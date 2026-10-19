import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CATEGORIES, FALLBACK_CATEGORY_ID } from '../model/category.ts';
import { calibrationHalf, loadBuiltInTasks, TaskSchema, testHalf, type Task } from './task.ts';

const tasks = loadBuiltInTasks();

test('the built-in decision types load and validate', () => {
  assert.deepEqual(tasks.map((task) => task.task), ['destructive-risk', 'flow-category']);
});

test('flow-category labels are exactly the editable default categories', () => {
  const flowCategory = tasks.find((task) => task.task === 'flow-category');
  const editable = DEFAULT_CATEGORIES.filter((category) => category.id !== FALLBACK_CATEGORY_ID).map((category) => category.id);
  assert.deepEqual(flowCategory?.labels, editable);
});

test('both halves of every labelled set contain every label', () => {
  for (const task of tasks) {
    for (const half of [calibrationHalf(task), testHalf(task)]) {
      assert.deepEqual(new Set(half.map((item) => item.label)), new Set(task.labels), task.task);
    }
  }
});

const valid: Task = {
  task: 'tiny',
  description: 'test',
  labels: ['a', 'b'],
  rules: [{ pattern: '^x', flags: 'i', label: 'a' }],
  examples: { a: ['alpha'], b: ['beta'] },
  labelled: [
    { text: 'alpha one', label: 'a' },
    { text: 'beta one', label: 'b' },
    { text: 'alpha two', label: 'a' },
    { text: 'beta two', label: 'b' },
  ],
};

const rejects = (change: (task: Task) => void, path: string) => {
  const task = structuredClone(valid);
  change(task);
  const result = TaskSchema.safeParse(task);
  assert.equal(result.success, false);
  assert.ok(result.error.issues.some((issue) => issue.path.join('.') === path), `${path}: ${JSON.stringify(result.error.issues)}`);
};

test('task data is rejected when it would leak, or names labels that do not exist', () => {
  assert.ok(TaskSchema.safeParse(valid).success);
  rejects((task) => (task.labelled[0].text = 'Alpha'), 'labelled.0.text'); // same as an example, ignoring case
  rejects((task) => (task.labelled[1].text = 'alpha one'), 'labelled.1.text'); // duplicate inside the labelled set
  rejects((task) => (task.rules[0].label = 'c'), 'rules.0.label');
  rejects((task) => (task.rules[0].pattern = '('), 'rules.0.pattern');
  rejects((task) => delete task.examples.b, 'examples.b');
  rejects((task) => (task.labelled[0].label = 'c'), 'labelled.0.label');
});
