/**
 * TEST-ONLY OpenAI-compatible model endpoint. It streams deterministic answers
 * built from the evidence blocks in the prompt so retrieval behaviour can be
 * asserted without a live model. It is never used in normal operation, and its
 * output is never reported as a live model result.
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

/** A test's own answer for the calls it cares about; null leaves the call to the built-in answers. */
export type ModelResponder = (call: ModelCall) => string | null;

export interface FixtureModel {
  calls: ModelCall[];
  /** Answer matching calls with `responder` until the returned function is called. */
  respond(responder: ModelResponder): () => void;
}

export function installFixtureModel(fx: FixtureServer, prefix = "/model"): FixtureModel {
  const calls: ModelCall[] = [];
  const responders: ModelResponder[] = [];
  fx.route("POST", `${prefix}/chat/completions`, (req) => {
    const body = req.body as { messages: Array<{ role: string; content: string }> };
    const system = body.messages.find((m) => m.role === "system")?.content ?? "";
    const user = [...body.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    calls.push({ system, user });
    const scripted = responders.map((r) => r({ system, user })).find((a) => a !== null);
    let answer: string;
    if (scripted !== undefined && scripted !== null) answer = scripted;
    else if (/Reply with exactly the word: ready/.test(system)) answer = "ready";
    // Consolidation without a scripted answer: nothing in the session is worth proposing.
    else if (/Consolidation/.test(system)) answer = "NOTHING_DURABLE";
    else if (/keyword search queries/.test(system)) answer = user.split(/\s+/).slice(0, 3).join(" ");
    else if (/Write .* the user could send/.test(user)) answer = "Thanks for the update. I reviewed the changes and have one question about the migration order.";
    else if (/briefing/i.test(system + user) && /Attention items/.test(user)) answer = "Two deadlines need attention; nothing else changed.";
    else if (/summarise a finished Harness session/.test(system)) {
      const decisions = [...(/<session>([\s\S]*)<\/session>/.exec(user)?.[1] ?? "").matchAll(/[^.\n]*\b(?:decided|chose)\b[^.\n]*\./gi)].map((m) => `- ${m[0].replace(/^\s*\w+:\s*/, "").trim()}`);
      answer = decisions.length ? decisions.join("\n") : "NOTHING_DURABLE";
    }
    else if (/research notes/.test(system)) {
      const ev = pickEvidence(user);
      answer = ev ? `According to your notes: ${ev.line} [${ev.marker}]` : "The evidence does not answer this.";
    } else answer = "The fixture model has no answer for this prompt.";
    const chunks = answer.match(/.{1,12}/g) ?? [answer];
    const text = chunks.map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join("") + "data: [DONE]\n\n";
    return { headers: { "content-type": "text/event-stream" }, text };
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
