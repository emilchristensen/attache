/**
 * Updates in the owner's words (spec #130): what Settings' Updates section says for each status the service reports
 * (`GET /updates`), which of Check now, Install now and Restart now it offers, and what the last Update did.
 * Pure, so every status has a table test; the line under the masthead (#141) words its notices from here too.
 */
import { plural, rollbackDetail, type LastUpdateView, type UpdateChannel, type UpdatesStatus, type UpdatesView } from "@attache/contracts";

export const CHANNEL_LABEL: Record<UpdateChannel, string> = { stable: "Stable", beta: "Beta" };

export interface UpdatesShown {
  /** `danger` when something failed and the owner should look; everything else reads as plain news. */
  tone: "plain" | "danger";
  headline: string;
  /** What it means, or why, and what the owner can do; null when the headline says it all. */
  detail: string | null;
  /** Check now; Install now, or Restart now while the Update waits for Jobs. */
  actions: { check: boolean; install: "install" | "restart" | null };
}

/** The version of the Update the view names; the status only names one when it has it. */
const version = (v: UpdatesView) => v.update?.version ?? "";

const RULES: Record<UpdatesStatus, (v: UpdatesView) => UpdatesShown> = {
  // A development install is not a fault, so it reads as plain news, not as a failure.
  unavailable: (v) => ({ tone: "plain", headline: "Updates are unavailable on this Machine", detail: v.reason, actions: { check: false, install: null } }),
  off: () => ({
    tone: "plain",
    headline: "Automatic updates is Off",
    detail: "Attache does not look for Updates and makes no request about them. Choose Automatic or Ask first to get Updates again.",
    actions: { check: false, install: null },
  }),
  not_checked: () => ({ tone: "plain", headline: "Not checked yet", detail: "Attache looks for an Update when the service starts and every 6 hours.", actions: { check: true, install: null } }),
  checking: () => ({ tone: "plain", headline: "Looking for an Update…", detail: null, actions: { check: false, install: null } }),
  up_to_date: (v) => ({ tone: "plain", headline: "Attache is up to date", detail: `No newer release in the ${CHANNEL_LABEL[v.channel]} channel.`, actions: { check: true, install: null } }),
  available: (v) => ({
    tone: "plain",
    headline: `Attache ${version(v)} is available`,
    detail: "Select Install now to install it. Attache restarts on the new version.",
    actions: { check: true, install: "install" },
  }),
  downloading: (v) => ({ tone: "plain", headline: `Downloading Attache ${version(v)}…`, detail: "Attache checks it against its signature before anything installs.", actions: { check: false, install: null } }),
  ready: (v) => ({
    tone: "plain",
    headline: `Attache ${version(v)} is ready to install`,
    detail: "It is downloaded and checked. Select Install now when it suits you; Attache restarts on the new version.",
    actions: { check: true, install: "install" },
  }),
  waiting_for_jobs: (v) => {
    const jobs = v.jobs ?? 0;
    return {
      tone: "plain",
      headline: `Attache ${version(v)} is waiting for ${plural(jobs, "Job")} to finish`,
      detail: `It installs once no Job is running, or after waiting 24 hours. Restart now installs it at once; ${jobs === 1 ? "the Job resumes from its" : "the Jobs resume from their"} last checkpoint.`,
      actions: { check: false, install: "restart" },
    };
  },
  installing: (v) => ({ tone: "plain", headline: `Installing Attache ${version(v)}`, detail: "Attache restarts on the new version in a moment, and this page reconnects on its own.", actions: { check: false, install: null } }),
  // A failed download keeps the Update an earlier check verified, so Install now can try it again.
  check_failed: (v) => ({ tone: "danger", headline: "The last check failed", detail: v.reason, actions: { check: true, install: v.update ? "install" : null } }),
};

export function updatesShown(v: UpdatesView): UpdatesShown {
  return RULES[v.status](v);
}

/** When the last check finished, and what it found: null before the first one; no result while the next one runs. */
export function lastCheckShown(v: UpdatesView): { at: string; result: string | null } | null {
  if (!v.lastCheckedAt) return null;
  const result = v.status === "check_failed" ? "failed" : v.status === "up_to_date" ? "up to date" : v.update ? `found Attache ${v.update.version}` : null;
  return { at: v.lastCheckedAt, result };
}

/**
 * What the last Update did. `tone` is the `state` class it shows with.
 * A rollback's `detail` is why it failed, then what became of the database (`rollbackDetail` in contracts' `wording.ts`).
 */
export function lastUpdateShown(last: LastUpdateView): { headline: string; detail: string | null; tone: "ok" | "error" | "partial" } {
  switch (last.outcome) {
    case "updated":
      return { headline: `Attache updated from ${last.from} to ${last.to}`, detail: null, tone: "ok" };
    case "rolled_back":
      return { headline: `The Update to ${last.to} failed, so Attache went back to ${last.from}`, detail: rollbackDetail(last), tone: "error" };
    case "failed":
      return { headline: `The Update to ${last.to} did not install, so Attache stayed on ${last.from}`, detail: last.reason, tone: "partial" };
  }
}
