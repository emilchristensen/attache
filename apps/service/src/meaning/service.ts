import type { MeaningState, MeaningStatus } from "@jarvis/contracts";
import type { Db } from "../core/db.ts";
import type { Logger } from "../core/log.ts";
import { VectorBuilder } from "./builder.ts";
import type { Embedder, LoadEmbedder } from "./embedder.ts";
import { downloadModel, isInstalled, modelDir, removeModel, type DownloadProgress } from "./model-files.ts";
import { modelBytes, type MeaningModel } from "./model.ts";
import { meaningStateOf, rankingOf } from "./status.ts";
import { vectorCoverage } from "./vectors.ts";

export interface MeaningOptions {
  model: MeaningModel;
  loadEmbedder: LoadEmbedder;
}

export interface MeaningDeps {
  db: Db;
  modelsDir: string;
  log: Logger;
  /** Tell Dashboards the status changed. */
  emit: () => void;
}

/** Progress events at most this often; state changes go out at once. */
const PROGRESS_EVERY_MS = 500;

/**
 * This Machine's meaning-based search: the model's download, loading it, and
 * the vectors built from the index. Search keeps answering on keywords
 * whatever state this is in; `status()` says what meaning-based search can do now.
 */
export class MeaningSearch {
  private readonly deps: MeaningDeps;
  private readonly model: MeaningModel;
  private readonly loadEmbedder: LoadEmbedder;
  private readonly builder: VectorBuilder;
  private loaded: Promise<Embedder> | null = null;
  private download: { progress: DownloadProgress; abort: AbortController; done: Promise<void> } | null = null;
  private error: string | null = null;
  /** Whether a whole, checked model is on disk; read once, then kept up to date by the download. */
  private installed: boolean;
  private lastEmit = 0;
  private emitTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(deps: MeaningDeps, opts: MeaningOptions) {
    this.deps = deps;
    this.model = opts.model;
    this.loadEmbedder = opts.loadEmbedder;
    this.installed = isInstalled(deps.modelsDir, this.model);
    this.builder = new VectorBuilder({
      db: deps.db,
      modelId: this.model.id,
      embedder: () => this.embedder(),
      onProgress: () => this.notify(this.state() === "ready"),
      onError: (e) => this.fail("could not build search vectors", e),
    });
  }

  get modelId(): string {
    return this.model.id;
  }

  status(): MeaningStatus {
    const state = this.state();
    return {
      state,
      ranking: rankingOf(state),
      model: { name: this.model.name, bytes: modelBytes(this.model) },
      download: this.download ? { ...this.download.progress } : null,
      vectors: vectorCoverage(this.deps.db, this.model.id),
      error: this.error,
    };
  }

  private state(): MeaningState {
    return meaningStateOf({ downloading: this.download !== null, failed: this.error !== null, installed: this.installed, vectors: vectorCoverage(this.deps.db, this.model.id) });
  }

  /** Build vectors for whatever the index holds now, if the model is here. */
  start(): void {
    this.indexChanged();
  }

  /** The index gained or lost chunks: bring the vectors up to date. */
  indexChanged(): void {
    if (this.stopped || this.download || this.error || !this.installed) return;
    this.builder.kick();
    this.notify();
  }

  /**
   * Start downloading the model, when it is missing or the last attempt
   * failed. Returns at once; progress shows in `status()`.
   */
  startDownload(): MeaningStatus {
    const state = this.state();
    if (this.stopped || (state !== "missing" && state !== "failed")) return this.status();
    removeModel(this.deps.modelsDir, this.model);
    this.installed = false;
    this.error = null;
    const abort = new AbortController();
    const progress: DownloadProgress = { received: 0, total: modelBytes(this.model) };
    const done = downloadModel(this.deps.modelsDir, this.model, {
      signal: abort.signal,
      onProgress: (p) => {
        progress.received = p.received;
        progress.total = p.total;
        this.notify();
      },
    }).then(
      () => {
        this.download = null;
        this.installed = true;
        this.deps.log.info("meaning model downloaded", { model: this.model.id, dir: modelDir(this.deps.modelsDir, this.model) });
        this.notify(true);
        this.indexChanged();
      },
      (e: Error) => {
        this.download = null;
        if (!this.stopped) this.fail("could not download the meaning model", e);
      },
    );
    this.download = { progress, abort, done };
    this.notify(true);
    return this.status();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.download?.abort.abort();
    await this.download?.done;
    await this.builder.stop();
    const loaded = this.loaded;
    this.loaded = null;
    if (loaded) await loaded.then((e) => e.close()).catch(() => {});
  }

  private embedder(): Promise<Embedder> {
    this.loaded ??= this.loadEmbedder(modelDir(this.deps.modelsDir, this.model), this.model).catch((e: Error) => {
      this.loaded = null;
      throw new Error(`Could not load ${this.model.name}: ${e.message}`);
    });
    return this.loaded;
  }

  private fail(what: string, e: Error): void {
    this.error = e.message;
    this.deps.log.error(what, { model: this.model.id, error: e.message });
    this.notify(true);
  }

  private notify(now = false): void {
    if (this.stopped) return;
    const wait = PROGRESS_EVERY_MS - (Date.now() - this.lastEmit);
    if (now || wait <= 0) {
      if (this.emitTimer) clearTimeout(this.emitTimer);
      this.emitTimer = null;
      this.lastEmit = Date.now();
      this.deps.emit();
      return;
    }
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.notify(true);
    }, wait);
    this.emitTimer.unref();
  }
}
