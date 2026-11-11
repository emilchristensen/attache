import { join } from "node:path";
import type { MemoryStore } from "../memory/store.ts";
import { brainNote, type BrainNote } from "../memory/note-links.ts";
import type { StateEntry } from "../memory/markdown.ts";
import { buildSessionContext, type ContextFact, type ContextInput } from "./context.ts";
import { projectSlug, type ProjectContext } from "./context-files.ts";
import { projectsWithContext, type ProjectNotes } from "./project-notes.ts";
import { recentSessionLogEntries, type SessionLogEntry } from "./session-log-entries.ts";

/** Days of session logs a project's context looks back over for its sessions. */
const SESSION_LOG_DAYS = 14;

export type ContextBase = Omit<ContextInput, "notes" | "project">;

type Memory = Pick<MemoryStore, "dataRoot" | "listDocuments" | "read">;

/** The global context and one context per project that lists a repository, read from the Brain. */
export function brainContexts(memory: Memory, base: ContextBase, onError: (relPath: string, error: Error) => void): { global: string; projects: ProjectContext[] } {
  const notes = curatedNotes(memory, onError);
  const input: ContextInput = { ...base, notes: notes.map(({ type, title }) => ({ type, title })) };
  const root = memory.dataRoot!;
  const entries = recentSessionLogEntries(join(root, "evidence", "sessions"), SESSION_LOG_DAYS);
  const projects = projectsWithContext(notes).map((p) => ({
    slug: projectSlug(p.project.relPath),
    repositories: p.repositories,
    text: buildSessionContext({ ...input, project: projectSection(root, p, entries) }),
  }));
  return { global: buildSessionContext(input), projects };
}

/** Every curated note but the identity record, most recently updated first. */
export function curatedNotes(memory: Memory, onError: (relPath: string, error: Error) => void): BrainNote[] {
  return memory
    .listDocuments({ area: "memory", root: "data", limit: 2000 })
    .filter((d) => d.relPath !== "memory/self.md" && d.title)
    .flatMap((d) => {
      try {
        return [brainNote({ relPath: d.relPath, type: d.docType ?? "note", title: d.title }, memory.read(d.relPath))];
      } catch (e) {
        onError(d.relPath, e as Error);
        return [];
      }
    });
}

const contextFacts = (state: readonly StateEntry[]): ContextFact[] => state.map(({ subject, date, review, value }) => ({ subject, date, ...(review ? { review } : {}), value }));

function projectSection(root: string, { project, repositories, linked }: ProjectNotes, entries: readonly SessionLogEntry[]): NonNullable<ContextInput["project"]> {
  const ours = new Set(repositories);
  return {
    title: project.title,
    path: join(root, project.relPath),
    state: contextFacts(project.state),
    linked: linked.map((n) => ({ type: n.type, title: n.title, relPath: n.relPath, state: contextFacts(n.state) })),
    sessions: entries.filter((e) => e.repositories.some((r) => ours.has(r))).map(({ date, heading, body }) => ({ date, heading, body })),
  };
}
