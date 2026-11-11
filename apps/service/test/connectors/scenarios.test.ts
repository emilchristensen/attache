import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionKind } from "@jarvis/contracts";
import { githubAdapter } from "../../src/connectors/github.ts";
import { jiraAdapter } from "../../src/connectors/jira.ts";
import { confluenceAdapter } from "../../src/connectors/confluence.ts";
import { slackAdapter } from "../../src/connectors/slack.ts";
import { gmailAdapter } from "../../src/connectors/gmail.ts";
import { gcalAdapter } from "../../src/connectors/gcal.ts";
import { startFixtureServer, type FixtureServer } from "../fixtures/fixture-server.ts";
import { fixtureContext } from "../fixtures/adapter-harness.ts";
import { ATLASSIAN_SITE, ATLASSIAN_TOKEN, FIXTURE_PREFIX, addJiraOverdue, installScenarios, setPrHeadSha, type ScenarioState } from "../fixtures/scenarios.ts";
import { useFakeClaude, type ClaudeFixture } from "../fixtures/claude-connectors.ts";

// Each test starts many fake Claude Code processes one after another, which is slow while other suites share the machine.
vi.setConfig({ testTimeout: 120_000 });

let fx: FixtureServer;
let state: ScenarioState;
let claude: ClaudeFixture;
beforeAll(async () => {
  fx = await startFixtureServer();
  useFakeClaude(fx.url);
});
afterAll(() => fx.close());
beforeEach(() => {
  fx.reset();
  ({ state, claude } = installScenarios(fx, { selfEmail: "alex@example.com" }));
});

/** A context that routes each default base through its scenario prefix, like JARVIS_TEST_ENDPOINTS does. */
function scenarioCtx(kind: ConnectionKind, opts: { scopes: string[]; secrets?: Record<string, string>; settings?: Record<string, unknown> }) {
  const c = fixtureContext({ kind, baseUrl: fx.url, readScopes: opts.scopes, selfEmail: "alex@example.com", ...(opts.secrets ? { secrets: opts.secrets } : {}), ...(opts.settings ? { settings: opts.settings } : {}), now: new Date() });
  c.endpoint = (d) => {
    const prefix = FIXTURE_PREFIX[d.replace(/\/$/, "")];
    return prefix ? `${fx.url}${prefix}` : d;
  };
  return c;
}

const atlassianSettings = { siteUrl: ATLASSIAN_SITE, email: "alex@example.com", authMethod: "api-token" };

