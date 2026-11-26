import { vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManualClock } from "../fixtures/manual-clock.ts";
import { startTestService, testFolder, type TestService } from "./harness.ts";

// A test with several Machines runs git dozens of times, one process after another; on Windows each
// start is slow, and a whole multi-Machine test took over 30 s while the suite ran in parallel there.
vi.setConfig({ testTimeout: 120_000 });

/** One Machine in a multi-Machine test: a whole service with its own state, Brain copy and clock. */
export interface TestMachine extends TestService {
  name: string;
  clock: ManualClock;
}

/** A local bare repository standing in for the owner's private GitHub repository. */
export interface TestRemote {
  /** What the owner names at setup and join. */
  readonly url: string;
  /** Make the remote unreachable, as when the Machine has no network. */
  goOffline(): void;
  goOnline(): void;
  /** `git` run inside the bare repository, for checking what was pushed. */
  git(...args: string[]): string;
  /**
   * Hold every push to the Reader lease until `count` of them have arrived,
   * then let them all go at once, so that Machines that decided at the same
   * moment also write at the same moment. Returns how many arrived.
   */
  holdLeaseWrites(count: number): { arrived(): number; stop(): void };
}

export interface TestWorld {
  remote: TestRemote;
  machines: TestMachine[];
  /** Start another Machine; it joins unless `join: false`. */
  addMachine(name: string, opts?: { join?: boolean }): Promise<TestMachine>;
  /** Stop a Machine's service and start it again on the same state and Brain, as after a crash or reboot. */
  restart(machine: TestMachine, opts?: { version?: string }): Promise<TestMachine>;
  stop(): Promise<void>;
}

const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };

/**
 * A bare repository that refuses anything but fast-forward pushes, so a test
 * fails loudly if Attache ever tried to rewrite what another Machine pushed.
 */
export function createRemote(): TestRemote {
  const dir = testFolder("remote");
  const url = join(dir, "brain.git");
  const offline = join(dir, "brain.git.offline");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env: gitEnv, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "--bare", "--quiet", "-b", "main", url);
  git("-C", url, "config", "receive.denyNonFastForwards", "true");
  // Deleting the Brain's branch is refused; Attache deletes nothing but a retired Reader lease generation.
  git("-C", url, "config", "receive.denyDeleteCurrent", "refuse");
  return {
    url,
    goOffline: () => renameSync(url, offline),
    goOnline: () => renameSync(offline, url),
    git: (...args: string[]) => execFileSync("git", ["-C", url, ...args], { env: gitEnv, encoding: "utf8", stdio: "pipe" }).trim(),
    holdLeaseWrites: (count) => holdLeaseWrites(url, count),
  };
}

/** How long a held lease write waits for the others before it goes on alone (the test then fails on `arrived`). */
const HOLD_LIMIT_S = 15;

function holdLeaseWrites(repo: string, count: number): { arrived(): number; stop(): void } {
  const gate = mkdtempSync(join(tmpdir(), "attache-it-gate-"));
  const hook = join(repo, "hooks", "pre-receive");
  const polls = HOLD_LIMIT_S * 20;
  const script = [
    "#!/bin/sh",
    `gate='${gate}'`,
    "lease=no",
    'while read old new ref; do case "$ref" in refs/attache/*) lease=yes ;; esac; done',
    '[ "$lease" = yes ] || exit 0',
    ': > "$gate/$$"',
    "polls=0",
    `while [ "$(ls "$gate" | wc -l)" -lt ${count} ] && [ "$polls" -lt ${polls} ]; do sleep 0.05; polls=$((polls + 1)); done`,
    "exit 0",
    "",
  ].join("\n");
  writeFileSync(hook, script, { mode: 0o755 });
  return {
    arrived: () => readdirSync(gate).length,
    stop: () => rmSync(hook, { force: true }),
  };
}

async function startMachine(name: string, opts: { setup: boolean } & WorldOptions): Promise<TestMachine> {
  const clock = new ManualClock();
  const svc = await startTestService({ clock, setup: opts.setup, leaseGenerationCommits: opts.leaseGenerationCommits, version: opts.version });
  await svc.call("PATCH", "/machine", { name });
  return Object.assign(svc, { name, clock });
}

/**
 * Several Machines sharing one remote. The first sets Replication up with its
 * Brain; the others join it into an empty data folder, as the owner would.
 */
export interface WorldOptions {
  /** See `TestServiceOptions.leaseGenerationCommits`. */
  leaseGenerationCommits?: number;
  /** The Attache version every Machine runs, unless a restart names another, as after an Update. */
  version?: string;
}

export async function startMachines(names: string[], world: WorldOptions = {}): Promise<TestWorld> {
  const remote = createRemote();
  const machines: TestMachine[] = [];
  const addMachine = async (name: string, opts: { join?: boolean } = {}) => {
    const joining = opts.join !== false && machines.length > 0;
    const m = await startMachine(name, { setup: !joining, ...world });
    machines.push(m);
    if (!joining && machines.length === 1 && opts.join !== false) await m.post("/replication/setup", { remote: remote.url });
    if (joining) {
      await m.post("/replication/join", { remote: remote.url, path: m.dataDir });
      await m.post("/setup/complete");
    }
    return m;
  };
  for (const name of names) await addMachine(name);
  const restart = async (machine: TestMachine, opts: { version?: string } = {}) => {
    const i = machines.indexOf(machine);
    if (i < 0) throw new Error(`${machine.name} is not part of this world`);
    await machine.stop();
    const clock = new ManualClock(machine.clock.now().getTime());
    const svc = await startTestService({ clock, stateDir: machine.stateDir, dataDir: machine.dataDir, leaseGenerationCommits: world.leaseGenerationCommits, version: opts.version ?? world.version });
    const again = Object.assign(svc, { name: machine.name, clock });
    machines.splice(i, 1, again);
    return again;
  };
  return {
    remote,
    machines,
    addMachine,
    restart,
    async stop() {
      // Each Machine has its own folders and port, so they stop side by side (one after another took over 10 s on Windows CI).
      await Promise.all(machines.map((m) => m.stop()));
    },
  };
}
