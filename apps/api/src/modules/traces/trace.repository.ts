import { Prisma } from '@prisma/client';
import { prisma, type DbClient } from '../../lib/db.js';
import type { TraceListFilter } from './schemas.js';

/** 折角部分唯一索引冲突（同页重复创建/移动）。 */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function createdAtRange(filter: TraceListFilter): Prisma.DogEarWhereInput['createdAt'] {
  if (!filter.from && !filter.to) return undefined;
  return {
    ...(filter.from ? { gte: filter.from } : {}),
    ...(filter.to ? { lte: filter.to } : {})
  };
}

/** 痕迹列表的三类查询：分页在内存合并后进行，保持与旧路由一致的行为。 */
export async function findTracePage(userId: string, bookId: string, filter: TraceListFilter) {
  const createdAt = createdAtRange(filter);
  const [dogEars, annotations, rereadMarks] = await Promise.all([
    !filter.type || filter.type === 'DOG_EAR'
      ? prisma.dogEar.findMany({
          where: {
            userId,
            bookId,
            deletedAt: null,
            ...(filter.pageNumber ? { pageNumber: filter.pageNumber } : {}),
            ...(filter.keyword ? { reason: { contains: filter.keyword, mode: 'insensitive' } } : {}),
            ...(createdAt ? { createdAt } : {})
          },
          orderBy: { createdAt: 'desc' }
        })
      : [],
    !filter.type || filter.type === 'ANNOTATION'
      ? prisma.annotation.findMany({
          where: {
            userId,
            bookId,
            deletedAt: null,
            ...(filter.pageNumber
              ? { startPage: { lte: filter.pageNumber }, endPage: { gte: filter.pageNumber } }
              : {}),
            ...(filter.keyword ? { content: { contains: filter.keyword, mode: 'insensitive' } } : {}),
            ...(createdAt ? { createdAt } : {})
          },
          orderBy: { createdAt: 'desc' }
        })
      : [],
    !filter.type || filter.type === 'REREAD_MARK'
      ? prisma.rereadMark.findMany({
          where: {
            userId,
            bookId,
            deletedAt: null,
            ...(filter.pageNumber ? { pageNumber: filter.pageNumber } : {}),
            ...(filter.keyword ? { reason: { contains: filter.keyword, mode: 'insensitive' } } : {}),
            ...(createdAt ? { createdAt } : {})
          },
          orderBy: { createdAt: 'desc' }
        })
      : []
  ]);
  return { dogEars, annotations, rereadMarks };
}

// ---------- 折角 ----------

export async function findActiveDogEar(id: string, userId: string, db: DbClient = prisma) {
  return db.dogEar.findFirst({ where: { id, userId, deletedAt: null } });
}

export async function findActiveDogEarByPage(
  bookId: string,
  pageNumber: number,
  db: DbClient = prisma
) {
  return db.dogEar.findFirst({
    where: { bookId, pageNumber, deletedAt: null }
  });
}

export async function createDogEar(
  userId: string,
  bookId: string,
  pageNumber: number,
  reason: string | null,
  db: DbClient
) {
  return db.dogEar.create({ data: { userId, bookId, pageNumber, reason } });
}

export async function findActiveDogEarForWrite(id: string, userId: string, db: DbClient = prisma) {
  return db.dogEar.findFirst({
    where: { id, userId, deletedAt: null },
    include: { book: true }
  });
}

export async function findDeletedDogEarForRestore(id: string, userId: string, db: DbClient = prisma) {
  return db.dogEar.findFirst({ where: { id, userId }, include: { book: true } });
}

export async function findOtherActiveDogEarAtPage(
  bookId: string,
  pageNumber: number,
  excludeId: string,
  db: DbClient = prisma
) {
  return db.dogEar.findFirst({
    where: { bookId, pageNumber, deletedAt: null, id: { not: excludeId } }
  });
}

export interface DogEarUpdateFields {
  pageNumber?: number;
  reason?: string | null;
}

export interface AnnotationUpdateFields {
  startPage?: number;
  endPage?: number;
  content?: string;
}

export interface RereadUpdateFields {
  pageNumber?: number;
  reason?: string | null;
}

export async function updateActiveDogEarVersioned(
  id: string,
  userId: string,
  version: number,
  data: DogEarUpdateFields,
  db: DbClient
): Promise<number> {
  const result = await db.dogEar.updateMany({
    where: { id, userId, version, deletedAt: null },
    data: { ...data, version: { increment: 1 } }
  });
  return result.count;
}

