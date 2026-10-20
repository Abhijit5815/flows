import { z } from 'zod';
import { OutputValidationError, PendingAnswer } from '../shared/errors.ts';
import { sha256 } from '../shared/hash.ts';
import { readCache, writeJsonAtomic } from '../shared/json-file.ts';
import type { TraceSink } from '../trace/sink.ts';
import { completeTraced, type LlmGateway, type LlmRequest } from './gateway.ts';

const JobSchema = z.object({
  purpose: z.string(),
  system: z.string(),
  prompt: z.string(),
  schema: z.unknown(), // the JSON Schema the answer must meet
  asked: z.iso.datetime(),
  answer: z.string().optional(),
  error: z.string().optional(), // why the last answer was refused
});
const JobsSchema = z.record(z.string(), JobSchema);

export type Job = z.infer<typeof JobSchema>;

export const loadJobs = (file: string): Record<string, Job> => readCache(file, JobsSchema) ?? {};

// The job's own schema, when it converts; otherwise the scan's check is the only one.
function answerProblem(job: Job, answer: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(answer);
  } catch {
    return 'the answer is not JSON';
  }
  let schema: z.ZodType;
  try {
    schema = z.fromJSONSchema(job.schema as Parameters<typeof z.fromJSONSchema>[0]);
  } catch {
    return undefined;
  }
  const checked = schema.safeParse(value);
  return checked.success ? undefined : z.prettifyError(checked.error).replace(/\n/g, ' ');
}

// `flows answer`: keeps an answer that meets the job's schema; the next scan checks it again and uses it.
export function answerJob(file: string, id: string, answer: string): void {
  const jobs = loadJobs(file);
  const job = jobs[id];
  if (job === undefined) throw new OutputValidationError(`no job ${id}; see "flows jobs"`);
  const problem = answerProblem(job, answer);
  if (problem !== undefined) throw new OutputValidationError(`job ${id}: ${problem}`);
  writeJsonAtomic(file, { ...jobs, [id]: { ...job, answer, error: undefined } });
}

const jobId = (request: LlmRequest<unknown>) => sha256(JSON.stringify([request.purpose, request.system, request.prompt])).slice(0, 12);

// PLAN.md Phase 5 delivery: inside a coding assistant, the assistant does the AI jobs on the user's own plan. Flows
// never calls out: a request without an answer is saved as a job, and an answer goes through the same schema check
// and trace as any model's reply. An answer the check refuses is dropped, and the job waits again with the reason.
export class AssistantGateway implements LlmGateway {
  readonly model = 'assistant';
  readonly #file: string;
  readonly #trace: TraceSink;

  constructor(jobsFile: string, trace: TraceSink) {
    this.#file = jobsFile;
    this.#trace = trace;
  }

  refuse(request: LlmRequest<unknown>, why: string): void {
    const id = jobId(request);
    const jobs = loadJobs(this.#file);
    if (jobs[id] !== undefined) writeJsonAtomic(this.#file, { ...jobs, [id]: { ...jobs[id], answer: undefined, error: why } });
  }

  async completeJson<T>(request: LlmRequest<T>): Promise<T> {
    const id = jobId(request);
    const jobs = loadJobs(this.#file);
    const job = jobs[id];
    if (job?.answer === undefined) {
      const asked: Job = { purpose: request.purpose, system: request.system, prompt: request.prompt, schema: z.toJSONSchema(request.schema), asked: new Date().toISOString(), ...(job?.error === undefined ? {} : { error: job.error }) };
      writeJsonAtomic(this.#file, { ...jobs, [id]: asked });
      throw new PendingAnswer(`job ${id} (${request.purpose}) waits for the assistant`);
    }
    try {
      return await completeTraced(this.#trace, { provider: 'assistant', model: this.model }, request, async () => ({ text: job.answer as string, tokens: null }));
    } catch (error) {
      if (error instanceof OutputValidationError) writeJsonAtomic(this.#file, { ...jobs, [id]: { ...job, answer: undefined, error: error.message } });
      throw error;
    }
  }
}
