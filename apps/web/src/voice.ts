import { useSyncExternalStore } from "react";
import { api, API_PREFIX, ApiError } from "./api.ts";

export type VoiceState = "idle" | "listening" | "thinking" | "speaking" | "error";

export interface VoiceSnapshot {
  modes: { stt: string; tts: string };
  state: VoiceState;
  message: string | null;
  micDenied: boolean;
  level: number;
}

const TARGET_RATE = 16_000;

/** Encode mono float samples as 16-bit PCM WAV. */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function downsample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j]!;
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

class VoiceController {
  private snap: VoiceSnapshot = { modes: { stt: "none", tts: "none" }, state: "idle", message: null, micDenied: false, level: 0 };
  private listeners = new Set<() => void>();
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private node: ScriptProcessorNode | null = null;
  private chunks: Float32Array[] = [];
  private audio: HTMLAudioElement | null = null;
  private speakAbort: AbortController | null = null;
  private recognition: { stop(): void; abort(): void } | null = null;
  get modes() {
    return this.snap.modes;
  }
  set modes(m: { stt: string; tts: string }) {
    this.set({ modes: m });
  }

  get snapshot() {
    return this.snap;
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  private set(p: Partial<VoiceSnapshot>) {
    this.snap = { ...this.snap, ...p };
    this.listeners.forEach((l) => l());
  }

  setThinking(on: boolean) {
    if (on && this.snap.state !== "listening") this.set({ state: "thinking", message: null });
    else if (!on && this.snap.state === "thinking") this.set({ state: "idle" });
  }

  get canListen() {
    return this.modes.stt !== "none";
  }
  get canSpeak() {
    return this.modes.tts !== "none";
  }

  /** Push-to-talk start. Interrupts any speech in progress. */
  async start(): Promise<void> {
    this.interrupt();
    if (this.modes.stt === "browser") return this.startBrowserRecognition();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      const denied = (e as DOMException).name === "NotAllowedError" || (e as DOMException).name === "SecurityError";
      this.set({ state: "error", micDenied: denied, message: denied ? "Microphone access is blocked. Allow it in your browser's site settings, then try again. Typing always works." : `No microphone available: ${(e as Error).message}` });
      throw e;
    }
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = this.ctx.createScriptProcessor(4096, 1, 1);
    this.chunks = [];
    this.node.onaudioprocess = (ev) => {
      const data = ev.inputBuffer.getChannelData(0);
      this.chunks.push(new Float32Array(data));
      let peak = 0;
      for (let i = 0; i < data.length; i += 64) peak = Math.max(peak, Math.abs(data[i]!));
      this.set({ level: peak });
    };
    src.connect(this.node);
    this.node.connect(this.ctx.destination);
    this.set({ state: "listening", message: null, micDenied: false });
  }

  /** Push-to-talk release: returns the transcript (empty if nothing was heard). */
  async stop(): Promise<string> {
    if (this.recognition) {
      this.recognition.stop();
      return "";
    }
    if (this.snap.state !== "listening" || !this.ctx) return "";
    const rate = this.ctx.sampleRate;
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx.close();
    this.ctx = null;
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const all = new Float32Array(total);
    let o = 0;
    for (const c of this.chunks) {
      all.set(c, o);
      o += c.length;
    }
    if (total < rate * 0.3) {
      this.set({ state: "idle", message: "Hold the button (or Space) while you speak.", level: 0 });
      return "";
    }
    this.set({ state: "thinking", level: 0 });
    try {
      const wav = encodeWav(downsample(all, rate, TARGET_RATE), TARGET_RATE);
      const r = await api<{ text: string }>("/voice/transcribe", { method: "POST", raw: wav, headers: { "content-type": "audio/wav" } });
      if (!r.text.trim()) this.set({ state: "idle", message: "I didn't catch that. Try again or type." });
      return r.text.trim();
    } catch (e) {
      this.set({ state: "error", message: `Speech recognition failed: ${(e as ApiError).message}. Typing still works.` });
      return "";
    }
  }

