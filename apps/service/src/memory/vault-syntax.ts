import type { MarkdownIt, StateInline } from "markdown-it";

/** The token a wiki link becomes; its content is the Markdown of what it shows. */
export const WIKI_LINK_TOKEN = "wiki_link";

/** `[[target]]`, `[[target|label]]` and the `![[embed]]` forms, which an imported vault writes and Markdown leaves as text. */
const WIKI_LINK = /!?\[\[([^[\]|\n]{1,200})(?:\|([^[\]\n]{1,200}))?\]\]/y;
/** A footnote reference, or the marker that starts its definition. */
const FOOTNOTE = /\[\^[^[\]\s]{1,100}\](?::(?=\s|$))?/y;

/**
 * Reads wiki links and footnote markers while Markdown is parsed, so a
 * character the author escaped never starts one and a label keeps its own
 * formatting. A wiki link becomes a `wiki_link` token holding what it shows;
 * a footnote marker becomes empty text.
 */
export function vaultSyntax(md: MarkdownIt): void {
  md.inline.ruler.before("link", "vault_syntax", (state: StateInline, silent: boolean) => {
    // A silent run is markdown-it measuring a link's text, where a jump past a `[` reads as a
    // nested link and drops the link. The brackets balance, and the link's text is read for real later.
    if (silent) return false;
    const first = state.src.charCodeAt(state.pos);
    if (first !== 0x5b /* [ */ && first !== 0x21 /* ! */) return false;
    for (const pattern of [WIKI_LINK, FOOTNOTE]) {
      pattern.lastIndex = state.pos;
      const match = pattern.exec(state.src);
      // Defensive: never read past the end of the text markdown-it handed this rule.
      if (!match || pattern.lastIndex > state.posMax) continue;
      // A footnote marker leaves an empty text token, so emphasis around it (`*[^1]*`) still pairs and goes.
      if (pattern === WIKI_LINK) state.push(WIKI_LINK_TOKEN, "", 0).content = match[2] ?? match[1]!;
      else state.push("text", "", 0);
      state.pos = pattern.lastIndex;
      return true;
    }
    return false;
  });
}
