import type { Ctx } from "./router.ts";
import type { App } from "../app.ts";
import { nowIso } from "../core/db.ts";

/** Records an auto-accept switch the owner flipped (a Harness's or Consolidation's) in the audit log. */
export function auditAutoAcceptChange(app: App, c: Ctx, data: { id: string; autoAccept: boolean }) {
  app.db.prepare("insert into audit (at, actor, event, data) values (?,?,?,?)").run(nowIso(), c.client?.id ?? "user", "auto_accept_changed", JSON.stringify(data));
}
