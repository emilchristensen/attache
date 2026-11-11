import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { gmailAdapter, isCalendarNotification, parseThreadPage, summarizeThread, type GmailThread } from "../../src/connectors/gmail.ts";
import { startFixtureServer, type FixtureServer } from "../fixtures/fixture-server.ts";
import { fixtureContext } from "../fixtures/adapter-harness.ts";
import { jsonAnswer, mountClaude, onTool, useFakeClaude, type ClaudeFixture } from "../fixtures/claude-connectors.ts";

// Each test starts many fake Claude Code processes one after another, which is slow while other suites share the machine.
vi.setConfig({ testTimeout: 120_000 });

let fx: FixtureServer;
let claude: ClaudeFixture;
const SERVER = "claude.ai Gmail";
const SELF = "alex@example.com";
const NOW = Date.parse("2026-09-30T10:00:00Z");
const HOUR = 3_600_000;

const m = (id: string, sender: string, hoursAgo: number, labels: string[], subject = "Contract renewal") => ({ id, threadId: "t", sender, subject, snippet: `${subject} snippet`, labelIds: labels, internalDate: String(NOW - hoursAgo * HOUR), date: new Date(NOW - hoursAgo * HOUR).toISOString() });
const thread = (id: string, messages: ReturnType<typeof m>[]): GmailThread => ({ id, messages: messages.map((x) => ({ ...x, threadId: id })), viewUrl: `https://mail.google.com/mail/?authuser=${SELF}#all/thread-f:${id}` });

beforeAll(async () => {
  fx = await startFixtureServer();
  useFakeClaude(fx.url);
});
afterAll(() => fx.close());
beforeEach(() => {
  fx.reset();
  claude = mountClaude(fx);
});

function inbox(threads: GmailThread[], pageSize = 25) {
  onTool(claude, SERVER, "search_threads", (a) => {
    const start = Number(a.pageToken ?? 0);
    const page = threads.slice(start, start + pageSize);
    if (!page.length && !start) return jsonAnswer({});
    return jsonAnswer({ threads: page, ...(start + pageSize < threads.length ? { nextPageToken: String(start + pageSize) } : {}) });
  });
}

/**
 * The claude.ai Gmail connector as observed 2026-11-02: search_threads returns only id, sender (dots
 * stripped from the local part), subject, recipients and threadId per message, whatever the view;
 * get_thread still returns date, internalDate, labelIds and viewUrl.
 */
function currentConnectorInbox(threads: GmailThread[]) {
  const undot = (from: string) => from.replace(/([^<\s@]+)@/, (_, local: string) => `${local.replace(/\./g, "")}@`);
  onTool(claude, SERVER, "search_threads", () =>
    jsonAnswer({
      resultCountEstimate: String(threads.length),
      threads: threads.map((t) => ({ id: t.id, messageCount: t.messages!.length, messages: t.messages!.map((x) => ({ id: x.id, threadId: t.id, sender: undot(x.sender ?? ""), subject: x.subject })) })),
    }),
  );
  onTool(claude, SERVER, "get_thread", (a) => {
    const t = threads.find((x) => x.id === a.threadId);
    return t ? jsonAnswer({ ...t, messageCount: t.messages!.length }) : { text: "Requested entity was not found. 404", isError: true };
  });
}

const ctx = (scopes = ["inbox_recent"]) => fixtureContext({ kind: "gmail", baseUrl: fx.url, settings: { authMethod: "claude-ai" }, readScopes: scopes, selfEmail: SELF, now: new Date(NOW) });
const calls = (tool: string) => claude.calls.filter((c) => c.tool === tool);

