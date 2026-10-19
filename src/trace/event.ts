import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const Common = { id: z.uuid(), at: z.iso.datetime(), duration_ms: z.number().nonnegative() };

// PLAN.md §4 TraceEvent: decision_type, inputs_ref, probs, threshold, model_version, llm_call, tokens.
// Decisions also keep their input text so they can be replayed.
export const TraceEventSchema = z.discriminatedUnion('kind', [
  z.object({
    ...Common,
    kind: z.literal('decision'),
    decision_type: z.string().min(1),
    input: z.string(),
    inputs_ref: z.string().regex(/^[0-9a-f]{64}$/), // sha256 of the input
    allowed_labels: z.array(z.string()),
    label: z.string().min(1),
    source: z.enum(['rule', 'classifier']),
    probs: z.record(z.string(), z.number().min(0).max(1)),
    threshold: z.object({ min_prob: z.number(), min_margin: z.number() }),
    model_version: z.string().min(1),
  }),
  z.object({
    ...Common,
    kind: z.literal('llm_call'),
    purpose: z.string().min(1),
    model_version: z.string().min(1),
    llm_call: z.object({
      provider: z.string().min(1),
      model: z.string().min(1),
      system: z.string(),
      prompt: z.string(),
      output: z.string().nullable(),
      ok: z.boolean(),
      error: z.string().optional(),
    }),
    tokens: z.object({ input: z.int().nonnegative(), output: z.int().nonnegative() }).nullable(),
  }),
]);

export type TraceEvent = z.infer<typeof TraceEventSchema>;

// Fields every event shares; call it when the traced work has finished.
export const eventBase = (startedAt: number) => ({
  id: randomUUID(),
  at: new Date().toISOString(),
  duration_ms: performance.now() - startedAt,
});
