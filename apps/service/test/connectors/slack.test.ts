import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { slackAdapter } from "../../src/connectors/slack.ts";
import { parseHistory, parseSearch, sameText, sentTs } from "../../src/connectors/slack-format.ts";
import { startFixtureServer, type FixtureServer } from "../fixtures/fixture-server.ts";
import { fixtureContext } from "../fixtures/adapter-harness.ts";
import { jsonAnswer, mountClaude, onTool, slackHistoryAnswer, slackProfileAnswer, slackSearchAnswer, slackSearchInvalid, useFakeClaude, type ClaudeFixture, type SlackFixtureMessage } from "../fixtures/claude-connectors.ts";

// Each test starts many fake Claude Code CLI processes, which is slow on a busy machine.
vi.setConfig({ testTimeout: 120_000 });

let fx: FixtureServer;
let claude: ClaudeFixture;
const SERVER = "claude.ai Slack";
const SELF = "U0SELF";
// Fixture clock: the 48h window starts at 2026-09-28T10:00:00Z.
const NOW_S = Date.parse("2026-09-30T10:00:00Z") / 1000;
const ts = (hoursAgo: number, n = 0) => `${(NOW_S - hoursAgo * 3600).toFixed(0)}.${String(n).padStart(6, "0")}`;
const msg = (channel: string, user: string, hoursAgo: number, text: string, extra: Partial<SlackFixtureMessage> = {}): SlackFixtureMessage => ({ channel, user, userName: user === SELF ? "Alex" : `Person ${user}`, ts: ts(hoursAgo), text, ...extra });

beforeAll(async () => {
  fx = await startFixtureServer();
  useFakeClaude(fx.url);
});
afterAll(() => fx.close());

function searchable(dms: SlackFixtureMessage[], mentions: SlackFixtureMessage[], pageSize = 20) {
  onTool(claude, SERVER, "slack_search_public_and_private", (a) => {
    const invalid = slackSearchInvalid(a);
    if (invalid) return invalid;
    const list = a.channel_types === "im" ? dms : mentions;
    const start = Number(a.cursor ?? 0);
    const page = [...list].sort((x, y) => Number(y.ts) - Number(x.ts)).slice(start, start + pageSize);
    return slackSearchAnswer(page, start + pageSize < list.length ? String(start + pageSize) : null);
  });
}

beforeEach(() => {
  fx.reset();
  claude = mountClaude(fx);
  onTool(claude, SERVER, "slack_read_user_profile", () => slackProfileAnswer(SELF));
});

const ctx = (scopes = ["dms"], settings: Record<string, unknown> = {}) => fixtureContext({ kind: "slack", baseUrl: fx.url, settings: { authMethod: "claude-ai", ...settings }, readScopes: scopes });
const calls = (tool: string) => claude.calls.filter((c) => c.tool === tool);

