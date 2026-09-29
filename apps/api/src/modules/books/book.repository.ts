import { Prisma } from '@prisma/client';
import { prisma, type DbClient } from '../../lib/db.js';
import type { BookListFilter } from './schemas.js';

const activeTraceCounts = {
  dogEars: { where: { deletedAt: null } },
  annotations: { where: { deletedAt: null } },
  rereadMarks: { where: { deletedAt: null } },
  reflections: { where: { deletedAt: null } }
} satisfies Prisma.BookCountOutputTypeSelect;

const listInclude = {
  _count: { select: activeTraceCounts }
} satisfies Prisma.BookInclude;

const detailInclude = {
  _count: { select: activeTraceCounts },
  reflections: {
    where: { deletedAt: null },
    orderBy: [{ completedAt: 'desc' }, { createdAt: 'desc' }]
  }
} satisfies Prisma.BookInclude;

export type BookWithCounts = Prisma.BookGetPayload<{ include: typeof listInclude }>;
export type BookDetailRecord = Prisma.BookGetPayload<{ include: typeof detailInclude }>;

export interface BookUpdateFields {
  title?: string;
  author?: string | null;
  publisher?: string | null;
  publicationYear?: number | null;
  isbn?: string | null;
  pageCount?: number | null;
  coverUrl?: string | null;
}

export interface BookCreateData {
  title: string;
  author: string | null;
  publisher: string | null;
  publicationYear: number | null;
  isbn: string | null;
  pageCount: number | null;
  coverUrl: string | null;
  status: Prisma.BookCreateInput['status'];
}

