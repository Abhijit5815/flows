import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FlowsError } from '../shared/errors.ts';
import { parseOrThrow } from '../shared/validate.ts';
import { TraceEventSchema, type TraceEvent } from './event.ts';

export interface TraceSink {
  record(event: TraceEvent): void;
}

const checked = (event: TraceEvent): TraceEvent => parseOrThrow(TraceEventSchema, event, 'trace event', FlowsError);

// This process's run: when it started and which command it is. One CLI invocation is one run.
export const RUN = `${new Date().toISOString()} ${process.argv[2] ?? 'library'}`;

// Append-only: one validated event per line, never rewritten, each stamped with this process's run.
export class JsonlTraceSink implements TraceSink {
  readonly file: string;

  constructor(file: string) {
    this.file = file;
    mkdirSync(dirname(file), { recursive: true });
  }

  record(event: TraceEvent): void {
    appendFileSync(this.file, `${JSON.stringify(checked({ ...event, run: RUN }))}\n`);
  }
}

export class MemoryTraceSink implements TraceSink {
  readonly events: TraceEvent[] = [];

  record(event: TraceEvent): void {
    this.events.push(checked(event));
  }
}

export const traceFile = (projectDataDir: string): string => join(projectDataDir, 'trace.jsonl');

export function readTrace(file: string): TraceEvent[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line, i) => {
      let data: unknown;
      try {
        data = JSON.parse(line);
      } catch (error) {
        throw new FlowsError(`${file}:${i + 1} is not valid JSON`, { cause: error });
      }
      return parseOrThrow(TraceEventSchema, data, `${file}:${i + 1}`, FlowsError);
    });
}
