import { describe, expect, it } from "vitest";
import { locationsForHome } from "../src/platform/locations.ts";
import { commandWrappers } from "../src/platform/wrapper.ts";

// cmd.exe reads a batch file in the console's code page (850, 437, 1252...), not UTF-8,
// so a wrapper must be plain ASCII to mean the same on every Windows computer.
const ASCII = /^[\x20-\x7e\r\n]*$/;
const HOME = "C:\\Users\\Søren Ærø";
const PREFIX = `${HOME}\\AppData\\Local\\Attache`;
const loc = locationsForHome(HOME, "windows", {});

describe("the Windows command wrappers", () => {
  it("are plain ASCII and find the install from their own folder, so an owner named Søren Ærø gets working commands", () => {
    const files = commandWrappers(loc, { installPrefix: PREFIX, stateDir: `${PREFIX}\\state`, instance: "default", port: 7427 });
    expect(files.map((f) => f.path)).toEqual([`${PREFIX}\\bin\\attache.cmd`, `${PREFIX}\\bin\\attache-uninstall.cmd`]);
    for (const f of files) {
      expect(f.text).toMatch(ASCII);
      expect(f.text).not.toContain("Søren");
    }
    const [attache, uninstall] = files.map((f) => f.text.split("\r\n"));
    expect(attache).toContain('if not defined ATTACHE_STATE_DIR for %%p in ("%~dp0..\\state") do set "ATTACHE_STATE_DIR=%%~fp"');
    expect(attache).toContain('"%~dp0..\\current\\bin\\attache.cmd" %*');
    expect(uninstall).toContain(
      '(goto) 2>nul & "%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\\current\\uninstall.ps1" --prefix "%~dp0.." --state-dir "%~dp0..\\state" --instance default %*',
    );
  });

  it("go into the bin folder of the install they belong to, wherever it is", () => {
    const files = commandWrappers(loc, { installPrefix: "D:\\Tools\\Attache", stateDir: "D:\\Tools\\Attache\\state", instance: "work", port: 7500 });
    expect(files.map((f) => f.path)).toEqual(["D:\\Tools\\Attache\\bin\\attache.cmd", "D:\\Tools\\Attache\\bin\\attache-uninstall.cmd"]);
    expect(files[0]!.text).toContain('if not defined ATTACHE_INSTANCE set "ATTACHE_INSTANCE=work"');
    expect(files[0]!.text).toContain('if not defined ATTACHE_PORT set "ATTACHE_PORT=7500"');
  });

  it("pin a state folder on another drive by its full path when that path is ASCII", () => {
    const [attache] = commandWrappers(loc, { installPrefix: PREFIX, stateDir: "E:\\Attache state", instance: "default", port: 7427 });
    expect(attache!.text).toContain('if not defined ATTACHE_STATE_DIR for %%p in ("E:\\Attache state") do set "ATTACHE_STATE_DIR=%%~fp"');
  });

  it("refuse a state folder whose letters outside ASCII cannot be reached from the install folder", () => {
    expect(() => commandWrappers(loc, { installPrefix: "D:\\Attache", stateDir: `${HOME}\\Attache state`, instance: "default", port: 7427 })).toThrow(
      "Attache cannot pin C:\\Users\\Søren Ærø\\Attache state in its Windows command wrappers: cmd.exe misreads letters outside ASCII in batch files. Keep the state folder inside the install folder, or choose a path with ASCII letters only.",
    );
  });
});
