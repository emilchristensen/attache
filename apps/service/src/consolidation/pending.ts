import type { MemorySaveItem } from "@jarvis/contracts";

const MAX_LINE_CHARS = 300;

/** One line naming a pending Proposal's change, so the model can see what already waits for review. */
export function pendingLine(item: MemorySaveItem): string {
  const where = item.action === "create" ? `new ${item.type} "${item.title}"` : item.path;
  const parts = [...(item.facts ?? []).map((f) => `${f.subject}: ${f.value}`), ...(item.events ?? []).map((e) => `event: ${e}`)].join("; ");
  const line = `${where}: ${parts}`;
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}…` : line;
}
