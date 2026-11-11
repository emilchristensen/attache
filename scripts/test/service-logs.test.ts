import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { collectServiceLogs } from "../service-logs.mjs";

function write(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

const listAll = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else out.push(relative(dir, join(d, e.name)).split("\\").join("/"));
    }
  };
  walk(dir);
  return out.sort();
};

describe("collectServiceLogs", () => {
  it("copies the logs folders that test services left in Jarvis's temporary folders, and nothing else", () => {
    const tmp = mkdtempSync(join(tmpdir(), "service-logs-tmp-"));
    const out = mkdtempSync(join(tmpdir(), "service-logs-out-"));
    write(tmp, "jarvis-it-state æøå-a1/logs/service.log", "{\"msg\":\"started\"}\n");
    write(tmp, "jarvis-it-state æøå-a1/jarvis.sqlite", "not a log");
    write(tmp, "jarvis clean home æøå-b2/AppData/Local/Jarvis/state/logs/service.err.log", "Error: boom\n");
    write(tmp, "jarvis clean home æøå-b2/AppData/Local/Jarvis/state/logs/service.out.log", "listening\n");
    write(tmp, "jarvis clean home æøå-b2/Documents/Jarvis/memory/self.md", "# Me\n");
    write(tmp, "someone-else/logs/service.log", "not ours\n");

    const copied = collectServiceLogs({ tmp, out });

    expect(listAll(out)).toEqual([
      "jarvis clean home æøå-b2/AppData/Local/Jarvis/state/logs/service.err.log",
      "jarvis clean home æøå-b2/AppData/Local/Jarvis/state/logs/service.out.log",
      "jarvis-it-state æøå-a1/logs/service.log",
    ]);
    expect(readFileSync(join(out, "jarvis clean home æøå-b2/AppData/Local/Jarvis/state/logs/service.err.log"), "utf8")).toBe("Error: boom\n");
    expect(copied).toBe(3);
  });

  it("keeps only the end of a very long log", () => {
    const tmp = mkdtempSync(join(tmpdir(), "service-logs-tmp-"));
    const out = mkdtempSync(join(tmpdir(), "service-logs-out-"));
    write(tmp, "jarvis-e2e-state æøå-c3/logs/service.log", `${"x".repeat(100)}the end\n`);

    collectServiceLogs({ tmp, out, maxBytes: 8 });

    expect(readFileSync(join(out, "jarvis-e2e-state æøå-c3/logs/service.log"), "utf8")).toBe("[the first 100 bytes left out]\nthe end\n");
  });
});
