import { createHash, randomBytes } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env.js';
import { prisma } from './db.js';
import { AppError } from './errors.js';

export const SESSION_COOKIE = 'pbt_session';

export interface AuthUser {
  id: string;
  email: string;
  createdAt: Date;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function hashPassword(password: string): Promise<string> {
  return argonHash(password, { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 });
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await argonVerify(passwordHash, password);
  } catch {
    return false;
  }
}

export async function createSession(
  userId: string,
  reply: FastifyReply,
  rotateOthers = false
): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  if (rotateOthers) {
    await prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() }
    });
  }
  await prisma.session.create({
    data: { userId, tokenHash: tokenHash(token), expiresAt }
  });
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax',
    maxAge: env.SESSION_TTL_DAYS * 24 * 60 * 60
  });
}

export async function deleteCurrentSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.cookies[SESSION_COOKIE];
  if (token) {
    await prisma.session.updateMany({
      where: { tokenHash: tokenHash(token), revokedAt: null },
      data: { revokedAt: new Date() }
    });
  }
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export async function requireAuth(request: FastifyRequest): Promise<void> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) throw new AppError(401, 'UNAUTHENTICATED', '请先登录');
  const session = await prisma.session.findUnique({
    where: { tokenHash: tokenHash(token) },
    include: { user: true }
  });
  if (
    !session ||
    session.revokedAt ||
    session.expiresAt.getTime() <= Date.now() ||
    session.user.status !== 'ACTIVE' ||
    session.user.deletedAt
  ) {
    throw new AppError(401, 'UNAUTHENTICATED', '登录状态已失效');
  }

  request.authUser = {
    id: session.user.id,
    email: session.user.email,
    createdAt: session.user.createdAt
  };

  const now = Date.now();
  const rollingInterval = 24 * 60 * 60 * 1000;
  if (session.expiresAt.getTime() - now < env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000 - rollingInterval) {
    const expiresAt = new Date(now + env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
    await prisma.session.update({ where: { id: session.id }, data: { expiresAt } });
  }
}

export function currentUser(request: FastifyRequest): AuthUser {
  if (!request.authUser) throw new AppError(401, 'UNAUTHENTICATED', '请先登录');
  return request.authUser;
}
