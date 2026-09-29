import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { bookService as BookService } from '../modules/books/service.js';

/**
 * Service-layer regression tests for the guarantees called out during the
 * refactor:
 *
 *  1. Concurrent writes cannot reorder the audit trail: a status change takes
 *     a ``SELECT ... FOR UPDATE`` row lock before reading the book, and every
 *     business row commits together with its ActivityEvent rows in one
 *     interactive transaction.
 *  2. The audit events are emitted in the exact same sequence as before the
 *     refactor (book status before reflection completion; book deletion before
 *     the cascaded child deletions).
 *
 * The Prisma client is replaced with an in-memory fake that records every
 * model call and every audit write in order, so no database is required.
 */

const USER_ID = '22222222-2222-4222-8222-222222222222';
const BOOK_ID = '11111111-1111-4111-8111-111111111111';
const DOG_EAR_ID = '44444444-4444-4444-8444-444444444444';

const { eventLog, callLog, installPrisma } = vi.hoisted(() => {
  const USER_ID = '22222222-2222-4222-8222-222222222222';
  const BOOK_ID = '11111111-1111-4111-8111-111111111111';
  const eventLog: Array<{ entityType: string; action: string }> = [];
  const callLog: Array<{ model: string; method: string }> = [];

  function readingBook(overrides: Record<string, unknown> = {}) {
    return {
      id: BOOK_ID,
      userId: USER_ID,
      version: 1,
      title: '书',
      author: null,
      publisher: null,
      publicationYear: null,
      isbn: null,
      pageCount: 100,
      coverUrl: null,
      status: 'READING',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      deletedAt: null,
      ...overrides
    };
  }

  /** Build a fake Prisma model delegate that records every invoked method. */
  function fakeModel(name: string, resolve: (method: string) => unknown) {
    return new Proxy(
      {},
      {
        get(_target, method: string) {
          return (...args: unknown[]) => {
            callLog.push({ model: name, method });
            return Promise.resolve(resolve(method, ...args));
          };
        }
      }
    );
  }

  interface FakeOptions {
    dogEarChildIds?: string[];
  }

  function installPrisma(options: FakeOptions = {}) {
    const bookModel = fakeModel('book', (method) => {
      switch (method) {
        case 'findFirst':
          return readingBook();
        case 'findUniqueOrThrow':
          return readingBook({ status: 'READ', version: 2 });
        case 'update':
          return readingBook({ status: 'READ', version: 2 });
        case 'updateMany':
          return { count: 1 };
        default:
          return undefined;
      }
    });

    const reflectionModel = fakeModel('completionReflection', (method) => {
      if (method === 'aggregate') return { _max: { completionRound: null } };
      if (method === 'create') return { id: '33333333-3333-4333-8333-333333333333', completionRound: 1 };
      if (method === 'findMany') return [];
      return { count: 1 };
    });

    const dogEarModel = fakeModel('dogEar', (method) => {
      if (method === 'aggregate') return { _max: { pageNumber: null } };
      if (method === 'findMany') return (options.dogEarChildIds ?? []).map((id) => ({ id }));
      return { count: 1 };
    });
    const annotationModel = fakeModel('annotation', (method) =>
      method === 'aggregate' ? { _max: { endPage: null } } : method === 'findMany' ? [] : { count: 1 }
    );
    const rereadModel = fakeModel('rereadMark', (method) =>
      method === 'aggregate' ? { _max: { pageNumber: null } } : method === 'findMany' ? [] : { count: 1 }
    );
    const eventModel = fakeModel('activityEvent', () => undefined);

    const tx = {
      $queryRaw: async () => {
        callLog.push({ model: 'book', method: '$queryRaw' });
      },
      book: bookModel,
      completionReflection: reflectionModel,
      dogEar: dogEarModel,
      annotation: annotationModel,
      rereadMark: rereadModel,
      activityEvent: eventModel
    };

    const prisma = {
      ...tx,
      $transaction: (work: (client: typeof tx) => unknown) => work(tx)
    };

    return { prisma, tx };
  }

  return { eventLog, callLog, installPrisma };
});

vi.mock('../../lib/events.js', () => ({
  writeEvent: async (_tx: unknown, input: unknown) => {
    eventLog.push(input as { entityType: string; action: string });
  }
}));

let bookService: typeof BookService;

beforeEach(async () => {
  eventLog.length = 0;
  callLog.length = 0;
  vi.resetModules();
});

describe('book service audit ordering', () => {
  it('locks the book row before reading it during a status change', async () => {
    vi.doMock('../../lib/prisma.js', () => ({ prisma: installPrisma().prisma }));
    ({ bookService } = await import('../modules/books/service.js'));

    await bookService.changeStatus(USER_ID, BOOK_ID, {
      status: 'READ',
      reflection: { moodTags: ['MOVED'], text: '好看' }
    });

    const lockIndex = callLog.findIndex((c) => c.model === 'book' && c.method === '$queryRaw');
    const readIndex = callLog.findIndex((c) => c.model === 'book' && c.method === 'findFirst');
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(readIndex).toBeGreaterThan(lockIndex);
  });

  it('writes the book status event before the completion reflection event', async () => {
    vi.doMock('../../lib/prisma.js', () => ({ prisma: installPrisma().prisma }));
    ({ bookService } = await import('../modules/books/service.js'));

    await bookService.changeStatus(USER_ID, BOOK_ID, {
      status: 'READ',
      reflection: { moodTags: ['CALM'], text: '' }
    });

    expect(eventLog).toEqual([
      { entityType: 'BOOK', action: 'STATUS_CHANGED' },
      { entityType: 'COMPLETION_REFLECTION', action: 'COMPLETED' }
    ]);
  });

  it('emits the book deletion event before the cascaded child deletion events', async () => {
    vi.doMock('../../lib/prisma.js', () => ({
      prisma: installPrisma({ dogEarChildIds: [DOG_EAR_ID] }).prisma
    }));
    ({ bookService } = await import('../modules/books/service.js'));

    await bookService.deleteBook(USER_ID, BOOK_ID, undefined);

    expect(eventLog[0]).toEqual({ entityType: 'BOOK', action: 'DELETED' });
    expect(eventLog).toContainEqual({ entityType: 'DOG_EAR', action: 'DELETED' });
    expect(eventLog.findIndex((e) => e.entityType === 'BOOK')).toBeLessThan(
      eventLog.findIndex((e) => e.entityType === 'DOG_EAR')
    );
  });
});
