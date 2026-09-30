import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { slackAdapter } from "../../src/connectors/slack.ts";
import { startFixtureServer, type FixtureServer, type FixtureResponse } from "../fixtures/fixture-server.ts";
import { fixtureContext } from "../fixtures/adapter-harness.ts";

let fx: FixtureServer;
beforeAll(async () => {
  fx = await startFixtureServer();
});
afterAll(() => fx.close());
beforeEach(() => fx.reset());

const TOKEN = "xoxp-1234567890-testtokentesttoken";
const SELF = "U0SELF";
// Fixture clock is 2026-09-30T10:00:00Z; the 48h window starts at 2026-09-28T10:00:00Z.
const NOW_S = Date.parse("2026-09-30T10:00:00Z") / 1000;
const ts = (hoursAgo: number, n = 0) => `${(NOW_S - hoursAgo * 3600).toFixed(0)}.${String(n).padStart(6, "0")}`;

const slack = (data: Record<string, unknown>): FixtureResponse => ({ json: { ok: true, ...data } });
const slackErr = (error: string): FixtureResponse => ({ json: { ok: false, error } });

const ctx = (scopes = ["dms"], opts: { secrets?: Record<string, string>; channels?: string } = {}) =>
  fixtureContext({ kind: "slack", baseUrl: fx.url, secrets: opts.secrets ?? { token: TOKEN }, settings: { channels: opts.channels ?? "" }, readScopes: scopes });

function authOk() {
  fx.route("POST", "/auth.test", (req) => (req.headers.authorization === `Bearer ${TOKEN}` ? slack({ user_id: SELF, user: "alex", team: "Acme", url: "https://acme.slack.com/" }) : slackErr("invalid_auth")));
}

function ims(histories: Record<string, unknown[] | FixtureResponse>) {
  fx.route("GET", "/conversations.list", () => slack({ channels: Object.keys(histories).map((id) => ({ id, user: `U${id}` })), response_metadata: { next_cursor: "" } }));
  fx.route("GET", "/conversations.history", (req) => {
    const h = histories[req.query.get("channel")!];
    return Array.isArray(h) ? slack({ messages: h, has_more: false }) : (h ?? slackErr("channel_not_found"));
  });
}

const count = (path: string) => fx.requests.filter((r) => r.path === path).length;

