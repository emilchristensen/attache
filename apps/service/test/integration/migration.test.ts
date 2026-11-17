import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestService, type TestService } from "./harness.ts";

let svc: TestService;
let old: string;
beforeAll(async () => {
  svc = await startTestService();
  old = mkdtempSync(join(tmpdir(), "jarvis-oldvault-"));
  mkdirSync(join(old, "notes/knowledge"), { recursive: true });
  mkdirSync(join(old, "notes/daily"), { recursive: true });
  mkdirSync(join(old, "generated/wiki"), { recursive: true });
  writeFileSync(join(old, "notes/knowledge/mia.md"), "---\ntitle: Mia Jensen\n---\n# Mia Jensen\n\nRole: design lead at the client.\nPrefers async review notes.\n");
  writeFileSync(join(old, "notes/daily/2026-09-01.md"), "# 2026-09-01\n\n- 10:00 kickoff with Mia\n");
  writeFileSync(join(old, "generated/wiki/Cluster.md"), "# Generated cluster page\n");
  writeFileSync(join(old, "notes/CACHE.md"), "# Cache\n");
});
afterAll(() => svc.stop());

describe("migrating another notes system into Jarvis", () => {
  it("archives a folder verbatim under evidence/archive, honouring excludes, and re-runs idempotently", async () => {
    const out = await svc.post("/memory/archive", { path: old, label: "old-notes", exclude: ["generated/", "notes/CACHE.md"], origin: "~/OldNotes at commit abc1234" });
    expect(out).toMatchObject({ relPath: "evidence/archive/old-notes/ARCHIVE.md", written: 2, unchanged: 0, excluded: 2, files: 2 });
    const copy = readFileSync(join(svc.dataDir, "evidence/archive/old-notes/notes/knowledge/mia.md"), "utf8");
    expect(copy).toBe(readFileSync(join(old, "notes/knowledge/mia.md"), "utf8"));
    const manifest = readFileSync(join(svc.dataDir, "evidence/archive/old-notes/ARCHIVE.md"), "utf8");
    expect(manifest).toMatch(/\| notes\/daily\/2026-09-01\.md \| \d+ \|/);
    expect(manifest).toMatch(/# Archive of ~\/OldNotes at commit abc1234/);
    // Excluded generated pages and caches are not carried over.
    const docs = (await svc.get("/memory/documents?area=evidence")) as Array<{ relPath: string }>;
    const paths = docs.map((d) => d.relPath);
    expect(paths).toContain("evidence/archive/old-notes/notes/daily/2026-09-01.md");
    expect(paths.filter((p) => /generated|CACHE\.md/.test(p))).toEqual([]);
    // Re-running copies only what changed.
    writeFileSync(join(old, "notes/daily/2026-09-01.md"), "# 2026-09-01\n\n- 10:00 kickoff with Mia\n- 11:00 follow-up\n");
    expect(await svc.post("/memory/archive", { path: old, label: "old-notes", exclude: ["generated/", "notes/CACHE.md"] })).toMatchObject({ written: 1, unchanged: 1 });
    expect((await svc.call("POST", "/memory/archive", { path: join(old, "missing"), label: "x" })).status).toBe(400);
    expect((await svc.call("POST", "/memory/archive", { path: old, label: "../escape" })).status).toBe(400);
  });
});
