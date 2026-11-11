/**
 * Finds the text in source code that the owner reads, so the avoided-terms
 * check can look at it without tripping over names.
 *
 * Web code (TypeScript and TSX) is parsed with the TypeScript compiler. These
 * count as text the owner reads:
 * - JSX text, and a string written as a child of a JSX element (`{"Drafts"}`);
 * - strings given to a user-visible JSX attribute (`title`, `aria-label`,
 *   `placeholder`, `alt`, `label`) or object property (`label`, `title`,
 *   `description`, `message`, `hint`, `placeholder`, `heading`, `text`);
 * - any other string or template text with whitespace inside, such as a toast
 *   message or a sentence built in code.
 * Identifiers and comments are never read, nor are module specifiers, string
 * types, or strings given to attributes that name things (`className`, `key`,
 * `id`, `type`, `href`, `data-*` and the like). A one-word string elsewhere is
 * taken as a key, route or name.
 *
 * Installer scripts (shell, PowerShell, cmd) are read line by line: quoted
 * strings with whitespace inside, outside comments, are the messages they
 * print.
 */
import ts from "typescript";

const VISIBLE_ATTRIBUTES = new Set(["title", "alt", "placeholder", "label", "aria-label", "aria-description", "aria-placeholder", "aria-roledescription", "aria-valuetext"]);
const VISIBLE_PROPERTIES = new Set(["label", "title", "description", "message", "hint", "placeholder", "heading", "text"]);
const NAMING_ATTRIBUTES = new Set(["className", "class", "style", "key", "id", "type", "name", "role", "href", "src", "htmlFor", "rel", "target", "method", "autoComplete", "inputMode", "pattern", "accept", "form", "lang"]);

/** Returns `{ line, text }` for each piece of text the owner can read in a web source file. */
export function userVisibleStrings(code, fileName) {
  const source = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found = [];
  const visit = (node) => {
    if (isSkipped(node)) return;
    if (ts.isJsxText(node)) found.push(...linesOf(source, node.getFullStart(), node.text));
    else if (isStringPart(node) && (/\S\s+\S/.test(node.text) || isVisibleContext(node))) found.push(...linesOf(source, node.getStart(), node.text));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found.filter(({ text }) => text.trim() !== "");
}

function isSkipped(node) {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportTypeNode(node) || ts.isLiteralTypeNode(node)) return true;
  if (!ts.isJsxAttribute(node)) return false;
  const name = node.name.getText();
  return NAMING_ATTRIBUTES.has(name) || name.startsWith("data-");
}

function isStringPart(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
}

function isVisibleContext(node) {
  const parent = node.parent;
  if (ts.isJsxAttribute(parent)) return VISIBLE_ATTRIBUTES.has(parent.name.getText());
  if (ts.isJsxExpression(parent)) {
    const holder = parent.parent;
    if (ts.isJsxAttribute(holder)) return VISIBLE_ATTRIBUTES.has(holder.name.getText());
    return ts.isJsxElement(holder) || ts.isJsxFragment(holder);
  }
  return ts.isPropertyAssignment(parent) && parent.initializer === node && VISIBLE_PROPERTIES.has(parent.name.getText().replace(/^["']|["']$/g, ""));
}

function linesOf(source, position, text) {
  const first = source.getLineAndCharacterOfPosition(position).line + 1;
  return text.split("\n").map((piece, index) => ({ line: first + index, text: piece }));
}

/** Returns `{ line, text }` for each quoted string with whitespace inside, outside `#` and `REM` comments. */
export function quotedStrings(code) {
  const found = [];
  let inBlockComment = false;
  for (const [index, line] of code.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (inBlockComment || trimmed.startsWith("<#")) {
      inBlockComment = !trimmed.includes("#>");
      continue;
    }
    if (trimmed.startsWith("#") || /^(@?rem\b|::)/i.test(trimmed)) continue;
    for (const match of line.matchAll(/"((?:[^"\\`]|[\\`].)*)"|'([^']*)'/g)) {
      const text = match[1] ?? match[2];
      if (/\S\s+\S/.test(text)) found.push({ line: index + 1, text });
    }
  }
  return found;
}