describe("Gmail adapter contract (claude.ai Gmail connector)", () => {
  it("authorization: test makes one read and reports the mailbox; an unconnected connector is unauthorized", async () => {
    inbox([thread("t1", [m("a", "mia@client.example", 1, ["INBOX"])])]);
    expect(await gmailAdapter.test(ctx())).toMatchObject({ ok: true, account: SELF });
    claude.servers = [{ name: SERVER, status: "needs-auth", source: "claudeai" }];
    expect(await gmailAdapter.test(ctx())).toMatchObject({ ok: false, state: "unauthorized" });
    expect((await gmailAdapter.sync!(ctx())).coverage.state).toBe("unauthorized");
  });

  it("scope: the inbox query covers 7 days; an unselected scope makes no call", async () => {
    inbox([]);
    await gmailAdapter.sync!(ctx([]));
    expect(claude.calls).toHaveLength(0);
    await gmailAdapter.sync!(ctx());
    expect(calls("search_threads")[0]!.args).toMatchObject({ query: "in:inbox newer_than:7d", view: "THREAD_VIEW_MINIMAL" });
  });

  it("pending replies: labels decide unread/important; my own last message, calendar mail and old threads never count", async () => {
    inbox([
      thread("t1", [m("a", "Mia <mia@client.example>", 3, ["INBOX", "UNREAD", "IMPORTANT"])]),
      thread("t2", [m("b", "bob@client.example", 30, ["INBOX", "UNREAD"]), m("c", SELF, 20, ["SENT"])]),
      thread("t3", [m("d", "calendar-notification@google.com", 2, ["INBOX", "UNREAD"], "Invitation: Design review")]),
      thread("t4", [m("e", "old@client.example", 24 * 9, ["INBOX", "UNREAD"])]),
      thread("t5", [m("f", "quiet@client.example", 5, ["INBOX"])]),
    ]);
    const r = await gmailAdapter.sync!(ctx());
    expect(r.observations.filter((o) => o.attention).map((o) => o.attention!.key)).toEqual(["gmail:t1"]);
    expect(r.observations.map((o) => o.externalId).sort()).toEqual(["t1", "t2", "t3", "t5"]);
    expect(r.coverage).toMatchObject({ state: "complete", items: 4 });
    expect(r.coverage.scopes[0]!.note).toMatch(/1 thread\(s\) outside the 7-day window/);
    expect(r.observations[0]!.attention!.draftable).toMatchObject({ actionKind: "gmail.draft", target: { threadId: "t1", to: "mia@client.example", replyToMessageId: "a" } });
  });

  it("pagination and caps: follows nextPageToken; a page cap is partial", async () => {
    const many = Array.from({ length: 60 }, (_, i) => thread(`t${i}`, [m(`m${i}`, "x@client.example", 1 + i * 0.1, ["INBOX"])]));
    inbox(many);
    const r = await gmailAdapter.sync!(ctx());
    expect(r.coverage, JSON.stringify(r.coverage)).toMatchObject({ state: "complete", items: 60 });
    expect(calls("search_threads")).toHaveLength(3);
    inbox(Array.from({ length: 200 }, (_, i) => thread(`u${i}`, [m(`n${i}`, "x@client.example", 1, ["INBOX"])])));
    expect((await gmailAdapter.sync!(ctx())).coverage.state).toBe("partial");
  });

  it("empty, errors and retries: {} is empty; a tool error fails; a failed later page is partial; a skipped call is retried", async () => {
    inbox([]);
    expect((await gmailAdapter.sync!(ctx())).coverage.state).toBe("empty");
    onTool(claude, SERVER, "search_threads", () => ({ text: "Request had insufficient authentication scopes (403)", isError: true }));
    expect((await gmailAdapter.sync!(ctx())).coverage.state).toBe("denied");
    onTool(claude, SERVER, "search_threads", (a) => (a.pageToken ? { text: "Backend unavailable 503", isError: true } : jsonAnswer({ threads: [thread("t1", [m("a", "x@client.example", 1, ["INBOX"])])], nextPageToken: "25" })));
    expect((await gmailAdapter.sync!(ctx())).coverage.state).toBe("partial");
    onTool(claude, SERVER, "search_threads", () => ({ text: "not json" }));
    expect((await gmailAdapter.sync!(ctx())).coverage.state).toBe("error");
  });

  it("search results without dates or labels are completed with get_thread (metadata only, no bodies)", async () => {
    const self = "alex.morgan@example.com";
    const dotted = (scopes = ["inbox_recent"]) => fixtureContext({ kind: "gmail", baseUrl: fx.url, settings: { authMethod: "claude-ai" }, readScopes: scopes, selfEmail: self, now: new Date(NOW) });
    currentConnectorInbox([
      thread("t1", [m("a", "Mia <mia.berg@client.example>", 3, ["INBOX", "UNREAD", "IMPORTANT"])]),
      thread("t2", [m("b", "bob@client.example", 30, ["INBOX"]), m("c", self, 20, ["SENT"])]),
      thread("t3", [m("d", "old@client.example", 24 * 9, ["INBOX"])]),
    ]);
    const r = await gmailAdapter.sync!(dotted());
    expect(r.coverage, JSON.stringify(r.coverage)).toMatchObject({ state: "complete", items: 2 });
    // The reply goes to the real address, and my own last message (dots and all) is recognised.
    expect(r.observations.filter((o) => o.attention).map((o) => o.attention!.key)).toEqual(["gmail:t1"]);
    expect(r.observations.find((o) => o.externalId === "t1")!.attention!.draftable).toMatchObject({ target: { to: "mia.berg@client.example", replyToMessageId: "a" } });
    expect(calls("get_thread").map((c) => c.args)).toEqual(["t1", "t2", "t3"].map((threadId) => ({ threadId, messageFormat: "MINIMAL" })));
  });

  it("a thread whose details cannot be read stays unread coverage, not a silent drop", async () => {
    currentConnectorInbox([thread("t1", [m("a", "mia@client.example", 3, ["INBOX"])]), thread("t2", [m("b", "bob@client.example", 2, ["INBOX"])])]);
    onTool(claude, SERVER, "get_thread", (a) => (a.threadId === "t2" ? { text: "Backend unavailable 503", isError: true } : jsonAnswer(thread("t1", [m("a", "mia@client.example", 3, ["INBOX"])]))));
    const r = await gmailAdapter.sync!(ctx());
    expect(r.coverage).toMatchObject({ state: "partial", items: 1 });
    expect(r.coverage.scopes[0]!.note).toMatch(/1 thread\(s\) could not be read or dated/);
  });

  it("search results that already carry dates and labels make no get_thread calls", async () => {
    inbox([thread("t1", [m("a", "mia@client.example", 3, ["INBOX"])])]);
    await gmailAdapter.sync!(ctx());
    expect(calls("get_thread")).toHaveLength(0);
  });

  it("coverage: undated threads make the scope partial; an error inside the result is an error, not zero threads", async () => {
    inbox([thread("t1", [{ ...m("a", "x@client.example", 1, ["INBOX"]), internalDate: "", date: "" }])]);
    expect((await gmailAdapter.sync!(ctx())).coverage).toMatchObject({ state: "partial", items: 0 });
    onTool(claude, SERVER, "search_threads", () => jsonAnswer({ error: { code: 403, message: "PERMISSION_DENIED" } }));
    expect((await gmailAdapter.sync!(ctx())).coverage.state).toBe("denied");
  });

  it("execute: saves a reply draft (never sends), verified with get_draft; recovery matches thread and body", async () => {
    const drafts: Array<Record<string, unknown>> = [];
    onTool(claude, SERVER, "create_draft", (a) => {
      const d = { id: `r-${drafts.length + 1}`, threadId: "t1", viewUrl: "https://mail.google.com/mail/#drafts/r-1", plaintextBody: `${String(a.body)}\n\nOn Tue, Mia wrote: …` };
      drafts.push(d);
      return jsonAnswer({ id: d.id, threadId: d.threadId, viewUrl: d.viewUrl });
    });
    onTool(claude, SERVER, "get_draft", (a) => {
      const d = drafts.find((x) => x.id === a.draftId);
      return d ? jsonAnswer({ id: d.id, message: { threadId: d.threadId } }) : { text: "Not found", isError: true };
    });
    onTool(claude, SERVER, "list_drafts", () => jsonAnswer({ drafts }));
    const action = { kind: "gmail.draft", target: { threadId: "t1", to: "mia@client.example", subject: "Contract renewal", replyToMessageId: "a" }, payload: { body: "Happy to renew." }, effectKey: "e4" };
    expect(await gmailAdapter.findEffect!(ctx(), action)).toBeNull();
    const r = await gmailAdapter.execute!(ctx(), action);
    expect(r).toMatchObject({ verified: true, remoteId: "r-1", url: "https://mail.google.com/mail/#drafts/r-1" });
    expect(calls("create_draft")[0]!.args).toEqual({ to: ["mia@client.example"], subject: "Re: Contract renewal", body: "Happy to renew.", replyToMessageId: "a" });
    expect(calls("send_message")).toHaveLength(0);
    expect(await gmailAdapter.findEffect!(ctx(), action)).toMatchObject({ verified: true, remoteId: "r-1" });
    await expect(gmailAdapter.execute!(ctx(), { ...action, target: { ...action.target, to: "a@b.c, evil@x.y" } })).rejects.toThrow(/recipient/);
  });

  it("recovery: a draft only counts in the same thread, created after the attempt started", async () => {
    onTool(claude, SERVER, "list_drafts", () => jsonAnswer({ drafts: [{ id: "r-9", threadId: "other", plaintextBody: "Happy to renew." }, { id: "r-8", plaintextBody: "Happy to renew." }, { id: "r-7", threadId: "t1", date: "2026-09-29T08:00:00Z", plaintextBody: "Happy to renew." }] }));
    const action = { kind: "gmail.draft", target: { threadId: "t1", to: "mia@client.example", subject: "S", replyToMessageId: "a" }, payload: { body: "Happy to renew." }, effectKey: "e", since: "2026-09-30T09:00:00Z" };
    expect(await gmailAdapter.findEffect!(ctx(), action)).toBeNull();
  });

  it("helpers: calendar notification markers, thread summary from labels, page parsing", () => {
    expect(isCalendarNotification("Invitation: Sync @ Tue", "x")).toBe(true);
    expect(isCalendarNotification("Re: budget", "mia@x")).toBe(false);
    const s = summarizeThread(thread("t9", [m("a", "mia@x.example", 2, ["INBOX"]), m("b", SELF, 1, ["SENT"])]), SELF)!;
    expect(s).toMatchObject({ fromSelf: true, awaiting: false, lastMessageId: "b" });
    expect(parseThreadPage("{}")).toEqual({ items: [], next: null, unreadable: 0 });
    expect(parseThreadPage(JSON.stringify({ threads: [{ id: "ok1" }, { nope: 1 }], nextPageToken: "n" }))).toMatchObject({ next: "n", unreadable: 1 });
  });
});
