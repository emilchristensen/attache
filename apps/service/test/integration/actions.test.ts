import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestService, type TestService } from "./harness.ts";
import { startFixtureServer, type FixtureServer } from "../fixtures/fixture-server.ts";
import { installFixtureModel } from "../fixtures/fixture-model.ts";
import { addBusinessHours } from "../../src/actions/expiry.ts";
import { APPROVAL_TTL_MS } from "../../src/actions/service.ts";
import { ManualClock } from "../fixtures/manual-clock.ts";

let svc: TestService;
let fx: FixtureServer;
const clock = new ManualClock();
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
  const sync = await svc.post("/connections/github/refresh");
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
  svc = await startTestService({ clock });
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
    await clock.advance(16 * 60_000);
    expect((await svc.call("POST", `/actions/${r3.id}/execute`, { nonce: a3.approval.nonce, version: 1, payloadHash: r3.payloadHash })).body.error.code).toBe("approval_expired");
    // Draft expired (48 business hours): housekeeping expires it on the service's clock, and the Dashboard hears of it.
    const events: string[] = [];
    const listen = (e: { type: string }) => events.push(e.type);
    svc.app.bus.on("event", listen);
    clock.skip(8 * 86_400_000);
    await clock.advance(30_000);
    svc.app.bus.off("event", listen);
    expect(events).toContain("attention.changed");
    expect(events).toContain("actions.changed");
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

  it("a failed check for an earlier attempt is never treated as 'not sent': the action is unknown and nothing is sent", async () => {
    await svc.put("/connections/github/write-actions", { writeActions: ["github.comment"], confirm: true });
    const d = svc.app.actions.createDraft({ kind: "github.comment", connectionId: "github", title: "t", target: { repo: "acme/web", number: 7 }, payload: { body: "retry me" }, context: {}, createdBy: "test" });
    const ap = await svc.post(`/actions/${d.id}/approve`, { version: 1, payloadHash: d.payloadHash });
    // An earlier attempt was interrupted after it may have sent; the lookup that would confirm it is refused.
    svc.app.db.prepare("insert into side_effects (effect_key, status, created_at) values (?, 'pending', ?)").run(`action:${d.id}:v1`, new Date().toISOString());
    fx.route("GET", "/gh/repos/acme/web/issues/7/comments", () => ({ status: 401, json: { message: "Bad credentials" } }));
    const before = posted.length;
    const exec = await svc.post(`/actions/${d.id}/execute`, { nonce: ap.approval.nonce, version: 1, payloadHash: d.payloadHash });
    await svc.waitJob(exec.job.id);
    const after = await svc.get(`/actions/${d.id}`);
    expect(after.status).toBe("unknown");
    expect(after.receipt.error).toMatch(/Could not check whether an earlier attempt/);
    expect(posted.length).toBe(before);
    expect((svc.app.db.prepare("select status from side_effects where effect_key = ?").get(`action:${d.id}:v1`) as { status: string }).status).toBe("pending");
    fx.route("GET", "/gh/repos/acme/web/issues/7/comments", () => ({ json: posted }));
  });

  it("an approval that ends puts the draft back to draft, at the moment it ends, so it can be approved again", async () => {
    const d = svc.app.actions.createDraft({ kind: "github.comment", connectionId: "github", title: "t", target: { repo: "acme/web", number: 7 }, payload: { body: "approve me twice" }, context: {}, createdBy: "test" });
    const first = await svc.post(`/actions/${d.id}/approve`, { version: 1, payloadHash: d.payloadHash });
    expect(first.executable.ok).toBe(true);
    const events: Array<{ type: string; id?: string }> = [];
    const listen = (e: { type: string; id?: string }) => events.push(e);
    svc.app.bus.on("event", listen);
    // Housekeeping wakes when the approval ends, not up to half a minute later, so an open Dashboard hears of it at once.
    await clock.advance(APPROVAL_TTL_MS);
    svc.app.bus.off("event", listen);
    expect(events).toContainEqual({ type: "actions.changed", id: d.id });
    const ended = await svc.get(`/actions/${d.id}`);
    expect(ended.status).toBe("draft");
    expect(ended.approval).toBeNull();
    expect(ended.executable).toEqual({ ok: false, reason: "Needs approval" });
    expect(ended.events.at(-1)).toMatchObject({ event: "approval_expired", actor: "service", data: { version: 1 } });
    // The ended approval still cannot send, and says why.
    expect((await svc.call("POST", `/actions/${d.id}/execute`, { nonce: first.approval.nonce, version: 1, payloadHash: d.payloadHash })).body.error.code).toBe("approval_expired");
    // Approving again is all it takes.
    const again = await svc.post(`/actions/${d.id}/approve`, { version: 1, payloadHash: d.payloadHash });
    expect(again.status).toBe("approved");
    expect(again.executable.ok).toBe(true);
    expect(again.approval.nonce).not.toBe(first.approval.nonce);
    const exec = await svc.post(`/actions/${d.id}/execute`, { nonce: again.approval.nonce, version: 1, payloadHash: d.payloadHash });
    await svc.waitJob(exec.job.id);
    expect((await svc.get(`/actions/${d.id}`)).status).toBe("succeeded");
  });

  it("a read never shows an approval past its end, even before housekeeping runs", async () => {
    const d = svc.app.actions.createDraft({ kind: "github.comment", connectionId: "github", title: "t", target: { repo: "acme/web", number: 7 }, payload: { body: "read me late" }, context: {}, createdBy: "test" });
    await svc.post(`/actions/${d.id}/approve`, { version: 1, payloadHash: d.payloadHash });
    // Time passes without any timer running, as when the computer was asleep.
    clock.skip(APPROVAL_TTL_MS + 1_000);
    const listed = (await svc.get("/actions?status=draft,approved")).find((a: { id: string }) => a.id === d.id);
    expect(listed).toMatchObject({ status: "draft", approval: null });
    const one = await svc.get(`/actions/${d.id}`);
    expect(one.status).toBe("draft");
    expect(one.events.filter((e: { event: string }) => e.event === "approval_expired")).toHaveLength(1);
    expect((await svc.post(`/actions/${d.id}/approve`, { version: 1, payloadHash: d.payloadHash })).status).toBe("approved");
    await clock.advance(0);
  });

  it("unknown read scopes and write actions are refused and named, one or several", async () => {
    const message = async (path: string, body: unknown) => {
      const r = await svc.call("PUT", path, body);
      expect(r.status).toBe(422);
      return r.body.error.message;
    };
    expect(await message("/connections/github/scopes", { readScopes: ["everything"] })).toBe("1 unknown scope: everything");
    expect(await message("/connections/github/scopes", { readScopes: ["everything", "more"] })).toBe("2 unknown scopes: everything, more");
    expect(await message("/connections/github/write-actions", { writeActions: ["github.merge"], confirm: true })).toBe("1 unknown write action: github.merge");
    expect(await message("/connections/github/write-actions", { writeActions: ["github.merge", "github.close"], confirm: true })).toBe("2 unknown write actions: github.merge, github.close");
  });

  it("an attention item carries its linked draft's status, and a finished draft leaves it free for a new one", async () => {
    const reviewItem = async () => (await svc.get("/attention")).items.find((i: any) => i.kind === "review_request");
    // The first draft for this item was sent above.
    const sent = await reviewItem();
    expect(sent.actionStatus).toBe("succeeded");
    // Rejected: the item still names the draft, so the Drafts list keeps it, and preparing again makes a new one.
    const fresh = await prepareDraft();
    expect(fresh.id).not.toBe(sent.actionId);
    expect(await reviewItem()).toMatchObject({ actionId: fresh.id, actionStatus: "draft" });
    await svc.post(`/actions/${fresh.id}/reject`, {});
    expect(await reviewItem()).toMatchObject({ actionId: fresh.id, actionStatus: "rejected" });
    // Expired: the item reads the expiry as soon as the deadline passes, without waiting for housekeeping.
    const again = await prepareDraft();
    expect(again.id).not.toBe(fresh.id);
    expect(await reviewItem()).toMatchObject({ actionId: again.id, actionStatus: "draft" });
    clock.skip(8 * 86_400_000);
    expect(await reviewItem()).toMatchObject({ actionId: again.id, actionStatus: "expired" });
    expect((await svc.get(`/actions/${fresh.id}`)).status).toBe("rejected");
  });

  it("a rejected draft is locked: only an explicit Restore brings it back, as vN+1 with the same text, until it expires", async () => {
    const reviewItem = async () => (await svc.get("/attention")).items.find((i: any) => i.kind === "review_request");
    const d = await prepareDraft();
    const rejected = await svc.post(`/actions/${d.id}/reject`, {});
    // Saving text no longer un-rejects it behind the owner's back.
    const edit = await svc.call("PUT", `/actions/${d.id}`, { payload: { body: "typed into a rejected draft" }, expectedVersion: rejected.version });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe("not_editable");
    // Restore names the version it starts from, like an edit.
    expect((await svc.call("POST", `/actions/${d.id}/restore`, { expectedVersion: rejected.version - 1 })).body.error.code).toBe("version_conflict");
    const events: Array<{ type: string; id?: string }> = [];
    const listen = (e: { type: string; id?: string }) => events.push(e);
    svc.app.bus.on("event", listen);
    const restored = await svc.post(`/actions/${d.id}/restore`, { expectedVersion: rejected.version });
    svc.app.bus.off("event", listen);
    expect(restored).toMatchObject({ status: "draft", version: rejected.version + 1, payload: rejected.payload, payloadHash: rejected.payloadHash, approval: null, expiresAt: rejected.expiresAt });
    expect(restored.events.at(-1)).toMatchObject({ event: "restored", data: { version: rejected.version + 1 } });
    expect(events).toContainEqual({ type: "actions.changed", id: d.id });
    expect(await reviewItem()).toMatchObject({ actionId: d.id, actionStatus: "draft" });
    // Only a rejected draft restores.
    expect((await svc.call("POST", `/actions/${d.id}/restore`, { expectedVersion: restored.version })).body.error.code).toBe("not_restorable");
    // A newer draft for the same item already waits: restoring the old one would make two.
    await svc.post(`/actions/${d.id}/reject`, {});
    const newer = await prepareDraft();
    expect(newer.id).not.toBe(d.id);
    const twice = await svc.call("POST", `/actions/${d.id}/restore`, { expectedVersion: restored.version });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe("superseded");
    // Past its lifetime it stays rejected.
    clock.skip(8 * 86_400_000);
    expect((await svc.call("POST", `/actions/${d.id}/restore`, { expectedVersion: restored.version })).body.error.code).toBe("expired");
    expect((await svc.get(`/actions/${d.id}`)).status).toBe("rejected");
  });

  it("after a send of unknown outcome the item is not drafted again unless the owner explicitly asks for a replacement", async () => {
    const reviewItem = async () => (await svc.get("/attention")).items.find((i: any) => i.kind === "review_request");
    const d = await prepareDraft();
    const ap = await svc.post(`/actions/${d.id}/approve`, { version: d.version, payloadHash: d.payloadHash });
    // The comment is posted, but reading it back fails: nobody knows whether it arrived.
    fx.route("GET", /^\/gh\/repos\/acme\/web\/issues\/comments\/\d+$/, () => ({ status: 500, json: { message: "Server Error" } }));
    const exec = await svc.post(`/actions/${d.id}/execute`, { nonce: ap.approval.nonce, version: d.version, payloadHash: d.payloadHash });
    await svc.waitJob(exec.job.id);
    fx.route("GET", /^\/gh\/repos\/acme\/web\/issues\/comments\/\d+$/, (req) => ({ json: posted.find((p) => String(p.id) === req.path.split("/").pop()) }));
    const item = await reviewItem();
    expect(item).toMatchObject({ state: "open", actionId: d.id, actionStatus: "unknown" });
    // Asking for a Draft as usual is refused, and nothing is queued.
    const jobsBefore = (await svc.get("/jobs?limit=200")).length;
    const plain = await svc.call("POST", `/attention/${item.id}/draft`, {});
    expect(plain.status).toBe(409);
    expect(plain.body.error.code).toBe("delivery_unconfirmed");
    expect(plain.body.error.message).toBe("The last Draft for this item may have been sent. Check the destination, then choose to prepare a replacement.");
    expect((await svc.get("/jobs?limit=200")).length).toBe(jobsBefore);
    expect(await reviewItem()).toMatchObject({ actionId: d.id, actionStatus: "unknown" });
    // The explicit choice prepares a new Draft; the uncertain one keeps its outcome.
    const { job } = await svc.post(`/attention/${item.id}/draft`, { replaceUnconfirmed: true });
    const done = await svc.waitJob(job.id);
    expect(done.job.status).toBe("succeeded");
    expect(done.job.result.actionId).not.toBe(d.id);
    expect(await reviewItem()).toMatchObject({ actionId: done.job.result.actionId, actionStatus: "draft" });
    expect((await svc.get(`/actions/${d.id}`)).status).toBe("unknown");
  });

  it("draft expiry counts business hours only", () => {
    const fri = new Date("2026-10-02T16:00:00Z");
    expect(addBusinessHours(fri, 48).toISOString()).toBe("2026-10-06T16:00:00.000Z");
    const sat = new Date("2026-10-03T10:00:00Z");
    expect(addBusinessHours(sat, 24).toISOString()).toBe("2026-10-06T00:00:00.000Z");
  });
});
