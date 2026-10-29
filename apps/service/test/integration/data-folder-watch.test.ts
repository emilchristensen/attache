import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
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
