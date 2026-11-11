/**
 * TEST-ONLY meaning model: a tiny ONNX model and tokenizer with the same files
 * and the same interface as the real one, served by the fixture server. Tests
 * and browser journeys download it instead of the real model, so they never
 * reach Hugging Face and still run the real ONNX runtime and tokenizer.
 *
 * Each dimension is one concept; a word's vector is its concept, in English or
 * Danish, and any other word is the unknown token with a zero vector. So
 * "arbejder" and "works" point the same way, which is enough for tests to tell
 * a meaning match from a keyword match.
 */
import { createHash } from "node:crypto";
import type { FixtureServer } from "./fixture-server.ts";
import { gatherEmbeddingModel } from "./onnx-writer.ts";

const CONCEPTS: readonly string[][] = [
  ["work", "works", "worked", "job", "employer", "arbejder", "arbejde", "arbejdsgiver"],
  ["school", "schools", "skole", "class", "klasse"],
  ["start", "starts", "begin", "begins", "begynder", "starter"],
  ["deploy", "deploys", "deployment", "release", "ship", "udrulning"],
  ["pipeline", "ci", "build", "actions"],
  ["daughter", "datter", "child", "barn"],
  ["meeting", "meetings", "møde", "call"],
  ["coffee", "kaffe", "tea", "te"],
];

const UNKNOWN = "[UNK]";

export const FIXTURE_MODEL_FILES = ["model.onnx", "tokenizer.json", "tokenizer_config.json"] as const;
export type FixtureModelFile = (typeof FIXTURE_MODEL_FILES)[number];

function buildFiles(): Record<FixtureModelFile, Buffer> {
  const vocab: Record<string, number> = { [UNKNOWN]: 0 };
  const table: number[][] = [CONCEPTS.map(() => 0)];
  CONCEPTS.forEach((words, concept) => {
    for (const word of words) {
      vocab[word] = table.length;
      table.push(CONCEPTS.map((_, d) => (d === concept ? 1 : 0)));
    }
  });
  const tokenizer = {
    version: "1.0",
    truncation: null,
    padding: null,
    added_tokens: [{ id: 0, content: UNKNOWN, single_word: false, lstrip: false, rstrip: false, normalized: false, special: true }],
    normalizer: { type: "Lowercase" },
    pre_tokenizer: { type: "Whitespace" },
    post_processor: null,
    decoder: null,
    model: { type: "WordPiece", unk_token: UNKNOWN, continuing_subword_prefix: "##", max_input_chars_per_word: 100, vocab },
  };
  return {
    "model.onnx": Buffer.from(gatherEmbeddingModel(table)),
    "tokenizer.json": Buffer.from(JSON.stringify(tokenizer)),
    "tokenizer_config.json": Buffer.from(JSON.stringify({ model_max_length: 64, unk_token: UNKNOWN })),
  };
}

export const fixtureModelFiles: Readonly<Record<FixtureModelFile, Buffer>> = buildFiles();

/** The model description Jarvis reads from `JARVIS_MEANING_MODEL`, pointing at files under `baseUrl`. */
export function fixtureModelDescription(baseUrl: string) {
  const file = (name: FixtureModelFile) => ({ url: `${baseUrl}/${name}`, sha256: createHash("sha256").update(fixtureModelFiles[name]).digest("hex"), bytes: fixtureModelFiles[name].length });
  return {
    id: "fixture-meaning-model-1",
    name: "Fixture meaning model",
    dimensions: CONCEPTS.length,
    maxTokens: 64,
    queryPrefix: "",
    passagePrefix: "",
    files: { model: file("model.onnx"), tokenizer: file("tokenizer.json"), tokenizerConfig: file("tokenizer_config.json") },
  };
}

export interface FixtureModelServer {
  /** The model description for files served at this prefix. */
  description(): ReturnType<typeof fixtureModelDescription>;
  /** Hold every file request until `release` is called, so a download stays in progress. */
  hold(): void;
  release(): void;
  /** Serve these bytes for a file instead of the real ones, or stop doing so with `null`. */
  replace(name: FixtureModelFile, bytes: Buffer | null): void;
  /** File requests served so far. */
  requests(): number;
}

export function installFixtureMeaningModel(fx: FixtureServer, prefix = "/meaning-model"): FixtureModelServer {
  let gate: { promise: Promise<void>; open: () => void } | null = null;
  const replaced = new Map<FixtureModelFile, Buffer>();
  let served = 0;
  for (const name of FIXTURE_MODEL_FILES) {
    fx.route("GET", `${prefix}/${name}`, async () => {
      served++;
      if (gate) await gate.promise;
      return { body: replaced.get(name) ?? fixtureModelFiles[name] };
    });
  }
  return {
    description: () => fixtureModelDescription(`${fx.url}${prefix}`),
    hold() {
      if (gate) return;
      let open = () => {};
      const promise = new Promise<void>((resolve) => (open = resolve));
      gate = { promise, open };
    },
    release() {
      gate?.open();
      gate = null;
    },
    replace(name, bytes) {
      if (bytes) replaced.set(name, bytes);
      else replaced.delete(name);
    },
    requests: () => served,
  };
}
