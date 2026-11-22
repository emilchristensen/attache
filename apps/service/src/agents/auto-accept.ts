import type { HarnessSettingView } from "@attache/contracts";
import { type Db, nowIso } from "../core/db.ts";
import { HttpError } from "../http/router.ts";

/** Whether a Harness is connected on this Machine. */
export type HarnessConnected = (kind: string) => boolean;

/** Every Harness Attache can connect, in the order it lists them. */
export type KnownHarnesses = () => Array<{ kind: string; label: string }>;

/**
 * Which Harnesses may save without asking the owner, on this Machine. Kept in
 * the service database (local state), never in the Brain, so it does not
 * replicate. On for every connected Harness unless the owner switched it off
 * (ADR 0004). A Harness that is not connected, or an unknown MCP client (one
 * that is not a Harness Attache knows), always asks: the Dashboard could not switch it off.
 */
export class AutoAcceptStore {
  private readonly db: Db;
  private readonly connected: HarnessConnected;
  private readonly harnesses: KnownHarnesses;

  constructor(db: Db, connected: HarnessConnected, harnesses: KnownHarnesses) {
    this.db = db;
    this.connected = connected;
    this.harnesses = harnesses;
  }

  private known(harness: string) {
    return this.harnesses().find((h) => h.kind === harness);
  }

  isOn(harness: string): boolean {
    if (!this.known(harness) || !this.connected(harness)) return false;
    const row = this.db.prepare("select auto_accept from harness_settings where harness = ?").get(harness) as { auto_accept: number } | undefined;
    return row === undefined || row.auto_accept === 1;
  }

  /** Forget the owner's choice for a Harness, so it is on again the next time it is connected. */
  forget(harness: string): void {
    this.db.prepare("delete from harness_settings where harness = ?").run(harness);
  }

  /** Every connected Harness with its setting, in the order Attache lists Harnesses. */
  list(): HarnessSettingView[] {
    return this.harnesses()
      .filter((a) => this.connected(a.kind))
      .map((a) => ({ id: a.kind, label: a.label, autoAccept: this.isOn(a.kind) }));
  }

  /** Switch auto-accept for one connected Harness. A Harness that is not connected has nothing to switch. */
  change(harness: string, on: boolean): HarnessSettingView {
    const integration = this.known(harness);
    if (!integration) throw new HttpError(404, "not_found", `Attache does not know a Harness called ${harness}.`);
    if (!this.connected(harness)) throw new HttpError(409, "not_connected", `Connect ${integration.label} first; auto-accept applies only to a connected Harness.`);
    this.db
      .prepare("insert into harness_settings (harness, auto_accept, updated_at) values (?, ?, ?) on conflict(harness) do update set auto_accept = excluded.auto_accept, updated_at = excluded.updated_at")
      .run(harness, on ? 1 : 0, nowIso());
    return { id: integration.kind, label: integration.label, autoAccept: on };
  }
}
