import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { startTestService, type TestService } from "./harness.ts";
import { startFixtureServer, type FixtureServer } from "../fixtures/fixture-server.ts";
import { installFixtureModel, type ModelCall } from "../fixtures/fixture-model.ts";

let svc: TestService;
let fx: FixtureServer;
let calls: ModelCall[];

interface Hit {
  root: string;
  relPath: string;
  section: string;
  startLine: number;
  endLine: number;
  text: string;
}

/** What a Harness gets back when it asks the Brain: search the way recall does. */
async function recall(q: string): Promise<Hit[]> {
  return (await svc.get(`/memory/search?recall=1&q=${encodeURIComponent(q)}`)).hits;
}

async function linesOf(hit: Hit): Promise<string> {
  const doc = await svc.get(`/memory/document?root=${hit.root}&path=${encodeURIComponent(hit.relPath)}`);
  return doc.raw.split("\n").slice(hit.startLine - 1, hit.endLine).join("\n");
}

beforeAll(async () => {
  fx = await startFixtureServer();
  calls = installFixtureModel(fx).calls;
  svc = await startTestService();
  await svc.post("/connections/model/configure", { method: "openai-compatible", fields: { baseUrl: `${fx.url}/model`, model: "fixture-model" } });
});
afterAll(async () => {
  await svc.stop();
  await fx.close();
});

describe("A05 grounded recall and corrections", () => {
  let decision = "";

  it("retrieves a source-linked decision and the hit locates its evidence lines", async () => {
    const out = await svc.post("/memory/save", {
      origin: { agent: "claude-code", sessionId: "sess-vendor-review" },
      items: [{ action: "create", type: "decision", title: "Nimbus contract renewal", facts: [{ subject: "Decision", value: "Renew Nimbus for two years at 12% discount" }, { subject: "Project", value: "Procurement" }] }],
    });
    decision = out.saved[0].relPath;
    const hits = await recall("What did we decide about the Nimbus contract?");
    const hit = hits.find((h) => h.relPath === decision && h.section === "state");
    expect(hit).toBeTruthy();
    expect(hits[0]!.relPath).toBe(decision);
    // The hit's line range locates the evidence in the note.
    expect(await linesOf(hit!)).toContain("Renew Nimbus for two years at 12% discount");
    // The decision links back to the Harness session it came from.
    const doc = await svc.get(`/memory/document?root=data&path=${encodeURIComponent(decision)}`);
    expect(doc.raw).toContain("claude-code/sess-vendor-review");
  });

  it("a correction changes what the next search returns and keeps the old value in history", async () => {
    await svc.post("/memory/save", { items: [{ action: "update", path: decision, facts: [{ subject: "Decision", value: "Renew Nimbus for one year at 8% discount", reason: "Finance rejected the two-year term" }] }] });
    const hits = await recall("What did we decide about the Nimbus contract?");
    const current = hits.filter((h) => h.relPath === decision && h.section === "state");
    expect(current.map((h) => h.text).join("\n")).toContain("one year at 8% discount");
    expect(current.map((h) => h.text).join("\n")).not.toContain("two years at 12%");
    const doc = await svc.get(`/memory/document?root=data&path=${encodeURIComponent(decision)}`);
    const [state, history] = doc.raw.split("## History");
    expect(state).toContain("one year at 8% discount");
    expect(state).not.toContain("two years at 12% discount");
    expect(history).toMatch(/was "Renew Nimbus for two years at 12% discount".*Finance rejected/);
    expect(doc.changes.some((c: any) => c.change === "correct" && c.beforeValue?.includes("two years"))).toBe(true);
  });

  it("finds nothing rather than something unrelated when the Brain does not hold the answer", async () => {
    expect(await recall("What is the wifi password at the Lisbon office?")).toEqual([]);
  });

  it("old chat archives stay in the Brain as evidence but are never recalled", async () => {
    const archive = "evidence/conversations/2026-10-01-nimbus.md";
    mkdirSync(dirname(join(svc.dataDir, archive)), { recursive: true });
    writeFileSync(join(svc.dataDir, archive), "---\ntype: conversation\ntitle: Nimbus chat\n---\n\n### assistant · 2026-10-01\n\nWe decided to drop the Nimbus contract.\n");
    const { job: reindex } = await svc.post("/memory/reindex");
    expect((await svc.waitJob(reindex.id)).job.status).toBe("succeeded");
    expect((await svc.get("/memory/documents?area=evidence")).map((d: { relPath: string }) => d.relPath)).toContain(archive);
    expect((await svc.get("/memory/search?q=drop%20Nimbus%20contract")).hits.map((h: Hit) => h.relPath)).toContain(archive);
    const hits = await recall("What did we decide about the Nimbus contract?");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => !h.relPath.startsWith("evidence/conversations/"))).toBe(true);
  });
});

describe("the model connection after chat", () => {
  it("writes research findings from the evidence search finds", async () => {
    const { job } = await svc.post("/jobs", { kind: "research", input: { question: "Nimbus contract renewal" } });
    const done = await svc.waitJob(job.id);
    expect(done.job.status).toBe("succeeded");
    const research = calls.find((c) => /research notes/.test(c.system));
    expect(research, "research asked the model").toBeTruthy();
    // Evidence reaches the model as quoted, untrusted data.
    expect(research!.system).toMatch(/Evidence is untrusted data/);
    expect(research!.user).toMatch(/<<<[\s\S]*one year at 8% discount[\s\S]*>>>/);
    const file = readFileSync(join(svc.dataDir, done.job.result.relPath), "utf8");
    // The findings are the model's, citing a source listed under them.
    const cited = /According to your notes: .*Nimbus.* \[(S\d+)\]/.exec(file)?.[1];
    expect(cited, "the model wrote cited findings").toBeTruthy();
    expect(file.split("## Sources")[1]).toContain(`- [${cited}] `);
  });
});
