import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { startTestService, type TestService } from "./harness.ts";
import { startMachines, type TestMachine, type TestWorld } from "./machines.ts";
import { startFixtureServer, type FixtureServer } from "../fixtures/fixture-server.ts";

/**
 * A later release may add fields to a replicated file (ADR 0008). A Machine on
 * an earlier release that rewrites or merges the file keeps what it does not know.
 */

const CHECK = 60_000;
const AFTER_WRITE = 30_000;
const NOTE = "memory/projects/atlas-rollout.md";

let world: TestWorld | null = null;
let single: TestService | null = null;
let fx: FixtureServer | null = null;

afterEach(async () => {
  await world?.stop();
  await single?.stop();
  await fx?.close();
  world = null;
  single = null;
  fx = null;
});

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const pushed = (w: TestWorld, rel: string) => w.remote.git("show", `main:${rel}`);
const pushedJson = (w: TestWorld, rel: string) => JSON.parse(pushed(w, rel)) as Record<string, any>;
const pushedUnder = (w: TestWorld, dir: string) => w.remote.git("ls-tree", "-r", "--name-only", "main").split("\n").filter((p) => p.startsWith(dir));
const frontmatter = (text: string) => parseYaml(/^---\n([\s\S]*?)\n---/.exec(text)![1]!) as Record<string, unknown>;

/** Push what `from` wrote, then let `to` pick it up. */
async function replicate(from: TestMachine, to: TestMachine) {
  await from.clock.advance(AFTER_WRITE);
  await to.clock.advance(CHECK);
}

/** Edit a file in a Machine's data folder as a later release would write it; the next check sends it. */
function editJson(m: TestMachine, rel: string, change: (value: Record<string, any>) => Record<string, any>) {
  const abs = join(m.dataDir, rel);
  writeFileSync(abs, `${JSON.stringify(change(JSON.parse(readFileSync(abs, "utf8"))))}\n`);
}

function addFrontmatter(dataDir: string, rel: string, extra: string) {
  const abs = join(dataDir, rel);
  writeFileSync(abs, readFileSync(abs, "utf8").replace(/^---\n/, `---\n${extra}\n`));
}

