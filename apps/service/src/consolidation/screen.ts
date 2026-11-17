import type { MemorySaveItem } from "@attache/contracts";
import { HttpError } from "../http/router.ts";
import { slugify } from "../memory/markdown.ts";
import { brainRel, PolicyError } from "../memory/policy.ts";
import { checkItemAlone, checkItems, type CheckedItem } from "../memory/save-items.ts";
import { looseText as norm } from "../memory/same-text.ts";
import type { MemoryStore } from "../memory/store.ts";
import type { Candidate, Dropped } from "./reply.ts";

type UpdateItem = Extract<MemorySaveItem, { action: "update" }>;

/** A drop, with the candidate it was made from. */
export type DroppedFrom<C extends Candidate> = Dropped & { candidate: C };

/**
 * A fact value as the owner would read it: emphasis, quotes around it and a
 * closing full stop do not make it a different value, so a value the model
 * merely writes back differently is never proposed as a change.
 */
const plainValue = (value: string) =>
  norm(value.replace(/[*_`]+/g, " "))
    .replace(/^["“”‘’']+|["“”‘’']+$/gu, "")
    .replace(/[.!;:,]+$/, "")
    .trim();

/**
 * Keep the candidates that pass the checks on each change by itself: a path in
 * the Brain, evidence quoted from what was read (`text`, named by `noun`), and
 * `checkItemAlone`, every check a save makes except whether a new note already
 * exists. For an update those include whether its note exists, and its type, so
 * a change written in this run can turn a verdict: a caller that runs again
 * keeps the first verdicts rather than asking again.
 * These run before one value is chosen per fact, so a change that fails them never
 * pushes out one that passes; each that fails is dropped with its problem.
 */
export function checkCandidates<C extends Candidate>(memory: MemoryStore, candidates: readonly C[], context: { text: string; noun: string }): { valid: C[]; dropped: Array<DroppedFrom<C>> } {
  const read = norm(context.text);
  const valid: C[] = [];
  const dropped: Array<DroppedFrom<C>> = [];
  for (const c of candidates) {
    const problem = problemOf(memory, c, read, context.noun);
    if (problem) dropped.push({ candidate: c, problem });
    else valid.push(c);
  }
  return { valid, dropped };
}

function problemOf(memory: MemoryStore, c: Candidate, read: string, noun: string): string | null {
  const path = pathProblem(c.item);
  if (path) return path;
  if (!read.includes(norm(c.evidence))) return `its evidence is not quoted from the ${noun}`;
  try {
    checkItemAlone(memory, c.item);
    return null;
  } catch (e) {
    return refusal(e);
  }
}

/**
 * Keep only the candidates that add something the Brain and the pending
 * Proposals do not already hold, and whose new note does not exist yet.
 * Repeated parts are removed; a candidate with nothing left is dropped.
 * The candidates have passed `checkCandidates`.
 */
export function screenCandidates<C extends Candidate>(memory: MemoryStore, candidates: readonly C[], context: { pending: readonly MemorySaveItem[] }): { accepted: C[]; dropped: Dropped[] } {
  const seen = new Set(context.pending.flatMap(keysOf));
  const accepted: C[] = [];
  const dropped: Dropped[] = [];
  for (const c of candidates) {
    const verdict = screenOne(memory, c, seen);
    if ("problem" in verdict) {
      dropped.push(verdict);
      continue;
    }
    accepted.push(verdict);
    for (const k of keysOf(verdict.item)) seen.add(k);
  }
  return { accepted, dropped };
}

function screenOne<C extends Candidate>(memory: MemoryStore, c: C, seen: ReadonlySet<string>): C | Dropped {
  let step: CheckedItem;
  try {
    [step] = checkItems(memory, [c.item]) as [CheckedItem];
  } catch (e) {
    return { problem: refusal(e) };
  }
  if (step.action === "create") return keysOf(c.item).some((k) => seen.has(k)) ? { problem: "the same note is already proposed" } : c;
  const item = newPartsOnly(memory, step.relPath, step.item, seen);
  if (!item.facts?.length && !item.events?.length) return { problem: "it repeats a pending Proposal or what the note already says" };
  return { ...c, item };
}

/** Why a save refuses a change, from the error its checks threw; any other error is thrown on. */
function refusal(e: unknown): string {
  if (e instanceof HttpError || e instanceof PolicyError) return `it fails the checks a save passes: ${e.message}`;
  throw e;
}

/** The update without the facts and events the note or a pending Proposal already holds. */
function newPartsOnly(memory: MemoryStore, relPath: string, item: UpdateItem, seen: ReadonlySet<string>): UpdateItem {
  const note = memory.describe(relPath);
  const body = norm(note.raw);
  const unchanged = (f: { subject: string; value: string; review?: string | undefined }) => {
    const current = note.state.find((e) => e.subject.toLowerCase() === f.subject.toLowerCase());
    return !!current && plainValue(current.value) === plainValue(f.value) && (!f.review || f.review === current.review);
  };
  const facts = (item.facts ?? []).filter((f) => !unchanged(f) && !seen.has(factKey(relPath, f)));
  const events = (item.events ?? []).filter((e) => !body.includes(norm(e)) && !seen.has(eventKey(relPath, e)));
  return { action: "update", path: relPath, ...(facts.length ? { facts } : {}), ...(events.length ? { events } : {}) };
}

/**
 * Give each fact one value per run, for a run that writes: when the model's
 * changes give the same fact of a note different values, only one is written,
 * and when two changes make the same new note, only one is written.
 * The change from the latest part of the source wins, as the newer word; within
 * one part the first wins, since the prompt lists the most important first.
 * Each other value or new note is dropped with its problem; a change left with nothing is dropped.
 * It chooses only among candidates that passed `checkCandidates`, so a change that
 * can never be written does not push out one that can.
 * A run tried again works from the model's answer its first attempt kept, so it picks
 * the same winner; it runs before `screenCandidates`, which depends on what the Brain
 * holds now, so a winner that attempt already wrote still wins, and no other value is
 * written over it.
 * Each drop names the candidate it comes from, so a caller can tell a drop of work
 * an earlier attempt already did from a drop of a change still to be made.
 */
export function oneValuePerFact<C extends Candidate & { part: number }>(candidates: readonly C[], noun: string): { kept: C[]; dropped: Array<DroppedFrom<C>> } {
  const dropped: Array<DroppedFrom<C>> = [];
  const winners = new Map<string, { index: number; value: string }>();
  const byPriority = candidates.map((c, index) => ({ c, index })).sort((a, b) => b.c.part - a.c.part || a.index - b.index);
  for (const { c, index } of byPriority) {
    for (const { key, value } of claimsOf(c.item)) if (!winners.has(key)) winners.set(key, { index, value });
  }
  const kept: C[] = [];
  for (const [index, c] of candidates.entries()) {
    if (c.item.action === "create") {
      if (winners.get(createKey(c.item))!.index === index) kept.push(c);
      else dropped.push({ candidate: c, problem: `it makes the new ${c.item.type} "${c.item.title}", but another change from the same ${noun} makes it too, and that one is kept instead` });
      continue;
    }
    if (!c.item.facts?.length) {
      kept.push(c);
      continue;
    }
    const { path, facts: all, ...rest } = c.item;
    const facts = all.filter((f) => {
      const winner = winners.get(fieldKey(path, f.subject))!;
      if (winner.index !== index) dropped.push({ candidate: c, problem: `it gives "${f.subject}" in ${path} the value "${f.value}", but another change from the same ${noun} gives it "${winner.value}", which is kept instead` });
      return winner.index === index;
    });
    if (facts.length || rest.events?.length) kept.push({ ...c, item: { ...rest, path, ...(facts.length ? { facts } : {}) } });
  }
  return { kept, dropped };
}

/** What a change claims one value for: the new note it makes, or each fact it sets. */
function claimsOf(item: MemorySaveItem): Array<{ key: string; value: string }> {
  if (item.action === "create") return [{ key: createKey(item), value: item.title }];
  return (item.facts ?? []).map((f) => ({ key: fieldKey(item.path, f.subject), value: f.value }));
}

/** Why an update's path is not a path in the Brain, or null when it is one. */
function pathProblem(item: MemorySaveItem): string | null {
  if (item.action !== "update") return null;
  try {
    brainRel(item.path);
    return null;
  } catch (e) {
    if (e instanceof PolicyError) return `it changes ${item.path}, which is not a path in the Brain: ${e.message}`;
    throw e;
  }
}

const fieldKey = (path: string, subject: string) => `${brainRel(path)}|${subject.toLowerCase()}`;
const createKey = (item: Extract<MemorySaveItem, { action: "create" }>) => `create|${item.type}|${slugify(item.title)}`;
const factKey = (relPath: string, f: { subject: string; value: string }) => `fact|${relPath}|${f.subject.toLowerCase()}|${plainValue(f.value)}`;
const eventKey = (relPath: string, text: string) => `event|${relPath}|${norm(text)}`;

/** What a change consists of, one key per part, so a repeat of any part can be recognised. */
function keysOf(item: MemorySaveItem): string[] {
  if (item.action === "create") return [createKey(item)];
  const relPath = brainRel(item.path);
  return [...(item.facts ?? []).map((f) => factKey(relPath, f)), ...(item.events ?? []).map((e) => eventKey(relPath, e))];
}
