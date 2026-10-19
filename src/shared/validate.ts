import { z } from 'zod';
import type { FlowsError } from './errors.ts';

// The one place outside data meets a schema: typed data back, or the caller's error type with a readable message.
export function parseOrThrow<T>(
  schema: z.ZodType<T>,
  data: unknown,
  what: string,
  ErrorType: new (message: string) => FlowsError,
): T {
  const result = schema.safeParse(data);
  if (!result.success) throw new ErrorType(`${what} is invalid:\n${z.prettifyError(result.error)}`);
  return result.data;
}
