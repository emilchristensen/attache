import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startTestService, type TestService } from "./harness.ts";

let svc: TestService;
const NOTE = "memory/projects/orion-migration.md";

beforeAll(async () => {
  svc = await startTestService();
  await svc.post("/memory/save", { confirmed: true, items: [{ action: "create", type: "project", title: "Orion migration", facts: [{ subject: "Status", value: "Cutover planned" }], notes: "Moves billing to the ledger." }] });
});
afterAll(() => svc.stop());

describe("the Dashboard shows the Brain and decides only", () => {
  it("has no capture, note creation, correction or note editing endpoint, and none of them writes to the Brain", async () => {
    const before = readFileSync(join(svc.dataDir, NOTE), "utf8");
    for (const [method, path, body] of [
      ["POST", "/memory/capture", { text: "Orion cutover moved to Sunday.", source: { kind: "user", ref: "browser capture" }, decision: { title: "Orion cutover", decision: "Cut over on Sunday" } }],
      ["POST", "/memory/notes", { type: "note", title: "Typed in the Dashboard", state: [{ subject: "Idea", value: "x" }] }],
      ["POST", "/memory/correct", { relPath: NOTE, subject: "Status", value: "Cutover done", reason: "typed in the Dashboard" }],
      ["PUT", "/memory/notes-body", { relPath: NOTE, notes: "Replaced from the Dashboard." }],
    ] as const) {
      expect((await svc.call(method, path, body)).status, `${method} ${path}`).toBe(404);
    }
    expect(readFileSync(join(svc.dataDir, NOTE), "utf8")).toBe(before);
    expect(existsSync(join(svc.dataDir, "memory/notes/typed-in-the-dashboard.md"))).toBe(false);
    expect(existsSync(join(svc.dataDir, "memory/decisions/orion-cutover.md"))).toBe(false);
    const captures = join(svc.dataDir, "evidence/captures");
    expect(existsSync(captures) ? readdirSync(captures) : []).toEqual([]);
  });

  it("serves a note for reading without offering to edit it", async () => {
    const doc = await svc.get(`/memory/document?path=${encodeURIComponent(NOTE)}`);
    expect(doc).toMatchObject({ relPath: NOTE, title: "Orion migration", state: [expect.objectContaining({ subject: "Status", value: "Cutover planned" })] });
    expect(doc.raw).toContain("Moves billing to the ledger.");
    expect(doc).not.toHaveProperty("editable");
  });

  it("names the schedules it shows by what they do, with Source refresh for reading sources", async () => {
    const status = await svc.get("/status");
    expect(status.schedules.map((s: { label: string }) => s.label)).toEqual(["Daily briefing", "Source refresh"]);
  });
});
