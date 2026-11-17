/**
 * Counts written with "(s)": text the owner reads gives a count its noun in
 * the right number ("1 file", "2 files"), never "file(s)". Code builds such a
 * count with `plural` from `@attache/contracts` (`packages/contracts/src/wording.ts`).
 *
 * A word followed directly by "(s)" or "(es)" matches, in any case. A lone
 * "(s)" does not, and neither does a spelling in `NOT_PLURALS`.
 */
import { findInMarkdown } from "./markdown.mjs";

/** Spellings where "(s)" is not a plural, each with what it means. */
export const NOT_PLURALS = new Map([["http(s)", "http or https, the two URL schemes"]]);

const PARENTHESISED_PLURAL = /(?<![\p{L}\p{N}_-])[\p{L}\p{N}_-]+\(e?s\)/giu;

/** Returns `{ found }` for each count written with "(s)" in a piece of text, in order. */
export function findParenthesisedPlurals(text) {
  return [...text.matchAll(PARENTHESISED_PLURAL)].map(([found]) => found).filter((found) => !NOT_PLURALS.has(found.toLowerCase())).map((found) => ({ found }));
}

/** How to write one: "event(s)" → `write the noun in its number ("1 event", "2 events"), …`. */
export function pluralAdvice(found) {
  const [, one, ending] = found.match(/^(.*)\((e?s)\)$/i);
  return `write the noun in its number ("1 ${one}", "2 ${one}${ending.toLowerCase()}"), with plural() from @attache/contracts in code`;
}

/** Returns `{ line, found }` for each count written with "(s)" in Markdown a reader sees. */
export function findParenthesisedPluralsInMarkdown(markdown) {
  return findInMarkdown(markdown, findParenthesisedPlurals);
}
