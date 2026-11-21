/**
 * TEST-ONLY OpenCode session snapshots in the envelope Attache's OpenCode
 * plugin spools (agents/opencode-transcript.ts). The message shapes inside
 * are the ones real OpenCode 1.19.6 (`client.session.messages`) and 2.3.2
 * (`ctx.session.context`, the `compaction` hook's `messages`) returned in an
 * isolated home with a stand-in model (probe-107), trimmed to the fields that
 * matter and with made-up ids and text.
 */

export const SECRET = "sk-live-abcdef1234567890";
/** Plain text only tool output holds: redaction never rewrites it, so finding it anywhere proves tool output leaked. */
export const TOOL_OUTPUT = "TOOL-OUTPUT-7731";
const READ_OUTPUT = `Read file /work/.env, lines 1-2\n1: # ${TOOL_OUTPUT}\n2: OPENAI_API_KEY=${SECRET}`;

type Shape = "v1-messages" | "v2-context" | "v2-request";
export function snapshot(shape: Shape, messages: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ attache: "opencode-session", v: 1, opencode: shape === "v1-messages" ? 1 : 2, shape, sessionID: "ses_1", parentID: null, title: "Plan the Orion cutover", directory: "/work/orion", messages, ...extra });
}

// ---- OpenCode 1: `{ info, parts }` per message ------------------------------------

let n = 0;
const id = (p: string) => `${p}_${String(++n).padStart(4, "0")}`;
const t = (s: number) => 1795256273000 + s * 1000;

export function v1User(text: string, at: number, parts: unknown[] = [], info: Record<string, unknown> = {}) {
  const mid = id("msg");
  return { info: { id: mid, sessionID: "ses_1", role: "user", time: { created: t(at) }, summary: { diffs: [] }, agent: "build", model: { providerID: "p", modelID: "m" }, ...info }, parts: [...(text ? [{ id: id("prt"), sessionID: "ses_1", messageID: mid, type: "text", text }] : []), ...parts] };
}
export function v1Assistant(parts: unknown[], at: number, info: Record<string, unknown> = {}) {
  const mid = id("msg");
  return { info: { id: mid, sessionID: "ses_1", role: "assistant", parentID: "msg_x", time: { created: t(at), completed: t(at) + 50 }, modelID: "m", providerID: "p", mode: "build", path: { cwd: "/work/orion", root: "/work/orion" }, cost: 0, finish: "stop", ...info }, parts: [{ type: "step-start" }, ...parts, { type: "step-finish", reason: "stop" }] };
}
export const v1Text = (text: string, extra: Record<string, unknown> = {}) => ({ id: id("prt"), type: "text", text, time: { start: 1, end: 2 }, ...extra });
export const v1ReadTool = () => ({ id: id("prt"), type: "tool", callID: "call_1", tool: "read", state: { status: "completed", input: { filePath: "/work/.env" }, output: READ_OUTPUT, title: ".env", metadata: {}, time: { start: 1, end: 2 } } });

/** A normal OpenCode 1 session: two exchanges, the second reading a secret-bearing file with a tool. */
export function v1Normal() {
  return [
    v1User("Should the cutover wait for the audit?", 0),
    v1Assistant([v1Text("Yes: we decided to wait, because the audit closes Friday.")], 1),
    v1User("Check the env file", 2),
    v1Assistant([v1ReadTool()], 3, { finish: "tool-calls" }),
    v1Assistant([{ type: "reasoning", text: `the key is ${SECRET}` }, v1Text("The file sets an API key; I left it alone.")], 4),
  ];
}

// ---- OpenCode 2: typed messages ----------------------------------------------------

export const v2User = (text: string, at: number) => ({ id: id("msg"), time: { created: t(at) }, text, files: [], type: "user" });
export const v2Assistant = (content: unknown[], at: number, completed = true) => ({ id: id("msg"), time: { created: t(at), ...(completed ? { completed: t(at) + 50 } : {}) }, type: "assistant", agent: "build", model: { id: "m", providerID: "p" }, content, finish: "stop" });
export const v2Idle = (at: number) => ({ id: id("msg"), time: { created: t(at) }, type: "idle", outcome: "succeeded" });
export const v2ReadTool = () => ({ type: "tool", id: "call_1", name: "read", executed: false, state: { status: "completed", input: { filePath: "/work/.env" }, content: [{ type: "text", text: READ_OUTPUT }], metadata: { truncated: false } } });
export const v2Compaction = (at: number, summary = "## Objective\n- Orion cutover") => ({ id: id("msg"), time: { created: t(at) }, type: "compaction", status: "completed", reason: "manual", summary });
