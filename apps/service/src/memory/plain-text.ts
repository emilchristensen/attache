import MarkdownIt, { type Token } from "markdown-it";
import { collapseSpaces } from "./same-text.ts";
import { vaultSyntax, WIKI_LINK_TOKEN } from "./vault-syntax.ts";

/** Parses as the Dashboard renders a note, plus the wiki links and footnotes an imported vault writes. */
const markdown = new MarkdownIt({ html: false, linkify: true, typographer: false }).use(vaultSyntax);

/** The box that starts a task-list item, as written: not escaped, not code. */
const TASK_BOX = /^\[[ xX]\](?:\s+|$)/;

/**
 * The plain words of a piece of Markdown, for showing a passage where its
 * syntax would be literal clutter or would restyle the text around it: no code
 * fences or backticks, heading, quote or list markers, task boxes, emphasis,
 * or link syntax. Link and image text stays; link targets go. Code and
 * characters the author escaped are kept as written. Blocks and line breaks
 * become new lines.
 */
export function markdownToPlainText(text: string): string {
  return markdown
    .parse(text, {})
    .flatMap((t, i, tokens) => {
      if (t.type === "fence" || t.type === "code_block") return [t.content.replace(/\n$/, "")];
      if (t.type !== "inline") return [];
      const words = inlineText(t.children ?? []);
      const taskItem = tokens[i - 2]?.type === "list_item_open" && TASK_BOX.test(t.content);
      return [taskItem ? words.replace(TASK_BOX, "") : words];
    })
    .join("\n");
}

function inlineText(tokens: Token[]): string {
  return tokens
    .map((t) => {
      if (t.type === "text" || t.type === "code_inline") return t.content;
      if (t.type === "softbreak" || t.type === "hardbreak") return "\n";
      if (t.type === "image") return inlineText(t.children ?? []);
      if (t.type === WIKI_LINK_TOKEN) return inlineText(markdown.parseInline(t.content, {})[0]?.children ?? []);
      return "";
    })
    .join("");
}

/** Characters that can start code, emphasis, a link, an autolink or an entity inside a line of Markdown. */
const INLINE_SYNTAX = /[\\`*_[\]<~&]/g;

const escapeAll = (text: string) => text.replace(INLINE_SYNTAX, "\\$&");

/**
 * Plain text made safe to put inside a line of Markdown, so it renders as the
 * same plain text, on one line. URLs are left as written, so they stay working links, and
 * everything else is escaped. Markdown reads a `scheme://` URL from the raw
 * text and can take an escape next to it into the link, so the result is
 * parsed back: if it would not read as `text`, every character is escaped,
 * `://` included, and the URLs show as text instead.
 */
export function escapeMarkdownInline(line: string): string {
  const text = collapseSpaces(line);
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
