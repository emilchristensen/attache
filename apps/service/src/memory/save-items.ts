import type { MemorySaveItem } from "@jarvis/contracts";
import { HttpError } from "../http/router.ts";
import { slugify } from "./markdown.ts";
import { isProtected, normalizeRel } from "./policy.ts";
import { isRepositorySubject, parseRepositoryList } from "./repositories.ts";
import type { ChangeMeta, MemoryStore, SourceRef } from "./store.ts";

type CreateItem = Extract<MemorySaveItem, { action: "create" }>;
type UpdateItem = Extract<MemorySaveItem, { action: "update" }>;

/** A save item that passed validation, with the note it targets resolved. */
export type CheckedItem = { action: "create"; item: CreateItem } | { action: "update"; item: UpdateItem; relPath: string; title: string };

/** Who writes a checked item: the owner directly, or the service applying a Proposal the owner approved. */
export type ItemWriter = { actor: "user"; provenance: "agent-saved" } | { actor: "service"; provenance: "user-approved" };

export interface WrittenItem {
  action: "created" | "updated";
  relPath: string;
  title: string;
  facts: number;
  events: number;
}

/**
 * Check every item against the Brain before anything is written, so a bad path,
 * a duplicate note or the identity record rejects the whole set. Saves and
 * Proposals both pass through here, so they follow the same rules.
 */
export function checkItems(memory: MemoryStore, items: readonly MemorySaveItem[]): CheckedItem[] {
  const plan = items.map((item) => (item.action === "create" ? checkCreate(memory, item) : checkUpdate(memory, item)));
  const creating = new Set<string>();
  for (const step of plan) {
    if (step.action !== "create") continue;
    const key = `${step.item.type}:${slugify(step.item.title)}`;
    if (creating.has(key)) throw new HttpError(400, "invalid_request", `The save creates the ${step.item.type} note "${step.item.title}" twice. Merge the two items.`);
    creating.add(key);
  }
  return plan;
}

/**
 * Write one checked item to its note in a single file write, so every part lands or none does.
 * `meta` goes into the change log with every change: items written together share one batch id.
 */
export function writeItem(memory: MemoryStore, step: CheckedItem, source: SourceRef | null, writer: ItemWriter, meta: ChangeMeta): WrittenItem {
  // An event names its source briefly; the full citation is in the note's sources and in the change log.
  const label = source ? (source.label ?? `${source.kind}: ${source.ref}`) : null;
  const events = (step.item.events ?? []).map((text) => (label ? `${text} (source: ${label})` : text));
  const opts = { approvedProposal: writer.actor === "service" };
  if (step.action === "create") {
    const { item } = step;
    const { relPath } = memory.createMemory(
      { type: item.type, title: item.title, state: item.facts, ...(item.notes?.trim() ? { notes: item.notes } : {}), sources: source ? [source] : [], provenance: writer.provenance, ...(item.tags?.length ? { tags: item.tags } : {}), events },
      writer.actor,
      opts,
      meta,
    );
    return { action: "created", relPath, title: item.title, facts: item.facts.length, events: events.length };
  }
  const { item, relPath, title } = step;
  const facts = item.facts ?? [];
  memory.update(relPath, { facts, events, ...(source ? { source } : {}) }, writer.actor, opts, meta);
  return { action: "updated", relPath, title, facts: facts.length, events: events.length };
}

function uniqueSubjects(facts: ReadonlyArray<{ subject: string }>, where: string) {
  const seen = new Set<string>();
  for (const f of facts) {
    const key = f.subject.toLowerCase();
    if (seen.has(key)) throw new HttpError(400, "invalid_request", `${where} sets "${f.subject}" twice. Give each subject one current value.`);
    seen.add(key);
  }
}

/** A saved fact is dated today, and its Review date must come after its own date. */
function reviewDatesAfterToday(today: string, facts: ReadonlyArray<{ subject: string; review?: string | undefined }>, where: string) {
  for (const f of facts) {
    if (f.review && f.review <= today)
      throw new HttpError(400, "invalid_request", `${where} gives "${f.subject}" the Review date ${f.review}, which is not after today (${today}). A Review date is the day after which the fact should be checked again, so it must come after the fact's own date.`);
  }
}

/** A new note must not duplicate one Jarvis already has: the same type and title is an update, not a second note. */
function checkCreate(memory: MemoryStore, item: CreateItem): CheckedItem {
  uniqueSubjects(item.facts, `"${item.title}"`);
  reviewDatesAfterToday(memory.today(), item.facts, `"${item.title}"`);
  if (item.type === "project") checkRepositories(item.facts, `"${item.title}"`);
  const slug = slugify(item.title);
  const twin = memory.listDocuments({ area: "memory", root: "data", docType: item.type, limit: 2000 }).find((d) => slugify(d.title) === slug);
  if (twin) throw new HttpError(409, "already_exists", `A ${item.type} note "${twin.title}" already exists at ${twin.relPath}. Update it instead of creating another.`, { relPath: twin.relPath });
  return { action: "create", item };
}

function checkUpdate(memory: MemoryStore, item: UpdateItem): CheckedItem {
  const relPath = normalizeRel(item.path.replace(/^\.\//, ""));
  if (!relPath.startsWith("memory/") || !relPath.endsWith(".md")) throw new HttpError(400, "not_memory", `${item.path} is not a memory note. Only notes under memory/ can be updated.`);
  if (isProtected(relPath)) throw new HttpError(403, "protected", `${relPath} is your identity record; change it in Jarvis Settings.`);
  if (!memory.exists(relPath)) throw new HttpError(404, "not_found", `${relPath} does not exist. Search for the note, or create a new one.`);
  if (!item.facts?.length && !item.events?.length) throw new HttpError(400, "invalid_request", `The update to ${relPath} has no facts or events.`);
  uniqueSubjects(item.facts ?? [], relPath);
  reviewDatesAfterToday(memory.today(), item.facts ?? [], relPath);
  const note = memory.describe(relPath);
  // The note's type as the index reads it: its frontmatter, else its folder.
  const type = typeof note.frontmatter.type === "string" ? note.frontmatter.type : relPath.split("/")[1]?.replace(/s$/, "");
  if (type === "project") checkRepositories(item.facts ?? [], relPath);
  return { action: "update", item, relPath, title: note.title };
}

/** A project's `Repositories` fact is what picks its session context, so every entry in it must be a repository. */
function checkRepositories(facts: ReadonlyArray<{ subject: string; value: string }>, where: string) {
  for (const f of facts.filter((f) => isRepositorySubject(f.subject))) {
    const { keys, invalid } = parseRepositoryList(f.value);
    if (invalid.length || !keys.length)
      throw new HttpError(
        400,
        "invalid_request",
        `${where} lists ${invalid.length ? invalid.map((e) => `"${e}"`).join(", ") : "nothing"} under ${f.subject}, which must name git repositories only: owner/name for GitHub, host/owner/name, or a remote address such as git@github.com:owner/name.git, separated by commas.`,
      );
  }
}
