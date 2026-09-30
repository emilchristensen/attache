import type { ConnectorAdapter, AdapterContext } from "./types.ts";
import { RemoteError } from "./http.ts";
import { anthropicProvider, claudeCliProvider, complete, DEFAULT_MODELS, findClaudeCli, ModelError, openAiCompatibleProvider, type ModelProvider } from "../models/providers.ts";

export async function providerFor(ctx: Pick<AdapterContext, "connection" | "secret">): Promise<ModelProvider | null> {
  const s = ctx.connection.settings;
  const provider = String(s.provider ?? "none");
  const model = String(s.model ?? "");
  if (provider === "claude-cli") return claudeCliProvider(model);
  if (provider === "anthropic") {
    const key = await ctx.secret("apiKey");
    return key ? anthropicProvider(key, model, String(s.baseUrl || "https://api.anthropic.com")) : null;
  }
  if (provider === "openai-compatible") return openAiCompatibleProvider(await ctx.secret("apiKey"), model, String(s.baseUrl ?? ""));
  return null;
}

export const modelAdapter: ConnectorAdapter = {
  kind: "model",
  secretNames: ["apiKey"],
  definition: {
    kind: "model",
    label: "Model",
    description: "The language model that writes answers, briefings and drafts. Search works without it.",
    authMethods: [
      { id: "claude-cli", label: "Claude Code on this Mac (uses your Claude sign-in)", fields: [{ id: "model", label: "Model", secret: false, optional: true, placeholder: DEFAULT_MODELS["claude-cli"] }] },
      {
        id: "anthropic",
        label: "Anthropic API key",
        fields: [
          { id: "apiKey", label: "API key", secret: true, placeholder: "sk-ant-…" },
          { id: "model", label: "Model", secret: false, optional: true, placeholder: DEFAULT_MODELS.anthropic },
        ],
      },
      {
        id: "openai-compatible",
        label: "OpenAI-compatible endpoint (OpenAI, Ollama, LM Studio)",
        fields: [
          { id: "baseUrl", label: "Base URL", secret: false, placeholder: "http://localhost:11434/v1" },
          { id: "model", label: "Model", secret: false, placeholder: "llama3.1" },
          { id: "apiKey", label: "API key", secret: true, optional: true },
        ],
      },
    ],
    scopes: [],
    writeActions: [],
    setupHelp: "Evidence from your notes is sent to the model you choose with each question. A local endpoint keeps it on this machine.",
    unavoidableSteps: [],
  },
  async configure(ctx, fields) {
    const provider = fields.method ?? "";
    if (!["claude-cli", "anthropic", "openai-compatible"].includes(provider)) throw new RemoteError("Choose a model provider", "error");
    if (provider === "claude-cli" && !findClaudeCli()) throw new RemoteError("Claude Code was not found on this Mac. Install it from claude.com/claude-code and sign in, or use an API key.", "not_configured");
    if (provider === "anthropic" && !fields.apiKey?.trim()) throw new RemoteError("An API key is required", "unauthorized");
    if (provider === "openai-compatible") {
      try {
        const u = new URL(fields.baseUrl ?? "");
        if (!/^https?:$/.test(u.protocol)) throw new Error("bad protocol");
      } catch {
        throw new RemoteError("Enter a valid http(s) base URL", "error");
      }
      if (!fields.model?.trim()) throw new RemoteError("Enter the model name", "error");
    }
    if (fields.apiKey?.trim()) await ctx.setSecret("apiKey", fields.apiKey.trim());
    return { provider, model: fields.model?.trim() || (provider === "openai-compatible" ? "" : DEFAULT_MODELS[provider as "claude-cli" | "anthropic"]), baseUrl: fields.baseUrl?.trim() ?? "", authMethod: provider };
  },
  async test(ctx) {
    const p = await providerFor(ctx);
    if (!p) return { ok: false, state: "not_configured", account: null, message: "No model configured" };
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 90_000);
    try {
      const out = await complete(p, { system: "Reply with exactly the word: ready", messages: [{ role: "user", content: "Status check." }], maxTokens: 16, signal: ctrl.signal });
      return { ok: /ready/i.test(out), state: /ready/i.test(out) ? "complete" : "error", account: `${p.id} · ${p.model}`, message: /ready/i.test(out) ? `${p.model} responded` : `Unexpected reply: ${out.slice(0, 80)}` };
    } catch (e) {
      const err = e as ModelError;
      return { ok: false, state: err.kind === "unauthorized" ? "unauthorized" : err.kind === "unavailable" ? "offline" : "error", account: null, message: ctrl.signal.aborted ? "The model did not respond within 90 seconds" : err.message };
    } finally {
      clearTimeout(t);
    }
  },
};
