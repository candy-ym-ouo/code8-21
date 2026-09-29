import type { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@prisma/client';
import { ACTIVITY_ACTIONS, ACTIVITY_ENTITY_TYPES, type ActivityAction, type ActivityEntityType } from '@paper-book-traces/shared';
import { prisma } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { currentUser, requireAuth } from '../../lib/auth.js';
import { optionalDate, paginationFromQuery, parseId } from '../../lib/http.js';

export const timelineRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  app.get('/timeline', async (request) => {
    const { page, pageSize, skip } = paginationFromQuery(request);
    const query = request.query as Record<string, unknown>;
    const userId = currentUser(request).id;
    const bookId = typeof query.bookId === 'string' && query.bookId ? parseId(query.bookId, 'bookId') : undefined;
    const action = typeof query.eventType === 'string' && query.eventType !== 'ALL' ? query.eventType : undefined;
    const entityType =
      typeof query.entityType === 'string' && query.entityType !== 'ALL' ? query.entityType : undefined;
    const from = optionalDate(query.from, 'from');
    const to = optionalDate(query.to, 'to');

    if (action && !ACTIVITY_ACTIONS.includes(action as ActivityAction)) {
      throw new AppError(422, 'VALIDATION_ERROR', '事件类型无效');
    }
    if (entityType && !ACTIVITY_ENTITY_TYPES.includes(entityType as ActivityEntityType)) {
      throw new AppError(422, 'VALIDATION_ERROR', '对象类型无效');
    }

    const where: Prisma.ActivityEventWhereInput = {
      userId,
      ...(bookId ? { bookId } : {}),
      ...(action ? { action: action as ActivityAction } : {}),
      ...(entityType ? { entityType: entityType as ActivityEntityType } : {}),
      ...(from || to
        ? {
            occurredAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {})
            }
          }
        : {})
    };

    const [total, events] = await Promise.all([
      prisma.activityEvent.count({ where }),
      prisma.activityEvent.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        skip,
        take: pageSize,
        include: { book: { select: { title: true } } }
      })
    ]);

    return {
      items: events.map((event) => ({
        id: event.id,
        bookId: event.bookId,
        bookTitle: event.book?.title ?? '已删除书目',
        entityType: event.entityType,
        entityId: event.entityId,
        action: event.action,
        payload: event.payloadJson,
        occurredAt: event.occurredAt
      })),
      pagination: { page, pageSize, total }
    };
  });
};
