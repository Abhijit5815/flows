// Every error Flows raises on purpose, so callers can tell them apart without matching message text.
export class FlowsError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ConfigError extends FlowsError {}

// A remote service (LLM, embeddings, model download) failed, timed out or refused.
export class ProviderError extends FlowsError {
  readonly status: number | undefined;

  constructor(message: string, status?: number, options?: ErrorOptions) {
    super(message, options);
    this.status = status;
  }
}

// Model output that does not match the schema it was asked for.
export class OutputValidationError extends FlowsError {}

export class ChecksumError extends FlowsError {}

export class DeciderError extends FlowsError {}

// An LLM request that waits for the coding assistant to answer it (`flows jobs`, `flows answer`).
export class PendingAnswer extends FlowsError {}

// The live app couldn't be explored or inspected: no browser, a failed login, a session that ended mid-run.
export class LiveError extends FlowsError {}
