import type { Request, Response } from 'express';
import { fail, ok } from '@/lib/envelope';
import { prisma } from '@/lib/prisma';
import { createOrderSchema } from '@/schemas/order.schema';
import * as orderService from '@/services/order.service';

export const orders = {
  async list(req: Request, res: Response) {
    return ok(res, await orderService.listForUser(res.locals.user.id));
  },
  async create(req: Request, res: Response) {
    const input = createOrderSchema.parse(req.body);
    const product = await prisma.product.findUnique({ where: { id: input.productId } });
    if (!product) return fail(res, 404, 'product not found');
    return ok(res, await prisma.order.create({ data: { ...input, userId: res.locals.user.id } }), 201);
  },
  async getById(req: Request, res: Response) {
    const order = await prisma.order.findUnique({ where: { id: Number(req.params.orderId) } });
    return order ? ok(res, order) : fail(res, 404, 'order not found');
  },
  async cancel(req: Request, res: Response) {
    await prisma.order.update({ where: { id: Number(req.params.orderId) }, data: { status: 'cancelled' } });
    return res.status(204).end();
  },
};
