import type { HarnessSettingView } from "@attache/contracts";
import { type Db, nowIso } from "../core/db.ts";
import { HttpError } from "../http/router.ts";
import { AGENT_INTEGRATIONS, integrationFor } from "./integrations.ts";

/**
 * Which Harnesses may save without asking the owner, on this Machine. Kept in
 * the service database (local state), never in the Brain, so it does not
 * replicate. Off unless the owner switched it on.
 */
export class AutoAcceptStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  isOn(harness: string): boolean {
    const row = this.db.prepare("select auto_accept from harness_settings where harness = ?").get(harness) as { auto_accept: number } | undefined;
    return row?.auto_accept === 1;
  }

  set(harness: string, on: boolean): void {
    this.db
      .prepare("insert into harness_settings (harness, auto_accept, updated_at) values (?, ?, ?) on conflict(harness) do update set auto_accept = excluded.auto_accept, updated_at = excluded.updated_at")
      .run(harness, on ? 1 : 0, nowIso());
  }

  /** Every connected Harness with its setting, in the order Attache lists Harnesses. */
  list(connected: (kind: string) => boolean): HarnessSettingView[] {
    return AGENT_INTEGRATIONS.filter((a) => connected(a.kind)).map((a) => ({ id: a.kind, label: a.label, autoAccept: this.isOn(a.kind) }));
  }

  /** Switch auto-accept for one connected Harness. A Harness that is not connected has nothing to switch. */
  change(harness: string, on: boolean, connected: (kind: string) => boolean): HarnessSettingView {
    const integration = integrationFor(harness);
    if (!integration) throw new HttpError(404, "not_found", `Attache does not know a Harness called ${harness}.`);
    if (!connected(harness)) throw new HttpError(409, "not_connected", `Connect ${integration.label} first; auto-accept applies only to a connected Harness.`);
    this.set(harness, on);
    return { id: integration.kind, label: integration.label, autoAccept: on };
  }
}
