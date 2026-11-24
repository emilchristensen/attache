#!/usr/bin/env node
/**
 * Docs check, run by `pnpm lint`: three writing rules the owner used to check
 * by hand.
 *
 * 1. One sentence per line in Markdown (`check-docs/sentences.mjs`). A prose
 *    line must not hold two sentences; headings, tables, code, HTML, front
 *    matter and link reference definitions are left as they are. Read in the
 *    repository's own Markdown: README.md, GLOSSARY.md, AGENTS.md,
 *    CODING_STANDARDS.md, docs/** and installer/**. Third-party skills
 *    (.claude/skills, .agents/skills), research/, design records under
 *    docs/design/ (which keep the words and reviews of their time),
 *    node_modules and release/ are never read.
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
 *      Attache ("server", "client", "draft") are listed with their reason in
 *      `ORDINARY_WORDS` and not checked.
 *
 * 3. Counts written with "(s)" (`check-docs/plurals.mjs`). Text the owner reads
 *    says "1 file" or "2 files", never "file(s)". Read in the Markdown above,
 *    the installer's messages, the web client's user-visible strings, and the
 *    same kind of strings in the service and the contracts package
 *    (`apps/service/src`, `packages/contracts/src`), whose coverage notes,
 *    errors and replies reach the owner through the Dashboard or a Harness.
 *    The service is read for this rule only: its strings also hold log lines
 *    and prompts, where the glossary's words may stand.
 *
 * 4. Browser specs' opening comments (`check-docs/spec-headers.mjs`). Every
 *    `tests/e2e/*.spec.ts` opens with a `/**` comment saying what it covers and
 *    whether it runs on its own; the developer guide points there instead of
 *    listing each spec.
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
import { findParenthesisedPlurals, findParenthesisedPluralsInMarkdown, pluralAdvice } from "./check-docs/plurals.mjs";
import { findMissingSpecHeader } from "./check-docs/spec-headers.mjs";
import { plural } from "../packages/contracts/src/wording.ts";

const GLOSSARY = "GLOSSARY.md";
const ROOT_MARKDOWN = ["README.md", GLOSSARY, "AGENTS.md", "CODING_STANDARDS.md"];
const NEVER_READ = new Set(["node_modules", "release", "research", "dist", ".claude", ".agents", ".git"]);
/** Folders skipped by their path from the repository root, not by name. */
const NEVER_READ_PATHS = new Set(["docs/design"]);
const INSTALLER_SCRIPTS = new Set([".sh", ".ps1", ".cmd", ".bat"]);
const SOURCE = /\.tsx?$/;
const NOT_TEXT = /(\.d\.ts|\.test\.tsx?)$/;
/** Source folders whose strings reach the owner without being the Dashboard's own text. */
const SERVICE_SOURCE = ["apps/service/src", "packages/contracts/src"];

/** Checks a repository and returns `{ sentences, terms, plurals, specHeaders }`, each finding with its repository-relative `file`. */
export function checkDocs(root) {
  const glossaryPath = join(root, GLOSSARY);
  if (!existsSync(glossaryPath)) throw new Error(`${GLOSSARY} not found in ${root}; the avoided terms come from it.`);
  const find = avoidedTermFinder(parseAvoidedTerms(readFileSync(glossaryPath, "utf8")));
  const read = (file) => readFileSync(join(root, file), "utf8");
  const markdown = markdownFiles(root);
  const installer = installerScripts(root).map((file) => ({ file, strings: quotedStrings(read(file)) }));
  const web = sourceFiles(root, ["apps/web/src"]).map((file) => ({ file, strings: userVisibleStrings(read(file), file) }));
  const service = sourceFiles(root, SERVICE_SOURCE).map((file) => ({ file, strings: userVisibleStrings(read(file), file) }));
  const sentences = markdown.flatMap((file) => findSentenceViolations(read(file)).map((v) => ({ file, ...v })));
  const terms = [
    ...markdown.filter((file) => file !== GLOSSARY).flatMap((file) => findAvoidedTermsInMarkdown(read(file), find).map((v) => ({ file, ...v }))),
    ...[...installer, ...web].flatMap(({ file, strings }) => hitsIn(file, strings, find)),
  ];
  const plurals = [
    ...markdown.flatMap((file) => findParenthesisedPluralsInMarkdown(read(file)).map((v) => ({ file, ...v }))),
    ...[...installer, ...web, ...service].flatMap(({ file, strings }) => hitsIn(file, strings, findParenthesisedPlurals)),
  ];
  const specHeaders = filesUnder(root, "tests/e2e")
    .filter((file) => file.endsWith(".spec.ts"))
    .flatMap((file) => findMissingSpecHeader(read(file)).map((v) => ({ file, ...v })));
  return { sentences, terms, plurals, specHeaders };
}

/** TypeScript sources under the folders, without declarations and tests. */
function sourceFiles(root, folders) {
  return folders.flatMap((folder) => filesUnder(root, folder)).filter((file) => SOURCE.test(file) && !NOT_TEXT.test(file));
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

function hitsIn(file, strings, find) {
  return strings.flatMap(({ line, text }) => find(text).map((hit) => ({ file, line, ...hit })));
}

/** Repository-relative paths, with `/`, of every file under a folder, in a stable order. */
function filesUnder(root, folder) {
  const start = join(root, folder);
  if (!existsSync(start)) return [];
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true })
      .filter((entry) => !NEVER_READ.has(entry.name) && !NEVER_READ_PATHS.has(relative(root, join(dir, entry.name)).split(sep).join("/")))
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : entry.isFile() ? [relative(root, join(dir, entry.name)).split(sep).join("/")] : []));
  return walk(start);
}

/** One line per finding, as `file:line: problem`. */
export function formatFindings({ sentences, terms, plurals, specHeaders }) {
  return [
    ...sentences.map(({ file, line }) => `${file}:${line}: two sentences on one line; put each sentence on its own line`),
    ...terms.map(({ file, line, found, preferred }) => `${file}:${line}: "${found}" is avoided in ${GLOSSARY}; use ${preferred.join(" or ")}`),
    ...plurals.map(({ file, line, found }) => `${file}:${line}: "${found}" writes a count with (s); ${pluralAdvice(found)}`),
    ...specHeaders.map(({ file, line }) => `${file}:${line}: a browser spec opens with a /** comment saying what it covers and whether it runs on its own`),
  ];
}


function main() {
  const { values } = parseArgs({ options: { root: { type: "string" } } });
  const root = resolve(values.root ?? join(import.meta.dirname, ".."));
  const findings = checkDocs(root);
  const lines = formatFindings(findings);
  if (lines.length === 0) return 0;
  console.log(lines.join("\n"));
  console.error(`\nDocs check: ${plural(findings.sentences.length, "line")} with two sentences, ${plural(findings.terms.length, "avoided glossary term")}, ${plural(findings.plurals.length, "count")} written with (s), ${plural(findings.specHeaders.length, "browser spec")} without its opening comment.`);
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
