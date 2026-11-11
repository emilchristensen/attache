import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ServicePaths } from "../core/paths.ts";
import { serviceBrain, type BrainAccess, type BrainOverview, type NoteText, type Passage } from "./brain.ts";
import { buildInstructions } from "./instructions.ts";
import { registerAuditTool } from "./audit-tool.ts";
import { failure } from "./failure.ts";
import { registerPrompts } from "./prompts.ts";

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 30;
/** How long a starting Harness waits for the Brain's index before connecting without it. */
const OVERVIEW_TIMEOUT_MS = 5_000;

const SECTION_LABEL: Record<Passage["section"], string> = { state: "current state", history: "history", body: "body" };

const PassageShape = z.object({
  path: z.string(),
  startLine: z.number().int(),
  endLine: z.number().int(),
  section: z.enum(["state", "history", "body"]),
  heading: z.string().nullable(),
  title: z.string(),
  text: z.string(),
});

const NoteShape = { path: z.string(), title: z.string(), startLine: z.number().int(), endLine: z.number().int(), totalLines: z.number().int(), text: z.string() };

function renderPassages(query: string, passages: Passage[]): string {
  if (!passages.length) return `No passages in the Brain match "${query}".`;
  return passages.map((p) => `${p.path}:${p.startLine}-${p.endLine} · ${p.title} · ${SECTION_LABEL[p.section]}${p.heading ? ` › ${p.heading}` : ""}\n${p.text.replace(/^/gm, "    ")}`).join("\n\n");
}

function renderNote(n: NoteText): string {
  return `${n.path} · ${n.title} · lines ${n.startLine}-${n.endLine} of ${n.totalLines}\n\n${n.text}`;
}

/** The MCP server a Harness talks to, over any transport. */
export function createMcpServer(brain: BrainAccess, info: { version: string; instructions: string }): McpServer {
  const server = new McpServer({ name: "jarvis", title: "Jarvis", version: info.version }, { instructions: info.instructions });
  server.registerTool(
    "search",
    {
      title: "Search the Brain",
      description: "Search the owner's Brain by words. Returns passages with their path, line range, section kind (current state, history or body) and note title. Old chat archives and raw session transcripts are left out; session summaries are included.",
      inputSchema: { query: z.string().trim().min(1).max(500).describe("What to look for, in the words the note would use."), limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Most passages to return (default ${DEFAULT_LIMIT}).`) },
      outputSchema: { passages: z.array(PassageShape) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      try {
        const passages = await brain.search(query, limit ?? DEFAULT_LIMIT);
        return { content: [{ type: "text", text: renderPassages(query, passages) }], structuredContent: { passages } };
      } catch (e) {
        return failure(e);
      }
    },
  );
  server.registerTool(
    "read",
    {
      title: "Read a note",
      description: "Read a note from the Brain, whole or only a line range. Pass a path exactly as `search` returned it; line numbers are 1-based and inclusive.",
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
  return server;
}

async function fetchOverview(brain: BrainAccess): Promise<{ overview: BrainOverview } | { error: string }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Jarvis did not answer within ${OVERVIEW_TIMEOUT_MS / 1000} seconds.`)), OVERVIEW_TIMEOUT_MS);
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
 * `jarvis mcp`: serve the Brain to the Harness that started this process, over
 * stdio. It pairs with the running service the way the CLI does, so a
 * Harness's configuration names only the command, never a token. It starts
 * even while the service is stopped, so the Harness can say how to start it.
 */
export async function runMcpServer(paths: ServicePaths, version: string): Promise<void> {
  const brain = serviceBrain(paths);
  const found = await fetchOverview(brain);
  const instructions = "overview" in found ? buildInstructions(found.overview) : buildInstructions(null, found.error);
  await createMcpServer(brain, { version, instructions }).connect(new StdioServerTransport());
}
