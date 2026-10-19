import { readdirSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { ConfigError } from '../shared/errors.ts';
import { parseOrThrow } from '../shared/validate.ts';

const normalise = (text: string) => text.trim().toLowerCase();

// One decision type's data: labels, plain rules, prototype examples, and a separate labelled set.
export const TaskSchema = z
  .object({
    task: z.string().regex(/^[a-z][a-z0-9-]*$/),
    description: z.string().min(1),
    labels: z.array(z.string().min(1)).min(2),
    rules: z.array(z.object({ pattern: z.string().min(1), flags: z.string().default('i'), label: z.string().min(1) })),
    examples: z.record(z.string(), z.array(z.string().min(1)).min(1)),
    labelled: z.array(z.object({ text: z.string().min(1), label: z.string().min(1) })).min(4),
  })
  .superRefine((task, ctx) => {
    const issue = (path: PropertyKey[], message: string) => ctx.addIssue({ code: 'custom', path, message });
    const labels = new Set(task.labels);
    task.rules.forEach((rule, i) => {
      if (!labels.has(rule.label)) issue(['rules', i, 'label'], `"${rule.label}" is not a label of this task`);
      try {
        new RegExp(rule.pattern, rule.flags);
      } catch {
        issue(['rules', i, 'pattern'], 'not a valid regular expression');
      }
    });
    for (const label of task.labels) if (!task.examples[label]) issue(['examples', label], `no examples for "${label}"`);
    for (const label of Object.keys(task.examples)) if (!labels.has(label)) issue(['examples', label], 'not a label of this task');
    // Every text appears once across examples and the labelled set, so the test half never sees a prototype.
    const seen = new Set<string>();
    const once = (text: string, path: PropertyKey[]) => {
      if (seen.has(normalise(text))) issue(path, `"${text}" appears more than once`);
      seen.add(normalise(text));
    };
    for (const [label, texts] of Object.entries(task.examples)) texts.forEach((text, i) => once(text, ['examples', label, i]));
    task.labelled.forEach((item, i) => {
      if (!labels.has(item.label)) issue(['labelled', i, 'label'], `"${item.label}" is not a label of this task`);
      once(item.text, ['labelled', i, 'text']);
    });
  });

export type Task = z.infer<typeof TaskSchema>;

// Even positions calibrate and odd positions test, so neither half is picked by hand.
export const calibrationHalf = (task: Task) => task.labelled.filter((_, i) => i % 2 === 0);
export const testHalf = (task: Task) => task.labelled.filter((_, i) => i % 2 === 1);

// Adding a decision type means adding a JSON file to tasks/, nothing else.
export function loadBuiltInTasks(): Task[] {
  const dir = new URL('./tasks/', import.meta.url);
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => parseOrThrow(TaskSchema, JSON.parse(readFileSync(new URL(file, dir), 'utf8')), `src/decider/tasks/${file}`, ConfigError));
}
