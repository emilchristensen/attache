/** Text with every run of whitespace made one space, so line breaks and spacing never make two texts differ. */
export function collapseSpaces(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Whether two values say the same thing: spacing does not count, case does. */
export function sameText(a: string, b: string): boolean {
  return collapseSpaces(a) === collapseSpaces(b);
}

/** Text compared as the owner would read it: neither case nor spacing makes two passages different. */
export function looseText(text: string): string {
  return collapseSpaces(text).toLowerCase();
}
