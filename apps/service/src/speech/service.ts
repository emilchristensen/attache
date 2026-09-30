import { createWriteStream, existsSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { App } from "../app.ts";
import { synthesize, transcribe, WHISPER_MODEL, findWhisperBin, sayAvailable, listSayVoices, type SpeechSettings, SpeechError } from "./engine.ts";

export class SpeechService {
  private readonly app: App;
  private download: { state: "idle" | "downloading" | "done" | "failed"; received: number; total: number; error: string | null } = { state: "idle", received: 0, total: WHISPER_MODEL.bytes, error: null };

  constructor(app: App) {
    this.app = app;
  }

  get modelPath(): string {
    return join(this.app.paths.modelsDir, WHISPER_MODEL.name);
  }

  environment() {
    const present = existsSync(this.modelPath) && statSync(this.modelPath).size > 100_000_000;
    return {
      whisperBin: findWhisperBin(),
      whisperModel: present ? this.modelPath : null,
      download: present && this.download.state !== "downloading" ? { ...this.download, state: "done" as const } : this.download,
      say: sayAvailable(),
    };
  }

  voices() {
    return listSayVoices();
  }

  /** Download the whisper.cpp model into the service state directory (never the vault). */
  async downloadModel(): Promise<void> {
    if (this.download.state === "downloading") return;
    if (existsSync(this.modelPath) && statSync(this.modelPath).size > 100_000_000) {
      this.download = { state: "done", received: WHISPER_MODEL.bytes, total: WHISPER_MODEL.bytes, error: null };
      return;
    }
    this.download = { state: "downloading", received: 0, total: WHISPER_MODEL.bytes, error: null };
    const tmp = `${this.modelPath}.part`;
    try {
      const res = await fetch(WHISPER_MODEL.url, { redirect: "follow" });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get("content-length") ?? WHISPER_MODEL.bytes);
      this.download.total = total;
      const body = Readable.fromWeb(res.body as never);
      body.on("data", (c: Buffer) => {
        this.download.received += c.length;
      });
      await pipeline(body, createWriteStream(tmp));
      if (statSync(tmp).size < 100_000_000) throw new Error("Downloaded file is incomplete");
      renameSync(tmp, this.modelPath);
      this.download.state = "done";
    } catch (e) {
      this.download = { ...this.download, state: "failed", error: (e as Error).message };
      if (existsSync(tmp)) unlinkSync(tmp);
    }
    this.app.bus.emit("event", { type: "speech.download", download: this.download });
  }

  private async settings(): Promise<{ s: SpeechSettings; key: string | null }> {
    if (!this.app.featureEnabled("voice")) throw new SpeechError("not_configured", "Voice is turned off");
    const rec = this.app.connections.connected("speech")[0] ?? this.app.connections.record("speech");
    if (!rec || rec.status === "disconnected") throw new SpeechError("not_configured", "No speech provider is set up");
    const s = { ...(rec.settings as unknown as SpeechSettings) };
    if (s.stt === "whisper-local" && !s.whisperModelPath) s.whisperModelPath = this.modelPath;
    const key = await this.app.connections.context(rec).secret("apiKey");
    return { s, key };
  }

  async transcribe(wav: Buffer, signal?: AbortSignal): Promise<string> {
    const { s, key } = await this.settings();
    return transcribe(s, wav, key, signal);
  }

  async synthesize(text: string, signal?: AbortSignal) {
    const { s, key } = await this.settings();
    return synthesize(s, text, key, signal);
  }

  async clientModes(): Promise<{ stt: string; tts: string }> {
    try {
      const { s } = await this.settings();
      return { stt: s.stt, tts: s.tts };
    } catch {
      return { stt: "none", tts: "none" };
    }
  }
}
