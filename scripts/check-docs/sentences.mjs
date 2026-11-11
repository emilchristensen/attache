/**
 * One sentence per line: a prose line of Markdown must not hold a sentence end
 * followed by the start of another sentence.
 *
 * A sentence ends at `.`, `!` or `?`, after any closing quotes, brackets or
 * emphasis, followed by whitespace and a capital letter, a digit or inline
 * code (again after any opening quotes, brackets or emphasis). A period does
 * not end a sentence after a known abbreviation ("e.g.", "etc."), a single
 * letter (an initial) or an ellipsis, nor does the end of a bold label that
 * opens the line (a run-in heading such as `**Local state.**`). Lower case after a period never starts a
 * sentence, so "Node.js. or" and file names pass. Inline code, URLs and link
 * targets are removed before the line is read.
 */
import { CODE_MARK, plainText, proseLines } from "./markdown.mjs";

const SENTENCE_BREAK = new RegExp(`([.!?])["'”’)\\]*_]*\\s+["'“‘(\\[*_]*[\\p{Lu}\\p{N}${CODE_MARK}]`, "gu");
/** A bold label that opens a line, such as `**Local state.**`: Markdown's run-in heading, not a sentence. */
const RUN_IN_LABEL = /^(\*\*|__)[^*_]+?[.!?:]\1/;
const ABBREVIATIONS = new Set(["e.g", "i.e", "etc", "vs", "cf", "viz", "approx", "incl", "al", "fig", "eq", "mr", "mrs", "ms", "dr", "prof", "st", "jr", "sr", "inc", "ltd", "co", "a.m", "p.m"]);

/** Returns `{ line, text }` for each prose line that holds two or more sentences. */
export function findSentenceViolations(markdown) {
  return proseLines(markdown)
    .filter(({ prose }) => holdsTwoSentences(plainText(prose)))
    .map(({ line, text }) => ({ line, text }));
}

function holdsTwoSentences(text) {
  const labelEnd = text.match(RUN_IN_LABEL)?.[0].length ?? 0;
  for (const match of text.matchAll(SENTENCE_BREAK)) {
    if (match.index < labelEnd) continue;
    if (match[1] !== "." || !endsWithAbbreviation(text.slice(0, match.index))) return true;
  }
  return false;
}

function endsWithAbbreviation(before) {
  if (before.endsWith("..")) return true;
  const word = (before.match(/\S+$/)?.[0] ?? "").replace(/^["'“‘(\[*_]+/, "");
  return /^\p{L}$/u.test(word) || ABBREVIATIONS.has(word.toLowerCase());
}
