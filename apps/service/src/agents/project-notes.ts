import { linkedNotes, type BrainNote } from "../memory/note-links.ts";
import { listedRepositories } from "../memory/repositories.ts";

/** The kinds of linked note a project's session context carries: its decisions and its people. */
const LINKED_TYPES: ReadonlySet<string> = new Set(["decision", "person"]);

export interface ProjectNotes {
  project: BrainNote;
  /** Repository keys the project lists; a session in one of them gets this project's context. */
  repositories: string[];
  /** The decisions and people linked to the project, in the order the notes were given. */
  linked: BrainNote[];
}

/** Every project that lists a repository, with its linked decisions and people. */
export function projectsWithContext(notes: readonly BrainNote[]): ProjectNotes[] {
  const candidates = notes.filter((n) => LINKED_TYPES.has(n.type));
  return notes.flatMap((project) => {
    if (project.type !== "project") return [];
    const repositories = listedRepositories(project.state);
    return repositories.length ? [{ project, repositories, linked: linkedNotes(project, candidates) }] : [];
  });
}

/** The notes whose facts some project's session context carries, by path. */
export function notesInSessionContext(notes: readonly BrainNote[]): Set<string> {
  return new Set(projectsWithContext(notes).flatMap((p) => [p.project.relPath, ...p.linked.map((n) => n.relPath)]));
}
