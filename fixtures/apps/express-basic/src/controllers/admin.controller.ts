import type { Request, Response } from 'express';
import { prisma } from '@/lib/prisma';

export class AdminController {
  stats = async (req: Request, res: Response) => {
    const [users, orders] = await Promise.all([prisma.user.count(), prisma.order.count()]);
    res.json({ users, orders });
  };

  maintenance = (req: Request, res: Response) => {
    res.sendStatus(204);
  };
}