function buildListWhere(userId: string, filter: BookListFilter): Prisma.BookWhereInput {
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

/** 列表：未删除书目及各类痕迹的有效数量。 */
export async function findBookPage(
  userId: string,
  filter: BookListFilter,
  skip: number,
  take: number,
  db: DbClient = prisma
): Promise<BookWithCounts[]> {
  return db.book.findMany({
    where: buildListWhere(userId, filter),
    orderBy: { updatedAt: 'desc' },
    skip,
    take,
    include: listInclude
  });
}

export async function countBooks(userId: string, filter: BookListFilter, db: DbClient = prisma): Promise<number> {
  return db.book.count({ where: buildListWhere(userId, filter) });
}

/** 列表页每本书最近一次痕迹活动时间（折角/批注/重读的创建、修改、恢复）。 */
export async function findLatestTraceTimes(
  userId: string,
  bookIds: string[],
  db: DbClient = prisma
): Promise<Map<string, Date | null>> {
  const rows = bookIds.length
    ? await db.activityEvent.groupBy({
        by: ['bookId'],
        where: {
          userId,
          bookId: { in: bookIds },
          entityType: { in: ['DOG_EAR', 'ANNOTATION', 'REREAD_MARK'] },
          action: { in: ['CREATED', 'UPDATED', 'RESTORED'] }
        },
        _max: { occurredAt: true }
      })
    : [];
  return new Map(rows.map((row) => [row.bookId, row._max.occurredAt]));
}

/** 书目详情：痕迹数量与历轮完成感受。 */
export async function findBookDetail(bookId: string, userId: string, db: DbClient = prisma) {
  return db.book.findFirst({
    where: { id: bookId, userId, deletedAt: null },
    include: detailInclude
  });
}

/** 供写操作校验归属用的未删除书目。 */
export async function findActiveBook(bookId: string, userId: string, db: DbClient = prisma) {
  return db.book.findFirst({ where: { id: bookId, userId, deletedAt: null } });
}

/** 已有痕迹使用到的最大页码，用于缩小总页数时的冲突校验。 */
export async function maximumTracePage(
  userId: string,
  bookId: string,
  db: DbClient = prisma
): Promise<number> {
  const [dogEar, annotation, reread] = await Promise.all([
    db.dogEar.aggregate({ where: { userId, bookId, deletedAt: null }, _max: { pageNumber: true } }),
    db.annotation.aggregate({ where: { userId, bookId, deletedAt: null }, _max: { endPage: true } }),
    db.rereadMark.aggregate({ where: { userId, bookId, deletedAt: null }, _max: { pageNumber: true } })
  ]);
  return Math.max(
    dogEar._max.pageNumber ?? 0,
    annotation._max.endPage ?? 0,
    reread._max.pageNumber ?? 0
  );
}

export async function createBook(userId: string, data: BookCreateData, db: DbClient) {
  return db.book.create({
    data: {
      userId,
      title: data.title,
      author: data.author,
      publisher: data.publisher,
      publicationYear: data.publicationYear,
      isbn: data.isbn,
      pageCount: data.pageCount,
      coverUrl: data.coverUrl,
      status: data.status
    }
  });
}

/** 乐观更新：版本号不匹配时 count 为 0，由服务层转成 409。 */
export async function updateActiveBookVersioned(
  bookId: string,
  userId: string,
  version: number,
  data: BookUpdateFields,
  db: DbClient
): Promise<number> {
  const result = await db.book.updateMany({
    where: { id: bookId, userId, deletedAt: null, version },
    data: { ...data, version: { increment: 1 } }
  });
  return result.count;
}

export async function findBookByIdOrThrow(bookId: string, db: DbClient) {
  return db.book.findUniqueOrThrow({ where: { id: bookId } });
}

/** 状态流转串行化：对书目行加 FOR UPDATE 锁，保证并发写入时审计顺序确定。 */
export async function lockBookForUpdate(bookId: string, userId: string, db: DbClient): Promise<void> {
  await db.$queryRaw`SELECT id FROM books WHERE id = ${bookId}::uuid AND user_id = ${userId}::uuid FOR UPDATE`;
}

export async function maxCompletionRound(bookId: string, db: DbClient): Promise<number> {
  const latest = await db.completionReflection.aggregate({
    where: { bookId },
    _max: { completionRound: true }
  });
  return latest._max.completionRound ?? 0;
}

export interface CompletionReflectionData {
  userId: string;
  bookId: string;
  completionRound: number;
  moodTags: Prisma.CompletionReflectionUncheckedCreateInput['moodTags'];
  reflection: string | null;
  completedAt: Date;
  editableUntil: Date;
  createdAt: Date;
}

export async function createCompletionReflection(data: CompletionReflectionData, db: DbClient) {
  return db.completionReflection.create({ data });
}

export async function updateBookStatus(bookId: string, status: Prisma.BookStatus, db: DbClient) {
  return db.book.update({
    where: { id: bookId },
    data: { status, version: { increment: 1 } }
  });
}

interface ChildIds {
  dogEars: string[];
  annotations: string[];
  rereadMarks: string[];
  reflections: string[];
}

/** 删除书目前列出全部有效子记录，用于逐条写 DELETED 审计事件。 */
export async function findActiveChildIds(bookId: string, db: DbClient): Promise<ChildIds> {
  const [dogEars, annotations, rereadMarks, reflections] = await Promise.all([
    db.dogEar.findMany({ where: { bookId, deletedAt: null }, select: { id: true } }),
    db.annotation.findMany({ where: { bookId, deletedAt: null }, select: { id: true } }),
    db.rereadMark.findMany({ where: { bookId, deletedAt: null }, select: { id: true } }),
    db.completionReflection.findMany({ where: { bookId, deletedAt: null }, select: { id: true } })
  ]);
  return {
    dogEars: dogEars.map((item) => item.id),
    annotations: annotations.map((item) => item.id),
    rereadMarks: rereadMarks.map((item) => item.id),
    reflections: reflections.map((item) => item.id)
  };
}

/**
 * 级联软删，与旧实现保持一致的执行顺序：
 * 四类子记录并发置删，再更新书目行。服务层必须已先取得 childIds 用于写审计。
 */
export async function softDeleteBookWithChildren(bookId: string, deletedAt: Date, db: DbClient): Promise<void> {
  await Promise.all([
    db.dogEar.updateMany({ where: { bookId, deletedAt: null }, data: { deletedAt, version: { increment: 1 } } }),
    db.annotation.updateMany({ where: { bookId, deletedAt: null }, data: { deletedAt, version: { increment: 1 } } }),
    db.rereadMark.updateMany({ where: { bookId, deletedAt: null }, data: { deletedAt, version: { increment: 1 } } }),
    db.completionReflection.updateMany({ where: { bookId, deletedAt: null }, data: { deletedAt, version: { increment: 1 } } })
  ]);
  await db.book.update({
    where: { id: bookId },
    data: { deletedAt, version: { increment: 1 } }
  });
}
