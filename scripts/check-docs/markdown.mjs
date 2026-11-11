/**
 * Splits Markdown into the lines the docs checks read. Front matter, fenced
 * code and HTML comments are never read. Prose lines (for one sentence per
 * line) also leave out HTML, headings, tables, link reference definitions and
 * thematic breaks, and drop list and quote markers. Readable lines (for
 * avoided terms) keep headings, tables and HTML, which a reader sees too.
 *
 * Indented code blocks are not recognised: in these docs an indented line is a
 * list continuation, and treating it as code would hide real prose.
 */

/** Marks where an inline code span or URL stood, so neither reads as words. */
export const CODE_MARK = "";

const FENCE = /^\s*(`{3,}|~{3,})/;
const HEADING = /^#{1,6}(\s|$)/;
const TABLE_ROW = /^\|/;
const LINK_DEFINITION = /^\[[^\]]+\]:\s/;
const THEMATIC_BREAK = /^([-*_])(\s*\1){2,}\s*$/;
const HTML_LINE = /^<(\/?[A-Za-z]|!)/;
const QUOTE_MARKERS = /^(\s*>\s?)+/;
const LIST_MARKER = /^\s*([-*+]|\d{1,9}[.)])(\s+\[[ xX]\])?\s+/;

/**
 * Returns `{ line, text, prose }` for every prose line: `line` is 1-based,
 * `text` the line as written and `prose` its content without list or quote
 * markers.
 */
export function proseLines(markdown) {
  return contentLines(markdown).flatMap(({ line, text, content }) => {
    if (isStructure(content)) return [];
    const prose = content.replace(LIST_MARKER, "").trim();
    return prose === "" || isStructure(prose) ? [] : [{ line, text, prose }];
  });
}

/**
 * Returns `{ line, text, content }` for every line a reader sees as text:
 * prose, headings, table rows and HTML, but no code, comments, front matter or
 * link reference definitions. `content` is the line without quote markers.
 */
export function readableLines(markdown) {
  return contentLines(markdown).filter(({ content }) => content !== "" && !LINK_DEFINITION.test(content));
}

/** Every line outside front matter, fenced code and HTML comments. */
function contentLines(markdown) {
  const lines = markdown.split(/\r?\n/);
  const result = [];
  let fence = null;
  let inComment = false;
  let inFrontMatter = lines[0] === "---";
  for (const [index, text] of lines.entries()) {
    if (inFrontMatter) {
      if (index > 0 && /^(---|\.\.\.)\s*$/.test(text)) inFrontMatter = false;
      continue;
    }
    if (fence) {
      if (closesFence(text, fence)) fence = null;
      continue;
    }
    if (inComment) {
      if (text.includes("-->")) inComment = false;
      continue;
    }
    const opened = text.match(FENCE);
    if (opened) {
      fence = opened[1];
      continue;
    }
    const content = text.replace(QUOTE_MARKERS, "").trim();
    if (content.startsWith("<!--")) {
      inComment = !content.includes("-->");
      continue;
    }
    result.push({ line: index + 1, text, content });
  }
  return result;
}

function closesFence(text, fence) {
  const trimmed = text.trim();
  return trimmed.startsWith(fence) && new RegExp(`^\\${fence[0]}+$`).test(trimmed);
}

function isStructure(content) {
  return content === "" || HEADING.test(content) || TABLE_ROW.test(content) || LINK_DEFINITION.test(content) || THEMATIC_BREAK.test(content) || HTML_LINE.test(content);
}

/**
 * Reduces one line of Markdown prose to the words a reader sees: code spans and
 * URLs become `CODE_MARK`, links and images keep their text, and inline HTML
 * tags are dropped. Emphasis markers stay; the checks read past them.
 */
export function plainText(prose) {
  return prose
    .replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, CODE_MARK)
    .replace(/<(https?:\/\/|mailto:)[^>\s]+>/g, CODE_MARK)
    .replace(/!?\[([^\]]*)\]\([^)\s]*(\s+"[^"]*")?\)/g, "$1")
    .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"]/g, CODE_MARK)
    .replace(/<\/?[A-Za-z][^>]*>/g, "");
}
