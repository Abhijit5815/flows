import { z } from 'zod';

export const registerSchema = z.object({ email: z.string().email(), password: z.string().min(8) });

export const loginSchema = registerSchema.pick({ email: true, password: true });

export const updateUserSchema = z.object({ email: z.string().email().optional() });

export const updateMeSchema = z.object({ name: z.string().min(1).optional(), email: z.string().email().optional() });
