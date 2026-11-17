#!/usr/bin/env node
/**
 * TEST-ONLY stand-in for the Claude Code CLI, selected with ATTACHE_CLAUDE_BIN.
 * It speaks the same stream-json + permission-control protocol Attache uses
 * with the real CLI, and executes approved connector calls against the
 * fixture server (ATTACHE_FAKE_CLAUDE_URL). The fixture decides server status,
 * sign-in state and how "the model" behaves, so the approval gate is tested
 * against deviations a real model could produce. Never live evidence.
 */
import { createInterface } from "node:readline";

const BASE = (process.env.ATTACHE_FAKE_CLAUDE_URL ?? "").replace(/\/$/, "");
const get = async (path) => (await fetch(`${BASE}${path}`)).json();
const post = async (path, body) => (await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const prefix = (server) => `mcp__${server.replace(/[^A-Za-z0-9_-]/g, "_")}`;

const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "status") {
  const a = await get("/claude/auth");
  process.stdout.write(`${JSON.stringify(a)}\n`);
  process.exit(a.loggedIn ? 0 : 1);
}
if (!args.includes("--permission-prompt-tool")) {
  // Plain model use (not a connector session): the fixture model answers the prompt on stdin, and each message
  // it writes streams as Claude Code streams it with --include-partial-messages: the API's events, then the message whole.
  let user = "";
  for await (const chunk of process.stdin) user += String(chunk);
  const flag = args.indexOf("--system-prompt");
  const system = flag < 0 ? "" : (args[flag + 1] ?? "");
  const res = await fetch(`${BASE}/claude/model`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ system, user }) });
  if (!res.ok) {
    emit({ type: "result", subtype: "error_during_execution", is_error: true, result: `fixture model: HTTP ${res.status}` });
    process.stdout.write("", () => process.exit(1));
    await new Promise(() => {});
  }
  const { messages } = await res.json();
  emit({ type: "system", subtype: "init", tools: [], mcp_servers: [] });
  for (const m of messages) {
    for (const event of m.events) emit({ type: "stream_event", event });
    emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: m.text }] } });
  }
  emit({ type: "result", subtype: "success", is_error: false, result: messages.at(-1)?.text ?? "" });
  process.stdout.write("", () => process.exit(0));
  await new Promise(() => {});
}

const rl = createInterface({ input: process.stdin });
const pending = new Map();
let nextReq = 0;
let first = null;
const firstMessage = new Promise((resolve) => (first = resolve));
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === "user") first(msg);
  if (msg.type === "control_response") {
    const r = msg.response ?? {};
    pending.get(r.request_id)?.(r.response ?? { behavior: "deny", message: r.error ?? "error" });
    pending.delete(r.request_id);
  }
});
process.on("SIGTERM", () => process.exit(143));

const ask = (tool, input, server, toolUseId) =>
  new Promise((resolve) => {
    const id = `req-${++nextReq}`;
    pending.set(id, resolve);
    emit({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: tool, mcp_server: { name: server.name, source: server.source }, input, tool_use_id: toolUseId } });
  });

let toolUse = 0;
async function attempt(servers, tool, input) {
  const server = servers.find((s) => tool.startsWith(`${prefix(s.name)}__`));
  const id = `toolu_${++toolUse}`;
  emit({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: tool, input }] } });
  const decision = await ask(tool, input, server ?? { name: "unknown", source: "unknown" }, id);
  let result;
  if (decision.behavior === "allow") {
    const short = tool.slice(prefix(server.name).length + 2);
    const out = await post("/claude/call", { server: server.name, tool: short, args: decision.updatedInput ?? input });
    result = { type: "tool_result", tool_use_id: id, content: [{ type: "text", text: out.text ?? "" }], ...(out.isError ? { is_error: true } : {}) };
  } else result = { type: "tool_result", tool_use_id: id, content: decision.message ?? "denied", is_error: true };
  emit({ type: "user", message: { role: "user", content: [result] } });
  return decision.behavior === "allow";
}

const msg = await firstMessage;
const text = typeof msg.message?.content === "string" ? msg.message.content : "";
const plan = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(text)?.[1] ?? "[]");
const { servers } = await get("/claude/servers");
const flag = args.indexOf("--disallowedTools");
const disallowed = flag < 0 ? [] : args.slice(flag + 1).filter((a, i, all) => !all.slice(0, i + 1).some((x) => x.startsWith("--")));
await post("/claude/started", { disallowed, planned: plan.length });
// A session without planned calls only lists the servers; it does not consume a behaviour.
const { mode = "normal" } = plan.length ? await get("/claude/behavior") : {};
// Like Claude Code on a busy computer, or connecting slow MCP servers: a long start before init.
if (mode === "slow-start") await new Promise((r) => setTimeout(r, Number(process.env.FAKE_CLAUDE_START_MS ?? 1_500)));
emit({ type: "system", subtype: "init", tools: [], mcp_servers: servers });

if (mode === "too-long-unless-hidden") {
  // Like the real CLI with tool search off: every visible server's tool definitions are inlined.
  const hidden = (name) => disallowed.includes("mcp__*") || disallowed.includes(prefix(name));
  const target = (plan[0]?.tool ?? "").split("__")[1] ?? "";
  if (servers.some((s) => prefix(s.name).split("__")[1] !== target && !hidden(s.name))) {
    emit({ type: "result", subtype: "error_during_execution", is_error: true, result: "Prompt is too long: 266386 tokens > 200000 maximum" });
    process.stdout.write("", () => process.exit(1));
    await new Promise(() => {});
  }
}

if (mode === "not-logged-in") {
  emit({ type: "result", subtype: "error_during_execution", is_error: true, result: "Not logged in · Please run /login" });
  process.stdout.write("", () => process.exit(1));
  await new Promise(() => {});
}
if (mode === "hang") await new Promise(() => {});

const target = plan[0]?.tool ?? "";
const targetServer = servers.find((s) => target.startsWith(`${prefix(s.name)}__`));
if (mode === "preapproved" && targetServer) {
  // A tool pre-approved by settings outside Attache runs without any permission request.
  const id = `toolu_${++toolUse}`;
  emit({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: `${prefix(targetServer.name)}__slack_send_message`, input: { channel_id: "C1", message: "injected" } }] } });
  emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: "{\"ok\":true}" }] }] } });
}
if (mode === "unplanned" && targetServer) await attempt(servers, `${prefix(targetServer.name)}__unplanned_write_tool`, { anything: true });
const calls = mode === "skip-all" ? [] : mode === "skip-last" && plan.length > 1 ? plan.slice(0, -1) : plan;
for (const [i, call] of calls.entries()) {
  if (mode === "altered" && i === 0) await attempt(servers, call.tool, { ...call.arguments, injected: "value" });
  await attempt(servers, call.tool, call.arguments);
}
emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "DONE" }] } });
emit({ type: "result", subtype: "success", is_error: false, result: "DONE", total_cost_usd: 0 });
// Exit only after stdout drained: large tool results would otherwise be cut off on a pipe.
process.stdout.write("", () => process.exit(0));
