import type { MeaningRanking, MeaningState, MeaningStatus } from "@jarvis/contracts";
import type { Db } from "../core/db.ts";
import { SEARCH_RANKS_BY_MEANING } from "../memory/search.ts";
import { isInstalled } from "./model-files.ts";
import { modelBytes, type MeaningModel } from "./model.ts";
import { vectorCoverage } from "./vectors.ts";

/** What meaning-based search can do, from what is known about the model and the vectors. */
export function meaningStateOf(s: { downloading: boolean; failed: boolean; installed: boolean; vectors: { chunks: number; embedded: number } }): MeaningState {
  if (s.downloading) return "downloading";
  if (s.failed) return "failed";
  if (!s.installed) return "missing";
  return s.vectors.embedded < s.vectors.chunks ? "building" : "ready";
}

/** How search ranks results in this state: by keywords, until it is ready and search uses its vectors. */
export function rankingOf(state: MeaningState): MeaningRanking {
  return state === "ready" && SEARCH_RANKS_BY_MEANING ? "meaning" : "keywords";
}

/**
 * Meaning-based search as the files and the index show it, for a command that
 * runs without the service: a download in progress or a failed one is known
 * only to the service, so here the model is either on disk or missing.
 */
export function offlineMeaningStatus(db: Db, modelsDir: string, model: MeaningModel): MeaningStatus {
  const vectors = vectorCoverage(db, model.id);
  const state = meaningStateOf({ downloading: false, failed: false, installed: isInstalled(modelsDir, model), vectors });
  return { state, ranking: rankingOf(state), model: { name: model.name, bytes: modelBytes(model) }, download: null, vectors, error: null };
}
