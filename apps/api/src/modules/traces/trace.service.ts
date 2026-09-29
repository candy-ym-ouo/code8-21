import { prisma } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { isRestoreWindowOpen, normalizeText, validatePageRange, validateSinglePage } from '../../lib/domain.js';
import { writeEvent } from '../../lib/events.js';
import { findActiveBook } from '../books/book.repository.js';
import {
  createAnnotation,
  createDogEar,
  createRereadMark,
  findActiveAnnotation,
  findActiveAnnotationForWrite,
  findActiveDogEar,
  findActiveDogEarByPage,
  findActiveDogEarForWrite,
  findActiveReread,
  findActiveRereadForWrite,
  findAnnotationByIdOrThrow,
  findDeletedAnnotationForRestore,
  findDeletedDogEarForRestore,
  findDeletedRereadForRestore,
  findDogEarByIdOrThrow,
  findOtherActiveDogEarAtPage,
  findRereadByIdOrThrow,
  findTracePage,
  isUniqueViolation,
  restoreAnnotation,
  restoreDogEar,
  restoreRereadMark,
  softDeleteAnnotationVersioned,
  softDeleteDogEarVersioned,
  softDeleteRereadVersioned,
  updateActiveAnnotationVersioned,
  updateActiveDogEarVersioned,
  updateActiveRereadVersioned
} from './trace.repository.js';
import { serializeAnnotation, serializeDogEar, serializeRereadMark } from './serializers.js';
import type {
  AnnotationCreateInput,
  AnnotationUpdateInput,
  DeleteInput,
  DogEarCreateInput,
  DogEarUpdateInput,
  RereadCreateInput,
  RereadUpdateInput,
  TraceListFilter
} from './schemas.js';

function eventSummary(value: string | null | undefined): string {
  return value ? normalizeText(value).slice(0, 120) : '';
}

async function requireActiveBook(userId: string, bookId: string) {
  const book = await findActiveBook(bookId, userId);
  if (!book) throw new AppError(404, 'NOT_FOUND', '书目不存在');
  return book;
}

function assertVersion(current: number, requested: number | undefined, label: string): void {
  if (requested && requested !== current) {
    throw new AppError(409, 'STALE_WRITE', `${label}已在其他位置被修改，请刷新后重试`);
  }
}

