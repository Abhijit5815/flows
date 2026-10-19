import type { Role } from '../config/project.ts';
import type { GraphBuilder } from '../graph/builder.ts';
import type { FileFacts, PatternRule } from '../ingest/match.ts';
import type { Resolver } from '../ingest/resolve.ts';

// What stack detection looks for: a package.json dependency, plus any folder the adapter needs.
export type DetectionRule = {
  dependency: string;
  testedMajor: number; // the major version the adapter is built and tested on; others get a warning
  needsOneOf?: readonly string[];
};

// Something an adapter matched but could not turn into graph nodes. The coverage report lists it instead of
// the adapter guessing.
export type Unrecognised = { file: string; line: number; reason: string };

export type ExtractContext = {
  files: readonly string[]; // every file in the repo folder, relative to it
  facts: ReadonlyMap<string, FileFacts>; // pattern matches for each source file
  read: (path: string) => string;
  resolver: Resolver;
  graph: GraphBuilder;
};

// One per framework. Adding a framework means adding an adapter, not changing the pipeline.
export interface FrameworkAdapter {
  readonly id: string;
  readonly role: Role;
  readonly detection: DetectionRule;
  readonly rules: readonly PatternRule[]; // run by the pipeline on every source file; results cached per file
  // Wider patterns for code that looks like a route, handler or action; matches the graph doesn't cover go to the
  // "possibly missed" list (never into the graph).
  readonly suspects: readonly PatternRule[];
  extract(context: ExtractContext): Unrecognised[];
}