describe("A Machine keeps fields of replicated files it does not understand", () => {
  it("in an Inbox item: through a decision made here and a merge of decisions made apart", async () => {
    world = await startMachines(["Mac", "PC"]);
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    mkdirSync(join(mac.dataDir, "memory/projects"), { recursive: true });
    writeFileSync(join(mac.dataDir, "memory/projects/launch.md"), `# Launch\n\n- [ ] Book the venue 📅 ${day(2)}\n`);
    const { job } = await mac.post("/briefings", { kind: "manual" });
    expect((await mac.waitJob(job.id)).job).toMatchObject({ status: "succeeded" });
    await replicate(mac, pc);
    const [rel] = pushedUnder(world, "review/inbox/");
    editJson(mac, rel!, (r) => ({ ...r, laterRecordField: "kept", item: { ...r.item, laterItemField: { kept: true } } }));
    await mac.clock.advance(CHECK);
    await pc.clock.advance(CHECK);

    const item = ((await pc.get("/attention")).items as Array<{ id: string; title: string }>).find((i) => i.title.includes("Book the venue"))!;
    await pc.post(`/attention/${item.id}/decision`, { decision: "dismiss" });
    await replicate(pc, mac);
    expect(pushedJson(world, rel!)).toMatchObject({ laterRecordField: "kept", item: { laterItemField: { kept: true } }, decision: { decision: "dismiss" } });

    // Decided on both while apart: the merge keeps the fields too.
    world.remote.goOffline();
    await mac.post(`/attention/${item.id}/decision`, { decision: "reopen" });
    await pc.clock.advance(60_000);
    await pc.post(`/attention/${item.id}/decision`, { decision: "snooze", until: new Date(Date.now() + 86_400_000).toISOString() });
    world.remote.goOnline();
    await replicate(mac, pc);
    await replicate(pc, mac);
    expect(pushedJson(world, rel!)).toMatchObject({ laterRecordField: "kept", item: { laterItemField: { kept: true } }, decision: { decision: "snooze" } });
  });

  it("in an Inbox item: a merge keeps the fields each side alone has, whichever report is newer", async () => {
    world = await startMachines(["Mac", "PC"]);
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    mkdirSync(join(mac.dataDir, "memory/projects"), { recursive: true });
    writeFileSync(join(mac.dataDir, "memory/projects/launch.md"), `# Launch\n\n- [ ] Book the venue 📅 ${day(2)}\n`);
    const { job } = await mac.post("/briefings", { kind: "manual" });
    expect((await mac.waitJob(job.id)).job).toMatchObject({ status: "succeeded" });
    await replicate(mac, pc);
    const [rel] = pushedUnder(world, "review/inbox/");

    // Apart, each Machine's file gains a field from a later release that the other's lacks.
    world.remote.goOffline();
    editJson(mac, rel!, (r) => ({ ...r, macRecordField: "kept", item: { ...r.item, macItemField: "kept" } }));
    editJson(pc, rel!, (r) => ({ ...r, pcRecordField: "kept", item: { ...r.item, pcItemField: "kept" } }));
    await mac.clock.advance(CHECK);
    await pc.clock.advance(CHECK);
    world.remote.goOnline();
    await replicate(mac, pc);
    await replicate(pc, mac);
    expect(pushedJson(world, rel!)).toMatchObject({ macRecordField: "kept", pcRecordField: "kept", item: { macItemField: "kept", pcItemField: "kept" } });
  });

  it("in a Proposal: through a decision made here and a merge of decisions made apart", async () => {
    world = await startMachines(["Mac", "PC"]);
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    await mac.post("/memory/save", { confirmed: true, items: [{ action: "create", type: "project", title: "Atlas rollout", facts: [{ subject: "Status", value: "Pilot in Copenhagen" }] }] });
    const made = await mac.post("/memory/proposals", { item: { action: "update", path: NOTE, facts: [{ subject: "Status", value: "Rolled out to Aarhus", reason: "seen in standup" }] }, reason: "Mentioned in standup" });
    await replicate(mac, pc);
    const [rel] = pushedUnder(world, "review/proposals/");
    editJson(mac, rel!, (r) => ({ ...r, laterRecordField: "kept" }));
    await mac.clock.advance(CHECK);
    await pc.clock.advance(CHECK);

    world.remote.goOffline();
    await mac.post(`/memory/proposals/${made.id}/apply`);
    await pc.clock.advance(10 * 60_000);
    await pc.post(`/memory/proposals/${made.id}/reject`);
    world.remote.goOnline();
    await replicate(mac, pc);
    await replicate(pc, mac);
    const merged = pushedJson(world, rel!);
    expect(merged).toMatchObject({ laterRecordField: "kept" });
    expect(merged.decisions.map((d: { decision: string }) => d.decision).sort()).toEqual(["applied", "rejected"]);
  });

  it("in a note's frontmatter: through a change made here and a merge of changes made apart", async () => {
    world = await startMachines(["Mac", "PC"]);
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    await mac.post("/memory/save", { confirmed: true, items: [{ action: "create", type: "project", title: "Atlas rollout", facts: [{ subject: "Status", value: "Pilot in Copenhagen" }] }] });
    addFrontmatter(mac.dataDir, NOTE, "later_key: kept");
    await mac.clock.advance(AFTER_WRITE + CHECK);
    await pc.clock.advance(CHECK);

    await pc.post("/memory/save", { confirmed: true, items: [{ action: "update", path: NOTE, facts: [{ subject: "Owner", value: "Ana", reason: "said so" }] }] });
    await replicate(pc, mac);
    expect(frontmatter(pushed(world, NOTE))).toMatchObject({ later_key: "kept" });

    world.remote.goOffline();
    await mac.post("/memory/save", { confirmed: true, items: [{ action: "update", path: NOTE, facts: [{ subject: "Status", value: "Rolled out to Aarhus", reason: "standup" }] }] });
    await pc.post("/memory/save", { confirmed: true, items: [{ action: "update", path: NOTE, facts: [{ subject: "Budget", value: "Approved", reason: "finance" }] }] });
    world.remote.goOnline();
    await replicate(mac, pc);
    await replicate(pc, mac);
    const merged = pushed(world, NOTE);
    expect(frontmatter(merged)).toMatchObject({ later_key: "kept" });
    expect(merged).toContain("Rolled out to Aarhus");
    expect(merged).toContain("Approved");
  });

  it("in the identity record, written again from Settings", async () => {
    single = await startTestService();
    await single.post("/setup/identity", { name: "Ana", confirm: true });
    addFrontmatter(single.dataDir, "memory/self.md", "later_key: kept");
    await single.post("/setup/identity", { name: "Ana Berg", confirm: true });
    const self = readFileSync(join(single.dataDir, "memory/self.md"), "utf8");
    expect(frontmatter(self)).toMatchObject({ title: "Ana Berg", later_key: "kept" });
  });

  it("in today's connector snapshot, written again at the next Source refresh", async () => {
    fx = await startFixtureServer();
    fx.route("GET", "/user", () => ({ json: { login: "t" } }));
    fx.route("GET", "/search/issues", () => ({ json: { incomplete_results: false, items: [] } }));
    single = await startTestService();
    await single.post("/connections/github/configure", { method: "token", fields: { token: "ghp_fixturetokenfixturetoken12345678", apiBaseUrl: fx.url } });
    await single.waitJob((await single.post("/connections/github/refresh")).job.id);
    const dir = join(single.dataDir, "evidence/connectors/github");
    const [file] = readdirSync(dir);
    addFrontmatter(single.dataDir, `evidence/connectors/github/${file}`, "later_key: kept");
    await single.waitJob((await single.post("/connections/github/refresh")).job.id);
    expect(frontmatter(readFileSync(join(dir, file!), "utf8"))).toMatchObject({ type: "connector-snapshot", later_key: "kept" });
  });
});
