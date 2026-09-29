import { prisma } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { normalizeMoodTags, normalizeText, validateStatusTransition } from '../../lib/domain.js';
import { writeEvent } from '../../lib/events.js';
import {
  createBook as insertBook,
  createCompletionReflection,
  countBooks,
  findActiveBook,
  findActiveChildIds,
  findBookByIdOrThrow,
  findBookDetail,
  findBookPage,
  findLatestTraceTimes,
  lockBookForUpdate,
  maxCompletionRound,
  maximumTracePage,
  softDeleteBookWithChildren,
  updateActiveBookVersioned,
  updateBookStatus,
  type BookUpdateFields
} from './book.repository.js';
import { serializeBook, serializeReflection } from './serializers.js';
import type { BookListFilter, CreateBookInput, StatusChangeInput, UpdateBookInput } from './schemas.js';

function staleBookError(): AppError {
  return new AppError(409, 'STALE_WRITE', '书目已在其他位置被修改，请刷新后重试');
}

export async function listBooks(userId: string, filter: BookListFilter, page: number, pageSize: number, skip: number) {
  const [total, books] = await Promise.all([
    countBooks(userId, filter),
    findBookPage(userId, filter, skip, pageSize)
  ]);
  const latestMap = await findLatestTraceTimes(
    userId,
    books.map((book) => book.id)
  );

  return {
    items: books.map((book) => ({
      ...serializeBook(book),
      traceSummary: {
        dogEars: book._count.dogEars,
        annotations: book._count.annotations,
        rereadMarks: book._count.rereadMarks
      },
      hasCompletionReflection: book._count.reflections > 0,
      lastTraceAt: latestMap.get(book.id) ?? null
    })),
    pagination: { page, pageSize, total }
  };
}

export async function createBook(userId: string, data: CreateBookInput) {
  const book = await prisma.$transaction(async (tx) => {
    const created = await insertBook(
      userId,
      {
        title: normalizeText(data.title),
        author: data.author ? normalizeText(data.author) : null,
        publisher: data.publisher ? normalizeText(data.publisher) : null,
        publicationYear: data.publicationYear ?? null,
        isbn: data.isbn ?? null,
        pageCount: data.pageCount ?? null,
        coverUrl: data.coverUrl ?? null,
        status: data.status
      },
      tx
    );
    await writeEvent(tx, {
      userId,
      bookId: created.id,
      entityType: 'BOOK',
      entityId: created.id,
      action: 'CREATED',
      payload: { bookTitle: created.title, status: created.status }
    });
    return created;
  });
  return { book: serializeBook(book) };
}

export async function getBook(bookId: string, userId: string) {
  const book = await findBookDetail(bookId, userId);
  if (!book) throw new AppError(404, 'NOT_FOUND', '书目不存在');

  return {
    book: {
      ...serializeBook(book),
      traceSummary: {
        dogEars: book._count.dogEars,
        annotations: book._count.annotations,
        rereadMarks: book._count.rereadMarks
      },
      reflections: book.reflections.map(serializeReflection)
    }
  };
}

export async function updateBook(bookId: string, userId: string, parsed: UpdateBookInput) {
  const existing = await findActiveBook(bookId, userId);
  if (!existing) throw new AppError(404, 'NOT_FOUND', '书目不存在');
  if (parsed.version && parsed.version !== existing.version) {
    throw staleBookError();
  }
  if (parsed.pageCount !== undefined && parsed.pageCount !== null) {
    const maxPage = await maximumTracePage(userId, bookId);
    if (parsed.pageCount < maxPage) {
      throw new AppError(409, 'PAGE_COUNT_TOO_SMALL', `总页数不能小于已有痕迹的最大页码 ${maxPage}`);
    }
  }

  const data: BookUpdateFields = {};
  if (parsed.title !== undefined) data.title = normalizeText(parsed.title);
  if (parsed.author !== undefined) data.author = parsed.author ? normalizeText(parsed.author) : null;
  if (parsed.publisher !== undefined) data.publisher = parsed.publisher ? normalizeText(parsed.publisher) : null;
  if (parsed.publicationYear !== undefined) data.publicationYear = parsed.publicationYear;
  if (parsed.isbn !== undefined) data.isbn = parsed.isbn;
  if (parsed.pageCount !== undefined) data.pageCount = parsed.pageCount;
  if (parsed.coverUrl !== undefined) data.coverUrl = parsed.coverUrl;

  // 旧行为：只有 version 之外的字段都会进入 data；zod 已保证至少一个字段。
  if (Object.keys(data).length === 0) return { book: serializeBook(existing) };

  const result = await prisma.$transaction(async (tx) => {
    const updated = await updateActiveBookVersioned(bookId, userId, existing.version, data, tx);
    if (updated !== 1) {
      throw staleBookError();
    }
    await writeEvent(tx, {
      userId,
      bookId,
      entityType: 'BOOK',
      entityId: bookId,
      action: 'UPDATED',
      payload: {
        bookTitle: normalizeText(parsed.title ?? existing.title),
        previousStatus: existing.status
      }
    });
    return findBookByIdOrThrow(bookId, tx);
  });
  return { book: serializeBook(result) };
}

