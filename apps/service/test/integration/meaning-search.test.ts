import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { startTestService, type TestService } from "./harness.ts";
import { callTool, mcpClients } from "./mcp-client.ts";
import { startFixtureServer, type FixtureServer } from "../fixtures/fixture-server.ts";
import { installFixtureMeaningModel, type FixtureModelServer } from "../fixtures/fixture-meaning-model.ts";
import type { LoadEmbedder } from "../../src/meaning/embedder.ts";
import { loadOnnxEmbedder } from "../../src/meaning/onnx-embedder.ts";

const SYNTHETIC_BRAIN = join(import.meta.dirname, "../fixtures/recall-brain");
const MAIN = join(import.meta.dirname, "../../src/main.ts");

let fx: FixtureServer;
let model: FixtureModelServer;
const running: TestService[] = [];

beforeAll(async () => {
  fx = await startFixtureServer();
  model = installFixtureMeaningModel(fx);
});
afterAll(async () => {
  await fx.close();
});
afterEach(async () => {
  model.release();
  model.replace("tokenizer.json", null);
  await Promise.all(running.splice(0).map((s) => s.stop()));
});

/** A service on a copy of the synthetic Brain, whose meaning model comes from the fixture server. */
async function start(opts: { stateDir?: string; dataDir?: string; loadEmbedder?: LoadEmbedder } = {}): Promise<TestService> {
  const dataDir = opts.dataDir ?? join(mkdtempSync(join(tmpdir(), "attache-meaning-")), "brain");
  if (!opts.dataDir) cpSync(SYNTHETIC_BRAIN, dataDir, { recursive: true });
  const meaning = { model: model.description(), ...(opts.loadEmbedder ? { loadEmbedder: opts.loadEmbedder } : {}) };
  const svc = await startTestService({ ...(opts.stateDir ? { stateDir: opts.stateDir } : {}), dataDir, meaning });
  running.push(svc);
  return svc;
}

async function meaningState(svc: TestService, state: string, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const status = await svc.get("/memory/meaning");
    if (status.state === state) return status;
    if (Date.now() > end) throw new Error(`meaning-based search stayed ${status.state} (${JSON.stringify(status)}), expected ${state}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * The real model loader, with a hand on it: it records every passage the
 * service asks to embed, and `pause` holds embedding until `resume`.
 */
function watchedLoader() {
  const passages: string[] = [];
  let gate: { promise: Promise<void>; open: () => void } | null = null;
  const load: LoadEmbedder = async (dir, m) => {
    const real = await loadOnnxEmbedder(dir, m);
    return {
      ...real,
      async embedPassages(texts) {
        passages.push(...texts);
        if (gate) await gate.promise;
        return real.embedPassages(texts);
      },
    };
  };
  return {
    load,
    passages,
    pause() {
      let open = () => {};
      const promise = new Promise<void>((resolve) => (open = resolve));
      gate = { promise, open };
    },
    resume() {
      gate?.open();
      gate = null;
    },
  };
}

async function eventually(svc: TestService, done: (status: any) => boolean, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const status = await svc.get("/memory/meaning");
    if (done(status)) return status;
    if (Date.now() > end) throw new Error(`meaning-based search did not get there: ${JSON.stringify(status)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Every file in a folder with its size and modification time, to show a folder was left alone. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else out[relative(dir, abs)] = `${statSync(abs).size}:${statSync(abs).mtimeMs}:${readFileSync(abs, "utf8").length}`;
    }
  };
  walk(dir);
  return out;
}

describe("meaning-based search while the model is missing", () => {
  it("answers on keywords and reports that the model is not downloaded", async () => {
    const svc = await start();
    const result = await svc.get("/memory/search?q=Aarhus%20office");
    expect(result.hits.map((h: { relPath: string }) => h.relPath)).toContain("memory/people/mia-jensen.md");
    expect(result.meaning).toMatchObject({ state: "missing", model: { name: "Fixture meaning model" }, vectors: { embedded: 0 } });
    expect(result.meaning.vectors.chunks).toBeGreaterThan(0);
    expect(await svc.get("/memory/meaning")).toEqual(result.meaning);
    expect(model.requests()).toBe(0);
  });
});

