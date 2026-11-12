import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { replaceWith } from "../platform/replace-file.ts";

/**
 * The hand-off between agent hooks and the service. A hook copies the
 * session's transcript into the spool and writes a small record next to it;
 * the service ingests the spool whenever it runs, so a session is saved even
 * when the service was stopped. Imported by the hook script: no heavy deps.
 */
/** `turn-end` is for agents without a session-end event: it fires after every turn. */
export type HookEvent = "session-start" | "pre-compact" | "session-end" | "turn-end";
export const CAPTURE_EVENTS: HookEvent[] = ["pre-compact", "session-end", "turn-end"];

export interface SpoolRecord {
  v: 1;
  id: string;
  agent: string;
  event: HookEvent;
  sessionId: string;
  cwd: string | null;
  /** Where the agent keeps the transcript. */
  sourcePath: string | null;
  /** File name of the copy inside the spool, or null when there was nothing to copy. */
  copy: string | null;
  at: string;
  error?: string;
  /**
   * True when the Harness named a transcript that does not exist. It writes
   * one once a conversation starts, so a session-end or compaction without one
   * had no conversation, unless Jarvis saved part of it before it went.
   */
  absent?: true;
}

export const agentsDir = (stateDir: string) => join(stateDir, "agents");
export const spoolDir = (stateDir: string) => join(agentsDir(stateDir), "spool");
export const contextFile = (stateDir: string) => join(agentsDir(stateDir), "session-context.md");

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || "unknown";

/** Copy the transcript and write the record last, so a record always has its complete copy. */
export function spoolCapture(stateDir: string, input: Omit<SpoolRecord, "v" | "id" | "copy" | "at" | "error" | "absent">): SpoolRecord {
  const dir = spoolDir(stateDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${safe(input.agent)}-${safe(input.sessionId)}-${randomUUID().slice(0, 8)}`;
  let copy: string | null = null;
  let error: string | undefined;
  const found = input.sourcePath && existsSync(input.sourcePath) && statSync(input.sourcePath).isFile() ? input.sourcePath : null;
  if (found) {
    copy = `${id}.transcript`;
    try {
      // A copy-on-write clone where the filesystem supports it, so even large transcripts are instant.
      copyFileSync(found, join(dir, copy), constants.COPYFILE_FICLONE);
    } catch (e) {
      copy = null;
      error = `Could not copy the transcript: ${(e as Error).message}`;
    }
  } else error = input.sourcePath ? `Transcript not found at ${input.sourcePath}` : "The agent did not say where the transcript is";
  const absent = !!input.sourcePath && !found;
  const record: SpoolRecord = { v: 1, id, ...input, copy, at: new Date().toISOString(), ...(error ? { error } : {}), ...(absent ? { absent: true } : {}) };
  const tmp = join(dir, `.${id}.tmp`);
  writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  replaceWith(tmp, join(dir, `${id}.json`));
  return record;
}

/** Complete records, oldest first. */
export function listSpool(stateDir: string): SpoolRecord[] {
  const dir = spoolDir(stateDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("."))
    .sort()
    .flatMap((f) => {
      try {
        const r = JSON.parse(readFileSync(join(dir, f), "utf8")) as SpoolRecord;
        return r?.v === 1 && typeof r.id === "string" ? [r] : [];
      } catch {
        return [];
      }
    });
}

export function spoolCopyPath(stateDir: string, r: SpoolRecord): string | null {
  return r.copy ? join(spoolDir(stateDir), r.copy) : null;
}

export function removeSpool(stateDir: string, r: SpoolRecord) {
  if (r.copy) rmSync(join(spoolDir(stateDir), r.copy), { force: true });
  rmSync(join(spoolDir(stateDir), `${r.id}.json`), { force: true });
}
