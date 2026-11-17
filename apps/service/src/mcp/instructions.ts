import { TYPE_LABEL } from "../agents/context.ts";
import type { BrainOverview } from "./brain.ts";

/** Titles per note type in the index; the rest are counted, since search reaches them anyway. */
const MAX_TITLES_PER_TYPE = 40;

const USAGE = [
  "Attache holds the owner's Brain: curated notes about the people, projects and decisions in their work, plus the evidence behind them.",
  "Search it with `search` before answering anything about the owner's work, people, projects or past decisions, instead of guessing.",
  "Every passage carries its path and line range: cite them, and use `read` to read the whole note or the cited lines.",
].join("\n");

/**
 * What a Harness without hooks learns when it connects: who the owner is and
 * which notes the Brain holds, so it knows when searching is worth it.
 * `unavailable` is the reason the overview could not be fetched.
 */
export function buildInstructions(overview: BrainOverview | null, unavailable?: string): string {
  if (!overview) return `${USAGE}\n\nThe index of the Brain is missing: ${unavailable ?? "Attache did not answer."}\nThe tools work as soon as Attache runs.\n`;
  const out = [USAGE, ""];
  out.push(overview.owner ? `The owner is ${overview.owner.name}${overview.owner.email ? ` <${overview.owner.email}>` : ""}.` : "The owner has not told Attache who they are yet.");
  const byType = new Map<string, string[]>();
  for (const n of overview.notes) byType.set(n.type, [...(byType.get(n.type) ?? []), n.title]);
  if (!byType.size) return `${out.join("\n")}\n\nThe Brain holds no curated notes yet.\n`;
  out.push("", "Notes in the Brain, most recently updated first:");
  for (const [type, titles] of byType) {
    const shown = titles.slice(0, MAX_TITLES_PER_TYPE);
    const more = titles.length - shown.length;
    out.push(`- ${TYPE_LABEL[type] ?? type}: ${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}`);
  }
  return `${out.join("\n")}\n`;
}
