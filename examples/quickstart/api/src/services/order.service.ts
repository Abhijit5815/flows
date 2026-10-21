import { prisma } from '@/lib/prisma';

export const listForUser = (userId: number) => prisma.order.findMany({ where: { userId } });
