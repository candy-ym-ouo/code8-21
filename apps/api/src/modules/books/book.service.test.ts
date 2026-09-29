import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityAction, ActivityEntityType } from '@prisma/client';
import type { DbClient } from '../../lib/db.js';

// 服务层依赖在模块加载时就绑定到存储层。每个用例先 resetModules，再用 vi.mock
// 注入内存假实现，保证用例之间互不串状态，且无需数据库即可验证
// “业务对象 + 审计事件”的事务编排与审计顺序。

interface RecordedEvent {
  entityType: ActivityEntityType;
  entityId?: string | null;
  action: ActivityAction;
}

interface FakeDb {
  events: RecordedEvent[];
  loadBookService(): Promise<typeof import('./book.service.js')>;
}

function setupFakeDb(initial: {
  book?: Record<string, unknown> | null;
  children?: {
    dogEars: Array<{ id: string }>;
    annotations: Array<{ id: string }>;
    rereadMarks: Array<{ id: string }>;
    reflections: Array<{ id: string }>;
  };
}): FakeDb {
  const events: RecordedEvent[] = [];
  const tx = {
    book: {
      findFirst: async () => initial.book ?? null,
      update: async () => ({}),
      updateMany: async () => ({ count: 1 })
    },
    dogEar: {
      findMany: async () => initial.children?.dogEars ?? [],
      updateMany: async () => ({ count: 1 })
    },
    annotation: {
      findMany: async () => initial.children?.annotations ?? [],
      updateMany: async () => ({ count: 1 })
    },
    rereadMark: {
      findMany: async () => initial.children?.rereadMarks ?? [],
      updateMany: async () => ({ count: 1 })
    },
    completionReflection: {
      findMany: async () => initial.children?.reflections ?? [],
      updateMany: async () => ({ count: 1 })
    },
    $queryRaw: async () => []
  } as unknown as DbClient;

  const prisma = {
    $transaction: async <T>(work: (tx: DbClient) => Promise<T>): Promise<T> => work(tx)
  };

  vi.doMock('../../lib/db.js', () => ({ prisma }));
  vi.doMock('../../lib/events.js', () => ({
    writeEvent: async (_tx: DbClient, input: RecordedEvent) => {
      events.push({ entityType: input.entityType, entityId: input.entityId, action: input.action });
    }
  }));

  return {
    events,
    loadBookService: () => import('./book.service.js')
  };
}

const USER_ID = '22222222-2222-2222-2222-222222222222';
const BOOK_ID = '11111111-1111-1111-1111-111111111111';

describe('book service audit ordering', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('deletes book before children and keeps child order dog-ear -> annotation -> reread -> reflection', async () => {
    const children = {
      dogEars: [{ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }],
      annotations: [{ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }],
      rereadMarks: [{ id: 'cccccccc-cccc-cccc-cccc-cccccccccccc' }],
      reflections: [{ id: 'dddddddd-dddd-dddd-dddd-dddddddddddd' }]
    };
    const fake = setupFakeDb({ book: { id: BOOK_ID, userId: USER_ID, version: 3, title: '旧书', status: 'READ' }, children });
    const { deleteBook } = await fake.loadBookService();

    await deleteBook(BOOK_ID, USER_ID, 3);

    expect(fake.events).toEqual([
      { entityType: 'BOOK', entityId: BOOK_ID, action: 'DELETED' },
      { entityType: 'DOG_EAR', entityId: children.dogEars[0]!.id, action: 'DELETED' },
      { entityType: 'ANNOTATION', entityId: children.annotations[0]!.id, action: 'DELETED' },
      { entityType: 'REREAD_MARK', entityId: children.rereadMarks[0]!.id, action: 'DELETED' },
      { entityType: 'COMPLETION_REFLECTION', entityId: children.reflections[0]!.id, action: 'DELETED' }
    ]);
  });

  it('rejects delete with a stale version before any write or audit event', async () => {
    const fake = setupFakeDb({ book: { id: BOOK_ID, userId: USER_ID, version: 4, title: '旧书', status: 'TO_READ' } });
    const { deleteBook } = await fake.loadBookService();

    await expect(deleteBook(BOOK_ID, USER_ID, 3)).rejects.toMatchObject({
      statusCode: 409,
      code: 'STALE_WRITE'
    });
    expect(fake.events).toEqual([]);
  });

  it('returns 404 when the book does not belong to the user', async () => {
    const fake = setupFakeDb({ book: null });
    const { deleteBook } = await fake.loadBookService();

    await expect(deleteBook(BOOK_ID, USER_ID)).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND'
    });
    expect(fake.events).toEqual([]);
  });
});
