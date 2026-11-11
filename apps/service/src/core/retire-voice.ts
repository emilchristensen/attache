import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db.ts";
import type { Logger } from "./log.ts";
import type { ServicePaths } from "./paths.ts";
import type { CredentialStore } from "./secrets.ts";

/** The whisper.cpp model voice downloaded, and the partial file an interrupted download left. */
const VOICE_MODEL_FILES = ["ggml-base.en.bin", "ggml-base.en.bin.part"] as const;
/** Credentials the speech connection kept, under `conn:<id>:<name>`. */
const SPEECH_SECRET_NAMES = ["apiKey"] as const;

export interface VoiceLeftovers {
  paths: ServicePaths;
  db: Db;
  secrets: CredentialStore;
  log: Logger;
}

/**
 * Voice is no longer part of Jarvis. An install that had it set up keeps a
 * 148 MB speech model, a speech connection and maybe its API key; remove them
 * on the first start after the upgrade. Running it again finds nothing to do.
 *
 * The files and connection rows go before this returns its promise, so no
 * request ever sees them; only the credential store is awaited.
 */
export async function retireVoice({ paths, db, secrets, log }: VoiceLeftovers): Promise<void> {
  for (const name of VOICE_MODEL_FILES) {
    try {
      rmSync(join(paths.modelsDir, name), { force: true });
    } catch (e) {
      log.error("could not remove the old speech model", { file: name, error: (e as Error).message });
    }
  }
  const ids = (db.prepare("select id from connections where kind = 'speech'").all() as Array<{ id: string }>).map((r) => r.id);
  if (!ids.length) return;
  for (const id of ids) {
    db.prepare("delete from sync_runs where connection_id = ?").run(id);
    db.prepare("delete from connections where id = ?").run(id);
  }
  log.info("removed the speech connection; voice is no longer part of Jarvis", { connections: ids });
  for (const id of ids) {
    for (const name of SPEECH_SECRET_NAMES) {
      try {
        await secrets.delete(`conn:${id}:${name}`);
      } catch (e) {
        log.error("could not remove the speech credential", { connection: id, error: (e as Error).message });
      }
    }
  }
}
