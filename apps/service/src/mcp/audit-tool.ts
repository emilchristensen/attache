import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { renderAudit } from "../memory/audit-view.ts";
import type { BrainAccess } from "./brain.ts";
import { failure } from "./failure.ts";

const EvidenceShape = z.object({ path: z.string(), title: z.string(), startLine: z.number().int(), endLine: z.number().int(), snippet: z.string(), modified: z.string() });

const EntryShape = z.object({
  subject: z.string(),
  value: z.string(),
  date: z.string(),
  review: z.string().nullable(),
  ageDays: z.number().int(),
  source: z.string().nullable(),
  line: z.number().int(),
  flags: z.array(z.string()),
  newerEvidence: z.array(EvidenceShape),
});

const AuditShape = {
  generatedAt: z.string(),
  staleDays: z.number().int(),
  notes: z.number().int(),
  entries: z.number().int(),
  counts: z.record(z.string(), z.number().int()),
  findings: z.array(z.object({ path: z.string(), title: z.string(), type: z.string(), inSessionIndex: z.boolean(), flags: z.array(z.string()), entries: z.array(EntryShape) })),
  possibleDuplicates: z.array(z.object({ title: z.string(), paths: z.array(z.string()) })),
};

const DESCRIPTION = [
  "Audit the owner's Brain for facts that may have stopped being true. Writes nothing.",
  "Returns every current fact in every note with its date, Review date (the day after which it should be checked again, or null), age, source and flags (stale, unsourced, missing-source, duplicate-subject), plus newer passages that name the note: where a contradiction would show up.",
  "Notes whose first fact every new session reads come first. The flags are leads, not verdicts: read the newer passages before judging a fact.",
].join(" ");

/** `audit`: the deterministic half of a memory audit, for the agent to judge. */
export function registerAuditTool(server: McpServer, brain: BrainAccess): void {
  server.registerTool(
    "audit",
    { title: "Audit the Brain", description: DESCRIPTION, inputSchema: {}, outputSchema: AuditShape, annotations: { readOnlyHint: true, openWorldHint: false } },
    async () => {
      try {
        const report = await brain.audit();
        return { content: [{ type: "text", text: renderAudit(report) }], structuredContent: { ...report } };
      } catch (e) {
        return failure(e);
      }
    },
  );
}
