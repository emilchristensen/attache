import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { MACHINE_NAME_MAX, type MachineRename, type MachineView } from "@jarvis/contracts";
import { type Db, nowIso } from "./db.ts";

export type MachineIdentity = Readonly<MachineView>;

/** A hostname without its domain, e.g. `adas-mac` for `adas-mac.local`. */
export function defaultMachineName(host = hostname()): string {
  const name = (host.split(".")[0] ?? "").replace(/\p{Cc}/gu, "").trim().slice(0, MACHINE_NAME_MAX);
  return name || "This Machine";
}

/**
 * This Machine's id and name, kept in local state. The id is made once and
 * never changes; the name starts as the hostname and the owner can change it.
 */
export class MachineStore {
  private readonly db: Db;
  private cache: MachineIdentity | null = null;

  constructor(db: Db) {
    this.db = db;
  }

  get(): MachineIdentity {
    if (this.cache) return this.cache;
    const now = nowIso();
    this.db.prepare("insert into machine (id, machine_id, name, created_at, updated_at) values (1, ?, ?, ?, ?) on conflict(id) do nothing").run(randomUUID(), defaultMachineName(), now, now);
    const row = this.db.prepare("select machine_id as id, name from machine where id = 1").get() as { id: string; name: string };
    this.cache = Object.freeze({ id: row.id, name: row.name });
    return this.cache;
  }

  /** `input` is validated at the API boundary (`MachineRename`). */
  rename({ name }: MachineRename): MachineIdentity {
    const id = this.get().id;
    this.db.prepare("update machine set name = ?, updated_at = ? where id = 1").run(name, nowIso());
    this.cache = Object.freeze({ id, name });
    return this.cache;
  }
}