describe("downloading the model", () => {
  it("is started by the owner, lands in the state folder and builds a vector for every chunk, leaving the Brain alone", async () => {
    const svc = await start();
    const brainBefore = snapshot(svc.dataDir);
    model.hold();
    const started = await svc.post("/memory/meaning/download");
    expect(started.state).toBe("downloading");
    const during = await svc.get("/memory/search?q=Aarhus%20office");
    expect(during.meaning.state).toBe("downloading");
    expect(during.hits.map((h: { relPath: string }) => h.relPath)).toContain("memory/people/mia-jensen.md");
    model.release();

    const ready = await meaningState(svc, "ready");
    expect(ready.vectors.chunks).toBeGreaterThan(20);
    expect(ready.vectors.embedded).toBe(ready.vectors.chunks);
    expect(ready.download).toBeNull();
    expect(ready.error).toBeNull();
    expect(Object.keys(snapshot(join(svc.stateDir, "models")))).toEqual(expect.arrayContaining([join("fixture-meaning-model-1", "model.onnx")]));
    expect(snapshot(svc.dataDir)).toEqual(brainBefore);
  });
});

describe("keeping vectors current", () => {
  it("embeds only the changed text when a file changes, answers on keywords meanwhile, and drops vectors of deleted files", async () => {
    const watched = watchedLoader();
    const svc = await start({ loadEmbedder: watched.load });
    await svc.post("/memory/meaning/download");
    const before = await meaningState(svc, "ready");
    expect(new Set(watched.passages).size).toBe(before.vectors.chunks);

    watched.passages.length = 0;
    watched.pause();
    const note = join(svc.dataDir, "memory/people/mia-jensen.md");
    writeFileSync(note, readFileSync(note, "utf8").replace("- **Birthday**", "- **Commute** (2026-11-11): Cycles to the Aarhus office along the harbour\n- **Birthday**"));
    const building = await meaningState(svc, "building");
    expect(building.vectors).toEqual({ chunks: before.vectors.chunks + 1, embedded: before.vectors.chunks });
    const meanwhile = await svc.get("/memory/search?q=harbour");
    expect(meanwhile.meaning.state).toBe("building");
    expect(meanwhile.hits[0].text).toContain("Cycles to the Aarhus office along the harbour");
    watched.resume();

    const after = await meaningState(svc, "ready");
    expect(after.vectors).toEqual({ chunks: before.vectors.chunks + 1, embedded: before.vectors.chunks + 1 });
    expect(watched.passages).toHaveLength(1);
    expect(watched.passages[0]).toContain("Cycles to the Aarhus office along the harbour");

    rmSync(note);
    const gone = await eventually(svc, (s) => s.vectors.chunks < after.vectors.chunks);
    expect(gone.state).toBe("ready");
    expect(gone.vectors.embedded).toBe(gone.vectors.chunks);
  });
});

describe("after the download", () => {
  it("runs without a network: a restarted service builds vectors for new notes with the model server gone", async () => {
    const own = await startFixtureServer();
    const ownModel = installFixtureMeaningModel(own);
    const stateDir = mkdtempSync(join(tmpdir(), "attache-meaning-state-"));
    const dataDir = join(mkdtempSync(join(tmpdir(), "attache-meaning-")), "brain");
    cpSync(SYNTHETIC_BRAIN, dataDir, { recursive: true });
    const first = await startTestService({ stateDir, dataDir, meaning: { model: ownModel.description() } });
    await first.post("/memory/meaning/download");
    await meaningState(first, "ready");
    await first.stop();
    await own.close();

    writeFileSync(join(dataDir, "memory/notes/offsite.md"), "# Offsite\n\nThe team offsite is in Skagen in May.\n");
    const second = await startTestService({ stateDir, dataDir, meaning: { model: ownModel.description() } });
    running.push(second);
    const status = await eventually(second, (s) => s.state === "ready" && s.vectors.chunks > 0);
    expect(status.vectors.embedded).toBe(status.vectors.chunks);
    expect((await second.get("/memory/search?q=Skagen")).hits[0].relPath).toBe("memory/notes/offsite.md");
  });
});

describe("a model that stops working while ranking", () => {
  it("is reported as failed, and that search and the next ones answer on keywords", async () => {
    const broken: LoadEmbedder = async (dir, m) => {
      const real = await loadOnnxEmbedder(dir, m);
      return { ...real, embedQuery: () => Promise.reject(new Error("the model ran out of memory")) };
    };
    const svc = await start({ loadEmbedder: broken });
    await svc.post("/memory/meaning/download");
    await meaningState(svc, "ready");

    const first = await svc.get("/memory/search?q=Aarhus%20office");
    expect(first.meaning).toMatchObject({ state: "failed", ranking: "keywords", error: expect.stringContaining("ran out of memory") });
    expect(first.hits.map((h: { relPath: string }) => h.relPath)).toContain("memory/people/mia-jensen.md");
    const next = await svc.get(`/memory/search?q=${encodeURIComponent("Hvornår holder vi morgenmøde?")}`);
    expect(next.meaning.state).toBe("failed");
    expect(next.hits).toEqual([]);
  });
});

