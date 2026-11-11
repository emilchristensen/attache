import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { MACHINE_NAME_MAX } from "@jarvis/contracts";

/**
 * Every Machine's record, kept in the Brain so all Machines read the same:
 * `machines/<machine id>.json`, written only by that Machine, and
 * `machines/preferred-reader.json`, which any Machine may change. JSON, so
 * search never indexes them. Both replicate like any other file; when two
 * Machines changed the same one, the later `updatedAt` wins (`machineRecordRule`).
 */
export const MACHINES_DIR = "machines";
export const PREFERRED_READER_FILE = `${MACHINES_DIR}/preferred-reader.json`;

export const MachineRecord = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(MACHINE_NAME_MAX),
  standby: z.boolean(),
  updatedAt: z.iso.datetime(),
});
export type MachineRecord = z.infer<typeof MachineRecord>;

export const PreferredReaderRecord = z.object({
  machine: z.uuid().nullable(),
  updatedAt: z.iso.datetime(),
  /** The Machine the owner chose it on. */
  by: z.uuid(),
});
export type PreferredReaderRecord = z.infer<typeof PreferredReaderRecord>;

/** Both kinds of record carry `updatedAt`; this is what the merge rule compares. */
export const DatedRecord = z.object({ updatedAt: z.iso.datetime() }).loose();

export function machineRecordPath(id: string): string {
  return `${MACHINES_DIR}/${id}.json`;
}

export function isMachineRecordPath(path: string): boolean {
  return /^machines\/[^/]+\.json$/.test(path);
}

export function renderRecord(record: MachineRecord | PreferredReaderRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** Written beside the target and renamed over it, so another Machine's git never sees half a record. */
function writeAtomic(abs: string, content: string): void {
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = join(dirname(abs), `.${randomUUID()}.tmp`);
  writeFileSync(tmp, content);
  renameSync(tmp, abs);
}

function readJson(abs: string): unknown {
  try {
    return JSON.parse(readFileSync(abs, "utf8"));
  } catch {
    return undefined;
  }
}

/** The records in one copy of the Brain. A record that does not parse is left out, never repaired. */
export class MachineRecords {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  machines(): MachineRecord[] {
    const dir = join(this.root, MACHINES_DIR);
    if (!existsSync(dir)) return [];
    const out: MachineRecord[] = [];
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith(".json") || `${MACHINES_DIR}/${file}` === PREFERRED_READER_FILE) continue;
      const parsed = MachineRecord.safeParse(readJson(join(dir, file)));
      if (parsed.success && file === `${parsed.data.id}.json`) out.push(parsed.data);
    }
    return out;
  }

  machine(id: string): MachineRecord | null {
    const parsed = MachineRecord.safeParse(readJson(join(this.root, machineRecordPath(id))));
    return parsed.success && parsed.data.id === id ? parsed.data : null;
  }

  preferredReader(): string | null {
    const parsed = PreferredReaderRecord.safeParse(readJson(join(this.root, PREFERRED_READER_FILE)));
    return parsed.success ? parsed.data.machine : null;
  }

  writeMachine(record: MachineRecord): void {
    writeAtomic(join(this.root, machineRecordPath(record.id)), renderRecord(MachineRecord.parse(record)));
  }

  writePreferredReader(record: PreferredReaderRecord): void {
    writeAtomic(join(this.root, PREFERRED_READER_FILE), renderRecord(PreferredReaderRecord.parse(record)));
  }
}
