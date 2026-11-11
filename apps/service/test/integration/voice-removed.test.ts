import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/core/db.ts";
import { startTestService, type TestService } from "./harness.ts";

const running: TestService[] = [];
afterAll(async () => {
  for (const s of running) await s.stop().catch(() => {});
});

/** A state folder as an install with voice set up left it: feature on, speech provider connected, model downloaded. */
function voiceEraState(): { stateDir: string; dataDir: string } {
  const stateDir = mkdtempSync(join(tmpdir(), "jarvis-it-voice-state-"));
  const dataDir = join(mkdtempSync(join(tmpdir(), "jarvis-it-voice-data-")), "data");
  mkdirSync(dataDir, { recursive: true });
  const now = new Date().toISOString();
  const db = openDb(join(stateDir, "jarvis.sqlite"));
  const config = { schemaVersion: 1, setupCompleted: true, setupStep: 4, dataFolder: dataDir, features: { voice: true, drafts: false } };
  db.prepare("insert into config (id, json, revision, updated_at) values (1, ?, 1, ?)").run(JSON.stringify(config), now);
  db.prepare("insert into connections (id, kind, label, status, settings, created_at, updated_at) values ('speech', 'speech', 'Speech', 'connected', ?, ?, ?)").run(JSON.stringify({ stt: "openai-compatible", tts: "macos-say" }), now, now);
  db.close();
  writeFileSync(join(stateDir, "secrets.json"), JSON.stringify({ "conn:speech:apiKey": "sk-old-speech-key" }), { mode: 0o600 });
  mkdirSync(join(stateDir, "models"), { recursive: true });
  writeFileSync(join(stateDir, "models", "ggml-base.en.bin"), "whisper model bytes");
  writeFileSync(join(stateDir, "models", "ggml-base.en.bin.part"), "half a download");
  writeFileSync(join(stateDir, "models", "keep-me.bin"), "another model");
  return { stateDir, dataDir };
}

describe("voice is gone", () => {
  it("has no voice endpoints, no voice feature and no speech connection", async () => {
    const svc = await startTestService();
    running.push(svc);
    for (const [method, path] of [
      ["GET", "/voice/status"],
      ["POST", "/voice/model/download"],
      ["POST", "/voice/transcribe"],
      ["POST", "/voice/speak"],
    ] as const) {
      expect((await svc.call(method, path, method === "POST" ? {} : undefined)).status, `${method} ${path}`).toBe(404);
    }
    const caps = await svc.get("/capabilities");
    expect(caps.features.map((f: { id: string }) => f.id)).not.toContain("voice");
    expect(caps.connections.map((c: { kind: string }) => c.kind)).not.toContain("speech");
    expect(caps.definitions.map((d: { kind: string }) => d.kind)).not.toContain("speech");
    expect((await svc.call("PUT", "/features", { changes: { voice: true } })).status).toBe(400);
    expect((await svc.call("POST", "/connections/speech/configure", { fields: {} })).status).toBeGreaterThanOrEqual(400);
  });

  it("an upgrade removes the downloaded speech model, the speech connection and its credential, and keeps every other setting", async () => {
    const { stateDir, dataDir } = voiceEraState();
    const svc = await startTestService({ stateDir, dataDir, setup: false });
    running.push(svc);

    expect(existsSync(join(stateDir, "models", "ggml-base.en.bin"))).toBe(false);
    expect(existsSync(join(stateDir, "models", "ggml-base.en.bin.part"))).toBe(false);
    expect(existsSync(join(stateDir, "models", "keep-me.bin"))).toBe(true);

    const cfg = await svc.get("/config");
    expect(cfg.config).toMatchObject({ setupCompleted: true, dataFolder: dataDir });
    expect(cfg.config.features).toEqual({ drafts: false });
    expect(cfg.features).not.toHaveProperty("voice");
    expect((await svc.get("/connections")).map((c: { kind: string }) => c.kind)).not.toContain("speech");
    const secretsFile = join(stateDir, "secrets.json");
    await expect.poll(() => (existsSync(secretsFile) ? readFileSync(secretsFile, "utf8") : "")).not.toContain("conn:speech:apiKey");
    // Changing settings afterwards still works.
    expect((await svc.call("PATCH", "/config", { schedules: { syncEveryMinutes: 40 } })).status).toBe(200);
  });
});
