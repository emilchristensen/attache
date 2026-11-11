#!/usr/bin/env node
/**
 * Docs check, run by `pnpm lint`: two writing rules the owner used to check by
 * hand.
 *
 * 1. One sentence per line in Markdown (`check-docs/sentences.mjs`). A prose
 *    line must not hold two sentences; headings, tables, code, HTML, front
 *    matter and link reference definitions are left as they are. Read in the
 *    repository's own Markdown: README.md, GLOSSARY.md, AGENTS.md,
 *    CODING_STANDARDS.md, docs/** and installer/**. Third-party skills
 *    (.claude/skills, .agents/skills), research/, node_modules and release/
 *    are never read. The dated records in docs (build-status.md,
 *    acceptance-report.md, inspection.md) are read too: the developer guide
 *    does not freeze them, and a line break never changes what they say.
 *
 * 2. Avoided glossary terms (`check-docs/glossary.mjs`). The words GLOSSARY.md
 *    lists under `_Avoid_` must not appear in text the owner reads: the
 *    Markdown above (except GLOSSARY.md, which names them), the installer's
 *    messages and the web client's user-visible strings. A term matches as a
 *    whole word in any case. To keep false positives low:
 *    - Markdown code spans, code blocks, URLs and link targets are not read;
 *    - in web code only JSX text, user-visible attributes and properties, and
 *      strings with whitespace inside are read (`check-docs/source-strings.mjs`);
 *      identifiers, comments, class names, routes and one-word keys are not;
 *    - in installer scripts only quoted strings with whitespace inside, outside
 *      comments, are read;
 *    - avoided words that are also the ordinary name of something else in
 *      Jarvis ("server", "client", "draft") are listed with their reason in
 *      `ORDINARY_WORDS` and not checked.
 *
 *   node scripts/check-docs.mjs [--root <folder>]
 *
 * Prints one `file:line: problem` line per finding and exits 1 if there is any.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { findSentenceViolations } from "./check-docs/sentences.mjs";
import { avoidedTermFinder, findAvoidedTermsInMarkdown, parseAvoidedTerms } from "./check-docs/glossary.mjs";
import { quotedStrings, userVisibleStrings } from "./check-docs/source-strings.mjs";

const GLOSSARY = "GLOSSARY.md";
const ROOT_MARKDOWN = ["README.md", GLOSSARY, "AGENTS.md", "CODING_STANDARDS.md"];
const NEVER_READ = new Set(["node_modules", "release", "research", "dist", ".claude", ".agents", ".git"]);
const INSTALLER_SCRIPTS = new Set([".sh", ".ps1", ".cmd", ".bat"]);
const WEB_SOURCE = /\.tsx?$/;
const NOT_WEB_TEXT = /(\.d\.ts|\.test\.tsx?)$/;

/** Checks a repository and returns `{ sentences, terms }`, each finding with its repository-relative `file`. */
export function checkDocs(root) {
  const glossaryPath = join(root, GLOSSARY);
  if (!existsSync(glossaryPath)) throw new Error(`${GLOSSARY} not found in ${root}; the avoided terms come from it.`);
  const find = avoidedTermFinder(parseAvoidedTerms(readFileSync(glossaryPath, "utf8")));
  const read = (file) => readFileSync(join(root, file), "utf8");
  const markdown = markdownFiles(root);
  const sentences = markdown.flatMap((file) => findSentenceViolations(read(file)).map((v) => ({ file, ...v })));
  const terms = [
    ...markdown.filter((file) => file !== GLOSSARY).flatMap((file) => findAvoidedTermsInMarkdown(read(file), find).map((v) => ({ file, ...v }))),
    ...installerScripts(root).flatMap((file) => termsIn(file, quotedStrings(read(file)), find)),
    ...filesUnder(root, "apps/web/src")
      .filter((file) => WEB_SOURCE.test(file) && !NOT_WEB_TEXT.test(file))
      .flatMap((file) => termsIn(file, userVisibleStrings(read(file), file), find)),
  ];
  return { sentences, terms };
}

function markdownFiles(root) {
  const isMarkdown = (file) => file.endsWith(".md");
  return [...ROOT_MARKDOWN.filter((file) => existsSync(join(root, file))), ...filesUnder(root, "docs").filter(isMarkdown), ...filesUnder(root, "installer").filter(isMarkdown)];
}

function installerScripts(root) {
  return filesUnder(root, "installer").filter((file) => {
    if (file.endsWith(".md")) return false;
    if (INSTALLER_SCRIPTS.has(extname(file))) return true;
    throw new Error(`${file}: the docs check does not know how to read this kind of installer file; teach scripts/check-docs.mjs to read it.`);
  });
}

function termsIn(file, strings, find) {
  return strings.flatMap(({ line, text }) => find(text).map((hit) => ({ file, line, ...hit })));
}

/** Repository-relative paths, with `/`, of every file under a folder, in a stable order. */
function filesUnder(root, folder) {
  const start = join(root, folder);
  if (!existsSync(start)) return [];
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true })
      .filter((entry) => !NEVER_READ.has(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : entry.isFile() ? [relative(root, join(dir, entry.name)).split(sep).join("/")] : []));
  return walk(start);
}

/** One line per finding, as `file:line: problem`. */
export function formatFindings({ sentences, terms }) {
  return [
    ...sentences.map(({ file, line }) => `${file}:${line}: two sentences on one line; put each sentence on its own line`),
    ...terms.map(({ file, line, found, preferred }) => `${file}:${line}: "${found}" is avoided in ${GLOSSARY}; use ${preferred.join(" or ")}`),
  ];
}

function main() {
  const { values } = parseArgs({ options: { root: { type: "string" } } });
  const root = resolve(values.root ?? join(import.meta.dirname, ".."));
  const findings = checkDocs(root);
  const lines = formatFindings(findings);
  if (lines.length === 0) return 0;
  console.log(lines.join("\n"));
  console.error(`\nDocs check: ${findings.sentences.length} line(s) with two sentences, ${findings.terms.length} avoided glossary term(s).`);
  return 1;
}

if (import.meta.main) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`Docs check could not run: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
