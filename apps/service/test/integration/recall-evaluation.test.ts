import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestService, type TestService } from "./harness.ts";
import { startFixtureServer, type FixtureServer } from "../fixtures/fixture-server.ts";
import { installFixtureMeaningModel } from "../fixtures/fixture-meaning-model.ts";

const MAIN = join(import.meta.dirname, "../../src/main.ts");
const SYNTHETIC_BRAIN = join(import.meta.dirname, "../fixtures/recall-brain");

let svc: TestService;
let scratch: string;

/** The `jarvis` executable, pinned to the test service's state folder. Asynchronous, because the service runs in this process. */
function jarvis(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDECODE|CLAUDE_SESSION_ID|CLAUDE_CODE_|CODEX_|ANTIGRAVITY_)/.test(k)));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN, ...args, "--state-dir", svc.stateDir], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end();
  });
}

async function evaluate(args: string[] = []) {
  const r = await jarvis(["evaluate-recall", "--json", ...args]);
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout);
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "jarvis-recall-eval-"));
  const brain = join(scratch, "brain");
  cpSync(SYNTHETIC_BRAIN, brain, { recursive: true });
  svc = await startTestService({ dataDir: brain });
});
afterAll(async () => {
  await svc?.stop();
});

/**
 * Keyword search on the synthetic set, measured before meaning-based search.
 * A search change may raise these, never lower them; raise them when it does.
 */
const BASELINE = { top1: 16, top3: 18 };
/** The synthetic set with meaning-based search, on the fixture meaning model. Raise it when a search change does. */
const MEANING_BASELINE = { top1: 19, top3: 20 };

function writeSet(name: string, content: unknown): string {
  const file = join(scratch, name);
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}

