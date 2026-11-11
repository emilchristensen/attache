/**
 * TEST-ONLY: run command lines the way a Harness's shell does, so tests catch
 * quoting that only one shell understands.
 *
 * macOS and Linux Harnesses use a POSIX shell. On Windows, Claude Code runs
 * hooks and its Bash tool through Git Bash, and Codex runs hooks through
 * cmd.exe; Antigravity is treated like Codex.
 */
import { execFileSync, execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const WINDOWS = process.platform === "win32";

export type ShellKind = "posix" | "git-bash" | "cmd";

/** Git Bash, as Git for Windows installs it. `JARVIS_TEST_GIT_BASH` overrides it. */
export function gitBash(): string {
  const candidates = [process.env.JARVIS_TEST_GIT_BASH, join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe")].filter(Boolean) as string[];
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error(`Git Bash was not found at ${candidates.join(" or ")}; install Git for Windows or set JARVIS_TEST_GIT_BASH.`);
  return found;
}

/** The shell a Harness runs hook commands with on this operating system. */
export function hookShell(harness: "claude-code" | "codex" | "antigravity"): ShellKind {
  if (!WINDOWS) return "posix";
  return harness === "claude-code" ? "git-bash" : "cmd";
}

/** The shell a Harness's own command tool (Claude Code's Bash tool) uses. */
export const toolShell = (): ShellKind => (WINDOWS ? "git-bash" : "posix");

/** The home folder variables a child expects: `HOME` everywhere, and `USERPROFILE`, which Windows programs read. */
export const homeEnv = (home: string): Record<string, string> => (WINDOWS ? { HOME: home, USERPROFILE: home } : { HOME: home });

interface RunOptions {
  cwd?: string;
  input?: string;
  env?: NodeJS.ProcessEnv;
}

/** Run `command` through `shell` and return its standard output; throws when it exits non-zero. */
export function runInShell(shell: ShellKind, command: string, opts: RunOptions = {}): string {
  const common = { cwd: opts.cwd, input: opts.input ?? "", env: opts.env, encoding: "utf8" as const };
  if (shell === "posix") return execFileSync("/bin/sh", ["-lc", command], common);
  if (shell === "git-bash") return execFileSync(gitBash(), ["-c", command], common);
  // Node runs a shell command on Windows as `cmd.exe /d /s /c "<command>"`, the way Codex and Claude Code's fallback do.
  return execSync(command, common);
}

/** Run `script` through `shell` without blocking this process (the service under test runs in it). */
export function spawnInShell(shell: ShellKind, script: string, opts: Omit<RunOptions, "input"> = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child =
      shell === "posix"
        ? spawn("/bin/sh", ["-c", script], { cwd: opts.cwd, env: opts.env })
        : shell === "git-bash"
          ? spawn(gitBash(), ["-c", script], { cwd: opts.cwd, env: opts.env })
          : spawn(script, { cwd: opts.cwd, env: opts.env, shell: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
