import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databaseBefore } from "../fixtures/old-database.ts";
import { ManualClock } from "../fixtures/manual-clock.ts";
import { startTestService, type TestService } from "./harness.ts";
import { createRemote } from "./machines.ts";

const running: TestService[] = [];
afterAll(async () => {
  for (const s of running) await s.stop().catch(() => {});
});

const hour = 3_600_000;

/** A state folder whose inbox was made before it replicated: items in each state, with their decision log. */
function stateFromBefore(): { stateDir: string; dataDir: string; until: string } {
  const stateDir = mkdtempSync(join(tmpdir(), "attache-it-inbox-state-"));
  const dataDir = join(mkdtempSync(join(tmpdir(), "attache-it-inbox-data-")), "data");
  mkdirSync(dataDir, { recursive: true });
  const now = new Date();
  const at = (ms: number) => new Date(now.getTime() + ms).toISOString();
  const until = at(48 * hour);
  // Every migration before the inbox kept its decisions apart: the schema an install had until then.
  const db = databaseBefore(join(stateDir, "attache.sqlite"), /alter table attention_items add column resolved_at/);
  const config = { schemaVersion: 1, setupCompleted: true, setupStep: 4, dataFolder: dataDir, features: {} };
  db.prepare("insert into config (id, json, revision, updated_at) values (1, ?, 1, ?)").run(JSON.stringify(config), at(0));
  const item = db.prepare(
    `insert into attention_items (id, item_key, fingerprint, kind, title, summary, why, source_kind, connection_id, evidence, priority, state, snooze_until, decided_fingerprint, first_seen_at, updated_at)
     values (?, ?, ?, 'deadline', ?, '', null, 'vault', 'vault-data', '[]', 50, ?, ?, ?, ?, ?)`,
  );
  const decision = db.prepare("insert into attention_decisions (item_key, fingerprint, decision, until, at, actor) values (?, ?, ?, ?, ?, 'dashboard')");
  item.run("i-open", "k-open", "f1", "Renew the passport", "open", null, null, at(-5 * hour), at(-5 * hour));
  item.run("i-dismissed", "k-dismissed", "f1", "Call the plumber", "dismissed", null, "f1", at(-5 * hour), at(-4 * hour));
  decision.run("k-dismissed", "f1", "dismiss", null, at(-4 * hour));
  item.run("i-snoozed", "k-snoozed", "f1", "Pay the invoice", "snoozed", until, "f1", at(-5 * hour), at(-3 * hour));
  decision.run("k-snoozed", "f1", "snooze", until, at(-3 * hour));
  item.run("i-done", "k-done", "f1", "Book flights", "resolved", null, "f1", at(-5 * hour), at(-2 * hour));
  decision.run("k-done", "f1", "done", null, at(-2 * hour));
  item.run("i-gone", "k-gone", "f1", "Reply to Anna", "resolved", null, null, at(-5 * hour), at(-1 * hour));
  // An old dismissal whose evidence changed since: open again, marked as changed.
  item.run("i-changed", "k-changed", "f2", "Water the plants", "open", null, "f1", at(-5 * hour), at(-1 * hour));
  decision.run("k-changed", "f1", "dismiss", null, at(-4 * hour));
  // Done, then its evidence changed and changed back: the release before set the state to open on
  // any change, so the row says open while the decision is done on the evidence it has now (#60).
  item.run("i-bounced", "k-bounced", "f1", "Review the pull request", "open", null, "f1", at(-5 * hour), at(-1 * hour));
  decision.run("k-bounced", "f1", "done", null, at(-3 * hour));
  db.close();
  return { stateDir, dataDir, until };
}

async function states(svc: TestService): Promise<Record<string, { state: string; changedSinceDecision: boolean; id: string }>> {
  const items = (await svc.get("/attention?state=open,dismissed,snoozed,resolved")).items as Array<{ id: string; title: string; state: string; changedSinceDecision: boolean }>;
  return Object.fromEntries(items.map((i) => [i.title, { id: i.id, state: i.state, changedSinceDecision: i.changedSinceDecision }]));
}

const EXPECTED = {
  "Renew the passport": { id: "i-open", state: "open", changedSinceDecision: false },
  "Call the plumber": { id: "i-dismissed", state: "dismissed", changedSinceDecision: false },
  "Pay the invoice": { id: "i-snoozed", state: "snoozed", changedSinceDecision: false },
  "Book flights": { id: "i-done", state: "resolved", changedSinceDecision: false },
  "Reply to Anna": { id: "i-gone", state: "resolved", changedSinceDecision: false },
  "Water the plants": { id: "i-changed", state: "open", changedSinceDecision: true },
  "Review the pull request": { id: "i-bounced", state: "resolved", changedSinceDecision: false },
};

describe("inbox items and decisions from before the inbox replicated", () => {
  it("are carried over into the Brain and reach a Machine that joins", async () => {
    const before = stateFromBefore();
    const mac = await startTestService({ stateDir: before.stateDir, dataDir: before.dataDir, clock: new ManualClock() });
    running.push(mac);
    expect(await states(mac)).toEqual(EXPECTED);
    expect(readdirSync(join(before.dataDir, "review/inbox"))).toHaveLength(7);

    const remote = createRemote();
    await mac.post("/replication/setup", { remote: remote.url });
    expect(remote.git("ls-tree", "-r", "--name-only", "main").split("\n").filter((p) => p.startsWith("review/inbox/"))).toHaveLength(7);

    const pc = await startTestService({ clock: new ManualClock(), setup: false });
    running.push(pc);
    await pc.post("/replication/join", { remote: remote.url, path: pc.dataDir });
    await pc.post("/setup/complete");
    expect(await states(pc)).toEqual(EXPECTED);
    expect((await pc.get("/attention?state=snoozed")).items[0].snoozeUntil).toBe(before.until);
  });

  it("show the state their records give even when the data folder does not open (#60)", async () => {
    const before = stateFromBefore();
    // A data folder on a drive that is not there: the inbox still shows what the database holds.
    rmSync(before.dataDir, { recursive: true });
    const mac = await startTestService({ stateDir: before.stateDir, dataDir: before.dataDir, clock: new ManualClock(), setup: false });
    running.push(mac);
    expect(await states(mac)).toEqual(EXPECTED);
  });
});
