import { Prisma, PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error']
});

/**
 * 存储层使用的数据库客户端：只读查询可使用普通客户端，
 * 事务内的写入必须由服务层传入事务客户端，保证业务对象与审计事件同事务提交。
 */
export type DbClient = Prisma.TransactionClient;
