import type { Request, Response } from 'express';
import { fail, ok } from '@/lib/envelope';
import { prisma } from '@/lib/prisma';

export async function list(req: Request, res: Response) {
  return ok(res, await prisma.cartItem.findMany({ where: { userId: res.locals.user.id } }));
}

export async function addItem(req: Request, res: Response) {
  const product = await prisma.product.findUnique({ where: { id: req.body.productId } });
  if (!product) return fail(res, 404, 'product not found');
  return ok(res, await prisma.cartItem.create({ data: { ...req.body, userId: res.locals.user.id } }), 201);
}
