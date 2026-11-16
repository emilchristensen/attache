import { CODE_FENCE } from "./markdown.ts";

/**
 * The plain words of a piece of Markdown, for showing a passage where its
 * syntax would be literal clutter or would restyle the text around it: no code
 * fences or backticks, heading, quote or list markers, emphasis, or link
 * syntax. Link and image text stays; link targets go. Code and characters the
 * author escaped are kept exactly as written. Line breaks stay, so a caller can
 * still tell lines apart.
 *
 * Every pattern is bounded, so the time taken grows with the length of the
 * text even when a long line opens markers it never closes.
 */
export function markdownToPlainText(markdown: string): string {
  const literals: string[] = [];
  const setAside = (text: string) => `${SET_ASIDE}${literals.push(text) - 1}${SET_ASIDE}`;
  const prose = setAsideLiterals(setAsideFencedCode(markdown, setAside), setAside);
  const plain = prose
    .split(/(\n[ \t]*\n)/)
    .map((part) => decodeEntities(plainInline(part.split("\n").flatMap(plainLine).join("\n"))))
    .join("");
  return plain.replace(SET_ASIDE_REF, (_, i: string) => literals[Number(i)] ?? "");
}

/**
 * Plain text made safe to put inside a line of Markdown: every character that
 * could start code, emphasis, a link, an autolink or an entity is escaped, so
 * it renders as the same plain text. A URL with a scheme (`https://…`) is left
 * as written up to the next space, because Markdown links it from the raw text
 * and takes an escape next to it into the link. A marker left bare at its end
 * pairs with nothing: every later one is escaped.
 */
