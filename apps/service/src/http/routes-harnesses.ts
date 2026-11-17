import { HarnessAutoAcceptInput } from "@attache/contracts";
import type { Router } from "./router.ts";
import type { App } from "../app.ts";
import { auditAutoAcceptChange } from "./auto-accept-audit.ts";

/** `GET /harnesses`: connected Harnesses and their auto-accept switch. `PUT /harnesses/:id/auto-accept` flips it. */
export function registerHarnessRoutes(r: Router, app: App) {
  r.get("/harnesses", () => app.autoAccept.list());
  r.put("/harnesses/:id/auto-accept", async (c) => {
    const { autoAccept } = await c.body(HarnessAutoAcceptInput);
    const out = app.autoAccept.change(c.params.id!, autoAccept);
    auditAutoAcceptChange(app, c, out);
    app.bus.emit("event", { type: "config.changed" });
    return out;
  });
}