export async function listTraces(
  userId: string,
  bookId: string,
  filter: TraceListFilter,
  page: number,
  pageSize: number
) {
  await requireActiveBook(userId, bookId);
  const { dogEars, annotations, rereadMarks } = await findTracePage(userId, bookId, filter);

  const merged = [
    ...dogEars.map(serializeDogEar),
    ...annotations.map(serializeAnnotation),
    ...rereadMarks.map(serializeRereadMark)
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const total = merged.length;
  const items = merged.slice((page - 1) * pageSize, page * pageSize);
  return { items, pagination: { page, pageSize, total } };
}

// ---------- 折角 ----------

export type DogEarCreateResult =
  | { dogEar: ReturnType<typeof serializeDogEar>; idempotent: true }
  | { dogEar: ReturnType<typeof serializeDogEar>; idempotent: false };

export async function createDogEarTrace(
  userId: string,
  bookId: string,
  parsed: DogEarCreateInput
): Promise<DogEarCreateResult> {
  const book = await requireActiveBook(userId, bookId);
  validateSinglePage(parsed.pageNumber, book.pageCount);
  const reason = parsed.reason ? normalizeText(parsed.reason) : null;
  const existing = await findActiveDogEarByPage(bookId, parsed.pageNumber);
  if (existing) {
    if ((existing.reason ?? '') === (reason ?? '')) {
      return { dogEar: serializeDogEar(existing), idempotent: true };
    }
    throw new AppError(409, 'DOG_EAR_EXISTS', '该页已有折角，请编辑原记录');
  }

  try {
    const dogEar = await prisma.$transaction(async (tx) => {
      const created = await createDogEar(userId, bookId, parsed.pageNumber, reason, tx);
      await writeEvent(tx, {
        userId,
        bookId,
        entityType: 'DOG_EAR',
        entityId: created.id,
        action: 'CREATED',
        payload: { pageNumber: created.pageNumber, reason: eventSummary(created.reason) }
      });
      return created;
    });
    return { dogEar: serializeDogEar(dogEar), idempotent: false };
  } catch (error) {
    // 部分唯一索引兜底：并发创建同页折角时仍返回 409。
    if (isUniqueViolation(error)) {
      throw new AppError(409, 'DOG_EAR_EXISTS', '该页已有折角，请编辑原记录');
    }
    throw error;
  }
}

export async function updateDogEarTrace(id: string, userId: string, parsed: DogEarUpdateInput) {
  const existing = await findActiveDogEarForWrite(id, userId);
  if (!existing || existing.book.deletedAt) throw new AppError(404, 'NOT_FOUND', '折角不存在');
  assertVersion(existing.version, parsed.version, '记录');
  const nextPage = parsed.pageNumber ?? existing.pageNumber;
  validateSinglePage(nextPage, existing.book.pageCount);
  const nextReason =
    parsed.reason === undefined
      ? existing.reason
      : parsed.reason
        ? normalizeText(parsed.reason)
        : null;
  if (nextPage !== existing.pageNumber) {
    const duplicate = await findOtherActiveDogEarAtPage(existing.bookId, nextPage, id);
    if (duplicate) throw new AppError(409, 'DOG_EAR_EXISTS', '目标页已有折角');
  }
  const updated = await prisma.$transaction(async (tx) => {
    const count = await updateActiveDogEarVersioned(
      id,
      userId,
      existing.version,
      { pageNumber: nextPage, reason: nextReason },
      tx
    );
    if (count !== 1) throw new AppError(409, 'STALE_WRITE', '折角已在其他位置被修改');
    await writeEvent(tx, {
      userId,
      bookId: existing.bookId,
      entityType: 'DOG_EAR',
      entityId: id,
      action: 'UPDATED',
      payload: { pageNumber: nextPage, reason: eventSummary(nextReason) }
    });
    return findDogEarByIdOrThrow(id, tx);
  });
  return { dogEar: serializeDogEar(updated) };
}

export async function deleteDogEarTrace(id: string, userId: string, parsed: DeleteInput): Promise<void> {
  const existing = await findActiveDogEar(id, userId);
  if (!existing) throw new AppError(404, 'NOT_FOUND', '折角不存在');
  assertVersion(existing.version, parsed?.version, '记录');
  await prisma.$transaction(async (tx) => {
    const count = await softDeleteDogEarVersioned(id, userId, existing.version, new Date(), tx);
    if (count !== 1) throw new AppError(409, 'STALE_WRITE', '折角已在其他位置被修改');
    await writeEvent(tx, {
      userId,
      bookId: existing.bookId,
      entityType: 'DOG_EAR',
      entityId: id,
      action: 'DELETED',
      payload: { pageNumber: existing.pageNumber }
    });
  });
}

export async function restoreDogEarTrace(id: string, userId: string) {
  const existing = await findDeletedDogEarForRestore(id, userId);
  if (!existing || !existing.deletedAt) throw new AppError(404, 'NOT_FOUND', '已删除折角不存在');
  if (!isRestoreWindowOpen(existing.deletedAt)) {
    throw new AppError(409, 'RESTORE_WINDOW_EXPIRED', '已超过 24 小时恢复窗口');
  }
  if (existing.book.deletedAt) throw new AppError(409, 'BOOK_DELETED', '所属书目已删除');
  const duplicate = await findOtherActiveDogEarAtPage(existing.bookId, existing.pageNumber, id);
  if (duplicate) throw new AppError(409, 'DOG_EAR_EXISTS', '该页已有有效折角，无法恢复');
  const restored = await prisma.$transaction(async (tx) => {
    const value = await restoreDogEar(id, tx);
    await writeEvent(tx, {
      userId,
      bookId: value.bookId,
      entityType: 'DOG_EAR',
      entityId: id,
      action: 'RESTORED',
      payload: { pageNumber: value.pageNumber }
    });
    return value;
  });
  return { dogEar: serializeDogEar(restored) };
}

// ---------- 批注 ----------

export async function createAnnotationTrace(
  userId: string,
  bookId: string,
  parsed: AnnotationCreateInput
) {
  const book = await requireActiveBook(userId, bookId);
  validatePageRange(parsed.startPage, parsed.endPage, book.pageCount);
  const annotation = await prisma.$transaction(async (tx) => {
    const created = await createAnnotation(
      userId,
      bookId,
      {
        startPage: parsed.startPage,
        endPage: parsed.endPage,
        content: normalizeText(parsed.content)
      },
      tx
    );
    await writeEvent(tx, {
      userId,
      bookId,
      entityType: 'ANNOTATION',
      entityId: created.id,
      action: 'CREATED',
      payload: { startPage: created.startPage, endPage: created.endPage, summary: eventSummary(created.content) }
    });
    return created;
  });
  return { annotation: serializeAnnotation(annotation) };
}

export async function updateAnnotationTrace(id: string, userId: string, parsed: AnnotationUpdateInput) {
  const existing = await findActiveAnnotationForWrite(id, userId);
  if (!existing || existing.book.deletedAt) throw new AppError(404, 'NOT_FOUND', '批注不存在');
  assertVersion(existing.version, parsed.version, '记录');
  const startPage = parsed.startPage ?? existing.startPage;
  const endPage = parsed.endPage ?? existing.endPage;
  validatePageRange(startPage, endPage, existing.book.pageCount);
  const updated = await prisma.$transaction(async (tx) => {
    const count = await updateActiveAnnotationVersioned(
      id,
      userId,
      existing.version,
      {
        startPage,
        endPage,
        ...(parsed.content !== undefined ? { content: normalizeText(parsed.content) } : {})
      },
      tx
    );
    if (count !== 1) throw new AppError(409, 'STALE_WRITE', '批注已在其他位置被修改');
    await writeEvent(tx, {
      userId,
      bookId: existing.bookId,
      entityType: 'ANNOTATION',
      entityId: id,
      action: 'UPDATED',
      payload: { startPage, endPage }
    });
    return findAnnotationByIdOrThrow(id, tx);
  });
  return { annotation: serializeAnnotation(updated) };
}

export async function deleteAnnotationTrace(id: string, userId: string, parsed: DeleteInput): Promise<void> {
  const existing = await findActiveAnnotation(id, userId);
  if (!existing) throw new AppError(404, 'NOT_FOUND', '批注不存在');
  assertVersion(existing.version, parsed?.version, '记录');
  await prisma.$transaction(async (tx) => {
    const count = await softDeleteAnnotationVersioned(id, userId, existing.version, new Date(), tx);
    if (count !== 1) throw new AppError(409, 'STALE_WRITE', '批注已在其他位置被修改');
    await writeEvent(tx, {
      userId,
      bookId: existing.bookId,
      entityType: 'ANNOTATION',
      entityId: id,
      action: 'DELETED',
      payload: { startPage: existing.startPage, endPage: existing.endPage }
    });
  });
}

export async function restoreAnnotationTrace(id: string, userId: string) {
  const existing = await findDeletedAnnotationForRestore(id, userId);
  if (!existing || !existing.deletedAt) throw new AppError(404, 'NOT_FOUND', '已删除批注不存在');
  if (!isRestoreWindowOpen(existing.deletedAt)) {
    throw new AppError(409, 'RESTORE_WINDOW_EXPIRED', '已超过 24 小时恢复窗口');
  }
  if (existing.book.deletedAt) throw new AppError(409, 'BOOK_DELETED', '所属书目已删除');
  const restored = await prisma.$transaction(async (tx) => {
    const value = await restoreAnnotation(id, tx);
    await writeEvent(tx, {
      userId,
      bookId: value.bookId,
      entityType: 'ANNOTATION',
      entityId: id,
      action: 'RESTORED',
      payload: { startPage: value.startPage, endPage: value.endPage }
    });
    return value;
  });
  return { annotation: serializeAnnotation(restored) };
}

// ---------- 重读页 ----------

export async function createRereadTrace(userId: string, bookId: string, parsed: RereadCreateInput) {
  const book = await requireActiveBook(userId, bookId);
  validateSinglePage(parsed.pageNumber, book.pageCount);
  const mark = await prisma.$transaction(async (tx) => {
    const created = await createRereadMark(
      userId,
      bookId,
      parsed.pageNumber,
      parsed.reason ? normalizeText(parsed.reason) : null,
      tx
    );
    await writeEvent(tx, {
      userId,
      bookId,
      entityType: 'REREAD_MARK',
      entityId: created.id,
      action: 'CREATED',
      payload: { pageNumber: created.pageNumber, reason: eventSummary(created.reason) }
    });
    return created;
  });
  return { rereadMark: serializeRereadMark(mark) };
}

export async function updateRereadTrace(id: string, userId: string, parsed: RereadUpdateInput) {
  const existing = await findActiveRereadForWrite(id, userId);
  if (!existing || existing.book.deletedAt) throw new AppError(404, 'NOT_FOUND', '重读记录不存在');
  assertVersion(existing.version, parsed.version, '记录');
  const pageNumber = parsed.pageNumber ?? existing.pageNumber;
  validateSinglePage(pageNumber, existing.book.pageCount);
  const reason =
    parsed.reason === undefined
      ? existing.reason
      : parsed.reason
        ? normalizeText(parsed.reason)
        : null;
  const updated = await prisma.$transaction(async (tx) => {
    const count = await updateActiveRereadVersioned(
      id,
      userId,
      existing.version,
      { pageNumber, reason },
      tx
    );
    if (count !== 1) throw new AppError(409, 'STALE_WRITE', '重读记录已在其他位置被修改');
    await writeEvent(tx, {
      userId,
      bookId: existing.bookId,
      entityType: 'REREAD_MARK',
      entityId: id,
      action: 'UPDATED',
      payload: { pageNumber, reason: eventSummary(reason) }
    });
    return findRereadByIdOrThrow(id, tx);
  });
  return { rereadMark: serializeRereadMark(updated) };
}

export async function deleteRereadTrace(id: string, userId: string, parsed: DeleteInput): Promise<void> {
  const existing = await findActiveReread(id, userId);
  if (!existing) throw new AppError(404, 'NOT_FOUND', '重读记录不存在');
  assertVersion(existing.version, parsed?.version, '记录');
  await prisma.$transaction(async (tx) => {
    const count = await softDeleteRereadVersioned(id, userId, existing.version, new Date(), tx);
    if (count !== 1) throw new AppError(409, 'STALE_WRITE', '重读记录已在其他位置被修改');
    await writeEvent(tx, {
      userId,
      bookId: existing.bookId,
      entityType: 'REREAD_MARK',
      entityId: id,
      action: 'DELETED',
      payload: { pageNumber: existing.pageNumber }
    });
  });
}

export async function restoreRereadTrace(id: string, userId: string) {
  const existing = await findDeletedRereadForRestore(id, userId);
  if (!existing || !existing.deletedAt) throw new AppError(404, 'NOT_FOUND', '已删除重读记录不存在');
  if (!isRestoreWindowOpen(existing.deletedAt)) {
    throw new AppError(409, 'RESTORE_WINDOW_EXPIRED', '已超过 24 小时恢复窗口');
  }
  if (existing.book.deletedAt) throw new AppError(409, 'BOOK_DELETED', '所属书目已删除');
  const restored = await prisma.$transaction(async (tx) => {
    const value = await restoreRereadMark(id, tx);
    await writeEvent(tx, {
      userId,
      bookId: value.bookId,
      entityType: 'REREAD_MARK',
      entityId: id,
      action: 'RESTORED',
      payload: { pageNumber: value.pageNumber }
    });
    return value;
  });
  return { rereadMark: serializeRereadMark(restored) };
}
