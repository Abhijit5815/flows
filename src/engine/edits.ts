import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { FlowSchema, StepSchema, type Flow } from '../model/flow.ts';
import { ConfigError } from '../shared/errors.ts';
import { writeJsonAtomic } from '../shared/json-file.ts';
import { parseOrThrow } from '../shared/validate.ts';

// PLAN.md Phase 5: what a person changed or added on the review page, kept in the repo itself
// (<repo>/.flows/flows.json) so it is reviewed and versioned with the code; git history is its version history.
// The engine lays it over each scan's generated flows, and a field a person set is never overwritten by regeneration.
export const OverrideSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  priority: z.enum(['high', 'medium', 'low']).optional(),
  tags: z.array(z.string().min(1)).optional(),
  steps: z.array(StepSchema).min(1).optional(), // a person rewrote the steps; regeneration leaves them alone
  disabled_steps: z.array(z.string().min(1)).optional(),
  version: z.int().min(2),
  edited: z.iso.datetime(),
});

export type Override = z.infer<typeof OverrideSchema>;
export type OverridePatch = Omit<Override, 'version' | 'edited'>;

const EditsSchema = z.object({ schema_version: z.literal(0), overrides: z.record(z.string(), OverrideSchema), added: z.array(FlowSchema) });

export type Edits = z.infer<typeof EditsSchema>;

export const editsFile = (repoDir: string): string => join(repoDir, '.flows', 'flows.json');

// A broken file stops the scan with a message rather than being skipped: it is the person's own work.
export function loadEdits(repoDir: string): Edits {
  const file = editsFile(repoDir);
  if (!existsSync(file)) return { schema_version: 0, overrides: {}, added: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ConfigError(`${file} is not valid JSON`, { cause: error });
  }
  return parseOrThrow(EditsSchema, raw, file, ConfigError);
}

const write = (repoDir: string, edits: Edits): void => writeJsonAtomic(editsFile(repoDir), EditsSchema.parse(edits), 2);
const now = () => new Date().toISOString();

// The fields in `patch` replace what a person set before; every edit raises the flow's version past what it has now.
export function saveOverride(repoDir: string, id: string, patch: OverridePatch, version: number): Override {
  const edits = loadEdits(repoDir);
  const override = OverrideSchema.parse({ ...edits.overrides[id], ...patch, version: Math.max(edits.overrides[id]?.version ?? 1, version) + 1, edited: now() });
  write(repoDir, { ...edits, overrides: { ...edits.overrides, [id]: override } });
  return override;
}

// A flow a person made (promoted, drawn, described, extracted), added or replaced whole; replacing raises its version.
export function saveAdded(repoDir: string, flow: Flow): Flow {
  const edits = loadEdits(repoDir);
  const previous = edits.added.find((own) => own.id === flow.id);
  const saved = FlowSchema.parse({ ...flow, version: previous === undefined ? flow.version : Math.max(previous.version, flow.version) + 1 });
  write(repoDir, { ...edits, added: [...edits.added.filter((own) => own.id !== flow.id), saved] });
  return saved;
}
