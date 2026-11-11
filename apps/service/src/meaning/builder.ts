import { setImmediate as nextTurn } from "node:timers/promises";
import type { Db } from "../core/db.ts";
import type { Embedder } from "./embedder.ts";
import { pendingTexts, pruneVectors, storeVectors } from "./vectors.ts";

/** Small batches keep each pause of the service's event loop short. */
const BATCH = 8;

export interface BuilderDeps {
  db: Db;
  modelId: string;
  embedder: () => Promise<Embedder>;
  /** After each stored batch. */
  onProgress: () => void;
  /** When a run stops on an error; the builder does nothing more until `kick` is called again. */
  onError: (e: Error) => void;
}

/**
 * Builds vectors for every chunk that lacks one, in the background, one run at
 * a time. A kick during a run makes the run look again before it ends, so a
 * file changed mid-run is not missed.
 */
export class VectorBuilder {
  private readonly deps: BuilderDeps;
  private run: Promise<void> | null = null;
  private again = false;
  private stopped = false;

  constructor(deps: BuilderDeps) {
    this.deps = deps;
  }

  kick(): void {
    if (this.stopped) return;
    if (this.run) {
      this.again = true;
      return;
    }
    this.run = this.loop().finally(() => {
      this.run = null;
    });
  }

  /** Stop after the batch in hand; resolves once nothing more touches the database. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.run;
  }

  private async loop(): Promise<void> {
    try {
      do {
        this.again = false;
        await this.drain();
      } while (this.again && !this.stopped);
      if (!this.stopped) pruneVectors(this.deps.db, this.deps.modelId);
    } catch (e) {
      if (!this.stopped) this.deps.onError(e as Error);
    }
  }

  private async drain(): Promise<void> {
    for (;;) {
      if (this.stopped) return;
      const batch = pendingTexts(this.deps.db, this.deps.modelId, BATCH);
      if (!batch.length) return;
      const embedder = await this.deps.embedder();
      const vectors = await embedder.embedPassages(batch.map((b) => b.text));
      if (this.stopped) return;
      if (vectors.length !== batch.length) throw new Error(`The model returned ${vectors.length} vectors for ${batch.length} passages.`);
      storeVectors(this.deps.db, this.deps.modelId, batch.map((b, i) => ({ hash: b.hash, vector: vectors[i]! })));
      this.deps.onProgress();
      await nextTurn();
    }
  }
}
