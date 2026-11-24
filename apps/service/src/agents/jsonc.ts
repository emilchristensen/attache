/**
 * Parse JSON with comments (`//`, `/* *\/`) and trailing commas, the way
 * OpenCode reads its `opencode.json(c)` files. Throws a `SyntaxError` for
 * anything else that is not JSON. Comments and the commas are blanked out
 * rather than removed, so `JSON.parse` positions still match the file.
 */
export function parseJsonc(text: string): unknown {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      out.push(text.slice(start, ++i));
    } else if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      out.push(" ".repeat(stop - i));
      i = stop;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) throw new SyntaxError("Unterminated comment");
      out.push(text.slice(i, end + 2).replace(/[^\n]/g, " "));
      i = end + 2;
    } else {
      out.push(c);
      i++;
    }
  }
  const blanked = out.join("");
  // A comma followed only by blanks and a closing bracket is a trailing comma; strings were copied as they are, so
  // skip over them again while looking.
  const result: string[] = [];
  for (let j = 0; j < blanked.length; j++) {
    const c = blanked[j]!;
    if (c === '"') {
      const start = j++;
      while (j < blanked.length && blanked[j] !== '"') j += blanked[j] === "\\" ? 2 : 1;
      result.push(blanked.slice(start, j + 1));
      continue;
    }
    if (c === ",") {
      let k = j + 1;
      while (k < blanked.length && /\s/.test(blanked[k]!)) k++;
      if (blanked[k] === "}" || blanked[k] === "]") {
        result.push(" ");
        continue;
      }
    }
    result.push(c);
  }
  return JSON.parse(result.join(""));
}
