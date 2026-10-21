import { resolve } from 'node:path';
import type { Project } from '../config/project.ts';
import type { Task } from '../decider/task.ts';
import { lookup } from '../graph/lookup.ts';
import { loadGraph } from '../graph/store.ts';
import { loadRules } from '../rules/learned.ts';
import { deciderText } from './describe.ts';
import { loadEdits } from './edits.ts';
import { verdictsOf } from './engine.ts';
import { loadFlows } from './store.ts';

// Decider examples a project taught, by task and label.
export type Learned = Record<string, Record<string, string[]>>;

// PLAN.md Phase 7 learning loop: what people did to a project's flows, as Decider examples. Only what is unambiguous:
// a category a person set says the flow's text is that category; a flow a person marked correct and left enabled
// says its text is safe. A flow marked wrong or never says nothing about risk, so it teaches nothing (fail closed).
// The texts come from the last scan, so a correction takes effect at the scan after it.
export function learnedExamples(project: Project): Learned {
  const learned: Learned = {};
  const add = (task: string, label: string, text: string) => {
    const labels = (learned[task] ??= {});
    if (!(labels[label] ??= []).includes(text)) labels[label].push(text);
  };
  for (const repo of project.config.repos) {
    const graph = loadGraph(project, repo);
    const set = loadFlows(project, repo);
    if (graph === undefined || set === undefined) continue;
    const dir = resolve(project.root, repo.path);
    const { overrides } = loadEdits(dir);
    const verdicts = verdictsOf(loadRules(dir));
    const nodes = lookup(graph);
    for (const flow of set.flows) {
      if (flow.origin === 'observed') continue; // no source nodes, so no text in the Decider's format
      const text = deciderText(flow, nodes);
      const category = overrides[flow.id]?.category;
      if (category !== undefined) add('flow-category', category, text);
      if (verdicts.get(flow.id) === 'correct' && flow.enabled) add('destructive-risk', 'safe', text);
    }
  }
  return learned;
}

// The built-in tasks with a project's examples added, for the labels each task has. A text already among a task's
// examples or held-out set is left out, so the held-out measure stays honest. The Decider caches its prototypes and
// calibration by the task data, so new examples mean a refit at the next use.
export function withLearned(tasks: readonly Task[], learned: Learned): Task[] {
  return tasks.map((task) => {
    const own = learned[task.task];
    if (own === undefined) return task;
    const known = new Set([...Object.values(task.examples).flat(), ...task.labelled.map((item) => item.text)].map((text) => text.trim().toLowerCase()));
    const examples = { ...task.examples };
    for (const [label, texts] of Object.entries(own)) {
      if (!task.labels.includes(label)) continue;
      const fresh = texts.filter((text) => !known.has(text.trim().toLowerCase()));
      if (fresh.length > 0) examples[label] = [...(examples[label] ?? []), ...fresh];
    }
    return { ...task, examples };
  });
}