describe("a download that goes wrong", () => {
  it("reports the failure, keeps answering on keywords and can be started again", async () => {
    const svc = await start();
    model.replace("tokenizer.json", Buffer.from("{}"));
    await svc.post("/memory/meaning/download");
    const failed = await meaningState(svc, "failed");
    expect(failed.error).toMatch(/tokenizer\.json/);
    expect(failed.vectors.embedded).toBe(0);
    const search = await svc.get("/memory/search?q=Aarhus%20office");
    expect(search.meaning.state).toBe("failed");
    expect(search.hits.map((h: { relPath: string }) => h.relPath)).toContain("memory/people/mia-jensen.md");
    expect(readdirSync(join(svc.stateDir, "models"))).toEqual([]);

    model.replace("tokenizer.json", null);
    expect((await svc.post("/memory/meaning/download")).state).toBe("downloading");
    const ready = await meaningState(svc, "ready");
    expect(ready.error).toBeNull();
  });
});

describe("once every passage has a vector, search ranks by meaning", () => {
  const mcp = mcpClients();
  afterAll(() => mcp.closeAll());

  const DANISH = "Hvornår holder vi morgenmøde?";
  const STANDUP = "Daily standup at 09:15 in the Copenhagen office";

  // Three Node starts (the MCP server and two CLI runs) after the model embeds the Brain: 1.5 s alone, past 30 s while
  // other test runs share the computer, where one Node start can wait seconds (issue #9).
  it("finds the English fact for a Danish question in the API, the MCP server and the CLI, with no keywords-only note", { timeout: 90_000 }, async () => {
    const svc = await start();
    const missing = await svc.get(`/memory/search?recall=1&q=${encodeURIComponent(DANISH)}`);
    expect(missing.meaning.ranking).toBe("keywords");
    expect(missing.hits).toEqual([]);

    await svc.post("/memory/meaning/download");
    const ready = await meaningState(svc, "ready");
    expect(ready.ranking).toBe("meaning");

    const api = await svc.get(`/memory/search?recall=1&q=${encodeURIComponent(DANISH)}`);
    expect(api.meaning).toMatchObject({ state: "ready", ranking: "meaning" });
    expect(api.hits[0]).toMatchObject({ relPath: "memory/notes/team-rituals.md", section: "state" });
    expect(api.hits[0].text).toContain(STANDUP);

    const client = await mcp.connect(svc.stateDir);
    const r = await callTool<{ meaning: { state: string; note: string | null }; passages: Array<{ text: string }> }>(client, "search", { query: DANISH });
    expect(r.data.meaning).toEqual({ state: "ready", note: null });
    expect(r.data.passages[0]!.text).toContain(STANDUP);
    expect(r.text).not.toMatch(/keywords only/);

    const modelFile = join(mkdtempSync(join(tmpdir(), "attache-meaning-model-")), "model.json");
    writeFileSync(modelFile, JSON.stringify(model.description()));
    const env = { ...process.env, ATTACHE_MEANING_MODEL: modelFile };
    const text = execFileSync(process.execPath, [MAIN, "search", DANISH, "--state-dir", svc.stateDir], { encoding: "utf8", env });
    expect(text).not.toMatch(/keywords only/);
    expect(text.split("\n")[0]).toMatch(/team-rituals\.md:\d+-\d+ {2}Team rituals$/);
    expect(text.split("\n")[1]).toContain("Daily standup");
    const json = spawnSync(process.execPath, [MAIN, "search", DANISH, "--state-dir", svc.stateDir, "--json"], { encoding: "utf8", env });
    expect(json.stderr).toBe("");
    expect(JSON.parse(json.stdout)[0].file).toBe(join(svc.dataDir, "memory", "notes", "team-rituals.md"));
  });

  it("the CLI says why when the model is not downloaded", async () => {
    const svc = await start();
    const out = execFileSync(process.execPath, [MAIN, "search", "Aarhus office", "--state-dir", svc.stateDir], { encoding: "utf8" });
    expect(out.split("\n")[0]).toMatch(/^Results match keywords only: the meaning model is not downloaded/);
  });
});
