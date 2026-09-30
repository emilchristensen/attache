import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestService, type TestService } from "./harness.ts";
import { startFixtureServer, type FixtureServer } from "../fixtures/fixture-server.ts";
import { installFixtureModel } from "../fixtures/fixture-model.ts";
import { addBusinessHours } from "../../src/actions/expiry.ts";

let svc: TestService;
let fx: FixtureServer;
const posted: Array<{ id: number; body: string; html_url: string }> = [];

function githubFixture() {
  fx.route("GET", "/gh/user", () => ({ json: { login: "tester" }, headers: { "x-oauth-scopes": "repo" } }));
  fx.route("GET", "/gh/search/issues", (req) =>
    req.query.get("q")!.includes("review-requested")
      ? { json: { incomplete_results: false, items: [{ number: 7, title: "Add ledger migration", html_url: "https://github.com/acme/web/pull/7", state: "open", draft: false, user: { login: "priya" }, repository_url: "https://api.github.com/repos/acme/web", created_at: new Date(Date.now() - 2 * 86_400_000).toISOString(), updated_at: new Date().toISOString(), body: "Moves billing to the ledger." }] } }
      : { json: { incomplete_results: false, items: [] } },
  );
  fx.route("GET", "/gh/repos/acme/web/pulls/7", () => ({ json: { head: { sha: "abc123" } } }));
  fx.route("GET", "/gh/repos/acme/web/pulls/7/files", () => ({ json: [{ filename: "db/migrate.sql", status: "added", additions: 40, deletions: 0, patch: "+create table ledger" }] }));
  fx.route("POST", "/gh/repos/acme/web/issues/7/comments", (req) => {
    const c = { id: 900 + posted.length, body: (req.body as { body: string }).body, html_url: "https://github.com/acme/web/pull/7#issuecomment" };
    posted.push(c);
    return { status: 201, json: c };
  });
  fx.route("GET", /^\/gh\/repos\/acme\/web\/issues\/comments\/\d+$/, (req) => ({ json: posted.find((p) => String(p.id) === req.path.split("/").pop()) }));
  fx.route("GET", "/gh/repos/acme/web/issues/7/comments", () => ({ json: posted }));
}

async function prepareDraft() {
  const sync = await svc.post("/connections/github/sync");
  await svc.waitJob(sync.job.id);
  const item = (await svc.get("/attention")).items.find((i: any) => i.kind === "review_request");
  expect(item).toBeTruthy();
  const { job } = await svc.post(`/attention/${item.id}/draft`, {});
  const done = await svc.waitJob(job.id);
  expect(done.job.status).toBe("succeeded");
  return svc.get(`/actions/${done.job.result.actionId}`);
}

beforeAll(async () => {
  fx = await startFixtureServer();
  installFixtureModel(fx);
  githubFixture();
  svc = await startTestService();
  await svc.post("/connections/model/configure", { method: "openai-compatible", fields: { baseUrl: `${fx.url}/model`, model: "fixture" } });
  await svc.post("/connections/github/configure", { method: "token", fields: { token: "ghp_fixturetokenfixturetoken12345678", apiBaseUrl: `${fx.url}/gh` } });
});
afterAll(async () => {
  await svc.stop();
  await fx.close();
});

