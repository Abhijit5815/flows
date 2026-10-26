import { resolve } from 'node:path';
import { z } from 'zod';
import { setCategories, type Project, type Repo } from '../config/project.ts';
import { loadEdits, OverrideSchema, saveAdded, saveOverride, type OverridePatch } from '../engine/edits.ts';
import { refreshFlows, type EngineDeps } from '../engine/engine.ts';
import { loadFlows } from '../engine/store.ts';
import type { Graph } from '../graph/schema.ts';
import { loadGraph } from '../graph/store.ts';
import { CategorySchema } from '../model/category.ts';
import { FlowSchema } from '../model/flow.ts';
import { addRule, FEEDBACK_KINDS, now } from '../rules/learned.ts';
import { ConfigError, FlowsError } from '../shared/errors.ts';
import { parseOrThrow } from '../shared/validate.ts';
import { drawFlow } from './propose.ts';

// What the review page may change. Every body is checked here, at the edge, before anything is written.
const RepoKey = z.string().min(1); // "<role>:<path>"
const Patch = OverrideSchema.omit({ version: true, edited: true });
const Place = z.string().regex(/^.+:[1-9]\d*$/);

export const FeedbackBody = z.object({ repo: RepoKey, flow: z.string().min(1), step: z.string().min(1).optional(), kind: z.enum(FEEDBACK_KINDS), comment: z.string().min(1).max(2000).optional(), place: Place.optional() });
export const EditBody = z.object({ repo: RepoKey, flow: z.string().min(1), patch: Patch });
export const AddBody = z.object({ repo: RepoKey, flow: FlowSchema });
export const BulkBody = z.object({
  flows: z.array(z.object({ repo: RepoKey, flow: z.string().min(1) })).min(1).max(1000),
  patch: Patch.optional(),
  verdict: z.enum(['correct', 'wrong', 'never']).optional(),
});
export const DrawBody = z.object({ repo: RepoKey, nodes: z.array(z.string().min(1)).min(1).max(50), name: z.string().trim().min(1).max(200) });
export const DescribeBody = z.object({ repo: RepoKey, text: z.string().trim().min(3).max(500) });
// "Walk this in the inspector": a flow to walk, or nothing for a free walk (a role no run has covered).
export const InspectBody = z.object({ repo: RepoKey.optional(), flow: z.string().min(1).max(200).optional() }).refine((walk) => (walk.repo === undefined) === (walk.flow === undefined), { message: 'give both repo and flow, or neither' });
export const CategoriesBody = z.object({ categories: z.array(CategorySchema).min(1), merges: z.array(z.object({ from: z.string().min(1), to: z.string().min(1) })).default([]) });

// A request the page sent that can't be carried out as asked; the server answers 400 with the message.
export class BadRequest extends FlowsError {}

export type Writes = {
  project(): Project;
  graphOf(repoKey: string): { repo: Repo; graph: Graph };
  draw(body: unknown): Promise<void>;
  feedback(body: unknown): Promise<void>;
  edit(body: unknown): Promise<void>;
  add(body: unknown): Promise<void>;
  bulk(body: unknown): Promise<void>;
  categories(body: unknown): Promise<void>;
};

