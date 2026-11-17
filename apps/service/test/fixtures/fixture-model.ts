/**
 * TEST-ONLY model endpoint. It streams deterministic answers built from the
 * evidence blocks in the prompt so retrieval behaviour can be asserted without
 * a live model, in each protocol Attache speaks to a model: an OpenAI-compatible
 * endpoint, the Anthropic API, and the Claude Code CLI (through fake-claude.mjs).
 * It is never used in normal operation, and its output is never reported as a
 * live model result.
 */
import type { FixtureServer } from "./fixture-server.ts";

export interface ModelCall {
  system: string;
  user: string;
}

/** The evidence line that shares most words with the research question, as `[S<n>]` research blocks quote it. */
function pickEvidence(prompt: string): { marker: string; line: string } | null {
  const q = (/Question: ([^\n]*)/.exec(prompt)?.[1] ?? prompt).toLowerCase();
  const words = q.split(/[^a-z0-9]+/).filter((w) => w.length > 3);
  const blocks = [...prompt.matchAll(/\[(S\d+)\] [^\n]*\n<<<\n([\s\S]*?)\n>>>/g)];
  let best: { marker: string; line: string; score: number } | null = null;
  for (const b of blocks) {
    for (const line of b[2]!.split("\n")) {
      const l = line.toLowerCase();
      const score = words.filter((w) => l.includes(w)).length;
      if (line.trim() && (!best || score > best.score)) best = { marker: b[1]!, line: line.replace(/^[-*>\s]+/, "").replace(/ — source:.*$/, "").trim(), score };
    }
  }
  return best && best.score > 0 ? best : null;
}

/** The marker a session or meeting capture carries to script Consolidation's reply where a test cannot call `respond`. */
export const FIXTURE_CONSOLIDATE = "FIXTURE-CONSOLIDATE";

/**
 * Consolidation's reply for a text holding a line `FIXTURE-CONSOLIDATE <reply JSON>`:
 * that JSON, as the model's whole reply. The browser journeys use it, because
 * their fixture server runs in another process; the JSON must be on one line,
 * and each entry's evidence quoted from another line of the text.
 */
export function fixtureConsolidation(user: string): string | null {
  return new RegExp(`${FIXTURE_CONSOLIDATE} (\\{.*\\})\\s*$`, "m").exec(user)?.[1] ?? null;
}

/** The line that makes the fixture model reply `reply` to Consolidation, for a session or meeting capture to carry. */
export const consolidationLine = (reply: unknown) => `${FIXTURE_CONSOLIDATE} ${JSON.stringify(reply)}`;

/**
 * A reply the model stopped writing because it reached the token limit. An
 * OpenAI-compatible endpoint reports it with the finish reason `length`; the
 * Anthropic API and Claude Code with `stopReason`, `max_tokens` unless a test
 * names another. `continuation` is the rest of the reply that Claude Code
 * writes in a following message, as it does after its own output limit; an
 * HTTP endpoint never continues a reply. That message ends with
 * `continuationStopReason`, `end_turn` unless a test names another.
 */
export interface CutOffReply {
  cutOff: string;
  stopReason?: string;
  continuation?: string;
  continuationStopReason?: string;
}

/** The reply `text`, ended where the model reached its token limit. */
export const cutOffAtTokenLimit = (text: string, how: Omit<CutOffReply, "cutOff"> = {}): CutOffReply => ({ cutOff: text, ...how });

/** What the fixture model answers: a whole reply, or one cut off at the token limit. */
export type ModelAnswer = string | CutOffReply;

/** A test's own answer for the calls it cares about, now or once a test lets it go; null leaves the call to the built-in answers. */
export type ModelResponder = (call: ModelCall) => ModelAnswer | Promise<ModelAnswer> | null;

export interface FixtureModel {
  calls: ModelCall[];
  /** Answer matching calls with `responder` until the returned function is called. */
  respond(responder: ModelResponder): () => void;
}

/** One message of a reply as the model streams it, and the Anthropic stop reason it ends with. */
interface Message {
  text: string;
  stopReason: string;
}

/** Where fake-claude.mjs asks for a plain model call's answer, as the Anthropic events of each message; at the root of the fixture server it is pointed at. */
const CLAUDE_CLI_MODEL_PATH = "/claude/model";

/** The text split into the small pieces a model streams. */
const pieces = (text: string) => text.match(/.{1,12}/gs) ?? [text];

/** The reply as an OpenAI-compatible endpoint streams it. */
function openAiStream([message, ...more]: Message[]): string {
  if (!message || more.length) throw new Error("An OpenAI-compatible endpoint does not continue a reply after its token limit");
  const finishReason = message.stopReason === "end_turn" ? "stop" : "length";
  const events = [...pieces(message.text).map((c) => ({ choices: [{ delta: { content: c }, finish_reason: null }] })), { choices: [{ delta: {}, finish_reason: finishReason }] }];
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
}

