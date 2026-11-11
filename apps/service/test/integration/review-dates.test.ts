import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTestService, type TestService } from "./harness.ts";

let svc: TestService;

/** A calendar day `days` from today, as the Brain writes dates. */
const dayFromToday = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const TODAY = dayFromToday(0);
const IN_A_MONTH = dayFromToday(30);
const IN_TWO_MONTHS = dayFromToday(60);

const brainFile = (rel: string) => readFileSync(join(svc.dataDir, rel), "utf8");
const lineOf = (text: string, needle: string) => text.split("\n").find((l) => l.includes(needle));
const docState = async (rel: string) => (await svc.get(`/memory/document?path=${encodeURIComponent(rel)}`)).state as Array<{ subject: string; date: string; value: string; review?: string; unverified: boolean }>;

beforeAll(async () => {
  svc = await startTestService();
});
afterAll(async () => {
  await svc?.stop();
});

describe("a fact with a Review date", () => {
  it("is written after the fact's own date and read back with it", async () => {
    await svc.post("/memory/save", {
      items: [{ action: "create", type: "project", title: "Vega launch", facts: [{ subject: "Status", value: "Beta opens to customers", review: IN_A_MONTH }, { subject: "Owner", value: "Ada" }] }],
    });
    const note = brainFile("memory/projects/vega-launch.md");
    expect(lineOf(note, "Beta opens")).toMatch(new RegExp(`^- \\*\\*Status\\*\\* \\(${TODAY}, review ${IN_A_MONTH}\\): Beta opens to customers`));
    // A fact without one keeps the plain form.
    expect(lineOf(note, "Ada")).toMatch(new RegExp(`^- \\*\\*Owner\\*\\* \\(${TODAY}\\): Ada`));
    const state = await docState("memory/projects/vega-launch.md");
    expect(state.map((s) => [s.subject, s.value, s.review ?? null, s.unverified])).toEqual([
      ["Status", "Beta opens to customers", IN_A_MONTH, false],
      ["Owner", "Ada", null, false],
    ]);
  });

  it("is refused when it is not after the fact's own date or not a real day, writing nothing", async () => {
    for (const review of [TODAY, dayFromToday(-3)]) {
      const r = await svc.call("POST", "/memory/save", { items: [{ action: "create", type: "note", title: `Too early ${review}`, facts: [{ subject: "Plan", value: "x", review }] }] });
      expect(r.status).toBe(400);
      expect(r.body.error.message).toContain(`Review date ${review}`);
    }
    for (const review of ["2026-02-30", "next week"]) {
      const r = await svc.call("POST", "/memory/save", { items: [{ action: "update", path: "memory/projects/vega-launch.md", facts: [{ subject: "Owner", value: "Grace", reason: "handover", review }] }] });
      expect(r.status).toBe(400);
    }
    expect(lineOf(brainFile("memory/projects/vega-launch.md"), "**Owner**")).toContain("Ada");
  });

  it("is cleared by a correction that gives none, and replaced by one that gives a new one", async () => {
    const rel = "memory/projects/vega-launch.md";
    await svc.post("/memory/save", { items: [{ action: "update", path: rel, facts: [{ subject: "Status", value: "Beta extended by two weeks", reason: "feedback backlog" }] }] });
    let note = brainFile(rel);
    expect(lineOf(note, "Beta extended")).toMatch(new RegExp(`^- \\*\\*Status\\*\\* \\(${TODAY}\\): Beta extended`));
    // History keeps the old value with the Review date it had.
    expect(lineOf(note, 'was "Beta opens to customers"')).toContain(`(dated ${TODAY}, review ${IN_A_MONTH})`);
    expect((await docState(rel)).find((s) => s.subject === "Status")?.review).toBeUndefined();

    await svc.post("/memory/save", { items: [{ action: "update", path: rel, facts: [{ subject: "Status", value: "General availability planned", reason: "beta closed", review: IN_TWO_MONTHS }] }] });
    note = brainFile(rel);
    expect(lineOf(note, "General availability")).toContain(`(${TODAY}, review ${IN_TWO_MONTHS}): General availability planned`);
  });
});

