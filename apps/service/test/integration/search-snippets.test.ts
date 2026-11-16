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
 * starts inside it; a list, a link, emphasis and fenced code follow, then a
 * section under its own heading.
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
  "```ts",
  "const totals = new Map<string, number>();",
  "```",
  "",
  "Finance signs off once the totals match for three days in a row, and the old exports are archived.",
  "",
  "## Rollback",
  "",
  "Restore the billing-v1 snapshot and reopen invoice runs.",
  "",
].join("\n");

/** Characters that are literal text in the note (escaped, an entity, a bare URL) and must stay so in a research answer. */
const LIMITS = "memory/notes/batch-limits.md";
const LIMITS_TEXT = [
  "---",
  "type: note",
  "title: Batch limits",
  "---",
  "",
  "The Pelicanpost batch sends at most 500 \\*per\\* hour, with <1% bounces. Tag runs with \\`nightly\\`.",
  "Ops &amp; Finance watch the board (https://status.example.com/pelican_post_batches) and `www.example.com/*nightly*` daily.",
  "",
].join("\n");

/** Link forms whose words stay and whose targets go, and a word whose underscores are not emphasis. */
const GUIDE = "memory/notes/wallaroo-guide.md";
const GUIDE_TEXT = [
  "---",
  "type: note",
  "title: Wallaroo guide",
  "---",
  "",
  "The Wallaroo guide covers [the API [v2]](https://example.com/v2), [![the diagram](d.png)](https://example.com/d), the [setup][s] page and foo__bar__baz values.",
  "",
  "[s]: https://example.com/setup",
  "",
].join("\n");

/** One long line that opens markers it never closes: search must stay fast on it. */
const LONG_LINE = "memory/notes/long-line.md";
const LONG_LINE_TEXT = `---\ntype: note\ntitle: Long line\n---\n\n${"[".repeat(40_000)}${"**a _a ~~a ".repeat(20_000)} Kookaburra\n`;

/**
 * URLs next to Markdown markers, which the research answer must show as the
 * same text: in code spans, where the snippet keeps them as written, and one
 * bare in parentheses.
 */
const URL_CASES = [
  "Snorkelfish one keeps `postgres://u@h/db?q=*a*` handy.",
  "Snorkelfish two keeps `s3://bucket/__tmp__/x` handy.",
  "Snorkelfish three keeps `(https://a.com/page)*bold*` handy.",
  "Snorkelfish four keeps `file:///tmp/*.log*` handy.",
  "Snorkelfish five keeps ``https://a.com/foo)` and https://b.com/bar)` `` handy.",
  "Snorkelfish six reads (https://github.com/a/b/blob/main/__init__.py) daily.",
];
const urlCase = (i: number) => `memory/notes/snorkelfish-${i + 1}.md`;

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
  writeFileSync(join(svc.dataDir, GUIDE), GUIDE_TEXT);
  writeFileSync(join(svc.dataDir, LONG_LINE), LONG_LINE_TEXT);
  URL_CASES.forEach((text, i) => writeFileSync(join(svc.dataDir, urlCase(i)), `---\ntype: note\ntitle: Snorkelfish ${i + 1}\n---\n\n${text}\n`));
  const { job } = await svc.post("/memory/reindex");
  expect((await svc.waitJob(job.id)).job.status).toBe("succeeded");
});
afterAll(() => svc.stop());

