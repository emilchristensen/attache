import { CODE_FENCE } from "./markdown.ts";

/**
 * The plain words of a piece of Markdown, for showing a passage where its
 * syntax would be literal clutter or would restyle the text around it: no code
 * fences or backticks, heading, quote or list markers, emphasis, or link
 * syntax. Link and image text stays; link targets go. Code and characters the
 * author escaped are kept exactly as written. Line breaks stay, so a caller can
 * still tell lines apart.
 */
export function markdownToPlainText(markdown: string): string {
  const literals: string[] = [];
  const setAside = (text: string) => `${SET_ASIDE}${literals.push(text) - 1}${SET_ASIDE}`;
  const prose = setAsideLiterals(setAsideFencedCode(markdown, setAside), setAside);
  const plain = decodeEntities(plainInline(prose.split("\n").flatMap(plainLine).join("\n")));
  return plain.replace(SET_ASIDE_REF, (_, i: string) => literals[Number(i)] ?? "");
}

/**
 * Plain text made safe to put inside a line of Markdown: every character that
 * could start code, emphasis, a link, an autolink or an entity is escaped, so
 * it renders as the same plain text. Bare URLs stay as they are, so they still
 * render as working links.
 */
export function escapeMarkdownInline(text: string): string {
  return text
    .split(/(\s+)/)
    .map((word) => (BARE_URL.test(word) ? word : word.replace(/[\\`*_[\]<~&]/g, "\\$&")))
    .join("");
}

/** Brackets text that later rules must not touch; the text itself is kept in a list and put back last. */
const SET_ASIDE = "\u0000";
const SET_ASIDE_REF = /\u0000(\d+)\u0000/g;
const BARE_URL = /^(?:https?:\/\/|www\.|mailto:)\S+$/i;

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

/** Escaped characters and code spans, left to right, so an escaped backtick never opens a span. */
function setAsideLiterals(text: string, setAside: (text: string) => string): string {
  return text.replace(/\\([\\`*_{}[\]()#+\-.!|<>~&])|(?<!`)(`+)(?!`)([\s\S]*?[^`])\2(?!`)/g, (_, escaped?: string, _ticks?: string, code?: string) =>
    setAside(escaped ?? code!.trim()),
  );
}

const RULE = /^\s{0,3}([-*_=])(?:\s*\1){2,}\s*$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const HEADING = /^\s{0,3}#{1,6}(?:\s+|$)/;

/** One line without its block syntax, or no line when it is only syntax (a rule, a table divider). */
function plainLine(line: string): string[] {
  if (RULE.test(line) || TABLE_DIVIDER.test(line)) return [];
  const unquoted = line.replace(/^(\s*>\s?)+/, "");
  const heading = HEADING.exec(unquoted);
  const text = (heading ? unquoted.slice(heading[0].length).replace(/\s+#+\s*$/, "") : unquoted)
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^\[[ xX]\]\s+/, "");
  return [/^\s*\|/.test(text) ? text.replace(/\s*\|\s*/g, " ").trim() : text];
}

/** Link, image and emphasis syntax gone, their words kept. */
function plainInline(text: string): string {
  return text
    .replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target: string, label?: string) => label ?? target)
    .replace(/!?\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/\[\^[^\]]+\]/g, "")
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, "$1")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replace(/\*(?=\S)([\s\S]*?\S)\*/g, "$1")
    .replace(/(?<![\p{L}\p{N}])_(?=\S)([\s\S]*?\S)_(?![\p{L}\p{N}])/gu, "$1")
    .replace(/`+/g, "");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** The characters common HTML entities stand for; an unknown entity stays as written. */
function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (whole, dec?: string, hex?: string, name?: string) => {
    const code = dec ? Number(dec) : hex ? parseInt(hex, 16) : null;
    if (code !== null) return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    return ENTITIES[name!.toLowerCase()] ?? whole;
  });
}
