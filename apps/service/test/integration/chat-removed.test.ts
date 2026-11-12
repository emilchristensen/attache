import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS } from "../../src/core/db.ts";
import { startTestService, type TestService } from "./harness.ts";

const running: TestService[] = [];
afterAll(async () => {
  for (const s of running) await s.stop().catch(() => {});
});

const ARCHIVE = "evidence/conversations/0b6f3c1e-chat.md";

/** The schema version an install had while Jarvis still kept conversations: every migration before the one that drops them. */
function chatEraSchema(db: DatabaseSync) {
  const drop = MIGRATIONS.findIndex((m) => /drop table if exists messages/.test(m));
  expect(drop, "a migration drops the chat tables").toBeGreaterThan(0);
  for (const m of MIGRATIONS.slice(0, drop)) db.exec(m);
  db.exec(`pragma user_version = ${drop}`);
}

/** A state folder and Brain as an install that used the chat left them: feature on, conversations stored, an archive in the Brain. */
function chatEraState(): { stateDir: string; dataDir: string } {
  const stateDir = mkdtempSync(join(tmpdir(), "jarvis-it-chat-state-"));
  const dataDir = join(mkdtempSync(join(tmpdir(), "jarvis-it-chat-data-")), "data");
  mkdirSync(join(dataDir, "evidence/conversations"), { recursive: true });
  mkdirSync(join(dataDir, "memory/projects"), { recursive: true });
  writeFileSync(join(dataDir, ARCHIVE), "---\ntype: conversation\ntitle: Zephyr rollout\nprovenance: conversation-archive\n---\n\n### user · 2026-10-01\n\nWhen does the Zephyr rollout start?\n\n### assistant · 2026-10-01\n\nThe Zephyr rollout starts on 3 November.\n");
  writeFileSync(join(dataDir, "memory/projects/zephyr.md"), "---\ntype: project\ntitle: Zephyr\n---\n\n# Zephyr\n\n## Current State\n\n- Rollout: starts 3 November\n");
  const now = new Date().toISOString();
  const db = new DatabaseSync(join(stateDir, "jarvis.sqlite"));
  chatEraSchema(db);
  const config = { schemaVersion: 1, setupCompleted: true, setupStep: 4, dataFolder: dataDir, features: { conversation: true, drafts: false } };
  db.prepare("insert into config (id, json, revision, updated_at) values (1, ?, 1, ?)").run(JSON.stringify(config), now);
  db.prepare("insert into conversations (id, title, created_at, updated_at) values ('0b6f3c1e', 'Zephyr rollout', ?, ?)").run(now, now);
  db.prepare("insert into messages (id, conversation_id, role, content, status, created_at, updated_at) values ('m1', '0b6f3c1e', 'user', 'When does the Zephyr rollout start?', 'complete', ?, ?)").run(now, now);
  db.prepare("insert into messages (id, conversation_id, role, content, status, created_at, updated_at) values ('m2', '0b6f3c1e', 'assistant', 'half an answer', 'streaming', ?, ?)").run(now, now);
  db.close();
  return { stateDir, dataDir };
}

describe("chat is gone", () => {
  it("has no chat or message endpoints and no conversation feature", async () => {
    const svc = await startTestService();
    running.push(svc);
    for (const [method, path] of [
      ["GET", "/conversations"],
      ["GET", "/conversations/0b6f3c1e/messages"],
      ["POST", "/chat"],
      ["GET", "/messages/m1"],
      ["POST", "/messages/m1/cancel"],
    ] as const) {
      expect((await svc.call(method, path, method === "POST" ? { text: "hello" } : undefined)).status, `${method} ${path}`).toBe(404);
    }
    const caps = await svc.get("/capabilities");
    expect(caps.features.map((f: { id: string }) => f.id)).not.toContain("conversation");
    expect((await svc.call("PUT", "/features", { changes: { conversation: true } })).status).toBe(400);
  });

  it("the Model card says what the model does now, with no answers or questions", async () => {
    const svc = await startTestService();
    running.push(svc);
    const caps = await svc.get("/capabilities");
    const model = caps.definitions.find((d: { kind: string }) => d.kind === "model");
    const card = `${model.description} ${model.setupHelp}`;
    expect(card).not.toMatch(/answer|question/i);
    for (const work of ["sessions", "Proposals", "briefings", "research", "drafts"]) expect(card).toContain(work);
  });

  it("an upgrade drops stored conversations, keeps chat archives in the Brain out of recall, and keeps every other setting", async () => {
    const { stateDir, dataDir } = chatEraState();
    const svc = await startTestService({ stateDir, dataDir, setup: false });
    running.push(svc);

    const tables = (svc.app.db.prepare("select name from sqlite_master where type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
    expect(tables).not.toContain("conversations");
    expect(tables).not.toContain("messages");

    const cfg = await svc.get("/config");
    expect(cfg.config).toMatchObject({ setupCompleted: true, dataFolder: dataDir });
    expect(cfg.config.features).toEqual({ drafts: false });
    expect(cfg.features).not.toHaveProperty("conversation");

    // The archive is still a file in the Brain and still indexed as evidence ...
    expect(readFileSync(join(dataDir, ARCHIVE), "utf8")).toContain("The Zephyr rollout starts on 3 November.");
    const evidence = await svc.get("/memory/documents?area=evidence");
    expect(evidence.map((d: { relPath: string }) => d.relPath)).toContain(ARCHIVE);
    // ... but recall answers from the note, never from the old chat.
    const recalled = await svc.get("/memory/search?recall=1&q=Zephyr%20rollout");
    const paths = recalled.hits.map((h: { relPath: string }) => h.relPath);
    expect(paths).toContain("memory/projects/zephyr.md");
    expect(paths.filter((p: string) => p.startsWith("evidence/conversations/"))).toEqual([]);

    // A new Brain no longer gets a folder for chat archives.
    const fresh = await startTestService();
    running.push(fresh);
    expect(existsSync(join(fresh.dataDir, "evidence/conversations"))).toBe(false);
    expect(existsSync(join(fresh.dataDir, "evidence/captures"))).toBe(true);

    // Changing settings afterwards still works.
    expect((await svc.call("PATCH", "/config", { schedules: { refreshEveryMinutes: 40 } })).status).toBe(200);
  });
});
