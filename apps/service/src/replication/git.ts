// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Git needs synchronous runs, 256 MB of output and a start failure kept apart from an exit code, which run() does not give; every command still starts through launchTool with windowsHide.
import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { redact } from "../core/log.ts";
import { launchTool, type Launch } from "../platform/launch.ts";
import { gitCandidates } from "../platform/git-install.ts";

/**
 * The git to run: `JARVIS_GIT_BIN`, else the first one in the usual install
 * folders (a service started at login often lacks the owner's PATH), else
 * whatever `git` the PATH finds.
 */
export function gitBinary(): string {
  if (process.env.JARVIS_GIT_BIN) return process.env.JARVIS_GIT_BIN;
  return gitCandidates().find((p) => existsSync(p)) ?? "git";
}

/** Why a git command failed, in the terms Replication reports. */
export type GitFailure = "offline" | "unauthorized" | "rejected" | "failed";

export class GitError extends Error {
  readonly kind: GitFailure;
  readonly stderr: string;
  constructor(kind: GitFailure, command: string, stderr: string) {
    super(`git ${command} failed: ${firstLine(stderr) || kind}`);
    this.kind = kind;
    this.stderr = stderr;
  }

  /** The line of git's output that says what went wrong, safe to show the owner. */
  get cause(): string {
    return firstLine(this.stderr) || this.message;
  }
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  /** The repository's working tree. */
  cwd: string;
  /** Extra `-c key=value` settings, e.g. a credential helper. */
  config?: readonly string[];
  /** Extra environment, e.g. the commit author. */
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
}

const NETWORK_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT = 256 * 1024 * 1024;

/**
 * Settings that keep git predictable whatever the owner's own git config says:
 * no hooks, no signing prompts, LF files, raw file names, never the `ext` transport.
 * A note an editor saved with CRLF is committed as LF (the Brain's
 * `.gitattributes`); `core.safecrlf` would refuse that commit, so it is off.
 */
const SAFE_CONFIG = ["core.hooksPath=.git/jarvis-no-hooks", "commit.gpgsign=false", "tag.gpgsign=false", "core.autocrlf=false", "core.safecrlf=false", "core.quotePath=false", "protocol.ext.allow=never", "advice.detachedHead=false"];

const SAFE_ENV = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", LC_ALL: "C", LANGUAGE: "C" };

/** The refs the Reader lease lives on, one per generation (`replication/lease-ref.ts`); never a branch. */
export const READER_LEASE_REFS = "refs/jarvis/reader-lease";
/** The one deletion Replication pushes: a lease generation nobody writes any more, which keeps the lease's history bounded. */
const RETIRED_LEASE = new RegExp(`^:${READER_LEASE_REFS}/[1-9][0-9]*$`);

/**
 * Replication merges and fast-forwards; it never rewrites history, here or on
 * the remote. Its only deleting push retires an old Reader lease generation.
 */
export function assertNoRewrite(args: readonly string[]): void {
  const [cmd, ...rest] = args;
  if (cmd === "rebase" || cmd === "pull" || cmd === "filter-branch" || cmd === "replace") throw new Error(`Replication never runs git ${cmd}`);
  if (cmd === "reset" && rest.some((a) => a === "--hard" || a === "--keep" || a === "--merge")) throw new Error("Replication never resets the working tree");
  if (cmd === "push" && rest.some((a) => /^(--force|-f|--force-with-lease.*|--force-if-includes|--mirror|--delete|-d|--prune)$/.test(a) || /^\+/.test(a) || (/^:/.test(a) && !RETIRED_LEASE.test(a)))) {
    throw new Error("Replication never force-pushes or deletes on the remote");
  }
}

