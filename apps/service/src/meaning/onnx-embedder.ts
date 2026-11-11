import { existsSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as ort from "onnxruntime-web";
import { Tokenizer } from "@huggingface/tokenizers";
import type { Embedder } from "./embedder.ts";
import { MODEL_FILE_NAMES, type MeaningModel } from "./model.ts";

/**
 * The model runs on ONNX Runtime's WebAssembly build: one portable binary for
 * macOS, Linux and Windows, with no native module to build or ship per platform.
 */
const WASM_FILE = "ort-wasm-simd-threaded.wasm";

/** The folder holding ONNX Runtime's WebAssembly files: next to the bundle in a release, in the package when run from source. */
export function ortWasmDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  if (existsSync(join(here, WASM_FILE))) return here;
  try {
    const pkg = dirname(createRequire(import.meta.url).resolve("onnxruntime-web"));
    if (existsSync(join(pkg, WASM_FILE))) return pkg;
  } catch {
    // not installed as a package: only the release layout applies
  }
  throw new Error(`ONNX Runtime's ${WASM_FILE} is missing from ${here}. Reinstall Jarvis.`);
}

let runtimeReady = false;

function prepareRuntime(): void {
  if (runtimeReady) return;
  ort.env.wasm.wasmPaths = `${pathToFileURL(ortWasmDir()).href}/`;
  // Leave cores for the owner's own work: building vectors runs in the background.
  ort.env.wasm.numThreads = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
  ort.env.logLevel = "error";
  runtimeReady = true;
}

const readJson = (file: string): object => JSON.parse(readFileSync(file, "utf8")) as object;

/** Load a downloaded model and its tokenizer from the model's folder. */
export async function loadOnnxEmbedder(dir: string, model: MeaningModel): Promise<Embedder> {
  prepareRuntime();
  const tokenizer = new Tokenizer(readJson(join(dir, MODEL_FILE_NAMES.tokenizer)), readJson(join(dir, MODEL_FILE_NAMES.tokenizerConfig)));
  const session = await ort.InferenceSession.create(readFileSync(join(dir, MODEL_FILE_NAMES.model)));
  if (!session.inputNames.includes("input_ids") || !session.inputNames.includes("attention_mask")) {
    await session.release();
    throw new Error(`${model.name} does not take input_ids and attention_mask`);
  }
  const encode = (text: string): number[] => {
    const ids = tokenizer.encode(text).ids;
    // Keep the closing special token, if any, when cutting a long passage.
    return ids.length <= model.maxTokens ? ids : [...ids.slice(0, model.maxTokens - 1), ids[ids.length - 1]!];
  };
  const embed = async (texts: readonly string[]): Promise<Float32Array[]> => {
    if (!texts.length) return [];
    const encoded = texts.map(encode);
    const width = Math.max(1, ...encoded.map((ids) => ids.length));
    const ids = new BigInt64Array(texts.length * width);
    const mask = new BigInt64Array(texts.length * width);
    encoded.forEach((row, i) =>
      row.forEach((id, j) => {
        ids[i * width + j] = BigInt(id);
        mask[i * width + j] = 1n;
      }),
    );
    const shape = [texts.length, width];
    const feeds: Record<string, ort.Tensor> = { input_ids: new ort.Tensor("int64", ids, shape), attention_mask: new ort.Tensor("int64", mask, shape) };
    if (session.inputNames.includes("token_type_ids")) feeds.token_type_ids = new ort.Tensor("int64", new BigInt64Array(texts.length * width), shape);
    const output = (await session.run(feeds))[session.outputNames[0]!];
    if (!output || output.dims.length !== 3 || output.dims[2] !== model.dimensions) throw new Error(`${model.name} returned vectors of shape [${output?.dims.join(", ")}], expected ${model.dimensions} dimensions`);
    return encoded.map((row, i) => meanPool(output.data as Float32Array, i, row.length, width, model.dimensions));
  };
  return {
    dimensions: model.dimensions,
    embedPassages: (texts) => embed(texts.map((t) => model.passagePrefix + t)),
    embedQuery: async (text) => (await embed([model.queryPrefix + text]))[0]!,
    close: () => session.release(),
  };
}

/** The average of one row's token vectors, scaled to unit length (a zero vector stays zero). */
function meanPool(data: Float32Array, row: number, tokens: number, width: number, dims: number): Float32Array {
  const v = new Float32Array(dims);
  for (let t = 0; t < tokens; t++) {
    const base = (row * width + t) * dims;
    for (let d = 0; d < dims; d++) v[d]! += data[base + d]!;
  }
  let norm = 0;
  for (let d = 0; d < dims; d++) norm += v[d]! * v[d]!;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let d = 0; d < dims; d++) v[d]! /= norm;
  return v;
}
