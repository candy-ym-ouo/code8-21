import { Prisma } from '@prisma/client';
import { TRACE_TYPES, type TraceType } from '@paper-book-traces/shared';
import { prisma } from '../../lib/prisma.js';
import { AppError, zodFields } from '../../lib/errors.js';
import { isRestoreWindowOpen, normalizeText, validatePageRange, validateSinglePage } from '../../lib/domain.js';
import { writeEvent } from '../../lib/events.js';
import { parseId } from '../../lib/http.js';
import {
  annotationCreateSchema,
  annotationUpdateSchema,
  deleteSchema,
  dogEarCreateSchema,
  dogEarUpdateSchema,
  rereadCreateSchema,
  rereadUpdateSchema
} from './schemas.js';
import { serializeAnnotation, serializeDogEar, serializeRereadMark } from './serialize.js';
import { tracesRepository, type TraceListFilter } from './repository.js';

const STALE_TRACE_MESSAGE: Record<TraceType, string> = {
  DOG_EAR: '折角已在其他位置被修改',
  ANNOTATION: '批注已在其他位置被修改',
  REREAD_MARK: '重读记录已在其他位置被修改'
};

const NOT_FOUND_MESSAGE: Record<TraceType, string> = {
  DOG_EAR: '折角不存在',
  ANNOTATION: '批注不存在',
  REREAD_MARK: '重读记录不存在'
};

const RESTORE_NOT_FOUND_MESSAGE: Record<TraceType, string> = {
  DOG_EAR: '已删除折角不存在',
  ANNOTATION: '已删除批注不存在',
  REREAD_MARK: '已删除重读记录不存在'
};

function assertVersion(current: number, requested: number | undefined): void {
  if (requested && requested !== current) {
    throw new AppError(409, 'STALE_WRITE', '记录已在其他位置被修改，请刷新后重试');
  }
}

function eventSummary(value: string | null | undefined): string {
  return value ? normalizeText(value).slice(0, 120) : '';
}

export interface TraceListParams {
  type?: string;
  pageNumber?: number;
  keyword: string;
  from?: Date;
  to?: Date;
  page: number;
  pageSize: number;
}