/** The events the Anthropic Messages API streams for one message; Claude Code passes the same events on as `stream_event`s. */
function anthropicEvents(message: Message, id = "msg_fixture"): Array<Record<string, unknown>> {
  return [
    { type: "message_start", message: { id, type: "message", role: "assistant", content: [], model: "fixture-model", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "ping" },
    ...pieces(message.text).map((text) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })),
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: message.stopReason, stop_sequence: null }, usage: { output_tokens: pieces(message.text).length } },
    { type: "message_stop" },
  ];
}

/** The reply as the Anthropic Messages API streams it. */
function anthropicStream([message, ...more]: Message[]): string {
  if (!message || more.length) throw new Error("The Anthropic API does not continue a reply after its token limit");
  return anthropicEvents(message)
    .map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");
}

/** The messages a scripted answer streams as. */
function messagesOf(answer: ModelAnswer): Message[] {
  if (typeof answer === "string") return [{ text: answer, stopReason: "end_turn" }];
  const cut = { text: answer.cutOff, stopReason: answer.stopReason ?? "max_tokens" };
  return answer.continuation === undefined ? [cut] : [cut, { text: answer.continuation, stopReason: answer.continuationStopReason ?? "end_turn" }];
}

/** The built-in answer to a call no test scripted. */
function builtInAnswer({ system, user }: ModelCall): string {
  if (/Reply with exactly the word: ready/.test(system)) return "ready";
  // Consolidation without a scripted answer: what the text asks for with a FIXTURE-CONSOLIDATE line, else nothing.
  if (/Consolidation/.test(system)) return fixtureConsolidation(user) ?? "NOTHING_DURABLE";
  if (/keyword search queries/.test(system)) return user.split(/\s+/).slice(0, 3).join(" ");
  if (/Write .* the user could send/.test(user)) return "Thanks for the update. I reviewed the changes and have one question about the migration order.";
  if (/briefing/i.test(system + user) && /Attention items/.test(user)) return "Two deadlines need attention; nothing else changed.";
  if (/summarise a finished Harness session/.test(system)) {
    const decisions = [...(/<session>([\s\S]*)<\/session>/.exec(user)?.[1] ?? "").matchAll(/[^.\n]*\b(?:decided|chose)\b[^.\n]*\./gi)].map((m) => `- ${m[0].replace(/^\s*\w+:\s*/, "").trim()}`);
    return decisions.length ? decisions.join("\n") : "NOTHING_DURABLE";
  }
  if (/research notes/.test(system)) {
    const ev = pickEvidence(user);
    return ev ? `According to your notes: ${ev.line} [${ev.marker}]` : "The evidence does not answer this.";
  }
  return "The fixture model has no answer for this prompt.";
}

/** The last user message of a conversation, with the content as a string or as Anthropic text blocks. */
function lastUserText(messages: Array<{ role: string; content: unknown }>): string {
  const content = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((b: { text?: string }) => b.text ?? "").join("") : "";
}

/**
 * Serve the model at `prefix`: `/chat/completions` (OpenAI-compatible) and
 * `/v1/messages` (Anthropic API). Claude Code's plain model calls reach it
 * through fake-claude.mjs at CLAUDE_CLI_MODEL_PATH.
 */
export function installFixtureModel(fx: FixtureServer, prefix = "/model"): FixtureModel {
  const calls: ModelCall[] = [];
  const responders: ModelResponder[] = [];
  async function messagesFor(call: ModelCall): Promise<Message[]> {
    calls.push(call);
    const scripted = await responders.map((r) => r(call)).find((a) => a !== null);
    return messagesOf(scripted ?? builtInAnswer(call));
  }
  const eventStream = (text: string) => ({ headers: { "content-type": "text/event-stream" }, text });
  fx.route("POST", `${prefix}/chat/completions`, async (req) => {
    const body = req.body as { messages: Array<{ role: string; content: string }> };
    const system = body.messages.find((m) => m.role === "system")?.content ?? "";
    return eventStream(openAiStream(await messagesFor({ system, user: lastUserText(body.messages) })));
  });
  fx.route("POST", `${prefix}/v1/messages`, async (req) => {
    if (!req.headers["x-api-key"] || !req.headers["anthropic-version"]) return { status: 401, json: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } };
    const body = req.body as { system?: string; messages: Array<{ role: string; content: unknown }>; max_tokens?: number };
    if (!body.max_tokens) return { status: 400, json: { type: "error", error: { type: "invalid_request_error", message: "max_tokens: Field required" } } };
    return eventStream(anthropicStream(await messagesFor({ system: body.system ?? "", user: lastUserText(body.messages) })));
  });
  fx.route("POST", CLAUDE_CLI_MODEL_PATH, async (req) => {
    const body = req.body as ModelCall;
    const messages = await messagesFor({ system: body.system, user: body.user });
    // What Claude Code streams for each message the model wrote, in the order it wrote them.
    return { json: { messages: messages.map((m, i) => ({ text: m.text, events: anthropicEvents(m, `msg_fixture_${i + 1}`) })) } };
  });
  return {
    calls,
    respond(responder) {
      responders.push(responder);
      return () => {
        const i = responders.indexOf(responder);
        if (i >= 0) responders.splice(i, 1);
      };
    },
  };
}
