import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTestService, type TestService } from "./harness.ts";

let svc: TestService;

/** A calendar day `days` from today, as the Brain writes dates. */
const dayFromToday = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const TODAY = dayFromToday(0);
const IN_A_MONTH = dayFromToday(30);

const REL = "memory/projects/orion-rollout.md";

interface Item {
  id: string;
  key: string;
  kind: string;
  title: string;
  summary: string;
  state: string;
  changedSinceDecision: boolean;
  evidence: Array<{ relPath?: string; lines?: number[] }>;
}

/** A hand edit to a note in the Brain, indexed as the folder watcher would. */
function writeNote(rel: string, facts: string[]) {
  writeFileSync(join(svc.dataDir, rel), ["---", "type: project", "title: Orion rollout", "---", "# Orion rollout", "", "## Current State", ...facts, ""].join("\n"));
  svc.app.memory.indexer.indexFile(svc.app.memory.rootRef!, rel);
}

function editNote(rel: string, from: string, to: string) {
  const file = join(svc.dataDir, rel);
  writeFileSync(file, readFileSync(file, "utf8").replace(from, to));
  svc.app.memory.indexer.indexFile(svc.app.memory.rootRef!, rel);
}

/** "Refresh now" on the data folder, the Source refresh that reads the Brain. */
async function refresh() {
  const { job } = await svc.post("/connections/vault-data/sync", {});
  const done = await svc.waitJob(job.id);
  expect(done.job.status).toBe("succeeded");
}

async function reviewItems(states = ["open", "dismissed", "snoozed", "resolved"]): Promise<Item[]> {
  const items = (await svc.get(`/attention?state=${states.join(",")}`)).items as Item[];
  return items.filter((i) => i.kind === "fact-review");
}

const itemFor = async (subject: string) => (await reviewItems()).find((i) => i.title.includes(`“${subject}”`));

beforeAll(async () => {
  svc = await startTestService();
  writeNote(REL, [
    "- **Status** (2026-01-10, review 2026-02-01): Pilot runs in Oslo — source: (user: kickoff, observed 2026-01-10)",
    "- **Budget** (2026-01-10, review 2026-03-01): 90k EUR",
    `- **Owner** (2026-01-10, review ${TODAY}): Ingrid`,
    `- **Launch** (2026-01-10, review ${IN_A_MONTH}): Planned for spring`,
    "- **Repository** (2025-01-10): acme/orion",
  ]);
});
afterAll(async () => {
  await svc?.stop();
});

