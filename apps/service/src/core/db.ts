import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export type Db = DatabaseSync;
export type Row = Record<string, SQLInputValue>;

/**
 * Ordered, append-only migrations. Never edit a shipped migration; add a new
 * one. `user_version` records the applied count so upgrades are repeatable.
 */
export const MIGRATIONS: readonly string[] = [
  `
  create table config (id integer primary key check (id = 1), json text not null, revision integer not null, updated_at text not null);
  create table audit (id integer primary key autoincrement, at text not null, actor text not null, event text not null, data text);

  create table clients (
    id text primary key, name text not null, kind text not null, token_hash text not null unique,
    created_at text not null, last_seen_at text, revoked_at text
  );
  create table pairing_codes (code_hash text primary key, purpose text not null, created_at text not null, expires_at text not null, used_at text);

  create table connections (
    id text primary key, kind text not null, label text not null, status text not null,
    settings text not null default '{}', read_scopes text not null default '[]', write_actions text not null default '[]',
    account text, created_at text not null, updated_at text not null,
    last_attempt_at text, last_success_at text, last_error text, last_error_at text, coverage text
  );
  create table sync_runs (
    id text primary key, connection_id text not null, started_at text not null, finished_at text,
    outcome text, coverage text, item_count integer, error text
  );
  create table observations (
    id text primary key, connection_id text not null, kind text not null, external_id text not null,
    fingerprint text not null, title text not null, url text, author text, data text not null,
    occurred_at text, observed_at text not null, first_seen_at text not null, removed_at text,
    unique (connection_id, kind, external_id)
  );

  create table documents (
    id text primary key, root text not null, rel_path text not null, area text not null, doc_type text,
    title text not null, hash text not null, mtime_ms integer not null, meta text not null default '{}', indexed_at text not null,
    unique (root, rel_path)
  );
  create table chunks (
    id integer primary key autoincrement, doc_id text not null references documents(id) on delete cascade,
    ordinal integer not null, heading text, start_line integer not null, end_line integer not null,
    section text not null, text text not null
  );
  create index chunks_doc on chunks(doc_id);
  create virtual table chunks_fts using fts5(title, heading, text, content='', contentless_delete=1, tokenize='porter unicode61 remove_diacritics 2');

  create table memory_changes (
    id text primary key, doc_rel_path text not null, change text not null, subject text,
    before_value text, after_value text, reason text, source text, actor text not null,
    status text not null, created_at text not null, decided_at text
  );

  create table conversations (id text primary key, title text not null, created_at text not null, updated_at text not null);
  create table messages (
    id text primary key, conversation_id text not null references conversations(id) on delete cascade,
    role text not null, content text not null, status text not null, citations text not null default '[]',
    retrieval text, error text, model text, created_at text not null, updated_at text not null
  );
  create index messages_conv on messages(conversation_id, created_at);

  create table attention_items (
    id text primary key, item_key text not null unique, fingerprint text not null, kind text not null,
    title text not null, summary text not null, why text, source_kind text not null, connection_id text,
    evidence text not null default '[]', url text, due_at text, priority integer not null default 0,
    state text not null, snooze_until text, decided_fingerprint text,
    first_seen_at text not null, updated_at text not null, last_briefing_id text, action_id text
  );
  create table attention_decisions (
    id integer primary key autoincrement, item_key text not null, fingerprint text not null,
    decision text not null, until text, at text not null, actor text not null
  );
  create table briefings (
    id text primary key, created_at text not null, kind text not null, summary text not null,
    items text not null, coverage text not null, job_id text, deliverable_path text
  );

  create table jobs (
    id text primary key, kind text not null, title text not null, status text not null,
    input text not null, result text, error text, progress real not null default 0, progress_note text,
    attempts integer not null default 0, max_attempts integer not null default 3,
    idempotency_key text unique, capability text, connection_id text, checkpoint text,
    created_at text not null, updated_at text not null, started_at text, finished_at text,
    lease_owner text, lease_until text, cancel_requested_at text, cancel_outcome text, run_after text
  );
  create index jobs_status on jobs(status, run_after);
  create table job_events (
    seq integer primary key autoincrement, job_id text not null, type text not null, data text not null, at text not null
  );
  create index job_events_job on job_events(job_id, seq);
  create table side_effects (
    effect_key text primary key, job_id text, action_id text, status text not null, result text,
    created_at text not null, completed_at text
  );

  create table actions (
    id text primary key, kind text not null, connection_id text, title text not null,
    target text not null, payload text not null, payload_hash text not null, version integer not null,
    context text not null default '{}', status text not null, expires_at text not null,
    created_at text not null, updated_at text not null, created_by text not null,
    approval text, receipt text, attention_item_key text
  );
  create table action_events (
    id integer primary key autoincrement, action_id text not null, event text not null, data text, at text not null, actor text not null
  );
  create table approval_nonces (nonce text primary key, action_id text not null, used_at text not null);

  create table schedules (
    id text primary key, capability text not null, job_kind text not null, every_minutes integer,
    daily_at text, enabled integer not null, next_run_at text, last_run_at text, last_job_id text
  );
  `,
  `
  alter table attention_items add column draftable text;
  create index attention_state on attention_items(state, priority);
  create table seen_clients (client_id text primary key, last_seen_at text not null);
  `,
  `
  create table agent_sessions (
    agent text not null, session_id text not null, rel_path text not null, title text, cwd text,
    started_at text, updated_at text not null, turns integer not null, distilled_turns integer not null default 0,
    primary key (agent, session_id)
  );
  `,
  // Recall now indexes one chunk per current fact and splits long lists. Forget every file's
  // fingerprint so the next scan re-chunks it; the old chunks stay searchable until then.
  `
  update documents set hash = '', mtime_ms = -1;
  `,
  // This Machine's identity: local state, never part of the Brain.
  `
  create table machine (
    id integer primary key check (id = 1), machine_id text not null, name text not null,
    created_at text not null, updated_at text not null
  );
  `,
  // Recent saves with revert: which Harness and session made each change, which changes one save
  // made together, which change a revert undid, and a fingerprint of the note right after the write.
  `
  alter table memory_changes add column harness text;
  alter table memory_changes add column session_id text;
  alter table memory_changes add column batch_id text;
  alter table memory_changes add column reverts text;
  alter table memory_changes add column doc_hash text;
  create index memory_changes_doc on memory_changes(doc_rel_path);
  create index memory_changes_reverts on memory_changes(reverts);
  `,
  // Jarvis holds no conversation of its own (ADR 0003). Chat archives already written stay in the Brain as evidence.
  `
  drop index if exists messages_conv;
  drop table if exists messages;
  drop table if exists conversations;
  `,
  // Replication of the Brain through git: local state, never part of the Brain. No row means off.
  `
  create table replication (
    id integer primary key check (id = 1), data_folder text not null, remote text not null, enabled_at text not null,
    committed_seq integer not null default 0, status text not null, cause text, checked_at text, pushed_at text
  );
  `,
  // Auto-accept per Harness: local state of this Machine, never part of the Brain. A change
  // written without asking the owner is marked so in the change log.
  `
  create table harness_settings (harness text primary key, auto_accept integer not null default 0, updated_at text not null);
  alter table memory_changes add column auto_accepted integer not null default 0;
  `,
  // Meaning-based search, local to this Machine: the text each chunk's vector is made from, and the
  // vectors, keyed by model and that text's hash so text that did not change keeps its vector when its
  // file is re-chunked. Forget every file's fingerprint so the next scan fills in the new columns.
  `
  alter table chunks add column embed_text text;
  alter table chunks add column embed_hash text;
  create index chunks_embed on chunks(embed_hash);
  create table chunk_vectors (model text not null, hash text not null, vector blob not null, primary key (model, hash)) without rowid;
  update documents set hash = '', mtime_ms = -1;
  `,
  // Review dates: the Review date a fact had before and after a correction, so a revert brings back both.
  `
  alter table memory_changes add column before_review text;
  alter table memory_changes add column after_review text;
  `,
  // The inbox replicates: each item keeps what its source said (with when the source stopped reporting it
  // and the Machine that ran Source refresh) apart from the owner's latest decision, so the state can be
  // worked out the same way on every Machine. Items and decisions from before carry over.
  `
  alter table attention_items add column resolved_at text;
  alter table attention_items add column decision text;
  alter table attention_items add column machine text;
  update attention_items set decision = (
    select json_object('decision', d.decision, 'fingerprint', d.fingerprint, 'until', d.until, 'at', d.at, 'actor', d.actor, 'machine', null)
    from attention_decisions d where d.item_key = attention_items.item_key order by d.id desc limit 1
  );
  update attention_items set resolved_at = updated_at
  where state = 'resolved'
    and not (decision is not null and json_extract(decision, '$.decision') = 'done' and json_extract(decision, '$.fingerprint') = fingerprint);
  `,
  // Proposals live in the Brain (review/proposals/), so they replicate. This table is only this
  // Machine's index of those files, rebuilt from them; Proposals stored in the change log before
  // are carried over into files when the data folder is next opened.
  `
  create table proposals (
    id text primary key, rel_path text not null unique, status text not null, created_at text not null,
    decided_at text, record text not null
  );
  create index proposals_status on proposals(status, created_at);
  `,
  // When this Machine was last up to date with the others, for the Dashboard. Setup and join count.
  `
  alter table replication add column up_to_date_at text;
  update replication set up_to_date_at = checked_at where status = 'up_to_date';
  `,
  // Consolidation from meeting captures: which captures of a data folder this Machine has seen, and
  // since when it watches the folder for new ones. Local state, never part of the Brain: a capture is
  // consolidated on the Machine where it arrived, and one that came from another Machine is only seen.
  `
  create table capture_watch (data_folder text primary key, since text not null);
  create table capture_arrivals (
    data_folder text not null, rel_path text not null, arrival text not null, seen_at text not null,
    primary key (data_folder, rel_path)
  ) without rowid;
  `,
  // Source refresh had been stored as "sync" (the job kind, its schedule and its interval setting);
  // the glossary avoids that word, so stored rows and settings take the Source refresh name.
  `
  update jobs set kind = 'source-refresh' where kind = 'sync';
  update schedules set id = 'attention:source-refresh', job_kind = 'source-refresh' where id = 'attention:sync';
  update config set json = json_set(json_remove(json, '$.schedules.syncEveryMinutes'), '$.schedules.refreshEveryMinutes', json_extract(json, '$.schedules.syncEveryMinutes'))
  where json_extract(json, '$.schedules.syncEveryMinutes') is not null;
  `,
];

export function openDb(file: string): Db {
  const db = new DatabaseSync(file);
  db.exec("pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000; pragma synchronous = normal;");
  migrate(db);
  return db;
}

export function migrate(db: Db): { from: number; to: number } {
  const from = Number((db.prepare("pragma user_version").get() as { user_version: number }).user_version);
  for (let i = from; i < MIGRATIONS.length; i++) {
    db.exec("begin");
    try {
      db.exec(MIGRATIONS[i]!);
      db.exec(`pragma user_version = ${i + 1}`);
      db.exec("commit");
    } catch (err) {
      db.exec("rollback");
      throw err;
    }
  }
  return { from, to: MIGRATIONS.length };
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec("begin immediate");
  try {
    const out = fn();
    db.exec("commit");
    return out;
  } catch (err) {
    db.exec("rollback");
    throw err;
  }
}

export const nowIso = (): string => new Date().toISOString();

export function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value === "") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
