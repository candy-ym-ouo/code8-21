import { Prisma } from '@prisma/client';
import type { BookStatus } from '@paper-book-traces/shared';
import { prisma } from '../../lib/prisma.js';
import { AppError, zodFields } from '../../lib/errors.js';
import { normalizeMoodTags, normalizeText, validateStatusTransition } from '../../lib/domain.js';
import { writeEvent } from '../../lib/events.js';
import { parseId } from '../../lib/http.js';
import { createBookSchema, statusSchema, updateBookSchema } from './schemas.js';
import { serializeBook, serializeReflection } from './serialize.js';
import { booksRepository, traceIndexRepository } from './repository.js';

export interface BookListParams {
  page: number;
  pageSize: number;
  skip: number;
  status?: string;
  search?: string;
}

export const bookService = {
  async listBooks(userId: string, params: BookListParams) {
    const { page, pageSize, skip } = params;
    const status = params.status && params.status !== 'ALL' ? params.status : undefined;
    const search = params.search ? params.search.trim() : '';

    if (status && !isBookStatus(status)) {
      throw new AppError(422, 'VALIDATION_ERROR', '书目状态无效');
    }

    const [total, books] = await booksRepository.list(
      prisma,
      userId,
      { status: status as BookStatus | undefined, search: search || undefined },
      skip,
      pageSize
    );

    const ids = books.map((book) => book.id);
    const latestEvents = await booksRepository.latestTraceEventTimes(prisma, userId, ids);
    const latestMap = new Map(latestEvents.map((event) => [event.bookId, event._max.occurredAt]));

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
  },

  async createBook(userId: string, body: unknown) {
    const parsed = createBookSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError(422, 'VALIDATION_ERROR', '书目信息无效', zodFields(parsed.error));
    }
    const data = parsed.data;
    const book = await prisma.$transaction(async (tx) => {
      const created = await booksRepository.create(tx, {
        userId,
        title: normalizeText(data.title),
        author: data.author ? normalizeText(data.author) : null,
        publisher: data.publisher ? normalizeText(data.publisher) : null,
        publicationYear: data.publicationYear ?? null,
        isbn: data.isbn ?? null,
        pageCount: data.pageCount ?? null,
        coverUrl: data.coverUrl ?? null,
        status: data.status
      });
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
    return { status: 201 as const, body: { book: serializeBook(book) } };
  },

  async getBook(userId: string, rawBookId: string) {
    const bookId = parseId(rawBookId, 'bookId');
    const book = await booksRepository.findDetailById(prisma, userId, bookId);
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
  },

  async updateBook(userId: string, rawBookId: string, body: unknown) {
    const bookId = parseId(rawBookId, 'bookId');
    const parsed = updateBookSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError(422, 'VALIDATION_ERROR', '书目信息无效', zodFields(parsed.error));
    }
    const existing = await booksRepository.findActiveById(prisma, userId, bookId);
    if (!existing) throw new AppError(404, 'NOT_FOUND', '书目不存在');
    if (parsed.data.version && parsed.data.version !== existing.version) {
      throw new AppError(409, 'STALE_WRITE', '书目已在其他位置被修改，请刷新后重试');
    }
    if (parsed.data.pageCount !== undefined && parsed.data.pageCount !== null) {
      const maxPage = await maximumTracePage(prisma, userId, bookId);
      if (parsed.data.pageCount < maxPage) {
        throw new AppError(409, 'PAGE_COUNT_TOO_SMALL', `总页数不能小于已有痕迹的最大页码 ${maxPage}`);
      }
    }

    const data: Prisma.BookUpdateManyMutationInput = {};
    if (parsed.data.title !== undefined) data.title = normalizeText(parsed.data.title);
    if (parsed.data.author !== undefined) data.author = parsed.data.author ? normalizeText(parsed.data.author) : null;
    if (parsed.data.publisher !== undefined) data.publisher = parsed.data.publisher ? normalizeText(parsed.data.publisher) : null;
    if (parsed.data.publicationYear !== undefined) data.publicationYear = parsed.data.publicationYear;
    if (parsed.data.isbn !== undefined) data.isbn = parsed.data.isbn;
    if (parsed.data.pageCount !== undefined) data.pageCount = parsed.data.pageCount;
    if (parsed.data.coverUrl !== undefined) data.coverUrl = parsed.data.coverUrl;

    if (Object.keys(data).length === 0) return { book: serializeBook(existing) };

    const result = await prisma.$transaction(async (tx) => {
      const updated = await booksRepository.updateVersioned(tx, bookId, userId, existing.version, data);
      if (updated.count !== 1) {
        throw new AppError(409, 'STALE_WRITE', '书目已在其他位置被修改，请刷新后重试');
      }
      await writeEvent(tx, {
        userId,
        bookId,
        entityType: 'BOOK',
        entityId: bookId,
        action: 'UPDATED',
        payload: {
          bookTitle: normalizeText(parsed.data.title ?? existing.title),
          previousStatus: existing.status
        }
      });
      return booksRepository.findByIdOrThrow(tx, bookId);
    });
    return { book: serializeBook(result) };
  },

  async changeStatus(userId: string, rawBookId: string, body: unknown) {
    const bookId = parseId(rawBookId, 'bookId');
    const parsed = statusSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError(422, 'VALIDATION_ERROR', '状态信息无效', zodFields(parsed.error));
    }

    const result = await prisma.$transaction(async (tx) => {
      await booksRepository.lockForUpdate(tx, bookId, userId);
      const book = await booksRepository.findActiveById(tx, userId, bookId);
      if (!book) throw new AppError(404, 'NOT_FOUND', '书目不存在');
      if (parsed.data.version && parsed.data.version !== book.version) {
        throw new AppError(409, 'STALE_WRITE', '书目已在其他位置被修改，请刷新后重试');
      }
      validateStatusTransition(book.status, parsed.data.status);
      if (book.status === parsed.data.status) {
        return { book, reflection: null };
      }

      if (parsed.data.status === 'READ') {
        if (!parsed.data.reflection) {
          throw new AppError(422, 'COMPLETION_REQUIRED', '标记读完时必须记录完成感受', {
            reflection: '请选择情绪标签'
          });
        }
        const moodTags = normalizeMoodTags(parsed.data.reflection.moodTags);
        const completedAt = parsed.data.reflection.completedAt
          ? new Date(parsed.data.reflection.completedAt)
          : new Date();
        if (
          completedAt.getTime() < book.createdAt.getTime() ||
          completedAt.getTime() > Date.now() + 5 * 60 * 1000
        ) {
          throw new AppError(422, 'VALIDATION_ERROR', '完成时间无效', {
            completedAt: '完成时间不能早于建书时间或晚于当前时间'
          });
        }
        const completionRound = (await traceIndexRepository.maxCompletionRound(tx, bookId)) + 1;
        const now = new Date();
        const reflection = await traceIndexRepository.createCompletionReflection(tx, {
          userId,
          bookId,
          completionRound,
          moodTags,
          reflection: parsed.data.reflection.text ? normalizeText(parsed.data.reflection.text) : null,
          completedAt,
          editableUntil: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
          createdAt: now
        });
        const updated = await booksRepository.updateStatus(tx, bookId, 'READ');
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

      const updated = await booksRepository.updateStatus(tx, bookId, parsed.data.status);
      await writeEvent(tx, {
        userId,
        bookId,
        entityType: 'BOOK',
        entityId: bookId,
        action: 'STATUS_CHANGED',
        payload: { previousStatus: book.status, nextStatus: parsed.data.status }
      });
      return { book: updated, reflection: null };
    });

    return {
      book: serializeBook(result.book),
      ...(result.reflection ? { reflection: result.reflection } : {})
    };
  },

  async deleteBook(userId: string, rawBookId: string, body: unknown) {
    const bookId = parseId(rawBookId, 'bookId');
    const existingVersion = (body as { version?: number } | undefined)?.version;

    await prisma.$transaction(async (tx) => {
      const book = await booksRepository.findActiveById(tx, userId, bookId);
      if (!book) throw new AppError(404, 'NOT_FOUND', '书目不存在');
      if (existingVersion && existingVersion !== book.version) {
        throw new AppError(409, 'STALE_WRITE', '书目已在其他位置被修改，请刷新后重试');
      }
      const now = new Date();
      const [dogEars, annotations, rereadMarks, reflections] =
        await traceIndexRepository.listActiveChildIds(tx, bookId);
      await traceIndexRepository.softDeleteChildren(tx, bookId, now);
      await booksRepository.softDelete(tx, bookId, now);
      await writeEvent(tx, {
        userId,
        bookId,
        entityType: 'BOOK',
        entityId: bookId,
        action: 'DELETED',
        payload: { bookTitle: book.title }
      });
      const childEvents = [
        ...dogEars.map((item) => ({ entityType: 'DOG_EAR' as const, id: item.id })),
        ...annotations.map((item) => ({ entityType: 'ANNOTATION' as const, id: item.id })),
        ...rereadMarks.map((item) => ({ entityType: 'REREAD_MARK' as const, id: item.id })),
        ...reflections.map((item) => ({ entityType: 'COMPLETION_REFLECTION' as const, id: item.id }))
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
};

function isBookStatus(value: string): value is BookStatus {
  return ['TO_READ', 'READING', 'READ', 'PAUSED', 'ABANDONED'].includes(value);
}

async function maximumTracePage(userId: string, bookId: string): Promise<number> {
  const max = await traceIndexRepository.maximumTracePages(prisma, userId, bookId);
  return Math.max(max.dogEar ?? 0, max.annotation ?? 0, max.reread ?? 0);
}
