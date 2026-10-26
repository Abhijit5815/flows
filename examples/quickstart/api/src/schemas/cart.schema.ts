import { z } from 'zod';

export const addItemSchema = z.object({ productId: z.number().int(), quantity: z.number().int().positive().default(1) });
