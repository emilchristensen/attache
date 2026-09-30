import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";

export interface SpeechSettings {
  stt: "none" | "whisper-local" | "openai-compatible" | "browser";
  tts: "none" | "macos-say" | "openai-compatible" | "browser";
  voice?: string;
  baseUrl?: string;
  sttModel?: string;
  ttsModel?: string;
  whisperModelPath?: string;
  whisperBin?: string;
}

export class SpeechError extends Error {
  readonly kind: "not_configured" | "unavailable" | "failed";
  constructor(kind: SpeechError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

export const WHISPER_MODEL = { name: "ggml-base.en.bin", url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin", bytes: 147_964_211 };

export function findWhisperBin(): string | null {
  const candidates = [process.env.JARVIS_WHISPER_BIN, "/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli", "/opt/homebrew/bin/whisper-cpp", "/usr/local/bin/whisper-cpp"].filter(Boolean) as string[];
  return candidates.find((c) => existsSync(c)) ?? null;
}

export function sayAvailable(): boolean {
  return platform() === "darwin" && existsSync("/usr/bin/say") && existsSync("/usr/bin/afconvert");
}

function run(cmd: string, args: string[], timeoutMs = 60_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new SpeechError("failed", `${cmd.split("/").pop()} failed: ${String(stderr || err.message).slice(0, 300)}`));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** Transcribe 16-bit PCM WAV audio. */
export async function transcribe(settings: SpeechSettings, wav: Buffer, apiKey: string | null, signal?: AbortSignal): Promise<string> {
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF") throw new SpeechError("failed", "Audio must be a WAV file");
  if (settings.stt === "whisper-local") {
    const bin = settings.whisperBin || findWhisperBin();
    if (!bin) throw new SpeechError("not_configured", "whisper.cpp is not installed. Install it with `brew install whisper-cpp`, or choose another speech provider.");
    const model = settings.whisperModelPath;
    if (!model || !existsSync(model)) throw new SpeechError("not_configured", "The speech recognition model has not been downloaded yet.");
    const dir = mkdtempSync(join(tmpdir(), "jarvis-stt-"));
    try {
      const file = join(dir, "in.wav");
      writeFileSync(file, wav);
      const { stdout } = await run(bin, ["-m", model, "-f", file, "-nt", "-np", "-l", "en"], 120_000);
      return stdout.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  if (settings.stt === "openai-compatible") {
    if (!settings.baseUrl) throw new SpeechError("not_configured", "Set the speech endpoint base URL");
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "speech.wav");
    form.append("model", settings.sttModel || "whisper-1");
    let res: Response;
    try {
      res = await fetch(`${settings.baseUrl.replace(/\/$/, "")}/audio/transcriptions`, { method: "POST", headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, body: form, ...(signal ? { signal } : {}) });
    } catch (e) {
      throw new SpeechError("unavailable", `Speech service unreachable: ${(e as Error).message}`);
    }
    if (!res.ok) throw new SpeechError(res.status >= 500 || res.status === 429 ? "unavailable" : "failed", `Transcription failed (HTTP ${res.status})`);
    const data = (await res.json()) as { text?: string };
    return (data.text ?? "").trim();
  }
  if (settings.stt === "browser") throw new SpeechError("not_configured", "Browser speech recognition runs in the client, not the service.");
  throw new SpeechError("not_configured", "Speech recognition is not configured.");
}

/** Synthesize speech; returns audio bytes and MIME type. */
export async function synthesize(settings: SpeechSettings, text: string, apiKey: string | null, signal?: AbortSignal): Promise<{ audio: Buffer; mime: string }> {
  const clean = text.replace(/\[S\d+\]/g, "").replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim().slice(0, 4000);
  if (!clean) throw new SpeechError("failed", "Nothing to say");
  if (settings.tts === "macos-say") {
    if (!sayAvailable()) throw new SpeechError("not_configured", "macOS speech is not available on this system.");
    const dir = mkdtempSync(join(tmpdir(), "jarvis-tts-"));
    try {
      const input = join(dir, "in.txt");
      const aiff = join(dir, "out.aiff");
      const wav = join(dir, "out.wav");
      writeFileSync(input, clean);
      await run("/usr/bin/say", [...(settings.voice ? ["-v", settings.voice] : []), "-f", input, "-o", aiff], 120_000);
      await run("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@22050", aiff, wav]);
      return { audio: readFileSync(wav), mime: "audio/wav" };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  if (settings.tts === "openai-compatible") {
    if (!settings.baseUrl) throw new SpeechError("not_configured", "Set the speech endpoint base URL");
    let res: Response;
    try {
      res = await fetch(`${settings.baseUrl.replace(/\/$/, "")}/audio/speech`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model: settings.ttsModel || "tts-1", voice: settings.voice || "alloy", input: clean, response_format: "mp3" }),
        ...(signal ? { signal } : {}),
      });
    } catch (e) {
      throw new SpeechError("unavailable", `Speech service unreachable: ${(e as Error).message}`);
    }
    if (!res.ok) throw new SpeechError(res.status >= 500 || res.status === 429 ? "unavailable" : "failed", `Speech synthesis failed (HTTP ${res.status})`);
    return { audio: Buffer.from(await res.arrayBuffer()), mime: "audio/mpeg" };
  }
  if (settings.tts === "browser") throw new SpeechError("not_configured", "Browser speech output runs in the client.");
  throw new SpeechError("not_configured", "Speech output is not configured.");
}

/** Make a small WAV of spoken text with macOS `say`, for self-tests. */
export async function sampleWav(text: string): Promise<Buffer | null> {
  if (!sayAvailable()) return null;
  const dir = mkdtempSync(join(tmpdir(), "jarvis-sample-"));
  try {
    const aiff = join(dir, "s.aiff");
    const wav = join(dir, "s.wav");
    await run("/usr/bin/say", ["-o", aiff, text]);
    await run("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
    return readFileSync(wav);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function listSayVoices(): Promise<string[]> {
  if (!sayAvailable()) return [];
  try {
    const { stdout } = await run("/usr/bin/say", ["-v", "?"]);
    return stdout
      .split("\n")
      .map((l) => /^(.+?)\s{2,}([a-z]{2}[_-][A-Z]{2})/.exec(l))
      .filter((m): m is RegExpExecArray => !!m && m[2]!.startsWith("en"))
      .map((m) => m[1]!.trim());
  } catch {
    return [];
  }
}
