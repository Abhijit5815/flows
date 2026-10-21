// What the review page reads from `flows ui`. Types only, shared by the server and the page.
import type { Verdict } from '../engine/judge.ts';
import type { FlowSet } from '../engine/store.ts';
import type { Category } from '../model/category.ts';
import type { Feedback } from '../rules/learned.ts';

// verdicts: each flow's latest correct, wrong or never, from the repo's rules.
// feedback: every comment, missing step and verdict people left, oldest first.
export type RepoView = { path: string; role: 'web' | 'api'; framework: string | undefined; set: FlowSet | null; verdicts: Record<string, Verdict>; feedback: Feedback[] };

export type ProjectView = { name: string; categories: Category[]; repos: RepoView[] };

// A cited line with the lines around it; `start` is the line number of `lines[0]`.
export type Snippet = { file: string; line: number; start: number; lines: string[] };

export const TOKEN_HEADER = 'x-flows-token';

// The inspector the page started ("Walk this in the inspector"): whether it is still open, and how the last walk went.
export type InspectorView = { running: boolean; last: { flow: string | null; ticked: number; steps: number; error: string | null } | null };
