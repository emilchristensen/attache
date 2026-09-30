import type { ConnectorAdapter } from "./types.ts";
import { RemoteError } from "./http.ts";
import { findWhisperBin, sampleWav, sayAvailable, synthesize, transcribe, type SpeechSettings, SpeechError } from "../speech/engine.ts";

export const speechAdapter: ConnectorAdapter = {
  kind: "speech",
  secretNames: ["apiKey"],
  definition: {
    kind: "speech",
    label: "Speech",
    description: "Speech recognition for push-to-talk and a voice for spoken answers.",
    authMethods: [
      {
        id: "local",
        label: "On this Mac (whisper.cpp recognition, macOS voice)",
        fields: [
          { id: "stt", label: "Recognition", secret: false, placeholder: "whisper-local | browser | none" },
          { id: "tts", label: "Voice output", secret: false, placeholder: "macos-say | browser | none" },
          { id: "voice", label: "macOS voice", secret: false, optional: true, placeholder: "Samantha" },
        ],
      },
      {
        id: "openai-compatible",
        label: "OpenAI-compatible speech API",
        fields: [
          { id: "baseUrl", label: "Base URL", secret: false, placeholder: "https://api.openai.com/v1" },
          { id: "apiKey", label: "API key", secret: true, optional: true },
          { id: "sttModel", label: "Transcription model", secret: false, optional: true, placeholder: "whisper-1" },
          { id: "ttsModel", label: "Speech model", secret: false, optional: true, placeholder: "tts-1" },
          { id: "voice", label: "Voice", secret: false, optional: true, placeholder: "alloy" },
        ],
      },
    ],
    scopes: [],
    writeActions: [],
    setupHelp: "Local recognition keeps audio on this Mac. It needs whisper.cpp (`brew install whisper-cpp`) and a one-time 148 MB model download, which Jarvis does for you. Browser recognition in Chrome sends audio to Google.",
    unavoidableSteps: ["For local recognition: install whisper.cpp once with `brew install whisper-cpp`."],
  },
  async configure(ctx, fields) {
    const method = fields.method ?? "local";
    const settings: SpeechSettings & { authMethod: string } = { stt: "none", tts: "none", authMethod: method };
    if (method === "local") {
      settings.stt = (["whisper-local", "browser", "none"].includes(fields.stt ?? "") ? fields.stt : "whisper-local") as SpeechSettings["stt"];
      settings.tts = (["macos-say", "browser", "none"].includes(fields.tts ?? "") ? fields.tts : sayAvailable() ? "macos-say" : "browser") as SpeechSettings["tts"];
      if (fields.voice?.trim()) settings.voice = fields.voice.trim();
      if (settings.stt === "whisper-local") {
        settings.whisperModelPath = fields.whisperModelPath ?? "";
        const bin = findWhisperBin();
        if (bin) settings.whisperBin = bin;
      }
    } else {
      if (!fields.baseUrl?.trim()) throw new RemoteError("Enter the speech API base URL", "error");
      settings.stt = "openai-compatible";
      settings.tts = "openai-compatible";
      settings.baseUrl = fields.baseUrl.trim();
      if (fields.sttModel?.trim()) settings.sttModel = fields.sttModel.trim();
      if (fields.ttsModel?.trim()) settings.ttsModel = fields.ttsModel.trim();
      if (fields.voice?.trim()) settings.voice = fields.voice.trim();
      if (fields.apiKey?.trim()) await ctx.setSecret("apiKey", fields.apiKey.trim());
    }
    return settings as unknown as Record<string, unknown>;
  },
  async test(ctx) {
    const s = ctx.connection.settings as unknown as SpeechSettings;
    const key = await ctx.secret("apiKey");
    const results: string[] = [];
    let sttOk = s.stt === "browser" || s.stt === "none";
    let ttsOk = s.tts === "browser" || s.tts === "none";
    if (s.tts !== "browser" && s.tts !== "none") {
      try {
        const out = await synthesize(s, "Jarvis voice check.", key, ctx.signal);
        ttsOk = out.audio.length > 1000;
        results.push(`voice output ok (${Math.round(out.audio.length / 1024)} KB)`);
      } catch (e) {
        results.push(`voice output: ${(e as Error).message}`);
      }
    } else results.push(`voice output: ${s.tts === "browser" ? "handled by the browser" : "off"}`);
    if (s.stt !== "browser" && s.stt !== "none") {
      try {
        const wav = await sampleWav("testing one two three");
        if (!wav) throw new SpeechError("unavailable", "Cannot create a test recording on this system");
        const text = await transcribe(s, wav, key, ctx.signal);
        sttOk = /test|one|two|three/i.test(text);
        results.push(sttOk ? `recognition ok (“${text.slice(0, 40)}”)` : `recognition returned “${text.slice(0, 40)}”`);
      } catch (e) {
        results.push(`recognition: ${(e as Error).message}`);
      }
    } else results.push(`recognition: ${s.stt === "browser" ? "handled by the browser" : "off"}`);
    const ok = sttOk && ttsOk && !(s.stt === "none" && s.tts === "none");
    return { ok, state: ok ? "complete" : sttOk || ttsOk ? "partial" : "error", account: `${s.stt} / ${s.tts}`, message: results.join("; ") };
  },
};
