import type { Role } from '../config/project.ts';

// What stack detection looks for: a package.json dependency, plus any folder the adapter needs.
export type DetectionRule = {
  dependency: string;
  testedMajor: number; // the major version the adapter is built and tested on; others get a warning
  needsOneOf?: readonly string[];
};

// One per framework. Adding a framework means adding an adapter, not changing the pipeline.
export interface FrameworkAdapter {
  readonly id: string;
  readonly role: Role;
  readonly detection: DetectionRule;
}