describe("a fact past its Review date in the inbox", () => {
  it("raises one item per overdue fact, naming the note and the fact", async () => {
    await refresh();
    await refresh();
    const items = await reviewItems();
    expect(items.map((i) => i.title).sort()).toEqual(["Review date passed: “Budget” in Orion rollout", "Review date passed: “Status” in Orion rollout"]);
    const status = items.find((i) => i.title.includes("“Status”"))!;
    expect(status.state).toBe("open");
    expect(status.summary).toContain("Pilot runs in Oslo");
    expect(status.summary).toContain(REL);
    expect(status.summary).toContain("2026-02-01");
    expect(status.evidence[0]).toMatchObject({ relPath: REL, lines: [8, 8] });
  });

  it("raises nothing for a fact without a Review date, or one whose Review date is today or later", async () => {
    for (const subject of ["Owner", "Launch", "Repository"]) expect(await itemFor(subject)).toBeUndefined();
  });

  it("is listed in the briefing as a fact to check", async () => {
    const { job } = await svc.post("/briefings", { kind: "manual" });
    expect((await svc.waitJob(job.id)).job.status).toBe("succeeded");
    const { briefing } = await svc.get("/briefings/latest");
    const section = briefing.sections.find((s: { title: string }) => s.title === "Facts to check");
    expect(section.items.map((i: { title: string }) => i.title).sort()).toEqual(["Review date passed: “Budget” in Orion rollout", "Review date passed: “Status” in Orion rollout"]);
    expect(briefing.summary).toContain("2 facts to check");
  });

  it("keeps a dismissed item dismissed until the fact changes", async () => {
    const status = (await itemFor("Status"))!;
    await svc.post(`/attention/${status.id}/decision`, { decision: "dismiss" });
    await refresh();
    expect((await itemFor("Status"))!.state).toBe("dismissed");

    editNote(REL, "Pilot runs in Oslo", "Pilot runs in Bergen");
    await refresh();
    const reopened = (await itemFor("Status"))!;
    expect(reopened).toMatchObject({ id: status.id, state: "open", changedSinceDecision: true });
    expect(reopened.summary).toContain("Pilot runs in Bergen");
  });

  it("keeps a dismissed item dismissed until its Review date changes", async () => {
    const budget = (await itemFor("Budget"))!;
    await svc.post(`/attention/${budget.id}/decision`, { decision: "dismiss" });
    await refresh();
    expect((await itemFor("Budget"))!.state).toBe("dismissed");

    editNote(REL, "review 2026-03-01", "review 2026-04-01");
    await refresh();
    expect((await itemFor("Budget"))!).toMatchObject({ id: budget.id, state: "open", changedSinceDecision: true });
  });

  it("is resolved by correcting the fact", async () => {
    await svc.post("/memory/save", { items: [{ action: "update", path: REL, facts: [{ subject: "Status", value: "Pilot moved to Trondheim", reason: "venue change" }] }] });
    await refresh();
    expect((await itemFor("Status"))!.state).toBe("resolved");
  });

  it("is resolved by setting a later Review date", async () => {
    await svc.post("/memory/save", { items: [{ action: "update", path: REL, facts: [{ subject: "Budget", value: "90k EUR", reason: "checked with finance", review: IN_A_MONTH }] }] });
    await refresh();
    expect((await itemFor("Budget"))!.state).toBe("resolved");
  });
});

describe("the audit's stale flag", () => {
  const AUDIT_REL = "memory/projects/vela-audit.md";
  beforeAll(() => {
    writeFileSync(
      join(svc.dataDir, AUDIT_REL),
      [
        "---",
        "type: project",
        "title: Vela audit",
        "---",
        "# Vela audit",
        "",
        "## Current State",
        "- **Status** (2026-01-10, review 2026-02-01): Vela pilot runs",
        `- **Owner** (2026-01-10, review ${TODAY}): Vela owner is Ada`,
        `- **Budget** (2026-01-10, review ${IN_A_MONTH}): Vela budget is 10k EUR`,
        "- **Repository** (2024-01-10): acme/vela",
        "",
      ].join("\n"),
    );
    svc.app.memory.indexer.indexFile(svc.app.memory.rootRef!, AUDIT_REL);
  });

  it("flags a fact as stale only when it is past its Review date", async () => {
    const audit = await svc.get("/memory/audit");
    const entries = audit.findings.find((f: { relPath: string }) => f.relPath === AUDIT_REL).entries as Array<{ subject: string; flags: string[] }>;
    const stale = (subject: string) => entries.find((e) => e.subject === subject)!.flags.includes("stale");
    expect(stale("Status")).toBe(true);
    expect(stale("Owner")).toBe(false);
    expect(stale("Budget")).toBe(false);
    // Two years old, but without a Review date: never stale.
    expect(stale("Repository")).toBe(false);
  });

  it("has no day threshold left", async () => {
    const audit = await svc.get("/memory/audit?staleDays=1");
    expect(audit).not.toHaveProperty("staleDays");
    const entries = audit.findings.find((f: { relPath: string }) => f.relPath === AUDIT_REL).entries as Array<{ subject: string; flags: string[] }>;
    expect(entries.find((e) => e.subject === "Repository")!.flags).not.toContain("stale");
  });
});
