import { join } from 'node:path';
import { projectDataDir, storageDir, threshold, type Project } from '../config/project.ts';
import { createEmbeddingProvider } from '../embeddings/create.ts';
import type { Progress } from '../embeddings/download.ts';
import { JsonlTraceSink, traceFile } from '../trace/sink.ts';
import { DeciderV1 } from './decider.ts';
import { loadBuiltInTasks } from './task.ts';

// Wires a Decider from the project config: its embedder, its trace file and its cache folder.
export function createDecider(project: Project, onProgress?: Progress): DeciderV1 {
  const dataDir = projectDataDir(project);
  return new DeciderV1({
    tasks: loadBuiltInTasks(),
    provider: createEmbeddingProvider(project.config.embedder, join(storageDir(project), 'models'), onProgress),
    trace: new JsonlTraceSink(traceFile(dataDir)),
    cacheDir: join(dataDir, 'index'),
    threshold: (taskType) => threshold(project.config, taskType),
  });
}
