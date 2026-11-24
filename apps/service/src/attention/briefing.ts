import { randomUUID } from "node:crypto";
import {
  type ActionStatus,
  type AttentionItemView,
  BRIEFING_HEADLINE_MAX,
  BRIEFING_TEXT_MAX,
  BRIEFING_TOP_PICKS,
  type BriefingSourceCoverage,
  type BriefingView,
  type BriefingsResponse,
  WAITING_ACTION_STATUSES,
} from "@attache/contracts";
import { type Db, json, nowIso, placeholders } from "../core/db.ts";
import { listItems } from "./engine.ts";
import { FACT_REVIEW_KIND } from "./fact-reviews.ts";
import { search } from "../memory/search.ts";
import { ProposalIndex } from "../memory/proposal-index.ts";
import { proposalHeadline } from "../memory/proposal-record.ts";
import { latestReplicatedBriefing, type BriefingWhich } from "./replicated-briefing.ts";

export type SourceCoverage = BriefingSourceCoverage;
export type BriefingSection = BriefingView["sections"][number];
export type Briefing = BriefingView;
/** A briefing before its summary is written and before it is saved as a deliverable. */
export type BriefingBase = Omit<Briefing, "summary" | "deliverablePath">;

const SECTION_OF: Record<string, { id: string; title: string }> = {
  deadline: { id: "deadlines", title: "Deadlines" },
  jira_overdue: { id: "deadlines", title: "Deadlines" },
  jira_due: { id: "deadlines", title: "Deadlines" },
  overdue: { id: "deadlines", title: "Deadlines" },
  due_soon: { id: "deadlines", title: "Deadlines" },
  review_request: { id: "reviews", title: "Review queue" },
  meeting_prep: { id: "meetings", title: "Meetings to prepare" },
  invite_response: { id: "meetings", title: "Meetings to prepare" },
  pending_reply: { id: "replies", title: "Pending replies" },
  mention: { id: "replies", title: "Pending replies" },
  [FACT_REVIEW_KIND]: { id: "facts", title: "Facts to check" },
};

function sectionFor(kind: string) {
  if (SECTION_OF[kind]) return SECTION_OF[kind]!;
  if (/due|overdue|deadline/.test(kind)) return SECTION_OF.deadline!;
  if (/reply|mention|dm/.test(kind)) return SECTION_OF.pending_reply!;
  if (/meeting|invite|event/.test(kind)) return SECTION_OF.meeting_prep!;
  return { id: "other", title: "Other" };
}

/** One line per Draft that waits for the owner (`WAITING_ACTION_STATUSES`), as the briefing's "Prepared for your review" says it. */
const PREPARED_SUMMARY = {
  draft: "Draft awaiting your review.",
  approved: "Approved, not yet sent.",
  revoked: "Approval revoked, waiting for your review.",
} as const satisfies Partial<Record<ActionStatus, string>>;

/** An item's own words fitted to one stored line: whitespace made single spaces, cut with an ellipsis at `max`. */
function ownLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** The lead and update words a briefing keeps when no model writes better ones: each item's own title and summary. */
function ownWords(item: Pick<AttentionItemView, "title" | "summary">): { headline: string; text: string } {
  const headline = ownLine(item.title, BRIEFING_HEADLINE_MAX) || "An open Inbox item";
  return { headline, text: ownLine(item.summary, BRIEFING_TEXT_MAX) || headline };
}

