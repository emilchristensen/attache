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

const StoredBriefing = BriefingViewSchema.omit({ deliverablePath: true });

/** What a briefing's deliverable carries in its frontmatter. */
export function briefingFrontmatter(b: Omit<Briefing, "deliverablePath">): Record<string, unknown> {
  const { id, kind, createdAt, since, summary, sections, lead, topPicks, updates, coverage, counts } = b;
  return { [BRIEFING_KEY]: { id, kind, createdAt, since, summary, sections, lead, topPicks, updates, coverage, counts } };
}

/** The newest briefing among the deliverables in this Machine's copy of the Brain, or null when none carries one. */
export function latestReplicatedBriefing(db: Db): Briefing | null {
  const rows = db
    .prepare(
      `select rel_path as relPath, meta from documents
       where root = 'data' and doc_type = 'briefing' and json_extract(meta, '$.${BRIEFING_KEY}.createdAt') is not null
       order by json_extract(meta, '$.${BRIEFING_KEY}.createdAt') desc limit 5`,
    )
    .all() as Array<{ relPath: string; meta: string }>;
  for (const row of rows) {
    const parsed = StoredBriefing.safeParse((JSON.parse(row.meta) as Record<string, unknown>)[BRIEFING_KEY]);
    // A file another Machine or an editor left malformed is skipped; the next newest is shown.
    if (parsed.success) return { ...(parsed.data as Omit<Briefing, "deliverablePath">), deliverablePath: row.relPath };
  }
  return null;
}
