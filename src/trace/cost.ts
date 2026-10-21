import type { LlmConfig } from '../config/project.ts';
import type { TraceEvent } from './event.ts';

export type Price = { input: number; output: number }; // per million tokens

export type ModelUse = { model: string; calls: number; input: number; output: number; uncounted: number; cost: number | null };
export type RunCost = { run: string; calls: number; models: ModelUse[]; cost: number | null };

// PLAN.md Phase 7 token and cost report: LLM calls per run and model, from the trace. A cost only for a model the
// user priced (price(model)), and none when any call of it had no token count; a model that costs nothing (local,
// or the coding assistant) prices at 0.
export function costs(events: readonly TraceEvent[], price: (model: string) => Price | undefined): RunCost[] {
  const runs = new Map<string, Map<string, ModelUse>>();
  for (const event of events) {
    if (event.kind !== 'llm_call') continue;
    const run = event.run ?? 'before runs were recorded';
    const models = runs.get(run) ?? new Map<string, ModelUse>();
    runs.set(run, models);
    const model = `${event.llm_call.provider}/${event.llm_call.model}`;
    const use = models.get(model) ?? { model, calls: 0, input: 0, output: 0, uncounted: 0, cost: 0 };
    models.set(model, use);
    use.calls++;
    if (event.tokens === null) use.uncounted++;
    else {
      use.input += event.tokens.input;
      use.output += event.tokens.output;
    }
  }
  return [...runs].map(([run, models]) => {
    const uses = [...models.values()].map((use) => {
      const rate = price(use.model);
      return { ...use, cost: rate === undefined || (use.uncounted > 0 && (rate.input > 0 || rate.output > 0)) ? null : (use.input * rate.input + use.output * rate.output) / 1e6 };
    });
    const cost = uses.some((use) => use.cost === null) ? null : uses.reduce((sum, use) => sum + (use.cost ?? 0), 0);
    return { run, calls: uses.reduce((sum, use) => sum + use.calls, 0), models: uses, cost };
  });
}

const FREE: Price = { input: 0, output: 0 };
const LOOPBACK = /^(localhost|127(\.\d+){3}|\[::1\])$/;

// The price of a traced model ("provider/model"): what the config says for its LLM, nothing for the coding assistant
// or a model served on this machine, and unknown for anything else (a model the config no longer names).
export const priceOf =
  (config: LlmConfig) =>
  (model: string): Price | undefined => {
    if (model.startsWith('assistant/')) return FREE;
    if (config.provider === 'assistant' || model !== `${config.provider}/${config.model}`) return undefined;
    if (config.price_per_mtok !== undefined) return config.price_per_mtok;
    return config.provider === 'openai-compatible' && LOOPBACK.test(new URL(config.base_url).hostname) ? FREE : undefined;
  };
