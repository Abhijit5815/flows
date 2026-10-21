import { candidates } from '../engine/candidates.ts';
import { deciderText, shape } from '../engine/describe.ts';
import type { Graph } from '../graph/schema.ts';
import { actionFor, formFor, indexOf } from './match.ts';

// What the explorer's gate rates for a live control that matches source: the matched source flows' own one-line texts,
// the ones the engine classifies (with the call each one makes), so the gate and the review page agree. A link is rated
// by the view of the page it opens. Controls source doesn't have keep their live text (actions.ts).
export type SourceTexts = {
  link(pattern: string): string[];
  form(pattern: string, fields: readonly string[], text: string): string[];
  click(pattern: string, text: string): string[];
};

export function sourceTexts(graphs: readonly Graph[]): SourceTexts {
  const parts = graphs
    .filter((graph) => graph.role === 'web')
    .map((graph) => {
      const index = indexOf(graph);
      const found = candidates(graph);
      // By the node a flow is about: its page for a view, the form or action it acts with otherwise. A click source
      // skipped (no API call) still has a flow, and a text.
      const byNode = new Map<string, string[]>();
      for (const flow of [...found.flows, ...found.skipped.flatMap((skip) => skip.flow ?? [])]) {
        const { entry, act } = shape(flow, index.nodes);
        const key = act.length > 0 ? act[0].id : entry?.id;
        if (key !== undefined) byNode.set(key, [...(byNode.get(key) ?? []), deciderText(flow, index.nodes)]);
      }
      return { index, byNode };
    });
  const texts = (pick: (part: (typeof parts)[number]) => string | undefined) => [...new Set(parts.flatMap((part) => part.byNode.get(pick(part) ?? '') ?? []))];
  return {
    link: (pattern) => texts(({ index }) => index.pageNode(pattern)?.id),
    form: (pattern, fields, text) => texts(({ index }) => formFor(index, pattern, fields, text)?.id),
    click: (pattern, text) => texts(({ index }) => actionFor(index, pattern, { text, calls: [] })?.id),
  };
}
