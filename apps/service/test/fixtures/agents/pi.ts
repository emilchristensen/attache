/**
 * TEST-ONLY Pi session snapshots in the envelope Attache's Pi extension spools
 * (agents/pi-transcript.ts). The entries inside are the shapes real Pi 1.6.0
 * kept in its session file and returned from `ctx.sessionManager.getBranch()`
 * in an isolated agent folder with a stand-in model (probe-109), trimmed to
 * the fields that matter and with made-up ids and text.
 */

export const SECRET = "sk-live-abcdef1234567890";
/** Plain text only tool output holds: redaction never rewrites it, so finding it anywhere proves tool output leaked. */
export const TOOL_OUTPUT = "TOOL-OUTPUT-7731";
/** Plain text only Attache's injected memory holds. */
export const MEMORY = "MEMORY-ORION-4410";
/** Plain text only a subagent's or a skill's text holds. */
export const SIDE = "SIDE-CHAIN-9902";

let n = 0;
const id = () => (0x10000000 + ++n).toString(16);
const iso = (s: number) => new Date(1795292861000 + s * 1000).toISOString();

export const HEADER = { type: "session", version: 3, id: "01a1ffcb-14da-777a-829f-aefcecc5b1a0", timestamp: iso(0), cwd: "/work/orion" };

export function snapshot(entries: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ attache: "pi-session", v: 1, header: HEADER, forkedAt: null, entries, ...extra });
}

type Entry = Record<string, unknown> & { id: string };
const entry = (type: string, at: number, fields: Record<string, unknown>): Entry => ({ type, id: id(), parentId: null, timestamp: iso(at), ...fields });

export const user = (text: string, at: number) => entry("message", at, { message: { role: "user", content: [{ type: "text", text }], timestamp: 1 } });
export const assistant = (content: unknown[], at: number, extra: Record<string, unknown> = {}) =>
  entry("message", at, { message: { role: "assistant", content, api: "openai-completions", provider: "stand-in", model: "stand-in", stopReason: "stop", timestamp: 1, ...extra } });
export const text = (t: string) => ({ type: "text", text: t });
export const readCall = () => ({ type: "toolCall", id: "call_1", name: "read", arguments: { path: "/work/orion/.env" } });
export const readResult = (at: number) =>
  entry("message", at, { message: { role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "text", text: `# ${TOOL_OUTPUT}\nOPENAI_API_KEY=${SECRET}\n` }], isError: false, timestamp: 1 } });
export const system = (at: number) =>
  entry("message", at, { message: { role: "system", content: "", sections: { preamble: "You are a coding assistant running inside pi.", context: `<context>OPENAI_API_KEY=${SECRET}</context>` }, timestamp: 1 } });
export const modelChange = (at: number) => entry("model_change", at, { provider: "stand-in", modelId: "stand-in" });
export const thinking = (at: number) => entry("thinking_level_change", at, { thinkingLevel: "off" });
export const compaction = (at: number, firstKeptEntryId: string) =>
  entry("compaction", at, { summary: `## Goal\nOrion cutover\n<read-files>\n/work/orion/.env\n</read-files>`, firstKeptEntryId, tokensBefore: 50000, details: { readFiles: ["/work/orion/.env"], modifiedFiles: [] } });

/** A normal Pi session as real Pi writes it: its setup entries, then two exchanges, the second reading a secret-bearing file with a tool. */
export function normal(): Entry[] {
  return [
    modelChange(0),
    thinking(0),
    system(0),
    user("Should the cutover wait for the audit?", 1),
    assistant([text("Yes: we decided to wait, because the audit closes Friday.")], 2),
    user("Check the env file", 3),
    assistant([{ type: "thinking", thinking: `The key is ${SECRET}` }, readCall()], 4, { stopReason: "toolUse" }),
    readResult(5),
    assistant([text("The file sets an API key; I left it alone.")], 6),
  ];
}

export { entry, iso };
