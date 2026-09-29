import { Prisma, PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error']
});

/**
 * Either the root client or a transaction client.
 *
 * Repositories accept this alias so the same storage function can run inside a
 * transaction (business rows commit together with their audit event) or
 * directly against the root client for read-only requests. The root
 * ``PrismaClient`` is assignable to ``TransactionClient``.
 */
export type DbClient = Prisma.TransactionClient;
