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

function pickEvidence(prompt: string): { marker: string; line: string } | null {
  const q = (/Question: ([\s\S]*)$/.exec(prompt)?.[1] ?? prompt).toLowerCase();
  const words = q.split(/[^a-z0-9]+/).filter((w) => w.length > 3);
  const blocks = [...prompt.matchAll(/\[(S\d+)\] (CURRENT STATE|SUPERSEDED HISTORY|[A-Z]+)[^\n]*\n<<<\n([\s\S]*?)\n>>>/g)];
  let best: { marker: string; line: string; score: number } | null = null;
  for (const b of blocks) {
    if (b[2] === "SUPERSEDED HISTORY") continue;
    for (const line of b[3]!.split("\n")) {
      const l = line.toLowerCase();
      const score = words.filter((w) => l.includes(w)).length + (b[2] === "CURRENT STATE" ? 2 : 0);
      if (line.trim() && (!best || score > best.score)) best = { marker: b[1]!, line: line.replace(/^[-*>\s]+/, "").replace(/ — source:.*$/, "").trim(), score };
    }
  }
  return best && best.score > 0 ? best : null;
}

export function installFixtureModel(fx: FixtureServer, prefix = "/model"): { calls: ModelCall[] } {
  const calls: ModelCall[] = [];
  fx.route("POST", `${prefix}/chat/completions`, (req) => {
    const body = req.body as { messages: Array<{ role: string; content: string }> };
    const system = body.messages.find((m) => m.role === "system")?.content ?? "";
    const user = [...body.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    calls.push({ system, user });
    let answer: string;
    if (/Reply with exactly the word: ready/.test(system)) answer = "ready";
    else if (/keyword search queries/.test(system)) answer = user.split(/\s+/).slice(0, 3).join(" ");
    else if (/Write .* the user could send/.test(user)) answer = "Thanks for the update. I reviewed the changes and have one question about the migration order.";
    else if (/briefing/i.test(system + user) && /Attention items/.test(user)) answer = "Two deadlines need attention; nothing else changed.";
    else {
      const ev = pickEvidence(user);
      answer = ev ? `According to your notes: ${ev.line} [${ev.marker}]` : "I could not find that in your notes.";
    }
    const chunks = answer.match(/.{1,12}/g) ?? [answer];
    const text = chunks.map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join("") + "data: [DONE]\n\n";
    return { headers: { "content-type": "text/event-stream" }, text };
  });
  return { calls };
}
