import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startMachines, type TestMachine, type TestWorld } from "./machines.ts";

let world: TestWorld | null = null;

afterEach(async () => {
  await world?.stop();
  world = null;
});

const saveProject = (m: TestMachine, title: string, status: string) =>
  m.post("/memory/save", { items: [{ action: "create", type: "project", title, facts: [{ subject: "Status", value: status }] }] });

const git = (m: TestMachine, ...args: string[]) =>
  execFileSync("git", ["-C", m.dataDir, ...args], { encoding: "utf8", stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

async function hits(m: TestMachine, q: string): Promise<string[]> {
  const r = await m.get(`/memory/search?q=${encodeURIComponent(q)}`);
  return [...new Set((r.hits as Array<{ relPath: string }>).map((h) => h.relPath))];
}

describe("A service stopped in the middle of a merge", () => {
  it("starts again with a clean folder and completes the merge", async () => {
    world = await startMachines(["Mac", "PC"]);
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    await saveProject(mac, "Takahe count", "From the Mac");
    await mac.clock.advance(30_000);
    await saveProject(pc, "Weka count", "From the PC");
    // What a crash halfway through a merge leaves: a merge in progress and git's own lock.
    git(pc, "add", "-A");
    git(pc, "commit", "-q", "-m", "local");
    git(pc, "fetch", "-q", "origin");
    git(pc, "merge", "-q", "--no-ff", "--no-commit", "origin/main");
    writeFileSync(join(pc.dataDir, ".git", "index.lock"), "");

    const restarted = await world.restart(pc);
    await restarted.clock.advance(0);

    expect(existsSync(join(pc.dataDir, ".git", "MERGE_HEAD"))).toBe(false);
    expect(existsSync(join(pc.dataDir, ".git", "index.lock"))).toBe(false);
    expect(git(restarted, "status", "--porcelain")).toBe("");
    expect((await restarted.get("/replication")).status).toBe("up_to_date");
    const pushed = world.remote.git("ls-tree", "-r", "--name-only", "main");
    expect(pushed).toContain("memory/projects/takahe-count.md");
    expect(pushed).toContain("memory/projects/weka-count.md");
    expect(await hits(restarted, "Takahe")).toContain("memory/projects/takahe-count.md");
    expect(await hits(restarted, "Weka")).toContain("memory/projects/weka-count.md");
  });
});

describe("Deleting a note", () => {
  it("removes it from every Machine and from their search, whether deleted in Jarvis or by hand", async () => {
    world = await startMachines(["Mac", "PC"]);
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    await saveProject(mac, "Kiwi tracking", "Collars fitted");
    await saveProject(mac, "Kea survey", "Started in the alps");
    await mac.clock.advance(30_000);
    await pc.clock.advance(60_000);
    expect(await hits(pc, "Kiwi tracking")).toContain("memory/projects/kiwi-tracking.md");
    expect(await hits(pc, "Kea survey")).toContain("memory/projects/kea-survey.md");

    // Undoing the save that created a note removes the note.
    const created = ((await mac.get("/memory/recent-changes")).changes as Array<{ id: string; relPath: string; kind: string }>).find((c) => c.relPath === "memory/projects/kiwi-tracking.md" && c.kind === "create")!;
    await mac.post(`/memory/changes/${created.id}/revert`);
    // An editor deletes a file outside Jarvis.
    rmSync(join(mac.dataDir, "memory/projects/kea-survey.md"));
    await mac.clock.advance(60_000);
    await pc.clock.advance(60_000);

    for (const rel of ["memory/projects/kiwi-tracking.md", "memory/projects/kea-survey.md"]) expect(existsSync(join(pc.dataDir, rel))).toBe(false);
    expect(await hits(pc, "Kiwi tracking")).toEqual([]);
    expect(await hits(pc, "Kea survey")).toEqual([]);
    expect((await pc.get("/replication")).status).toBe("up_to_date");
  });
});

describe("A note deleted on one Machine and changed on another", () => {
  const status = (m: TestMachine, title: string, value: string) =>
    m.post("/memory/save", { items: [{ action: "update", path: `memory/projects/${title}.md`, facts: [{ subject: "Status", value, reason: "news" }] }] });
  const inbox = async (m: TestMachine) => ((await m.get("/attention")).items as Array<{ title: string; summary: string; sourceKind: string; evidence: Array<{ relPath?: string }> }>).filter((i) => i.sourceKind === "replication");

  it("is kept with the change, on both Machines, and one inbox item says so", async () => {
    world = await startMachines(["Mac", "PC"]);
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    await saveProject(mac, "Tui nesting", "Nests found");
    await saveProject(mac, "Moa bones", "Dig planned");
    await mac.clock.advance(30_000);
    await pc.clock.advance(60_000);

    // Each Machine deletes one note and changes the other, before seeing what the other did.
    rmSync(join(mac.dataDir, "memory/projects/tui-nesting.md"));
    await status(mac, "moa-bones", "Dig moved to summer");
    await mac.clock.advance(60_000);
    rmSync(join(pc.dataDir, "memory/projects/moa-bones.md"));
    await status(pc, "tui-nesting", "Chicks hatched");
    await pc.clock.advance(60_000);
    await mac.clock.advance(60_000);

    for (const m of [mac, pc]) {
      expect((await m.get("/replication")).status).toBe("up_to_date");
      expect(readFileSync(join(m.dataDir, "memory/projects/tui-nesting.md"), "utf8")).toContain("Chicks hatched");
      expect(readFileSync(join(m.dataDir, "memory/projects/moa-bones.md"), "utf8")).toContain("Dig moved to summer");
      expect(await hits(m, "Chicks hatched")).toContain("memory/projects/tui-nesting.md");
      expect(await hits(m, "Dig moved to summer")).toContain("memory/projects/moa-bones.md");
    }

    // PC made the merge, so PC raised the items: one per note, naming who deleted and who changed it.
    const items = await inbox(pc);
    expect(items).toHaveLength(2);
    const tui = items.find((i) => i.evidence[0]?.relPath === "memory/projects/tui-nesting.md")!;
    expect(tui.title).toContain("Tui nesting");
    expect(tui.summary).toMatch(/deleted on Mac/);
    expect(tui.summary).toMatch(/changed on PC/);
    const moa = items.find((i) => i.evidence[0]?.relPath === "memory/projects/moa-bones.md")!;
    expect(moa.summary).toMatch(/deleted on PC/);
    expect(moa.summary).toMatch(/changed on Mac/);

    // Later checks do not raise it again.
    await pc.clock.advance(60_000);
    expect(await inbox(pc)).toHaveLength(2);
  });
});

describe("Joining a Machine that already has a Brain", () => {
  it("is refused, and the folder is backed up and left as it was", async () => {
    world = await startMachines(["Mac"]);
    const pc = await world.addMachine("PC", { join: false });
    await saveProject(pc, "Kakapo census", "Counted in spring");
    const before = readdirSync(join(pc.dataDir, "memory/projects"));

    const r = await pc.call("POST", "/replication/join", { remote: world.remote.url, path: pc.dataDir });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("not_empty");
    const backup: string = r.body.error.details.backup;
    expect(r.body.error.message).toContain(backup);

    const listed = (await pc.get("/backups")) as Array<{ path: string }>;
    expect(listed.map((b) => b.path)).toContain(backup);
    const archived = execFileSync("tar", ["-tzf", backup], { encoding: "utf8" });
    expect(archived).toContain("data/memory/projects/kakapo-census.md");
    expect(archived).toContain("jarvis.sqlite");

    expect(readdirSync(join(pc.dataDir, "memory/projects"))).toEqual(before);
    expect(existsSync(join(pc.dataDir, ".git"))).toBe(false);
    expect((await pc.get("/replication")).status).toBe("off");
  });
});
