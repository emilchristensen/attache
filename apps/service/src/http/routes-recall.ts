import { RecallEvaluationInput } from "@jarvis/contracts";
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
    return input.set
      ? evaluateRecall(app.db, dataRoot, input.set, { source: "supplied" })
      : evaluateRecall(app.db, dataRoot, loadBrainQuestionSet(dataRoot), { source: "brain", path: RECALL_SET_PATH });
  });
}
