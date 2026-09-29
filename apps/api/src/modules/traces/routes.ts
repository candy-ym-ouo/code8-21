import type { FastifyPluginAsync } from 'fastify';
import { currentUser, requireAuth } from '../../lib/auth.js';
import { AppError } from '../../lib/errors.js';
import { optionalDate, paginationFromQuery } from '../../lib/http.js';
import { traceService } from './service.js';

export const traceRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  app.get('/books/:bookId/traces', async (request) => {
    const { bookId } = request.params as { bookId: string };
    const query = request.query as Record<string, unknown>;
    const type = typeof query.type === 'string' && query.type !== 'ALL' ? query.type : undefined;
    const pageNumber = query.pageNumber === undefined ? undefined : Number(query.pageNumber);
    if (pageNumber !== undefined && (!Number.isInteger(pageNumber) || pageNumber < 1)) {
      throw new AppError(422, 'VALIDATION_ERROR', '页码无效');
    }
    const keyword = typeof query.keyword === 'string' ? query.keyword.trim() : '';
    const from = optionalDate(query.from, 'from');
    const to = optionalDate(query.to, 'to');
    const { page, pageSize } = paginationFromQuery(request);

    return traceService.listTraces(currentUser(request).id, bookId, {
      type,
      pageNumber,
      keyword,
      from,
      to,
      page,
      pageSize
    });
  });

  app.post('/books/:bookId/dog-ears', async (request, reply) => {
    const { bookId } = request.params as { bookId: string };
    const result = await traceService.createDogEar(currentUser(request).id, bookId, request.body);
    return reply.status(result.status).send(result.body);
  });

  app.patch('/dog-ears/:dogEarId', async (request) => {
    const { dogEarId } = request.params as { dogEarId: string };
    return traceService.updateDogEar(currentUser(request).id, dogEarId, request.body);
  });

  app.delete('/dog-ears/:dogEarId', async (request, reply) => {
    const { dogEarId } = request.params as { dogEarId: string };
    await traceService.deleteDogEar(currentUser(request).id, dogEarId, request.body);
    return reply.status(204).send();
  });

  app.post('/dog-ears/:dogEarId/restore', async (request) => {
    const { dogEarId } = request.params as { dogEarId: string };
    return traceService.restoreDogEar(currentUser(request).id, dogEarId);
  });

  app.post('/books/:bookId/annotations', async (request, reply) => {
    const { bookId } = request.params as { bookId: string };
    const result = await traceService.createAnnotation(currentUser(request).id, bookId, request.body);
    return reply.status(result.status).send(result.body);
  });

  app.patch('/annotations/:annotationId', async (request) => {
    const { annotationId } = request.params as { annotationId: string };
    return traceService.updateAnnotation(currentUser(request).id, annotationId, request.body);
  });

  app.delete('/annotations/:annotationId', async (request, reply) => {
    const { annotationId } = request.params as { annotationId: string };
    await traceService.deleteAnnotation(currentUser(request).id, annotationId, request.body);
    return reply.status(204).send();
  });

  app.post('/annotations/:annotationId/restore', async (request) => {
    const { annotationId } = request.params as { annotationId: string };
    return traceService.restoreAnnotation(currentUser(request).id, annotationId);
  });

  app.post('/books/:bookId/reread-marks', async (request, reply) => {
    const { bookId } = request.params as { bookId: string };
    const result = await traceService.createReread(currentUser(request).id, bookId, request.body);
    return reply.status(result.status).send(result.body);
  });

  app.patch('/reread-marks/:rereadMarkId', async (request) => {
    const { rereadMarkId } = request.params as { rereadMarkId: string };
    return traceService.updateReread(currentUser(request).id, rereadMarkId, request.body);
  });

  app.delete('/reread-marks/:rereadMarkId', async (request, reply) => {
    const { rereadMarkId } = request.params as { rereadMarkId: string };
    await traceService.deleteReread(currentUser(request).id, rereadMarkId, request.body);
    return reply.status(204).send();
  });

  app.post('/reread-marks/:rereadMarkId/restore', async (request) => {
    const { rereadMarkId } = request.params as { rereadMarkId: string };
    return traceService.restoreReread(currentUser(request).id, rereadMarkId);
  });
};
