import type { ProposalView, RecentChangeView } from "@attache/contracts";

/** The Brain's collections, in the Library's order. The first is where the Library opens. */
export const COLLECTIONS = [
  { id: "person", label: "People", one: "Person", query: "area=memory&type=person", folder: "people" },
  { id: "project", label: "Projects", one: "Project", query: "area=memory&type=project", folder: "projects" },
  { id: "decision", label: "Decisions", one: "Decision", query: "area=memory&type=decision", folder: "decisions" },
  { id: "note", label: "Notes", one: "Note", query: "area=memory&type=note", folder: "notes" },
  { id: "import", label: "Imported", one: "Imported note", query: "area=import", folder: null },
  { id: "evidence", label: "Evidence", one: "Evidence", query: "area=evidence", folder: null },
  { id: "deliverables", label: "Deliverables", one: "Deliverable", query: "area=deliverables", folder: null },
] as const;
export type CollectionId = (typeof COLLECTIONS)[number]["id"];
export type Collection = (typeof COLLECTIONS)[number];

export function collection(id: CollectionId): Collection {
  return COLLECTIONS.find((c) => c.id === id)!;
}

const isCollection = (id: string | null): id is CollectionId => COLLECTIONS.some((c) => c.id === id);

/** The curated collection a note in the data folder belongs to, from its folder; null for anything else. */
export function collectionOf(relPath: string): CollectionId | null {
  const m = /^memory\/([^/]+)\//.exec(relPath);
  return COLLECTIONS.find((c) => c.folder !== null && c.folder === m?.[1])?.id ?? null;
}

/** Recent saves' filters: every change, those written without review, and those reverted. */
export const RECENT_FILTERS = [
  { id: "all", label: "All" },
  { id: "unreviewed", label: "Written without review" },
  { id: "reverted", label: "Reverted" },
] as const;
export type RecentFilter = (typeof RECENT_FILTERS)[number]["id"];

export function recentFilterAt(search: URLSearchParams): RecentFilter {
  const show = search.get("show");
  return RECENT_FILTERS.find((f) => f.id === show)?.id ?? "all";
}

/**
 * The changes a filter keeps. Without review means an auto-accepted save or a Consolidation write. Reverted keeps
 * a reverted change and the revert that undid it, so the pair reads together.
 */
export function filterChanges(changes: readonly RecentChangeView[], filter: RecentFilter): RecentChangeView[] {
  switch (filter) {
    case "all":
      return [...changes];
    case "unreviewed":
      return changes.filter((c) => c.source.autoAccepted);
    case "reverted":
      return changes.filter((c) => c.revertedBy !== null || c.revertOf !== null);
  }
}

/** Where the owner is in the Brain, as the address says. */
export type BrainPlace =
  | { view: "library"; collection: CollectionId; root: string; path: string | null; q: string }
  | { view: "recent"; show: RecentFilter };

export function brainPlace(path: string, search: URLSearchParams): BrainPlace {
  if (path === "/brain/recent") return { view: "recent", show: recentFilterAt(search) };
  const note = search.get("path");
  const tab = search.get("tab");
  const fromNote = note ? collectionOf(note) : null;
  const collection = isCollection(tab) ? tab : (fromNote ?? COLLECTIONS[0].id);
  return { view: "library", collection, root: search.get("root") ?? "data", path: note, q: (search.get("q") ?? "").trim() };
}

/** What `brainHref` takes: a view, and for the Library any of its parts. */
export type BrainLink = { view: "recent"; show?: RecentFilter } | { view: "library"; collection?: CollectionId; root?: string; path?: string | null; q?: string };

/** The address of a place in the Brain: `/brain?root=&path=&tab=&q=`, or `/brain/recent?show=`. */
export function brainHref(link: BrainLink): string {
  const params = new URLSearchParams();
  if (link.view === "recent") {
    if (link.show && link.show !== "all") params.set("show", link.show);
  } else {
    if (link.path) {
      params.set("root", link.root ?? "data");
      params.set("path", link.path);
    }
    if (link.collection) params.set("tab", link.collection);
    const q = link.q?.trim();
    if (q) params.set("q", q);
  }
  const search = params.toString();
  return `${link.view === "recent" ? "/brain/recent" : "/brain"}${search ? `?${search}` : ""}`;
}

