import type { EmbedderConfig } from '../config/project.ts';
import { catalogueEntry } from './catalogue.ts';
import type { Progress } from './download.ts';
import { LocalEmbeddingProvider } from './local.ts';
import type { EmbeddingProvider } from './provider.ts';
import { RemoteEmbeddingProvider } from './remote.ts';

export function createEmbeddingProvider(config: EmbedderConfig, modelsDir: string, onProgress?: Progress): EmbeddingProvider {
  switch (config.provider) {
    case 'local':
      return new LocalEmbeddingProvider(catalogueEntry(config.model), modelsDir, onProgress);
    case 'openai-compatible':
      return new RemoteEmbeddingProvider(config);
  }
}
