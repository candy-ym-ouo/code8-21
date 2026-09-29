import { Prisma } from '@prisma/client';
import type { BookStatus } from '@paper-book-traces/shared';
import type { DbClient } from '../../lib/prisma.js';

export interface ListBooksFilter {
  status?: BookStatus;
  search?: string;
}

const activeTraceCountInclude = {
  _count: {
    select: {
      dogEars: { where: { deletedAt: null } },
      annotations: { where: { deletedAt: null } },
      rereadMarks: { where: { deletedAt: null } },
      reflections: { where: { deletedAt: null } }
    }
  }
} satisfies Prisma.BookInclude;

function buildWhere(userId: string, filter: ListBooksFilter = {}): Prisma.BookWhereInput {
  return {
    userId,
    deletedAt: null,
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.search
      ? {
          OR: [
            { title: { contains: filter.search, mode: 'insensitive' } },
            { author: { contains: filter.search, mode: 'insensitive' } }
          ]
        }
      : {})
  };
}

export const booksRepository = {
  async list(
    db: DbClient,
    userId: string,
    filter: ListBooksFilter,
    skip: number,
    take: number
  ) {
    const where = buildWhere(userId, filter);
    return Promise.all([
      db.book.count({ where }),
      db.book.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip,
        take,
        include: activeTraceCountInclude
      })
    ]);
  },

  async latestTraceEventTimes(db: DbClient, userId: string, bookIds: string[]) {
    if (bookIds.length === 0) return [];
    return db.activityEvent.groupBy({
      by: ['bookId'],
      where: {
        userId,
        bookId: { in: bookIds },
        entityType: { in: ['DOG_EAR', 'ANNOTATION', 'REREAD_MARK'] },
        action: { in: ['CREATED', 'UPDATED', 'RESTORED'] }
      },
      _max: { occurredAt: true }
    });
  },

  async findDetailById(db: DbClient, userId: string, bookId: string) {
    return db.book.findFirst({
      where: { id: bookId, userId, deletedAt: null },
      include: {
        _count: {
          select: {
            dogEars: { where: { deletedAt: null } },
            annotations: { where: { deletedAt: null } },
            rereadMarks: { where: { deletedAt: null } },
            reflections: { where: { deletedAt: null } }
          }
        },
        reflections: {
          where: { deletedAt: null },
          orderBy: [{ completedAt: 'desc' }, { createdAt: 'desc' }]
        }
      }
    });
  },

  async findActiveById(db: DbClient, userId: string, bookId: string) {
    return db.book.findFirst({ where: { id: bookId, userId, deletedAt: null } });
  },

  async findByIdOrThrow(db: DbClient, bookId: string) {
    return db.book.findUniqueOrThrow({ where: { id: bookId } });
  },

  /** SELECT ... FOR UPDATE row lock; must run inside a transaction. */
  async lockForUpdate(db: DbClient, bookId: string, userId: string): Promise<void> {
    await db.$queryRaw`SELECT id FROM books WHERE id = ${bookId}::uuid AND user_id = ${userId}::uuid FOR UPDATE`;
  },

  async create(db: DbClient, data: Prisma.BookUncheckedCreateInput) {
    return db.book.create({ data });
  },

  async updateVersioned(
    db: DbClient,
    bookId: string,
    userId: string,
    expectedVersion: number,
    data: Prisma.BookUpdateManyMutationInput
  ) {
    return db.book.updateMany({
      where: { id: bookId, userId, deletedAt: null, version: expectedVersion },
      data: { ...data, version: { increment: 1 } }
    });
  },

  async updateStatus(db: DbClient, bookId: string, status: BookStatus) {
    return db.book.update({
      where: { id: bookId },
      data: { status, version: { increment: 1 } }
    });
  },

  async softDelete(db: DbClient, bookId: string, deletedAt: Date) {
    return db.book.update({
      where: { id: bookId },
      data: { deletedAt, version: { increment: 1 } }
    });
  }
};

export interface TracePageMaximums {
  dogEar: number | null;
  annotation: number | null;
  reread: number | null;
}

/** Storage queries for trace rows referenced while validating book mutations. */
export const traceIndexRepository = {
  async maximumTracePages(db: DbClient, userId: string, bookId: string): Promise<TracePageMaximums> {
    const [dogEar, annotation, reread] = await Promise.all([
      db.dogEar.aggregate({ where: { userId, bookId, deletedAt: null }, _max: { pageNumber: true } }),
      db.annotation.aggregate({ where: { userId, bookId, deletedAt: null }, _max: { endPage: true } }),
      db.rereadMark.aggregate({ where: { userId, bookId, deletedAt: null }, _max: { pageNumber: true } })
    ]);
    return {
      dogEar: dogEar._max.pageNumber,
      annotation: annotation._max.endPage,
      reread: reread._max.pageNumber
    };
  },

  async listActiveChildIds(db: DbClient, bookId: string) {
    return Promise.all([
      db.dogEar.findMany({ where: { bookId, deletedAt: null }, select: { id: true } }),
      db.annotation.findMany({ where: { bookId, deletedAt: null }, select: { id: true } }),
      db.rereadMark.findMany({ where: { bookId, deletedAt: null }, select: { id: true } }),
      db.completionReflection.findMany({ where: { bookId, deletedAt: null }, select: { id: true } })
    ]);
  },

  async softDeleteChildren(db: DbClient, bookId: string, deletedAt: Date) {
    await Promise.all([
      db.dogEar.updateMany({ where: { bookId, deletedAt: null }, data: { deletedAt, version: { increment: 1 } } }),
      db.annotation.updateMany({ where: { bookId, deletedAt: null }, data: { deletedAt, version: { increment: 1 } } }),
      db.rereadMark.updateMany({ where: { bookId, deletedAt: null }, data: { deletedAt, version: { increment: 1 } } }),
      db.completionReflection.updateMany({
        where: { bookId, deletedAt: null },
        data: { deletedAt, version: { increment: 1 } }
      })
    ]);
  },

  async maxCompletionRound(db: DbClient, bookId: string): Promise<number> {
    const latest = await db.completionReflection.aggregate({
      where: { bookId },
      _max: { completionRound: true }
    });
    return latest._max.completionRound ?? 0;
  },

  createCompletionReflection(
    db: DbClient,
    data: Prisma.CompletionReflectionUncheckedCreateInput
  ) {
    return db.completionReflection.create({ data });
  }
};