describe("Slack adapter contract (claude.ai Slack connector)", () => {
  it("authorization: test reports the Slack user through the claude.ai account and caches the user id", async () => {
    const r = await slackAdapter.test(ctx());
    expect(r).toMatchObject({ ok: true, state: "complete", account: "alex@example.com", settings: { userId: SELF } });
    expect(r.message).toMatch(/claude\.ai \(alex@example\.com, Example Org\)/);
  });

  it("authorization: an unconnected Slack connector or signed-out Claude Code fails every selected scope, never empty", async () => {
    claude.servers = [{ name: SERVER, status: "needs-auth", source: "claudeai" }];
    expect(await slackAdapter.test(ctx())).toMatchObject({ ok: false, state: "unauthorized" });
    const s = await slackAdapter.sync!(ctx(["dms", "mentions"]));
    expect(s.coverage.state).toBe("unauthorized");
    expect(s.coverage.scopes).toHaveLength(2);
    claude.servers = [{ name: SERVER, status: "connected", source: "claudeai" }];
    claude.auth = { loggedIn: false };
    expect(await slackAdapter.test(ctx())).toMatchObject({ ok: false, state: "unauthorized" });
  });

  it("scope: DMs search only 1:1 conversations inside the window; mentions search for my user id; nothing else is called", async () => {
    searchable([msg("D01", "U0MIA", 1, "Can you look at this?")], [msg("C01", "U0BOB", 2, `<@${SELF}|Alex> ping`, { channelName: "general" })]);
    const r = await slackAdapter.sync!(ctx(["dms", "mentions"], { userId: SELF }));
    expect(r.coverage.state).toBe("complete");
    const search = calls("slack_search_public_and_private");
    expect(search.find((c) => c.args.channel_types === "im")!.args).toMatchObject({ filters: "is:dm", after: String(NOW_S - 48 * 3600), sort: "timestamp", include_bots: false });
    expect(search.find((c) => c.args.channel_types !== "im")!.args.keywords).toEqual([`<@${SELF}>`]);
    expect(calls("slack_read_user_profile")).toHaveLength(0);
    expect(r.observations.map((o) => o.attention?.kind).sort()).toEqual(["mention", "pending_reply"]);
    // Both scopes' first pages go in one Claude Code session.
    expect(claude.sessions).toBe(1);
  });

  it("awaiting reply: only when the newest human message in the DM is from someone else", async () => {
    searchable([msg("D01", SELF, 1, "Sent it."), msg("D01", "U0MIA", 3, "Got it?"), msg("D02", "U0BOB", 2, "Lunch?"), msg("D03", "UBOT", 1, "Reminder", { bot: true })], []);
    const r = await slackAdapter.sync!(ctx(["dms"], { userId: SELF }));
    const byChannel = Object.fromEntries(r.observations.map((o) => [String(o.data.channel), o.data.awaiting]));
    expect(byChannel).toEqual({ D01: false, D02: true });
    expect(r.observations.find((o) => o.data.channel === "D02")!.attention).toMatchObject({ kind: "pending_reply", title: "Reply to Person U0BOB in Slack" });
  });

  // Every page is a Claude Code session (a process spawn), so each pagination case is its own test to stay well inside the timeout.
  const dms = (n: number) => Array.from({ length: n }, (_, i) => msg(`D${String(i).padStart(3, "0")}`, "U0MIA", 0.5 + i * 0.1, `m${i}`));

  it("pagination: follows the search cursor", async () => {
    searchable(dms(45), []);
    const r = await slackAdapter.sync!(ctx(["dms"], { userId: SELF }));
    expect(r.coverage).toMatchObject({ state: "complete", items: 45 });
    expect(calls("slack_search_public_and_private")).toHaveLength(3);
  });

  it("pagination: stops at the window edge", async () => {
    searchable([...dms(5), msg("D999", "U0MIA", 60, "too old")], [], 3);
    const edge = await slackAdapter.sync!(ctx(["dms"], { userId: SELF }));
    expect(edge.observations.map((o) => o.data.channel)).not.toContain("D999");
    expect(edge.coverage.state).toBe("complete");
  });

  it("pagination: a page cap is partial", async () => {
    searchable(Array.from({ length: 300 }, (_, i) => msg(`D${String(i).padStart(3, "0")}`, "U0MIA", 0.1 + i * 0.01, `x${i}`)), [], 20);
    const capped = await slackAdapter.sync!(ctx(["dms"], { userId: SELF }));
    expect(capped.coverage.scopes[0]).toMatchObject({ state: "partial", items: 200, pages: 10, note: "Stopped after 10 pages" });
  });

  it("retry and failures: a tool error on the first page fails the scope; a later page failure keeps it partial", async () => {
    onTool(claude, SERVER, "slack_search_public_and_private", (a) => (a.channel_types === "im" ? { text: "missing_scope: search:read", isError: true } : slackSearchAnswer([])));
    const r = await slackAdapter.sync!(ctx(["dms", "mentions"], { userId: SELF }));
    expect(r.coverage.scopes.find((s) => s.scope.startsWith("Direct"))!.state).toBe("denied");
    expect(r.coverage.scopes.find((s) => s.scope.startsWith("Mentions"))!.state).toBe("empty");
    expect(r.coverage.state).toBe("partial");
    onTool(claude, SERVER, "slack_search_public_and_private", (a) => (a.cursor ? { text: "ratelimited", isError: true } : slackSearchAnswer([msg("D01", "U0MIA", 1, "hi")], "20")));
    const p = await slackAdapter.sync!(ctx(["dms"], { userId: SELF }));
    expect(p.coverage.state).toBe("partial");
    expect(p.observations).toHaveLength(1);
  });

  it("empty and unreadable: zero matches is empty; an unreadable result is partial, not empty", async () => {
    searchable([], []);
    expect((await slackAdapter.sync!(ctx(["dms"], { userId: SELF }))).coverage.state).toBe("empty");
    onTool(claude, SERVER, "slack_search_public_and_private", () => jsonAnswer({ results: "### Result 1 of 1\nChannel: ???\nText: \nno ids\n\n---\n" }));
    expect((await slackAdapter.sync!(ctx(["dms"], { userId: SELF }))).coverage.state).toBe("partial");
  });

  it("format drift: hits that no reader recognises make the scope partial, not empty", async () => {
    onTool(claude, SERVER, "slack_search_public_and_private", (a) => slackSearchInvalid(a) ?? slackSearchAnswer([msg("C01", "U0MIA", 1, "@Alex changed rendering", { channelName: "eng" })]));
    const r = await slackAdapter.sync!(ctx(["dms", "mentions"], { userId: SELF }));
    expect(r.coverage.scopes.map((s) => s.state)).toEqual(["partial", "partial"]);
    expect(r.coverage.scopes[1]!.note).toMatch(/recognised form/);
  });

  it("watched channels: history per channel; unconfigured is not_configured; an unreadable channel is partial", async () => {
    expect((await slackAdapter.sync!(ctx(["channels"], { userId: SELF }))).coverage.scopes[0]).toMatchObject({ state: "not_configured" });
    onTool(claude, SERVER, "slack_read_channel", (a) => (a.channel_id === "C01" ? slackHistoryAnswer("C01", [msg("C01", "U0BOB", 3, "Standup moved")]) : { text: "channel_not_found", isError: true }));
    const r = await slackAdapter.sync!(ctx(["channels"], { userId: SELF, channels: "C01,C02" }));
    expect(r.observations.map((o) => o.kind)).toEqual(["slack_channel_message"]);
    // History carries no permalink; the link is built from the workspace URL once a search result reveals it.
    expect(r.observations[0]!.url).toBeUndefined();
    onTool(claude, SERVER, "slack_search_public_and_private", (a) => slackSearchInvalid(a) ?? slackSearchAnswer([msg("D01", "U0MIA", 1, "hi")]));
    const linked = await slackAdapter.sync!(ctx(["dms", "channels"], { userId: SELF, channels: "C01" }));
    expect(linked.observations.find((o) => o.kind === "slack_channel_message")!.url).toMatch(/^https:\/\/acme\.slack\.com\/archives\/C01\/p\d+$/);
    expect(r.coverage.scopes[0]).toMatchObject({ state: "partial", note: expect.stringMatching(/Not read: C02/) });
  });

  it("execute: posts once through the gate, verifies by reading the message back; recovery matches author and text", async () => {
    const posted: SlackFixtureMessage[] = [];
    onTool(claude, SERVER, "slack_send_message", (a) => {
      const m = msg(String(a.channel_id), SELF, 0, String(a.message), a.thread_ts ? { threadTs: String(a.thread_ts) } : {});
      posted.push(m);
      return jsonAnswer({ ok: true, message_link: `https://acme.slack.com/archives/${m.channel}/p${m.ts.replace(".", "")}` });
    });
    onTool(claude, SERVER, "slack_read_thread", (a) => slackHistoryAnswer(String(a.channel_id), posted.filter((p) => p.threadTs === a.message_ts)));
    const action = { kind: "slack.post", target: { channel: "C01", thread_ts: "1790000000.000100" }, payload: { text: "**Looking** now" }, effectKey: "e3" };
    const c = ctx(["dms"], { userId: SELF });
    expect(await slackAdapter.findEffect!(c, action)).toBeNull();
    const r = await slackAdapter.execute!(c, action);
    expect(r).toMatchObject({ verified: true, remoteId: posted[0]!.ts, url: expect.stringContaining("/archives/C01/") });
    expect(calls("slack_send_message")).toEqual([{ server: SERVER, tool: "slack_send_message", args: { channel_id: "C01", message: "**Looking** now", thread_ts: "1790000000.000100" } }]);
    // Slack rewrote the Markdown; recovery still recognises our message.
    posted[0]!.text = "*Looking* now";
    expect(await slackAdapter.findEffect!(c, action)).toMatchObject({ verified: true, remoteId: posted[0]!.ts });
    await expect(slackAdapter.execute!(c, { ...action, target: { channel: "not-a-channel" } })).rejects.toThrow(/Invalid Slack channel/);
  });

  it("recovery: matches only my message created after the attempt started, with links in either Markdown form", async () => {
    const history: SlackFixtureMessage[] = [msg("C01", SELF, 30, "see <https://x.example/doc|the doc>")];
    onTool(claude, SERVER, "slack_read_channel", (a) => slackHistoryAnswer("C01", history.filter((m) => Number(m.ts) >= Number(a.oldest ?? 0))));
    const action = { kind: "slack.post", target: { channel: "C01" }, payload: { text: "see [the doc](https://x.example/doc)" }, effectKey: "e9" };
    const c = ctx(["dms"], { userId: SELF });
    // Same text, but posted a day before this attempt started: not ours.
    expect(await slackAdapter.findEffect!(c, { ...action, since: new Date(NOW_S * 1000 - 3_600_000).toISOString() })).toBeNull();
    expect(await slackAdapter.findEffect!(c, { ...action, since: new Date(NOW_S * 1000 - 31 * 3_600_000).toISOString() })).toMatchObject({ verified: true });
  });

  it("parsers: search, history, send confirmation and loose text identity", () => {
    const s = parseSearch(slackSearchAnswer([msg("C01", "U0MIA", 1, "multi\nline", { threadTs: "1790000000.000001", channelName: "eng" })], "abc=").text);
    expect(s).toMatchObject({ cursor: "abc=", unreadable: 0, items: [{ channel: "C01", channelName: "eng", user: "U0MIA", threadTs: "1790000000.000001", text: "multi\nline" }] });
    const h = parseHistory(slackHistoryAnswer("C01", [msg("C01", "UBOB1234", 2, "hello")], "next").text, "C01");
    expect(h).toMatchObject({ cursor: "next", items: [{ user: "UBOB1234", text: "hello" }] });
    expect(sentTs('{"ts":"1790000000.123456"}').ts).toBe("1790000000.123456");
    expect(sameText("<https://x.com|link> **bold**", "link bold")).toBe(true);
    expect(sameText("", "")).toBe(false);
  });
});