export function composeBriefing(db: Db, input: { kind: Briefing["kind"]; since: string | null; coverage: SourceCoverage[] }): BriefingBase {
  const items = listItems(db, { states: ["open"], limit: 200 });
  const last = db.prepare("select created_at from briefings order by created_at desc limit 1").get() as { created_at: string } | undefined;
  const since = input.since ?? last?.created_at ?? null;
  // The picks and their order are the Inbox's, by fixed rules; a model only words them later (`applyModelWords`).
  const topPicks = items.slice(0, BRIEFING_TOP_PICKS).map((item) => item.id);
  const picked = new Set(topPicks);
  const sections = new Map<string, BriefingSection>();
  let newCount = 0;
  let changedCount = 0;
  for (const it of items) {
    const s = sectionFor(it.kind);
    const isNew = !!since && it.firstSeenAt > since;
    const changed = !isNew && !!since && it.updatedAt > since;
    if (isNew) newCount++;
    if (changed) changedCount++;
    // An away summary leaves out what did not change, except the lead and the picks: their entries are the snapshot
    // the briefing page lists them from and the words the model writes the lead from.
    if (input.kind === "away" && since && !isNew && !changed && !picked.has(it.id)) continue;
    const entry: BriefingSection["items"][number] = { id: it.id, title: it.title, summary: it.summary, url: it.url, isNew, changed };
    if (s.id === "meetings") entry.related = relatedNotes(db, it);
    if (!sections.has(s.id)) sections.set(s.id, { id: s.id, title: s.title, items: [] });
    sections.get(s.id)!.items.push(entry);
  }
  const drafts = db.prepare(`select id, title, status from actions where status in (${placeholders(WAITING_ACTION_STATUSES)}) order by updated_at desc limit 20`).all(...WAITING_ACTION_STATUSES) as Array<{ id: string; title: string; status: keyof typeof PREPARED_SUMMARY }>;
  if (drafts.length) sections.set("prepared", { id: "prepared", title: "Prepared for your review", items: drafts.map((d) => ({ id: d.id, title: d.title, summary: PREPARED_SUMMARY[d.status], url: null, isNew: false, changed: false })) });
  const proposals = new ProposalIndex(db).list({ statuses: ["proposed"], limit: 20 });
  if (proposals.length) sections.set("memory", { id: "memory", title: "Memory changes to review", items: proposals.map((p) => ({ id: p.id, title: proposalHeadline(p), summary: `Proposed for ${p.target}`, url: null, isNew: false, changed: false })) });
  const order = ["deadlines", "reviews", "meetings", "replies", "prepared", "memory", "facts", "other"];
  const leadItem = items[0];
  const flagged = items.filter((item) => !!since && (item.firstSeenAt > since || item.updatedAt > since));
  return {
    id: randomUUID(),
    kind: input.kind,
    createdAt: nowIso(),
    since,
    sections: order.filter((o) => sections.has(o)).map((o) => sections.get(o)!),
    lead: leadItem ? { itemId: leadItem.id, headline: ownWords(leadItem).headline, explanation: ownWords(leadItem).text } : null,
    topPicks,
    updates: flagged.map((item) => ({ itemId: item.id, ...ownWords(item) })),
    coverage: input.coverage,
    counts: { open: items.length, new: newCount, changed: changedCount, drafts: drafts.length, proposals: proposals.length, failedSources: input.coverage.filter((c) => c.coverage && !["complete", "empty"].includes(c.coverage.state)).length },
  };
}

/** Meeting and team recall: notes that mention the meeting title or attendees, best passage per note. */
function relatedNotes(db: Db, item: AttentionItemView) {
  const q = `${item.title.replace(/^[^:]*:\s*/, "")} ${item.summary}`.slice(0, 300);
  const hits = search(db, q, { limit: 9, areas: ["memory", "import"], relativeCutoff: 0.5 });
  return hits
    .filter((h, n) => hits.findIndex((o) => o.relPath === h.relPath) === n)
    .slice(0, 3)
    .map((h) => ({ title: h.title, relPath: h.relPath, lines: [h.startLine, h.endLine] as [number, number] }));
}

export function deterministicSummary(b: Omit<Briefing, "summary" | "deliverablePath">): string {
  const parts: string[] = [];
  // An away summary keeps entries for its unchanged lead and picks; it counts only what is new or changed.
  const counted = (i: BriefingSection["items"][number]) => b.kind !== "away" || i.isNew || i.changed;
  const count = (id: string) => b.sections.find((s) => s.id === id)?.items.filter(counted).length ?? 0;
  if (!b.counts.open && !b.counts.drafts && !b.counts.proposals) parts.push("Nothing needs your attention right now.");
  else {
    const bits = [
      count("deadlines") && `${count("deadlines")} deadline${count("deadlines") === 1 ? "" : "s"}`,
      count("reviews") && `${count("reviews")} review request${count("reviews") === 1 ? "" : "s"}`,
      count("meetings") && `${count("meetings")} meeting${count("meetings") === 1 ? "" : "s"} to prepare`,
      count("replies") && `${count("replies")} pending repl${count("replies") === 1 ? "y" : "ies"}`,
      b.counts.drafts && `${b.counts.drafts} draft${b.counts.drafts === 1 ? "" : "s"} ready for review`,
      b.counts.proposals && `${b.counts.proposals} memory change${b.counts.proposals === 1 ? "" : "s"} to review`,
      count("facts") && `${count("facts")} fact${count("facts") === 1 ? "" : "s"} to check`,
      count("other") && `${count("other")} other item${count("other") === 1 ? "" : "s"}`,
    ].filter(Boolean);
    // An away summary is measured from the time the owner gave; the others from the last briefing.
    const baseline = b.kind === "away" ? "since the time you gave" : "since the last briefing";
    // Said only of an Inbox that has open items: with nothing open, the Drafts or Proposals named above are the summary.
    const nothingNew = b.kind === "away" && b.counts.open > 0 && !b.counts.new && !b.counts.changed;
    if (bits.length) parts.push(`${bits.join(", ")}.`);
    if (nothingNew) parts.push(`Nothing new or changed in your Inbox ${baseline}; ${b.counts.open} item${b.counts.open === 1 ? " is" : "s are"} still open.`);
    else if (b.counts.new || b.counts.changed) parts.push(`${b.counts.new} new and ${b.counts.changed} changed ${baseline}.`);
  }
  const failed = b.coverage.filter((c) => c.coverage && !["complete", "empty"].includes(c.coverage.state));
  if (failed.length) parts.push(`Incomplete: ${failed.map((f) => `${f.label} (${f.coverage!.state})`).join(", ")}: items from these sources may be missing.`);
  return parts.join(" ");
}

