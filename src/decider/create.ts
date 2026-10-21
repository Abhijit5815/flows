import { join } from 'node:path';
import { projectDataDir, storageDir, threshold, type Project } from '../config/project.ts';
import { createEmbeddingProvider } from '../embeddings/create.ts';
import type { Progress } from '../embeddings/download.ts';
import type { EmbeddingProvider } from '../embeddings/provider.ts';
import { JsonlTraceSink, traceFile } from '../trace/sink.ts';
import { DeciderV1 } from './decider.ts';
import { EntailmentDecider, GROUNDING } from './entailment.ts';
import { loadBuiltInTasks, type Task } from './task.ts';

// Wires a Decider from the project config: its embedder (or one the caller already has), its trace file and its cache
// folder. tasks: the built-in ones by default; the CLI passes them with the project's learned examples (Phase 7).
export function createDecider(project: Project, onProgress?: Progress, provider?: EmbeddingProvider, tasks: readonly Task[] = loadBuiltInTasks()): DeciderV1 {
  const dataDir = projectDataDir(project);
  return new DeciderV1({
    tasks,
    provider: provider ?? createEmbeddingProvider(project.config.embedder, join(storageDir(project), 'models'), onProgress),
    trace: new JsonlTraceSink(traceFile(dataDir)),
    cacheDir: join(dataDir, 'index'),
    threshold: (taskType) => threshold(project.config, taskType),
  });
}

// The grounding check's Decider; its model is downloaded the first time a claim needs it.
export function createGrounding(project: Project, onProgress?: Progress): EntailmentDecider {
  return new EntailmentDecider({
    modelsDir: join(storageDir(project), 'models'),
    trace: new JsonlTraceSink(traceFile(projectDataDir(project))),
    threshold: threshold(project.config, GROUNDING),
    onProgress,
  });
}
