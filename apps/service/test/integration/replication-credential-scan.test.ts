import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startMachines, type TestMachine, type TestWorld } from "./machines.ts";

const CHECK = 60_000;
const AFTER_WRITE = 30_000;

// Built at run time so no scanner mistakes this file for a leak.
const GITHUB_TOKEN = ["ghp", "Q7f2Lk9Xw3Rt8Vb1Nm4Pz6Hc0Jd5Gs2Ya8Ue"].join("_");

let world: TestWorld | null = null;

afterEach(async () => {
  await world?.stop();
  world = null;
});

const pushedFiles = (w: TestWorld) => w.remote.git("ls-tree", "-r", "--name-only", "main").split("\n");

const saveProject = (m: TestMachine, title: string, status: string) =>
  m.post("/memory/save", { confirmed: true, items: [{ action: "create", type: "project", title, facts: [{ subject: "Status", value: status }] }] });

describe("Credential scan before every commit", () => {
  it("does not commit or push a note holding a token, and the status names the file and line without the secret", async () => {
    world = await startMachines(["Mac"]);
    const [mac] = world.machines as [TestMachine];
    writeFileSync(join(mac.dataDir, "memory/notes/deploy.md"), `# Deploy\n\nThe deploy runs nightly.\nToken: ${GITHUB_TOKEN}\n`);
    await mac.clock.advance(CHECK);

    expect(pushedFiles(world)).not.toContain("memory/notes/deploy.md");
    expect(world.remote.git("log", "--all", "-p")).not.toContain(GITHUB_TOKEN);
    const status = await mac.get("/replication");
    expect(status.status).toBe("blocked");
    expect(status.cause).toContain("memory/notes/deploy.md");
    expect(status.cause).toContain("line 4");
    expect(status.cause).not.toContain(GITHUB_TOKEN);
  });

  it("refuses to set Replication up while the Brain holds a credential, and pushes nothing", async () => {
    world = await startMachines([]);
    const mac = await world.addMachine("Mac", { join: false });
    writeFileSync(join(mac.dataDir, "memory/notes/keys.md"), `# Keys\n\n${GITHUB_TOKEN}\n`);
    const r = await mac.call("POST", "/replication/setup", { remote: world.remote.url });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("commit_refused");
    expect(r.body.error.message).toContain("memory/notes/keys.md line 3");
    expect(r.body.error.message).not.toContain(GITHUB_TOKEN);
    expect(world.remote.git("rev-list", "--all")).toBe("");
    expect((await mac.get("/replication")).status).toBe("off");
  });

  it("raises one inbox item that names the evidence file and line without showing the secret", async () => {
    world = await startMachines(["Mac"]);
    const [mac] = world.machines as [TestMachine];
    writeFileSync(join(mac.dataDir, "evidence/captures/standup.md"), `# Standup\n\nKey for the build: ${GITHUB_TOKEN}\n`);
    await mac.clock.advance(CHECK);
    await mac.clock.advance(CHECK);

    const inbox = await mac.get("/attention");
    expect(JSON.stringify(inbox)).not.toContain(GITHUB_TOKEN);
    const items = (inbox.items as Array<{ sourceKind: string; title: string; summary: string }>).filter((i) => i.sourceKind === "replication");
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe("Replication is blocked");
    expect(items[0]!.summary).toContain("evidence/captures/standup.md line 3");
  });

  it("continues by itself once the credential is removed, and resolves the inbox item", async () => {
    world = await startMachines(["Mac", "PC"]);
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    await mac.post("/memory/save", { confirmed: true, items: [{ action: "create", type: "project", title: "Kestrel deploy", facts: [{ subject: "Token", value: GITHUB_TOKEN }] }] });
    await mac.clock.advance(AFTER_WRITE);
    expect((await mac.get("/replication")).status).toBe("blocked");
    expect(pushedFiles(world)).not.toContain("memory/projects/kestrel-deploy.md");

    await mac.post("/memory/save", { confirmed: true, items: [{ action: "update", path: "memory/projects/kestrel-deploy.md", facts: [{ subject: "Token", value: "kept in the password manager", reason: "never store tokens in notes" }] }] });
    // The correction moves the old value to History, so the note still holds the token: remove it by hand.
    const file = join(mac.dataDir, "memory/projects/kestrel-deploy.md");
    writeFileSync(file, readFileSync(file, "utf8").split(GITHUB_TOKEN).join("(removed)"));
    await mac.clock.advance(CHECK);

    expect((await mac.get("/replication")).status).toBe("up_to_date");
    expect(pushedFiles(world)).toContain("memory/projects/kestrel-deploy.md");
    expect(world.remote.git("log", "--all", "-p")).not.toContain(GITHUB_TOKEN);
    expect((await mac.get("/attention")).items.filter((i: { sourceKind: string }) => i.sourceKind === "replication")).toEqual([]);
    await pc.clock.advance(CHECK);
    expect(readFileSync(join(pc.dataDir, "memory/projects/kestrel-deploy.md"), "utf8")).toContain("kept in the password manager");
  });

  it("keeps everything already committed replicated while one Machine is blocked", async () => {
    world = await startMachines(["Mac", "PC"]);
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    await saveProject(mac, "Heron survey", "Counts in April");
    await mac.clock.advance(AFTER_WRITE);
    writeFileSync(join(mac.dataDir, "memory/notes/leak.md"), `# Leak\n\n${GITHUB_TOKEN}\n`);
    await mac.clock.advance(CHECK);
    expect((await mac.get("/replication")).status).toBe("blocked");

    // What the Mac pushed before stays on the remote and on the PC, and the PC keeps replicating.
    await pc.clock.advance(CHECK);
    expect(readFileSync(join(pc.dataDir, "memory/projects/heron-survey.md"), "utf8")).toContain("Counts in April");
    await saveProject(pc, "Egret survey", "Counts in May");
    await pc.clock.advance(AFTER_WRITE);
    expect((await pc.get("/replication")).status).toBe("up_to_date");
    expect(pushedFiles(world)).toEqual(expect.arrayContaining(["memory/projects/heron-survey.md", "memory/projects/egret-survey.md"]));
    expect(pushedFiles(world)).not.toContain("memory/notes/leak.md");

    rmSync(join(mac.dataDir, "memory/notes/leak.md"));
    await mac.clock.advance(CHECK);
    expect((await mac.get("/replication")).status).toBe("up_to_date");
    expect(existsSync(join(mac.dataDir, "memory/projects/egret-survey.md"))).toBe(true);
  });

  it("does not hold back later edits to a file whose credential is in history already", async () => {
    world = await startMachines(["Mac", "PC"]);
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    // Committed before the scan existed, e.g. by hand: it is in the shared history already.
    const file = join(mac.dataDir, "memory/notes/old-runbook.md");
    writeFileSync(file, `# Old runbook\n\nToken: ${GITHUB_TOKEN}\n`);
    const git = (...args: string[]) => execFileSync("git", ["-C", mac.dataDir, ...args], { encoding: "utf8", stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    git("add", "-A");
    git("commit", "-q", "--no-verify", "-m", "runbook from before the scan");
    git("push", "-q", "origin", "HEAD:main");

    writeFileSync(file, `# Old runbook\n\nToken: ${GITHUB_TOKEN}\nRotate it every quarter.\n`);
    await mac.clock.advance(CHECK);
    expect((await mac.get("/replication")).status).toBe("up_to_date");
    await pc.clock.advance(CHECK);
    expect(readFileSync(join(pc.dataDir, "memory/notes/old-runbook.md"), "utf8")).toContain("Rotate it every quarter.");

    // A new credential in the same file is still refused.
    const second = ["ghp", "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo8Nn"].join("_");
    writeFileSync(file, `# Old runbook\n\nToken: ${GITHUB_TOKEN}\nRotate it every quarter.\nNew: ${second}\n`);
    await mac.clock.advance(CHECK);
    const status = await mac.get("/replication");
    expect(status.status).toBe("blocked");
    expect(status.cause).toContain("memory/notes/old-runbook.md line 5");
  });
});
