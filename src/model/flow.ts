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

export const StepSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(['ui', 'api', 'subflow']),
    claim: z.string().min(1),
    request: z.object({ method: z.enum(HTTP_METHODS), path: z.string().startsWith('/') }).optional(),
    evidence: EvidenceListSchema,
    check: CheckSchema.nullable(),
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
      }
    });
  });

export type Flow = z.infer<typeof FlowSchema>;
