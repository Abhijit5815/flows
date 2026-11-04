// What the review page reads from `flows ui`. Types only, shared by the server and the page.
import type { Verdict } from '../engine/judge.ts';
import type { FlowSet } from '../engine/store.ts';
import type { Category } from '../model/category.ts';
import type { Feedback } from '../rules/learned.ts';

// verdicts: each flow's latest correct, wrong or never, from the repo's rules.
// feedback: every comment, missing step and verdict people left, oldest first.
export type RepoView = { path: string; role: 'web' | 'api'; framework: string | undefined; set: FlowSet | null; verdicts: Record<string, Verdict>; feedback: Feedback[] };

// llm: the AI that names flows (a key is never here, only the variable that holds it); sessions: the saved logins
// "Explore" can sign in as.
export type LlmView = { provider: 'assistant' | 'anthropic' | 'gemini' | 'openai-compatible'; model: string | null; base_url: string | null; api_key_env: string | null };

export type ProjectView = { name: string; categories: Category[]; repos: RepoView[]; llm: LlmView; sessions: string[] };

// A cited line with the lines around it; `start` is the line number of `lines[0]`.
export type Snippet = { file: string; line: number; start: number; lines: string[] };

export const TOKEN_HEADER = 'x-flows-token';

// The inspector the page started ("Walk this in the inspector"): whether it is still open, and how the last walk went.
export type InspectorView = { running: boolean; last: { flow: string | null; ticked: number; steps: number; error: string | null } | null };

// A run the page started that takes a while: an explorer run, or naming flows with the AI. `pending` counts the AI jobs
// now waiting for the coding assistant; `off` says why the AI could not be used.
export type TaskView = { running: 'explore' | 'name' | 'qa' | null; last: { task: 'explore' | 'name' | 'qa'; message: string; error: string | null; pending: number; off: string | null } | null };
