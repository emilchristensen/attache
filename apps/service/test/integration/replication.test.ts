import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { startTestService, type TestService } from "./harness.ts";
import { startMachines, type TestMachine, type TestWorld } from "./machines.ts";

const CHECK = 60_000;
const AFTER_WRITE = 30_000;

let world: TestWorld | null = null;
let single: TestService | null = null;

afterEach(async () => {
  await world?.stop();
  await single?.stop();
  world = null;
  single = null;
});

async function hits(m: TestMachine, q: string): Promise<string[]> {
  const r = await m.get(`/memory/search?q=${encodeURIComponent(q)}`);
  return [...new Set((r.hits as Array<{ relPath: string }>).map((h) => h.relPath))];
}

const saveProject = (m: TestMachine, title: string, status: string) =>
  m.post("/memory/save", { items: [{ action: "create", type: "project", title, facts: [{ subject: "Status", value: status }] }] });

describe("Replication between Machines", () => {
  it("is off until switched on, and a single Machine works as before", async () => {
    single = await startTestService();
    expect((await single.get("/replication")).status).toBe("off");
    await single.post("/memory/save", { items: [{ action: "create", type: "note", title: "Local only", facts: [{ subject: "Fact", value: "kept here" }] }] });
    expect(existsSync(join(single.dataDir, ".git"))).toBe(false);
  });

  it("sets up on the first Machine and joins from a second, which builds its search index", async () => {
    world = await startMachines(["Mac"]);
    const [mac] = world.machines as [TestMachine];
    await saveProject(mac, "Orion migration", "Cutover planned for October");
    await mac.clock.advance(AFTER_WRITE);
    expect(existsSync(join(mac.dataDir, ".git"))).toBe(true);
    expect(world.remote.git("ls-tree", "-r", "--name-only", "main")).toContain("memory/projects/orion-migration.md");
    expect((await mac.get("/replication")).status).toBe("up_to_date");

    const pc = await world.addMachine("PC");
    expect(readFileSync(join(pc.dataDir, "memory/projects/orion-migration.md"), "utf8")).toContain("Cutover planned for October");
    expect(await hits(pc, "Orion cutover")).toContain("memory/projects/orion-migration.md");
    expect((await pc.get("/replication")).status).toBe("up_to_date");
  });

  it("makes a save on one Machine searchable on the other after the next check", async () => {
    world = await startMachines(["Mac", "PC"]);
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    await saveProject(mac, "Quokka rollout", "Starts in March");
    // Pushed 30 seconds after the last write, not before.
    await mac.clock.advance(AFTER_WRITE - 1_000);
    expect(world.remote.git("ls-tree", "-r", "--name-only", "main")).not.toContain("memory/projects/quokka-rollout.md");
    await mac.clock.advance(1_000);
    expect(world.remote.git("ls-tree", "-r", "--name-only", "main")).toContain("memory/projects/quokka-rollout.md");

    expect(await hits(pc, "quokka")).toEqual([]);
    await pc.clock.advance(CHECK);
    expect(await hits(pc, "quokka")).toContain("memory/projects/quokka-rollout.md");
  });

  it("commits with a message that names what changed and the Machine", async () => {
    world = await startMachines(["Mac", "PC"]);
    const [mac] = world.machines as [TestMachine, TestMachine];
    await saveProject(mac, "Orion migration", "Cutover planned for October");
    await mac.post("/memory/save", { items: [{ action: "update", path: "memory/projects/orion-migration.md", facts: [{ subject: "Status", value: "Cutover moved to November", reason: "vendor delay" }], events: ["Vendor slipped the cutover"] }] });
    await mac.clock.advance(AFTER_WRITE);
    const message = world.remote.git("log", "-1", "--format=%an%n%B", "main");
    expect(message.split("\n")[0]).toBe("Mac");
    expect(message).toContain("Mac: ");
    expect(message).toContain("memory/projects/orion-migration.md");
    expect(message).toContain('created "Orion migration"');
    expect(message).toContain("corrected Status");
    expect(message).toContain("added an event");
    expect(message).toMatch(/Jarvis-Machine: Mac \([0-9a-f-]{36}\)/);
  });

  it("replicates a hand edit to a note, with the edit named in history", async () => {
    world = await startMachines(["Mac", "PC"]);
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    writeFileSync(join(mac.dataDir, "memory/notes/wombat.md"), "# Wombat plan\n\nThe wombat census runs in May.\n");
    await mac.clock.advance(CHECK);
    expect(world.remote.git("log", "-1", "--format=%B", "main")).toContain("memory/notes/wombat.md: added");
    await pc.clock.advance(CHECK);
    expect(await hits(pc, "wombat census")).toContain("memory/notes/wombat.md");

    writeFileSync(join(pc.dataDir, "memory/notes/wombat.md"), "# Wombat plan\n\nThe wombat census moved to June.\n");
    await pc.clock.advance(CHECK);
    await mac.clock.advance(CHECK);
    expect(readFileSync(join(mac.dataDir, "memory/notes/wombat.md"), "utf8")).toContain("moved to June");
    expect(world.remote.git("log", "-1", "--format=%B", "main")).toMatch(/^PC: edited in memory\/notes\/wombat.md/);
  });

  it("keeps saving offline, reads offline, and catches up when the remote is back", async () => {
    world = await startMachines(["Mac", "PC"]);
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    world.remote.goOffline();
    // A failing Replication never fails a save.
    await saveProject(mac, "Platypus survey", "Field work in April");
    await mac.clock.advance(AFTER_WRITE);
    const offline = await mac.get("/replication");
    expect(offline.status).toBe("offline");
    expect(offline.cause).toBeTruthy();
    await saveProject(mac, "Echidna survey", "Field work in May");
    expect(await hits(mac, "Echidna")).toContain("memory/projects/echidna-survey.md");
    await saveProject(pc, "Numbat survey", "Field work in June");
    await pc.clock.advance(AFTER_WRITE);
    expect((await pc.get("/replication")).status).toBe("offline");

    world.remote.goOnline();
    await mac.clock.advance(CHECK);
    await pc.clock.advance(CHECK);
    await mac.clock.advance(CHECK);
    for (const m of [mac, pc]) {
      expect((await m.get("/replication")).status).toBe("up_to_date");
      for (const q of ["Platypus", "Echidna", "Numbat"]) expect(await hits(m, `${q} survey`)).toHaveLength(1);
    }
  });

  it("never rebases or force-pushes: every commit a Machine made stays in the shared history", async () => {
    world = await startMachines(["Mac", "PC"]);
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    world.remote.goOffline();
    await saveProject(mac, "Mac only", "Written on the Mac");
    await saveProject(pc, "PC only", "Written on the PC");
    await mac.clock.advance(AFTER_WRITE);
    await pc.clock.advance(AFTER_WRITE);
    const local = (m: TestMachine) => execFileSync("git", ["-C", m.dataDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const madeOffline = [local(mac), local(pc)];
    world.remote.goOnline();
    // The remote refuses anything but a fast-forward (see createRemote), so both pushes are merges.
    await mac.clock.advance(CHECK);
    await pc.clock.advance(CHECK);
    for (const sha of madeOffline) expect(() => world!.remote.git("merge-base", "--is-ancestor", sha, "main")).not.toThrow();
    expect(world.remote.git("log", "-1", "--format=%P", "main").split(" ")).toHaveLength(2);
    expect((await pc.get("/replication")).status).toBe("up_to_date");
  });

  it("never leaves conflict markers: a file both Machines changed with no merge rule blocks Replication until fixed", async () => {
    world = await startMachines(["Mac", "PC"]);
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    writeFileSync(join(mac.dataDir, "plan.txt"), "base\n");
    await mac.clock.advance(CHECK);
    await pc.clock.advance(CHECK);
    writeFileSync(join(mac.dataDir, "plan.txt"), "from the Mac\n");
    writeFileSync(join(pc.dataDir, "plan.txt"), "from the PC\n");
    await mac.clock.advance(CHECK);
    await pc.clock.advance(CHECK);
    const blocked = await pc.get("/replication");
    expect(blocked.status).toBe("blocked");
    expect(blocked.cause).toContain("plan.txt");
    expect(readFileSync(join(pc.dataDir, "plan.txt"), "utf8")).toBe("from the PC\n");
    expect(existsSync(join(pc.dataDir, ".git", "MERGE_HEAD"))).toBe(false);
    // A save still works while blocked.
    await saveProject(pc, "Still saving", "Yes");

    writeFileSync(join(pc.dataDir, "plan.txt"), "from the Mac\n");
    await pc.clock.advance(CHECK);
    expect((await pc.get("/replication")).status).toBe("up_to_date");
    await mac.clock.advance(CHECK);
    expect(await hits(mac, "Still saving")).toHaveLength(1);
  });

  it("abandons a merge a crash interrupted and merges again", async () => {
    world = await startMachines(["Mac", "PC"]);
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    await saveProject(mac, "Merged after restart", "Yes");
    await mac.clock.advance(AFTER_WRITE);
    await saveProject(pc, "Local before the crash", "Yes");
    const git = (...args: string[]) => execFileSync("git", ["-C", pc.dataDir, ...args], { encoding: "utf8", stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    git("add", "-A");
    git("commit", "-q", "-m", "local");
    git("fetch", "-q", "origin");
    git("merge", "-q", "--no-ff", "--no-commit", "origin/main");
    expect(existsSync(join(pc.dataDir, ".git", "MERGE_HEAD"))).toBe(true);

    await pc.clock.advance(CHECK);
    expect(existsSync(join(pc.dataDir, ".git", "MERGE_HEAD"))).toBe(false);
    expect((await pc.get("/replication")).status).toBe("up_to_date");
    expect(await hits(pc, "Merged after restart")).toHaveLength(1);
  });

  it("never mixes two Brains: setup refuses a repository that holds one, join refuses a folder that is not empty", async () => {
    world = await startMachines(["Mac"]);
    const other = await world.addMachine("PC", { join: false });
    const setup = await other.call("POST", "/replication/setup", { remote: world.remote.url });
    expect(setup.status).toBe(409);
    expect(setup.body.error.code).toBe("remote_has_brain");
    expect(existsSync(join(other.dataDir, ".git"))).toBe(false);

    const join_ = await other.call("POST", "/replication/join", { remote: world.remote.url, path: other.dataDir });
    expect(join_.status).toBe(409);
    expect(join_.body.error.code).toBe("not_empty");
    expect((await other.get("/replication")).status).toBe("off");
  });

  it("refuses a repository address with spaces, though a folder may have them", async () => {
    single = await startTestService();
    // Every test above replicates through folders whose paths have spaces and non-ASCII letters.
    expect(single.dataDir).toMatch(/ æøå-/);
    for (const remote of ["owner/my brain", "https://github.com/owner/my brain.git", "-uowner/brain"]) {
      const r = await single.call("POST", "/replication/setup", { remote });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("invalid_remote");
    }
    expect((await single.get("/replication")).status).toBe("off");
  });
});