export function renderBriefingMarkdown(b: Briefing): string {
  const out = [`${b.summary}`, ""];
  for (const s of b.sections) {
    out.push(`## ${s.title}`);
    for (const i of s.items) {
      out.push(`- ${i.isNew ? "**New** " : i.changed ? "**Changed** " : ""}${i.title}: ${i.summary}${i.url ? ` ([link](${i.url}))` : ""}`);
      for (const r of i.related ?? []) out.push(`  - Related note: ${r.title} (${r.relPath}#L${r.lines[0]}-L${r.lines[1]})`);
    }
    out.push("");
  }
  out.push("## Source coverage");
  for (const c of b.coverage) out.push(`- ${c.label}: ${c.coverage?.state ?? "never refreshed"}${c.lastSuccessAt ? `, last success ${c.lastSuccessAt}` : ""}${c.coverage?.note ? ` - ${c.coverage.note}` : ""}`);
  return out.join("\n");
}

export function saveBriefing(db: Db, b: Briefing, jobId: string | null) {
  db.prepare("insert into briefings (id, created_at, kind, summary, items, coverage, job_id, deliverable_path) values (?,?,?,?,?,?,?,?)").run(b.id, b.createdAt, b.kind, b.summary, JSON.stringify({ sections: b.sections, lead: b.lead, topPicks: b.topPicks, updates: b.updates, counts: b.counts, since: b.since }), JSON.stringify(b.coverage), jobId, b.deliverablePath);
}

/** The newer of two briefings, either of which may be missing. */
const newer = (a: Briefing | null, b: Briefing | null) => (!a || !b ? (a ?? b) : b.createdAt > a.createdAt ? b : a);

/**
 * The newest briefing this Machine knows: its own, or one another Machine (the
 * Reader) made and Replication brought in as a deliverable.
 */
export function latestBriefing(db: Db): Briefing | null {
  return newer(latestOwnBriefing(db, "any"), latestReplicatedBriefing(db, "any"));
}

/** `GET /briefings`: the newest Daily Briefing, and the newest away summary or briefing asked for, own or replicated. */
export function latestBriefings(db: Db): BriefingsResponse {
  return {
    daily: newer(latestOwnBriefing(db, "daily"), latestReplicatedBriefing(db, "daily")),
    requested: newer(latestOwnBriefing(db, "requested"), latestReplicatedBriefing(db, "requested")),
  };
}

const OWN_KIND_FILTER: Readonly<Record<BriefingWhich, string>> = { any: "", daily: "where kind = 'daily'", requested: "where kind != 'daily'" };

interface StoredItems {
  sections: BriefingSection[];
  lead?: Briefing["lead"];
  topPicks?: string[];
  updates?: Briefing["updates"];
  counts: Briefing["counts"];
  since: string | null;
}

/** The newest briefing of `which` this Machine made itself. One written before the lead and picks existed has none. */
function latestOwnBriefing(db: Db, which: BriefingWhich): Briefing | null {
  const r = db.prepare(`select * from briefings ${OWN_KIND_FILTER[which]} order by created_at desc limit 1`).get() as Record<string, unknown> | undefined;
  if (!r) return null;
  const items = json<StoredItems>(r.items, { sections: [], counts: { open: 0, new: 0, changed: 0, drafts: 0, proposals: 0, failedSources: 0 }, since: null });
  return {
    id: String(r.id),
    kind: r.kind as Briefing["kind"],
    createdAt: String(r.created_at),
    since: items.since,
    summary: String(r.summary),
    sections: items.sections,
    lead: items.lead ?? null,
    topPicks: items.topPicks ?? [],
    updates: items.updates ?? [],
    counts: items.counts,
    coverage: json(r.coverage, []),
    deliverablePath: (r.deliverable_path as string) ?? null,
  };
}
