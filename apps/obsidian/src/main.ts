import { FileSystemAdapter, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TFile, type App, type Editor } from "obsidian";
import { JarvisClient } from "./api.ts";
import { JarvisView, VIEW_TYPE, noticeError } from "./view.ts";

interface Settings {
  serviceUrl: string;
  clientName: string;
}

const DEFAULTS: Settings = { serviceUrl: "http://127.0.0.1:7427", clientName: "Obsidian" };
const TOKEN_ID = "jarvis-client-token";

/**
 * Thin Obsidian client for the Jarvis service. It never writes memory or
 * schedules work itself: captures, questions and decisions go to the same
 * service API the browser uses. Closing Obsidian does not stop the service.
 */
export default class JarvisPlugin extends Plugin {
  settings: Settings = { ...DEFAULTS };

  async onload() {
    this.settings = { ...DEFAULTS, ...((await this.loadData()) as Partial<Settings> | null) };
    this.registerView(VIEW_TYPE, (leaf) => new JarvisView(leaf, this));
    this.addRibbonIcon("bot", "Open Jarvis", () => void this.activate("attention"));
    this.addSettingTab(new JarvisSettingTab(this.app, this));

    this.addCommand({
      id: "ask-about-note",
      name: "Ask about the current note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) void this.askAboutNote(file);
        return true;
      },
    });
    this.addCommand({
      id: "capture-selection",
      name: "Capture selection with provenance",
      editorCheckCallback: (checking, editor: Editor, view) => {
        if (!editor.getSelection() || !(view instanceof MarkdownView) || !view.file) return false;
        if (!checking) void this.captureSelection(editor, view.file);
        return true;
      },
    });
    this.addCommand({
      id: "research-note",
      name: "Research the current note in the background",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) void this.researchNote(file);
        return true;
      },
    });
    this.addCommand({
      id: "open-attention",
      name: "Open attention items",
      callback: () => void this.activate("attention"),
    });
  }

  onunload() {
    // Views, intervals, DOM and workspace events are registered through the Plugin/ItemView
    // APIs and released by Obsidian. Leaves are not detached here, per Obsidian guidance.
  }

  token(): string | null {
    const t = this.app.secretStorage.getSecret(TOKEN_ID);
    return t ? t : null;
  }

  client(): JarvisClient {
    return new JarvisClient(this.settings.serviceUrl, this.token());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  vaultBasePath(): string | null {
    const a = this.app.vault.adapter;
    return a instanceof FileSystemAdapter ? a.getBasePath() : null;
  }

  async pair(code: string): Promise<string> {
    const r = await new JarvisClient(this.settings.serviceUrl, null).post<{ token: string; client: { id: string } }>("/pair", { code, kind: "obsidian", clientName: `${this.settings.clientName} (${this.app.vault.getName()})` });
    this.app.secretStorage.setSecret(TOKEN_ID, r.token);
    return r.client.id;
  }

  unpair() {
    this.app.secretStorage.setSecret(TOKEN_ID, "");
  }

  async activate(tab: "attention" | "ask", context?: { absPath: string; title: string; text: string }) {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (view instanceof JarvisView) await view.show(tab, context);
  }

  async askAboutNote(file: TFile) {
    const base = this.vaultBasePath();
    const text = await this.app.vault.cachedRead(file);
    await this.activate("ask", { absPath: base ? `${base}/${file.path}` : file.path, title: file.basename, text });
  }

  async researchNote(file: TFile) {
    try {
      const r = await this.client().post<{ job: { id: string } }>("/jobs", { kind: "research", input: { question: `What do my notes say about ${file.basename}?` } });
      new Notice(`Jarvis is researching “${file.basename}” in the background (job ${r.job.id.slice(0, 8)}). Results appear in Jarvis → Jobs.`);
    } catch (e) {
      noticeError(e);
    }
  }

  async captureSelection(editor: Editor, file: TFile) {
    const from = editor.getCursor("from").line + 1;
    const to = editor.getCursor("to").line + 1;
    const base = this.vaultBasePath();
    try {
      const r = await this.client().post<{ capture: { relPath: string } }>("/memory/capture", {
        text: editor.getSelection(),
        title: `${file.basename} (lines ${from}-${to})`,
        source: { kind: "note", ref: file.path, lines: [from, to], label: `Obsidian vault “${this.app.vault.getName()}”${base ? ` at ${base}` : ""}` },
      });
      new Notice(`Captured to Jarvis: ${r.capture.relPath}`);
    } catch (e) {
      noticeError(e);
    }
  }

  /** Open a cited note: in this vault when the citation points into it, otherwise in the Jarvis app. */
  async openCitation(c: { root: string; relPath: string; startLine: number }) {
    try {
      const roots = await this.client().get<Array<{ root: string; path: string }>>("/memory/roots");
      const base = this.vaultBasePath();
      const root = roots.find((r) => r.root === c.root);
      if (root && base) {
        const abs = `${root.path.replace(/\/+$/, "")}/${c.relPath}`;
        if (abs.startsWith(`${base}/`)) {
          const inVault = abs.slice(base.length + 1);
          const file = this.app.vault.getAbstractFileByPath(inVault);
          if (file instanceof TFile) {
            const leaf = this.app.workspace.getLeaf(false);
            await leaf.openFile(file, { eState: { line: Math.max(0, c.startLine - 1) } });
            return;
          }
        }
      }
      window.open(`${this.settings.serviceUrl}/memory?root=${encodeURIComponent(c.root)}&path=${encodeURIComponent(c.relPath)}`);
    } catch (e) {
      noticeError(e);
    }
  }
}

