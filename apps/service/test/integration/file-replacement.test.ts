import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { startTestService, type TestService } from "./harness.ts";

/**
 * Notes are replaced atomically: written beside the target, then renamed over
 * it. Windows refuses that rename while another program holds the note open
 * without sharing delete access, as editors, virus scanners and the search
 * indexer do; the save must wait for it and succeed, not fail.
 */
let svc: TestService;
const NOTE = "memory/projects/orion-migration.md";

beforeAll(async () => {
  svc = await startTestService();
  await svc.post("/memory/save", { items: [{ action: "create", type: "project", title: "Orion migration", facts: [{ subject: "Status", value: "Cutover planned" }] }] });
});
afterAll(() => svc?.stop());

/** Another program holding `file` open for `ms`, sharing read and write but not delete. Resolves once it holds it. */
function holdOpen(file: string, ms: number): Promise<ChildProcess> {
  const child =
    process.platform === "win32"
      ? spawn("powershell.exe", ["-NoProfile", "-Command", `$f = [IO.File]::Open($env:HELD_FILE, 'Open', 'Read', 'ReadWrite'); 'held'; Start-Sleep -Milliseconds ${ms}; $f.Close()`], { env: { ...process.env, HELD_FILE: file } })
      : spawn(process.execPath, ["-e", `const fs = require("node:fs"); const fd = fs.openSync(process.env.HELD_FILE, "r"); console.log("held"); setTimeout(() => fs.closeSync(fd), ${ms});`], { env: { ...process.env, HELD_FILE: file } });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.stdout!.on("data", (d) => String(d).includes("held") && resolve(child));
  });
}

describe("replacing a note another program has open", () => {
  it("waits for the other program and saves, leaving no temporary file", async () => {
    const abs = join(svc.dataDir, NOTE);
    const holder = await holdOpen(abs, 1_500);
    const r = await svc.post("/memory/save", { items: [{ action: "update", path: NOTE, facts: [{ subject: "Status", value: "Cutover moved to November", reason: "vendor delay" }] }] });
    expect(r.saved).toHaveLength(1);
    expect(readFileSync(abs, "utf8")).toContain("Cutover moved to November");
    expect(readdirSync(dirname(abs)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    await new Promise((res) => (holder.exitCode !== null ? res(null) : holder.once("exit", res)));
  });
});
