import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import MarkdownIt from "markdown-it";
import { startTestService, type TestService } from "./harness.ts";

let svc: TestService;

/** How the Dashboard renders a research answer (apps/web/src/components/ui.tsx). */
const dashboard = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });

const NOTE = "memory/notes/ledger-cutover.md";

/**
 * The match sits just after a long code span, so a window of raw Markdown
 * starts inside it; a list, a link, emphasis and a fenced `## Heading` follow.
 */
const RUNBOOK = [
  "---",
  "type: note",
  "title: Ledger cutover runbook",
  "---",
  "",
  "Before the cutover, run `jarvis-ledger migrate --dry-run --from billing-v1 --to ledger-v2` on staging. The Quokkaflow check compares totals.",
  "",
  "- Freeze **invoice runs** at noon",
  "- Point the [billing dashboard](https://example.com/billing) at the _new_ ledger",
  "",
  "```markdown",
  "## Rollback",
  "Restore the billing-v1 snapshot and reopen invoice runs.",
  "```",
  "",
  "Finance signs off once the totals match for three days in a row, and the old exports are archived.",
  "",
].join("\n");

/** Characters the owner escaped, which are literal text in the note and must stay literal in a research answer. */
const LIMITS = "memory/notes/batch-limits.md";
const LIMITS_TEXT = "---\ntype: note\ntitle: Batch limits\n---\n\nThe Pelicanpost batch sends at most 500 \\*per\\* hour, with <1% bounces.\n";

interface Hit {
  relPath: string;
  title: string;
  snippet: string;
}

const search = async (q: string): Promise<Hit[]> => (await svc.get(`/memory/search?q=${encodeURIComponent(q)}`)).hits;

/** Markdown syntax a reader would see as literal characters, or that would restyle the words around it. */
const SYNTAX = /[`*_[\]#]|\]\(|https?:\/\/| - /;

beforeAll(async () => {
  svc = await startTestService();
  mkdirSync(dirname(join(svc.dataDir, NOTE)), { recursive: true });
  writeFileSync(join(svc.dataDir, NOTE), RUNBOOK);
  writeFileSync(join(svc.dataDir, LIMITS), LIMITS_TEXT);
  const { job } = await svc.post("/memory/reindex");
  expect((await svc.waitJob(job.id)).job.status).toBe("succeeded");
});
afterAll(() => svc.stop());

describe("search snippets are the plain words of the note", () => {
  it("drops code, list, link, emphasis and heading syntax and keeps the words around the match", async () => {
    const hit = (await search("Quokkaflow")).find((h) => h.relPath === NOTE);
    expect(hit, "the runbook is found").toBeTruthy();
    const { snippet } = hit!;
    expect(snippet).not.toMatch(SYNTAX);
    expect(snippet).toContain("--to ledger-v2 on staging. The Quokkaflow check compares totals.");
    expect(snippet).toContain("Freeze invoice runs at noon Point the billing dashboard at the new ledger");
    expect(snippet).toContain("Rollback Restore the billing-v1 snapshot");
    // Cut at both ends, and marked so.
    expect(snippet).toMatch(/^….+…$/);
  });

  it("a current fact reads as its subject and value, without the list and bold markers", async () => {
    await svc.post("/memory/save", { confirmed: true, items: [{ action: "create", type: "decision", title: "Halibut vendor", facts: [{ subject: "Decision", value: "Keep Halibut as the mail vendor until March" }] }] });
    const hit = (await search("Halibut mail vendor")).find((h) => h.title === "Halibut vendor" && h.snippet.includes("until March"));
    expect(hit, "the fact is found").toBeTruthy();
    expect(hit!.snippet).toMatch(/^Decision \(\d{4}-\d{2}-\d{2}.*\): Keep Halibut as the mail vendor until March/);
    expect(hit!.snippet).not.toMatch(SYNTAX);
  });
});

describe("research without a model", () => {
  it("lists each hit's snippet as plain text in the answer and the saved deliverable", async () => {
    const { job } = await svc.post("/jobs", { kind: "research", input: { question: "Quokkaflow" } });
    const done = await svc.waitJob(job.id);
    expect(done.job.status).toBe("succeeded");
    const { answer, relPath } = done.job.result as { answer: string; relPath: string };
    const line = answer.split("\n").find((l) => l.includes("Ledger cutover runbook"));
    expect(line, "the runbook is listed").toBeTruthy();
    // Rendered as the Dashboard does: the title in bold, then the snippet as plain words.
    const html = dashboard.render(line!);
    expect(html).not.toMatch(/<(code|em|h\d|a)\b/);
    expect(html.match(/<strong>/g)).toHaveLength(1);
    const text = html.replace(/<[^>]+>/g, "").trim();
    expect(text).toContain("Ledger cutover runbook: …");
    expect(text).toContain("on staging. The Quokkaflow check compares totals. Freeze invoice runs at noon");
    expect(text).not.toMatch(/[`*_#]/);
    expect(readFileSync(join(svc.dataDir, relPath), "utf8")).toContain(line!);
  });

  it("keeps characters the note escaped as literal text", async () => {
    const { job } = await svc.post("/jobs", { kind: "research", input: { question: "Pelicanpost" } });
    const done = await svc.waitJob(job.id);
    expect(done.job.status).toBe("succeeded");
    const line = (done.job.result.answer as string).split("\n").find((l) => l.includes("Batch limits"));
    expect(line, "the note is listed").toBeTruthy();
    const html = dashboard.render(line!);
    expect(html).not.toMatch(/<em>/);
    expect(html.replace(/<[^>]+>/g, "")).toContain("at most 500 *per* hour, with &lt;1% bounces.");
  });
});