function firstLine(text: string): string {
  const lines = redact(text)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.find((l) => /^(fatal|error|remote: error|! \[)/i.test(l)) ?? lines[0] ?? "";
}

/** Sort a failed command's output into what the owner can do about it. */
export function classifyFailure(stderr: string): GitFailure {
  if (/\[rejected\]|non-fast-forward|fetch first|\[remote rejected\]|Updates were rejected/i.test(stderr)) return "rejected";
  if (/Authentication failed|could not read Username|could not read Password|terminal prompts disabled|Permission denied|Invalid username or password|returned error: 40[13]|HTTP 40[13]|access denied|not authorized/i.test(stderr)) return "unauthorized";
  if (/Could not resolve host|Failed to connect|Connection (refused|timed out|reset)|Network is unreachable|Operation timed out|No route to host|Temporary failure in name resolution|unable to access|does not appear to be a git repository|Could not read from remote repository|Couldn't connect|timed out/i.test(stderr)) return "offline";
  return "failed";
}

/** Runs the Machine's own git in one repository. */
export class Git {
  private readonly bin: string;
  private readonly opts: GitOptions;

  constructor(opts: GitOptions, bin = gitBinary()) {
    this.opts = opts;
    this.bin = bin;
  }

  get cwd(): string {
    return this.opts.cwd;
  }

  /** The same repository with more environment, e.g. the author of the next commit. */
  with(env: Readonly<Record<string, string>>): Git {
    return new Git({ ...this.opts, env: { ...this.opts.env, ...env } }, this.bin);
  }

  private launch(args: readonly string[]): Launch {
    assertNoRewrite(args);
    const argv = [...[...SAFE_CONFIG, ...(this.opts.config ?? [])].flatMap((c) => ["-c", c]), ...args];
    try {
      return launchTool(this.bin, argv);
    } catch (e) {
      throw new GitError("failed", args[0] ?? "", (e as Error).message);
    }
  }

  private env(): NodeJS.ProcessEnv {
    return { ...process.env, ...SAFE_ENV, ...this.opts.env };
  }

  /**
   * Run a local command and wait for it. Local commands are quick, and while
   * one runs the service writes nothing, so git and Jarvis never change the
   * data folder at the same moment.
   */
  runSync(args: readonly string[], input?: string): GitResult {
    const { command, args: argv } = this.launch(args);
    const r = spawnSync(command, argv, { cwd: this.opts.cwd, env: this.env(), encoding: "utf8", maxBuffer: MAX_OUTPUT, ...(input !== undefined ? { input } : {}), windowsHide: true });
    if (r.error) throw new GitError("failed", args[0] ?? "", (r.error as Error).message);
    return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
  }

  /** `runSync`, throwing when git fails. Returns stdout. */
  okSync(args: readonly string[], input?: string): string {
    const r = this.runSync(args, input);
    if (r.code !== 0) throw new GitError(classifyFailure(r.stderr), args[0] ?? "", r.stderr);
    return r.stdout;
  }

  /** Run a command that may wait on the network, without holding up the service. */
  run(args: readonly string[]): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      const { command, args: argv } = this.launch(args);
      execFile(command, argv, { cwd: this.opts.cwd, env: this.env(), encoding: "utf8", maxBuffer: MAX_OUTPUT, timeout: this.opts.timeoutMs ?? NETWORK_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
        if (err && (err as { killed?: boolean }).killed) return reject(new GitError("offline", args[0] ?? "", `fatal: the remote did not answer within ${Math.round((this.opts.timeoutMs ?? NETWORK_TIMEOUT_MS) / 1000)} seconds`));
        if (err && typeof (err as { code?: unknown }).code !== "number") return reject(new GitError("failed", args[0] ?? "", `${stderr}\n${err.message}`));
        resolve({ code: err ? Number((err as { code?: number }).code) : 0, stdout, stderr });
      });
    });
  }

  /** `run`, throwing when git fails. Returns stdout. */
  async ok(args: readonly string[]): Promise<string> {
    const r = await this.run(args);
    if (r.code !== 0) throw new GitError(classifyFailure(r.stderr), args[0] ?? "", r.stderr);
    return r.stdout;
  }
}

/** Whether git can be run at all on this Machine. */
export function gitVersion(bin = gitBinary()): string | null {
  let launch: Launch;
  try {
    launch = launchTool(bin, ["--version"]);
  } catch {
    return null;
  }
  const r = spawnSync(launch.command, launch.args, { encoding: "utf8", windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
}
