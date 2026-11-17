import { readFileSync } from "node:fs";
import { z } from "zod";

const ModelFile = z.object({
  url: z.url({ protocol: /^https?$/ }),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "must be a lower-case SHA-256 hex digest"),
  bytes: z.number().int().positive(),
});
export type ModelFile = z.infer<typeof ModelFile>;

/**
 * A sentence-embedding model as Attache downloads and runs it: an ONNX model
 * with a `last_hidden_state` output, and a Hugging Face tokenizer.
 */
export const MeaningModel = z.object({
  /** Names the model's folder and keys its vectors, so a different model never reuses them. */
  id: z.string().regex(/^[A-Za-z0-9][\w.-]{0,99}$/, "must be a plain file name"),
  /** What the Dashboard calls it. */
  name: z.string().min(1).max(100),
  dimensions: z.number().int().positive().max(4096),
  /** Tokens the model reads at most; longer passages are cut. */
  maxTokens: z.number().int().min(8).max(8192),
  /** Text put before a question and before a passage, for models trained with such prefixes. */
  queryPrefix: z.string().max(50),
  passagePrefix: z.string().max(50),
  files: z.object({ model: ModelFile, tokenizer: ModelFile, tokenizerConfig: ModelFile }),
});
export type MeaningModel = z.infer<typeof MeaningModel>;

export type ModelFileRole = keyof MeaningModel["files"];

/** Where each file lives inside the model's folder. */
export const MODEL_FILE_NAMES: Readonly<Record<ModelFileRole, string>> = { model: "model.onnx", tokenizer: "tokenizer.json", tokenizerConfig: "tokenizer_config.json" };

const E5_REPO = "https://huggingface.co/Xenova/multilingual-e5-small/resolve/761b726dd34fb83930e26aab4e9ac3899aa1fa78";

/**
 * multilingual-e5-small (Microsoft, MIT licence) as ONNX with 8-bit weights:
 * 384 dimensions, about 100 languages including Danish and English, 135 MB to
 * download. Files are pinned to one revision and checked by SHA-256.
 */
export const E5_SMALL: MeaningModel = {
  id: "multilingual-e5-small-q8-761b726",
  name: "multilingual-e5-small",
  dimensions: 384,
  maxTokens: 512,
  queryPrefix: "query: ",
  passagePrefix: "passage: ",
  files: {
    model: { url: `${E5_REPO}/onnx/model_quantized.onnx`, sha256: "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193", bytes: 118_308_185 },
    tokenizer: { url: `${E5_REPO}/tokenizer.json`, sha256: "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39", bytes: 17_082_730 },
    tokenizerConfig: { url: `${E5_REPO}/tokenizer_config.json`, sha256: "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b", bytes: 443 },
  },
};

export const modelBytes = (m: MeaningModel): number => m.files.model.bytes + m.files.tokenizer.bytes + m.files.tokenizerConfig.bytes;

/**
 * The model this service uses: the one described in the JSON file named by
 * `ATTACHE_MEANING_MODEL` (a mirror, or the fixture model in tests), else multilingual-e5-small.
 */
export function configuredMeaningModel(env: NodeJS.ProcessEnv = process.env): MeaningModel {
  const file = env.ATTACHE_MEANING_MODEL;
  if (!file) return E5_SMALL;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`ATTACHE_MEANING_MODEL: cannot read ${file}: ${(e as Error).message}`);
  }
  const parsed = MeaningModel.safeParse(raw);
  if (!parsed.success) throw new Error(`ATTACHE_MEANING_MODEL: ${file} is not a model description: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
