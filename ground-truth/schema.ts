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

// A hand-written answer key of the flows a person sees on a running sample app (PLAN.md Phase 3 exit), written from a
// walk of the app in a browser, not from its source or from Flows. The explorer's recall is measured against it.
export const LiveKeySchema = z.object({
  app: z.string().regex(/^[a-z0-9-]+$/),
  url: z.url(),
  signed_in: z.boolean(), // the walk's default; a flow seen only signed out says so itself
  written: z.string().min(1),
  flows: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9-]+$/),
        kind: z.enum(['ui', 'api']),
        page: z.string().startsWith('/').optional(),
        action: z.enum(['open', 'click', 'submit']).optional(),
        element: z.string().min(1).optional(), // the visible text, or a form's input names
        request: z.string().regex(/^[A-Z]+ \//).optional(), // "METHOD /path" the browser sent for it
        signed_in: z.boolean().optional(),
      }),
    )
    .min(1),
});
