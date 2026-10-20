import { z } from 'zod';
import type { Decider } from '../decider/decider.ts';
import { GROUNDING, GROUNDING_LABELS, groundingInput } from '../decider/entailment.ts';
import type { Flow } from '../model/flow.ts';
import type { OptionalLlm } from './llm.ts';

const NameSchema = z.object({ name: z.string().min(3).max(80), description: z.string().min(10).max(240) });

const SYSTEM =
  'You name the user flows of a web application for testers. You get the steps of one flow, as found in its source ' +
  'code. Reply with JSON only: {"name": "...", "description": "..."}. The name is a short imperative phrase of at ' +
  'most eight words, like "Log in with email and password". The description is one sentence. Say only what the ' +
  'steps say: no pages, data or outcomes they do not mention.';

// PLAN.md Phase 4 (4): the LLM proposes a name and a description from the flow's proven steps, and each is kept only
// when the grounding Decider says those steps support it, so the LLM never adds a fact.
export async function proposeName(flow: Flow, llm: OptionalLlm, grounding: Decider): Promise<{ name?: string; description?: string; reasons: string[] }> {
  const facts = flow.steps.map((step) => `${step.claim}.`).join(' ');
  const reply = await llm.ask({ purpose: 'flow-name', system: SYSTEM, prompt: facts, schema: NameSchema });
  if (reply === undefined) return { reasons: [] };
  const kept: { name?: string; description?: string; reasons: string[] } = { reasons: [] };
  for (const field of ['name', 'description'] as const) {
    const decision = await grounding.decide(GROUNDING, groundingInput(facts, reply[field]), GROUNDING_LABELS);
    if (decision.label === 'supported') kept[field] = reply[field];
    else kept.reasons.push(`the LLM's ${field} "${reply[field]}" is not supported by the steps (p=${(decision.all_probs.supported ?? 0).toFixed(2)}); not used`);
  }
  return kept;
}
