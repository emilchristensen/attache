import type { MeaningRanking, MeaningState } from "@jarvis/contracts";

/** What meaning-based search can do, from what is known about the model and the vectors. */
export function meaningStateOf(s: { downloading: boolean; failed: boolean; installed: boolean; vectors: { chunks: number; embedded: number } }): MeaningState {
  if (s.downloading) return "downloading";
  if (s.failed) return "failed";
  if (!s.installed) return "missing";
  return s.vectors.embedded < s.vectors.chunks ? "building" : "ready";
}

/** How search ranks results in this state: by keywords alone until every passage has a vector, then by meaning as well. */
export function rankingOf(state: MeaningState): MeaningRanking {
  return state === "ready" ? "meaning" : "keywords";
}
