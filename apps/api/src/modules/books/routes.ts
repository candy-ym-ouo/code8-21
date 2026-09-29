import type { FastifyPluginAsync } from 'fastify';
import { currentUser, requireAuth } from '../../lib/auth.js';
import { paginationFromQuery, parseId } from '../../lib/http.js';
import {
  changeBookStatus,
  createBook,
  deleteBook,
  getBook,
  listBooks,
  updateBook
} from './book.service.js';
import { optionalVersion, parseBody, parseBookListQuery, createBookSchema, statusSchema, updateBookSchema } from './schemas.js';

export const bookRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  app.get('/books', async (request) => {
    const { page, pageSize, skip } = paginationFromQuery(request);
    const userId = currentUser(request).id;
    const filter = parseBookListQuery(request.query as Record<string, unknown>);
    return listBooks(userId, filter, page, pageSize, skip);
  });

  app.post('/books', async (request, reply) => {
    const data = parseBody(createBookSchema, request.body, '书目信息无效');
    const book = await createBook(currentUser(request).id, data);
    return reply.status(201).send(book);
  });

  app.get('/books/:bookId', async (request) => {
    const bookId = parseId((request.params as { bookId: string }).bookId, 'bookId');
    return getBook(bookId, currentUser(request).id);
  });

  app.patch('/books/:bookId', async (request) => {
    const bookId = parseId((request.params as { bookId: string }).bookId, 'bookId');
    const data = parseBody(updateBookSchema, request.body, '书目信息无效');
    return updateBook(bookId, currentUser(request).id, data);
  });

  app.patch('/books/:bookId/status', async (request) => {
    const bookId = parseId((request.params as { bookId: string }).bookId, 'bookId');
    const data = parseBody(statusSchema, request.body, '状态信息无效');
    return changeBookStatus(bookId, currentUser(request).id, data);
  });

  app.delete('/books/:bookId', async (request, reply) => {
    const bookId = parseId((request.params as { bookId: string }).bookId, 'bookId');
    await deleteBook(bookId, currentUser(request).id, optionalVersion(request.body));
    return reply.status(204).send();
  });
};
