import { describe, expect, it } from "vitest";
import type { LastUpdateView, UpdatesStatus, UpdatesView } from "@attache/contracts";
import { UPDATED_LINE_MS, updateLine, type UpdateLine } from "../src/update-line.ts";

const NOW = Date.parse("2026-11-26T12:00:00Z");
const HOUR = 60 * 60_000;
const UPDATE = { version: "0.7.0", channel: "stable" as const, publishedAt: "2026-11-25T09:00:00Z", notes: "## 0.7.0\n\nWhat changed.\n" };
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const updated = (at: string): LastUpdateView => ({ outcome: "updated", from: "0.6.1", to: "0.7.0", at, notes: "### Fixed\n\n- Faster search.\n" });
const rolledBack = (at: string): LastUpdateView => ({ outcome: "rolled_back", from: "0.6.1", to: "0.7.0", at, reason: "Attache 0.7.0 did not answer within 30 seconds.", database: "restored", backup: null });
const failed = (at: string): LastUpdateView => ({ outcome: "failed", from: "0.6.1", to: "0.7.0", at, reason: "The download was refused." });

function view(status: UpdatesStatus, extra: Partial<UpdatesView> = {}): UpdatesView {
  return { version: "0.6.1", channel: "stable", mode: "automatic", status, reason: null, update: null, jobs: null, lastCheckedAt: null, lastUpdate: null, ...extra };
}

/** The line as the owner reads it: its words, then its action's label, as the spec writes them. */
function read(line: UpdateLine | null): string | null {
  if (!line) return null;
  return line.action ? `${line.text} · ${line.action.label}` : line.text;
}

describe("updateLine: which line shows under the masthead, in the spec's words", () => {
  const cases: ReadonlyArray<[name: string, v: UpdatesView | null, shown: string | null]> = [
    ["nothing known yet", null, null],
    ["up to date, no Update ever", view("up_to_date"), null],
    ["updated a moment ago", view("up_to_date", { version: "0.7.0", lastUpdate: updated(ago(0)) }), "Attache updated to 0.7.0 · What changed"],
    ["updated 23 hours ago", view("up_to_date", { version: "0.7.0", lastUpdate: updated(ago(23 * HOUR)) }), "Attache updated to 0.7.0 · What changed"],
    ["updated exactly one day ago: gone", view("up_to_date", { version: "0.7.0", lastUpdate: updated(ago(UPDATED_LINE_MS)) }), null],
    ["updated two days ago", view("up_to_date", { version: "0.7.0", lastUpdate: updated(ago(48 * HOUR)) }), null],
    ["updated, while Updates are Off", view("off", { mode: "off", version: "0.7.0", lastUpdate: updated(ago(HOUR)) }), "Attache updated to 0.7.0 · What changed"],
    ["ready in Ask first", view("ready", { mode: "ask_first", update: UPDATE }), "Attache 0.7.0 is ready · Install"],
    ["waiting for 1 Job", view("waiting_for_jobs", { update: UPDATE, jobs: 1 }), "Attache 0.7.0 is waiting for 1 Job to finish · Restart now"],
    ["waiting for 2 Jobs", view("waiting_for_jobs", { update: UPDATE, jobs: 2 }), "Attache 0.7.0 is waiting for 2 Jobs to finish · Restart now"],
    ["installing", view("installing", { update: UPDATE }), "Installing Attache 0.7.0"],
    ["rolled back an hour ago", view("up_to_date", { lastUpdate: rolledBack(ago(HOUR)) }), "The Update to 0.7.0 failed, so Attache went back to 0.6.1 · Details"],
    ["rolled back two days ago", view("up_to_date", { lastUpdate: rolledBack(ago(48 * HOUR)) }), null],
    // An installer that changed nothing is told in Settings only: the Machine runs as it did.
    ["an Update that did not install", view("up_to_date", { lastUpdate: failed(ago(HOUR)) }), null],
    // Found by a report-only check: nothing waits for the owner yet, and Settings offers Install now.
    ["available after a report-only check", view("available", { update: UPDATE }), null],
    ["downloading", view("downloading", { update: UPDATE }), null],
    ["a failed check", view("check_failed", { reason: "The release server did not answer." }), null],
    ["unavailable", view("unavailable", { reason: "Attache runs from a source checkout here." }), null],
  ];
  it.each(cases)("%s", (_name, v, shown) => {
    expect(read(updateLine({ updates: v, now: NOW }))).toBe(shown);
  });
});

describe("updateLine: what waits for the owner now comes before news of the last Update", () => {
  const cases: ReadonlyArray<[name: string, v: UpdatesView, shown: string]> = [
    ["ready, after an Update yesterday", view("ready", { mode: "ask_first", version: "0.7.0", update: { ...UPDATE, version: "0.7.1" }, lastUpdate: updated(ago(HOUR)) }), "Attache 0.7.1 is ready · Install"],
    ["waiting for Jobs, after a rollback", view("waiting_for_jobs", { update: { ...UPDATE, version: "0.7.1" }, jobs: 2, lastUpdate: rolledBack(ago(HOUR)) }), "Attache 0.7.1 is waiting for 2 Jobs to finish · Restart now"],
    ["installing, after a rollback", view("installing", { update: { ...UPDATE, version: "0.7.1" }, lastUpdate: rolledBack(ago(HOUR)) }), "Installing Attache 0.7.1"],
  ];
  it.each(cases)("%s", (_name, v, shown) => {
    expect(read(updateLine({ updates: v, now: NOW }))).toBe(shown);
  });
});

describe("updateLine: what each line carries", () => {
  it("What changed carries the release notes from the signed manifest, and the version they belong to", () => {
    const line = updateLine({ updates: view("up_to_date", { version: "0.7.0", lastUpdate: updated(ago(HOUR)) }), now: NOW });
    expect(line).toMatchObject({ state: "updated", tone: "plain", action: { kind: "what_changed", version: "0.7.0", notes: "### Fixed\n\n- Faster search.\n" } });
  });
  it("a rollback reads as a failure; every other line as plain news", () => {
    expect(updateLine({ updates: view("up_to_date", { lastUpdate: rolledBack(ago(HOUR)) }), now: NOW })).toMatchObject({ state: "rolled_back", tone: "danger", action: { kind: "details" } });
    expect(updateLine({ updates: view("ready", { update: UPDATE }), now: NOW })).toMatchObject({ state: "ready", tone: "plain", action: { kind: "install" } });
    expect(updateLine({ updates: view("waiting_for_jobs", { update: UPDATE, jobs: 1 }), now: NOW })).toMatchObject({ state: "waiting_for_jobs", tone: "plain", action: { kind: "restart" } });
    expect(updateLine({ updates: view("installing", { update: UPDATE }), now: NOW })).toMatchObject({ state: "installing", tone: "plain", action: null });
  });
  it("a line's key changes only when what it says does, so a refresh is not read out again", () => {
    const a = updateLine({ updates: view("waiting_for_jobs", { update: UPDATE, jobs: 2 }), now: NOW });
    const b = updateLine({ updates: view("waiting_for_jobs", { update: UPDATE, jobs: 2, lastCheckedAt: ago(0) }), now: NOW + HOUR });
    const c = updateLine({ updates: view("waiting_for_jobs", { update: UPDATE, jobs: 1 }), now: NOW });
    expect(a!.key).toBe(b!.key);
    expect(a!.key).not.toBe(c!.key);
  });
});
