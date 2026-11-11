import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redact } from "../core/log.ts";
import { platformLocations } from "../platform/locations.ts";
import { harnessInstalls } from "../platform/harness-locations.ts";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface StreamRequest {
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ModelProvider {
  id: "claude-cli" | "anthropic" | "openai-compatible";
  model: string;
  stream(req: StreamRequest): AsyncGenerator<string>;
}

export class ModelError extends Error {
  readonly kind: "not_configured" | "unauthorized" | "unavailable" | "failed" | "cancelled";
  constructor(kind: ModelError["kind"], message: string) {
    super(redact(message));
    this.kind = kind;
  }
}

export const DEFAULT_MODELS = {
  "claude-cli": "claude-sonnet-5-5",
  anthropic: "claude-sonnet-5-5",
  "openai-compatible": "",
} as const;

export function findClaudeCli(): string | null {
  const candidates = [process.env.JARVIS_CLAUDE_BIN, ...harnessInstalls(platformLocations())["claude-code"].executables].filter(Boolean) as string[];
  return candidates.find((c) => existsSync(c)) ?? null;
}

/** Render a multi-turn conversation as a single prompt for single-shot CLIs. */
function transcript(messages: ChatMessage[]): string {
  if (messages.length === 1) return messages[0]!.content;
  const prior = messages.slice(0, -1).map((m) => `<${m.role}>\n${m.content}\n</${m.role}>`).join("\n");
  return `Earlier conversation:\n${prior}\n\nCurrent message:\n${messages[messages.length - 1]!.content}`;
}

/**
 * Local Claude Code CLI, using the user's existing Claude sign-in. It runs
 * with no tools, no MCP servers and no user/project settings, in an empty
 * working directory, so the user's own agent configuration does not leak in
 * and document content cannot trigger tool use.
 */
export function claudeCliProvider(model: string, bin = findClaudeCli()): ModelProvider {
  return {
    id: "claude-cli",
    model: model || DEFAULT_MODELS["claude-cli"],
    async *stream(req) {
      if (!bin) throw new ModelError("not_configured", "Claude Code CLI was not found. Install it from claude.com/claude-code, or choose another model provider.");
      const cwd = join(tmpdir(), "jarvis-model-cwd");
      mkdirSync(cwd, { recursive: true });
      const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence", "--system-prompt", req.system, "--model", model || DEFAULT_MODELS["claude-cli"]];
      const child = spawn(bin, args, { cwd, env: { ...process.env, CLAUDE_INVOKED_BY: "jarvis" }, stdio: ["pipe", "pipe", "pipe"] });
      const onAbort = () => child.kill("SIGTERM");
      req.signal?.addEventListener("abort", onAbort);
      child.stdin.end(transcript(req.messages));
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += String(d)));
      const exit = new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? 1)));
      let buf = "";
      let gotText = false;
      let resultError: string | null = null;
      try {
        for await (const chunk of child.stdout) {
          buf += String(chunk);
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let ev: Record<string, unknown>;
            try {
              ev = JSON.parse(line);
            } catch {
              continue;
            }
            if (ev.type === "stream_event") {
              const e = ev.event as { type?: string; delta?: { type?: string; text?: string } };
              if (e?.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text) {
                gotText = true;
                yield e.delta.text;
              }
            } else if (ev.type === "result") {
              if (ev.is_error) resultError = String(ev.result ?? ev.subtype ?? "error");
              else if (!gotText && typeof ev.result === "string") {
                gotText = true;
                yield ev.result;
              }
            }
          }
        }
        const code = await exit;
        if (req.signal?.aborted) throw new ModelError("cancelled", "Cancelled");
        if (resultError) throw new ModelError(/auth|login|credential|401/i.test(resultError) ? "unauthorized" : "failed", `Claude CLI: ${resultError}`);
        if (code !== 0 && !gotText) throw new ModelError(/not logged|login|auth/i.test(stderr) ? "unauthorized" : "failed", `Claude CLI exited ${code}: ${stderr.slice(0, 400)}`);
      } finally {
        req.signal?.removeEventListener("abort", onAbort);
        if (child.exitCode === null) child.kill("SIGTERM");
      }
    },
  };
}

async function* sseLines(res: Response): AsyncGenerator<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
}

function httpError(status: number, text: string, who: string): ModelError {
  if (status === 401 || status === 403) return new ModelError("unauthorized", `${who} rejected the credentials (HTTP ${status}).`);
  if (status === 429 || status >= 500) return new ModelError("unavailable", `${who} is unavailable (HTTP ${status}): ${text.slice(0, 200)}`);
  return new ModelError("failed", `${who} error (HTTP ${status}): ${text.slice(0, 300)}`);
}

async function post(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal | undefined, who: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
  } catch (e) {
    if (signal?.aborted) throw new ModelError("cancelled", "Cancelled");
    throw new ModelError("unavailable", `Could not reach ${who}: ${(e as Error).message}`);
  }
  if (!res.ok) throw httpError(res.status, await res.text(), who);
  return res;
}

export function anthropicProvider(apiKey: string, model: string, baseUrl = "https://api.anthropic.com"): ModelProvider {
  return {
    id: "anthropic",
    model: model || DEFAULT_MODELS.anthropic,
    async *stream(req) {
      const res = await post(
        `${baseUrl.replace(/\/$/, "")}/v1/messages`,
        { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        { model: model || DEFAULT_MODELS.anthropic, max_tokens: req.maxTokens ?? 2048, system: req.system, messages: req.messages, stream: true },
        req.signal,
        "Anthropic API",
      );
      for await (const data of sseLines(res)) {
        if (!data) continue;
        const ev = JSON.parse(data) as { type: string; delta?: { type?: string; text?: string }; error?: { message?: string } };
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) yield ev.delta.text;
        if (ev.type === "error") throw new ModelError("failed", ev.error?.message ?? "stream error");
      }
    },
  };
}

export function openAiCompatibleProvider(apiKey: string | null, model: string, baseUrl: string): ModelProvider {
  return {
    id: "openai-compatible",
    model,
    async *stream(req) {
      if (!baseUrl || !model) throw new ModelError("not_configured", "Set a base URL and model name for the OpenAI-compatible provider.");
      const res = await post(
        `${baseUrl.replace(/\/$/, "")}/chat/completions`,
        apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        { model, stream: true, max_tokens: req.maxTokens ?? 2048, messages: [{ role: "system", content: req.system }, ...req.messages] },
        req.signal,
        "Model endpoint",
      );
      for await (const data of sseLines(res)) {
        if (!data || data === "[DONE]") continue;
        const ev = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
        const t = ev.choices?.[0]?.delta?.content;
        if (t) yield t;
      }
    },
  };
}

export async function complete(p: ModelProvider, req: StreamRequest): Promise<string> {
  let out = "";
  for await (const t of p.stream(req)) out += t;
  return out;
}
