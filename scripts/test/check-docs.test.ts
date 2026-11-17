/**
 * The docs check (`scripts/check-docs.mjs`): one sentence per line in Markdown,
 * no term the glossary says to avoid in user-facing text, and no count written
 * with "(s)".
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findSentenceViolations } from "../check-docs/sentences.mjs";
import { avoidedTermFinder, findAvoidedTermsInMarkdown, parseAvoidedTerms } from "../check-docs/glossary.mjs";
import { quotedStrings, userVisibleStrings } from "../check-docs/source-strings.mjs";
import { findParenthesisedPlurals, findParenthesisedPluralsInMarkdown } from "../check-docs/plurals.mjs";
import { checkDocs } from "../check-docs.mjs";

const FIXTURES = join(import.meta.dirname, "fixtures/check-docs");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

/** 1-based numbers of the lines that are not blank. */
function nonBlankLineNumbers(text: string): number[] {
  return text
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => line.trim() !== "")
    .map(({ number }) => number);
}

/** 1-based numbers of the lines that are neither blank nor a heading. */
function proseLineNumbers(text: string): number[] {
  const lines = text.split("\n");
  return nonBlankLineNumbers(text).filter((number) => !lines[number - 1].startsWith("#"));
}

describe("one sentence per line", () => {
  it("accepts prose with one sentence per line and leaves Markdown structure alone", () => {
    expect(findSentenceViolations(fixture("sentences-good.md"))).toEqual([]);
  });

  it("flags every line that holds two sentences", () => {
    const text = fixture("sentences-bad.md");
    expect(findSentenceViolations(text).map((v: { line: number }) => v.line)).toEqual(proseLineNumbers(text));
  });

  it("reports the line's text", () => {
    expect(findSentenceViolations("Intro line.\nOne. Two.\n")).toEqual([{ line: 2, text: "One. Two." }]);
  });
});

describe("avoided glossary terms", () => {
  const avoided = parseAvoidedTerms(fixture("glossary.md"));
  const find = avoidedTermFinder(avoided);

  it("reads each avoided term with the glossary terms to use instead", () => {
    expect(avoided).toEqual([
      { term: "vault", preferred: ["Brain"] },
      { term: "second brain", preferred: ["Brain"] },
      { term: "data folder", preferred: ["Brain"] },
      { term: "sync", preferred: ["Replication", "Source refresh"] },
      { term: "backup", preferred: ["Replication"] },
      { term: "poll", preferred: ["Source refresh"] },
      { term: "coding agent", preferred: ["Harness"] },
      { term: "auto-save", preferred: ["Harness"] },
    ]);
  });

  it("finds an avoided term as a whole word in any case, with its inflections", () => {
    expect(find("Attache syncs your Second Brain.")).toEqual([
      { term: "sync", found: "syncs", preferred: ["Replication", "Source refresh"] },
      { term: "second brain", found: "Second Brain", preferred: ["Brain"] },
    ]);
  });

  it("leaves Markdown without avoided terms alone, including code, link targets and ordinary words", () => {
    expect(findAvoidedTermsInMarkdown(fixture("terms-good.md"), find)).toEqual([]);
  });

  it("flags avoided terms in prose, headings, tables, lists, quotes, HTML and link text", () => {
    const text = fixture("terms-bad.md");
    const flagged = new Set(findAvoidedTermsInMarkdown(text, find).map((v: { line: number }) => v.line));
    expect([...flagged]).toEqual(nonBlankLineNumbers(text).slice(1));
  });

  it("leaves names, routes, class names and types in web code alone", () => {
    expect(userVisibleStrings(fixture("web-good.tsx"), "web-good.tsx").flatMap(({ text }) => find(text))).toEqual([]);
  });

  it("flags avoided terms in web text: JSX text, labels, titles, placeholders and sentences in strings", () => {
    const text = fixture("web-bad.tsx");
    expect(flaggedLines(userVisibleStrings(text, "web-bad.tsx"), find)).toEqual(linesMarked(text, "avoided"));
  });

  it("flags avoided terms in installer messages but not in comments or variable names", () => {
    const text = fixture("installer-bad.sh");
    expect(flaggedLines(quotedStrings(text), find)).toEqual(linesMarked(text, "avoided"));
  });
});

