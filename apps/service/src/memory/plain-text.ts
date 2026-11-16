import MarkdownIt, { type Token } from "markdown-it";

/** Parses as the Dashboard renders a note, so the plain words are the words a reader sees there. */
const markdown = new MarkdownIt({ html: false, linkify: true, typographer: false });

/** `[[target]]` and `[[target|label]]`: links the old vault wrote, which Markdown leaves as text. */
const WIKI_LINK = /\[\[([^\]|\n]{1,500})(?:\|([^\]\n]{1,500}))?\]\]/g;
/** A footnote reference or the start of its definition, which Markdown also leaves as text. */
const FOOTNOTE = /\[\^[^\]\s]{1,100}\]:?/g;

/**
 * The plain words of a piece of Markdown, for showing a passage where its
 * syntax would be literal clutter or would restyle the text around it: no code
 * fences or backticks, heading, quote or list markers, emphasis, or link
 * syntax. Link and image text stays; link targets go. Code and characters the
 * author escaped are kept as written. Blocks and line breaks become new lines.
 */
export function markdownToPlainText(text: string): string {
  return markdown
    .parse(text, {})
    .flatMap((t) => (t.type === "inline" ? [inlineText(t.children ?? [])] : t.type === "fence" || t.type === "code_block" ? [t.content.replace(/\n$/, "")] : []))
    .join("\n");
}

function inlineText(tokens: Token[]): string {
  return tokens
    .map((t) => {
      if (t.type === "text") return t.content.replace(WIKI_LINK, (_: string, target: string, label?: string) => label ?? target).replace(FOOTNOTE, "");
      if (t.type === "code_inline") return t.content;
      if (t.type === "softbreak" || t.type === "hardbreak") return "\n";
      if (t.type === "image") return inlineText(t.children ?? []);
      return "";
    })
    .join("");
}

/** Characters that can start code, emphasis, a link, an autolink or an entity inside a line of Markdown. */
const INLINE_SYNTAX = /[\\`*_[\]<~&]/g;

const escapeAll = (text: string) => text.replace(INLINE_SYNTAX, "\\$&");

/**
 * Plain text made safe to put inside a line of Markdown, so it renders as the
 * same plain text. URLs are left as written, so they stay working links, and
 * everything else is escaped. Markdown reads a `scheme://` URL from the raw
 * text and can take an escape next to it into the link, so the result is
 * parsed back: if it would not read as `text`, every character is escaped,
 * `://` included, and the URLs show as text instead.
 */
export function escapeMarkdownInline(text: string): string {
  const links = markdown.linkify.match(text) ?? [];
  const parts = links.flatMap((link, i) => [escapeAll(text.slice(links[i - 1]?.lastIndex ?? 0, link.index)), text.slice(link.index, link.lastIndex)]);
  const withLinks = [...parts, escapeAll(text.slice(links.at(-1)?.lastIndex ?? 0))].join("");
  return readsAs(withLinks, text) ? withLinks : escapeAll(text).replaceAll("://", "\\://");
}

/** Whether a line of Markdown shows exactly `text` once parsed. */
function readsAs(line: string, text: string): boolean {
  const tokens = markdown.parseInline(line, {})[0]?.children ?? [];
  return tokens.every((t) => ["text", "link_open", "link_close"].includes(t.type)) && tokens.map((t) => t.content).join("") === text;
}
