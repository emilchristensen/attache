import type { Db } from "../core/db.ts";
import { isProtected } from "../memory/policy.ts";
import { search } from "../memory/search.ts";
import type { MemoryStore } from "../memory/store.ts";
import type { RelatedNote } from "./prompt.ts";

const MAX_NOTES = 8;
const MAX_FACTS_PER_NOTE = 30;
const MAX_VALUE_CHARS = 300;

/**
 * The notes search finds related to a session, with their current facts, so
 * the model can update a note by its path and see what is already true.
 * Each query is one thing the session decided, plus its title.
 */
export function relatedNotes(db: Db, memory: MemoryStore, queries: readonly string[]): RelatedNote[] {
  const paths: string[] = [];
  for (const q of queries) {
    for (const hit of search(db, q, { limit: 6, areas: ["memory"], roots: ["data"] })) {
      if (!paths.includes(hit.relPath) && !isProtected(hit.relPath)) paths.push(hit.relPath);
    }
  }
  return paths.slice(0, MAX_NOTES).flatMap((path) => describeNote(memory, path));
}

function describeNote(memory: MemoryStore, path: string): RelatedNote[] {
  if (!memory.exists(path)) return [];
  const note = memory.describe(path);
  const type = typeof note.frontmatter.type === "string" ? note.frontmatter.type : "note";
  const facts = note.state
    .slice(0, MAX_FACTS_PER_NOTE)
    .map(({ subject, value, review }) => ({ subject, value: value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS - 1)}…` : value, ...(review ? { review } : {}) }));
  return [{ path, type, title: note.title, facts }];
}
