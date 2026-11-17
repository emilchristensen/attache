import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "../src");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
}

/** Each call that starts a process, with the text of its argument list. */
function processStarts(text: string): string[] {
  const calls: string[] = [];
  // A method such as `regex.exec(` is not a process.
  const start = /(?<![.\w])(spawn|spawnSync|execFile|exec)\(/g;
  for (let m = start.exec(text); m; m = start.exec(text)) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")" && --depth === 0) break;
    }
    calls.push(text.slice(m.index, i + 1));
  }
  return calls;
}

/**
 * The service runs in the background without a console. On Windows, a console
 * program it starts without `windowsHide` flashes a window on the owner's
 * screen, so every process Attache starts hides it.
 */
describe("processes Attache starts", () => {
  it("hide their console window on Windows", () => {
    const shown: string[] = [];
    for (const file of sources(SRC)) {
      const text = readFileSync(file, "utf8");
      if (!/from "node:child_process"/.test(text)) continue;
      for (const call of processStarts(text)) if (!/windowsHide: true/.test(call)) shown.push(`${relative(SRC, file)}: ${call.split("\n")[0]!.slice(0, 120)}`);
    }
    expect(shown).toEqual([]);
  });
});
