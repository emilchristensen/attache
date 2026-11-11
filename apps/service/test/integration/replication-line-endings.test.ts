import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testFolder } from "./harness.ts";
import { startMachines, type TestMachine, type TestWorld } from "./machines.ts";

const CHECK = 60_000;
const AFTER_WRITE = 30_000;

const KIWI = "memory/notes/kiwi-harvest.md";
/** A note as a Windows editor saves it: every line ends in CRLF. */
const KIWI_CRLF = ["---", "type: note", "title: Kiwi harvest", "---", "# Kiwi harvest", "", "## Current State", "- **Harvest** (2026-11-01): The kiwi harvest starts in March", "", "## History", ""].join("\r\n");

let world: TestWorld | null = null;
let ownGitConfig: string | undefined;

/**
 * Git for Windows' installer turns `core.autocrlf` on for every repository, and
 * some owners make git refuse any line-ending conversion. Every Machine's git
 * here is set up that way; the Brain must stay LF regardless.
 */
beforeAll(() => {
  ownGitConfig = process.env.GIT_CONFIG_GLOBAL;
  const file = join(testFolder("gitconfig"), "gitconfig");
  writeFileSync(file, "[core]\n\tautocrlf = true\n\tsafecrlf = true\n");
  process.env.GIT_CONFIG_GLOBAL = file;
});

afterAll(() => {
  process.env.GIT_CONFIG_GLOBAL = ownGitConfig;
});

afterEach(async () => {
  await world?.stop();
  world = null;
});

const bytes = (m: TestMachine, rel: string) => readFileSync(join(m.dataDir, rel));
const pushed = (rel: string) => world!.remote.git("cat-file", "blob", `main:${rel}`);
const state = async (m: TestMachine, rel: string) => (await m.get(`/memory/document?path=${encodeURIComponent(rel)}`)).state as Array<{ subject: string; value: string }>;

async function hits(m: TestMachine, q: string): Promise<string[]> {
  const r = await m.get(`/memory/search?q=${encodeURIComponent(q)}`);
  return [...new Set((r.hits as Array<{ relPath: string }>).map((h) => h.relPath))];
}

describe("Line endings in a replicated Brain", () => {
  it("pins the Brain to LF when it is set up", async () => {
    world = await startMachines(["PC"]);
    expect(pushed(".gitattributes")).toContain("* text=auto eol=lf");
  });

  it("pins the Brain to LF when the data folder already has attributes of its own, and keeps them", async () => {
    world = await startMachines([]);
    const pc = await world.addMachine("PC", { join: false });
    writeFileSync(join(pc.dataDir, ".gitattributes"), "*.png binary\r\n");
    await pc.post("/replication/setup", { remote: world.remote.url });
    // LF is the default; the owner's own, more specific lines come after it and still apply.
    expect(pushed(".gitattributes").split("\n")).toEqual(["* text=auto eol=lf", "*.png binary"]);
  });

  it("gives a note saved on one Machine the same bytes, LF only, on every other Machine", async () => {
    world = await startMachines(["PC", "Mac"]);
    const [pc, mac] = world.machines as [TestMachine, TestMachine];
    // A Harness on Windows may send text with CRLF line breaks.
    await pc.post("/memory/save", { confirmed: true, items: [{ action: "create", type: "note", title: "Tui count", facts: [{ subject: "Count", value: "The tui count is on Saturday" }], notes: "First line.\r\nSecond line." }] });
    await pc.clock.advance(AFTER_WRITE);
    await mac.clock.advance(CHECK);

    const rel = "memory/notes/tui-count.md";
    expect(pushed(rel)).not.toContain("\r");
    expect(bytes(pc, rel).includes("\r")).toBe(false);
    expect(bytes(mac, rel).equals(bytes(pc, rel))).toBe(true);
  });

  it("reads a note saved with CRLF line endings, replicates it as LF, and writes it back as LF", async () => {
    world = await startMachines(["PC", "Mac"]);
    const [pc, mac] = world.machines as [TestMachine, TestMachine];
    writeFileSync(join(pc.dataDir, KIWI), KIWI_CRLF);
    expect(await state(pc, KIWI)).toEqual([expect.objectContaining({ subject: "Harvest", value: "The kiwi harvest starts in March" })]);

    await pc.clock.advance(CHECK);
    expect((await pc.get("/replication")).status).toBe("up_to_date");
    expect(pushed(KIWI)).not.toContain("\r");
    await mac.clock.advance(CHECK);
    expect(readFileSync(join(mac.dataDir, KIWI), "utf8")).toBe(KIWI_CRLF.replace(/\r\n/g, "\n"));
    expect(await state(mac, KIWI)).toEqual([expect.objectContaining({ subject: "Harvest", value: "The kiwi harvest starts in March" })]);
    expect(await hits(mac, "kiwi harvest")).toContain(KIWI);

    await pc.post("/memory/save", { confirmed: true, items: [{ action: "update", path: KIWI, facts: [{ subject: "Harvest", value: "The kiwi harvest starts in April", reason: "late frost" }] }] });
    const corrected = readFileSync(join(pc.dataDir, KIWI), "utf8");
    expect(corrected).not.toContain("\r");
    expect(corrected).toContain("- **Harvest** (");
    expect(corrected).toContain('**Harvest** was "The kiwi harvest starts in March"');
    expect(await state(pc, KIWI)).toEqual([expect.objectContaining({ subject: "Harvest", value: "The kiwi harvest starts in April" })]);

    await pc.clock.advance(AFTER_WRITE);
    await mac.clock.advance(CHECK);
    expect(bytes(mac, KIWI).equals(bytes(pc, KIWI))).toBe(true);
  });
});
