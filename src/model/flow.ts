import { z } from 'zod';
import { EvidenceSchema, type Evidence } from './evidence.ts';

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

// Every claim needs evidence, so an empty list is invalid.
const EvidenceListSchema = z.array(EvidenceSchema).min(1);

const UiCheckSchema = z
  .object({
    kind: z.literal('ui'),
    page: z.string().min(1).optional(),
    element: z.string().min(1).optional(),
    evidence: EvidenceListSchema,
  })
  .refine((check) => check.page !== undefined || check.element !== undefined, {
    message: 'a ui check needs a page or an element',
  });

const ApiCheckSchema = z
  .object({
    kind: z.literal('api'),
    status: z.int().min(100).max(599).optional(),
    fields: z.array(z.string().min(1)).min(1).optional(),
    evidence: EvidenceListSchema,
  })
  .refine((check) => check.status !== undefined || check.fields !== undefined, {
    message: 'an api check needs a status or fields',
  });

// The expected result of a step, taken from source; a step's check is null when source is silent.
const CheckSchema = z.discriminatedUnion('kind', [UiCheckSchema, ApiCheckSchema]);

// One field of a request body, from its schema: type is the schema's base type ("string"), rules the rest of its
// chain as written ("email", "min(8)"), so negative and edge cases can be read off it.
export const FieldSchema = z.object({ name: z.string().min(1), type: z.string().min(1), required: z.boolean(), rules: z.array(z.string().min(1)) });

// What else a step can end in, from source: an error response (by the guard, middleware or handler that sends it)
// or a message a form action returns. These are the negative cases.
const ErrorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('api'), status: z.int().min(400).max(599), by: z.string().min(1), message: z.string().min(1).optional(), evidence: EvidenceListSchema }),
  z.object({ kind: z.literal('ui'), message: z.string().min(1), evidence: EvidenceListSchema }),
]);

export const StepSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(['ui', 'api', 'subflow']),
    claim: z.string().min(1),
    request: z
      .object({
        method: z.enum(HTTP_METHODS),
        path: z.string().startsWith('/'),
        body: z.object({ schema: z.string().min(1), fields: z.array(FieldSchema).min(1), evidence: EvidenceListSchema }).optional(),
      })
      .optional(),
    evidence: EvidenceListSchema,
    check: CheckSchema.nullable(),
    errors: z.array(ErrorSchema).min(1).optional(),
    enabled: z.boolean(),
    subflow_ref: z.string().min(1).optional(),
  })
  .superRefine((step, ctx) => {
    if ((step.kind === 'api') !== (step.request !== undefined)) {
      ctx.addIssue({ code: 'custom', path: ['request'], message: 'api steps need a request; other steps must not have one' });
    }
    if ((step.kind === 'subflow') !== (step.subflow_ref !== undefined)) {
      ctx.addIssue({ code: 'custom', path: ['subflow_ref'], message: 'subflow steps need subflow_ref; other steps must not have one' });
    }
    if (step.check !== null && step.check.kind !== step.kind) {
      ctx.addIssue({ code: 'custom', path: ['check', 'kind'], message: 'a check has the same kind as its step; subflow steps have no check' });
    }
    if (step.errors?.some((error) => error.kind !== step.kind)) {
      ctx.addIssue({ code: 'custom', path: ['errors'], message: 'errors have the same kind as their step; subflow steps have none' });
    }
  });

const FLOW_STATUSES = ['confirmed', 'verified', 'observed-only', 'unreachable', 'unverified', 'rejected'] as const;
const FLOW_ORIGINS = ['source', 'observed', 'both'] as const;

// From the status definitions in PLAN.md §4.
const REQUIRED_ORIGIN: Partial<Record<(typeof FLOW_STATUSES)[number], (typeof FLOW_ORIGINS)[number]>> = {
  confirmed: 'both',
  verified: 'source',
  'observed-only': 'observed',
};

const isObserved = (evidence: Evidence) => evidence.type !== 'code';

export const FlowSchema = z
  .object({
    schema_version: z.literal(0),
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1).optional(),
    category: z.string().min(1),
    kind: z.enum(['ui', 'api']),
    origin: z.enum(FLOW_ORIGINS),
    status: z.enum(FLOW_STATUSES),
    confidence: z.number().min(0).max(1),
    enabled: z.boolean(),
    destructive: z.enum(['yes', 'no', 'unknown']),
    priority: z.enum(['high', 'medium', 'low']),
    tags: z.array(z.string().min(1)),
    version: z.int().min(1),
    steps: z.array(StepSchema).min(1),
  })
  .superRefine((flow, ctx) => {
    const issue = (path: PropertyKey[], message: string) => ctx.addIssue({ code: 'custom', path, message });

    const requiredOrigin = REQUIRED_ORIGIN[flow.status];
    if (requiredOrigin !== undefined && flow.origin !== requiredOrigin) {
      issue(['origin'], `status "${flow.status}" needs origin "${requiredOrigin}"`);
    }

    const seenIds = new Set<string>();
    flow.steps.forEach((step, i) => {
      if (seenIds.has(step.id)) issue(['steps', i, 'id'], `duplicate step id "${step.id}"`);
      seenIds.add(step.id);
      if (flow.kind === 'api' && step.kind === 'ui') issue(['steps', i, 'kind'], 'api flows have no ui steps');
      if (step.subflow_ref === flow.id) issue(['steps', i, 'subflow_ref'], 'a flow cannot use itself as a subflow');
      if (flow.origin === 'source') {
        if (step.evidence.some(isObserved)) issue(['steps', i, 'evidence'], 'source flows cite code evidence only');
        if (step.check?.evidence.some(isObserved)) issue(['steps', i, 'check', 'evidence'], 'source flows cite code evidence only');
        if (step.errors?.some((error) => error.evidence.some(isObserved)) || step.request?.body?.evidence.some(isObserved)) {
          issue(['steps', i, 'errors'], 'source flows cite code evidence only');
        }
      }
    });
  });

export type Flow = z.infer<typeof FlowSchema>;
export type Field = z.infer<typeof FieldSchema>;
