import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ourHooks, ourNamedHooks, readSettings, sameHooks, withNamedHooks, withOurHooks, withoutNamedHooks, withoutOurHooks, writeSettings, HooksFileError, type HookSpec } from "../src/agents/hooks-config.ts";
import { accessOutsideOwner, permissions, tempDir } from "./helpers.ts";

const isOurs = (c: string) => c.includes("attache-agent-hook");
const ours: HookSpec[] = [
  { event: "SessionStart", matcher: "", command: "node attache-agent-hook.mjs claude-code session-start", timeout: 10 },
  { event: "SessionEnd", command: "node attache-agent-hook.mjs claude-code session-end", timeout: 5 },
];
const foreign = {
  model: "opus",
  permissions: { allow: ["Bash(git *)"] },
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "rtk hook claude" }] }],
    SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "bash snapshot.sh", timeout: 5 }] }],
  },
};

describe("hooks config editing", () => {
  it("adds Attache hooks without touching anything else", () => {
    const next = withOurHooks(foreign, ours, isOurs);
    expect(next.model).toBe("opus");
    expect(next.permissions).toEqual(foreign.permissions);
    expect(next.hooks!.PreToolUse).toEqual(foreign.hooks.PreToolUse);
    expect(next.hooks!.SessionStart![0]).toEqual(foreign.hooks.SessionStart[0]);
    expect(sameHooks(ourHooks(next, isOurs), ours)).toBe(true);
  });

  it("is idempotent and replaces stale Attache entries instead of duplicating them", () => {
    const stale = withOurHooks(foreign, [{ ...ours[0]!, command: "old/attache-agent-hook.mjs claude-code session-start" }], isOurs);
    const once = withOurHooks(stale, ours, isOurs);
    expect(withOurHooks(once, ours, isOurs)).toEqual(once);
    expect(ourHooks(once, isOurs)).toHaveLength(2);
  });

  it("removing restores the original settings exactly", () => {
    expect(withoutOurHooks(withOurHooks(foreign, ours, isOurs), isOurs)).toEqual(foreign);
    expect(withoutOurHooks(withOurHooks({}, ours, isOurs), isOurs)).toEqual({ hooks: {} });
  });

  it("keeps a foreign hook that shares a group with an Attache hook", () => {
    const mixed = { hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "other" }, { type: "command", command: "x attache-agent-hook y" }] }] } };
    expect(withoutOurHooks(mixed, isOurs)).toEqual({ hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "other" }] }] } });
  });

  it("refuses to edit files it cannot understand, and never overwrites them", () => {
    const dir = tempDir();
    const bad = join(dir, "settings.json");
    writeFileSync(bad, "{ not json");
    expect(() => readSettings(bad)).toThrow(HooksFileError);
    expect(() => withOurHooks({ hooks: "nope" } as never, ours, isOurs)).toThrow(HooksFileError);
    expect(readFileSync(bad, "utf8")).toBe("{ not json");
  });

  it("backs up the previous file before writing", () => {
    const dir = tempDir();
    const file = join(dir, "claude", "settings.json");
    expect(writeSettings(file, { a: 1 }, join(dir, "backups")).backup).toBeNull();
    const { backup } = writeSettings(file, { a: 2 }, join(dir, "backups"));
    expect(backup && existsSync(backup)).toBe(true);
    expect(JSON.parse(readFileSync(backup!, "utf8"))).toEqual({ a: 1 });
    expect(readSettings(file)).toEqual({ a: 2 });
  });
});

describe("named hooks format (Antigravity)", () => {
  const spec: HookSpec[] = [{ event: "Stop", command: "node attache-agent-hook.mjs antigravity turn-end", timeout: 10 }];
  const other = { "claude-mem": { enabled: true, PreInvocation: [{ type: "command", command: "claude-mem inject", timeout: 30 }] } };

  it("owns one entry and leaves other tools' entries alone", () => {
    const next = withNamedHooks(other, "attache", spec, isOurs);
    expect(next["claude-mem"]).toEqual(other["claude-mem"]);
    expect(next.attache).toEqual({ enabled: true, Stop: [{ type: "command", command: spec[0]!.command, timeout: 10 }] });
    expect(sameHooks(ourNamedHooks(next, isOurs), spec)).toBe(true);
    expect(withNamedHooks(next, "attache", spec, isOurs)).toEqual(next);
    expect(withoutNamedHooks(next, isOurs)).toEqual(other);
  });

  it("will not take over an entry it did not write", () => {
    expect(() => withNamedHooks({ attache: { Stop: [{ type: "command", command: "someone else" }] } }, "attache", spec, isOurs)).toThrow(HooksFileError);
  });
});

describe("review fixes: never damage the user's own agent setup", () => {
  it("writes through a symlinked settings file and keeps its permissions", async () => {
    const { symlinkSync, lstatSync, chmodSync } = await import("node:fs");
    const dir = tempDir();
    const real = join(dir, "dotfiles-settings.json");
    writeFileSync(real, JSON.stringify(foreign));
    chmodSync(real, 0o600);
    const before = permissions(real);
    const link = join(dir, "settings.json");
    symlinkSync(real, link);
    writeSettings(link, withOurHooks(readSettings(link), ours, isOurs), join(dir, "backups"));
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(permissions(real)).toBe(before);
    expect(accessOutsideOwner(real)).toEqual([]);
    expect(JSON.stringify(readSettings(real))).toContain("attache-agent-hook");
  });

  it("updates Attache's hooks in place, so the user's other hooks keep their positions (Codex trusts by position)", () => {
    const userHook = { matcher: "", hooks: [{ type: "command", command: "user-session-start" }] };
    const installed = { hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "old attache-agent-hook a" }] }, userHook] } };
    const next = withOurHooks(installed, [{ event: "SessionStart", matcher: "", command: "new attache-agent-hook b", timeout: 10 }], isOurs);
    expect(next.hooks!.SessionStart![1]).toEqual(userHook);
    expect(next.hooks!.SessionStart![0]!.hooks![0]!.command).toBe("new attache-agent-hook b");
  });
});