class JarvisSettingTab extends PluginSettingTab {
  private readonly plugin: JarvisPlugin;
  constructor(app: App, plugin: JarvisPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("p", { text: "Jarvis runs as a separate service on this Mac. This plugin is a client: it asks questions, captures notes and shows attention items through that service. Closing Obsidian does not stop Jarvis." });
    const status = containerEl.createDiv({ cls: "jarvis-status", text: "Checking the Jarvis service…" });
    void this.check(status);

    new Setting(containerEl)
      .setName("Service address")
      .setDesc("Where the Jarvis service listens. The installer uses http://127.0.0.1:7427.")
      .addText((t) =>
        t.setValue(this.plugin.settings.serviceUrl).onChange(async (v) => {
          this.plugin.settings.serviceUrl = v.trim() || DEFAULTS.serviceUrl;
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName("Client name")
      .setDesc("Shown in Jarvis → Settings → Paired clients.")
      .addText((t) =>
        t.setValue(this.plugin.settings.clientName).onChange(async (v) => {
          this.plugin.settings.clientName = v.trim() || DEFAULTS.clientName;
          await this.plugin.saveSettings();
        }),
      );
    let code = "";
    new Setting(containerEl)
      .setName("Pair with Jarvis")
      .setDesc("In the Jarvis app open Settings → Paired clients → Create pairing code, then enter it here. The access token is kept in Obsidian's secret storage, not in this vault.")
      .addText((t) => t.setPlaceholder("ABCD2345").onChange((v) => (code = v)))
      .addButton((b) =>
        b
          .setButtonText(this.plugin.token() ? "Pair again" : "Pair")
          .setCta()
          .onClick(async () => {
            try {
              await this.plugin.pair(code);
              new Notice("Paired with Jarvis");
              this.display();
            } catch (e) {
              noticeError(e);
            }
          }),
      );
    if (this.plugin.token()) {
      new Setting(containerEl).setName("Unpair").setDesc("Forget this vault's Jarvis access token.").addButton((b) =>
        b.setButtonText("Unpair").onClick(() => {
          this.plugin.unpair();
          this.display();
        }),
      );
    }
    const install = containerEl.createDiv({ cls: "setting-item-description" });
    install.createEl("p", { text: "Jarvis is not installed? Run the Jarvis installer (Jarvis-Installer-<version>-macos.command) from the release, then pair." });
  }

  private async check(el: HTMLElement) {
    try {
      const h = await this.plugin.client().get<{ version: string }>("/health");
      if (!this.plugin.token()) {
        el.setText(`Jarvis ${h.version} is running. Not paired yet.`);
        return;
      }
      const s = await this.plugin.client().get<{ client: { name: string } }>("/session");
      el.setText(`Connected to Jarvis ${h.version} as “${s.client.name}”.`);
      el.addClass("jarvis-ok");
    } catch (e) {
      el.setText((e as Error).message);
      el.addClass("jarvis-error");
    }
  }
}
