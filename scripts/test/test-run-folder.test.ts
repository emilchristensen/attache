import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openRunFolder } from "../test-run-folder.mjs";

/** What a test or test service does: make its own folder in the system's temporary folder. */
const MAKE_TEMP_FOLDER = `const { mkdtempSync } = require("node:fs"); const { join } = require("node:path"); process.stdout.write(mkdtempSync(join(require("node:os").tmpdir(), "attache-it-state æøå-")));`;

const exitedPid = () => spawnSync(process.execPath, ["-e", ""]).pid!;

describe("a test run's temporary folder", () => {
  it("holds every temporary folder the run's processes make, and is gone when the run ends", () => {
    const base = mkdtempSync(join(tmpdir(), "run-folder-base-"));
    const env: Record<string, string | undefined> = { ...process.env, TMPDIR: base, TMP: base, TEMP: base, CI: undefined };

    const run = openRunFolder({ base, env });
    const made = execFileSync(process.execPath, ["-e", MAKE_TEMP_FOLDER], { env, encoding: "utf8" });
    expect(made.startsWith(run.folder)).toBe(true);
    expect(existsSync(made)).toBe(true);

    run.close();

    expect(readdirSync(base)).toEqual([]);
    expect([env.TMPDIR, env.TMP, env.TEMP]).toEqual([base, base, base]);
  });

  it("removes the folders that killed runs left behind, and keeps those of runs still going", () => {
    const base = mkdtempSync(join(tmpdir(), "run-folder-base-"));
    const killed = `attache-run-${exitedPid()}-a1b2c3`;
    const going = `attache-run-${process.pid}-d4e5f6`;
    for (const name of [killed, going, "attache-it-state-g7h8i9", "someone-else"]) mkdirSync(join(base, name, "logs"), { recursive: true });

    const run = openRunFolder({ base, env: { CI: undefined } });
    run.close();

    expect(readdirSync(base).sort()).toEqual(["attache-it-state-g7h8i9", going, "someone-else"]);
  });

  it("on CI, copies the run's service logs out before removing the folder", () => {
    const base = mkdtempSync(join(tmpdir(), "run-folder-base-"));
    const logsOut = mkdtempSync(join(tmpdir(), "run-folder-logs-"));
    const env: Record<string, string | undefined> = { CI: "true" };

    const run = openRunFolder({ base, env, logsOut });
    const state = join(run.folder, "attache-it-state æøå-a1");
    mkdirSync(join(state, "logs"), { recursive: true });
    writeFileSync(join(state, "logs", "service.log"), "Error: boom\n");
    run.close();

    const [kept] = readdirSync(logsOut);
    expect(readFileSync(join(logsOut, kept, "attache-it-state æøå-a1", "logs", "service.log"), "utf8")).toBe("Error: boom\n");
    expect(readdirSync(base)).toEqual([]);
  });
});