describe("recall evaluation against the synthetic Brain", () => {
  it("scores search with the question set kept in the Brain, no worse than the recorded baseline", async () => {
    const report = await evaluate();
    expect(report.set).toEqual({ source: "brain", path: "evaluation/recall-questions.json" });
    expect(report.questions).toBe(22);
    expect(report.invalid).toEqual([]);
    expect(report.top1).toBeGreaterThanOrEqual(BASELINE.top1);
    expect(report.top3).toBeGreaterThanOrEqual(BASELINE.top3);
    expect(report.top1Rate).toBeCloseTo(report.top1 / 22);
    expect(report.top3Rate).toBeCloseTo(report.top3 / 22);
    // Every question that is not answered first is listed, with at most the first three results.
    expect(report.misses).toHaveLength(22 - report.top1);
    for (const m of report.misses) {
      expect(m.rank).not.toBe(1);
      expect(m.returned.length).toBeLessThanOrEqual(3);
    }
  });

  it("lists each missed question with what was returned", async () => {
    const set = writeSet("miss.json", {
      questions: [
        { question: "ORION-412", note: "memory/projects/orion-migration.md", fact: "Ticket" },
        // Deliberately wrong: the Orion note answers this, not Mia's.
        { question: "Who owns the Orion migration?", note: "./memory/people/mia-jensen.md", fact: "role" },
      ],
    });
    const report = await evaluate(["--set", set]);
    expect(report.set).toEqual({ source: "supplied" });
    expect(report).toMatchObject({ questions: 2, top1: 1, top3: 1, top1Rate: 0.5, top3Rate: 0.5 });
    expect(report.misses).toHaveLength(1);
    const miss = report.misses[0];
    expect(miss).toMatchObject({ question: "Who owns the Orion migration?", note: "memory/people/mia-jensen.md", fact: "role", rank: null });
    expect(miss.returned[0]).toMatchObject({ root: "data", relPath: "memory/projects/orion-migration.md", title: "Orion migration", fact: "Owner", startLine: 14, endLine: 14 });
    expect(miss.returned[0].snippet).toContain("Ada Okafor");

    const text = await jarvis(["evaluate-recall", "--set", set]);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain("2 questions from the supplied set");
    expect(text.stdout).toContain("Ranked by keywords only: meaning-based search is not ready on this Machine");
    expect(text.stdout).toContain("First result: 1 of 2 (50%)");
    expect(text.stdout).toContain("In the first three: 1 of 2 (50%)");
    expect(text.stdout).toMatch(/Not found: Who owns the Orion migration\?\n  expected: memory\/people\/mia-jensen\.md · role\n  1\. memory\/projects\/orion-migration\.md:14-14 · Owner /);
  });

  it("does not score a question whose note or fact is not in the Brain, and says why", async () => {
    const set = writeSet("invalid.json", {
      questions: [
        { question: "ORION-412", note: "memory/projects/orion-migration.md", fact: "Ticket" },
        { question: "Who runs Apollo?", note: "memory/projects/apollo.md", fact: "Owner" },
        { question: "What is Mia's shoe size?", note: "memory/people/mia-jensen.md", fact: "Shoe size" },
      ],
    });
    const report = await evaluate(["--set", set]);
    expect(report).toMatchObject({ questions: 1, top1: 1, top3: 1, misses: [] });
    expect(report.invalid).toEqual([
      expect.objectContaining({ question: "Who runs Apollo?", problem: "The note memory/projects/apollo.md is not in the Brain." }),
      expect.objectContaining({ question: "What is Mia's shoe size?", problem: expect.stringMatching(/has no current fact "Shoe size"\. Its facts: Role, Review preference, Location, Birthday\./) }),
    ]);
    const text = await jarvis(["evaluate-recall", "--set", set]);
    expect(text.stdout).toMatch(/Not scored \(2\)[\s\S]*Who runs Apollo\?\n  The note memory\/projects\/apollo\.md is not in the Brain\./);
  });

  it("refuses a question set that is not valid, naming the problem", async () => {
    const notJson = await jarvis(["evaluate-recall", "--set", writeSet("broken.json", "{ questions: ")]);
    expect(notJson.status).toBe(1);
    expect(notJson.stderr).toMatch(/broken\.json is not valid JSON/);

    const badShape = await jarvis(["evaluate-recall", "--set", writeSet("shape.json", { questions: [{ question: "Where?", note: "../outside.md" }] })]);
    expect(badShape.status).toBe(1);
    expect(badShape.stderr).toMatch(/questions\.0\.note: must be a Markdown file's path inside the Brain/);
    expect(badShape.stderr).toMatch(/questions\.0\.fact/);

    const missing = await jarvis(["evaluate-recall", "--set", join(scratch, "nope.json")]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/Could not read the question set .*nope\.json/);
  });

  it("tells the owner where to keep a question set when the Brain has none", async () => {
    const kept = join(svc.dataDir, "evaluation/recall-questions.json");
    const aside = join(scratch, "aside.json");
    renameSync(kept, aside);
    try {
      const r = await jarvis(["evaluate-recall"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`This Brain has no recall question set. Write one to ${kept}`);
    } finally {
      renameSync(aside, kept);
    }
  });

  it("refuses the Brain's own set when it is not valid, naming the problem", async () => {
    const kept = join(svc.dataDir, "evaluation/recall-questions.json");
    const original = readFileSync(kept, "utf8");
    try {
      writeFileSync(kept, JSON.stringify({ questions: [{ question: "Where?", note: "memory/people/mia-jensen.md" }] }));
      const r = await jarvis(["evaluate-recall"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/evaluation\/recall-questions\.json is not a recall question set:\n  - questions\.0\.fact/);
    } finally {
      writeFileSync(kept, original);
    }
  });
});

describe("recall evaluation with meaning-based search", () => {
  let fx: FixtureServer;
  let ranked: TestService;

  beforeAll(async () => {
    fx = await startFixtureServer();
    const model = installFixtureMeaningModel(fx);
    const brain = join(mkdtempSync(join(tmpdir(), "jarvis-recall-meaning-")), "brain");
    cpSync(SYNTHETIC_BRAIN, brain, { recursive: true });
    ranked = await startTestService({ dataDir: brain, meaning: { model: model.description() } });
    await ranked.post("/memory/meaning/download");
    const end = Date.now() + 15_000;
    while ((await ranked.get("/memory/meaning")).state !== "ready") {
      if (Date.now() > end) throw new Error("meaning-based search never became ready");
      await new Promise((r) => setTimeout(r, 25));
    }
  });
  afterAll(async () => {
    await ranked?.stop();
    await fx?.close();
  });

  const evaluateOn = (service: TestService, questions?: unknown[]) => service.post("/memory/recall-evaluation", questions ? { set: { questions } } : {});

  it("finds the fact for a question worded unlike the note, and for a Danish question about an English note, which keywords alone miss", async () => {
    const questions = [
      { question: "What do we use for web statistics?", note: "memory/projects/website-relaunch.md", fact: "Analytics" },
      { question: "Hvornår holder vi morgenmøde?", note: "memory/notes/team-rituals.md", fact: "Standup" },
    ];
    const keywordsOnly = await evaluateOn(svc, questions);
    expect(keywordsOnly).toMatchObject({ ranking: "keywords", top1: 0 });
    const withMeaning = await evaluateOn(ranked, questions);
    expect(withMeaning).toMatchObject({ ranking: "meaning", questions: 2, top1: 2, top3: 2, misses: [] });
  });

  it("keeps exact lookups of ticket numbers, repositories and names first", async () => {
    const report = await evaluateOn(ranked, [
      { question: "ORION-412", note: "memory/projects/orion-migration.md", fact: "Ticket" },
      { question: "northwind/orion-infra", note: "memory/projects/orion-migration.md", fact: "Repository" },
      { question: "Lars Holm", note: "memory/people/ada-okafor.md", fact: "Manager" },
      { question: "Plausible", note: "memory/projects/website-relaunch.md", fact: "Analytics" },
    ]);
    expect(report).toMatchObject({ questions: 4, top1: 4, misses: [] });
  });

  it("scores the Brain's own set above keywords alone", async () => {
    const report = await evaluateOn(ranked);
    expect(report.ranking).toBe("meaning");
    expect(report.top1).toBeGreaterThanOrEqual(MEANING_BASELINE.top1);
    expect(report.top3).toBeGreaterThanOrEqual(MEANING_BASELINE.top3);
    expect(MEANING_BASELINE.top1).toBeGreaterThan(BASELINE.top1);
    expect(MEANING_BASELINE.top3).toBeGreaterThan(BASELINE.top3);
  });
});
