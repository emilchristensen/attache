import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startTestService, type TestService } from "./harness.ts";
import { startMachines, type TestMachine, type TestWorld } from "./machines.ts";

const CHECK = 60_000;
const AFTER_WRITE = 30_000;
const NOTE = "memory/projects/atlas-rollout.md";

let world: TestWorld | null = null;
let single: TestService | null = null;

afterEach(async () => {
  await world?.stop();
  await single?.stop();
  world = null;
  single = null;
});

const read = (m: TestService, rel: string) => readFileSync(join(m.dataDir, rel), "utf8");
const pending = async (m: TestService) => (await m.get("/memory/proposals")).proposals as Array<Record<string, any>>;
const withStatus = async (m: TestService, status: string) => (await m.get(`/memory/proposals?status=${status}`)).proposals as Array<Record<string, any>>;

async function seedNote(m: TestService) {
  await m.post("/memory/save", { confirmed: true, items: [{ action: "create", type: "project", title: "Atlas rollout", facts: [{ subject: "Status", value: "Pilot in Copenhagen" }] }] });
}

function propose(m: TestService, value: string) {
  return m.post("/memory/proposals", { item: { action: "update", path: NOTE, facts: [{ subject: "Status", value, reason: "seen in standup" }] }, reason: "Mentioned in standup" });
}

/** Push what `from` wrote, then let `to` pick it up. */
async function replicate(from: TestMachine, to: TestMachine) {
  await from.clock.advance(AFTER_WRITE);
  await to.clock.advance(CHECK);
}

/** Two Machines sharing a Brain that holds the Atlas note, already on both. */
async function twoMachines(): Promise<[TestMachine, TestMachine]> {
  world = await startMachines(["Mac", "PC"]);
  const [mac, pc] = world.machines as [TestMachine, TestMachine];
  await seedNote(mac);
  await replicate(mac, pc);
  return [mac, pc];
}

