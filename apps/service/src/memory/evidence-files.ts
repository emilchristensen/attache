import { randomUUID } from "node:crypto";
import { stringify as stringifyYaml } from "yaml";
import { nowIso } from "../core/db.ts";
import type { MachineIdentity } from "../core/machine.ts";
import type { SourceRef } from "./store.ts";

/**
 * What each evidence and deliverable file in the Brain looks like: frontmatter
 * that says what it is, then its text. Pure, so the store only decides where
 * a file goes and who writes it.
 */

/** A Markdown file with YAML frontmatter. */
export function withFrontmatter(fm: Record<string, unknown>, body: string): string {
  return `---\n${stringifyYaml(fm, { lineWidth: 0 }).trimEnd()}\n---\n${body}`;
}

/** Text that must stay on one line of Markdown, so it can never open a heading or a section of its own. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function formatSource(s: SourceRef): string {
  const lines = s.lines ? `#L${s.lines[0]}-L${s.lines[1]}` : "";
  const where = s.url ?? `${s.root && s.root !== "data" ? s.root + ":" : ""}${s.ref}${lines}`;
  return `${s.label ? s.label + " " : ""}(${s.kind}: ${where}, observed ${s.observedAt.slice(0, 10)})`;
}

export function sourceToYaml(s: SourceRef): Record<string, unknown> {
  return { kind: s.kind, ref: s.ref, ...(s.root ? { root: s.root } : {}), ...(s.lines ? { lines: s.lines } : {}), ...(s.url ? { url: s.url } : {}), observed_at: s.observedAt, ...(s.label ? { label: s.label } : {}) };
}

/** A capture's title when none is given: its first words. */
export function captureTitle(text: string, title?: string): string {
  const given = title?.trim();
  if (given) return given;
  const words = text.replace(/[#>*_`]/g, " ").trim().split(/\s+/).slice(0, 8).join(" ");
  return words || "Capture";
}

/** Captured text, quoted, with the source it came from. */
export function captureFile(input: { text: string; title: string; source: SourceRef; tags?: string[] }): string {
  const fm = { id: randomUUID(), type: "capture", title: input.title, captured_at: nowIso(), provenance: "captured", source: sourceToYaml(input.source), ...(input.tags?.length ? { tags: input.tags } : {}) };
  const quoted = input.text
    .trim()
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  return withFrontmatter(fm, `# ${input.title}\n\n${quoted}\n\nSource: ${formatSource(input.source)}\n`);
}

/** ARCHIVE.md of a verbatim archive: where it came from and a hash per file. */
export function archiveManifest(input: { path: string; origin?: string; exclude: string[]; rows: readonly string[] }): string {
  const origin = input.origin ?? input.path;
  const fm = { type: "archive", title: `Archive of ${origin}`, source_path: input.path, ...(input.origin ? { origin: input.origin } : {}), archived_at: nowIso(), files: input.rows.length, excluded: input.exclude, provenance: "archived-verbatim" };
  return withFrontmatter(
    fm,
    `# Archive of ${origin}\n\nVerbatim copies of ${input.rows.length} Markdown files, at the same relative paths, so citations keep their line numbers.\n\n| File | Bytes | SHA-256 (first 16) |\n| --- | --- | --- |\n${input.rows.join("\n")}\n`,
  );
}

export function deliverableFile(kind: "briefings" | "research" | "drafts", title: string, body: string, meta: Record<string, unknown>): string {
  const fm = { id: randomUUID(), type: kind.replace(/s$/, ""), title, generated_at: nowIso(), provenance: "generated", ...meta };
  return withFrontmatter(fm, `# ${title}\n\n${body.trim()}\n`);
}

export interface AgentSessionMeta {
  agent: string;
  agentLabel: string;
  sessionId: string;
  title: string;
  cwd: string | null;
  startedAt: string | null;
}

/** The conversation of one Harness session. */
export function agentSessionFile(meta: AgentSessionMeta, turns: ReadonlyArray<{ role: "user" | "assistant"; text: string; at: string | null }>, userName: string): string {
  const fm = { id: meta.sessionId, type: "agent-session", title: meta.title, agent: meta.agent, cwd: meta.cwd, started_at: meta.startedAt, archived_at: nowIso(), provenance: "agent-session-archive" };
  const body = turns.map((t) => `### ${t.role === "user" ? userName : meta.agentLabel}${t.at ? ` · ${t.at}` : ""}\n\n${t.text.trim()}`).join("\n\n");
  const where = [meta.agentLabel, meta.cwd ? `in \`${meta.cwd}\`` : null, meta.startedAt ? `started ${meta.startedAt}` : null].filter(Boolean).join(" · ");
  return withFrontmatter(fm, `# ${meta.title}\n\n${where}\n\n${body}\n`);
}

/** The head of one Machine's session log for one day, before its first section. */
export function sessionLogHead(date: string, machine: MachineIdentity): string {
  const title = `Agent sessions on ${date} (${machine.name})`;
  return withFrontmatter({ type: "session-log", title, date, machine: machine.name, machine_id: machine.id, provenance: "agent-session-summary" }, `# ${title}\n`);
}

/** What a connector observed on one day, on one Machine. */
export function connectorSnapshotFile(input: { kind: string; label: string; day: string; machine: MachineIdentity; lines: readonly string[] }): string {
  const title = `${input.label} on ${input.day} (${input.machine.name})`;
  const fm = { type: "connector-snapshot", title, source: input.kind, machine: input.machine.name, machine_id: input.machine.id, observed_at: nowIso(), provenance: "connector" };
  const body = input.lines.length ? input.lines.join("\n") : "_The last Source refresh returned no items._";
  return withFrontmatter(fm, `# ${title}\n\nLatest observation at ${nowIso()}.\n\n${body}\n`);
}

/** The durable points of one Harness conversation: evidence, never under Current State. */
export function wrapUpFile(input: { harness: { id: string; label: string }; title: string; date: string; machine: MachineIdentity; points: readonly string[] }): string {
  const fm = { id: randomUUID(), type: "wrap-up", title: input.title, date: input.date, harness: input.harness.id, harness_label: input.harness.label, machine: input.machine.name, machine_id: input.machine.id, recorded_at: nowIso(), provenance: "harness-wrap-up" };
  const intro = `Evidence: the durable points of a conversation in ${input.harness.label} on ${input.date}, as its agent summed them up with the wrap-up prompt.\nThey are not curated memory: none is a current fact until it is saved to a note.`;
  const points = input.points.map((p) => `- ${oneLine(p)}`).join("\n");
  return withFrontmatter(fm, `# ${input.title}\n\n${intro}\n\n## Points\n\n${points}\n`);
}
