import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ServicePaths } from "../core/paths.ts";
import { MeaningState } from "@attache/contracts";
import { serviceBrain, type BrainAccess, type BrainOverview, type NoteText, type Passage, type SearchAnswer } from "./brain.ts";
import { buildInstructions } from "./instructions.ts";
import { registerAuditTool } from "./audit-tool.ts";
import { failure } from "./failure.ts";
import { registerPrompts } from "./prompts.ts";
import { registerSaveTool } from "./save-tool.ts";
import type { ServerContext } from "./harness.ts";
import { registerWrapUpTool } from "./wrap-up-tool.ts";
import { withUpdateNotice } from "./update-notice.ts";
import { unverifiedLabel } from "../memory/review-date.ts";
import type { Clock } from "../replication/clock.ts";

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 30;
/** How long a starting Harness waits for the Brain's index before connecting without it. */
const OVERVIEW_TIMEOUT_MS = 5_000;

const SECTION_LABEL: Record<Passage["section"], string> = { state: "current state", history: "history", body: "body" };

const PassageShape = z.object({
  path: z.string(),
  startLine: z.number().int(),
  endLine: z.number().int(),
  area: z.string(),
  section: z.enum(["state", "history", "body"]),
  heading: z.string().nullable(),
  title: z.string(),
  text: z.string(),
  review: z.string().nullable().describe("A current fact's Review date (YYYY-MM-DD): the day after which it should be checked again."),
  unverified: z.boolean().describe("True for a current fact past its Review date: check it before relying on it."),
});

const NoteShape = {
  path: z.string(),
  title: z.string(),
  startLine: z.number().int(),
  endLine: z.number().int(),
  totalLines: z.number().int(),
  text: z.string(),
  unverified: z.array(z.object({ subject: z.string(), review: z.string(), line: z.number().int() })).describe("Current facts in the returned lines that are past their Review date."),
};

function renderPassages(query: string, { passages, meaning }: SearchAnswer): string {
  const note = meaning.note ? `${meaning.note}\n\n` : "";
  if (!passages.length) return `${note}No passages in the Brain match "${query}".`;
  return (
    note +
    passages
      .map((p) => `${p.path}:${p.startLine}-${p.endLine} · ${p.title} · ${p.area} · ${SECTION_LABEL[p.section]}${p.heading ? ` › ${p.heading}` : ""}${p.unverified && p.review ? ` · ${unverifiedLabel(p.review)}` : ""}\n${p.text.replace(/^/gm, "    ")}`)
      .join("\n\n")
  );
}

function renderNote(n: NoteText): string {
  const unverified = n.unverified.length ? `\nUnverified (past their Review date): ${n.unverified.map((u) => `${u.subject} (review ${u.review}, line ${u.line})`).join("; ")}` : "";
  return `${n.path} · ${n.title} · lines ${n.startLine}-${n.endLine} of ${n.totalLines}${unverified}\n\n${n.text}`;
}

/** The MCP server a Harness talks to, over any transport. */
/** `clock` times the owner's confirmation of a save; the system clock when left out. */
export function createMcpServer(brain: BrainAccess, info: { version: string; instructions: string; context: ServerContext; clock?: Clock }): McpServer {
  const server = withUpdateNotice(new McpServer({ name: "attache", title: "Attache", version: info.version }, { instructions: info.instructions }), info.version, () => brain.serviceVersion());
  server.registerTool(
    "search",
    {
      title: "Search the Brain",
      description: "Search the owner's Brain by words. Returns passages with their path, line range, area, section kind (current state, history or body) and note title. A current fact past its Review date is marked unverified: it may no longer be true, so check it before relying on it. Only passages from area `memory` state current facts; `evidence` records what was observed or said, such as session logs and wrap-ups. Old chat archives and raw session transcripts are left out; session summaries are included.",
      inputSchema: { query: z.string().trim().min(1).max(500).describe("What to look for, in the words the note would use."), limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Most passages to return (default ${DEFAULT_LIMIT}).`) },
      outputSchema: { passages: z.array(PassageShape), meaning: z.object({ state: MeaningState, note: z.string().nullable() }) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      try {
        const answer = await brain.search(query, limit ?? DEFAULT_LIMIT);
        return { content: [{ type: "text", text: renderPassages(query, answer) }], structuredContent: { ...answer } };
      } catch (e) {
        return failure(e);
      }
    },
  );
  server.registerTool(
    "read",
    {
      title: "Read a note",
      description: "Read a note from the Brain, whole or only a line range. Pass a path exactly as `search` returned it; line numbers are 1-based and inclusive. Current facts past their Review date are listed as unverified.",
      inputSchema: {
        path: z.string().trim().min(1).max(1000).describe("The note's path from a search result, e.g. memory/projects/orion.md."),
        startLine: z.number().int().min(1).optional().describe("First line to return (default 1)."),
        endLine: z.number().int().min(1).optional().describe("Last line to return (default the note's last line)."),
      },
      outputSchema: NoteShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path, startLine, endLine }) => {
      try {
        const note = await brain.read(path, { startLine, endLine });
        return { content: [{ type: "text", text: renderNote(note) }], structuredContent: { ...note } };
      } catch (e) {
        return failure(e);
      }
    },
  );
  registerAuditTool(server, brain);
  registerPrompts(server);
  registerSaveTool(server, brain, info.context, info.clock);
  registerWrapUpTool(server, brain, info.context);
  return server;
}

async function fetchOverview(brain: BrainAccess): Promise<{ overview: BrainOverview } | { error: string }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Attache did not answer within ${OVERVIEW_TIMEOUT_MS / 1000} seconds.`)), OVERVIEW_TIMEOUT_MS);
  });
  try {
    return { overview: await Promise.race([brain.overview(), timeout]) };
  } catch (e) {
    return { error: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `attache mcp`: serve the Brain to the Harness that started this process, over
 * stdio. It pairs with the running service the way the CLI does, so a
 * Harness's configuration names only the command, never a token. It starts
 * even while the service is stopped, so the Harness can say how to start it.
 */
export async function runMcpServer(paths: ServicePaths, version: string): Promise<void> {
  const brain = serviceBrain(paths);
  const found = await fetchOverview(brain);
  const instructions = "overview" in found ? buildInstructions(found.overview) : buildInstructions(null, found.error);
  await createMcpServer(brain, { version, instructions, context: { env: process.env, cwd: process.cwd() } }).connect(new StdioServerTransport());
}