describe("Proposals replicate", () => {
  it("shows a Proposal made on one Machine in the Dashboard of another, naming where it was made", async () => {
    const [mac, pc] = await twoMachines();
    const made = await propose(mac, "Rolled out to Aarhus");
    expect(await pending(pc)).toEqual([]);

    await replicate(mac, pc);
    const onPc = await pending(pc);
    expect(onPc.map((p) => p.id)).toEqual([made.id]);
    expect(onPc[0]).toMatchObject({ status: "proposed", target: NOTE, reason: "Mentioned in standup", proposedOn: "Mac", item: { action: "update", path: NOTE } });
    expect(world!.remote.git("ls-tree", "-r", "--name-only", "main").split("\n").filter((p) => p.startsWith("review/proposals/"))).toHaveLength(1);
  });

  it("applies an approval once, on the Machine where it was approved, and takes it off the list on all", async () => {
    const [mac, pc] = await twoMachines();
    const made = await propose(mac, "Rolled out to Aarhus");
    await replicate(mac, pc);

    const applied = await pc.post(`/memory/proposals/${made.id}/apply`);
    expect(applied).toMatchObject({ status: "applied", decidedOn: "PC" });
    expect(await pending(pc)).toEqual([]);

    await replicate(pc, mac);
    expect(await pending(mac)).toEqual([]);
    expect((await withStatus(mac, "applied")).map((p) => [p.id, p.decidedOn])).toEqual([[made.id, "PC"]]);
    const note = read(mac, NOTE);
    expect(note).toContain("Rolled out to Aarhus");
    expect(note.match(/was "Pilot in Copenhagen"/g)).toHaveLength(1);
    expect(read(pc, NOTE)).toBe(note);

    const again = await mac.call("POST", `/memory/proposals/${made.id}/apply`);
    expect(again.status).toBe(409);
    await replicate(mac, pc);
    expect(read(pc, NOTE).match(/Rolled out to Aarhus/g)).toHaveLength(1);
  });

  it("resolves an approval and a later rejection made apart to the rejection on both, undoing the approval", async () => {
    const [mac, pc] = await twoMachines();
    const made = await propose(mac, "Rolled out to Aarhus");
    await replicate(mac, pc);

    world!.remote.goOffline();
    await mac.post(`/memory/proposals/${made.id}/apply`);
    expect(read(mac, NOTE)).toContain("Rolled out to Aarhus");
    await pc.clock.advance(10 * 60_000);
    await pc.post(`/memory/proposals/${made.id}/reject`);
    world!.remote.goOnline();

    await replicate(mac, pc);
    await replicate(pc, mac);
    await replicate(mac, pc);

    for (const m of [mac, pc]) {
      expect(await pending(m)).toEqual([]);
      expect((await withStatus(m, "rejected")).map((p) => [p.id, p.decidedOn])).toEqual([[made.id, "PC"]]);
      expect(await withStatus(m, "applied")).toEqual([]);
      const current = read(m, NOTE).split("## History")[0]!;
      expect(current).toContain("Pilot in Copenhagen");
      expect(current).not.toContain("Rolled out to Aarhus");
    }
    expect(read(pc, NOTE)).toBe(read(mac, NOTE));
  });

  it("resolves a rejection and a later approval made apart to the approval on both", async () => {
    const [mac, pc] = await twoMachines();
    const made = await propose(mac, "Rolled out to Aarhus");
    await replicate(mac, pc);

    world!.remote.goOffline();
    await mac.post(`/memory/proposals/${made.id}/reject`);
    await pc.clock.advance(10 * 60_000);
    await pc.post(`/memory/proposals/${made.id}/apply`);
    world!.remote.goOnline();

    await replicate(mac, pc);
    await replicate(pc, mac);

    for (const m of [mac, pc]) {
      expect((await withStatus(m, "applied")).map((p) => [p.id, p.decidedOn])).toEqual([[made.id, "PC"]]);
      expect(await withStatus(m, "rejected")).toEqual([]);
      expect(read(m, NOTE).split("## History")[0]).toContain("Rolled out to Aarhus");
    }
  });

  it("is never indexed for recall", async () => {
    single = await startTestService();
    await seedNote(single);
    await propose(single, "Zanzibar quokka launch");
    // A Markdown file in the review area is not recall either.
    mkdirSync(join(single.dataDir, "review", "proposals"), { recursive: true });
    writeFileSync(join(single.dataDir, "review", "proposals", "stray.md"), "# Stray\n\nZanzibar quokka launch\n");
    single.app.memory.indexer.scan(single.app.memory.rootRef!);

    const hits = (await single.get(`/memory/search?q=${encodeURIComponent("Zanzibar quokka")}`)).hits as Array<{ relPath: string }>;
    expect(hits.filter((h) => h.relPath.startsWith("review/"))).toEqual([]);
    expect(existsSync(join(single.dataDir, "review", "proposals"))).toBe(true);
  });
});

