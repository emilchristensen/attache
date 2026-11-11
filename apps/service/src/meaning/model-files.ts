import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MODEL_FILE_NAMES, modelBytes, type MeaningModel, type ModelFileRole } from "./model.ts";
import { replaceWith } from "../platform/replace-file.ts";

/**
 * A downloaded model lives in `<state>/models/<model id>/`, never in the Brain.
 * The folder only appears once every file has been checked, so a folder that
 * exists is a whole model; `manifest.json` records what was checked.
 */
export const modelDir = (modelsDir: string, model: MeaningModel): string => join(modelsDir, model.id);

const MANIFEST = "manifest.json";

interface Manifest {
  id: string;
  files: Record<ModelFileRole, string>;
}

export function isInstalled(modelsDir: string, model: MeaningModel): boolean {
  const dir = modelDir(modelsDir, model);
  try {
    const manifest = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8")) as Manifest;
    return manifest.id === model.id && roles(model).every((r) => manifest.files[r] === model.files[r].sha256 && existsSync(join(dir, MODEL_FILE_NAMES[r])));
  } catch {
    return false;
  }
}

/** Remove the model, e.g. when its files no longer load. */
export function removeModel(modelsDir: string, model: MeaningModel): void {
  rmSync(modelDir(modelsDir, model), { recursive: true, force: true });
}

const roles = (model: MeaningModel) => Object.keys(model.files) as ModelFileRole[];

export interface DownloadProgress {
  received: number;
  total: number;
}

/**
 * Fetch every file of the model into a staging folder, check each against its
 * size and SHA-256, then move the folder into place. Nothing is left behind on failure.
 */
export async function downloadModel(modelsDir: string, model: MeaningModel, opts: { signal: AbortSignal; onProgress: (p: DownloadProgress) => void }): Promise<void> {
  const staging = join(modelsDir, `${model.id}.download`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  const total = modelBytes(model);
  let received = 0;
  try {
    for (const role of roles(model)) {
      const file = model.files[role];
      const name = MODEL_FILE_NAMES[role];
      await fetchChecked(file.url, join(staging, name), { name, bytes: file.bytes, sha256: file.sha256, signal: opts.signal }, (n) => {
        received += n;
        opts.onProgress({ received, total });
      });
    }
    const manifest: Manifest = { id: model.id, files: Object.fromEntries(roles(model).map((r) => [r, model.files[r].sha256])) as Record<ModelFileRole, string> };
    writeFileSync(join(staging, MANIFEST), JSON.stringify(manifest, null, 2));
    const dir = modelDir(modelsDir, model);
    rmSync(dir, { recursive: true, force: true });
    replaceWith(staging, dir);
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw e;
  }
}

async function fetchChecked(url: string, dest: string, expect: { name: string; bytes: number; sha256: string; signal: AbortSignal }, onBytes: (n: number) => void): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow", signal: expect.signal });
  } catch (e) {
    if (expect.signal.aborted) throw new Error("The download was stopped.");
    throw new Error(`Could not reach ${new URL(url).host} for ${expect.name}: ${(e as Error).message}`);
  }
  if (!res.ok || !res.body) throw new Error(`${expect.name}: the server answered HTTP ${res.status}.`);
  const hash = createHash("sha256");
  let size = 0;
  const count = new Transform({
    transform(chunk: Buffer, _enc, done) {
      size += chunk.length;
      if (size > expect.bytes) return done(new Error(`${expect.name} is larger than the expected ${expect.bytes} bytes.`));
      hash.update(chunk);
      onBytes(chunk.length);
      done(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as never), count, createWriteStream(dest, { mode: 0o600 }), { signal: expect.signal });
  } catch (e) {
    if (expect.signal.aborted) throw new Error("The download was stopped.");
    throw e;
  }
  if (size !== expect.bytes) throw new Error(`${expect.name} is ${size} bytes, expected ${expect.bytes}. The download was cut short.`);
  if (hash.digest("hex") !== expect.sha256) throw new Error(`${expect.name} does not match its published checksum.`);
}
