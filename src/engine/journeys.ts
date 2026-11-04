import type { Lookup } from '../graph/lookup.ts';
import type { Graph, GraphNode } from '../graph/schema.ts';
import type { Flow } from '../model/flow.ts';
import { draft, openStep, template, uiStep, type DraftStep } from './candidates.ts';
import { JOURNEY } from '../model/tags.ts';
import { evidenceOf, label } from './describe.ts';

// A journey is what a person does across pages: open a page, follow a link or submit a form, land on the next page,
// and carry on. Flows reads each hop from source (a <Link href>, or a form whose action redirects), so a journey is a
// path through the app's own pages, never invented. One flow per path, tagged "journey".
const MAX_HOPS = 4; // a longer path is several journeys that meet
const BRANCH = 3; // hops followed from one page
const LIMIT = 40;
const GLOBAL_SHARE = 0.4; // a link on this share of the pages is the site's menu or footer, not a step of a journey

type Hop = { to: GraphNode; cited: GraphNode[]; form: boolean };
type Path = { start: GraphNode; hops: Hop[] };

const titleOf = (page: GraphNode): string => (page.kind === 'page' && page.attrs.headings?.[0]) || label(page);

function linkStep(link: GraphNode, page: GraphNode): DraftStep {
  const text = link.kind === 'link' ? link.attrs.text : undefined;
  return {
    kind: 'ui',
    claim: template('ui', [link, page]),
    evidence: [link, page].map(evidenceOf),
    check: { kind: 'ui', page: label(page), ...(page.kind === 'page' && page.attrs.headings !== undefined ? { text: page.attrs.headings } : {}), evidence: [evidenceOf(page)] },
    ...(text === undefined ? {} : { action: { kind: 'click' as const, fields: [], button: { text, selector: `role=link[name="${text.replace(/"/g, '\\"')}"]` } } }),
    enabled: true,
  };
}

export function journeys(graph: Graph, nodes: Lookup): Flow[] {
  if (graph.role !== 'web') return [];
  const pages = graph.nodes.filter((node) => node.kind === 'page');
  const pageAt = (path: string) => pages.find((page) => page.kind === 'page' && page.attrs.path === path);

  // What a page shows: its own links and forms and those of the components it renders (never another page's).
  const shown = (page: GraphNode): GraphNode[] => {
    const seen = new Set<string>();
    for (const queue = [page.id]; queue.length > 0; ) {
      const id = queue.shift() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      queue.push(...nodes.out(id, 'renders').map((own) => own.id), ...nodes.out(id, 'contains').map((own) => own.id));
    }
    return [...seen].flatMap((id) => nodes.node(id) ?? []);
  };
  const shownBy = new Map(pages.map((page) => [page.id, shown(page)]));
  const linkKey = (link: GraphNode) => (link.kind === 'link' ? `${link.attrs.href}|${link.attrs.text ?? ''}` : '');
  const reach = new Map<string, number>();
  for (const items of shownBy.values()) for (const key of new Set(items.filter((own) => own.kind === 'link').map(linkKey))) reach.set(key, (reach.get(key) ?? 0) + 1);
  const global = (link: GraphNode) => (reach.get(linkKey(link)) ?? 0) >= Math.max(4, pages.length * GLOBAL_SHARE);

  // The hops out of each page: a form that redirects (first, it does something) and then the page's own links.
  const hopsFrom = new Map<string, Hop[]>();
  for (const page of pages) {
    const hops: Hop[] = [];
    const add = (hop: Hop) => {
      if (hop.to.id !== page.id && !hops.some((own) => own.to.id === hop.to.id)) hops.push(hop);
    };
    for (const own of shownBy.get(page.id) ?? []) {
      if (own.kind !== 'form') continue;
      for (const action of nodes.out(own.id, 'submits')) {
        const redirects = action.kind === 'action' ? (action.attrs.redirects ?? []) : [];
        const to = redirects.length === 1 ? pageAt(redirects[0]) : undefined;
        if (to !== undefined) add({ to, cited: [own, action], form: true });
      }
    }
    for (const own of shownBy.get(page.id) ?? []) {
      const to = own.kind === 'link' && !global(own) ? nodes.out(own.id, 'navigates')[0] : undefined;
      if (to !== undefined) add({ to, cited: [own, to], form: false });
    }
    hopsFrom.set(page.id, hops);
  }

  // Start where a person enters: pages nothing links to, and the home and sign-in pages.
  const linkedTo = new Set([...hopsFrom.values()].flatMap((hops) => hops.map((hop) => hop.to.id)));
  const entry = pages.filter((page) => !linkedTo.has(page.id) || (page.kind === 'page' && ['/', '/auth', '/auth/signup'].includes(page.attrs.path)));
  const found: Path[] = [];
  const walk = (path: Path, seen: Set<string>) => {
    const last = path.hops.at(-1)?.to ?? path.start;
    const next = (hopsFrom.get(last.id) ?? []).filter((hop) => !seen.has(hop.to.id)).slice(0, BRANCH);
    if (next.length === 0 || path.hops.length >= MAX_HOPS) {
      if (path.hops.length >= 2) found.push(path); // one hop is the flow of that page already
      return;
    }
    for (const hop of next) walk({ start: path.start, hops: [...path.hops, hop] }, new Set([...seen, hop.to.id]));
  };
  for (const start of entry) walk({ start, hops: [] }, new Set([start.id]));

  // Keep a path only when no longer one begins the same way, the richest first.
  const same = (a: Path, b: Path) => a.start.id === b.start.id && a.hops.every((hop, i) => b.hops[i]?.to.id === hop.to.id && b.hops[i]?.cited[0].id === hop.cited[0].id);
  const kept = found.filter((path) => !found.some((other) => other !== path && other.hops.length > path.hops.length && same(path, other)));
  const score = (path: Path) => path.hops.length + path.hops.filter((hop) => hop.form).length * 2;
  return kept
    .sort((a, b) => score(b) - score(a))
    .slice(0, LIMIT)
    .map((path) => {
      const steps = [openStep(path.start), ...path.hops.map((hop) => (hop.form ? uiStep(hop.cited) : linkStep(hop.cited[0], hop.to)))];
      const key = `journey:${[path.start.id, ...path.hops.map((hop) => hop.cited.map((own) => own.id).join('+'))].join('>')}`;
      const flow = draft('ui', key, steps, nodes);
      const titles = [path.start, ...path.hops.map((hop) => hop.to)].map(titleOf);
      return { ...flow, name: `Journey: ${titles.join(' → ')}`, tags: [JOURNEY], priority: path.hops.some((hop) => hop.form) ? ('high' as const) : ('medium' as const) };
    });
}
