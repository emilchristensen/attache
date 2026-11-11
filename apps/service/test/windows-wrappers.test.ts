import { describe, expect, it } from "vitest";
import { locationsForHome } from "../src/platform/locations.ts";
import { commandWrappers } from "../src/platform/wrapper.ts";

// cmd.exe reads a batch file in the console's code page (850, 437, 1252...), not UTF-8,
// so a wrapper must be plain ASCII to mean the same on every Windows computer.
const ASCII = /^[\x20-\x7e\r\n]*$/;
const HOME = "C:\\Users\\Søren Ærø";
const PREFIX = `${HOME}\\AppData\\Local\\Jarvis`;
const loc = locationsForHome(HOME, "windows", {});

describe("the Windows command wrappers", () => {
  it("are plain ASCII and find the install from their own folder, so an owner named Søren Ærø gets working commands", () => {
    const files = commandWrappers(loc, { installPrefix: PREFIX, stateDir: `${PREFIX}\\state`, instance: "default", port: 7427 });
    expect(files.map((f) => f.path)).toEqual([`${PREFIX}\\bin\\jarvis.cmd`, `${PREFIX}\\bin\\jarvis-uninstall.cmd`]);
    for (const f of files) {
      expect(f.text).toMatch(ASCII);
      expect(f.text).not.toContain("Søren");
    }
    const [jarvis, uninstall] = files.map((f) => f.text.split("\r\n"));
    expect(jarvis).toContain('if not defined JARVIS_STATE_DIR for %%p in ("%~dp0..\\state") do set "JARVIS_STATE_DIR=%%~fp"');
    expect(jarvis).toContain('"%~dp0..\\current\\bin\\jarvis.cmd" %*');
    expect(uninstall).toContain('for %%p in ("%~dp0..") do set "JARVIS_PREFIX=%%~fp"');
  });

  it("go into the bin folder of the install they belong to, wherever it is", () => {
    const files = commandWrappers(loc, { installPrefix: "D:\\Tools\\Jarvis", stateDir: "D:\\Tools\\Jarvis\\state", instance: "work", port: 7500 });
    expect(files.map((f) => f.path)).toEqual(["D:\\Tools\\Jarvis\\bin\\jarvis.cmd", "D:\\Tools\\Jarvis\\bin\\jarvis-uninstall.cmd"]);
    expect(files[0]!.text).toContain('if not defined JARVIS_INSTANCE set "JARVIS_INSTANCE=work"');
    expect(files[0]!.text).toContain('if not defined JARVIS_PORT set "JARVIS_PORT=7500"');
  });

  it("pin a state folder on another drive by its full path when that path is ASCII", () => {
    const [jarvis] = commandWrappers(loc, { installPrefix: PREFIX, stateDir: "E:\\Jarvis state", instance: "default", port: 7427 });
    expect(jarvis!.text).toContain('if not defined JARVIS_STATE_DIR for %%p in ("E:\\Jarvis state") do set "JARVIS_STATE_DIR=%%~fp"');
  });

  it("refuse a state folder whose letters outside ASCII cannot be reached from the install folder", () => {
    expect(() => commandWrappers(loc, { installPrefix: "D:\\Jarvis", stateDir: `${HOME}\\Jarvis state`, instance: "default", port: 7427 })).toThrow(
      "Jarvis cannot pin C:\\Users\\Søren Ærø\\Jarvis state in its Windows command wrappers: cmd.exe misreads letters outside ASCII in batch files. Keep the state folder inside the install folder, or choose a path with ASCII letters only.",
    );
  });
});
