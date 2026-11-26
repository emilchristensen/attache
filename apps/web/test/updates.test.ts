import { describe, expect, it } from "vitest";
import type { LastUpdateView, UpdatesStatus, UpdatesView } from "@attache/contracts";
import { lastCheckShown, lastUpdateShown, updatesShown } from "../src/updates.ts";

const UPDATE = { version: "0.7.0", channel: "stable" as const, publishedAt: "2026-11-26T09:00:00Z", notes: "## 0.7.0\n\nWhat changed.\n" };

function view(status: UpdatesStatus, extra: Partial<UpdatesView> = {}): UpdatesView {
  return { version: "0.6.0", channel: "stable", mode: "automatic", status, reason: null, update: null, jobs: null, lastCheckedAt: null, lastUpdate: null, ...extra };
}

describe("updatesShown: every status the service reports, in the owner's words, with the actions it allows; only a failure reads as one", () => {
  const cases: ReadonlyArray<[name: string, v: UpdatesView, headline: string, detail: string | null, tone: "plain" | "danger", check: boolean, install: "install" | "restart" | null]> = [
    ["unavailable", view("unavailable", { reason: "Attache runs from a source checkout here, so it does not update itself." }), "Updates are unavailable on this Machine", "Attache runs from a source checkout here, so it does not update itself.", "plain", false, null],
    ["off", view("off", { mode: "off" }), "Automatic updates is Off", "Attache does not look for Updates and makes no request about them. Choose Automatic or Ask first to get Updates again.", "plain", false, null],
    ["not checked", view("not_checked"), "Not checked yet", "Attache looks for an Update when the service starts and every 6 hours.", "plain", true, null],
    ["checking", view("checking"), "Looking for an Update…", null, "plain", false, null],
    ["up to date", view("up_to_date"), "Attache is up to date", "No newer release in the Stable channel.", "plain", true, null],
    ["up to date on Beta", view("up_to_date", { channel: "beta" }), "Attache is up to date", "No newer release in the Beta channel.", "plain", true, null],
    ["available", view("available", { update: UPDATE }), "Attache 0.7.0 is available", "Select Install now to install it. Attache restarts on the new version.", "plain", true, "install"],
    ["downloading", view("downloading", { update: UPDATE }), "Downloading Attache 0.7.0…", "Attache checks it against its signature before anything installs.", "plain", false, null],
    ["ready", view("ready", { mode: "ask_first", update: UPDATE }), "Attache 0.7.0 is ready to install", "It is downloaded and checked. Select Install now when it suits you; Attache restarts on the new version.", "plain", true, "install"],
    [
      "waiting for 1 Job",
      view("waiting_for_jobs", { update: UPDATE, jobs: 1 }),
      "Attache 0.7.0 is waiting for 1 Job to finish",
      "It installs once no Job is running, or after waiting 24 hours. Restart now installs it at once; the Job resumes from its last checkpoint.",
      "plain",
      false,
      "restart",
    ],
    [
      "waiting for 2 Jobs",
      view("waiting_for_jobs", { update: UPDATE, jobs: 2 }),
      "Attache 0.7.0 is waiting for 2 Jobs to finish",
      "It installs once no Job is running, or after waiting 24 hours. Restart now installs it at once; the Jobs resume from their last checkpoint.",
      "plain",
      false,
      "restart",
    ],
    ["installing, after a restart that knows no manifest", view("installing"), "Installing an Update", "Attache restarts on the new version in a moment, and this page reconnects on its own.", "plain", false, null],
    ["installing", view("installing", { update: UPDATE }), "Installing Attache 0.7.0", "Attache restarts on the new version in a moment, and this page reconnects on its own.", "plain", false, null],
    ["check failed", view("check_failed", { reason: "Attache could not reach GitHub to look for an Update. Check the network, then select Check now." }), "The last check failed", "Attache could not reach GitHub to look for an Update. Check the network, then select Check now.", "danger", true, null],
    // A refused download keeps the Update an earlier check verified, so Install now can try it again.
    ["check failed with an Update known", view("check_failed", { reason: "The download of Attache 0.7.0 failed.", update: UPDATE }), "The last check failed", "The download of Attache 0.7.0 failed.", "danger", true, "install"],
  ];
  it.each(cases)("%s", (_name, v, headline, detail, tone, check, install) => {
    const shown = updatesShown(v);
    expect(shown.headline).toBe(headline);
    expect(shown.detail).toBe(detail);
    expect(shown.tone).toBe(tone);
    expect(shown.actions).toEqual({ check, install });
  });

});

describe("lastCheckShown: when the last check finished, and what it found", () => {
  it.each<[name: string, v: UpdatesView, result: string | null]>([
    ["never checked", view("not_checked"), null],
    ["found nothing newer", view("up_to_date", { lastCheckedAt: "2026-11-26T09:00:00Z" }), "up to date"],
    ["found an Update", view("ready", { lastCheckedAt: "2026-11-26T09:00:00Z", update: UPDATE }), "found Attache 0.7.0"],
    ["failed", view("check_failed", { lastCheckedAt: "2026-11-26T09:00:00Z", reason: "x" }), "failed"],
    ["checking again after a check that found nothing", view("checking", { lastCheckedAt: "2026-11-26T09:00:00Z" }), null],
  ])("%s", (_name, v, result) => {
    expect(lastCheckShown(v)).toEqual(v.lastCheckedAt ? { at: v.lastCheckedAt, result } : null);
  });
});

describe("lastUpdateShown: what the last Update did", () => {
  const at = "2026-11-26T09:00:00Z";
  it.each<[name: string, last: LastUpdateView, headline: string, detail: string | null, tone: "ok" | "error" | "partial"]>([
    ["updated", { outcome: "updated", from: "0.6.0", to: "0.7.0", at, notes: "## 0.7.0" }, "Attache updated from 0.6.0 to 0.7.0", null, "ok"],
    ["rolled back, with the database restored", { outcome: "rolled_back", from: "0.6.0", to: "0.7.0", at, reason: "Attache 0.7.0 did not start within 30 seconds.", database: "restored", backup: "/state/backups/pre-update-0.6.0-to-0.7.0-20261126090000.tar.gz" }, "The Update to 0.7.0 failed, so Attache went back to 0.6.0", "Attache 0.7.0 did not start within 30 seconds. The database was restored from the backup taken just before the Update.", "error"],
    ["rolled back without a backup", { outcome: "rolled_back", from: "0.6.0", to: "0.7.0", at, reason: "the service did not become healthy", database: "no_backup", backup: null }, "The Update to 0.7.0 failed, so Attache went back to 0.6.0", "the service did not become healthy. The database was not restored, because Attache 0.6.0 could not open it to back it up before the Update.", "error"],
    ["rolled back by an installer that did not say what became of the database", { outcome: "rolled_back", from: "0.6.0", to: "0.7.0", at, reason: "Attache 0.7.0 did not start within 30 seconds.", database: null, backup: null }, "The Update to 0.7.0 failed, so Attache went back to 0.6.0", "Attache 0.7.0 did not start within 30 seconds.", "error"],
    ["failed before changing anything", { outcome: "failed", from: "0.6.0", to: "0.7.0", at, reason: "The installer could not stop the service." }, "The Update to 0.7.0 did not install, so Attache stayed on 0.6.0", "The installer could not stop the service.", "partial"],
  ])("%s", (_name, last, headline, detail, tone) => {
    expect(lastUpdateShown(last)).toEqual({ headline, detail, tone });
  });
});
