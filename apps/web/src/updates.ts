/**
 * Settings' Updates section in the owner's words (spec #130): for each status the service reports (`GET /updates`),
 * its headline (shared with `attache update` and the line under the masthead, contracts' `update-wording.ts`), what it
 * means here, and which of Check now, Install now and Restart now it offers; and what the last Update did.
 * Pure, so every status has a table test.
 */
import { CHANNEL_LABEL, installAction, lastUpdateDetail, lastUpdateHeadline, UPDATES_OFF_DETAIL, updatesHeadline, type LastUpdateView, type UpdatesStatus, type UpdatesView } from "@attache/contracts";

export interface UpdatesShown {
  /** `danger` when something failed and the owner should look; everything else reads as plain news. */
  tone: "plain" | "danger";
  headline: string;
  /** What it means, or why, and what the owner can do; null when the headline says it all. */
  detail: string | null;
  /** Check now; Install now, or Restart now while the Update waits for Jobs. */
  actions: { check: boolean; install: "install" | "restart" | null };
}

/** What each status means in this section, and whether Check now shows; the headline and Install come from contracts. */
const DETAIL: Record<UpdatesStatus, { detail: (v: UpdatesView) => string | null; check: boolean; tone?: "danger" }> = {
  // A development install is not a fault, so it reads as plain news, not as a failure.
  unavailable: { detail: (v) => v.reason, check: false },
  off: { detail: () => `${UPDATES_OFF_DETAIL} Choose Automatic or Ask first to get Updates again.`, check: false },
  not_checked: { detail: () => "Attache looks for an Update when the service starts and every 6 hours.", check: true },
  checking: { detail: () => null, check: false },
  up_to_date: { detail: (v) => `No newer release in the ${CHANNEL_LABEL[v.channel]} channel.`, check: true },
  available: { detail: () => "Select Install now to install it. Attache restarts on the new version.", check: true },
  downloading: { detail: () => "Attache checks it against its signature before anything installs.", check: false },
  ready: { detail: () => "It is downloaded and checked. Select Install now when it suits you; Attache restarts on the new version.", check: true },
  waiting_for_jobs: {
    detail: (v) => `It installs once no Job is running, or after waiting 24 hours. Restart now installs it at once; ${v.jobs === 1 ? "the Job resumes from its" : "the Jobs resume from their"} last checkpoint.`,
    check: false,
  },
  installing: { detail: () => "Attache restarts on the new version in a moment, and this page reconnects on its own.", check: false },
  // A failed download keeps the Update an earlier check verified, so Install now can try it again.
  check_failed: { detail: (v) => v.reason, check: true, tone: "danger" },
};

export function updatesShown(v: UpdatesView): UpdatesShown {
  const rule = DETAIL[v.status];
  return { tone: rule.tone ?? "plain", headline: updatesHeadline(v), detail: rule.detail(v), actions: { check: rule.check, install: installAction(v) } };
}

/** When the last check finished, and what it found: null before the first one; no result while the next one runs. */
export function lastCheckShown(v: UpdatesView): { at: string; result: string | null } | null {
  if (!v.lastCheckedAt) return null;
  const result = v.status === "check_failed" ? "failed" : v.status === "up_to_date" ? "up to date" : v.update ? `found Attache ${v.update.version}` : null;
  return { at: v.lastCheckedAt, result };
}

/** What the last Update did, as its card shows it. `tone` is the `state` class it shows with. */
export function lastUpdateShown(last: LastUpdateView): { headline: string; detail: string | null; tone: "ok" | "error" | "partial" } {
  const tone = last.outcome === "updated" ? "ok" : last.outcome === "rolled_back" ? "error" : "partial";
  return { headline: lastUpdateHeadline(last), detail: lastUpdateDetail(last), tone };
}