describe("Proposals pending before they moved into the Brain", () => {
  /** A Proposal as an earlier version kept it in this Machine's change log. */
  function storeLegacy(stateDir: string, row: { target: string; subject: string; payload: unknown; status?: string }): string {
    const id = randomUUID();
    const db = new DatabaseSync(join(stateDir, "jarvis.sqlite"));
    try {
      db.prepare("insert into memory_changes (id, doc_rel_path, change, subject, before_value, after_value, reason, source, actor, status, created_at, decided_at) values (?,?,?,?,?,?,?,?,?,?,?,?)").run(
        id,
        row.target,
        "proposal",
        row.subject,
        null,
        JSON.stringify(row.payload),
        "Mentioned in standup",
        "slack",
        "model",
        row.status ?? "proposed",
        "2026-11-01T08:00:00.000Z",
        null,
      );
    } finally {
      db.close();
    }
    return id;
  }

  it("carries them over into the Brain, in both stored shapes, and they still apply", async () => {
    const first = await startTestService();
    await seedNote(first);
    const { stateDir, dataDir } = first;
    await first.stop();
    const oneFact = storeLegacy(stateDir, { target: NOTE, subject: "Status", payload: { value: "Rolled out to Aarhus", newDoc: null } });
    const newNote = storeLegacy(stateDir, { target: "(new person: Lars Holm)", subject: "Role", payload: { value: "Platform lead", newDoc: { type: "person", title: "Lars Holm" } } });
    const saveItem = storeLegacy(stateDir, {
      target: "(new note: Vendor terms)",
      subject: "Notice",
      payload: { item: { action: "create", type: "note", title: "Vendor terms", facts: [{ subject: "Notice", value: "90 days" }] }, source: null, origin: { agent: "claude-code", sessionId: "s-1" } },
    });

    single = await startTestService({ stateDir, dataDir });
    const listed = await pending(single);
    expect(listed.map((p) => p.id).sort()).toEqual([oneFact, newNote, saveItem].sort());
    expect(listed.find((p) => p.id === oneFact)!.item).toEqual({ action: "update", path: NOTE, facts: [{ subject: "Status", value: "Rolled out to Aarhus", reason: "Mentioned in standup" }] });
    expect(listed.find((p) => p.id === newNote)!.item).toEqual({ action: "create", type: "person", title: "Lars Holm", facts: [{ subject: "Role", value: "Platform lead" }] });
    expect(readdirSync(join(dataDir, "review", "proposals"))).toHaveLength(3);

    await single.post(`/memory/proposals/${oneFact}/apply`);
    expect(read(single, NOTE)).toMatch(/\*\*Status\*\* \(\d{4}-\d{2}-\d{2}\): Rolled out to Aarhus — source: slack/);
    expect((await single.post(`/memory/proposals/${newNote}/apply`)).target).toBe("memory/people/lars-holm.md");
    await single.post(`/memory/proposals/${saveItem}/reject`);
    expect(await pending(single)).toEqual([]);

    // Carried over once: a restart neither repeats nor loses them.
    await single.stop();
    single = await startTestService({ stateDir, dataDir });
    expect(await pending(single)).toEqual([]);
    expect((await withStatus(single, "applied")).map((p) => p.id).sort()).toEqual([oneFact, newNote].sort());
    expect(readdirSync(join(dataDir, "review", "proposals"))).toHaveLength(3);
  });

  it("still cannot change the identity record", async () => {
    const first = await startTestService();
    await first.post("/setup/identity", { name: "Alex", role: "Engineer", confirm: true });
    const { stateDir, dataDir } = first;
    await first.stop();
    const id = storeLegacy(stateDir, { target: "memory/self.md", subject: "Role", payload: { value: "CEO", newDoc: null } });

    single = await startTestService({ stateDir, dataDir });
    const before = read(single, "memory/self.md");
    expect((await single.call("POST", `/memory/proposals/${id}/apply`)).status).toBe(403);
    expect(read(single, "memory/self.md")).toBe(before);
    expect((await pending(single)).map((p) => p.id)).toEqual([id]);
  });

  it("carries them over so another Machine sees them once Replication is on", async () => {
    world = await startMachines(["Mac"]);
    const [mac] = world.machines as [TestMachine];
    await seedNote(mac);
    const { stateDir, dataDir, clock } = mac;
    await mac.stop();
    const id = storeLegacy(stateDir, { target: NOTE, subject: "Status", payload: { value: "Rolled out to Aarhus", newDoc: null } });
    const restarted = Object.assign(await startTestService({ stateDir, dataDir, clock }), { name: "Mac", clock });
    world.machines[0] = restarted;
    const pc = await world.addMachine("PC");
    await restarted.clock.advance(AFTER_WRITE);
    await pc.clock.advance(CHECK);
    expect((await pending(pc)).map((p) => p.id)).toEqual([id]);
  });
});