describe("counts written with (s)", () => {
  it("finds a noun with (s) or (es) after it, in any case", () => {
    expect(findParenthesisedPlurals("3 file(s) and 2 match(es) for Job(s) in work item(s)")).toEqual([{ found: "file(s)" }, { found: "match(es)" }, { found: "Job(s)" }, { found: "item(s)" }]);
  });

  it("leaves http(s), a lone (s) and proper plurals alone", () => {
    expect(findParenthesisedPlurals("Enter an HTTP(S) or http(s) URL; (s) on its own; 1 file, 2 files")).toEqual([]);
  });

  it("flags counts with (s) in service and web strings, but not in comments, names or http(s)", () => {
    const text = fixture("plurals-bad.ts");
    expect(flaggedLines(userVisibleStrings(text, "plurals-bad.ts"), findParenthesisedPlurals)).toEqual(linesMarked(text, "plural"));
    expect(userVisibleStrings(fixture("plurals-good.ts"), "plurals-good.ts").flatMap(({ text }) => findParenthesisedPlurals(text))).toEqual([]);
  });

  it("flags counts with (s) in Markdown prose, but not in code", () => {
    expect(findParenthesisedPluralsInMarkdown("# Files\n\nReads 2 file(s).\n\n`file(s)` in code.\n\n```\njob(s)\n```\n")).toEqual([{ line: 3, found: "file(s)" }]);
  });
});

describe("checking a repository", () => {
  const repo = join(FIXTURES, "repo");

  it("checks the repository's own docs, installer, web and service text, and nothing else", () => {
    expect(checkDocs(repo)).toEqual({
      sentences: [{ file: "README.md", line: 4, text: "This line holds two sentences. It is flagged." }],
      terms: [
        { file: "docs/adr/0001-example.md", line: 3, term: "sync", found: "sync", preferred: ["Replication", "Source refresh"] },
        { file: "installer/install.sh", line: 2, term: "poll", found: "Polling", preferred: ["Source refresh"] },
        { file: "apps/web/src/View.tsx", line: 2, term: "second brain", found: "second brain", preferred: ["Brain"] },
      ],
      plurals: [
        { file: "docs/adr/0001-example.md", line: 4, found: "file(s)" },
        { file: "apps/web/src/View.tsx", line: 4, found: "note(s)" },
        { file: "apps/service/src/notes.ts", line: 2, found: "event(s)" },
      ],
    });
  });

  it("fails from the command line with one line per finding", () => {
    const run = spawnSync(process.execPath, [join(import.meta.dirname, "../check-docs.mjs"), "--root", repo], { encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("README.md:4: two sentences on one line; put each sentence on its own line");
    expect(run.stdout).toContain('installer/install.sh:2: "Polling" is avoided in GLOSSARY.md; use Source refresh');
    expect(run.stdout).toContain('docs/adr/0001-example.md:3: "sync" is avoided in GLOSSARY.md; use Replication or Source refresh');
    expect(run.stdout).toContain('apps/service/src/notes.ts:2: "event(s)" writes a count with (s); write the noun in its number ("1 event", "2 events"), with plural() from @attache/contracts in code');
    expect(run.stderr).toContain("Docs check: 1 line with two sentences, 3 avoided glossary terms, 3 counts written with (s).");
  });

  it("passes from the command line when nothing is found", () => {
    const run = spawnSync(process.execPath, [join(import.meta.dirname, "../check-docs.mjs"), "--root", join(FIXTURES, "clean-repo")], { encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });
});

function flaggedLines(strings: { line: number; text: string }[], find: (text: string) => unknown[]): number[] {
  return [...new Set(strings.filter(({ text }) => find(text).length > 0).map(({ line }) => line))];
}

/** 1-based numbers of the lines with a `// <mark>`, `/* <mark>` or `# <mark>` comment. */
function linesMarked(text: string, mark: "avoided" | "plural"): number[] {
  const marked = new RegExp(`(//|/\\*|#) ${mark}`);
  return text
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => marked.test(line))
    .map(({ number }) => number);
}
