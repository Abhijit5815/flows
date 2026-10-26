import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { FlowSchema, StepSchema, type Flow } from '../model/flow.ts';
import { ConfigError } from '../shared/errors.ts';
import { appendJsonLine, readJsonLines } from '../shared/json-file.ts';
import { parseOrThrow } from '../shared/validate.ts';

// PLAN.md Phase 5: what a person changed or added on the review page, kept in the repo itself
// (<repo>/.flows/flows.jsonl) so it is reviewed and versioned with the code; git history is its version history.
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

export const editsFile = (repoDir: string): string => join(repoDir, '.flows', 'flows.jsonl');
const legacyEditsFile = (repoDir: string): string => join(repoDir, '.flows', 'flows.json');

// One line per change: a person's patch to a flow, or a flow a person added or replaced whole. Folded oldest first, so
// when two people change one flow, a field only one of them set is kept and the later one wins a field both set.
const OverrideLineSchema = z.object({ type: z.literal('override'), id: z.string().min(1), patch: OverrideSchema.omit({ version: true, edited: true }), version: z.int().min(2), edited: z.iso.datetime() });
const LineSchema = z.discriminatedUnion('type', [OverrideLineSchema, z.object({ type: z.literal('added'), flow: FlowSchema, edited: z.iso.datetime() })]);

// A broken file stops the scan with a message rather than being skipped: it is the person's own work.
export function loadEdits(repoDir: string): Edits {
  const edits = legacyEdits(repoDir);
  const lines = readJsonLines(editsFile(repoDir), LineSchema).sort((a, b) => (a.edited < b.edited ? -1 : a.edited > b.edited ? 1 : 0));
  for (const line of lines) {
    if (line.type === 'added') edits.added = [...edits.added.filter((own) => own.id !== line.flow.id), line.flow];
    else {
      const previous = edits.overrides[line.id];
      edits.overrides[line.id] = { ...previous, ...line.patch, version: Math.max(previous?.version ?? 1, line.version), edited: line.edited };
    }
  }
  return edits;
}

// What the older flows.json holds, read under the lines; new changes only go to flows.jsonl.
function legacyEdits(repoDir: string): Edits {
  const file = legacyEditsFile(repoDir);
  if (!existsSync(file)) return { schema_version: 0, overrides: {}, added: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ConfigError(`${file} is not valid JSON`, { cause: error });
  }
  return parseOrThrow(EditsSchema, raw, file, ConfigError);
}

const now = () => new Date().toISOString();

// The fields in `patch` replace what a person set before; every edit raises the flow's version past what it has now.
export function saveOverride(repoDir: string, id: string, patch: OverridePatch, version: number): Override {
  const previous = loadEdits(repoDir).overrides[id];
  const line = OverrideLineSchema.parse({ type: 'override', id, patch, version: Math.max(previous?.version ?? 1, version) + 1, edited: now() });
  appendJsonLine(editsFile(repoDir), line);
  return OverrideSchema.parse({ ...previous, ...patch, version: line.version, edited: line.edited });
}

// A flow a person made (promoted, drawn, described, extracted), added or replaced whole; replacing raises its version.
export function saveAdded(repoDir: string, flow: Flow): Flow {
  const previous = loadEdits(repoDir).added.find((own) => own.id === flow.id);
  const saved = FlowSchema.parse({ ...flow, version: previous === undefined ? flow.version : Math.max(previous.version, flow.version) + 1 });
  appendJsonLine(editsFile(repoDir), { type: 'added', flow: saved, edited: now() });
  return saved;
}
