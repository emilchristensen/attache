import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTestService, type TestService } from "./harness.ts";

let svc: TestService;

beforeAll(async () => {
  svc = await startTestService();
});
afterAll(async () => {
  await svc.stop();
});

async function hitPaths(q: string): Promise<string[]> {
  const r = await svc.get(`/memory/search?q=${encodeURIComponent(q)}`);
  return (r.hits as Array<{ relPath: string }>).map((h) => h.relPath);
}

async function eventually(q: string, expected: string[], timeoutMs = 8_000) {
  const end = Date.now() + timeoutMs;
  let last: string[] = [];
  while (Date.now() < end) {
    last = await hitPaths(q);
    if (JSON.stringify(last) === JSON.stringify(expected)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(last).toEqual(expected);
}

describe("edits made outside the service", () => {
  it("are searchable within seconds, at their current path, without a restart", async () => {
    const events: string[] = [];
    svc.app.bus.on("event", (ev: { type: string }) => events.push(ev.type));
    writeFileSync(join(svc.dataDir, "memory/notes/quokka.md"), "# Quokka plan\n\nThe quokka rollout starts in March.\n");
    await eventually("quokka", ["memory/notes/quokka.md"]);
    expect(events).toContain("memory.changed");

    mkdirSync(join(svc.dataDir, "memory/projects"), { recursive: true });
    renameSync(join(svc.dataDir, "memory/notes/quokka.md"), join(svc.dataDir, "memory/projects/quokka.md"));
    await eventually("quokka", ["memory/projects/quokka.md"]);
  });
});

describe("a Brain folder replaced by a file", () => {
  it("leaves the service running and still picking up edits once the folder is back", async () => {
    // A throw from inside the file watcher reaches no error handler; Vitest also fails the run on one.
    const uncaught: unknown[] = [];
    const record = (e: unknown) => uncaught.push(e);
    process.on("uncaughtException", record);
    try {
      const folder = join(svc.dataDir, "memory/decisions");
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "okapi.md"), "# Okapi\n\nThe okapi budget is frozen.\n");
      await eventually("okapi", ["memory/decisions/okapi.md"]);

      // What a file sync tool can do: the folder goes, and a file of the same name takes its place.
      rmSync(folder, { recursive: true });
      writeFileSync(folder, "");
      await eventually("okapi", []);

      rmSync(folder);
      mkdirSync(folder);
      writeFileSync(join(folder, "okapi-thaw.md"), "# Okapi thaw\n\nThe okapi budget thaws in May.\n");
      await eventually("okapi", ["memory/decisions/okapi-thaw.md"]);

      // Removed and made again at once, as a sync tool restoring it does: edits inside the new folder still count.
      rmSync(folder, { recursive: true });
      mkdirSync(folder);
      writeFileSync(join(folder, "okapi-review.md"), "# Okapi review\n\nThe okapi budget is reviewed in June.\n");
      await eventually("okapi", ["memory/decisions/okapi-review.md"]);
      writeFileSync(join(folder, "okapi-review.md"), "# Okapi review\n\nThe okapi budget review moved to July.\n");
      await eventually("july", ["memory/decisions/okapi-review.md"]);

      expect(await svc.get("/health")).toMatchObject({ ok: true });
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", record);
    }
  });
});
