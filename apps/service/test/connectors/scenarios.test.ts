import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConnectionKind } from "@jarvis/contracts";
import { githubAdapter } from "../../src/connectors/github.ts";
import { jiraAdapter } from "../../src/connectors/jira.ts";
import { confluenceAdapter } from "../../src/connectors/confluence.ts";
import { slackAdapter } from "../../src/connectors/slack.ts";
import { gmailAdapter } from "../../src/connectors/gmail.ts";
import { gcalAdapter } from "../../src/connectors/gcal.ts";
import { startFixtureServer, type FixtureServer } from "../fixtures/fixture-server.ts";
import { fixtureContext } from "../fixtures/adapter-harness.ts";
import { FIXTURE_PREFIX, addJiraOverdue, atlassianSiteUrls, grantGmailCompose, installScenarios, setPrHeadSha, type ScenarioState } from "../fixtures/scenarios.ts";

let fx: FixtureServer;
let state: ScenarioState;
beforeAll(async () => {
  fx = await startFixtureServer();
});
afterAll(() => fx.close());
beforeEach(() => {
  fx.reset();
  state = installScenarios(fx, { selfEmail: "alex@example.com" });
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

const googleSettings = { clientId: "123-abc.apps.googleusercontent.com" };

async function connectGoogle(kind: "gmail" | "gcal", scopes: string[]) {
  const adapter = kind === "gmail" ? gmailAdapter : gcalAdapter;
  const c = scenarioCtx(kind, { scopes, settings: googleSettings, secrets: { clientSecret: "GOCSPX-fixture" } });
  const authUrl = await adapter.authorizeUrl!(c, { redirectUri: "http://127.0.0.1:1/oauth/callback", state: "st", codeChallenge: "ch", scopes: [] });
  const res = await fetch(authUrl, { redirect: "manual" });
  const back = new URL(res.headers.get("location")!);
  expect(back.searchParams.get("state")).toBe("st");
  const done = await adapter.completeAuthorization!(c, { code: back.searchParams.get("code")!, redirectUri: "http://127.0.0.1:1/oauth/callback", codeVerifier: "verifier" });
  c.connection.settings = done.settings;
  return { c, done };
}

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

  it("Jira: due item, then an added overdue item; comment round-trip", async () => {
    const c = scenarioCtx("jira", { scopes: ["assigned_open", "due_soon"], secrets: { apiToken: "t" }, settings: { siteUrl: atlassianSiteUrls(fx).jira, email: "alex@example.com" } });
    expect((await jiraAdapter.test(c)).account).toBe("alex@example.com");
    const a = await jiraAdapter.sync!(c);
    expect(a.observations.filter((o) => o.attention).map((o) => o.attention!.kind)).toEqual(["due_work_item"]);
    addJiraOverdue(state, "ABC-9", "Send invoice", 2);
    const b = await jiraAdapter.sync!(c);
    expect(b.observations.find((o) => o.externalId === "ABC-9")!.attention).toMatchObject({ key: "jira:ABC-9", kind: "overdue_work_item" });
    const action = { kind: "jira.comment", target: { key: "ABC-1" }, payload: { body: "Done" }, effectKey: "e1" };
    expect((await jiraAdapter.execute!(c, action)).verified).toBe(true);
    expect((await jiraAdapter.findEffect!(c, action))?.verified).toBe(true);
  });

  it("Confluence: mention attention and comment round-trip under the /confluence site prefix", async () => {
    const c = scenarioCtx("confluence", { scopes: ["mentions", "my_recent"], secrets: { apiToken: "t" }, settings: { siteUrl: atlassianSiteUrls(fx).confluence, email: "alex@example.com" } });
    expect((await confluenceAdapter.test(c)).ok).toBe(true);
    const s = await confluenceAdapter.sync!(c);
    expect(s.coverage.state).toBe("complete");
    expect(s.observations.filter((o) => o.attention).map((o) => o.attention!.key)).toEqual(["confluence:mention:1001"]);
    const action = { kind: "confluence.comment", target: { pageId: "1001" }, payload: { body: "Noted" }, effectKey: "e2" };
    expect((await confluenceAdapter.execute!(c, action)).verified).toBe(true);
    expect((await confluenceAdapter.findEffect!(c, action))?.verified).toBe(true);
  });

  it("Slack: pending DM, mention, watched channel, and a verified post", async () => {
    const c = scenarioCtx("slack", { scopes: ["dms", "mentions", "channels"], secrets: { token: "xoxp-fixture" }, settings: { channels: "C0000001" } });
    const s = await slackAdapter.sync!(c);
    expect(s.coverage.state).toBe("complete");
    expect(s.observations.filter((o) => o.attention).map((o) => o.attention!.kind).sort()).toEqual(["mention", "pending_reply"]);
    const action = { kind: "slack.post", target: { channel: "D0000001" }, payload: { text: "Looking now" }, effectKey: "e3" };
    expect((await slackAdapter.execute!(c, action)).verified).toBe(true);
    expect((await slackAdapter.findEffect!(c, action))?.verified).toBe(true);
  });

  it("Gmail: OAuth redirect flow, one pending reply, draft denied until compose is granted", async () => {
    const { c, done } = await connectGoogle("gmail", ["inbox_recent"]);
    expect(done.account).toBe("alex@example.com");
    const s = await gmailAdapter.sync!(c);
    expect(s.coverage.state).toBe("complete");
    expect(s.observations.filter((o) => o.attention).map((o) => o.attention!.key)).toEqual(["gmail:thr1"]);
    const draft = s.observations[0]!.attention!.draftable!;
    const action = { kind: "gmail.draft", target: draft.target, payload: { body: "Happy to renew." }, effectKey: "e4" };
    await expect(gmailAdapter.execute!(c, action)).rejects.toMatchObject({ state: "denied" });
    grantGmailCompose(state);
    const again = await connectGoogle("gmail", ["inbox_recent"]);
    expect((await gmailAdapter.execute!(again.c, action)).verified).toBe(true);
    expect((await gmailAdapter.findEffect!(again.c, action))?.verified).toBe(true);
  });

  it("Calendar: meeting prep and an invite response; revoked refresh token is unauthorized", async () => {
    const { c } = await connectGoogle("gcal", ["upcoming"]);
    const s = await gcalAdapter.sync!(c);
    expect(s.observations.filter((o) => o.attention).map((o) => [o.attention!.key, o.attention!.kind])).toEqual([["gcal:evt1", "meeting_prep"], ["gcal:evt2", "invite_response"]]);
    state.google.revoked = true;
    c.secrets.set("accessTokenExpiresAt", new Date(0).toISOString());
    expect((await gcalAdapter.sync!(c)).coverage.state).toBe("unauthorized");
  });
});
