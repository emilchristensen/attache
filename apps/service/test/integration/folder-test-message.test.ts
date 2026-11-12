import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTestService, testFolder, type TestService } from "./harness.ts";

let svc: TestService | null = null;
afterEach(async () => {
  await svc?.stop();
  svc = null;
});

async function setupTestMessage(s: TestService, id: string): Promise<string> {
  const r = await s.post("/setup/test");
  return (r.connections as Array<{ id: string; message: string }>).find((c) => c.id === id)!.message;
}

describe("what testing a folder of notes says", () => {
  it("a data folder Jarvis just created reports its one note and nothing skipped", async () => {
    // Setup as the Dashboard runs it: choose a folder that does not exist yet, then test.
    svc = await startTestService({ setup: false });
    await svc.post("/setup/data-folder", { path: svc.dataDir });
    expect(await setupTestMessage(svc, "vault-data")).toBe("1 Markdown file readable");
  });

  it("a refresh of a data folder with one note counts it as one file", async () => {
    svc = await startTestService();
    const { job } = await svc.post("/connections/vault-data/refresh");
    await svc.waitJob(job.id);
    const card = JSON.stringify((await svc.get("/connections")).find((c: { id: string }) => c.id === "vault-data"));
    expect(card).toContain("1 Markdown file indexed (");
  });

  it("leaves Jarvis's own folders in the data folder out of what it skipped", async () => {
    svc = await startTestService();
    // What Replication and replicated review state put in the data folder.
    mkdirSync(join(svc.dataDir, ".git"), { recursive: true });
    writeFileSync(join(svc.dataDir, ".git/HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(svc.dataDir, "review/proposals"), { recursive: true });
    writeFileSync(join(svc.dataDir, "review/proposals/p1.md"), "# Proposal\n");
    writeFileSync(join(svc.dataDir, "memory/notes.md"), "# Notes\n");
    expect(await setupTestMessage(svc, "vault-data")).toBe("2 Markdown files readable");
  });

  it("says which files it skipped and why", async () => {
    svc = await startTestService();
    mkdirSync(join(svc.dataDir, "evidence/big"), { recursive: true });
    writeFileSync(join(svc.dataDir, "evidence/big/dump.md"), "x".repeat(2 * 1024 * 1024 + 1));
    expect(await setupTestMessage(svc, "vault-data")).toBe("1 Markdown file readable, 1 skipped: evidence/big/dump.md (larger than 2 MB)");
  });

  it("names the first few skipped items of an imported folder and counts the rest", async () => {
    svc = await startTestService();
    const folder = testFolder("notes");
    writeFileSync(join(folder, "a.md"), "# A\n");
    writeFileSync(join(folder, "b.md"), "# B\n");
    for (const hidden of [".obsidian", ".trash", ".stversions", ".cache", "node_modules"]) mkdirSync(join(folder, hidden));
    const { connection } = await svc.post("/import", { path: folder, label: "Notes" });
    const { test } = await svc.post(`/connections/${connection.id}/test`);
    expect(test.message).toBe("2 Markdown files readable, 5 skipped: .cache/ (hidden or tool folder), .obsidian/ (hidden or tool folder), .stversions/ (hidden or tool folder) and 2 more");
  });
});
