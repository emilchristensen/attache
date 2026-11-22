import { BriefingViewSchema } from "@attache/contracts";
import type { Db } from "../core/db.ts";
import type { Briefing } from "./briefing.ts";

/**
 * A briefing as its deliverable in the Brain carries it, in the frontmatter
 * key `briefing`, so every Machine's Dashboard shows the Reader's latest
 * briefing, not only the Machine that made it. Read back from another
 * Machine's file, so it is checked before it is shown.
 */
export const BRIEFING_KEY = "briefing";

/** A briefing in a deliverable's frontmatter; one a Machine wrote before briefings had a lead and picks has none. */
const StoredBriefing = BriefingViewSchema.omit({ deliverablePath: true }).extend({
  lead: BriefingViewSchema.shape.lead.default(null),
  topPicks: BriefingViewSchema.shape.topPicks.default([]),
  updates: BriefingViewSchema.shape.updates.default([]),
});

/** What a briefing's deliverable carries in its frontmatter. */
export function briefingFrontmatter(b: Omit<Briefing, "deliverablePath">): Record<string, unknown> {
  const { id, kind, createdAt, since, summary, sections, lead, topPicks, updates, coverage, counts } = b;
  return { [BRIEFING_KEY]: { id, kind, createdAt, since, summary, sections, lead, topPicks, updates, coverage, counts } };
}

/** Which briefings a lookup wants: any kind, the Daily Briefing, or an away summary or one the owner asked for. */
export type BriefingWhich = "any" | "daily" | "requested";

const KIND_FILTER: Readonly<Record<BriefingWhich, string>> = {
  any: "",
  daily: `and json_extract(meta, '$.${BRIEFING_KEY}.kind') = 'daily'`,
  requested: `and json_extract(meta, '$.${BRIEFING_KEY}.kind') != 'daily'`,
};

/**
 * The newest briefing of `which` among the deliverables in this Machine's copy of the Brain, or null when none
 * carries one. Each is checked against the contract's schema before it is shown.
 */
export function latestReplicatedBriefing(db: Db, which: BriefingWhich = "any"): Briefing | null {
  const rows = db
    .prepare(
      `select rel_path as relPath, meta from documents
       where root = 'data' and doc_type = 'briefing' and json_extract(meta, '$.${BRIEFING_KEY}.createdAt') is not null ${KIND_FILTER[which]}
       order by json_extract(meta, '$.${BRIEFING_KEY}.createdAt') desc limit 5`,
    )
    .all() as Array<{ relPath: string; meta: string }>;
  for (const row of rows) {
    const parsed = StoredBriefing.safeParse((JSON.parse(row.meta) as Record<string, unknown>)[BRIEFING_KEY]);
    // A file another Machine or an editor left malformed is skipped; the next newest is shown.
    if (parsed.success) return { ...parsed.data, deliverablePath: row.relPath };
  }
  return null;
}