/** What the Library's source button opens: a file Attache indexes, at the cited lines, or a web page. */
export type SourceOpen = { kind: "file"; root: string; relPath: string; lines?: [number, number] } | { kind: "url"; url: string };

export interface FactSource {
  /** The source exactly as the note stores it. */
  text: string;
  /** A few words for the button: its label, else its kind, else a short source itself; null when none fit. */
  summary: string | null;
  /** What kind of source it is, in the owner's words; null when the note does not say. */
  kind: string | null;
  /** The day it was observed (YYYY-MM-DD); null when the note does not say. */
  observed: string | null;
  open: SourceOpen | null;
}

const KIND_WORDS: Readonly<Record<string, string>> = {
  capture: "Capture",
  note: "Note",
  import: "Imported note",
  connector: "Connector",
  conversation: "Conversation",
  user: "You",
  "agent-session": "Harness session",
};
/** `label (kind: where, observed YYYY-MM-DD)`, as the service writes a source. */
const SOURCE_RE = /^(.*?)\s*\((capture|note|import|connector|conversation|user|agent-session): (.+), observed (\d{4}-\d{2}-\d{2})\)$/;
/** Longest hand-written source shown on the button itself. */
const SHORT_SOURCE = 40;
const DATA_FILE = /^(?:memory|evidence|deliverables)\/.+\.md$/;
const IMPORT_FILE = /^(import:[^:]+):(.+\.md)$/;

function webPage(text: string): string | null {
  if (!/^https?:\/\//.test(text)) return null;
  try {
    return new URL(text).href;
  } catch {
    return null;
  }
}

/** A cited place: a web page, a file in the data folder, or a file in an imported folder, with its lines. */
function placeOf(where: string): SourceOpen | null {
  const url = webPage(where);
  if (url) return { kind: "url", url };
  const m = /^(.*?)(?:#L(\d+)-L(\d+))?$/.exec(where)!;
  const lines: [number, number] | undefined = m[2] ? [Number(m[2]), Number(m[3])] : undefined;
  const file = m[1]!;
  const imported = IMPORT_FILE.exec(file);
  const target = DATA_FILE.test(file) ? { root: "data", relPath: file } : imported ? { root: imported[1]!, relPath: imported[2]! } : null;
  return target ? { kind: "file", ...target, ...(lines ? { lines } : {}) } : null;
}

/** A fact's source, read from the words the note stores, for the source button and what it expands to. */
export function parseSource(text: string): FactSource {
  const m = SOURCE_RE.exec(text);
  if (m) {
    const kind = KIND_WORDS[m[2]!]!;
    return { text, summary: m[1] || kind, kind, observed: m[4]!, open: placeOf(m[3]!) };
  }
  const url = webPage(text);
  if (url) return { text, summary: new URL(url).hostname, kind: null, observed: null, open: { kind: "url", url } };
  return { text, summary: text.length <= SHORT_SOURCE ? text : null, kind: null, observed: null, open: null };
}

/** The Proposals waiting for the owner's OK that change this note. */
export function waitingProposalsFor(relPath: string, proposals: readonly ProposalView[]): ProposalView[] {
  return proposals.filter((p) => p.status === "proposed" && p.target === relPath);
}

export function waitingProposalWords(n: number): string {
  return n === 1 ? "A change to this note waits for your OK." : `${n} changes to this note wait for your OK.`;
}

/** The lines under a level-two heading (any case), up to the next level-two heading; null without the heading. */
function section(raw: string, heading: string): string[] | null {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${heading}\\s*$`, "i").test(l));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

/**
 * What the reader shows of a note beyond its Current state: the Notes prose, and History's entries exactly as stored
 * (each line after its list dash; the comment Attache writes under the heading is left out).
 */
export function noteSections(raw: string): { notes: string | null; history: string[] } {
  const notes = section(raw, "notes")?.join("\n").trim() || null;
  const history = (section(raw, "history") ?? []).filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
  return { notes, history };
}
