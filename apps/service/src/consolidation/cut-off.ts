/** Where the `proposals` array of Consolidation's reply opens. */
const ARRAY_OPEN = /\{\s*"proposals"\s*:\s*\[/;

/**
 * What a reply the model stopped writing at its token limit still holds: each
 * entry of its `proposals` array written out in full, as JSON, and whether an
 * unfinished part followed them. The unfinished part is never repaired into an
 * entry. A reply cut off before its array opened holds no entries.
 */
export function entriesBeforeTheCut(text: string): { entries: unknown[]; unfinished: boolean } {
  const open = ARRAY_OPEN.exec(text);
  if (!open) return { entries: [], unfinished: true };
  const { ends, closed } = entryEnds(text, open.index + open[0].length);
  // The longest prefix that reads as JSON once the array and object are closed; usually the first one tried.
  for (const end of ends.toReversed()) {
    const entries = parsedArray(`${text.slice(open.index, end)}]}`);
    if (entries) return { entries, unfinished: !closed };
  }
  return { entries: [], unfinished: true };
}

/**
 * The positions just past each entry of the array that starts at `from`, found
 * by tracking strings and nesting; `closed` when the array's own `]` was reached.
 */
function entryEnds(text: string, from: number): { ends: number[]; closed: boolean } {
  const ends = [from];
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || (ch === "]" && depth > 0)) {
      depth--;
      if (depth === 0) ends.push(i + 1);
    } else if (depth === 0 && (ch === "," || ch === "]")) {
      // A bare value in the array ends here; an object or array already ended at its closing bracket.
      ends.push(i);
      if (ch === "]") return { ends, closed: true };
    }
  }
  return { ends, closed: false };
}

/** The `proposals` array of `json`, or null when `json` does not read as that object. */
function parsedArray(json: string): unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(json);
    const proposals = (parsed as { proposals?: unknown }).proposals;
    return Array.isArray(proposals) ? proposals : null;
  } catch {
    // Not JSON at this cut: an earlier one is tried next.
    return null;
  }
}