export function escapeMarkdownInline(text: string): string {
  return text
    .split(SCHEME_URL_RUN)
    .map((part, i) => (i % 2 ? part : part.replace(/[\\`*_[\]<~&]/g, "\\$&")))
    .join("");
}

/** Brackets text that later rules must not touch; the text itself is kept in a list and put back last. */
const SET_ASIDE = "\u0000";
const SET_ASIDE_REF = /\u0000(\d+)\u0000/g;
/** A URL Markdown links from the raw text: a scheme, `://`, and no trailing punctuation, as markdown-it's linkify ends it. */
const SCHEME_URL = /(?<![a-z0-9.+-])[a-z][a-z0-9.+-]*:\/\/[^\s<>]*[^\s<>.,:;!?*_~)\]'"`]/i;
/** Such a URL and whatever follows it up to the next space. */
const SCHEME_URL_RUN = /((?<![a-z0-9.+-])[a-z][a-z0-9.+-]*:\/\/[^\s<>]*)/i;
/** Longest span an inline pattern looks across, so an unclosed marker never makes it scan the rest of the text. */
const SPAN = 500;

/** Fence lines dropped, the code between them set aside whole. */
function setAsideFencedCode(markdown: string, setAside: (text: string) => string): string {
  let inFence = false;
  return markdown
    .split("\n")
    .flatMap((line) => {
      if (CODE_FENCE.test(line)) {
        inFence = !inFence;
        return [];
      }
      return [inFence ? setAside(line) : line];
    })
    .join("\n");
}

const LITERALS = new RegExp(String.raw`\\([!-/:-@[-\`{-~])|(?<!\`)(\`+)(?!\`)([^]{0,${SPAN}}?[^\`])\2(?!\`)|(?<![(<])${SCHEME_URL.source}`, "gi");

/**
 * Escaped characters, code spans and bare URLs, left to right, so an escaped
 * backtick never opens a span and no rule edits a URL. A URL in a link's
 * parentheses or an autolink's angle brackets is left to those rules.
 */
function setAsideLiterals(text: string, setAside: (text: string) => string): string {
  return text.replace(LITERALS, (whole: string, escaped?: string, _ticks?: string, code?: string) => setAside(escaped ?? code?.trim() ?? whole));
}

const RULE = /^\s{0,3}([-*_=])(?:\s*\1){2,}\s*$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const HEADING = /^\s{0,3}#{1,6}(?:\s+|$)/;
const LINK_DEFINITION = /^\s{0,3}\[(?!\^)[^\]\n]{1,500}\]:\s*\S/;

/** One line without its block syntax, or no line when it is only syntax (a rule, a table divider, a link definition). */
function plainLine(line: string): string[] {
  if (RULE.test(line) || TABLE_DIVIDER.test(line) || LINK_DEFINITION.test(line)) return [];
  const unquoted = line.replace(/^(\s*>\s?)+/, "");
  const heading = HEADING.exec(unquoted);
  const text = (heading ? unquoted.slice(heading[0].length).replace(/\s+#+\s*$/, "") : unquoted)
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^\[[ xX]\]\s+/, "")
    .replace(/^\s{0,3}\[\^[^\]\n]{1,100}\]:\s*/, "");
  return [/^\s*\|/.test(text) ? text.replace(/\s*\|\s*/g, " ").trim() : text];
}

/** A link label: text with at most one level of brackets inside. */
const LABEL = String.raw`((?:[^[\]\n]|\[[^[\]\n]{0,${SPAN}}\]){0,${SPAN}})`;
/** A link destination and title in parentheses, with at most one level of parentheses inside. */
const DESTINATION = String.raw`\((?:[^()\n]|\([^()\n]{0,${SPAN}}\)){0,${SPAN}}\)`;
const WORD_EDGE = String.raw`[\p{L}\p{N}_]`;
const INLINE_RULES: Array<[RegExp, string | ((...groups: string[]) => string)]> = [
  [new RegExp(String.raw`!?\[\[([^\]|\n]{1,${SPAN}})(?:\|([^\]\n]{1,${SPAN}}))?\]\]`, "g"), (_, target: string, label?: string) => label ?? target],
  [new RegExp(String.raw`!\[([^[\]\n]{0,${SPAN}})\]${DESTINATION}`, "g"), "$1"],
  [new RegExp(String.raw`\[${LABEL}\]${DESTINATION}`, "g"), "$1"],
  [new RegExp(String.raw`\[${LABEL}\]\[[^[\]\n]{0,${SPAN}}\]`, "g"), "$1"],
  [new RegExp(String.raw`\[\^[^\]\n]{1,100}\]`, "g"), ""],
  [new RegExp(String.raw`<((?:https?|mailto):[^>\s]{1,${SPAN}})>`, "g"), "$1"],
  [new RegExp(String.raw`\*\*(?=\S)([^]{0,${SPAN}}?\S)\*\*`, "g"), "$1"],
  [new RegExp(String.raw`(?<!${WORD_EDGE})__(?=\S)([^]{0,${SPAN}}?\S)__(?!${WORD_EDGE})`, "gu"), "$1"],
  [new RegExp(String.raw`~~(?=\S)([^]{0,${SPAN}}?\S)~~`, "g"), "$1"],
  [new RegExp(String.raw`\*(?=\S)([^]{0,${SPAN}}?\S)\*`, "g"), "$1"],
  [new RegExp(String.raw`(?<!${WORD_EDGE})_(?=\S)([^]{0,${SPAN}}?\S)_(?!${WORD_EDGE})`, "gu"), "$1"],
  [/`+/g, ""],
];

/** Link, image and emphasis syntax gone, their words kept. Runs on one paragraph, so no pair spans two. */
function plainInline(paragraph: string): string {
  return INLINE_RULES.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement as string), paragraph);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** The characters common HTML entities stand for; an unknown entity stays as written. */
function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{1,32}));/gi, (whole, dec?: string, hex?: string, name?: string) => {
    const code = dec ? Number(dec) : hex ? parseInt(hex, 16) : null;
    if (code !== null) return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    return ENTITIES[name!.toLowerCase()] ?? whole;
  });
}
