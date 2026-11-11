import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { App } from "./app.ts";
import { VERSION } from "./app.ts";
import { nowIso } from "./core/db.ts";
import { platformLocations } from "./platform/locations.ts";

function tar(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => execFile(platformLocations().tar, args, { maxBuffer: 8 * 1024 * 1024 }, (err, _o, stderr) => (err ? reject(new Error(`tar failed: ${stderr || err.message}`)) : resolve())));
}

export interface BackupManifest {
  format: "jarvis-backup-1";
  version: string;
  createdAt: string;
  instance: string;
  dataFolder: string | null;
  includesData: boolean;
  credentialsIncluded: false;
  connectionsNeedingReconnect: string[];
}

export interface BackupOptions {
  /** Where to write the archive; the backups folder when left out. */
  dest?: string;
  /** The folder to back up instead of the configured data folder, e.g. one a join refused. */
  dataFolder?: string;
  /** Added to the archive's name, e.g. "before-join". */
  label?: string;
}

/**
 * Create a backup archive: a consistent database snapshot (VACUUM INTO), the
 * whole data folder, and a manifest. Credentials are never exported; they stay
 * in the Keychain and connections are re-authorised after a restore elsewhere.
 */
export async function createBackup(app: App, opts: BackupOptions = {}): Promise<{ path: string; bytes: number; manifest: BackupManifest }> {
  const stamp = nowIso().replace(/[:.]/g, "-");
  const folder = opts.dataFolder ?? app.config.get().dataFolder;
  const work = mkdtempSync(join(tmpdir(), "jarvis-backup-"));
  try {
    app.db.exec(`vacuum into '${join(work, "jarvis.sqlite").replace(/'/g, "''")}'`);
    const manifest: BackupManifest = {
      format: "jarvis-backup-1",
      version: VERSION,
      createdAt: nowIso(),
      instance: app.instance,
      dataFolder: folder,
      includesData: !!folder && existsSync(folder),
      credentialsIncluded: false,
      connectionsNeedingReconnect: app.connections.records().filter((r) => r.kind !== "vault" && r.status !== "disconnected").map((r) => r.id),
    };
    writeFileSync(join(work, "manifest.json"), JSON.stringify(manifest, null, 2));
    if (manifest.includesData) cpSync(folder!, join(work, "data"), { recursive: true, filter: (src) => basename(src) !== "writer.lock" });
    const out = opts.dest ?? join(app.paths.backupsDir, `jarvis-backup-${stamp}${opts.label ? `-${opts.label}` : ""}.tar.gz`);
    mkdirSync(join(out, ".."), { recursive: true });
    await tar(["-czf", out, "-C", work, "."]);
    return { path: out, bytes: statSync(out).size, manifest };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function listBackups(app: App) {
  if (!existsSync(app.paths.backupsDir)) return [];
  return readdirSync(app.paths.backupsDir)
    .filter((f) => f.endsWith(".tar.gz"))
    .map((f) => ({ name: f, path: join(app.paths.backupsDir, f), bytes: statSync(join(app.paths.backupsDir, f)).size, createdAt: statSync(join(app.paths.backupsDir, f)).mtime.toISOString() }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Restore a backup into a (fresh) state directory while the service is stopped.
 * Refuses to overwrite an existing database or a non-empty data folder unless forced.
 */
export async function restoreBackup(archive: string, opts: { stateDir: string; dataFolder?: string; force?: boolean }): Promise<{ dataFolder: string | null; manifest: BackupManifest }> {
  const work = mkdtempSync(join(tmpdir(), "jarvis-restore-"));
  try {
    await tar(["-xzf", archive, "-C", work]);
    const manifest = JSON.parse(readFileSync(join(work, "manifest.json"), "utf8")) as BackupManifest;
    if (manifest.format !== "jarvis-backup-1") throw new Error("Not a Jarvis backup");
    mkdirSync(opts.stateDir, { recursive: true, mode: 0o700 });
    const dbFile = join(opts.stateDir, "jarvis.sqlite");
    if (existsSync(dbFile)) {
      if (!opts.force) throw new Error(`${dbFile} already exists. Restore into a fresh profile, or pass --force (the current database is kept as a .pre-restore copy).`);
      renameSync(dbFile, `${dbFile}.pre-restore-${Date.now()}`);
      for (const ext of ["-wal", "-shm"]) if (existsSync(dbFile + ext)) rmSync(dbFile + ext);
    }
    cpSync(join(work, "jarvis.sqlite"), dbFile);
    let dataFolder: string | null = null;
    if (manifest.includesData) {
      dataFolder = opts.dataFolder ?? manifest.dataFolder;
      if (!dataFolder) throw new Error("Choose where to restore the data folder");
      if (existsSync(dataFolder) && readdirSync(dataFolder).length && !opts.force) throw new Error(`${dataFolder} is not empty. Choose an empty folder.`);
      cpSync(join(work, "data"), dataFolder, { recursive: true });
    }
    const db = new DatabaseSync(dbFile);
    try {
      const row = db.prepare("select json from config where id = 1").get() as { json: string } | undefined;
      if (row) {
        const cfg = JSON.parse(row.json);
        cfg.dataFolder = dataFolder;
        db.prepare("update config set json = ?, revision = revision + 1, updated_at = ? where id = 1").run(JSON.stringify(cfg), nowIso());
      }
      db.prepare("update connections set settings = json_set(settings, '$.path', ?), account = ? where id = 'vault-data'").run(dataFolder, dataFolder);
      // Credentials were not in the backup; remote connections must be re-authorised.
      db.prepare("update connections set status = 'needs_auth', last_error = 'Restored from backup: reconnect to re-enter credentials' where kind not in ('vault') and status != 'disconnected'").run();
      db.prepare("update clients set revoked_at = ? where revoked_at is null").run(nowIso());
      db.prepare("update jobs set status = 'queued', lease_owner = null where status = 'running'").run();
    } finally {
      db.close();
    }
    return { dataFolder, manifest };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
