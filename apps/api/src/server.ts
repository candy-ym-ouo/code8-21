import { buildApp } from './app.js';
import { env } from './config/env.js';
import { prisma } from './lib/db.js';

async function main(): Promise<void> {
  const app = await buildApp();
  await prisma.$connect();
  await app.listen({ host: '0.0.0.0', port: env.PORT });

  const close = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void close('SIGINT'));
  process.on('SIGTERM', () => void close('SIGTERM'));
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