export async function changeBookStatus(bookId: string, userId: string, parsed: StatusChangeInput) {
  const result = await prisma.$transaction(async (tx) => {
    await lockBookForUpdate(bookId, userId, tx);
    const book = await findActiveBook(bookId, userId, tx);
    if (!book) throw new AppError(404, 'NOT_FOUND', '书目不存在');
    if (parsed.version && parsed.version !== book.version) {
      throw staleBookError();
    }
    validateStatusTransition(book.status, parsed.status);
    if (book.status === parsed.status) {
      return { book, reflection: null };
    }

    if (parsed.status === 'READ') {
      if (!parsed.reflection) {
        throw new AppError(422, 'COMPLETION_REQUIRED', '标记读完时必须记录完成感受', {
          reflection: '请选择情绪标签'
        });
      }
      const moodTags = normalizeMoodTags(parsed.reflection.moodTags);
      const completedAt = parsed.reflection.completedAt
        ? new Date(parsed.reflection.completedAt)
        : new Date();
      if (
        completedAt.getTime() < book.createdAt.getTime() ||
        completedAt.getTime() > Date.now() + 5 * 60 * 1000
      ) {
        throw new AppError(422, 'VALIDATION_ERROR', '完成时间无效', {
          completedAt: '完成时间不能早于建书时间或晚于当前时间'
        });
      }
      const completionRound = (await maxCompletionRound(bookId, tx)) + 1;
      const now = new Date();
      const reflection = await createCompletionReflection(
        {
          userId,
          bookId,
          completionRound,
          moodTags,
          reflection: parsed.reflection.text ? normalizeText(parsed.reflection.text) : null,
          completedAt,
          editableUntil: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
          createdAt: now
        },
        tx
      );
      const updated = await updateBookStatus(bookId, 'READ', tx);
      await writeEvent(tx, {
        userId,
        bookId,
        entityType: 'BOOK',
        entityId: bookId,
        action: 'STATUS_CHANGED',
        payload: { previousStatus: book.status, nextStatus: 'READ', completionRound }
      });
      await writeEvent(tx, {
        userId,
        bookId,
        entityType: 'COMPLETION_REFLECTION',
        entityId: reflection.id,
        action: 'COMPLETED',
        payload: { moodTags, completionRound }
      });
      return { book: updated, reflection: serializeReflection(reflection) };
    }

    const updated = await updateBookStatus(bookId, parsed.status, tx);
    await writeEvent(tx, {
      userId,
      bookId,
      entityType: 'BOOK',
      entityId: bookId,
      action: 'STATUS_CHANGED',
      payload: { previousStatus: book.status, nextStatus: parsed.status }
    });
    return { book: updated, reflection: null };
  });
  return {
    book: serializeBook(result.book),
    ...(result.reflection ? { reflection: result.reflection } : {})
  };
}

export async function deleteBook(bookId: string, userId: string, requestedVersion?: number): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const book = await findActiveBook(bookId, userId, tx);
    if (!book) throw new AppError(404, 'NOT_FOUND', '书目不存在');
    if (requestedVersion && requestedVersion !== book.version) {
      throw staleBookError();
    }
    const now = new Date();
    // 先在同一事务内取出全部有效子记录，保证每条都有对应的级联 DELETED 审计事件。
    const childIds = await findActiveChildIds(bookId, tx);
    await softDeleteBookWithChildren(bookId, now, tx);
    await writeEvent(tx, {
      userId,
      bookId,
      entityType: 'BOOK',
      entityId: bookId,
      action: 'DELETED',
      payload: { bookTitle: book.title }
    });
    // 审计顺序：折角 -> 批注 -> 重读 -> 完成感受，与旧实现完全一致。
    const childEvents = [
      ...childIds.dogEars.map((id) => ({ entityType: 'DOG_EAR' as const, id })),
      ...childIds.annotations.map((id) => ({ entityType: 'ANNOTATION' as const, id })),
      ...childIds.rereadMarks.map((id) => ({ entityType: 'REREAD_MARK' as const, id })),
      ...childIds.reflections.map((id) => ({ entityType: 'COMPLETION_REFLECTION' as const, id }))
    ];
    for (const child of childEvents) {
      await writeEvent(tx, {
        userId,
        bookId,
        entityType: child.entityType,
        entityId: child.id,
        action: 'DELETED',
        payload: { cascade: true }
      });
    }
  });
}