describe("scenario fixtures drive every adapter end to end", () => {
  it("GitHub: review requests, and a new head sha changes the fingerprint", async () => {
    const c = scenarioCtx("github", { scopes: ["review_requests"], secrets: { token: "ghp_fixture" } });
    const a = await githubAdapter.sync!(c);
    expect(a.coverage.state).toBe("complete");
    expect(a.observations.map((o) => o.attention?.key)).toEqual(["github:pr:acme/web#42", "github:pr:acme/api#7"]);
    setPrHeadSha(state, 42, "fff000");
    const b = await githubAdapter.sync!(c);
    expect(b.observations[0]!.fingerprintParts).not.toEqual(a.observations[0]!.fingerprintParts);
  });

  it("Jira: due item, then an added overdue item; comment round-trip through the Atlassian MCP server", async () => {
    const c = scenarioCtx("jira", { scopes: ["assigned_open", "due_soon"], secrets: { apiToken: ATLASSIAN_TOKEN }, settings: atlassianSettings });
    const t = await jiraAdapter.test(c);
    expect(t.account).toBe("alex@example.com");
    c.connection.settings = { ...c.connection.settings, ...t.settings };
    const a = await jiraAdapter.sync!(c);
    expect(a.observations.filter((o) => o.attention).map((o) => o.attention!.kind)).toEqual(["due_work_item"]);
    addJiraOverdue(state, "ABC-9", "Send invoice", 2);
    const b = await jiraAdapter.sync!(c);
    expect(b.observations.find((o) => o.externalId === "ABC-9")!.attention).toMatchObject({ key: "jira:ABC-9", kind: "overdue_work_item" });
    const action = { kind: "jira.comment", target: { key: "ABC-1" }, payload: { body: "Done" }, effectKey: "e1" };
    expect((await jiraAdapter.execute!(c, action)).verified).toBe(true);
    expect((await jiraAdapter.findEffect!(c, action))?.verified).toBe(true);
  });

  it("Confluence: mention attention and comment round-trip through the Atlassian MCP server", async () => {
    const c = scenarioCtx("confluence", { scopes: ["mentions", "my_recent"], secrets: { apiToken: ATLASSIAN_TOKEN }, settings: atlassianSettings });
    expect((await confluenceAdapter.test(c)).ok).toBe(true);
    const s = await confluenceAdapter.sync!(c);
    expect(s.coverage.state).toBe("complete");
    expect(s.observations.filter((o) => o.attention).map((o) => o.attention!.key)).toEqual(["confluence:mention:1001"]);
    const action = { kind: "confluence.comment", target: { pageId: "1001" }, payload: { body: "Noted" }, effectKey: "e2" };
    expect((await confluenceAdapter.execute!(c, action)).verified).toBe(true);
    expect((await confluenceAdapter.findEffect!(c, action))?.verified).toBe(true);
  });

  it("Slack: pending DM, mention, watched channel, and a verified post through the claude.ai connector", async () => {
    const c = scenarioCtx("slack", { scopes: ["dms", "mentions", "channels"], settings: { authMethod: "claude-ai", channels: "C0000001" } });
    const s = await slackAdapter.sync!(c);
    expect(s.coverage.state).toBe("complete");
    expect(s.observations.filter((o) => o.attention).map((o) => o.attention!.kind).sort()).toEqual(["mention", "pending_reply"]);
    const action = { kind: "slack.post", target: { channel: "D0000001" }, payload: { text: "Looking now" }, effectKey: "e3" };
    expect((await slackAdapter.execute!(c, action)).verified).toBe(true);
    expect((await slackAdapter.findEffect!(c, action))?.verified).toBe(true);
  });

  it("Gmail: one pending reply; the reply is saved as a draft, never sent", async () => {
    const c = scenarioCtx("gmail", { scopes: ["inbox_recent"], settings: { authMethod: "claude-ai" } });
    expect((await gmailAdapter.test(c)).account).toBe("alex@example.com");
    const s = await gmailAdapter.sync!(c);
    expect(s.coverage.state).toBe("complete");
    expect(s.observations.filter((o) => o.attention).map((o) => o.attention!.key)).toEqual(["gmail:thr1"]);
    const draft = s.observations.find((o) => o.attention)!.attention!.draftable!;
    const action = { kind: "gmail.draft", target: draft.target, payload: { body: "Happy to renew." }, effectKey: "e4" };
    expect((await gmailAdapter.execute!(c, action)).verified).toBe(true);
    expect(state.gmail.drafts).toMatchObject([{ threadId: "thr1", body: "Happy to renew." }]);
    expect((await gmailAdapter.findEffect!(c, action))?.verified).toBe(true);
    expect(claude.calls.some((x) => x.tool === "send_message")).toBe(false);
  });

  it("Calendar: meeting prep and an invite response; a disconnected connector is unauthorized", async () => {
    const c = scenarioCtx("gcal", { scopes: ["upcoming"], settings: { authMethod: "claude-ai" } });
    const s = await gcalAdapter.sync!(c);
    expect(s.observations.filter((o) => o.attention).map((o) => [o.attention!.key, o.attention!.kind])).toEqual([["gcal:evt1", "meeting_prep"], ["gcal:evt2", "invite_response"]]);
    claude.servers = claude.servers.map((x) => (x.name === "claude.ai Google Calendar" ? { ...x, status: "needs-auth" } : x));
    expect((await gcalAdapter.sync!(c)).coverage.state).toBe("unauthorized");
  });
});