export const traceService = {
  async listTraces(userId: string, rawBookId: string, params: TraceListParams) {
    const bookId = parseId(rawBookId, 'bookId');
    const book = await tracesRepository.findActiveBook(prisma, userId, bookId);
    if (!book) throw new AppError(404, 'NOT_FOUND', '书目不存在');

    const type = params.type && params.type !== 'ALL' ? params.type : undefined;
    if (type && !TRACE_TYPES.includes(type as TraceType)) {
      throw new AppError(422, 'VALIDATION_ERROR', '痕迹类型无效');
    }

    const filter: TraceListFilter = {
      ...(params.pageNumber !== undefined ? { pageNumber: params.pageNumber } : {}),
      ...(params.keyword ? { keyword: params.keyword } : {}),
      ...(params.from ? { from: params.from } : {}),
      ...(params.to ? { to: params.to } : {})
    };
    const { page, pageSize } = params;

    const [dogEars, annotations, rereadMarks] = await Promise.all([
      !type || type === 'DOG_EAR' ? tracesRepository.listDogEars(prisma, userId, bookId, filter) : [],
      !type || type === 'ANNOTATION' ? tracesRepository.listAnnotations(prisma, userId, bookId, filter) : [],
      !type || type === 'REREAD_MARK' ? tracesRepository.listRereadMarks(prisma, userId, bookId, filter) : []
    ]);

    const merged = [
      ...dogEars.map(serializeDogEar),
      ...annotations.map(serializeAnnotation),
      ...rereadMarks.map(serializeRereadMark)
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const total = merged.length;
    const items = merged.slice((page - 1) * pageSize, page * pageSize);
    return { items, pagination: { page, pageSize, total } };
  },

  // -- Dog ears ---------------------------------------------------------------

  async createDogEar(userId: string, rawBookId: string, body: unknown) {
    const bookId = parseId(rawBookId, 'bookId');
    const parsed = dogEarCreateSchema.safeParse(body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '折角信息无效', zodFields(parsed.error));

    const book = await tracesRepository.findActiveBook(prisma, userId, bookId);
    if (!book) throw new AppError(404, 'NOT_FOUND', '书目不存在');
    validateSinglePage(parsed.data.pageNumber, book.pageCount);
    const reason = parsed.data.reason ? normalizeText(parsed.data.reason) : null;
    const existing = await tracesRepository.findDogEarByBookPage(prisma, bookId, parsed.data.pageNumber);
    if (existing) {
      if ((existing.reason ?? '') === (reason ?? '')) {
        return { status: 200 as const, body: { dogEar: serializeDogEar(existing), idempotent: true } };
      }
      throw new AppError(409, 'DOG_EAR_EXISTS', '该页已有折角，请编辑原记录');
    }

    try {
      const dogEar = await prisma.$transaction(async (tx) => {
        const created = await tracesRepository.createDogEar(tx, {
          userId,
          bookId,
          pageNumber: parsed.data.pageNumber,
          reason
        });
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
      return { status: 201 as const, body: { dogEar: serializeDogEar(dogEar) } };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppError(409, 'DOG_EAR_EXISTS', '该页已有折角，请编辑原记录');
      }
      throw error;
    }
  },

  async updateDogEar(userId: string, rawId: string, body: unknown) {
    const id = parseId(rawId, 'dogEarId');
    const parsed = dogEarUpdateSchema.safeParse(body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '折角信息无效', zodFields(parsed.error));

    const existing = await tracesRepository.findActiveDogEarWithBook(prisma, id, userId);
    if (!existing || existing.book.deletedAt) throw new AppError(404, 'NOT_FOUND', NOT_FOUND_MESSAGE.DOG_EAR);
    assertVersion(existing.version, parsed.data.version);
    const nextPage = parsed.data.pageNumber ?? existing.pageNumber;
    validateSinglePage(nextPage, existing.book.pageCount);
    const nextReason =
      parsed.data.reason === undefined
        ? existing.reason
        : parsed.data.reason
          ? normalizeText(parsed.data.reason)
          : null;
    if (nextPage !== existing.pageNumber) {
      const duplicate = await tracesRepository.findActiveDogEarOnPageExcluding(
        prisma,
        existing.bookId,
        nextPage,
        id
      );
      if (duplicate) throw new AppError(409, 'DOG_EAR_EXISTS', '目标页已有折角');
    }

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tracesRepository.updateDogEarVersioned(tx, id, userId, existing.version, {
        pageNumber: nextPage,
        reason: nextReason
      });
      if (result.count !== 1) throw new AppError(409, 'STALE_WRITE', STALE_TRACE_MESSAGE.DOG_EAR);
      await writeEvent(tx, {
        userId,
        bookId: existing.bookId,
        entityType: 'DOG_EAR',
        entityId: id,
        action: 'UPDATED',
        payload: { pageNumber: nextPage, reason: eventSummary(nextReason) }
      });
      return tracesRepository.getDogEarOrThrow(tx, id);
    });
    return { dogEar: serializeDogEar(updated) };
  },

  async deleteDogEar(userId: string, rawId: string, body: unknown) {
    const id = parseId(rawId, 'dogEarId');
    const parsed = deleteSchema.safeParse(body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '删除参数无效', zodFields(parsed.error));

    const existing = await tracesRepository.findActiveDogEar(prisma, id, userId);
    if (!existing) throw new AppError(404, 'NOT_FOUND', NOT_FOUND_MESSAGE.DOG_EAR);
    assertVersion(existing.version, parsed?.version);

    await prisma.$transaction(async (tx) => {
      const result = await tracesRepository.softDeleteDogEarVersioned(
        tx,
        id,
        userId,
        existing.version,
        new Date()
      );
      if (result.count !== 1) throw new AppError(409, 'STALE_WRITE', STALE_TRACE_MESSAGE.DOG_EAR);
      await writeEvent(tx, {
        userId,
        bookId: existing.bookId,
        entityType: 'DOG_EAR',
        entityId: id,
        action: 'DELETED',
        payload: { pageNumber: existing.pageNumber }
      });
    });
  },

  async restoreDogEar(userId: string, rawId: string) {
    const id = parseId(rawId, 'dogEarId');
    const existing = await tracesRepository.findAnyDogEarWithBook(prisma, id, userId);
    if (!existing || !existing.deletedAt) throw new AppError(404, 'NOT_FOUND', RESTORE_NOT_FOUND_MESSAGE.DOG_EAR);
    if (!isRestoreWindowOpen(existing.deletedAt)) {
      throw new AppError(409, 'RESTORE_WINDOW_EXPIRED', '已超过 24 小时恢复窗口');
    }
    if (existing.book.deletedAt) throw new AppError(409, 'BOOK_DELETED', '所属书目已删除');
    const duplicate = await tracesRepository.findActiveDogEarOnPageExcluding(
      prisma,
      existing.bookId,
      existing.pageNumber,
      id
    );
    if (duplicate) throw new AppError(409, 'DOG_EAR_EXISTS', '该页已有有效折角，无法恢复');

    const restored = await prisma.$transaction(async (tx) => {
      const value = await tracesRepository.restoreDogEar(tx, id);
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
  },

  // -- Annotations ------------------------------------------------------------

  async createAnnotation(userId: string, rawBookId: string, body: unknown) {
    const bookId = parseId(rawBookId, 'bookId');
    const parsed = annotationCreateSchema.safeParse(body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '批注信息无效', zodFields(parsed.error));

    const book = await tracesRepository.findActiveBook(prisma, userId, bookId);
    if (!book) throw new AppError(404, 'NOT_FOUND', '书目不存在');
    validatePageRange(parsed.data.startPage, parsed.data.endPage, book.pageCount);

    const annotation = await prisma.$transaction(async (tx) => {
      const created = await tracesRepository.createAnnotation(tx, {
        userId,
        bookId,
        startPage: parsed.data.startPage,
        endPage: parsed.data.endPage,
        content: normalizeText(parsed.data.content)
      });
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
    return { status: 201 as const, body: { annotation: serializeAnnotation(annotation) } };
  },

  async updateAnnotation(userId: string, rawId: string, body: unknown) {
    const id = parseId(rawId, 'annotationId');
    const parsed = annotationUpdateSchema.safeParse(body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '批注信息无效', zodFields(parsed.error));

    const existing = await tracesRepository.findActiveAnnotationWithBook(prisma, id, userId);
    if (!existing || existing.book.deletedAt) throw new AppError(404, 'NOT_FOUND', NOT_FOUND_MESSAGE.ANNOTATION);
    assertVersion(existing.version, parsed.data.version);
    const startPage = parsed.data.startPage ?? existing.startPage;
    const endPage = parsed.data.endPage ?? existing.endPage;
    validatePageRange(startPage, endPage, existing.book.pageCount);

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tracesRepository.updateAnnotationVersioned(tx, id, userId, existing.version, {
        startPage,
        endPage,
        ...(parsed.data.content !== undefined ? { content: normalizeText(parsed.data.content) } : {})
      });
      if (result.count !== 1) throw new AppError(409, 'STALE_WRITE', STALE_TRACE_MESSAGE.ANNOTATION);
      await writeEvent(tx, {
        userId,
        bookId: existing.bookId,
        entityType: 'ANNOTATION',
        entityId: id,
        action: 'UPDATED',
        payload: { startPage, endPage }
      });
      return tracesRepository.getAnnotationOrThrow(tx, id);
    });
    return { annotation: serializeAnnotation(updated) };
  },

  async deleteAnnotation(userId: string, rawId: string, body: unknown) {
    const id = parseId(rawId, 'annotationId');
    const parsed = deleteSchema.safeParse(body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '删除参数无效', zodFields(parsed.error));

    const existing = await tracesRepository.findActiveAnnotation(prisma, id, userId);
    if (!existing) throw new AppError(404, 'NOT_FOUND', NOT_FOUND_MESSAGE.ANNOTATION);
    assertVersion(existing.version, parsed?.version);

    await prisma.$transaction(async (tx) => {
      const result = await tracesRepository.softDeleteAnnotationVersioned(tx, id, userId, existing.version);
      if (result.count !== 1) throw new AppError(409, 'STALE_WRITE', STALE_TRACE_MESSAGE.ANNOTATION);
      await writeEvent(tx, {
        userId,
        bookId: existing.bookId,
        entityType: 'ANNOTATION',
        entityId: id,
        action: 'DELETED',
        payload: { startPage: existing.startPage, endPage: existing.endPage }
      });
    });
  },

  async restoreAnnotation(userId: string, rawId: string) {
    const id = parseId(rawId, 'annotationId');
    const existing = await tracesRepository.findAnyAnnotationWithBook(prisma, id, userId);
    if (!existing || !existing.deletedAt) throw new AppError(404, 'NOT_FOUND', RESTORE_NOT_FOUND_MESSAGE.ANNOTATION);
    if (!isRestoreWindowOpen(existing.deletedAt)) {
      throw new AppError(409, 'RESTORE_WINDOW_EXPIRED', '已超过 24 小时恢复窗口');
    }
    if (existing.book.deletedAt) throw new AppError(409, 'BOOK_DELETED', '所属书目已删除');

    const restored = await prisma.$transaction(async (tx) => {
      const value = await tracesRepository.restoreAnnotation(tx, id);
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
  },

  // -- Reread marks -----------------------------------------------------------

  async createReread(userId: string, rawBookId: string, body: unknown) {
    const bookId = parseId(rawBookId, 'bookId');
    const parsed = rereadCreateSchema.safeParse(body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '重读信息无效', zodFields(parsed.error));

    const book = await tracesRepository.findActiveBook(prisma, userId, bookId);
    if (!book) throw new AppError(404, 'NOT_FOUND', '书目不存在');
    validateSinglePage(parsed.data.pageNumber, book.pageCount);

    const mark = await prisma.$transaction(async (tx) => {
      const created = await tracesRepository.createReread(tx, {
        userId,
        bookId,
        pageNumber: parsed.data.pageNumber,
        reason: parsed.data.reason ? normalizeText(parsed.data.reason) : null
      });
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
    return { status: 201 as const, body: { rereadMark: serializeRereadMark(mark) } };
  },

  async updateReread(userId: string, rawId: string, body: unknown) {
    const id = parseId(rawId, 'rereadMarkId');
    const parsed = rereadUpdateSchema.safeParse(body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '重读信息无效', zodFields(parsed.error));

    const existing = await tracesRepository.findActiveRereadWithBook(prisma, id, userId);
    if (!existing || existing.book.deletedAt) throw new AppError(404, 'NOT_FOUND', NOT_FOUND_MESSAGE.REREAD_MARK);
    assertVersion(existing.version, parsed.data.version);
    const pageNumber = parsed.data.pageNumber ?? existing.pageNumber;
    validateSinglePage(pageNumber, existing.book.pageCount);
    const reason =
      parsed.data.reason === undefined
        ? existing.reason
        : parsed.data.reason
          ? normalizeText(parsed.data.reason)
          : null;

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tracesRepository.updateRereadVersioned(tx, id, userId, existing.version, {
        pageNumber,
        reason
      });
      if (result.count !== 1) throw new AppError(409, 'STALE_WRITE', STALE_TRACE_MESSAGE.REREAD_MARK);
      await writeEvent(tx, {
        userId,
        bookId: existing.bookId,
        entityType: 'REREAD_MARK',
        entityId: id,
        action: 'UPDATED',
        payload: { pageNumber, reason: eventSummary(reason) }
      });
      return tracesRepository.getRereadOrThrow(tx, id);
    });
    return { rereadMark: serializeRereadMark(updated) };
  },

  async deleteReread(userId: string, rawId: string, body: unknown) {
    const id = parseId(rawId, 'rereadMarkId');
    const parsed = deleteSchema.safeParse(body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '删除参数无效', zodFields(parsed.error));

    const existing = await tracesRepository.findActiveReread(prisma, id, userId);
    if (!existing) throw new AppError(404, 'NOT_FOUND', NOT_FOUND_MESSAGE.REREAD_MARK);
    assertVersion(existing.version, parsed?.version);

    await prisma.$transaction(async (tx) => {
      const result = await tracesRepository.softDeleteRereadVersioned(tx, id, userId, existing.version);
      if (result.count !== 1) throw new AppError(409, 'STALE_WRITE', STALE_TRACE_MESSAGE.REREAD_MARK);
      await writeEvent(tx, {
        userId,
        bookId: existing.bookId,
        entityType: 'REREAD_MARK',
        entityId: id,
        action: 'DELETED',
        payload: { pageNumber: existing.pageNumber }
      });
    });
  },

  async restoreReread(userId: string, rawId: string) {
    const id = parseId(rawId, 'rereadMarkId');
    const existing = await tracesRepository.findAnyRereadWithBook(prisma, id, userId);
    if (!existing || !existing.deletedAt) throw new AppError(404, 'NOT_FOUND', RESTORE_NOT_FOUND_MESSAGE.REREAD_MARK);
    if (!isRestoreWindowOpen(existing.deletedAt)) {
      throw new AppError(409, 'RESTORE_WINDOW_EXPIRED', '已超过 24 小时恢复窗口');
    }
    if (existing.book.deletedAt) throw new AppError(409, 'BOOK_DELETED', '所属书目已删除');

    const restored = await prisma.$transaction(async (tx) => {
      const value = await tracesRepository.restoreReread(tx, id);
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
};
