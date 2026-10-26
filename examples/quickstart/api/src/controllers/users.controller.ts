import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '@/config';
import { fail, ok } from '@/lib/envelope';
import { prisma } from '@/lib/prisma';

export async function register(req: Request, res: Response) {
  const existing = await prisma.user.findUnique({ where: { email: req.body.email } });
  if (existing) return fail(res, 409, 'email already registered');
  const user = await prisma.user.create({ data: req.body });
  return ok(res, { id: user.id, email: user.email }, 201);
}

export async function login(req: Request, res: Response) {
  const user = await prisma.user.findUnique({ where: { email: req.body.email } });
  if (!user || user.password !== req.body.password) return fail(res, 401, 'wrong email or password');
  return ok(res, { token: jwt.sign({ id: user.id, role: user.role }, JWT_SECRET) });
}

export const me = (req: Request, res: Response) => ok(res, res.locals.user);

export async function updateMe(req: Request, res: Response) {
  const user = await prisma.user.update({ where: { id: res.locals.user.id }, data: req.body });
  return ok(res, { id: user.id, email: user.email, name: user.name });
}

// Tokens are stateless, so signing out is the client dropping its token; the route confirms it.
export const logout = (req: Request, res: Response) => res.sendStatus(204);

export async function getById(req: Request, res: Response) {
  const user = await prisma.user.findUnique({ where: { id: Number(req.params.id) } });
  return user ? ok(res, user) : fail(res, 404, 'user not found');
}

export async function update(req: Request, res: Response) {
  const user = await prisma.user.update({ where: { id: Number(req.params.id) }, data: req.body });
  return ok(res, user);
}

// Looks like a handler, but no route uses it.
export async function exportCsv(req: Request, res: Response) {
  const users = await prisma.user.findMany();
  res.type('text/csv').send(users.map((user) => user.email).join('\n'));
}