describe("A09 drafts and approvals are enforced on the server", () => {
  let draft: any;

  it("prepares a PR review draft with its context and evidence", async () => {
    draft = await prepareDraft();
    expect(draft.status).toBe("draft");
    expect(draft.kind).toBe("github.comment");
    expect(draft.payload.body).toMatch(/reviewed the changes/);
    expect(draft.context.fetched.changedFiles[0].file).toBe("db/migrate.sql");
    expect(draft.context.item.url).toBe("https://github.com/acme/web/pull/7");
    expect(Date.parse(draft.expiresAt)).toBeGreaterThan(Date.now() + 40 * 3_600_000);
  });

  it("editing creates a new version and invalidates approval", async () => {
    const approved = await svc.post(`/actions/${draft.id}/approve`, { version: draft.version, payloadHash: draft.payloadHash });
    expect(approved.status).toBe("approved");
    const edited = await svc.put(`/actions/${draft.id}`, { payload: { body: "LGTM after one question: is the migration reversible?" }, expectedVersion: approved.version });
    expect(edited).toMatchObject({ status: "draft", version: draft.version + 1, approval: null });
    expect(edited.payloadHash).not.toBe(draft.payloadHash);
    // The old approval nonce cannot execute the new payload.
    const r = await svc.call("POST", `/actions/${draft.id}/execute`, { nonce: approved.approval.nonce, version: edited.version, payloadHash: edited.payloadHash });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("not_approved");
    // Stale edits are rejected too.
    const stale = await svc.call("PUT", `/actions/${draft.id}`, { payload: { body: "x" }, expectedVersion: draft.version });
    expect(stale.body.error.code).toBe("version_conflict");
    // Approving with a stale hash fails.
    const bad = await svc.call("POST", `/actions/${draft.id}/approve`, { version: edited.version, payloadHash: draft.payloadHash });
    expect(bad.body.error.code).toBe("stale_approval");
    draft = edited;
  });

  it("execution fails without separately granted write authority", async () => {
    const a = await svc.post(`/actions/${draft.id}/approve`, { version: draft.version, payloadHash: draft.payloadHash });
    expect(a.executable).toEqual({ ok: false, reason: expect.stringMatching(/not authorised/) });
    const r = await svc.call("POST", `/actions/${draft.id}/execute`, { nonce: a.approval.nonce, version: a.version, payloadHash: a.payloadHash });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("not_authorized");
    expect(posted).toHaveLength(0);
    draft = a;
  });

  it("an approved, authorised action executes once, is marked sent only after verification, and replays fail", async () => {
    await svc.put("/connections/github/write-actions", { writeActions: ["github.comment"], confirm: true });
    const a = await svc.get(`/actions/${draft.id}`);
    expect(a.executable.ok).toBe(true);
    const exec = await svc.call("POST", `/actions/${draft.id}/execute`, { nonce: a.approval.nonce, version: a.version, payloadHash: a.payloadHash });
    expect(exec.status).toBe(202);
    expect(exec.body.action.status).toBe("executing");
    await svc.waitJob(exec.body.job.id);
    const done = await svc.get(`/actions/${draft.id}`);
    expect(done.status).toBe("succeeded");
    expect(done.receipt).toMatchObject({ verified: true, remoteId: "900" });
    expect(done.receipt.verifiedAt).toBeTruthy();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toContain("is the migration reversible?");
    const replay = await svc.call("POST", `/actions/${draft.id}/execute`, { nonce: a.approval.nonce, version: a.version, payloadHash: a.payloadHash });
    expect(replay.body.error.code).toBe("replayed");
    expect(posted).toHaveLength(1);
    expect(done.events.map((e: any) => e.event)).toEqual(expect.arrayContaining(["created", "approved", "edited", "approval_invalidated", "execution_refused", "execution_started", "execution_succeeded"]));
  });

  it("rejection, revocation, expiry and tampered payloads all block execution", async () => {
    const mk = () => svc.app.actions.createDraft({ kind: "github.comment", connectionId: "github", title: "t", target: { repo: "acme/web", number: 7 }, payload: { body: "hello" }, context: {}, createdBy: "test" });
    // Rejected
    const r1 = mk();
    await svc.post(`/actions/${r1.id}/reject`, {});
    expect((await svc.call("POST", `/actions/${r1.id}/approve`, { version: 1, payloadHash: r1.payloadHash })).body.error.code).toBe("not_approvable");
    // Revoked
    const r2 = mk();
    const a2 = await svc.post(`/actions/${r2.id}/approve`, { version: 1, payloadHash: r2.payloadHash });
    await svc.post(`/actions/${r2.id}/revoke`);
    expect((await svc.call("POST", `/actions/${r2.id}/execute`, { nonce: a2.approval.nonce, version: 1, payloadHash: r2.payloadHash })).body.error.code).toBe("not_approved");
    // Approval expired (15 minutes)
    const r3 = mk();
    const a3 = await svc.post(`/actions/${r3.id}/approve`, { version: 1, payloadHash: r3.payloadHash });
    const realNow = svc.app.actions.now;
    svc.app.actions.now = () => new Date(Date.now() + 16 * 60_000);
    expect((await svc.call("POST", `/actions/${r3.id}/execute`, { nonce: a3.approval.nonce, version: 1, payloadHash: r3.payloadHash })).body.error.code).toBe("approval_expired");
    // Draft expired (48 business hours)
    svc.app.actions.now = () => new Date(Date.now() + 8 * 86_400_000);
    svc.app.actions.expireStale();
    svc.app.actions.now = realNow;
    expect((await svc.get(`/actions/${r3.id}`)).status).toBe("expired");
    // Payload changed behind the approval's back
    const r4 = mk();
    const a4 = await svc.post(`/actions/${r4.id}/approve`, { version: 1, payloadHash: r4.payloadHash });
    svc.app.db.prepare("update actions set payload = ? where id = ?").run(JSON.stringify({ body: "tampered" }), r4.id);
    expect((await svc.call("POST", `/actions/${r4.id}/execute`, { nonce: a4.approval.nonce, version: 1, payloadHash: r4.payloadHash })).body.error.code).toBe("payload_changed");
    // Wrong nonce
    const r5 = mk();
    await svc.post(`/actions/${r5.id}/approve`, { version: 1, payloadHash: r5.payloadHash });
    expect((await svc.call("POST", `/actions/${r5.id}/execute`, { nonce: "0".repeat(48), version: 1, payloadHash: r5.payloadHash })).body.error.code).toBe("approval_mismatch");
    // Removing write authority revokes outstanding approvals
    await svc.put("/connections/github/write-actions", { writeActions: [], confirm: true });
    expect((await svc.get(`/actions/${r5.id}`)).status).toBe("revoked");
    expect(posted).toHaveLength(1);
  });

  it("draft expiry counts business hours only", () => {
    const fri = new Date("2026-10-02T16:00:00Z");
    expect(addBusinessHours(fri, 48).toISOString()).toBe("2026-10-06T16:00:00.000Z");
    const sat = new Date("2026-10-03T10:00:00Z");
    expect(addBusinessHours(sat, 24).toISOString()).toBe("2026-10-06T00:00:00.000Z");
  });
});