describe("a note edited by hand with a Review date", () => {
  const rel = "memory/projects/lyra-rollout.md";
  beforeAll(() => {
    writeFileSync(
      join(svc.dataDir, rel),
      [
        "---",
        "type: project",
        "title: Lyra rollout",
        "---",
        "# Lyra rollout",
        "",
        "## Current State",
        "- **Status** (2026-01-10, review 2026-02-01): Lyra pilot runs in Oslo — source: (user: kickoff, observed 2026-01-10)",
        `- **Budget** (2026-01-10,  Review: ${IN_A_MONTH}): Lyra budget is 90k EUR`,
        "- **Sponsor** (2026-01-10): Lyra sponsor is Ingrid",
        "",
      ].join("\n"),
    );
    svc.app.memory.indexer.indexFile(svc.app.memory.rootRef!, rel);
  });

  it("is read with its Review dates, and marks a fact past its Review date as unverified", async () => {
    const state = await docState(rel);
    expect(state.map((s) => [s.subject, s.value, s.review ?? null, s.unverified])).toEqual([
      ["Status", "Lyra pilot runs in Oslo", "2026-02-01", true],
      ["Budget", "Lyra budget is 90k EUR", IN_A_MONTH, false],
      ["Sponsor", "Lyra sponsor is Ingrid", null, false],
    ]);
  });

  it("is marked unverified in search results, and only the fact that is past its Review date", async () => {
    const { hits } = await svc.get(`/memory/search?q=${encodeURIComponent("Lyra")}&limit=10`);
    const fact = (subject: string) => hits.find((h: { relPath: string; text: string }) => h.relPath === rel && h.text.includes(`**${subject}**`));
    expect(fact("Status")).toMatchObject({ review: "2026-02-01", unverified: true });
    expect(fact("Budget")).toMatchObject({ review: IN_A_MONTH, unverified: false });
    expect(fact("Sponsor")).toMatchObject({ review: null, unverified: false });
    // The Review date is not something a search matches on.
    expect((await svc.get(`/memory/search?q=review`)).hits.filter((h: { relPath: string }) => h.relPath === rel)).toEqual([]);
  });

  it("is marked unverified by the terminal search a session context points to", () => {
    const run = (...args: string[]) => execFileSync(process.execPath, [join(import.meta.dirname, "../../src/main.ts"), "search", "Lyra", ...args, "--state-dir", svc.stateDir], { encoding: "utf8" });
    const hits = JSON.parse(run("--json")) as Array<{ lines: number[]; review: string | null; unverified: boolean }>;
    expect(hits.find((h) => h.lines[0] === 8)).toMatchObject({ review: "2026-02-01", unverified: true });
    const text = run().split("\n");
    expect(text.find((l) => l.includes("lyra-rollout.md:8-8"))).toContain("(unverified: Review date 2026-02-01 passed)");
    expect(text.find((l) => l.includes("lyra-rollout.md:9-9"))).not.toContain("unverified");
  });

  it("gives the audit each fact's Review date", async () => {
    const audit = await svc.get("/memory/audit");
    const entries = audit.findings.find((f: { relPath: string }) => f.relPath === rel).entries;
    expect(entries.map((e: { subject: string; review: string | null; date: string }) => [e.subject, e.date, e.review])).toEqual([
      ["Status", "2026-01-10", "2026-02-01"],
      ["Budget", "2026-01-10", IN_A_MONTH],
      ["Sponsor", "2026-01-10", null],
    ]);
  });
});

