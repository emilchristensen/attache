import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { stringify as stringifyYaml } from "yaml";
import { HooksFileError } from "./hooks-config.ts";
import { AGENT_INTEGRATIONS, type AgentIntegration } from "./integrations.ts";
import { auditSkill, saveSkill, type SkillText } from "./skill-text.ts";

/**
 * Where an agent reads user-level skills. Several agents can read one folder
 * (Codex reads `~/.agents/skills`, and `~/.claude/skills` is often a symlink
 * to it), so one skill folder serves every connected agent that resolves to it.
 */
export interface SkillPackaging {
  /** User-level skills folder, relative to the home folder. */
  dir: string;
}

/**
 * Every skill folder carries every agent's "user only" switch, because an
 * agent Jarvis is not connected to may still read a shared folder:
 * `disable-model-invocation` for Claude Code and Antigravity, and
 * `agents/openai.yaml` for Codex, which ignores that frontmatter key.
 */
const USER_ONLY_FRONTMATTER = { "disable-model-invocation": true };
const CODEX_POLICY = { "agents/openai.yaml": "policy:\n  allow_implicit_invocation: false\n" };

const MARKER = ".jarvis-skill.json";

interface Marker {
  managedBy: "jarvis";
  stateDir: string;
  /** Connected agents this folder serves. */
  agents: string[];
}

/** A path with its existing part resolved, so two routes to one folder (a symlinked ~/.claude/skills) compare equal. */
function resolveLoose(p: string): string {
  let probe = p;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  return join(realpathSync(probe), relative(probe, p));
}

export class AgentSkills {
  private readonly home: () => string;
  private readonly stateDir: string;
  private readonly owner: () => string;
  private readonly cli: () => string;

  constructor(opts: { home: () => string; stateDir: string; owner: () => string; cli: () => string }) {
    this.home = opts.home;
    this.stateDir = opts.stateDir;
    this.owner = opts.owner;
    this.cli = opts.cli;
  }

  private texts(): SkillText[] {
    const cli = this.cli();
    return [saveSkill(cli), auditSkill(cli)];
  }

  /** Where agent `a` keeps the folder for one skill, e.g. ~/.claude/skills/jarvis-save. */
  private folder(a: AgentIntegration, s: SkillText): string {
    return resolveLoose(join(this.home(), a.skills!.dir, `${this.owner()}-${s.id}`));
  }

  /** Skill folder names users type: `/jarvis-save`, `/jarvis-audit`. */
  names(): string[] {
    return this.texts().map((s) => `${this.owner()}-${s.id}`);
  }

  private readMarker(folder: string): Marker | null | "foreign" {
    if (!existsSync(folder)) return null;
    try {
      const m = JSON.parse(readFileSync(join(folder, MARKER), "utf8")) as Marker;
      return m.managedBy === "jarvis" && m.stateDir === this.stateDir && Array.isArray(m.agents) ? m : "foreign";
    } catch {
      return "foreign";
    }
  }

  /** The files a skill folder should hold; the marker records which connected agents it serves. */
  private render(s: SkillText, agents: AgentIntegration[]): Record<string, string> {
    const frontmatter = { name: `${this.owner()}-${s.id}`, description: s.description, ...USER_ONLY_FRONTMATTER };
    const marker: Marker = { managedBy: "jarvis", stateDir: this.stateDir, agents: agents.map((a) => a.kind).sort() };
    return {
      "SKILL.md": `---\n${stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd()}\n---\n<!-- Managed by Jarvis: rewritten on every update and removed when you disconnect the agent. -->\n\n${s.body}`,
      ...CODEX_POLICY,
      [MARKER]: JSON.stringify(marker, null, 2) + "\n",
    };
  }

  /** Agents a folder should serve once `a` is added or removed. */
  private servedBy(folder: string, s: SkillText, change: { add?: AgentIntegration; remove?: AgentIntegration }): AgentIntegration[] {
    const m = this.readMarker(folder);
    const current = m && m !== "foreign" ? m.agents : [];
    const kinds = new Set(current.filter((k) => k !== change.remove?.kind));
    if (change.add) kinds.add(change.add.kind);
    // Only agents whose skills folder really is this one.
    return AGENT_INTEGRATIONS.filter((x) => x.skills && kinds.has(x.kind) && this.folder(x, s) === folder);
  }

  /** Install or refresh agent `a`'s skills. Never replaces a skill folder Jarvis did not write. */
  install(a: AgentIntegration): string[] {
    if (!a.skills) return [];
    return this.texts().map((s) => {
      const folder = this.folder(a, s);
      if (this.readMarker(folder) === "foreign") throw new HooksFileError(`${folder} exists and was not written by Jarvis; Jarvis will not change it. Rename or remove it, then connect again.`);
      this.write(folder, this.render(s, this.servedBy(folder, s, { add: a })));
      return folder;
    });
  }

  /** Remove agent `a` from its skill folders; a folder another connected agent still reads is rewritten for that agent instead. */
  uninstall(a: AgentIntegration): string[] {
    if (!a.skills) return [];
    return this.texts().flatMap((s) => {
      const folder = this.folder(a, s);
      const m = this.readMarker(folder);
      if (!m || m === "foreign" || !m.agents.includes(a.kind)) return [];
      const rest = this.servedBy(folder, s, { remove: a });
      if (rest.length) this.write(folder, this.render(s, rest));
      else rmSync(folder, { recursive: true, force: true });
      return [folder];
    });
  }

  /** Installed skill folders for `a`, and whether they match what this version would write. */
  status(a: AgentIntegration): { folders: string[]; current: boolean } {
    if (!a.skills) return { folders: [], current: true };
    const checks = this.texts().map((s) => {
      const folder = this.folder(a, s);
      const m = this.readMarker(folder);
      if (!m || m === "foreign" || !m.agents.includes(a.kind)) return { folder, ok: false, installed: false };
      const want = this.render(s, this.servedBy(folder, s, {}));
      return { folder, installed: true, ok: sameFolder(folder, want) };
    });
    return { folders: checks.filter((c) => c.installed).map((c) => c.folder), current: checks.every((c) => c.ok) };
  }

  /** Replace a folder's files with `files` in one step: build beside it, then swap. */
  private write(folder: string, files: Record<string, string>) {
    if (existsSync(folder) && sameFolder(folder, files)) return;
    const tmp = join(dirname(folder), `.${basename(folder)}.${randomUUID().slice(0, 8)}.jarvis.tmp`);
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(tmp, rel)), { recursive: true });
      writeFileSync(join(tmp, rel), content, { mode: 0o644 });
    }
    rmSync(folder, { recursive: true, force: true });
    renameSync(tmp, folder);
  }
}

function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(join(dir, e.name), base) : [relative(base, join(dir, e.name))]));
}

function sameFolder(folder: string, files: Record<string, string>): boolean {
  if (!existsSync(folder)) return false;
  const have = listFiles(folder).sort();
  const want = Object.keys(files).sort();
  return JSON.stringify(have) === JSON.stringify(want) && want.every((rel) => readFileSync(join(folder, rel), "utf8") === files[rel]);
}
