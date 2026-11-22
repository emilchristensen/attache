import { expect } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ConnectionKind, HarnessCapabilities } from "@attache/contracts";
import type { TestService } from "./harness.ts";

/**
 * The whole Harness Connection contract (ADR 0006) against a real executable, shared by the
 * real-executable smoke tests: detect, preview, apply, current status, refresh of a stale entry,
 * the executable loading the refreshed entries, and uninstall. Each smoke runs it on its own
 * Harness, so a failure withdraws only that Harness's support claim.
 */

interface Change {
  path: string;
  change: "create" | "update" | "remove";
  backup: boolean;
}

interface Preview {
  changes: Change[];
  restartRequired: boolean;
  capabilities: HarnessCapabilities;
}

interface Row {
  kind: string;
  status: string;
  harness?: { state: string; files: string[] };
}

export interface HarnessContract {
  kind: ConnectionKind;
  /** The command name Attache looks for in the owner's tool folders. */
  command: string;
  /** The real executable under test. */
  executable: string;
  /** What the Connection claims; the preview must say exactly this. */
  capabilities: HarnessCapabilities;
  /** Settings that make detection trivially true (such as `PI_CODING_AGENT_DIR`), unset while detection is checked. */
  detectionEnv?: string[];
  /** Asserts that the real executable loads Attache's current entries. */
  loaded: () => Promise<void>;
}

const row = async (svc: TestService, kind: string) => (await svc.get<Row[]>("/connections")).find((r) => r.kind === kind);

/**
 * Run the contract on a Harness that is not connected (its smoke has already disconnected it), and
 * leave it disconnected again.
 */
export async function checkHarnessContract(svc: TestService, c: HarnessContract): Promise<void> {
  // Detect: the real executable in the owner's first tool folder is found. Detection only reads
  // the file system, so it is checked at the adapter boundary, the way setup and the Connection test use it.
  const home = process.env.ATTACHE_AGENT_HOME!;
  const link = join(home, ".local", "bin", c.command);
  const saved = Object.fromEntries((c.detectionEnv ?? []).map((k) => [k, process.env[k]]));
  mkdirSync(dirname(link), { recursive: true });
  const linked = !existsSync(link);
  if (linked) symlinkSync(c.executable, link);
  try {
    for (const k of Object.keys(saved)) delete process.env[k];
    expect(svc.app.connections.adapter(c.kind).harness!.detect(home), `${c.kind} found at ${link}`).toBe(true);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
    if (linked) rmSync(link);
  }

  // Preview: the claimed capabilities and restart, and every file it names, written by nobody yet.
  const preview = await svc.get<Preview>(`/connections/${c.kind}/harness-preview`);
  expect(preview.capabilities).toEqual(c.capabilities);
  expect(preview.restartRequired).toBe(true);
  expect(preview.changes.length).toBeGreaterThan(0);
  for (const ch of preview.changes) {
    expect(ch.change === "create" ? !existsSync(ch.path) : existsSync(ch.path), `${ch.change} ${ch.path}`).toBe(true);
    if (ch.change === "update") expect(ch.backup).toBe(true);
  }

  // Apply: connecting makes every previewed file, and the Connection reports current.
  const applied = await svc.post<{ test: { ok: boolean } }>(`/connections/${c.kind}/configure`, { method: "mcp", fields: {} });
  expect(applied.test.ok).toBe(true);
  expect((await row(svc, c.kind))?.harness?.state).toBe("current");
  for (const ch of preview.changes) expect(existsSync(ch.path), ch.path).toBe(true);
  expect((await svc.get<Preview>(`/connections/${c.kind}/harness-preview`)).changes).toEqual([]);

  // Refresh: an Attache file left out of date is reported stale, and connecting again repairs it with a backup.
  const owned = preview.changes.filter((ch) => ch.change === "create").at(-1)!.path;
  const current = readFileSync(owned, "utf8");
  writeFileSync(owned, `${current}\n`);
  expect((await row(svc, c.kind))?.harness?.state).toBe("stale");
  const backups = readdirSync(svc.app.paths.backupsDir).length;
  const refreshed = await svc.post<{ test: { ok: boolean } }>(`/connections/${c.kind}/configure`, { method: "mcp", fields: {} });
  expect(refreshed.test.ok).toBe(true);
  expect(readFileSync(owned, "utf8")).toBe(current);
  expect((await row(svc, c.kind))?.harness?.state).toBe("current");
  expect(readdirSync(svc.app.paths.backupsDir).length).toBeGreaterThan(backups);

  // The real executable loads the refreshed entries.
  await c.loaded();

  // Uninstall: every file Attache created is gone, nothing is left behind, and connecting would create them again.
  const d = await svc.post<{ harness: { failures: string[] } }>(`/connections/${c.kind}/disconnect`, { deleteData: false });
  expect(d.harness.failures).toEqual([]);
  for (const ch of preview.changes) if (ch.change === "create") expect(existsSync(ch.path), ch.path).toBe(false);
  expect((await svc.get<Preview>(`/connections/${c.kind}/harness-preview`)).changes.map((ch) => [ch.path, ch.change])).toEqual(preview.changes.map((ch) => [ch.path, ch.change]));
}
