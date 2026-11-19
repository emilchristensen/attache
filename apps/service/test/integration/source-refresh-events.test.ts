import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SOURCE_REFRESH_EVENT } from "@attache/contracts";
import { startTestService, type TestService } from "./harness.ts";

let svc: TestService;

beforeAll(async () => {
  svc = await startTestService();
});
afterAll(async () => {
  await svc.stop();
});

/** Runs one Source refresh of the data folder and returns the live events it sent, in order. */
async function refresh(): Promise<Array<{ type: string; changed?: boolean }>> {
  const events: Array<{ type: string; changed?: boolean }> = [];
  const listen = (e: { type: string; changed?: boolean }) => events.push(e);
  svc.app.bus.on("event", listen);
  try {
    await svc.waitJob((await svc.post("/connections/vault-data/refresh")).job.id);
  } finally {
    svc.app.bus.off("event", listen);
  }
  return events.filter((e) => e.type === SOURCE_REFRESH_EVENT || e.type === "attention.changed");
}

describe("a Source refresh's live event", () => {
  it("says it finished, and whether it changed the Inbox itself, before the Inbox change that asks the count again", async () => {
    // A fact past its Review date: the refresh opens a Fact to check.
    mkdirSync(join(svc.dataDir, "memory/people"), { recursive: true });
    writeFileSync(join(svc.dataDir, "memory/people/nora-lind.md"), "# Nora Lind\n\n## Current state\n- **Role** (2026-01-01, review 2026-02-01): Client contact\n");
    const first = await refresh();
    expect(first.slice(-2)).toEqual([{ type: SOURCE_REFRESH_EVENT, changed: true }, { type: "attention.changed" }]);
    // Read again with nothing new: finished, and nothing changed by the refresh itself.
    const second = await refresh();
    expect(second.slice(-2)).toEqual([{ type: SOURCE_REFRESH_EVENT, changed: false }, { type: "attention.changed" }]);
  });

  it("says nothing changed when the refresh resolves one item and opens another: the decision count is the same", async () => {
    // Role is due for review, on its own (this test does not lean on the one before it).
    mkdirSync(join(svc.dataDir, "memory/people"), { recursive: true });
    writeFileSync(join(svc.dataDir, "memory/people/nora-lind.md"), "# Nora Lind\n\n## Current state\n- **Role** (2026-01-01, review 2026-02-01): Client contact\n");
    await refresh();
    // Role is checked again (its item resolves) while Office comes due for review (a new item opens).
    writeFileSync(join(svc.dataDir, "memory/people/nora-lind.md"), "# Nora Lind\n\n## Current state\n- **Role** (2026-01-01, review 2099-02-01): Client contact\n- **Office** (2026-01-01, review 2026-02-01): Copenhagen\n");
    const events = await refresh();
    expect(events.slice(-2)).toEqual([{ type: SOURCE_REFRESH_EVENT, changed: false }, { type: "attention.changed" }]);
    const open = (await svc.get("/attention?state=open")).items.filter((i: { kind: string }) => i.kind === "fact-review").map((i: { title: string }) => i.title);
    expect(open).toEqual([expect.stringContaining("Office")]);
  });
});