  private startBrowserRecognition(): Promise<void> {
    const Ctor = (window as unknown as { SpeechRecognition?: new () => unknown; webkitSpeechRecognition?: new () => unknown }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: new () => unknown }).webkitSpeechRecognition;
    if (!Ctor) {
      this.set({ state: "error", message: "This browser has no speech recognition. Configure local recognition in Connections, or type." });
      return Promise.reject(new Error("unsupported"));
    }
    return new Promise((resolve) => {
      const rec = new Ctor() as { lang: string; interimResults: boolean; onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void; onerror: (e: { error: string }) => void; onend: () => void; start(): void; stop(): void; abort(): void };
      rec.lang = "en-US";
      rec.interimResults = false;
      rec.onresult = (e) => this.onBrowserTranscript?.(e.results[0]?.[0]?.transcript ?? "");
      rec.onerror = (e) => this.set({ state: "error", micDenied: e.error === "not-allowed", message: e.error === "not-allowed" ? "Microphone access is blocked. Allow it in site settings, or type." : `Speech recognition error: ${e.error}` });
      rec.onend = () => {
        this.recognition = null;
        if (this.snap.state === "listening") this.set({ state: "idle" });
      };
      this.recognition = rec;
      rec.start();
      this.set({ state: "listening", message: null });
      resolve();
    });
  }

  onBrowserTranscript: ((text: string) => void) | null = null;

  /** Speak an answer. Resolves when playback ends or is interrupted. */
  async speak(text: string): Promise<void> {
    this.interrupt();
    if (!this.canSpeak || !text.trim()) return;
    if (this.modes.tts === "browser") {
      const u = new SpeechSynthesisUtterance(text.replace(/\[S\d+\]/g, ""));
      this.set({ state: "speaking" });
      await new Promise<void>((resolve) => {
        u.onend = () => resolve();
        u.onerror = () => resolve();
        speechSynthesis.speak(u);
      });
      if (this.snap.state === "speaking") this.set({ state: "idle" });
      return;
    }
    this.speakAbort = new AbortController();
    this.set({ state: "thinking" });
    let blob: Blob;
    try {
      const res = await fetch(`${API_PREFIX}/voice/speak`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-jarvis-client": "1" }, body: JSON.stringify({ text: text.slice(0, 8000) }), signal: this.speakAbort.signal });
      if (!res.ok) throw new Error((await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }))).error?.message ?? `HTTP ${res.status}`);
      blob = await res.blob();
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      this.set({ state: "error", message: `Speech output unavailable: ${(e as Error).message}. The text answer is above.` });
      return;
    }
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    this.audio = audio;
    this.set({ state: "speaking", message: null });
    await new Promise<void>((resolve) => {
      audio.onended = () => resolve();
      audio.onpause = () => resolve();
      audio.onerror = () => resolve();
      audio.play().catch(() => {
        this.set({ state: "error", message: "The browser blocked audio playback. Click the page, then try again." });
        resolve();
      });
    });
    URL.revokeObjectURL(url);
    if (this.audio === audio) {
      this.audio = null;
      if (this.snap.state === "speaking") this.set({ state: "idle" });
    }
  }

  /** Stop speaking immediately. Text answers are unaffected. */
  interrupt(): boolean {
    let stopped = false;
    this.speakAbort?.abort();
    this.speakAbort = null;
    if (this.audio) {
      this.audio.pause();
      this.audio = null;
      stopped = true;
    }
    if (typeof speechSynthesis !== "undefined" && speechSynthesis.speaking) {
      speechSynthesis.cancel();
      stopped = true;
    }
    if (this.snap.state === "speaking" || (stopped && this.snap.state !== "listening")) this.set({ state: "idle", message: stopped ? "Stopped speaking." : null });
    return stopped;
  }

  clearError() {
    if (this.snap.state === "error") this.set({ state: "idle", message: null });
  }
}

export const voice = new VoiceController();

export function useVoice(): VoiceSnapshot {
  return useSyncExternalStore(voice.subscribe, () => voice.snapshot);
}
