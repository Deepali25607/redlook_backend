import { PrismaClient } from '@prisma/client';

// Single shared client. Avoids exhausting connections during dev hot-reload.
export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'production' ? ['error'] : ['warn', 'error'],
});
