import { z } from "zod";
import type { Db } from "../core/db.ts";
import type { Briefing } from "./briefing.ts";

/**
 * A briefing as its deliverable in the Brain carries it, in the frontmatter
 * key `briefing`, so every Machine's Dashboard shows the Reader's latest
 * briefing, not only the Machine that made it. Read back from another
 * Machine's file, so it is checked before it is shown.
 */
export const BRIEFING_KEY = "briefing";

const Related = z.object({ title: z.string(), relPath: z.string(), lines: z.tuple([z.number(), z.number()]) });
const Item = z.object({ id: z.string(), title: z.string(), summary: z.string(), url: z.string().nullable(), isNew: z.boolean(), changed: z.boolean(), related: z.array(Related).optional() });
const Section = z.object({ id: z.string(), title: z.string(), items: z.array(Item) });
const Scope = z.object({ scope: z.string(), state: z.string(), items: z.number(), pages: z.number(), note: z.string().optional() });
const Coverage = z.object({ state: z.string(), scopes: z.array(Scope), items: z.number(), at: z.string(), note: z.string().optional() });
const SourceCoverage = z.object({ id: z.string(), label: z.string(), kind: z.string(), coverage: Coverage.nullable(), lastSuccessAt: z.string().nullable(), status: z.string() });
const Counts = z.object({ open: z.number(), new: z.number(), changed: z.number(), drafts: z.number(), proposals: z.number(), failedSources: z.number() });

const StoredBriefing = z.object({
  id: z.string().min(1),
  kind: z.enum(["daily", "away", "manual"]),
  createdAt: z.iso.datetime(),
  since: z.string().nullable(),
  summary: z.string(),
  sections: z.array(Section),
  coverage: z.array(SourceCoverage),
  counts: Counts,
});

/** What a briefing's deliverable carries in its frontmatter. */
export function briefingFrontmatter(b: Omit<Briefing, "deliverablePath">): Record<string, unknown> {
  const { id, kind, createdAt, since, summary, sections, coverage, counts } = b;
  return { [BRIEFING_KEY]: { id, kind, createdAt, since, summary, sections, coverage, counts } };
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
