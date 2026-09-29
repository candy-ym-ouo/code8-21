import { Prisma } from '@prisma/client';
import type { DbClient } from '../../lib/prisma.js';
import { booksRepository } from '../books/repository.js';

export interface TraceListFilter {
  pageNumber?: number;
  keyword?: string;
  from?: Date;
  to?: Date;
}

function createdAtRange(filter: TraceListFilter): Prisma.DateTimeFilter {
  return {
    ...(filter.from ? { gte: filter.from } : {}),
    ...(filter.to ? { lte: filter.to } : {})
  };
}

function hasDateRange(filter: TraceListFilter): boolean {
  return filter.from !== undefined || filter.to !== undefined;
}

export const tracesRepository = {
  findActiveBook(db: DbClient, userId: string, bookId: string) {
    return booksRepository.findActiveById(db, userId, bookId);
  },

  // -- Dog ears ---------------------------------------------------------------

  listDogEars(db: DbClient, userId: string, bookId: string, filter: TraceListFilter) {
    return db.dogEar.findMany({
      where: {
        userId,
        bookId,
        deletedAt: null,
        ...(filter.pageNumber ? { pageNumber: filter.pageNumber } : {}),
        ...(filter.keyword ? { reason: { contains: filter.keyword, mode: 'insensitive' } } : {}),
        ...(hasDateRange(filter) ? { createdAt: createdAtRange(filter) } : {})
      },
      orderBy: { createdAt: 'desc' }
    });
  },

  /**
   * Active dog ear on a page. Deliberately not scoped by ``userId``: the
   * partial unique index is on ``(book_id, page_number)`` for active rows and
   * the book already belongs to the requesting user.
   */
  findDogEarByBookPage(db: DbClient, bookId: string, pageNumber: number) {
    return db.dogEar.findFirst({ where: { bookId, pageNumber, deletedAt: null } });
  },

  findActiveDogEarWithBook(db: DbClient, id: string, userId: string) {
    return db.dogEar.findFirst({ where: { id, userId, deletedAt: null }, include: { book: true } });
  },

  findActiveDogEar(db: DbClient, id: string, userId: string) {
    return db.dogEar.findFirst({ where: { id, userId, deletedAt: null } });
  },

  findAnyDogEarWithBook(db: DbClient, id: string, userId: string) {
    return db.dogEar.findFirst({ where: { id, userId }, include: { book: true } });
  },

  findActiveDogEarOnPageExcluding(db: DbClient, bookId: string, pageNumber: number, excludeId: string) {
    return db.dogEar.findFirst({
      where: { bookId, pageNumber, deletedAt: null, id: { not: excludeId } }
    });
  },

  createDogEar(db: DbClient, data: Prisma.DogEarUncheckedCreateInput) {
    return db.dogEar.create({ data });
  },

  updateDogEarVersioned(
    db: DbClient,
    id: string,
    userId: string,
    expectedVersion: number,
    data: Prisma.DogEarUpdateManyMutationInput
  ) {
    return db.dogEar.updateMany({
      where: { id, userId, version: expectedVersion, deletedAt: null },
      data: { ...data, version: { increment: 1 } }
    });
  },

  softDeleteDogEarVersioned(db: DbClient, id: string, userId: string, expectedVersion: number, deletedAt: Date) {
    return db.dogEar.updateMany({
      where: { id, userId, deletedAt: null, version: expectedVersion },
      data: { deletedAt, version: { increment: 1 } }
    });
  },

  restoreDogEar(db: DbClient, id: string) {
    return db.dogEar.update({ where: { id }, data: { deletedAt: null, version: { increment: 1 } } });
  },

  getDogEarOrThrow(db: DbClient, id: string) {
    return db.dogEar.findUniqueOrThrow({ where: { id } });
  },

  // -- Annotations ------------------------------------------------------------

  listAnnotations(db: DbClient, userId: string, bookId: string, filter: TraceListFilter) {
    return db.annotation.findMany({
      where: {
        userId,
        bookId,
        deletedAt: null,
        ...(filter.pageNumber
          ? { startPage: { lte: filter.pageNumber }, endPage: { gte: filter.pageNumber } }
          : {}),
        ...(filter.keyword ? { content: { contains: filter.keyword, mode: 'insensitive' } } : {}),
        ...(hasDateRange(filter) ? { createdAt: createdAtRange(filter) } : {})
      },
      orderBy: { createdAt: 'desc' }
    });
  },

  findActiveAnnotationWithBook(db: DbClient, id: string, userId: string) {
    return db.annotation.findFirst({ where: { id, userId, deletedAt: null }, include: { book: true } });
  },

  findActiveAnnotation(db: DbClient, id: string, userId: string) {
    return db.annotation.findFirst({ where: { id, userId, deletedAt: null } });
  },

  findAnyAnnotationWithBook(db: DbClient, id: string, userId: string) {
    return db.annotation.findFirst({ where: { id, userId }, include: { book: true } });
  },

  createAnnotation(db: DbClient, data: Prisma.AnnotationUncheckedCreateInput) {
    return db.annotation.create({ data });
  },

  updateAnnotationVersioned(
    db: DbClient,
    id: string,
    userId: string,
    expectedVersion: number,
    data: Prisma.AnnotationUpdateManyMutationInput
  ) {
    return db.annotation.updateMany({
      where: { id, userId, deletedAt: null, version: expectedVersion },
      data: { ...data, version: { increment: 1 } }
    });
  },

  softDeleteAnnotationVersioned(db: DbClient, id: string, userId: string, expectedVersion: number) {
    return db.annotation.updateMany({
      where: { id, userId, deletedAt: null, version: expectedVersion },
      data: { deletedAt: new Date(), version: { increment: 1 } }
    });
  },

  restoreAnnotation(db: DbClient, id: string) {
    return db.annotation.update({ where: { id }, data: { deletedAt: null, version: { increment: 1 } } });
  },

  getAnnotationOrThrow(db: DbClient, id: string) {
    return db.annotation.findUniqueOrThrow({ where: { id } });
  },

  // -- Reread marks -----------------------------------------------------------

  listRereadMarks(db: DbClient, userId: string, bookId: string, filter: TraceListFilter) {
    return db.rereadMark.findMany({
      where: {
        userId,
        bookId,
        deletedAt: null,
        ...(filter.pageNumber ? { pageNumber: filter.pageNumber } : {}),
        ...(filter.keyword ? { reason: { contains: filter.keyword, mode: 'insensitive' } } : {}),
        ...(hasDateRange(filter) ? { createdAt: createdAtRange(filter) } : {})
      },
      orderBy: { createdAt: 'desc' }
    });
  },

  findActiveRereadWithBook(db: DbClient, id: string, userId: string) {
    return db.rereadMark.findFirst({ where: { id, userId, deletedAt: null }, include: { book: true } });
  },

  findActiveReread(db: DbClient, id: string, userId: string) {
    return db.rereadMark.findFirst({ where: { id, userId, deletedAt: null } });
  },

  findAnyRereadWithBook(db: DbClient, id: string, userId: string) {
    return db.rereadMark.findFirst({ where: { id, userId }, include: { book: true } });
  },

  createReread(db: DbClient, data: Prisma.RereadMarkUncheckedCreateInput) {
    return db.rereadMark.create({ data });
  },

  updateRereadVersioned(
    db: DbClient,
    id: string,
    userId: string,
    expectedVersion: number,
    data: Prisma.RereadMarkUpdateManyMutationInput
  ) {
    return db.rereadMark.updateMany({
      where: { id, userId, deletedAt: null, version: expectedVersion },
      data: { ...data, version: { increment: 1 } }
    });
  },

  softDeleteRereadVersioned(db: DbClient, id: string, userId: string, expectedVersion: number) {
    return db.rereadMark.updateMany({
      where: { id, userId, deletedAt: null, version: expectedVersion },
      data: { deletedAt: new Date(), version: { increment: 1 } }
    });
  },

  restoreReread(db: DbClient, id: string) {
    return db.rereadMark.update({ where: { id }, data: { deletedAt: null, version: { increment: 1 } } });
  },

  getRereadOrThrow(db: DbClient, id: string) {
    return db.rereadMark.findUniqueOrThrow({ where: { id } });
  }
};
