import { z } from 'zod';
import { HTTP_METHODS } from '../src/model/flow.ts';

// A hand-written answer key for one sample app. Phase 2 compares parser output with it:
// pages by path, endpoints by method + path. file and line are there for review.
export const GroundTruthSchema = z.object({
  app: z.string().regex(/^[a-z0-9-]+$/), // also the folder name under fixtures/samples/
  source: z.object({
    repo: z.url(),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    license: z.string().min(1),
  }),
  // Repo-relative folder of each role, so Phase 2 knows what to parse.
  roles: z
    .object({ web: z.string().min(1).optional(), api: z.string().min(1).optional() })
    .refine((roles) => roles.web !== undefined || roles.api !== undefined, { message: 'at least one role' }),
  pages: z.array(z.object({ path: z.string().startsWith('/'), file: z.string().min(1) })),
  endpoints: z.array(
    z.object({
      method: z.enum([...HTTP_METHODS, 'ALL'] as const),
      path: z.string().startsWith('/'),
      file: z.string().min(1),
      line: z.int().min(1),
    }),
  ),
  // Judgement calls (what was left out and why), for the reviewer.
  notes: z.array(z.string().min(1)),
});

export type GroundTruth = z.infer<typeof GroundTruthSchema>;
