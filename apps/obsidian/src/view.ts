import { ItemView, MarkdownRenderer, Notice, type WorkspaceLeaf } from "obsidian";
import type JarvisPlugin from "./main.ts";
import type { AttentionItem, Citation, Message } from "./api.ts";

export const VIEW_TYPE = "jarvis-view";

export class JarvisView extends ItemView {
  private readonly plugin: JarvisPlugin;
  private tab: "attention" | "ask" = "attention";
  private conversationId: string | null = null;
  private body!: HTMLElement;
  private pendingContext: { absPath: string; title: string; text: string } | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: JarvisPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return "Jarvis";
  }
  getIcon() {
    return "bot";
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("jarvis-view");
    const tabs = root.createDiv({ cls: "jarvis-tabs" });
    const mk = (id: "attention" | "ask", label: string) => {
      const b = tabs.createEl("button", { text: label, cls: "jarvis-tab" });
      b.setAttr("data-tab", id);
      this.registerDomEvent(b, "click", () => void this.show(id));
    };
    mk("attention", "Attention");
    mk("ask", "Ask");
    this.body = root.createDiv({ cls: "jarvis-body" });
    // Refresh the attention list periodically while the view is open; registerInterval is cleaned up on close/unload.
    this.registerInterval(window.setInterval(() => this.tab === "attention" && void this.renderAttention(), 60_000));
    await this.show(this.tab);
  }

  async onClose() {
    this.contentEl.empty();
  }

  async show(tab: "attention" | "ask", context?: { absPath: string; title: string; text: string }) {
    this.tab = tab;
    if (context) this.pendingContext = context;
    this.contentEl.querySelectorAll(".jarvis-tab").forEach((el) => el.toggleClass("is-active", el.getAttribute("data-tab") === tab));
    if (tab === "attention") await this.renderAttention();
    else this.renderAsk();
  }

  private notPaired(): boolean {
    if (this.plugin.client().token) return false;
    this.body.empty();
    const d = this.body.createDiv({ cls: "jarvis-empty" });
    d.createEl("p", { text: "This vault is not paired with Jarvis yet." });
    d.createEl("p", { text: "Open Settings → Jarvis, then enter a pairing code from the Jarvis app (Settings → Paired clients)." });
    return true;
  }

  async renderAttention() {
    if (this.notPaired()) return;
    this.body.empty();
    const status = this.body.createDiv({ cls: "jarvis-muted", text: "Loading…" });
    try {
      const { items } = await this.plugin.client().get<{ items: AttentionItem[] }>("/attention");
      status.remove();
      if (!items.length) {
        this.body.createDiv({ cls: "jarvis-empty", text: "Nothing needs your attention." });
        return;
      }
      for (const it of items) {
        const card = this.body.createDiv({ cls: "jarvis-item" });
        card.setAttr("data-item-key", it.key);
        card.createDiv({ cls: "jarvis-item-title", text: it.title });
        card.createDiv({ cls: "jarvis-muted", text: it.summary });
        const row = card.createDiv({ cls: "jarvis-row" });
        const ev = it.evidence[0];
        if (ev?.relPath) {
          const open = row.createEl("button", { text: "Open note" });
          this.registerDomEvent(open, "click", () => void this.plugin.openCitation({ root: it.connectionId === "vault-data" || !it.connectionId ? "data" : `import:${it.connectionId}`, relPath: ev.relPath!, startLine: ev.lines?.[0] ?? 1 }));
        }
        if (it.url) {
          const link = row.createEl("a", { text: "Open", href: it.url });
          link.setAttr("target", "_blank");
        }
        const dismiss = row.createEl("button", { text: "Dismiss" });
        this.registerDomEvent(dismiss, "click", async () => {
          await this.plugin.client().post(`/attention/${it.id}/decision`, { decision: "dismiss" });
          card.remove();
        });
      }
    } catch (e) {
      status.setText((e as Error).message);
      status.addClass("jarvis-error");
    }
  }

  renderAsk() {
    if (this.notPaired()) return;
    this.body.empty();
    const ctx = this.pendingContext;
    if (ctx) {
      const c = this.body.createDiv({ cls: "jarvis-context" });
      c.setText(`About: ${ctx.title}`);
      const clear = c.createEl("button", { text: "×", cls: "jarvis-clear" });
      clear.setAttr("aria-label", "Stop asking about this note");
      this.registerDomEvent(clear, "click", () => {
        this.pendingContext = null;
        this.renderAsk();
      });
    }
    const log = this.body.createDiv({ cls: "jarvis-log" });
    const form = this.body.createEl("form", { cls: "jarvis-form" });
    const input = form.createEl("textarea", { cls: "jarvis-input", attr: { placeholder: ctx ? `Ask about ${ctx.title}…` : "Ask Jarvis…", rows: "3" } });
    const send = form.createEl("button", { text: "Ask", cls: "mod-cta", attr: { type: "submit" } });
    this.registerDomEvent(input, "keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
    this.registerDomEvent(form, "submit", async (e: Event) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      send.disabled = true;
      log.createDiv({ cls: "jarvis-q", text });
      const a = log.createDiv({ cls: "jarvis-a", text: "Searching your notes…" });
      try {
        const r = await this.plugin.client().post<{ conversationId: string; assistantMessage: Message }>("/chat", {
          conversationId: this.conversationId,
          text,
          ...(ctx ? { context: { absPath: ctx.absPath, title: ctx.title, selection: ctx.text.slice(0, 20_000) } } : {}),
        });
        this.conversationId = r.conversationId;
        const m = await this.waitForAnswer(r.assistantMessage.id, a);
        await this.renderAnswer(a, m);
      } catch (err) {
        a.setText((err as Error).message);
        a.addClass("jarvis-error");
      } finally {
        send.disabled = false;
      }
    });
    input.focus();
  }

  private async waitForAnswer(id: string, el: HTMLElement): Promise<Message> {
    for (let i = 0; i < 600; i++) {
      const m = await this.plugin.client().get<Message>(`/messages/${id}`);
      if (m.status !== "streaming") return m;
      if (m.content) el.setText(m.content);
      await sleep(400);
    }
    throw new Error("Jarvis did not finish answering in time");
  }

  private async renderAnswer(el: HTMLElement, m: Message) {
    el.empty();
    el.setAttr("data-status", m.status);
    if (m.status === "error") {
      el.setText(`The answer failed: ${m.error}`);
      el.addClass("jarvis-error");
      return;
    }
    const content = el.createDiv();
    // Render as Markdown through Obsidian's own renderer (HTML in answers is not trusted).
    await MarkdownRenderer.render(this.app, safeMarkdown(m.content), content, "", this);
    if (m.retrieval && !m.retrieval.supported) el.createDiv({ cls: "jarvis-warn", text: "No supporting evidence was cited from your notes." });
    if (m.citations.length) {
      const src = el.createDiv({ cls: "jarvis-sources" });
      for (const c of m.citations) {
        const b = src.createEl("button", { cls: "jarvis-source", text: `${c.marker} ${c.title} · ${c.relPath}:${c.startLine}` });
        this.registerDomEvent(b, "click", () => void this.plugin.openCitation(c as Citation));
      }
    }
  }
}

/**
 * Model output is untrusted: escape HTML, drop images and embeds (a remote image
 * URL could carry note text out), and keep only http(s) links.
 */
export function safeMarkdown(text: string): string {
  return text
    .replace(/</g, "&lt;")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/!\[\[[^\]]*\]\]/g, "")
    .replace(/\[([^\]]*)\]\((?!https?:\/\/)[^)]*\)/g, "$1");
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

export function noticeError(e: unknown) {
  new Notice(`Jarvis: ${(e as Error).message}`, 8000);
}
