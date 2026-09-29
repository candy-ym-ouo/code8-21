import type { FastifyPluginAsync } from 'fastify';
import { currentUser, requireAuth } from '../../lib/auth.js';
import { paginationFromQuery, parseId } from '../../lib/http.js';
import {
  annotationCreateSchema,
  annotationUpdateSchema,
  deleteSchema,
  dogEarCreateSchema,
  dogEarUpdateSchema,
  parseBody,
  parseTraceListQuery,
  rereadCreateSchema,
  rereadUpdateSchema
} from './schemas.js';
import {
  createAnnotationTrace,
  createDogEarTrace,
  createRereadTrace,
  deleteAnnotationTrace,
  deleteDogEarTrace,
  deleteRereadTrace,
  listTraces,
  restoreAnnotationTrace,
  restoreDogEarTrace,
  restoreRereadTrace,
  updateAnnotationTrace,
  updateDogEarTrace,
  updateRereadTrace
} from './trace.service.js';

export const traceRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  app.get('/books/:bookId/traces', async (request) => {
    const bookId = parseId((request.params as { bookId: string }).bookId, 'bookId');
    const userId = currentUser(request).id;
    const filter = parseTraceListQuery(request.query as Record<string, unknown>);
    const { page, pageSize } = paginationFromQuery(request);
    return listTraces(userId, bookId, filter, page, pageSize);
  });

  app.post('/books/:bookId/dog-ears', async (request, reply) => {
    const bookId = parseId((request.params as { bookId: string }).bookId, 'bookId');
    const parsed = parseBody(dogEarCreateSchema, request.body, '折角信息无效');
    const result = await createDogEarTrace(currentUser(request).id, bookId, parsed);
    if (result.idempotent) {
      return reply.status(200).send({ dogEar: result.dogEar, idempotent: true });
    }
    return reply.status(201).send({ dogEar: result.dogEar });
  });

  app.patch('/dog-ears/:dogEarId', async (request) => {
    const id = parseId((request.params as { dogEarId: string }).dogEarId, 'dogEarId');
    const parsed = parseBody(dogEarUpdateSchema, request.body, '折角信息无效');
    return updateDogEarTrace(id, currentUser(request).id, parsed);
  });

  app.delete('/dog-ears/:dogEarId', async (request, reply) => {
    const id = parseId((request.params as { dogEarId: string }).dogEarId, 'dogEarId');
    const parsed = parseBody(deleteSchema, request.body, '删除参数无效');
    await deleteDogEarTrace(id, currentUser(request).id, parsed);
    return reply.status(204).send();
  });

  app.post('/dog-ears/:dogEarId/restore', async (request) => {
    const id = parseId((request.params as { dogEarId: string }).dogEarId, 'dogEarId');
    return restoreDogEarTrace(id, currentUser(request).id);
  });

  app.post('/books/:bookId/annotations', async (request, reply) => {
    const bookId = parseId((request.params as { bookId: string }).bookId, 'bookId');
    const parsed = parseBody(annotationCreateSchema, request.body, '批注信息无效');
    const result = await createAnnotationTrace(currentUser(request).id, bookId, parsed);
    return reply.status(201).send(result);
  });

  app.patch('/annotations/:annotationId', async (request) => {
    const id = parseId((request.params as { annotationId: string }).annotationId, 'annotationId');
    const parsed = parseBody(annotationUpdateSchema, request.body, '批注信息无效');
    return updateAnnotationTrace(id, currentUser(request).id, parsed);
  });

  app.delete('/annotations/:annotationId', async (request, reply) => {
    const id = parseId((request.params as { annotationId: string }).annotationId, 'annotationId');
    const parsed = parseBody(deleteSchema, request.body, '删除参数无效');
    await deleteAnnotationTrace(id, currentUser(request).id, parsed);
    return reply.status(204).send();
  });

  app.post('/annotations/:annotationId/restore', async (request) => {
    const id = parseId((request.params as { annotationId: string }).annotationId, 'annotationId');
    return restoreAnnotationTrace(id, currentUser(request).id);
  });

  app.post('/books/:bookId/reread-marks', async (request, reply) => {
    const bookId = parseId((request.params as { bookId: string }).bookId, 'bookId');
    const parsed = parseBody(rereadCreateSchema, request.body, '重读信息无效');
    const result = await createRereadTrace(currentUser(request).id, bookId, parsed);
    return reply.status(201).send(result);
  });

  app.patch('/reread-marks/:rereadMarkId', async (request) => {
    const id = parseId((request.params as { rereadMarkId: string }).rereadMarkId, 'rereadMarkId');
    const parsed = parseBody(rereadUpdateSchema, request.body, '重读信息无效');
    return updateRereadTrace(id, currentUser(request).id, parsed);
  });

  app.delete('/reread-marks/:rereadMarkId', async (request, reply) => {
    const id = parseId((request.params as { rereadMarkId: string }).rereadMarkId, 'rereadMarkId');
    const parsed = parseBody(deleteSchema, request.body, '删除参数无效');
    await deleteRereadTrace(id, currentUser(request).id, parsed);
    return reply.status(204).send();
  });

  app.post('/reread-marks/:rereadMarkId/restore', async (request) => {
    const id = parseId((request.params as { rereadMarkId: string }).rereadMarkId, 'rereadMarkId');
    return restoreRereadTrace(id, currentUser(request).id);
  });
};
