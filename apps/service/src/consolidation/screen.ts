import type { MemorySaveItem } from "@jarvis/contracts";
import { HttpError } from "../http/router.ts";
import { slugify } from "../memory/markdown.ts";
import { normalizeRel } from "../memory/policy.ts";
import { checkItems, type CheckedItem } from "../memory/save-items.ts";
import type { MemoryStore } from "../memory/store.ts";
import type { Candidate, Dropped } from "./reply.ts";

type UpdateItem = Extract<MemorySaveItem, { action: "update" }>;

/** Text compared as the owner would read it: case and spacing do not make two things different. */
const norm = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Keep only the candidates worth the owner's click, at most `limit` of them:
 * each must quote its evidence from the session, pass the same checks as a
 * save, and add something the Brain and the pending Proposals do not already
 * hold. Repeated parts are removed; a candidate with nothing left is dropped.
 */
export function screenCandidates(
  memory: MemoryStore,
  candidates: readonly Candidate[],
  context: { session: string; pending: readonly MemorySaveItem[]; limit: number },
): { accepted: Candidate[]; dropped: Dropped[] } {
  const session = norm(context.session);
  const seen = new Set(context.pending.flatMap(keysOf));
  const accepted: Candidate[] = [];
  const dropped: Dropped[] = [];
  for (const c of candidates) {
    const verdict = screenOne(memory, c, session, seen);
    if ("problem" in verdict) {
      dropped.push(verdict);
      continue;
    }
    if (accepted.length >= context.limit) {
      dropped.push({ problem: `more than ${context.limit} Proposals for one session` });
      continue;
    }
    accepted.push(verdict);
    for (const k of keysOf(verdict.item)) seen.add(k);
  }
  return { accepted, dropped };
}

function screenOne(memory: MemoryStore, c: Candidate, session: string, seen: ReadonlySet<string>): Candidate | Dropped {
  if (!session.includes(norm(c.evidence))) return { problem: "its evidence is not quoted from the session" };
  let step: CheckedItem;
  try {
    [step] = checkItems(memory, [c.item]) as [CheckedItem];
  } catch (e) {
    if (e instanceof HttpError) return { problem: `it fails the checks a save passes: ${e.message}` };
    throw e;
  }
  if (step.action === "create") return keysOf(c.item).some((k) => seen.has(k)) ? { problem: "the same note is already proposed" } : c;
  const item = newPartsOnly(memory, step.relPath, step.item, seen);
  if (!item.facts?.length && !item.events?.length) return { problem: "it repeats a pending Proposal or what the note already says" };
  return { ...c, item };
}

/** The update without the facts and events the note or a pending Proposal already holds. */
function newPartsOnly(memory: MemoryStore, relPath: string, item: UpdateItem, seen: ReadonlySet<string>): UpdateItem {
  const note = memory.describe(relPath);
  const body = norm(note.raw);
  const unchanged = (f: { subject: string; value: string; review?: string | undefined }) => {
    const current = note.state.find((e) => e.subject.toLowerCase() === f.subject.toLowerCase());
    return !!current && norm(current.value) === norm(f.value) && (!f.review || f.review === current.review);
  };
  const facts = (item.facts ?? []).filter((f) => !unchanged(f) && !seen.has(factKey(relPath, f)));
  const events = (item.events ?? []).filter((e) => !body.includes(norm(e)) && !seen.has(eventKey(relPath, e)));
  return { action: "update", path: relPath, ...(facts.length ? { facts } : {}), ...(events.length ? { events } : {}) };
}

const factKey = (relPath: string, f: { subject: string; value: string }) => `fact|${relPath}|${f.subject.toLowerCase()}|${norm(f.value)}`;
const eventKey = (relPath: string, text: string) => `event|${relPath}|${norm(text)}`;

/** What a change consists of, one key per part, so a repeat of any part can be recognised. */
function keysOf(item: MemorySaveItem): string[] {
  if (item.action === "create") return [`create|${item.type}|${slugify(item.title)}`];
  const relPath = normalizeRel(item.path.replace(/^\.\//, ""));
  return [...(item.facts ?? []).map((f) => factKey(relPath, f)), ...(item.events ?? []).map((e) => eventKey(relPath, e))];
}
