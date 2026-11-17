import { RecallEvaluationInput } from "@attache/contracts";
import type { Router } from "./router.ts";
import { HttpError } from "./router.ts";
import type { App } from "../app.ts";
import { requireFeature } from "./routes-data.ts";
import { evaluateRecall, loadBrainQuestionSet, RECALL_SET_PATH } from "../memory/recall-evaluation.ts";

export function registerRecallRoutes(r: Router, app: App) {
  // Score search against a question set: the caller's, or the one kept in the Brain.
  r.post("/memory/recall-evaluation", async (c) => {
    requireFeature(app, "recall");
    const dataRoot = app.memory.dataRoot;
    if (!dataRoot) throw new HttpError(409, "needs_data_folder", "Choose a data folder first.");
    const input = await c.body(RecallEvaluationInput);
    const meaning = { ranking: app.meaning.status().ranking, nearest: (q: string, n: number) => app.meaning.nearest(q, n) };
    return input.set
      ? evaluateRecall(app.db, dataRoot, input.set, { source: "supplied" }, meaning)
      : evaluateRecall(app.db, dataRoot, loadBrainQuestionSet(dataRoot), { source: "brain", path: RECALL_SET_PATH }, meaning);
  });
}
