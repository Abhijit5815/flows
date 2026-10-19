export interface EmbeddingProvider {
  // Identifies model, revision and dtype; it keys the vector cache and the Decider's calibration.
  readonly version: string;
  // One unit-length vector per text, in the same order.
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}
