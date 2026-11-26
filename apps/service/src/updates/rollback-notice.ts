/**
 * The system notification for a rolled-back Update (spec #130, "System notifications"): the one an Update raises,
 * since a successful Update tells the owner in the Dashboard only. Raised once per outcome: the service reads the
 * outcome at every start, so the first one to raise it writes `notifiedAt` into the outcome record first (a field
 * installers of other versions leave alone, see `install-records.ts`). Writing first means a crash in between loses
 * the notification rather than showing it twice; the Dashboard and `attache update` still tell the rollback.
 *
 * It is not gated by the owner's switch for urgent items nor by quiet hours, both of which are about the Inbox: a
 * rollback means Attache changed its own software and went back, which the owner hears about once, when it happens.
 */
import { rollbackDetail } from "@attache/contracts";
import type { Logger } from "../core/log.ts";
import { recordOutcome, type OutcomeRecord } from "./install-records.ts";

/** Hands a notification to the operating system; resolves whether it was shown. */
export type Notify = (title: string, body: string) => Promise<boolean>;

/** The notification's words: which Update failed, the version Attache runs again, why, and what became of the database. */
export function rollbackNotification(outcome: OutcomeRecord): { title: string; body: string } {
  const reason = outcome.reason ?? "The installer gave no reason.";
  return {
    title: `The Update to ${outcome.to} failed`,
    body: `Attache went back to ${outcome.from}. ${rollbackDetail({ from: outcome.from, reason, database: outcome.database ?? null, backup: outcome.backup ?? null })}`,
  };
}

/** Raise the notification for a rolled-back outcome no service has raised it for yet; anything else raises nothing. */
export function notifyRollbackOnce(deps: { stateDir: string; notify: Notify; log: Logger; now: Date }, outcome: OutcomeRecord): void {
  if (outcome.outcome !== "rolled_back" || outcome.notifiedAt) return;
  recordOutcome(deps.stateDir, { ...outcome, notifiedAt: deps.now.toISOString() });
  const { title, body } = rollbackNotification(outcome);
  void deps.notify(title, body).catch((e: unknown) => deps.log.warn("could not raise the notification for a rolled-back Update", { error: (e as Error).message }));
}
