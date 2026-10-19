import type { EmbeddingProvider } from '../embeddings/provider.ts';
import { embedEach } from '../embeddings/vector-cache.ts';
import type { Graph } from '../graph/schema.ts';
import type { FileFacts, PatternRule } from './match.ts';

// PLAN.md Phase 2 safety net: code that looks like a handler or action but is not in the graph. The list is only
// shown to the user (`flows show missed`); nothing in it becomes a graph node or a flow.
export type Suspect = { file: string; line: number; reason: string; similarity?: number };

// Functions that stand on their own (declarations, methods, arrows held by a variable, field or property): the
// candidates for the embedding search. Arrows passed straight into a call (callbacks) are left out. Only node kinds
// that the TypeScript, TSX and JavaScript grammars all have.
export const FUNCTION_RULE: PatternRule = {
  id: 'function',
  rule: { any: [{ kind: 'function_declaration' }, { kind: 'method_definition' }, { kind: 'arrow_function', not: { inside: { kind: 'arguments', stopBy: 'neighbor' } } }] },
};

// Tests call routes and look like handlers; they are not part of the app.
const TEST_FILE = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

export type PossiblyMissedOptions = { minSimilarity: number; limit: number };

// Merges suspects found at the same place, keeping every reason.
function merge(suspects: Suspect[]): Suspect[] {
  const byPlace = new Map<string, Suspect>();
  for (const suspect of suspects) {
    const place = `${suspect.file}:${suspect.line}`;
    const seen = byPlace.get(place);
    if (seen === undefined) byPlace.set(place, { ...suspect });
    else {
      seen.reason = `${seen.reason}; ${suspect.reason}`;
      seen.similarity ??= suspect.similarity;
    }
  }
  return [...byPlace.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export async function possiblyMissed(
  graph: Graph,
  facts: ReadonlyMap<string, FileFacts>,
  sources: ReadonlyMap<string, string>,
  suspectRules: readonly PatternRule[],
  embedding: { provider: EmbeddingProvider; cacheFile: string; options: PossiblyMissedOptions } | undefined,
): Promise<Suspect[]> {
  const atNode = new Set(graph.nodes.map((node) => `${node.file}:${node.line}`));
  // A function inside a graph node's own function (the (req, res, next) a middleware factory returns) is part of it.
  const spans = new Map<string, [number, number][]>();
  for (const [file, { facts: list }] of facts) {
    for (const fact of list) if (fact.rule === FUNCTION_RULE.id && atNode.has(`${file}:${fact.line}`)) spans.set(file, [...(spans.get(file) ?? []), [fact.start, fact.end]]);
  }
  const isCovered = (file: string, line: number, start: number) =>
    atNode.has(`${file}:${line}`) || (spans.get(file) ?? []).some(([from, to]) => start > from && start < to);
  const notes = new Map(suspectRules.map((rule) => [rule.id, rule.note ?? rule.id]));
  const found: Suspect[] = [];
  const functions: { file: string; line: number; start: number; name: string | undefined; declaredWithParen: boolean; text: string }[] = [];
  for (const [file, { facts: list }] of facts) {
    if (TEST_FILE.test(file)) continue;
    for (const fact of list) {
      const reason = notes.get(fact.rule);
      // 1. Pattern search: a suspect rule matched where the graph has nothing.
      if (reason !== undefined && !isCovered(file, fact.line, fact.start)) found.push({ file, line: fact.line, reason });
      if (fact.rule !== FUNCTION_RULE.id) continue;
      const source = sources.get(file) ?? '';
      const text = source.slice(fact.start, fact.end);
      // An arrow's name sits just before it: "export const listForUser = (" or "stats = async (".
      const before = source.slice(source.lastIndexOf('\n', fact.start) + 1, fact.start);
      const held = /([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?$/.exec(before)?.[1];
      const declared = /^(?:(?:async|static|public|private|protected|get|set)\s+)*(?:function\s*\*?\s*)?([A-Za-z_$][\w$]*)\s*[(<]/.exec(text)?.[1];
      functions.push({ file, line: fact.line, start: fact.start, name: held ?? declared, declaredWithParen: held === undefined && declared !== undefined, text });
    }
  }
  // 2. Embedding search: functions most like the graph's own handlers and actions, among those not in the graph that
  // no project code calls. Handlers and actions are entry points the framework calls, so a function the code itself
  // calls (a service, a model, a helper) is supporting code, not a missed handler.
  // shortcut: calls are counted by name across the source text, so a missed handler that shares a name with something
  // called elsewhere is left out; resolve the calls with the resolver if that ever hides a real miss.
  const calls = new Map<string, number>();
  for (const source of sources.values()) for (const match of source.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) calls.set(match[1], (calls.get(match[1]) ?? 0) + 1);
  const examples = new Set(graph.nodes.filter((node) => node.kind === 'handler' || node.kind === 'action').map((node) => `${node.file}:${node.line}`));
  const known = functions.filter((fn) => examples.has(`${fn.file}:${fn.line}`));
  const candidates = functions.filter((fn) => {
    if (isCovered(fn.file, fn.line, fn.start)) return false;
    if (fn.name === undefined) return true;
    const ownDeclaration = fn.declaredWithParen ? 1 : 0; // "function exportCsv(" counts as a match of itself
    return (calls.get(fn.name) ?? 0) - ownDeclaration <= 0;
  });
  if (embedding !== undefined && known.length > 0 && candidates.length > 0) {
    // The first 1200 characters are plenty for the model (it truncates at 512 tokens anyway).
    const vectors = await embedEach(embedding.cacheFile, [...known, ...candidates].map((fn) => fn.text.slice(0, 1200)), embedding.provider);
    const knownVectors = vectors.slice(0, known.length);
    const kind = graph.role === 'api' ? 'route handlers' : 'actions';
    const scored = candidates
      .map((fn, i) => {
        const vector = vectors[known.length + i];
        // Vectors are unit length, so the dot product is the cosine similarity.
        const similarity = Math.max(...knownVectors.map((other) => other.reduce((sum, value, d) => sum + value * vector[d], 0)));
        return { ...fn, similarity };
      })
      .filter((fn) => fn.similarity >= embedding.options.minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, embedding.options.limit);
    for (const { file, line, similarity } of scored) found.push({ file, line, similarity, reason: `reads like the ${kind} in the graph (similarity ${similarity.toFixed(2)})` });
  }
  return merge(found);
}
