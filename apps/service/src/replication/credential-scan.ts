import { findSecrets, redact } from "../core/redaction.ts";
import type { CommitGuard, GuardVerdict, StagedFile } from "./seams.ts";

/** A cause names this many places at most; the rest are counted. */
const PLACES_SHOWN = 5;

interface Place {
  path: string;
  /** Null when the secret is in the file's name. */
  line: number | null;
  kind: string;
}

/** New credentials only: one that is in the shared history already is there whatever this commit does. */
function placesIn(file: StagedFile): Place[] {
  const named = findSecrets(file.path).map((f) => ({ path: file.path, line: null, kind: f.kind }));
  const content = file.read();
  const inside = content === null ? [] : findSecrets(content, file.committed?.() ?? []).map((f) => ({ path: file.path, line: f.line, kind: f.kind }));
  return [...named, ...inside];
}

function describe(place: Place): string {
  // The file name is redacted too, in case the secret is part of it.
  const where = place.line === null ? `the name of ${redact(place.path)}` : `${redact(place.path)} line ${place.line}`;
  return `${where} (${place.kind})`;
}

/** What the owner reads in the status and the inbox: where each credential is, never the credential. */
export function credentialCause(places: readonly Place[]): string {
  const shown = places.slice(0, PLACES_SHOWN).map(describe);
  const more = places.length > PLACES_SHOWN ? `, and ${places.length - PLACES_SHOWN} more` : "";
  const one = places.length === 1;
  return [
    `Jarvis found what looks like a credential in ${shown.join(", ")}${more}, so it did not commit or push.`,
    `Remove ${one ? "it" : "them"} from the ${one ? "file" : "files"} and Replication continues by itself.`,
  ].join(" ");
}

/**
 * Refuses a commit that would put a credential in the repository. It looks
 * for exactly what redaction hides (`core/redaction.ts`), in every file about
 * to be committed and in their names.
 */
export const credentialScan: CommitGuard = Object.freeze({
  name: "credential scan",
  check(files: readonly StagedFile[]): GuardVerdict {
    const places = files.filter((f) => f.change !== "deleted").flatMap(placesIn);
    return places.length ? { ok: false, status: "blocked", cause: credentialCause(places) } : { ok: true };
  },
});
