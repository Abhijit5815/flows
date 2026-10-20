import { z } from 'zod';
import { UNKNOWN, type Decider } from '../decider/decider.ts';
import { FALLBACK_CATEGORY_ID, type Category } from '../model/category.ts';
import type { Flow } from '../model/flow.ts';
import type { OptionalLlm } from './llm.ts';

// What the review page shows under "why this flow": the label, the Decider's probabilities, and who decided.
export type DecisionView = { label: string; probs: Record<string, number>; by: 'decider' | 'llm' | 'fallback' };
export type Classified = Pick<Flow, 'category' | 'destructive'> & { decisions: { destructive: DecisionView; category: DecisionView } };

export type ClassifyDeps = {
  decider: Decider;
  llm: OptionalLlm;
  categories: readonly Category[]; // the project's
  categoryLabels: readonly string[]; // those the flow-category task has examples for
};

// PLAN.md Phase 4 decision order on a flow's one-line text: plain rules, then the embedding Decider (both inside
// decide()). An unknown category goes to the LLM, which may only pick a project category; else "uncategorized".
// An unknown destructive answer stays unknown: that already holds the flow for review, and an LLM "safe" must not
// release it.
export async function classify(text: string, deps: ClassifyDeps): Promise<Classified> {
  const risk = await deps.decider.decide('destructive-risk', text, ['destructive', 'safe']);
  const destructive = risk.label === 'destructive' ? 'yes' : risk.label === 'safe' ? 'no' : 'unknown';
  const allowed = deps.categories.filter((category) => category.id !== FALLBACK_CATEGORY_ID).map((category) => category.id);
  const known = allowed.filter((id) => deps.categoryLabels.includes(id));
  const decision = known.length >= 2 ? await deps.decider.decide('flow-category', text, known) : undefined;
  const decided = decision?.label ?? UNKNOWN;
  const result = (category: string, by: DecisionView['by']): Classified => ({
    category,
    destructive,
    decisions: { destructive: { label: risk.label, probs: risk.all_probs, by: 'decider' }, category: { label: category, probs: decision?.all_probs ?? {}, by } },
  });
  if (decided !== UNKNOWN) return result(decided, 'decider');
  if (allowed.length === 0) return result(FALLBACK_CATEGORY_ID, 'fallback');
  const ids = allowed as [string, ...string[]]; // safe: checked non-empty above
  const reply = await deps.llm.ask({
    purpose: 'flow-category',
    system:
      'You sort the user flows of a web application into categories. Reply with JSON only: {"category": "<id>"}. ' +
      `The categories are: ${deps.categories.filter((category) => ids.includes(category.id)).map((category) => `${category.id} (${category.name})`).join(', ')}.`,
    prompt: `Which category does this flow belong to?\n${text}`,
    schema: z.object({ category: z.enum(ids) }),
  });
  return reply === undefined ? result(FALLBACK_CATEGORY_ID, 'fallback') : result(reply.category, 'llm');
}
