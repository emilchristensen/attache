import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { AgentSkills } from "../src/agents/skills.ts";
import { antigravity, claudeCode, codex } from "../src/agents/integrations.ts";
import { splitFrontmatter } from "../src/memory/markdown.ts";

let home: string;
const STATE = "/tmp/jarvis-skill-test-state";
const CLI = `JARVIS_STATE_DIR='${STATE}' '/x/node' '/x/jarvis-service.mjs'`;
let cli = CLI;
const skills = () => new AgentSkills({ home: () => home, stateDir: STATE, owner: () => "jarvis", cli: () => cli });

const skillMd = (dir: string) => readFileSync(join(home, dir, "SKILL.md"), "utf8");

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "jarvis-skills-home-"));
  cli = CLI;
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("user-invoked Jarvis skills", () => {
  it("installs save and audit skills that only the user can invoke, in every agent's format", () => {
    const folders = skills().install(claudeCode);
    expect(folders.map((f) => f.split("/").at(-1))).toEqual(["jarvis-save", "jarvis-audit"]);
    for (const name of ["jarvis-save", "jarvis-audit"]) {
      const { frontmatter, body } = splitFrontmatter(skillMd(`.claude/skills/${name}`));
      expect(frontmatter).toMatchObject({ name, "disable-model-invocation": true });
      expect(String(frontmatter.description)).toContain("Only when the user explicitly invokes it");
      expect(body).toContain(`${CLI} ${name === "jarvis-save" ? "save" : "audit"}`);
      // Codex ignores the frontmatter key, so every folder also carries Codex's policy file.
      expect(parseYaml(readFileSync(join(home, `.claude/skills/${name}/agents/openai.yaml`), "utf8"))).toEqual({ policy: { allow_implicit_invocation: false } });
    }
    skills().install(codex);
    skills().install(antigravity);
    expect(existsSync(join(home, ".agents/skills/jarvis-save/agents/openai.yaml"))).toBe(true);
    expect(splitFrontmatter(skillMd(".gemini/config/skills/jarvis-audit")).frontmatter["disable-model-invocation"]).toBe(true);
    for (const a of [claudeCode, codex, antigravity]) expect(skills().status(a)).toMatchObject({ current: true });
  });

  it("shares one folder between agents that read the same place, and removes it only when the last one disconnects", () => {
    // A dotfiles setup: ~/.claude/skills is a symlink to ~/.agents/skills, which Codex reads.
    mkdirSync(join(home, ".agents/skills"), { recursive: true });
    mkdirSync(join(home, ".claude"), { recursive: true });
    symlinkSync(join(home, ".agents/skills"), join(home, ".claude/skills"));
    skills().install(claudeCode);
    skills().install(codex);
    const marker = () => JSON.parse(readFileSync(join(home, ".agents/skills/jarvis-save/.jarvis-skill.json"), "utf8"));
    expect(marker().agents).toEqual(["claude-code", "codex"]);
    skills().uninstall(claudeCode);
    // Codex still reads it, and so does Claude Code through the link: it stays user-only for both.
    expect(marker().agents).toEqual(["codex"]);
    expect(splitFrontmatter(skillMd(".claude/skills/jarvis-save")).frontmatter["disable-model-invocation"]).toBe(true);
    expect(skills().status(claudeCode).folders).toEqual([]);
    expect(skills().status(codex).current).toBe(true);
    skills().uninstall(codex);
    expect(readdirSync(join(home, ".agents/skills"))).toEqual([]);
  });

  it("never touches a skill folder it did not write, and leaves other skills alone", () => {
    mkdirSync(join(home, ".claude/skills/jarvis-save"), { recursive: true });
    writeFileSync(join(home, ".claude/skills/jarvis-save/SKILL.md"), "---\nname: jarvis-save\n---\nmine\n");
    mkdirSync(join(home, ".claude/skills/other"), { recursive: true });
    writeFileSync(join(home, ".claude/skills/other/SKILL.md"), "other");
    expect(() => skills().install(claudeCode)).toThrow(/was not written by Jarvis/);
    expect(skillMd(".claude/skills/jarvis-save")).toContain("mine");
    expect(skills().uninstall(claudeCode)).toEqual([]);
    expect(skillMd(".claude/skills/jarvis-save")).toContain("mine");
    expect(skillMd(".claude/skills/other")).toBe("other");
  });

  it("another Jarvis instance's skills are foreign", () => {
    skills().install(claudeCode);
    const other = new AgentSkills({ home: () => home, stateDir: "/tmp/other-state", owner: () => "jarvis", cli: () => CLI });
    expect(() => other.install(claudeCode)).toThrow(/was not written by Jarvis/);
    expect(other.uninstall(claudeCode)).toEqual([]);
    expect(existsSync(join(home, ".claude/skills/jarvis-save/SKILL.md"))).toBe(true);
  });

  it("reports out-of-date skills and rewrites them in place", () => {
    skills().install(claudeCode);
    cli = `JARVIS_STATE_DIR='${STATE}' '/y/node' '/y/jarvis-service.mjs'`;
    expect(skills().status(claudeCode)).toMatchObject({ current: false, folders: [expect.stringContaining("jarvis-save"), expect.stringContaining("jarvis-audit")] });
    skills().install(claudeCode);
    expect(skills().status(claudeCode).current).toBe(true);
    expect(skillMd(".claude/skills/jarvis-save")).toContain("/y/jarvis-service.mjs");
    // A stray file in a managed folder also counts as out of date, and is cleared by the rewrite.
    writeFileSync(join(home, ".claude/skills/jarvis-save/extra.md"), "x");
    expect(skills().status(claudeCode).current).toBe(false);
    skills().install(claudeCode);
    expect(existsSync(join(home, ".claude/skills/jarvis-save/extra.md"))).toBe(false);
    expect(readdirSync(join(home, ".claude/skills")).filter((f) => f.includes("tmp"))).toEqual([]);
  });
});
