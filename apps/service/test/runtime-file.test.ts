/**
 * runtime.json tells the CLI and the tests where `jarvis serve`
 * listens, and they read it while the service is still starting. A loaded
 * machine can pause the service midway through writing it; a reader must still
 * see no file or the whole file, never an empty or half-written one.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tempDir } from "./helpers.ts";
import { childEnv, MAIN, newStateDir, runningChildren } from "./fixtures/jarvis-child.ts";

/** A URL, because `--import` reads a Windows path's drive letter as a URL scheme. */
const SLOW_RUNTIME_WRITE = pathToFileURL(join(import.meta.dirname, "fixtures/slow-runtime-write.mjs")).href;
// Starts the service from source, which is slow under load.
const SLOW = 90_000;

afterEach(() => {
  for (const c of runningChildren.splice(0)) c.kill("SIGKILL");
});

describe("runtime.json", () => {
  it(
    "is never seen half written, even when the service is paused while writing it",
    async () => {
      const stateDir = newStateDir();
      const pauses = join(tempDir("jarvis-runtime-"), "pauses.log");
      const env = childEnv({ JARVIS_CREDENTIAL_STORE: "file", JARVIS_NO_NOTIFY: "1", SLOW_RUNTIME_WRITE_MS: "500", SLOW_RUNTIME_WRITE_LOG: pauses });
      const child = spawn(process.execPath, ["--import", SLOW_RUNTIME_WRITE, MAIN, "serve", "--state-dir", stateDir, "--port", "0"], { env, stdio: "ignore" });
      runningChildren.push(child);

      const file = join(stateDir, "runtime.json");
      const unreadable = new Set<string>();
      let runtime: { pid?: number; url?: string } | undefined;
      for (const deadline = Date.now() + 60_000; !runtime && Date.now() < deadline; await new Promise((r) => setTimeout(r, 5))) {
        if (!existsSync(file)) continue;
        const text = readFileSync(file, "utf8");
        try {
          runtime = JSON.parse(text);
        } catch {
          // What the reader saw instead of the whole file is the failure; the assertion below shows it.
          unreadable.add(text);
        }
      }

      expect([...unreadable]).toEqual([]);
      expect(runtime).toMatchObject({ pid: child.pid, url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/) });
      // The service really was paused mid-write, so the reader had its chance.
      expect(existsSync(pauses) && readFileSync(pauses, "utf8")).toBeTruthy();
    },
    SLOW,
  );
});
