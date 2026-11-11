import { z } from "zod";

/** API contract: Meaning-based search. */

/**
 * Where this Machine's meaning-based search stands. Search answers on keywords
 * in every state; vectors are only complete in `ready`.
 * - `missing`: the model is not downloaded.
 * - `downloading`: the owner started the download and it is running.
 * - `failed`: the download, or loading the downloaded model, failed; `error` says why.
 * - `building`: the model is here and vectors are being built for chunks that lack one.
 * - `ready`: every chunk in this Machine's index has a vector.
 */
export const MeaningState = z.enum(["missing", "downloading", "failed", "building", "ready"]);
export type MeaningState = z.infer<typeof MeaningState>;

/** How search ranks results now: by keywords only, or by keywords and meaning together. */
export type MeaningRanking = "keywords" | "meaning";

export interface MeaningStatus {
  state: MeaningState;
  /** Keywords until the model is ready and search uses its vectors in ranking. */
  ranking: MeaningRanking;
  model: { name: string; bytes: number };
  /** Bytes received so far, while downloading. */
  download: { received: number; total: number } | null;
  /** Chunks in this Machine's index, and how many of them have a vector. */
  vectors: { chunks: number; embedded: number };
  error: string | null;
}
