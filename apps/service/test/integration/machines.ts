import { execFileSync } from "node:child_process";
import { mkdtempSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManualClock } from "../fixtures/manual-clock.ts";
import { startTestService, type TestService } from "./harness.ts";

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
}

export interface TestWorld {
  remote: TestRemote;
  machines: TestMachine[];
  /** Start another Machine; it joins unless `join: false`. */
  addMachine(name: string, opts?: { join?: boolean }): Promise<TestMachine>;
  /** Stop a Machine's service and start it again on the same state and Brain, as after a crash or reboot. */
  restart(machine: TestMachine): Promise<TestMachine>;
  stop(): Promise<void>;
}

const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };

/**
 * A bare repository that refuses anything but fast-forward pushes, so a test
 * fails loudly if Jarvis ever tried to rewrite what another Machine pushed.
 */
export function createRemote(): TestRemote {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-it-remote-"));
  const url = join(dir, "brain.git");
  const offline = join(dir, "brain.git.offline");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env: gitEnv, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "--bare", "--quiet", "-b", "main", url);
  git("-C", url, "config", "receive.denyNonFastForwards", "true");
  git("-C", url, "config", "receive.denyDeletes", "true");
  return {
    url,
    goOffline: () => renameSync(url, offline),
    goOnline: () => renameSync(offline, url),
    git: (...args: string[]) => execFileSync("git", ["-C", url, ...args], { env: gitEnv, encoding: "utf8", stdio: "pipe" }).trim(),
  };
}

async function startMachine(name: string, opts: { setup: boolean }): Promise<TestMachine> {
  const clock = new ManualClock();
  const svc = await startTestService({ clock, setup: opts.setup });
  await svc.call("PATCH", "/machine", { name });
  return Object.assign(svc, { name, clock });
}

/**
 * Several Machines sharing one remote. The first sets Replication up with its
 * Brain; the others join it into an empty data folder, as the owner would.
 */
export async function startMachines(names: string[]): Promise<TestWorld> {
  const remote = createRemote();
  const machines: TestMachine[] = [];
  const addMachine = async (name: string, opts: { join?: boolean } = {}) => {
    const joining = opts.join !== false && machines.length > 0;
    const m = await startMachine(name, { setup: !joining });
    machines.push(m);
    if (!joining && machines.length === 1 && opts.join !== false) await m.post("/replication/setup", { remote: remote.url });
    if (joining) {
      await m.post("/replication/join", { remote: remote.url, path: m.dataDir });
      await m.post("/setup/complete");
    }
    return m;
  };
  for (const name of names) await addMachine(name);
  const restart = async (machine: TestMachine) => {
    const i = machines.indexOf(machine);
    if (i < 0) throw new Error(`${machine.name} is not part of this world`);
    await machine.stop();
    const clock = new ManualClock(machine.clock.now().getTime());
    const svc = await startTestService({ clock, stateDir: machine.stateDir, dataDir: machine.dataDir });
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
      for (const m of machines) await m.stop();
    },
  };
}
