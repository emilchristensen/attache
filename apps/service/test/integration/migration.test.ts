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
  mkdirSync(join(old, "brain/knowledge"), { recursive: true });
  mkdirSync(join(old, "brain/daily"), { recursive: true });
  mkdirSync(join(old, "graphify-out/wiki"), { recursive: true });
  writeFileSync(join(old, "brain/knowledge/mia.md"), "---\ntitle: Mia Jensen\n---\n# Mia Jensen\n\nRole: design lead at the client.\nPrefers async review notes.\n");
  writeFileSync(join(old, "brain/daily/2026-09-01.md"), "# 2026-09-01\n\n- 10:00 kickoff with Mia\n");
  writeFileSync(join(old, "graphify-out/wiki/Cluster.md"), "# Generated cluster page\n");
  writeFileSync(join(old, "brain/HOT.md"), "# Cache\n");
});
afterAll(() => svc.stop());

describe("migrating another notes system into Jarvis", () => {
  it("archives a folder verbatim under evidence/archive, honouring excludes, and re-runs idempotently", async () => {
    const out = await svc.post("/memory/archive", { path: old, label: "old-notes", exclude: ["graphify-out/", "brain/HOT.md"], origin: "~/OldNotes at commit abc1234" });
    expect(out).toMatchObject({ relPath: "evidence/archive/old-notes/ARCHIVE.md", written: 2, unchanged: 0, excluded: 2, files: 2 });
    const copy = readFileSync(join(svc.dataDir, "evidence/archive/old-notes/brain/knowledge/mia.md"), "utf8");
    expect(copy).toBe(readFileSync(join(old, "brain/knowledge/mia.md"), "utf8"));
    const manifest = readFileSync(join(svc.dataDir, "evidence/archive/old-notes/ARCHIVE.md"), "utf8");
    expect(manifest).toMatch(/\| brain\/daily\/2026-09-01\.md \| \d+ \|/);
    expect(manifest).toMatch(/# Archive of ~\/OldNotes at commit abc1234/);
    // Excluded generated pages and caches are not carried over.
    const docs = (await svc.get("/memory/documents?area=evidence")) as Array<{ relPath: string }>;
    const paths = docs.map((d) => d.relPath);
    expect(paths).toContain("evidence/archive/old-notes/brain/daily/2026-09-01.md");
    expect(paths.filter((p) => /graphify-out|HOT\.md/.test(p))).toEqual([]);
    // Re-running copies only what changed.
    writeFileSync(join(old, "brain/daily/2026-09-01.md"), "# 2026-09-01\n\n- 10:00 kickoff with Mia\n- 11:00 follow-up\n");
    expect(await svc.post("/memory/archive", { path: old, label: "old-notes", exclude: ["graphify-out/", "brain/HOT.md"] })).toMatchObject({ written: 1, unchanged: 1 });
    expect((await svc.call("POST", "/memory/archive", { path: join(old, "missing"), label: "x" })).status).toBe(400);
    expect((await svc.call("POST", "/memory/archive", { path: old, label: "../escape" })).status).toBe(400);
  });

  it("a migrated note keeps each fact's original date and source line, carries history, and is found and cited", async () => {
    const src = (lines: [number, number]) => ({ kind: "import", root: "data", ref: "evidence/archive/old-notes/brain/knowledge/mia.md", lines, observedAt: "2026-09-01T00:00:00Z", label: "OldNotes: mia" });
    const out = await svc.post("/memory/notes", {
      type: "person",
      title: "Mia Jensen",
      provenance: "migrated",
      tags: ["client"],
      state: [
        { subject: "Role", value: "Design lead at the client", date: "2026-09-01", source: src([6, 6]) },
        { subject: "Review preference", value: "Prefers async review notes", date: "2026-08-15", source: src([7, 7]) },
      ],
      history: ["2026-07-01 — Role: contractor (superseded 2026-09-01)"],
      sources: [src([1, 7])],
    });
    const doc = readFileSync(join(svc.dataDir, out.relPath), "utf8");
    expect(doc).toMatch(/provenance: migrated/);
    expect(doc).toMatch(/- \*\*Role\*\* \(2026-09-01\): Design lead at the client — source: OldNotes: mia \(import: evidence\/archive\/old-notes\/brain\/knowledge\/mia\.md#L6-L6/);
    expect(doc).toMatch(/- \*\*Review preference\*\* \(2026-08-15\)/);
    expect(doc).toMatch(/## History[\s\S]*- 2026-07-01 — Role: contractor \(superseded 2026-09-01\)[\s\S]*created by user \(migrated, reviewed\)/);
    const hits = (await svc.get(`/memory/search?q=${encodeURIComponent("async review notes")}`)).hits;
    expect(hits.map((h: { relPath: string }) => h.relPath)).toEqual(expect.arrayContaining([out.relPath, "evidence/archive/old-notes/brain/knowledge/mia.md"]));
  });
});
