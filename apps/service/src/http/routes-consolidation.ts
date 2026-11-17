import { HarnessAutoAcceptInput, type ConsolidationSettingView } from "@attache/contracts";
import type { Router } from "./router.ts";
import type { App } from "../app.ts";
import { auditAutoAcceptChange } from "./auto-accept-audit.ts";

/**
 * `GET /consolidation` and `PUT /consolidation/auto-accept`: the Consolidation
 * switch, on this Machine only. On, Consolidation writes what it finds without
 * review; off, it makes Proposals (ADR 0004).
 */
export function registerConsolidationRoutes(r: Router, app: App) {
  const setting = (): ConsolidationSettingView => ({ autoAccept: app.config.get().consolidation.autoAccept });
  r.get("/consolidation", setting);
  r.put("/consolidation/auto-accept", async (c) => {
    const { autoAccept } = await c.body(HarnessAutoAcceptInput);
    app.config.set({ ...app.config.get(), consolidation: { autoAccept } });
    auditAutoAcceptChange(app, c, { id: "consolidation", autoAccept });
    app.bus.emit("event", { type: "config.changed" });
    return setting();
  });
}
