import type { LlmConfig } from '../config/project.ts';
import type { TraceSink } from '../trace/sink.ts';
import { AnthropicGateway } from './anthropic.ts';
import { AssistantGateway } from './assistant.ts';
import type { LlmGateway } from './gateway.ts';
import { OpenAiCompatibleGateway } from './openai-compatible.ts';

// jobsFile: where the assistant provider keeps its jobs (the project's data folder); the others call a model.
export function createGateway(config: LlmConfig, trace: TraceSink, jobsFile = ''): LlmGateway {
  switch (config.provider) {
    case 'assistant':
      return new AssistantGateway(jobsFile, trace);
    case 'anthropic':
      return new AnthropicGateway(config, trace);
    case 'openai-compatible':
      return new OpenAiCompatibleGateway(config, trace);
  }
}
