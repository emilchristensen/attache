import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Coverage } from "@attache/contracts";
import { startTestService, type TestService } from "./harness.ts";
import { startFixtureServer, type FixtureServer } from "../fixtures/fixture-server.ts";
import { applyCandidates } from "../../src/attention/engine.ts";

/**
 * `GET /decision-count`: the four inputs of the Decision count as totals over everything this Machine holds, so the
 * Dashboard's count stays exact above the list routes' default limits (`/attention` 200, `/actions` and
 * `/memory/proposals` 100).
 */

let svc: TestService;
let fx: FixtureServer;

const OPEN_ITEMS = 230;
const LONE_DRAFTS = 102;
const PROPOSALS = 101;

const coverage: Coverage = { state: "complete", scopes: [], items: 0, at: new Date().toISOString() };
const candidate = (n: number) => ({ key: `count:item-${n}`, kind: "deadline" as const, title: `Item ${n}`, summary: "", why: "", priority: 1, sourceKind: "count", connectionId: null, fingerprint: `fp-${n}`, evidence: [] });

/** A Draft, linked to the Inbox item with this key when one is given. */
function draft(itemKey: string | null, body: string) {
  return svc.app.actions.createDraft({ kind: "github.comment", connectionId: "github", title: body, target: { repo: "acme/web", number: 7 }, payload: { body }, context: {}, attentionItemKey: itemKey, createdBy: "test" });
}

/** The totals while every feature is on. */
const count = async () => (await svc.get("/decision-count")) as { inbox: number; drafts: number; proposals: number; signIns: number };

const itemByKey = async (key: string) => ((await svc.get("/attention?state=open,snoozed&limit=500")).items as Array<{ id: string; key: string }>).find((i) => i.key === key)!;

beforeAll(async () => {
  fx = await startFixtureServer();
  svc = await startTestService();
  applyCandidates(svc.app.db, { sourceKind: "count", connectionId: null, coverage, previousCoverage: null }, Array.from({ length: OPEN_ITEMS }, (_, i) => candidate(i)));
  for (let i = 0; i < LONE_DRAFTS; i++) draft(null, `lone draft ${i}`);
  for (let i = 0; i < PROPOSALS; i++) {
    await svc.post("/memory/proposals", { item: { action: "create", type: "note", title: `Counted note ${i}`, facts: [{ subject: "Status", value: `n${i}` }] }, reason: "count test" });
  }
  // A GitHub sign-in that is refused: the Connection needs sign-in.
  fx.route("GET", "/user", () => ({ status: 401, json: { message: "Bad credentials" } }));
  await svc.call("POST", "/connections/github/configure", { method: "token", fields: { token: "ghp_fixturetokenfixturetoken12345678", apiBaseUrl: fx.url } });
});
afterAll(async () => {
  await svc?.stop();
  await fx?.close();
});

describe("GET /decision-count", () => {
  it("returns exact totals above the list routes' default limits", async () => {
    expect((await svc.get("/attention?state=open")).items).toHaveLength(200);
    expect(await svc.get("/actions?status=draft,approved,revoked")).toHaveLength(100);
    expect((await svc.get("/memory/proposals?status=proposed")).proposals).toHaveLength(100);
    expect((await svc.get("/connections")).find((c: { id: string }) => c.id === "github").status).toBe("needs_auth");

    expect(await svc.get("/decision-count")).toEqual({ inbox: OPEN_ITEMS, drafts: LONE_DRAFTS, proposals: PROPOSALS, signIns: 1 });
  });

  // Each case below counts from the totals it finds, with Inbox items of its own, so it also runs alone.

  it("counts a Draft linked to an open Inbox item once, in Drafts, and its item again once the Draft is finished or being sent", async () => {
    const before = await count();
    const waiting = draft("count:item-0", "reply to item 0");
    draft("count:item-1", "reply to item 1");
    expect(await count()).toMatchObject({ inbox: before.inbox - 2, drafts: before.drafts + 2 });

    // Rejected: finished, so the item is a decision on Home again.
    await svc.post(`/actions/${waiting.id}/reject`, {});
    expect(await count()).toMatchObject({ inbox: before.inbox - 1, drafts: before.drafts + 1 });

    // Being sent: not a decision; its item still is.
    const sending = draft("count:item-2", "reply to item 2");
    svc.app.db.prepare("update actions set status = 'executing' where id = ?").run(sending.id);
    expect(await count()).toMatchObject({ inbox: before.inbox - 1, drafts: before.drafts + 1 });
    svc.app.db.prepare("update actions set status = 'succeeded' where id = ?").run(sending.id);
  });

  it("keeps counting a waiting Draft whose item was snoozed, and counts the snoozed item nowhere", async () => {
    const before = await count();
    draft("count:item-3", "reply to item 3");
    const item = await itemByKey("count:item-3");
    await svc.post(`/attention/${item.id}/decision`, { decision: "snooze", until: new Date(Date.now() + 3_600_000).toISOString() });
    expect(await count()).toMatchObject({ inbox: before.inbox - 1, drafts: before.drafts + 1 });
  });

  it("counts a Draft that ran past its expiry as finished, as the lists do, and the Inbox list that expires it announces it", async () => {
    const before = await count();
    const stale = draft("count:item-4", "reply to item 4");
    svc.app.db.prepare("update actions set expires_at = ? where id = ?").run(new Date(Date.now() - 1000).toISOString(), stale.id);
    const events: string[] = [];
    const listen = (e: { type: string }) => events.push(e.type);
    svc.app.bus.on("event", listen);
    try {
      await svc.get("/attention?state=open");
    } finally {
      svc.app.bus.off("event", listen);
    }
    expect(events).toEqual(expect.arrayContaining(["actions.changed", "attention.changed"]));
    expect(await count()).toMatchObject({ inbox: before.inbox, drafts: before.drafts });
    expect((await svc.get(`/actions/${stale.id}`)).status).toBe("expired");
  });

  it("returns off, not zero, for a part whose feature is switched off", async () => {
    const before = await count();
    await svc.put("/features", { changes: { drafts: false } });
    expect(await svc.get("/decision-count")).toEqual({ ...before, drafts: "off" });

    await svc.put("/features", { changes: { attention: false }, cascade: true });
    expect(await svc.get("/decision-count")).toEqual({ ...before, inbox: "off", drafts: "off" });

    await svc.put("/features", { changes: { attention: true, drafts: true }, cascade: true });
  });
});
