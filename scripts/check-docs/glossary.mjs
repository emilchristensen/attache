/**
 * Avoided terms: `GLOSSARY.md` lists, under each term, the words to avoid for
 * it (`_Avoid_: Sync, backup`). This module reads that list and finds the
 * words in text, so adding a word to the glossary extends the check.
 *
 * A term matches as a whole word, case-insensitively, with an `s`, `es`, `ed`
 * or `ing` ending ("syncs", "syncing"). Letters, digits, `_` and `-` around it
 * make it a different word, so `sync-state` and `asynchronously` pass.
 */
import { plainText, readableLines } from "./markdown.mjs";

/**
 * Avoided words that are also the ordinary name of something else in Jarvis.
 * The glossary avoids them only as a name for its own term, which a word match
 * cannot tell apart, so the check leaves them alone. Each entry says what the
 * word legitimately names. Prefer rewording over adding an entry here.
 */
export const ORDINARY_WORDS = new Map([
  ["vault", "Obsidian's own name for a folder of notes, which Jarvis can import"],
  ["data folder", "the folder where one Machine keeps its copy of the Brain, as the glossary itself says"],
  ["node", "the Node.js runtime, and nodes in a model graph"],
  ["device", "hardware such as a microphone"],
  ["instance", "the named install that `JARVIS_INSTANCE` selects"],
  ["client", "OAuth, MCP and HTTP clients"],
  ["backup", "the backup and restore of a Machine's data"],
  ["fetch", "git fetch, which Replication runs"],
  ["server", "MCP servers, OAuth authorization servers and the test fixture server"],
  ["chat", "Claude Desktop's Chat tab, and the chat box Jarvis does not have"],
  ["app", "other applications, such as Obsidian or an OAuth app"],
  ["draft", "a drafted reply or comment waiting for approval, which is not a Proposal"],
  ["learning", "learning in its ordinary sense"],
  ["overwrite", "replacing a file's contents"],
  ["fix", "repairing a defect"],
  ["edit", "changing a file by hand"],
  ["expiry", "when a job lease or a draft expires"],
]);

const AVOID_LINE = /^_Avoid_:\s*(.+)$/;
const TERM_LINE = /^\*\*(.+?)\*\*:\s*$/;

/**
 * Returns `{ term, preferred }` for each avoided word in a glossary, in the
 * order the glossary lists them. `term` is lower case; `preferred` lists the
 * glossary terms that avoid it.
 */
export function parseAvoidedTerms(glossaryMarkdown) {
  const byTerm = new Map();
  let current = null;
  for (const line of glossaryMarkdown.split(/\r?\n/)) {
    const term = line.match(TERM_LINE);
    if (term) current = term[1];
    const avoid = line.match(AVOID_LINE);
    if (!avoid) continue;
    if (!current) throw new Error(`An _Avoid_ line comes before any glossary term: ${line}`);
    for (const word of splitAvoided(avoid[1])) {
      const preferred = byTerm.get(word)?.preferred ?? [];
      if (!preferred.includes(current)) byTerm.set(word, { term: word, preferred: [...preferred, current] });
    }
  }
  return [...byTerm.values()];
}

/** "Vault, second brain, data folder (a note)" → ["vault", "second brain", "data folder"]. */
function splitAvoided(list) {
  return list
    .replace(/\([^)]*\)/g, "")
    .split(",")
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Returns a function that finds the avoided terms in a piece of text, as
 * `{ term, found, preferred }` in the order they appear. Terms in
 * `ordinaryWords` are skipped.
 */
export function avoidedTermFinder(avoided, ordinaryWords = ORDINARY_WORDS) {
  const checked = avoided.filter(({ term }) => !ordinaryWords.has(term));
  const matchers = checked.map((entry) => ({ entry, pattern: new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeRegExp(entry.term).replace(/ /g, "\\s+")}(?:s|es|ed|ing)?(?![\\p{L}\\p{N}_-])`, "giu") }));
  return (text) =>
    matchers
      .flatMap(({ entry, pattern }) => [...text.matchAll(pattern)].map((match) => ({ index: match.index, term: entry.term, found: match[0], preferred: entry.preferred })))
      .sort((a, b) => a.index - b.index)
      .map(({ term, found, preferred }) => ({ term, found, preferred }));
}

/** Returns `{ line, term, found, preferred }` for each avoided term in Markdown a reader sees. */
export function findAvoidedTermsInMarkdown(markdown, find) {
  return readableLines(markdown).flatMap(({ line, content }) => find(plainText(content)).map((hit) => ({ line, ...hit })));
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