describe("search snippets are the plain words of the note", () => {
  it("drops code, list, link and emphasis syntax, keeps fenced code as written and the words around the match", async () => {
    const hit = (await search("Quokkaflow")).find((h) => h.relPath === NOTE);
    expect(hit, "the runbook is found").toBeTruthy();
    const { snippet } = hit!;
    expect(snippet).not.toMatch(SYNTAX);
    expect(snippet).toContain("--to ledger-v2 on staging. The Quokkaflow check compares totals.");
    expect(snippet).toContain("Freeze invoice runs at noon Point the billing dashboard at the new ledger");
    expect(snippet).toContain("at the new ledger const totals = new Map<string, number>();");
    // Cut at both ends, and marked so.
    expect(snippet).toMatch(/^….+…$/);
  });

  it("a section under a heading reads as its words, without the heading marker", async () => {
    const hit = (await search("billing-v1 snapshot")).find((h) => h.relPath === NOTE);
    expect(hit?.snippet).toBe("Restore the billing-v1 snapshot and reopen invoice runs.");
  });

  it("decodes entities and keeps escaped characters as the note wrote them", async () => {
    const hit = (await search("Pelicanpost")).find((h) => h.relPath === LIMITS);
    expect(hit?.snippet).toBe("The Pelicanpost batch sends at most 500 *per* hour, with <1% bounces. Tag runs with `nightly`. Ops & Finance watch the board (https://status.example.com/pelican_post_batches) and www.example.com/*nightly* daily.");
  });

  it("keeps link text, drops every kind of link target, and keeps underscores inside a word", async () => {
    const hit = (await search("Wallaroo guide")).find((h) => h.relPath === GUIDE);
    expect(hit?.snippet).toBe("The Wallaroo guide covers the API [v2], the diagram, the setup page and foo__bar__baz values.");
  });

  it("answers quickly on a long line of markers that never close", async () => {
    const started = Date.now();
    const hit = (await search("Kookaburra")).find((h) => h.relPath === LONG_LINE);
    // Each marker used to make the snippet scan the rest of the line: seconds of blocked service for this note.
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(hit?.snippet).toMatch(/Kookaburra$/);
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

  it("keeps escaped characters, entities and bare URLs literal", async () => {
    const { job } = await svc.post("/jobs", { kind: "research", input: { question: "Pelicanpost" } });
    const done = await svc.waitJob(job.id);
    expect(done.job.status).toBe("succeeded");
    const line = (done.job.result.answer as string).split("\n").find((l) => l.includes("Batch limits"));
    expect(line, "the note is listed").toBeTruthy();
    const html = dashboard.render(line!);
    expect(html).not.toMatch(/<(code|em)\b/);
    expect(html).toContain('(<a href="https://status.example.com/pelican_post_batches">https://status.example.com/pelican_post_batches</a>)');
    expect(html.replace(/<[^>]+>/g, "")).toContain("at most 500 *per* hour, with &lt;1% bounces. Tag runs with `nightly`. Ops &amp; Finance watch the board (https://status.example.com/pelican_post_batches) and www.example.com/*nightly* daily.");
  });

  it("shows URLs next to Markdown markers as the same text the snippet has", async () => {
    const snippets = new Map((await search("Snorkelfish")).map((h) => [h.relPath, h.snippet]));
    expect(snippets.get(urlCase(5))).toBe("Snorkelfish six reads (https://github.com/a/b/blob/main/__init__.py) daily.");
    const { job } = await svc.post("/jobs", { kind: "research", input: { question: "Snorkelfish" } });
    const done = await svc.waitJob(job.id);
    expect(done.job.status).toBe("succeeded");
    const lines = (done.job.result.answer as string).split("\n").filter((l) => l.startsWith("- [S"));
    URL_CASES.forEach((_, i) => {
      const line = lines.find((l) => l.includes(`**Snorkelfish ${i + 1}**`));
      expect(line, `case ${i + 1} is listed`).toBeTruthy();
      const html = dashboard.render(line!);
      expect(html, `case ${i + 1}`).not.toMatch(/<(code|em)\b/);
      expect(html.match(/<strong>/g), `case ${i + 1}`).toHaveLength(1);
      expect(textOf(html), `case ${i + 1}`).toBe(`[S${lines.indexOf(line!) + 1}] Snorkelfish ${i + 1}: ${snippets.get(urlCase(i))}`);
    });
  });
});

/** The text a reader sees in rendered HTML. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .trim();
}
