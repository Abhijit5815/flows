import { AutoModelForSequenceClassification, AutoTokenizer, env, type PreTrainedModel, type PreTrainedTokenizer } from '@huggingface/transformers';
import { z } from 'zod';
import type { Threshold } from '../config/project.ts';
import { ensureModelFiles, type ModelFiles, type Progress } from '../embeddings/download.ts';
import { DeciderError, FlowsError } from '../shared/errors.ts';
import { sha256 } from '../shared/hash.ts';
import { parseOrThrow } from '../shared/validate.ts';
import { eventBase } from '../trace/event.ts';
import type { TraceSink } from '../trace/sink.ts';
import { softmax } from './calibration.ts';
import { UNKNOWN, type Decider, type Decision } from './decider.ts';

// Transformers.js must never fetch by itself: weights arrive only through ensureModelFiles, checksummed.
env.allowRemoteModels = false;

// PLAN.md §13, decided 2026-10-20: Apache-2.0 on its model card, trained on SNLI and MultiNLI only.
export const NLI_MODEL: ModelFiles = {
  source: 'https://huggingface.co/cross-encoder/nli-deberta-v3-xsmall',
  revision: 'a150876415327c80daeff35ca6f68f5ed8cf5c24',
  files: [
    { path: 'config.json', size: 1053, sha256: '8d9f07bf7ba54a6fc3b1962483056f94c39dcf188db4cf61843e1c88f94b2342' },
    { path: 'tokenizer.json', size: 8656624, sha256: '5124ef2ead1a10a717703bc436de7f353da76d6340e4587719b42b1693707964' },
    { path: 'tokenizer_config.json', size: 1346, sha256: 'f3eecd07c370ef0bf7dd3780d3cd68cf9c8b00c267e21a208ddcd8f82bfec1a6' },
    { path: 'onnx/model.onnx', size: 284200859, sha256: '7105da41f625c42eca24e9465ec99150d02a80e644659d7a1daa93a6357155d4' },
  ],
};

export const GROUNDING = 'grounding';
export const GROUNDING_LABELS = ['supported', 'unsupported'] as const;

const InputSchema = z.object({ evidence: z.string().min(1), claim: z.string().min(1) });

// The grounding question as one Decider input: does `evidence` support `claim`?
export const groundingInput = (evidence: string, claim: string): string => JSON.stringify({ evidence, claim });

function parseJson(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    throw new DeciderError(`${GROUNDING} input is not JSON: ${input.slice(0, 80)}`);
  }
}

export type EntailmentDeps = { modelsDir: string; trace: TraceSink; threshold: Threshold; onProgress?: Progress };

type Loaded = { tokenizer: PreTrainedTokenizer; model: PreTrainedModel; entailment: number };

// PLAN.md §7 claim-vs-evidence grounding: an NLI cross-encoder reads the evidence as premise and the claim as
// hypothesis. supported = p(entailment), unsupported = p(neutral) + p(contradiction); below the threshold, unknown.
export class EntailmentDecider implements Decider {
  readonly version = `nli:${new URL(NLI_MODEL.source).pathname.slice(1)}@${NLI_MODEL.revision}:fp32`;
  readonly #deps: EntailmentDeps;
  #loaded: Promise<Loaded> | undefined;

  constructor(deps: EntailmentDeps) {
    this.#deps = deps;
  }

  async decide(taskType: string, input: string, allowedLabels: readonly string[]): Promise<Decision> {
    const startedAt = performance.now();
    if (taskType !== GROUNDING) throw new DeciderError(`the entailment Decider answers "${GROUNDING}" only, not "${taskType}"`);
    if (allowedLabels.length !== 2 || !GROUNDING_LABELS.every((label) => allowedLabels.includes(label))) {
      throw new DeciderError(`allowed labels for ${GROUNDING} must be: ${GROUNDING_LABELS.join(', ')} (got: ${allowedLabels.join(', ')})`);
    }
    const { evidence, claim } = parseOrThrow(InputSchema, parseJson(input), `${GROUNDING} input`, DeciderError);
    const { tokenizer, model, entailment } = await (this.#loaded ??= this.#load());
    const { logits } = await model(tokenizer(evidence, { text_pair: claim, truncation: true }));
    const supported = softmax(Array.from(logits.data as Float32Array), 1)[entailment];
    const top = Math.max(supported, 1 - supported);
    const { min_prob, min_margin } = this.#deps.threshold;
    // With two labels the margin between them is |2p - 1|.
    const sure = top >= min_prob && Math.abs(2 * supported - 1) >= min_margin;
    const all_probs = { supported, unsupported: 1 - supported };
    const decision: Decision = { label: sure ? (supported >= 0.5 ? 'supported' : 'unsupported') : UNKNOWN, prob: top, all_probs, version: this.version };
    this.#deps.trace.record({
      ...eventBase(startedAt),
      kind: 'decision',
      decision_type: GROUNDING,
      input,
      inputs_ref: sha256(input),
      allowed_labels: [...allowedLabels],
      label: decision.label,
      source: 'entailment',
      probs: all_probs,
      threshold: this.#deps.threshold,
      model_version: this.version,
    });
    return decision;
  }

  async #load(): Promise<Loaded> {
    try {
      const dir = await ensureModelFiles(NLI_MODEL, this.#deps.modelsDir, this.#deps.onProgress);
      const [tokenizer, model] = await Promise.all([
        AutoTokenizer.from_pretrained(dir, { local_files_only: true }),
        AutoModelForSequenceClassification.from_pretrained(dir, { local_files_only: true, device: 'cpu', dtype: 'fp32' }),
      ]);
      const labels = Object.entries((model.config as { id2label?: Record<string, string> }).id2label ?? {});
      const entailment = labels.find(([, label]) => label.toLowerCase() === 'entailment')?.[0];
      if (entailment === undefined) throw new FlowsError(`${NLI_MODEL.source} has no "entailment" label in its config`);
      return { tokenizer, model, entailment: Number(entailment) };
    } catch (error) {
      this.#loaded = undefined; // a failed load is not remembered, so the next call retries
      throw error;
    }
  }
}
