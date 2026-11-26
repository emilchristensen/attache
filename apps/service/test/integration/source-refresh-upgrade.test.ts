import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { databaseBefore } from "../fixtures/old-database.ts";
import { startTestService, type TestService } from "./harness.ts";

const running: TestService[] = [];
afterAll(async () => {
  for (const s of running) await s.stop().catch(() => {});
});

/** A state folder as an install left it while Source refresh was stored as "sync": its interval, a scheduled run and a refresh of one connection. */
function syncEraState(): { stateDir: string; dataDir: string } {
  const stateDir = mkdtempSync(join(tmpdir(), "attache-it-sync-state-"));
  const dataDir = join(mkdtempSync(join(tmpdir(), "attache-it-sync-data-")), "data");
  mkdirSync(dataDir, { recursive: true });
  const now = new Date().toISOString();
  // The schema before Source refresh had its own name: every migration up to the one that renames it.
  const db = databaseBefore(join(stateDir, "attache.sqlite"), /source-refresh/);
  const config = { schemaVersion: 1, setupCompleted: true, setupStep: 4, dataFolder: dataDir, schedules: { syncEveryMinutes: 45, briefingAt: "07:30", briefingEnabled: true } };
  db.prepare("insert into config (id, json, revision, updated_at) values (1, ?, 1, ?)").run(JSON.stringify(config), now);
  db.prepare("insert into jobs (id, kind, title, status, input, capability, created_at, updated_at, finished_at) values ('j1', 'sync', 'Refresh sources (scheduled)', 'succeeded', '{\"all\":true}', 'attention', ?, ?, ?)").run(now, now, now);
  db.prepare("insert into schedules (id, capability, job_kind, every_minutes, enabled, next_run_at, last_run_at, last_job_id) values ('attention:sync', 'attention', 'sync', 45, 1, ?, ?, 'j1')").run(now, now);
  db.close();
  return { stateDir, dataDir };
}

describe("an upgrade from when Source refresh was stored as sync", () => {
  it("keeps the owner's refresh interval, the past refreshes and the schedule's last run, under the Source refresh name", async () => {
    const { stateDir, dataDir } = syncEraState();
    const svc = await startTestService({ stateDir, dataDir, setup: false });
    running.push(svc);

    const cfg = await svc.get("/config");
    expect(cfg.config.schedules).toEqual({ refreshEveryMinutes: 45, briefingAt: "07:30", briefingEnabled: true });

    const jobs = await svc.get("/jobs");
    expect(jobs.find((j: { id: string }) => j.id === "j1")).toMatchObject({ kind: "source-refresh", status: "succeeded" });

    const schedules = (await svc.get("/schedules")) as Array<{ id: string; jobKind: string; everyMinutes: number | null; lastJobId: string | null }>;
    expect(schedules.map((s) => s.id)).not.toContain("attention:sync");
    expect(schedules.find((s) => s.id === "attention:source-refresh")).toMatchObject({ jobKind: "source-refresh", everyMinutes: 45, lastJobId: "j1" });
  });
});