export async function softDeleteDogEarVersioned(
  id: string,
  userId: string,
  version: number,
  deletedAt: Date,
  db: DbClient
): Promise<number> {
  const result = await db.dogEar.updateMany({
    where: { id, userId, deletedAt: null, version },
    data: { deletedAt, version: { increment: 1 } }
  });
  return result.count;
}

export async function restoreDogEar(id: string, db: DbClient) {
  return db.dogEar.update({
    where: { id },
    data: { deletedAt: null, version: { increment: 1 } }
  });
}

export async function findDogEarByIdOrThrow(id: string, db: DbClient) {
  return db.dogEar.findUniqueOrThrow({ where: { id } });
}

// ---------- 批注 ----------

export async function findActiveAnnotation(id: string, userId: string, db: DbClient = prisma) {
  return db.annotation.findFirst({ where: { id, userId, deletedAt: null } });
}

export async function createAnnotation(
  userId: string,
  bookId: string,
  data: { startPage: number; endPage: number; content: string },
  db: DbClient
) {
  return db.annotation.create({
    data: {
      userId,
      bookId,
      startPage: data.startPage,
      endPage: data.endPage,
      content: data.content
    }
  });
}

export async function findActiveAnnotationForWrite(id: string, userId: string, db: DbClient = prisma) {
  return db.annotation.findFirst({
    where: { id, userId, deletedAt: null },
    include: { book: true }
  });
}

export async function findDeletedAnnotationForRestore(id: string, userId: string, db: DbClient = prisma) {
  return db.annotation.findFirst({ where: { id, userId }, include: { book: true } });
}

export async function updateActiveAnnotationVersioned(
  id: string,
  userId: string,
  version: number,
  data: AnnotationUpdateFields,
  db: DbClient
): Promise<number> {
  const result = await db.annotation.updateMany({
    where: { id, userId, deletedAt: null, version },
    data: { ...data, version: { increment: 1 } }
  });
  return result.count;
}

export async function softDeleteAnnotationVersioned(
  id: string,
  userId: string,
  version: number,
  deletedAt: Date,
  db: DbClient
): Promise<number> {
  const result = await db.annotation.updateMany({
    where: { id, userId, deletedAt: null, version },
    data: { deletedAt, version: { increment: 1 } }
  });
  return result.count;
}

export async function restoreAnnotation(id: string, db: DbClient) {
  return db.annotation.update({
    where: { id },
    data: { deletedAt: null, version: { increment: 1 } }
  });
}

export async function findAnnotationByIdOrThrow(id: string, db: DbClient) {
  return db.annotation.findUniqueOrThrow({ where: { id } });
}

// ---------- 重读页 ----------

export async function findActiveReread(id: string, userId: string, db: DbClient = prisma) {
  return db.rereadMark.findFirst({ where: { id, userId, deletedAt: null } });
}

export async function createRereadMark(
  userId: string,
  bookId: string,
  pageNumber: number,
  reason: string | null,
  db: DbClient
) {
  return db.rereadMark.create({ data: { userId, bookId, pageNumber, reason } });
}

export async function findActiveRereadForWrite(id: string, userId: string, db: DbClient = prisma) {
  return db.rereadMark.findFirst({
    where: { id, userId, deletedAt: null },
    include: { book: true }
  });
}

export async function findDeletedRereadForRestore(id: string, userId: string, db: DbClient = prisma) {
  return db.rereadMark.findFirst({ where: { id, userId }, include: { book: true } });
}

export async function updateActiveRereadVersioned(
  id: string,
  userId: string,
  version: number,
  data: RereadUpdateFields,
  db: DbClient
): Promise<number> {
  const result = await db.rereadMark.updateMany({
    where: { id, userId, deletedAt: null, version },
    data: { ...data, version: { increment: 1 } }
  });
  return result.count;
}

export async function softDeleteRereadVersioned(
  id: string,
  userId: string,
  version: number,
  deletedAt: Date,
  db: DbClient
): Promise<number> {
  const result = await db.rereadMark.updateMany({
    where: { id, userId, deletedAt: null, version },
    data: { deletedAt, version: { increment: 1 } }
  });
  return result.count;
}

export async function restoreRereadMark(id: string, db: DbClient) {
  return db.rereadMark.update({
    where: { id },
    data: { deletedAt: null, version: { increment: 1 } }
  });
}

export async function findRereadByIdOrThrow(id: string, db: DbClient) {
  return db.rereadMark.findUniqueOrThrow({ where: { id } });
}
