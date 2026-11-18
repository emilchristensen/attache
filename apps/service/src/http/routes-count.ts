import { DECISION_COUNT_PATH, type DecisionTotals } from "@attache/contracts";
import type { Router } from "./router.ts";
import type { App } from "../app.ts";
import { countOpenDecisions } from "../attention/engine.ts";

/**
 * The Decision count's four inputs as totals, so the Dashboard's count is exact above any list limit. A part whose
 * feature is off answers "off", not zero; the route itself needs no feature, since Proposals and sign-ins count with
 * everything switched off.
 */
export function decisionTotals(app: App): DecisionTotals {
  // Drafts past their expiry are finished, as `GET /actions` and `GET /attention` settle them before they answer.
  app.settleActions();
  return {
    inbox: app.featureEnabled("attention") ? countOpenDecisions(app.db) : "off",
    drafts: app.featureEnabled("drafts") ? app.actions.countWaiting() : "off",
    proposals: app.proposals.count("proposed"),
    signIns: app.connections.statuses().filter((c) => c.status === "needs_auth").length,
  };
}

export function registerCountRoutes(r: Router, app: App) {
  r.get(DECISION_COUNT_PATH, () => decisionTotals(app));
}