export function writes(start: Project, deps: EngineDeps): Writes {
  let project = start;
  const repoOf = (key: string): Repo => {
    const repo = project.config.repos.find((candidate) => `${candidate.role}:${candidate.path}` === key);
    if (repo === undefined) throw new BadRequest(`no repo ${key}`);
    return repo;
  };
  const dirOf = (repo: Repo) => resolve(project.root, repo.path);
  const versionOf = (repo: Repo, id: string): number => {
    const flow = loadFlows(project, repo)?.flows.find((candidate) => candidate.id === id);
    if (flow === undefined) throw new BadRequest(`no flow ${id} in ${repo.role} ${repo.path}; run "flows scan"`);
    return flow.version;
  };
  // Every write ends here: the repo's flows are rebuilt from its last graph, so the page shows what the engine
  // now makes of the change.
  const refresh = async (repos: Iterable<Repo>): Promise<void> => {
    for (const repo of new Set(repos)) {
      const graph = loadGraph(project, repo);
      if (graph === undefined) throw new BadRequest(`${repo.role} ${repo.path} has no graph yet; run "flows scan"`);
      await refreshFlows(project, repo, graph, deps);
    }
  };
  // Every change is an override, on a generated flow or on one a person added, so it outlasts the next scan.
  const change = (repo: Repo, id: string, patch: OverridePatch): void => {
    saveOverride(dirOf(repo), id, patch, versionOf(repo, id));
  };
  const verdict = (repo: Repo, flow: string, kind: (typeof FEEDBACK_KINDS)[number], extra: { step?: string; comment?: string; place?: string } = {}) =>
    addRule(dirOf(repo), { type: 'feedback', flow, kind, ...extra, added: now() });

  const graphOf = (key: string): { repo: Repo; graph: Graph } => {
    const repo = repoOf(key);
    const graph = loadGraph(project, repo);
    if (graph === undefined) throw new BadRequest(`${repo.role} ${repo.path} has no graph yet; run "flows scan"`);
    return { repo, graph };
  };

  return {
    project: () => project,
    graphOf,
    async draw(body) {
      const { repo: key, nodes, name } = parseOrThrow(DrawBody, body, 'drawn flow', BadRequest);
      const { repo, graph } = graphOf(key);
      const flow = drawFlow(graph, nodes, name, loadFlows(project, repo)?.flows ?? []);
      if (typeof flow === 'string') throw new BadRequest(flow);
      saveAdded(dirOf(repo), flow);
      await refresh([repo]);
    },
    async feedback(body) {
      const { repo: key, flow, kind, ...extra } = parseOrThrow(FeedbackBody, body, 'feedback', BadRequest);
      const repo = repoOf(key);
      versionOf(repo, flow);
      verdict(repo, flow, kind, extra);
      await refresh([repo]);
    },
    async edit(body) {
      const { repo: key, flow, patch } = parseOrThrow(EditBody, body, 'edit', BadRequest);
      const repo = repoOf(key);
      change(repo, flow, patch);
      await refresh([repo]);
    },
    async add(body) {
      const { repo: key, flow } = parseOrThrow(AddBody, body, 'new flow', BadRequest);
      const repo = repoOf(key);
      if (loadFlows(project, repo)?.flows.some((own) => own.id === flow.id) && !loadEdits(dirOf(repo)).added.some((own) => own.id === flow.id)) {
        throw new BadRequest(`${flow.id} is already a flow of ${repo.role} ${repo.path}`);
      }
      saveAdded(dirOf(repo), flow);
      await refresh([repo]);
    },
    async bulk(body) {
      const { flows, patch, verdict: kind } = parseOrThrow(BulkBody, body, 'bulk change', BadRequest);
      const repos = flows.map(({ repo }) => repoOf(repo));
      flows.forEach(({ flow }, i) => {
        if (patch !== undefined) change(repos[i], flow, patch);
        if (kind !== undefined) verdict(repos[i], flow, kind);
      });
      await refresh(repos);
    },
    async categories(body) {
      const { categories, merges } = parseOrThrow(CategoriesBody, body, 'categories', BadRequest);
      const ids = new Set(categories.map((category) => category.id));
      for (const { to } of merges) if (!ids.has(to)) throw new BadRequest(`can't merge into "${to}": it isn't one of the categories`);
      try {
        project = setCategories(project, categories);
      } catch (error) {
        if (error instanceof ConfigError) throw new BadRequest(error.message);
        throw error;
      }
      // A merge moves every flow now in the merged category, as if a person had moved each one.
      for (const repo of project.config.repos) {
        for (const flow of loadFlows(project, repo)?.flows ?? []) {
          const into = merges.find(({ from }) => from === flow.category)?.to;
          if (into !== undefined) change(repo, flow.id, { category: into });
        }
      }
      await refresh(project.config.repos);
    },
  };
}