describe("Slack adapter contract", () => {
  it("authorization: bearer token via auth.test reports user and team", async () => {
    authOk();
    expect(await slackAdapter.test(ctx())).toMatchObject({ ok: true, account: "alex @ Acme" });
    expect(fx.requests[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("ok:false errors map to coverage states (HTTP 200 is not success)", async () => {
    for (const [error, state] of [["invalid_auth", "unauthorized"], ["token_revoked", "unauthorized"], ["account_inactive", "unauthorized"], ["missing_scope", "denied"], ["no_permission", "denied"], ["ratelimited", "partial"]] as const) {
      fx.reset();
      fx.route("POST", "/auth.test", () => slackErr(error));
      expect((await slackAdapter.test(ctx())).state).toBe(state);
    }
    fx.reset();
    fx.route("POST", "/auth.test", () => slackErr("invalid_auth"));
    const s = await slackAdapter.sync!(ctx(["dms", "mentions"]));
    expect(s.coverage.state).toBe("unauthorized");
    expect(s.coverage.scopes).toHaveLength(2);
  });

  it("scope: only selected scopes are queried; a bot token's not_allowed_token_type on search is denied", async () => {
    authOk();
    ims({});
    fx.route("GET", "/search.messages", () => slackErr("not_allowed_token_type"));
    const a = await slackAdapter.sync!(ctx(["dms"]));
    expect(count("/search.messages")).toBe(0);
    expect(a.coverage.state).toBe("empty");
    const b = await slackAdapter.sync!(ctx(["dms", "mentions"]));
    expect(b.coverage.scopes.find((c) => c.scope.includes("Mentions"))).toMatchObject({ state: "denied" });
    expect(b.coverage.state).toBe("partial");
  });

  it("pagination: conversations.list follows next_cursor; search.messages follows page_count", async () => {
    authOk();
    fx.route("GET", "/conversations.list", (req) =>
      req.query.get("cursor") === "c2" ? slack({ channels: [{ id: "D2" }], response_metadata: { next_cursor: "" } }) : slack({ channels: [{ id: "D1" }], response_metadata: { next_cursor: "c2" } }),
    );
    fx.route("GET", "/conversations.history", (req) => slack({ messages: [{ ts: ts(1), user: `U${req.query.get("channel")}`, text: "hi" }] }));
    fx.route("GET", "/search.messages", (req) => {
      const page = Number(req.query.get("page"));
      const m = { ts: ts(page), user: "UMIA", text: `<@${SELF}> look ${page}`, channel: { id: "C1", name: "eng" }, permalink: `https://acme.slack.com/archives/C1/p${page}` };
      return slack({ messages: { matches: [m], pagination: { page, page_count: 2 } } });
    });
    const s = await slackAdapter.sync!(ctx(["dms", "mentions"]));
    expect(s.coverage.scopes.map((c) => [c.state, c.items])).toEqual([["complete", 2], ["complete", 2]]);
    expect(fx.requests.find((r) => r.path === "/search.messages")!.query.get("query")).toBe(`<@${SELF}>`);
    expect(count("/search.messages")).toBe(2);
    expect(s.observations.filter((o) => o.attention?.kind === "mention").map((o) => o.attention!.key)).toEqual([`slack:C1:${ts(1)}`, `slack:C1:${ts(2)}`]);
  });

  it("mentions stop at the 48h window and skip my own messages", async () => {
    authOk();
    fx.route("GET", "/search.messages", () => slack({ messages: { matches: [{ ts: ts(1), user: SELF, text: "me", channel: { id: "C1" } }, { ts: ts(3), user: "UMIA", text: "hey", channel: { id: "C1" } }, { ts: ts(60), user: "UMIA", text: "old", channel: { id: "C1" } }], pagination: { page: 1, page_count: 5 } } }));
    const s = await slackAdapter.sync!(ctx(["mentions"]));
    expect(count("/search.messages")).toBe(1);
    expect(s.observations.map((o) => o.data.text)).toEqual(["hey"]);
    expect(s.coverage.scopes[0]!.state).toBe("complete");
  });

  it("retry: HTTP 429 with Retry-After is retried, then succeeds", async () => {
    authOk();
    let calls = 0;
    fx.route("GET", "/conversations.list", () => (++calls < 3 ? { status: 429, headers: { "retry-after": "0" }, json: { ok: false, error: "ratelimited" } } : slack({ channels: [] })));
    const s = await slackAdapter.sync!(ctx());
    expect(calls).toBe(3);
    expect(s.coverage.state).toBe("empty");
  });

  it("empty result: no DMs in the window is 'empty'", async () => {
    authOk();
    ims({ D1: [] });
    const s = await slackAdapter.sync!(ctx());
    expect(s.coverage.scopes[0]).toMatchObject({ state: "empty", items: 0 });
    expect(fx.requests.find((r) => r.path === "/conversations.history")!.query.get("oldest")).toBe(String((NOW_S - 48 * 3600).toFixed(6)));
  });

  it("partial coverage: list failure after page one, and a rate-limited DM history", async () => {
    authOk();
    fx.route("GET", "/conversations.list", (req) => (req.query.get("cursor") ? { status: 500, json: {} } : slack({ channels: [{ id: "D1" }], response_metadata: { next_cursor: "c2" } })));
    fx.route("GET", "/conversations.history", () => slack({ messages: [{ ts: ts(1), user: "UMIA", text: "yo" }] }));
    const a = await slackAdapter.sync!(ctx());
    expect(a.coverage.state).toBe("partial");
    expect(a.observations).toHaveLength(1);
    fx.reset();
    authOk();
    ims({ D1: [{ ts: ts(1), user: "UMIA", text: "yo" }], D2: slackErr("ratelimited") });
    const b = await slackAdapter.sync!(ctx());
    expect(b.coverage.scopes[0]).toMatchObject({ state: "partial", items: 1 });
    expect(b.coverage.scopes[0]!.note).toMatch(/D2/);
  });

  it("disconnect: without a stored token no request is made", async () => {
    const s = await slackAdapter.sync!(ctx(["dms", "mentions"], { secrets: {} }));
    expect(s.coverage.state).toBe("unauthorized");
    expect(fx.requests).toHaveLength(0);
  });

  it("DMs: awaiting only when the latest human message is from someone else; bots never count", async () => {
    authOk();
    ims({
      D1: [{ ts: ts(1), user: "UMIA", text: "can you check?" }],
      D2: [{ ts: ts(1), user: SELF, text: "done" }, { ts: ts(2), user: "UBOB", text: "?" }],
      D3: [{ ts: ts(1), bot_id: "B1", subtype: "bot_message", text: "deploy ok" }],
      D4: [{ ts: ts(1), bot_id: "B1", user: "UBOT", text: "reminder" }, { ts: ts(2), user: SELF, text: "noted" }],
    });
    const s = await slackAdapter.sync!(ctx());
    const byChannel = Object.fromEntries(s.observations.map((o) => [o.data.channel, o]));
    expect(byChannel.D1!.attention).toMatchObject({ key: `slack:D1:${ts(1)}`, kind: "pending_reply", draftable: { actionKind: "slack.post", target: { channel: "D1" } } });
    expect(byChannel.D1!.fingerprintParts).toEqual(["can you check?", true]);
    expect(byChannel.D2!.attention).toBeUndefined();
    expect(byChannel.D2!.fingerprintParts).toEqual(["done", false]);
    expect(byChannel.D3).toBeUndefined();
    expect(byChannel.D4!.attention).toBeUndefined();
  });

  it("channels: every requested channel is audited; unreadable ones make the scope partial", async () => {
    authOk();
    fx.route("GET", "/conversations.history", (req) => (req.query.get("channel") === "C0000002" ? slackErr("not_in_channel") : slack({ messages: [{ ts: ts(1), user: "UMIA", text: "standup notes" }] })));
    const s = await slackAdapter.sync!(ctx(["channels"], { channels: "C0000001,C0000002" }));
    expect(s.coverage.scopes[0]).toMatchObject({ state: "partial", items: 1 });
    expect(s.coverage.scopes[0]!.note).toContain("C0000002 (not_in_channel)");
    expect(s.observations[0]!.attention).toBeUndefined();
    fx.reset();
    authOk();
    fx.route("GET", "/conversations.history", () => slack({ messages: [] }));
    expect((await slackAdapter.sync!(ctx(["channels"], { channels: "C0000001" }))).coverage.scopes[0]!.state).toBe("empty");
  });

  it("write: posts once with effect metadata, verifies by read-back, recovery finds it", async () => {
    authOk();
    const posted: Array<Record<string, unknown>> = [];
    fx.route("POST", "/chat.postMessage", (req) => {
      const b = req.body as { channel: string; text: string; metadata: unknown };
      const m = { ts: `${NOW_S}.000100`, user: SELF, text: b.text, metadata: b.metadata };
      posted.push(m);
      return slack({ channel: b.channel, ts: m.ts });
    });
    fx.route("GET", "/conversations.history", (req) => {
      const allMeta = req.query.get("include_all_metadata") === "true";
      const msgs = posted.map((m) => (allMeta ? m : { ...m, metadata: undefined }));
      return slack({ messages: req.query.get("latest") ? msgs.filter((m) => m.ts === req.query.get("latest")) : msgs, has_more: false });
    });
    const action = { kind: "slack.post", target: { channel: "D0000001" }, payload: { text: "On it" }, effectKey: "eff-s" };
    const r = await slackAdapter.execute!(ctx(), action);
    expect(r).toMatchObject({ verified: true, remoteId: `${NOW_S}.000100` });
    expect(posted[0]!.metadata).toEqual({ event_type: "jarvis_effect", event_payload: { key: "eff-s" } });
    expect(fx.requests.find((q) => q.path === "/chat.postMessage")!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(await slackAdapter.findEffect!(ctx(), action)).toMatchObject({ verified: true, remoteId: `${NOW_S}.000100` });
    expect(await slackAdapter.findEffect!(ctx(), { ...action, effectKey: "other" })).toBeNull();
    expect(count("/chat.postMessage")).toBe(1);
  });

  it("write: thread replies are read back via conversations.replies", async () => {
    authOk();
    fx.route("POST", "/chat.postMessage", (req) => slack({ channel: "C0000001", ts: "1759226400.000200", message: req.body }));
    fx.route("GET", "/conversations.replies", (req) =>
      slack({ messages: [{ ts: req.query.get("ts"), user: "UMIA", text: "parent" }, { ts: "1759226400.000200", user: SELF, text: "reply", metadata: { event_type: "jarvis_effect", event_payload: { key: "eff-t" } } }] }),
    );
    const r = await slackAdapter.execute!(ctx(), { kind: "slack.post", target: { channel: "C0000001", thread_ts: "1759220000.000100" }, payload: { text: "reply" }, effectKey: "eff-t" });
    expect(r.verified).toBe(true);
    expect((fx.requests.find((q) => q.path === "/chat.postMessage")!.body as { thread_ts: string }).thread_ts).toBe("1759220000.000100");
  });

  it("recovery throws partial when recent history cannot all be read", async () => {
    authOk();
    fx.route("GET", "/conversations.history", () => slack({ messages: [], has_more: true, response_metadata: { next_cursor: "more" } }));
    await expect(slackAdapter.findEffect!(ctx(), { kind: "slack.post", target: { channel: "C0000001" }, payload: {}, effectKey: "k" })).rejects.toMatchObject({ state: "partial" });
  });
});
