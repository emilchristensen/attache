import { Config, FeatureId, type ConfigPatch } from "@attache/contracts";
import { type Db, nowIso } from "./db.ts";

/** Configuration persisted in the service database, with a revision counter for optimistic updates. */
export class ConfigStore {
  private readonly db: Db;
  private cache: Config | null = null;

  constructor(db: Db) {
    this.db = db;
  }

  get(): Config {
    if (this.cache) return this.cache;
    const row = this.db.prepare("select json from config where id = 1").get() as { json: string } | undefined;
    const parsed = Config.parse(withoutRetiredFeatures(row ? JSON.parse(row.json) : {}));
    this.cache = parsed;
    return parsed;
  }

  revision(): number {
    const row = this.db.prepare("select revision from config where id = 1").get() as { revision: number } | undefined;
    return row?.revision ?? 0;
  }

  set(next: Config): Config {
    const valid = Config.parse(next);
    this.db
      .prepare("insert into config (id, json, revision, updated_at) values (1, ?, 1, ?) on conflict(id) do update set json = excluded.json, revision = config.revision + 1, updated_at = excluded.updated_at")
      .run(JSON.stringify(valid), nowIso());
    this.cache = valid;
    return valid;
  }

  patch(p: ConfigPatch & { dataFolder?: string | null; identity?: Config["identity"] }): Config {
    const cur = this.get();
    return this.set({
      ...cur,
      ...(p.setupCompleted !== undefined ? { setupCompleted: p.setupCompleted } : {}),
      ...(p.setupStep !== undefined ? { setupStep: p.setupStep } : {}),
      ...(p.dataFolder !== undefined ? { dataFolder: p.dataFolder } : {}),
      ...(p.identity !== undefined ? { identity: p.identity } : {}),
      features: { ...cur.features, ...(p.features ?? {}) },
      schedules: { ...cur.schedules, ...(p.schedules ?? {}) },
      notifications: { ...cur.notifications, ...(p.notifications ?? {}) },
    });
  }
}

/**
 * A feature Attache no longer has (voice, for one) may still be switched on or
 * off in a configuration saved before the upgrade. Forget it rather than
 * refuse the whole configuration; the next save writes it without the entry.
 */
function withoutRetiredFeatures(stored: unknown): unknown {
  if (!stored || typeof stored !== "object") return stored;
  const { features, ...rest } = stored as { features?: unknown };
  if (!features || typeof features !== "object") return stored;
  const known = Object.entries(features).filter(([id]) => FeatureId.safeParse(id).success);
  return { ...rest, features: Object.fromEntries(known) };
}
