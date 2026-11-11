import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProposalView } from "@jarvis/contracts";
import { createPairingCode } from "../../src/http/security.ts";
import { startTestService, type TestService } from "./harness.ts";

let svc: TestService;
beforeAll(async () => {
  svc = await startTestService();
});
afterAll(() => svc.stop());

const ITEMS = [{ action: "create", type: "decision", title: "Ledger for billing", facts: [{ subject: "Decision", value: "Billing moves to the ledger" }] }];
const NOTE = "memory/decisions/ledger-for-billing.md";

/** A Dashboard session, as the browser gets it when it pairs. */
async function dashboardCookie(): Promise<string> {
  const { code } = createPairingCode(svc.app.db);
  const res = await fetch(`${svc.url}/api/v1/pair`, { method: "POST", headers: { "content-type": "application/json", "x-jarvis-client": "1" }, body: JSON.stringify({ code, kind: "browser" }) });
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

const pending = async () => ((await svc.get("/memory/proposals?limit=500")).proposals as ProposalView[]).filter((p) => p.status === "proposed");

describe("who a save writes as", () => {
  it("a save nobody confirmed waits as a Proposal and writes nothing", async () => {
    const before = (await pending()).length;
    const r = await svc.call("POST", "/memory/save", { origin: { agent: "claude-code", sessionId: "unconfirmed-1" }, items: ITEMS });
    expect(r.status).toBe(200);
    expect(r.body.saved).toEqual([]);
    expect(r.body.proposals).toHaveLength(1);
    expect(r.body.proposals[0]).toMatchObject({ status: "proposed", reason: expect.stringMatching(/not confirmed/) });
    expect(existsSync(join(svc.dataDir, NOTE))).toBe(false);
    expect((await pending()).length).toBe(before + 1);
  });

  it("a save the owner confirmed in the Harness writes as the owner", async () => {
    const r = await svc.call("POST", "/memory/save", { origin: { agent: "claude-code", sessionId: "confirmed-1" }, confirmed: true, items: [{ ...ITEMS[0], title: "Ledger for invoices" }] });
    expect(r.status).toBe(200);
    expect(r.body.saved).toMatchObject([{ action: "created", relPath: "memory/decisions/ledger-for-invoices.md" }]);
    expect(r.body.proposals).toEqual([]);
    expect(existsSync(join(svc.dataDir, "memory/decisions/ledger-for-invoices.md"))).toBe(true);
  });

  it("the Dashboard cannot save, confirmed or not, and nothing is written or proposed", async () => {
    const cookie = await dashboardCookie();
    const before = (await pending()).length;
    for (const body of [{ items: ITEMS }, { items: ITEMS, confirmed: true }]) {
      const res = await fetch(`${svc.url}/api/v1/memory/save`, { method: "POST", headers: { cookie, "content-type": "application/json", "x-jarvis-client": "1" }, body: JSON.stringify(body) });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("dashboard_cannot_save");
    }
    expect(existsSync(join(svc.dataDir, NOTE))).toBe(false);
    expect((await pending()).length).toBe(before);
  });
});
