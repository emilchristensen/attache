import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestService, type TestService } from "./harness.ts";
import { startFixtureServer, type FixtureServer } from "../fixtures/fixture-server.ts";
import { E5_SMALL, MODEL_FILE_NAMES, type MeaningModel, type ModelFileRole } from "../../src/meaning/model.ts";
import { loadOnnxEmbedder } from "../../src/meaning/onnx-embedder.ts";
import { modelDir } from "../../src/meaning/model-files.ts";

/**
 * The real multilingual-e5-small, run on this platform. Opt-in, because tests
 * never download it: set JARVIS_TEST_REAL_MODEL_DIR to a folder holding
 * `onnx/model_quantized.onnx`, `tokenizer.json` and `tokenizer_config.json`
 * from the model's pinned revision. The files are served locally and checked
 * against the published checksums, like a real download.
 */
const SOURCE = process.env.JARVIS_TEST_REAL_MODEL_DIR;
const SOURCE_FILES: Record<ModelFileRole, string> = { model: "onnx/model_quantized.onnx", tokenizer: "tokenizer.json", tokenizerConfig: "tokenizer_config.json" };

describe.skipIf(!SOURCE)("the real meaning model", () => {
  let fx: FixtureServer;
  let svc: TestService;
  let model: MeaningModel;

  beforeAll(async () => {
    fx = await startFixtureServer();
    const files = Object.fromEntries(
      (Object.keys(SOURCE_FILES) as ModelFileRole[]).map((role) => {
        const path = `/e5/${MODEL_FILE_NAMES[role]}`;
        fx.route("GET", path, () => ({ body: readFileSync(join(SOURCE!, SOURCE_FILES[role])) }));
        return [role, { ...E5_SMALL.files[role], url: `${fx.url}${path}` }];
      }),
    ) as MeaningModel["files"];
    model = { ...E5_SMALL, files };
    const dataDir = join(mkdtempSync(join(tmpdir(), "jarvis-real-model-")), "brain");
    cpSync(join(import.meta.dirname, "../fixtures/recall-brain"), dataDir, { recursive: true });
    svc = await startTestService({ dataDir, meaning: { model } });
  }, 120_000);
  afterAll(async () => {
    await svc?.stop();
    await fx?.close();
  });

  it("downloads with checked files and builds a vector for every chunk", async () => {
    await svc.post("/memory/meaning/download");
    const end = Date.now() + 240_000;
    let status = await svc.get("/memory/meaning");
    while (status.state !== "ready" && status.state !== "failed" && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 200));
      status = await svc.get("/memory/meaning");
    }
    expect(status.error).toBeNull();
    expect(status.state).toBe("ready");
    expect(status.vectors.embedded).toBe(status.vectors.chunks);
  }, 300_000);

  it("puts a Danish question nearest the English passage that answers it", async () => {
    const embedder = await loadOnnxEmbedder(modelDir(svc.app.paths.modelsDir, model), model);
    try {
      const passages = await embedder.embedPassages(["Mia Jensen works from the Aarhus office on Tuesdays and Thursdays.", "The deploy pipeline for the website runs on GitHub Actions.", "Ada Okafor is primary on-call for the billing service."]);
      const query = await embedder.embedQuery("Hvilke dage arbejder Mia fra kontoret i Aarhus?");
      const scores = passages.map((p) => p.reduce((sum, x, i) => sum + x * query[i]!, 0));
      expect(scores.indexOf(Math.max(...scores))).toBe(0);
      expect(query).toHaveLength(384);
    } finally {
      await embedder.close();
    }
  }, 60_000);
});
