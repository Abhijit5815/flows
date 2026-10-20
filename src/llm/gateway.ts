import type { z } from 'zod';
import { OutputValidationError } from '../shared/errors.ts';
import { parseOrThrow } from '../shared/validate.ts';
import { eventBase } from '../trace/event.ts';
import type { TraceSink } from '../trace/sink.ts';

export type LlmRequest<T> = { purpose: string; system: string; prompt: string; schema: z.ZodType<T> };

export interface LlmGateway {
  readonly model: string;
  // The answer must be JSON that validates against `schema`; anything else is an OutputValidationError.
  completeJson<T>(request: LlmRequest<T>): Promise<T>;
  // A schema-valid answer that a later check refused; a gateway that can be asked again (the assistant) reopens it.
  refuse?(request: LlmRequest<unknown>, why: string): void;
}

export type RawReply = { text: string; tokens: { input: number; output: number } | null };

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new OutputValidationError(`reply is not JSON: ${text.slice(0, 200)}`, { cause: error });
  }
}

// Shared by every implementation: send once, validate the JSON against the schema,
// and write exactly one trace event whether the call worked or not.
export async function completeTraced<T>(
  trace: TraceSink,
  meta: { provider: string; model: string },
  request: LlmRequest<T>,
  send: () => Promise<RawReply>,
): Promise<T> {
  const startedAt = performance.now();
  let reply: RawReply | undefined;
  const record = (ok: boolean, error?: string) =>
    trace.record({
      ...eventBase(startedAt),
      kind: 'llm_call',
      purpose: request.purpose,
      model_version: `${meta.provider}:${meta.model}`,
      llm_call: { ...meta, system: request.system, prompt: request.prompt, output: reply?.text ?? null, ok, error },
      tokens: reply?.tokens ?? null,
    });
  try {
    reply = await send();
    const value = parseOrThrow(request.schema, parseJson(reply.text), `${meta.model} reply for "${request.purpose}"`, OutputValidationError);
    record(true);
    return value;
  } catch (error) {
    record(false, error instanceof Error ? error.message : String(error));
    throw error;
  }
}