describe("reverting a change to a fact with a Review date", () => {
  const rel = "memory/projects/draco-upgrade.md";
  const statusChange = async (value: string) => {
    const { changes } = await svc.get("/memory/recent-changes?limit=50");
    return changes.find((c: { relPath: string; subject: string | null; newValue: string | null }) => c.relPath === rel && c.subject === "Status" && c.newValue === value);
  };
  beforeAll(async () => {
    await svc.post("/memory/save", { items: [{ action: "create", type: "project", title: "Draco upgrade", facts: [{ subject: "Status", value: "Waiting for the vendor", review: IN_A_MONTH }] }] });
  });

  it("brings back the old value with the Review date it had", async () => {
    await svc.post("/memory/save", { items: [{ action: "update", path: rel, facts: [{ subject: "Status", value: "Vendor delivered", reason: "delivery arrived" }] }] });
    const change = await statusChange("Vendor delivered");
    expect(change).toMatchObject({ oldValue: "Waiting for the vendor", oldReview: IN_A_MONTH, newReview: null });
    await svc.post(`/memory/changes/${change.id}/revert`);
    expect(lineOf(brainFile(rel), "**Status**")).toContain(`, review ${IN_A_MONTH}): Waiting for the vendor`);
  });

  it("puts back the Review date the value had before, and refuses once the Review date was edited by hand", async () => {
    await svc.post("/memory/save", { items: [{ action: "update", path: rel, facts: [{ subject: "Status", value: "Upgrade scheduled", reason: "date agreed", review: IN_TWO_MONTHS }] }] });
    const scheduled = await statusChange("Upgrade scheduled");
    expect(scheduled).toMatchObject({ newReview: IN_TWO_MONTHS, revert: { allowed: true } });

    const file = join(svc.dataDir, rel);
    writeFileSync(file, brainFile(rel).replace(`review ${IN_TWO_MONTHS}`, `review ${IN_A_MONTH}`));
    svc.app.memory.indexer.indexFile(svc.app.memory.rootRef!, rel);
    expect((await statusChange("Upgrade scheduled")).revert).toMatchObject({ allowed: false, reason: expect.stringContaining("edited outside Jarvis") });

    writeFileSync(file, brainFile(rel).replace(`review ${IN_A_MONTH}`, `review ${IN_TWO_MONTHS}`));
    await svc.post(`/memory/changes/${scheduled.id}/revert`);
    // Back to the value before, with the Review date that value had.
    expect(lineOf(brainFile(rel), "**Status**")).toContain(`, review ${IN_A_MONTH}): Waiting for the vendor`);
  });
});

describe("a Proposal with a Review date", () => {
  it("carries the Review date per fact and writes it when the owner applies it", async () => {
    const proposal = await svc.post("/memory/proposals", {
      item: { action: "create", type: "project", title: "Cygnus pilot", facts: [{ subject: "Status", value: "Pilot starts in January", review: IN_A_MONTH }, { subject: "Owner", value: "Bao" }] },
      reason: "Heard in the planning call",
    });
    expect(proposal.item.facts).toEqual([{ subject: "Status", value: "Pilot starts in January", review: IN_A_MONTH }, { subject: "Owner", value: "Bao" }]);
    const listed = (await svc.get("/memory/proposals?status=proposed")).proposals.find((p: { id: string }) => p.id === proposal.id);
    expect(listed.item.facts[0].review).toBe(IN_A_MONTH);

    const applied = await svc.post(`/memory/proposals/${proposal.id}/apply`);
    const note = brainFile(applied.target);
    expect(lineOf(note, "Pilot starts")).toContain(`(${TODAY}, review ${IN_A_MONTH}): Pilot starts in January`);
    expect(lineOf(note, "**Owner**")).toContain(`(${TODAY}): Bao`);
  });

  it("is refused when its Review date is not after today, like a save", async () => {
    const r = await svc.call("POST", "/memory/proposals", {
      item: { action: "update", path: "memory/projects/vega-launch.md", facts: [{ subject: "Owner", value: "Grace", reason: "handover", review: TODAY }] },
      reason: "x",
    });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain("Review date");
  });
});

