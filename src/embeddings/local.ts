import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { FlowsError } from '../shared/errors.ts';
import type { CatalogueEntry } from './catalogue.ts';
import { ensureModelFiles, type Progress } from './download.ts';
import type { EmbeddingProvider } from './provider.ts';

// Transformers.js must never fetch by itself: weights arrive only through ensureModelFiles, checksummed.
env.allowRemoteModels = false;

// A catalogue model run in-process on the CPU through Transformers.js (inputs past max_tokens are truncated by its tokenizer).
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly version: string;
  readonly #entry: CatalogueEntry;
  readonly #modelsDir: string;
  readonly #onProgress: Progress | undefined;
  #extractor: Promise<FeatureExtractionPipeline> | undefined;

  constructor(entry: CatalogueEntry, modelsDir: string, onProgress?: Progress) {
    this.version = `local:${new URL(entry.source).pathname.slice(1)}@${entry.revision}:${entry.dtype}`;
    this.#entry = entry;
    this.#modelsDir = modelsDir;
    this.#onProgress = onProgress;
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const extractor = await (this.#extractor ??= this.#load());
    const output = await extractor([...texts], { pooling: this.#entry.pooling, normalize: true });
    const data = output.data;
    const dims = output.dims.at(-1);
    if (!(data instanceof Float32Array) || dims !== this.#entry.dims) {
      throw new FlowsError(`${this.#entry.id} returned ${dims}-dim ${data.constructor.name} output, expected ${this.#entry.dims}-dim Float32Array`);
    }
    return texts.map((_, i) => data.slice(i * dims, (i + 1) * dims));
  }

  #load(): Promise<FeatureExtractionPipeline> {
    const external = this.#entry.files.some((file) => file.path.endsWith('.onnx_data'));
    const loading = ensureModelFiles(this.#entry, this.#modelsDir, this.#onProgress).then((dir) =>
      pipeline('feature-extraction', dir, {
        local_files_only: true,
        device: 'cpu',
        dtype: this.#entry.dtype,
        ...(external ? { use_external_data_format: true } : {}),
      }),
    );
    // A failed load is not remembered, so the next call retries instead of failing forever.
    return loading.catch((error: unknown) => {
      this.#extractor = undefined;
      throw error;
    });
  }
}
