/**
 * The plain words of a piece of Markdown, for showing a passage where its
 * syntax would be literal clutter or would restyle the text around it: no code
 * fences or backticks, heading, quote or list markers, emphasis, or link
 * syntax. Link and image text stays; link targets go. Line breaks stay, so a
 * caller can still tell lines apart.
 */
export function markdownToPlainText(markdown: string): string {
  const lines = markdown.split("\n").flatMap(plainLine);
  return plainInline(lines.join("\n"));
}

const FENCE = /^\s*(```|~~~)/;
const RULE = /^\s{0,3}([-*_=])(?:\s*\1){2,}\s*$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** One line without its block syntax, or no line when it is only syntax (a fence, a rule, a table divider). */
function plainLine(line: string): string[] {
  if (FENCE.test(line) || RULE.test(line) || TABLE_DIVIDER.test(line)) return [];
  const unquoted = line.replace(/^(\s*>\s?)+/, "");
  const heading = /^\s{0,3}#{1,6}(?:\s+|$)/.exec(unquoted);
  const text = (heading ? unquoted.slice(heading[0].length).replace(/\s+#+\s*$/, "") : unquoted)
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^\[[ xX]\]\s+/, "");
  return [/^\s*\|/.test(text) ? text.replace(/\s*\|\s*/g, " ").trim() : text];
}

/** Code spans are set aside first, so their contents are kept exactly and never read as emphasis or links. */
function plainInline(text: string): string {
  const code: string[] = [];
  const hold = (s: string) => `\u0000${code.push(s) - 1}\u0000`;
  return text
    .replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _ticks: string, inner: string) => hold(inner.trim()))
    .replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, (_, ch: string) => hold(ch))
    .replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target: string, label?: string) => label ?? target)
    .replace(/!\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, "$1")
    .replace(/\[([^\]]+)\]\((?:[^()]|\([^()]*\))*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/\[\^[^\]]+\]/g, "")
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, "$1")
    .replace(/<\/?[A-Za-z][^>]*>/g, "")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replace(/\*(?=\S)([\s\S]*?\S)\*/g, "$1")
    .replace(/(?<![\p{L}\p{N}])_(?=\S)([\s\S]*?\S)_(?![\p{L}\p{N}])/gu, "$1")
    .replace(/`+/g, "")
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => code[Number(i)] ?? "");
}

/**
 * Plain text made safe to put inside a line of Markdown: every character that
 * could start code, emphasis, a link or HTML is escaped, so it renders as the
 * same plain text.
 */
export function escapeMarkdownInline(text: string): string {
  return text.replace(/[\\`*_[\]<~]/g, "\\$&");
}
