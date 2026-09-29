import type { FastifyPluginAsync } from 'fastify';
import { currentUser, requireAuth } from '../../lib/auth.js';
import { paginationFromQuery } from '../../lib/http.js';
import { bookService } from './service.js';

export const bookRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  app.get('/books', async (request) => {
    const { page, pageSize, skip } = paginationFromQuery(request);
    const query = request.query as Record<string, unknown>;
    return bookService.listBooks(currentUser(request).id, {
      page,
      pageSize,
      skip,
      status: typeof query.status === 'string' ? query.status : undefined,
      search: typeof query.search === 'string' ? query.search : undefined
    });
  });

  app.post('/books', async (request, reply) => {
    const result = await bookService.createBook(currentUser(request).id, request.body);
    return reply.status(result.status).send(result.body);
  });

  app.get('/books/:bookId', async (request) => {
    const { bookId } = request.params as { bookId: string };
    return bookService.getBook(currentUser(request).id, bookId);
  });

  app.patch('/books/:bookId', async (request) => {
    const { bookId } = request.params as { bookId: string };
    return bookService.updateBook(currentUser(request).id, bookId, request.body);
  });

  app.patch('/books/:bookId/status', async (request) => {
    const { bookId } = request.params as { bookId: string };
    return bookService.changeStatus(currentUser(request).id, bookId, request.body);
  });

  app.delete('/books/:bookId', async (request, reply) => {
    const { bookId } = request.params as { bookId: string };
    await bookService.deleteBook(currentUser(request).id, bookId, request.body);
    return reply.status(204).send();
  });
};
