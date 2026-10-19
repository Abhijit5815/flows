import { z } from 'zod';

// node_id is what the verifier checks against the graph; ref ("path:line") is for people.
const CodeEvidenceSchema = z.object({
  type: z.literal('code'),
  node_id: z.string().min(1),
  ref: z.string().regex(/^.+:[1-9]\d*$/, 'ref must look like "path/to/file.ts:42"'),
});

// Only observed flows (Phase 3) carry these.
const ObservedEvidenceSchema = z.object({
  type: z.enum(['network', 'dom', 'screenshot']),
  ref: z.string().min(1),
});

export const EvidenceSchema = z.discriminatedUnion('type', [CodeEvidenceSchema, ObservedEvidenceSchema]);

export type Evidence = z.infer<typeof EvidenceSchema>;
