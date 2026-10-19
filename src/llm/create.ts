import type { LlmConfig } from '../config/project.ts';
import type { TraceSink } from '../trace/sink.ts';
import { AnthropicGateway } from './anthropic.ts';
import type { LlmGateway } from './gateway.ts';
import { OpenAiCompatibleGateway } from './openai-compatible.ts';

export function createGateway(config: LlmConfig, trace: TraceSink): LlmGateway {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicGateway(config, trace);
    case 'openai-compatible':
      return new OpenAiCompatibleGateway(config, trace);
  }
}
