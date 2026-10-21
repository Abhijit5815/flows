import { z } from 'zod';

// The parser answer keys' schema lives with the code that reads it (src/ingest/keys.ts), so the package ships it.
export { GroundTruthSchema, type GroundTruth } from '../src/ingest/keys.ts';

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
