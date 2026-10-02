/**
 * Breaks a briefing summary (plain prose from the model or the deterministic
 * fallback) into one line per sentence, so a dense paragraph scans as a list.
 */
export interface BriefingLine {
  text: string;
  /** True for sentences about missing or partial source coverage. */
  caveat: boolean;
}

// A boundary is sentence punctuation, whitespace, then something that can open a sentence.
const BOUNDARY = /(?<=[.!?])\s+(?=["“'(\p{Lu}\p{N}\p{Extended_Pictographic}])/u;
const ABBREVIATION = /\b(?:e\.g|i\.e|vs|Mr|Ms|Mrs|Dr|No|approx)\.$/i;
const CAVEAT = /\bincomplete\b|\bmay be missing\b|\bnot configured\b|\breturned an error\b|\bcoverage\b/i;

export function briefingLines(summary: string): BriefingLine[] {
  const sentences = summary
    .trim()
    .split(BOUNDARY)
    .filter(Boolean)
    .reduce<string[]>((acc, piece) => {
      const prev = acc.at(-1);
      return prev !== undefined && ABBREVIATION.test(prev) ? [...acc.slice(0, -1), `${prev} ${piece}`] : [...acc, piece];
    }, []);
  return sentences.map((text) => ({ text, caveat: CAVEAT.test(text) }));
}
