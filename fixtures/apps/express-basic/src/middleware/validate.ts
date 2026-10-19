import type { NextFunction, Request, Response } from 'express';
import type { ZodSchema } from 'zod';
import { fail } from '@/lib/envelope';

// Checks the JSON body against a Zod schema before the handler runs.
export const validate = (schema: ZodSchema) => (req: Request, res: Response, next: NextFunction) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.message);
  req.body = parsed.data;
  next();
};
