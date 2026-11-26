import { DatabaseSync } from "node:sqlite";

/**
 * Which Attache wrote a database, and the refusal an older Attache gives when
 * the schema is newer than the migrations it knows (spec #130).
 *
 * `schema_writer` is a contract between versions: a version records itself
 * there with each migration it applies, and every older version that refuses
 * the database reads it back to name the version to install. Its name and
 * columns never change.
 */
export class NewerDatabaseError extends Error {
  /** The Attache version that wrote the database, when it recorded itself. */
  readonly writtenBy: string | null;

  constructor(writtenBy: string | null, running: string) {
    super(
      writtenBy
        ? `This Machine's database was written by Attache ${writtenBy}, which is newer than this Attache (${running}). Install Attache ${writtenBy} or newer again to keep using it. Nothing was changed.`
        : `This Machine's database was written by a newer Attache than this one (${running}). Install the newest Attache again to keep using it. Nothing was changed.`,
    );
    this.name = "NewerDatabaseError";
    this.writtenBy = writtenBy;
  }
}

const hasWriterTable = (db: DatabaseSync): boolean => db.prepare("select 1 from sqlite_master where type = 'table' and name = 'schema_writer'").get() !== undefined;

export const schemaVersionOf = (db: DatabaseSync): number => Number((db.prepare("pragma user_version").get() as { user_version: number }).user_version);

/** Throws `NewerDatabaseError`, reading only, when the database's schema is past the `known` migrations. */
export function refuseNewerSchema(db: DatabaseSync, known: number, running: string): void {
  if (schemaVersionOf(db) <= known) return;
  const row = hasWriterTable(db) ? (db.prepare("select version from schema_writer where id = 1").get() as { version: string } | undefined) : undefined;
  throw new NewerDatabaseError(row?.version ?? null, running);
}

/** The same check on a database file, opened read-only and closed again; for a database Attache is about to take over, such as a restored backup. */
export function refuseNewerSchemaFile(file: string, known: number, running: string): void {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    refuseNewerSchema(db, known, running);
  } finally {
    db.close();
  }
}

/** Inside a migration's transaction: `version` brought the schema to `schemaVersion`. Before the table exists there is nothing to record. */
export function recordSchemaWriter(db: DatabaseSync, schemaVersion: number, version: string): void {
  if (!hasWriterTable(db)) return;
  db.prepare("insert into schema_writer (id, version, schema_version, at) values (1, ?, ?, ?) on conflict (id) do update set version = excluded.version, schema_version = excluded.schema_version, at = excluded.at").run(version, schemaVersion, new Date().toISOString());
}
