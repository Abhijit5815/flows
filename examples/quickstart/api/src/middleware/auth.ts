import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '@/config';
import { fail } from '@/lib/envelope';

export type AuthUser = { id: number; role: string };

// Custom JWT guard: reads the Bearer token and rejects the request without a valid one.
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return fail(res, 401, 'missing token');
  try {
    res.locals.user = jwt.verify(token, JWT_SECRET) as AuthUser;
    next();
  } catch {
    fail(res, 401, 'invalid token');
  }
}

export const requireRole = (role: string) => (req: Request, res: Response, next: NextFunction) =>
  res.locals.user?.role === role ? next() : fail(res, 403, 'forbidden');
