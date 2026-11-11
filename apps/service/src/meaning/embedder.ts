import type { MeaningModel } from "./model.ts";

/**
 * Turns text into unit-length vectors that point the same way when the text
 * means the same thing. Passages and questions are embedded apart, because
 * some models expect a different prefix for each.
 */
export interface Embedder {
  readonly dimensions: number;
  embedPassages(texts: readonly string[]): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
  close(): Promise<void>;
}

/** Load a downloaded model from its folder. Tests pass their own to watch or pace the work. */
export type LoadEmbedder = (dir: string, model: MeaningModel) => Promise<Embedder>;
