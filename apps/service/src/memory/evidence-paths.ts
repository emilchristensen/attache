import type { MachineIdentity } from "../core/machine.ts";
import { slugify } from "./markdown.ts";

/**
 * Evidence that every Machine appends to is written per Machine, so that two
 * Machines never change the same file. The file name carries the Machine's
 * name for people, and the start of its id so that two Machines with the same
 * name still write apart.
 */
const SESSION_LOG_DIR = "evidence/sessions";
const SNAPSHOT_DIR = "evidence/connectors";
export const WRAP_UP_DIR = "evidence/wrap-ups";
const ID_CHARS = 8;
/** `2026-11-11.md` from before Machine identity, or `2026-11-11-<machine>.md`. */
const SESSION_LOG_FILE = /^(\d{4}-\d{2}-\d{2})(?:-[a-z0-9-]+)?\.md$/;

export function machineTag(machine: MachineIdentity): string {
  return `${slugify(machine.name).slice(0, 40)}-${machine.id.replace(/-/g, "").slice(0, ID_CHARS)}`;
}

export function sessionLogPath(date: string, machine: MachineIdentity): string {
  return `${SESSION_LOG_DIR}/${date}-${machineTag(machine)}.md`;
}

export function connectorSnapshotPath(kind: string, date: string, machine: MachineIdentity): string {
  return `${SNAPSHOT_DIR}/${slugify(kind)}/${date}-${machineTag(machine)}.md`;
}

/**
 * One wrap-up of a Harness conversation. Each is a new file, and the Machine
 * tag keeps two Machines that wrap up same-named conversations on the same
 * day from creating the same file.
 */
export function wrapUpPath(date: string, title: string, machine: MachineIdentity): string {
  return `${WRAP_UP_DIR}/${date}-${machineTag(machine)}-${slugify(title).slice(0, 60)}.md`;
}

/** The day a session-log file speaks for, or null when `file` is not one. */
export function sessionLogDate(file: string): string | null {
  return SESSION_LOG_FILE.exec(file)?.[1] ?? null;
}
