import { HarnessAutoAcceptInput } from "@attache/contracts";
import type { Router } from "./router.ts";
import type { App } from "../app.ts";
import { nowIso } from "../core/db.ts";

/** `GET /harnesses`: connected Harnesses and their auto-accept switch. `PUT /harnesses/:id/auto-accept` flips it. */
export function registerHarnessRoutes(r: Router, app: App) {
  const connected = (kind: string) => app.connections.record(kind)?.status === "connected";
  r.get("/harnesses", () => app.autoAccept.list(connected));
  r.put("/harnesses/:id/auto-accept", async (c) => {
    const { autoAccept } = await c.body(HarnessAutoAcceptInput);
    const out = app.autoAccept.change(c.params.id!, autoAccept, connected);
    app.db.prepare("insert into audit (at, actor, event, data) values (?,?,?,?)").run(nowIso(),c.client?.id ?? "user", "auto_accept_changed", JSON.stringify(out));
    app.bus.emit("event", { type: "config.changed" });
    return out;
  });
}
