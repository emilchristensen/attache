import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { brainFile, startTestService, type TestService } from "./harness.ts";
import { startFixtureServer, type FixtureServer } from "../fixtures/fixture-server.ts";
import { cutOffAtTokenLimit, installFixtureModel, type FixtureModel } from "../fixtures/fixture-model.ts";
import { useFakeClaude } from "../fixtures/claude-connectors.ts";
import { claudeCodeHome, consolidationReplies, endSession, setUp } from "./consolidation-kit.ts";

/**
 * A Consolidation reply the model stopped writing at its token limit keeps every change written out in full before
 * the cut, whichever provider Attache uses: each reports the limit its own way (an OpenAI-compatible endpoint's finish
 * reason, the Anthropic API's stop reason, the same stop reason in Claude Code's stream).
 */

let svc: TestService;
let fx: FixtureServer;
let model: FixtureModel;

const today = () => new Date().toISOString().slice(0, 10);
/** How many model calls reached the fixture model at `path`. */
const callsAt = (path: string) => fx.requests.filter((r) => r.path === path).length;

beforeAll(async () => {
  claudeCodeHome();
  fx = await startFixtureServer();
  model = installFixtureModel(fx);
  useFakeClaude(fx.url);
  svc = await startTestService();
  await setUp(svc);
  await svc.post("/connections/claude-code/configure", { method: "hooks", fields: {} });
});
afterAll(async () => {
  await svc?.stop();
  await fx?.close();
});

let launches = 0;
const QUOTE = "We decided the launch team: Sofie leads, Anders tests, and Kari owns support";

/**
 * A new project note, and Consolidation's reply naming its launch team in three changes: whole, and cut off in the
 * middle of the third change, before its value.
 */
async function launchTeam() {
  const n = ++launches;
  await svc.post("/memory/save", { confirmed: true, items: [{ action: "create", type: "project", title: `Launch ${n}`, facts: [{ subject: "Status", value: "Planned" }] }] });
  const path = `memory/projects/launch-${n}.md`;
  const roles = [
    ["Launch lead", "Sofie"],
    ["Test lead", "Anders"],
    ["Support owner", "Kari"],
  ];
  const whole = JSON.stringify({ proposals: roles.map(([subject, value]) => ({ item: { action: "update", path, facts: [{ subject, value }] }, reason: `The session named the ${subject}.`, evidence: QUOTE })) });
  const cut = whole.slice(0, whole.indexOf('"Support owner"') + '"Support o'.length);
  return { path, whole, cut, note: () => brainFile(svc, path) };
}

/** End a Claude Code session that names the launch team, with the model answering Consolidation with `reply`. */
async function consolidate(sessionId: string, reply: unknown) {
  const stop = consolidationReplies(model, () => reply);
  try {
    const r = await endSession(svc, sessionId, [["Who is on the launch team?", `${QUOTE}.`]]);
    return r.consolidate?.result;
  } finally {
    stop();
  }
}

const PROVIDERS = [
  { id: "openai", name: "an OpenAI-compatible endpoint", path: "/model/chat/completions", limits: ["length"], configure: () => ({ method: "openai-compatible", fields: { baseUrl: `${fx.url}/model`, model: "fixture-model" } }) },
  { id: "anthropic", name: "the Anthropic API", path: "/model/v1/messages", limits: ["max_tokens", "model_context_window_exceeded"], configure: () => ({ method: "anthropic", fields: { apiKey: "fixture-anthropic-key", baseUrl: `${fx.url}/model` } }) },
  { id: "claude-cli", name: "Claude Code", path: "/claude/model", limits: ["max_tokens", "model_context_window_exceeded"], configure: () => ({ method: "claude-cli", fields: {} }) },
];

describe.each(PROVIDERS)("A reply cut off at the model's token limit, from $name", (provider) => {
  beforeAll(async () => {
    const out = await svc.post<{ test: { ok: boolean; message: string } }>("/connections/model/configure", provider.configure());
    expect(out.test).toMatchObject({ ok: true });
  });

  // An OpenAI-compatible endpoint always says `length`; the fixture model says what the test names to the others.
  it.each(provider.limits)("stopped with %s, keeps every entry before the cut, and drops the unfinished one saying the reply reached the token limit", async (stopReason) => {
    const team = await launchTeam();
    const before = callsAt(provider.path);
    const result = await consolidate(`s-cut-${provider.id}-${stopReason}`, cutOffAtTokenLimit(team.cut, { stopReason }));
    expect(result).toMatchObject({ written: 2, proposals: 0, dropped: [expect.stringContaining("token limit")] });
    expect(callsAt(provider.path)).toBeGreaterThan(before);
    expect(team.note()).toContain(`- **Launch lead** (${today()}): Sofie`);
    expect(team.note()).toContain(`- **Test lead** (${today()}): Anders`);
    expect(team.note()).not.toContain("Support owner");
  });

  it("a reply broken the same way, but ended as done, is still dropped whole as a malformed reply", async () => {
    const team = await launchTeam();
    const before = callsAt(provider.path);
    const result = await consolidate(`s-broken-${provider.id}`, team.cut);
    expect(result).toMatchObject({ written: 0, proposals: 0, dropped: ["the reply is not the JSON object Consolidation asks for"] });
    expect(callsAt(provider.path)).toBeGreaterThan(before);
    expect(team.note()).not.toContain("Launch lead");
  });
});

describe("A reply Claude Code continues after its token limit", () => {
  beforeAll(async () => {
    const out = await svc.post<{ test: { ok: boolean } }>("/connections/model/configure", { method: "claude-cli", fields: {} });
    expect(out.test).toMatchObject({ ok: true });
  });

  it("is read whole across both messages, and every change in it is written", async () => {
    const team = await launchTeam();
    const result = await consolidate("s-continued", cutOffAtTokenLimit(team.cut, { continuation: team.whole.slice(team.cut.length) }));
    expect(result).toMatchObject({ written: 3, proposals: 0, dropped: [] });
    expect(team.note()).toContain(`- **Launch lead** (${today()}): Sofie`);
    expect(team.note()).toContain(`- **Test lead** (${today()}): Anders`);
    expect(team.note()).toContain(`- **Support owner** (${today()}): Kari`);
  });

  // The last message's stop reason decides: these two replies differ only in how the continuation ended.
  it("cut off again in the continuation, keeps every entry before that cut and drops the unfinished one saying the reply reached the token limit", async () => {
    const team = await launchTeam();
    const middle = team.whole.slice(0, team.whole.indexOf('"Test lead"'));
    const result = await consolidate("s-continued-cut", cutOffAtTokenLimit(middle, { continuation: team.cut.slice(middle.length), continuationStopReason: "max_tokens" }));
    expect(result).toMatchObject({ written: 2, proposals: 0, dropped: [expect.stringContaining("token limit")] });
    expect(team.note()).toContain(`- **Launch lead** (${today()}): Sofie`);
    expect(team.note()).toContain(`- **Test lead** (${today()}): Anders`);
    expect(team.note()).not.toContain("Support owner");
  });

  it("broken but ended as done in the continuation, is dropped whole as a malformed reply", async () => {
    const team = await launchTeam();
    const middle = team.whole.slice(0, team.whole.indexOf('"Test lead"'));
    const result = await consolidate("s-continued-broken", cutOffAtTokenLimit(middle, { continuation: team.cut.slice(middle.length) }));
    expect(result).toMatchObject({ written: 0, proposals: 0, dropped: ["the reply is not the JSON object Consolidation asks for"] });
    expect(team.note()).not.toContain("Launch lead");
  });
});
