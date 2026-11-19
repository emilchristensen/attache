import type { FeatureStatus } from "@attache/contracts";

/** What a feature switch says beside its name: only a problem, in words, with the service's reason. */
export interface FeatureProblem {
  state: "needs_setup" | "partial" | "unavailable";
  words: string;
  reason: string | null;
}

const WORDS: Record<FeatureProblem["state"], string> = { needs_setup: "needs setup", partial: "partly working", unavailable: "unavailable" };

/**
 * The problem a feature switch shows, or null. A ready feature is quiet, and a feature that is off says nothing more
 * than its unchecked switch: only a feature that is on and not fully working names its state and why.
 */
export function featureProblem(f: FeatureStatus): FeatureProblem | null {
  if (!f.enabled || f.readiness === "ready" || f.readiness === "disabled") return null;
  return { state: f.readiness, words: WORDS[f.readiness], reason: f.reason };
}
