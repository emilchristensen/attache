#!/bin/sh
# Remove Jarvis. By default your data folder, service state (settings, jobs,
# drafts, receipts, backups) and stored credentials are KEPT, so reinstalling
# picks up where you left off.
#
#   jarvis-uninstall                      remove the app and service, keep data
#   jarvis-uninstall --delete-data --yes  also delete service state, credentials and the data folder
#
# The background service, the secret store and the command-line wrappers are
# removed by the installed `jarvis` itself, through its platform modules.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
export JARVIS_INSTANCE="${JARVIS_INSTANCE:-default}"
PREFIX="${JARVIS_PREFIX:-$("$HERE/bin/jarvis" paths installPrefix)}"
STATE="$PREFIX/state"
JARVIS="$PREFIX/current/bin/jarvis"
NODE="$PREFIX/current/runtime/node"
DELETE=0
YES=0
for a in "$@"; do
  case "$a" in
    --delete-data) DELETE=1 ;;
    --yes) YES=1 ;;
    *) printf 'Unknown option %s\n' "$a" >&2; exit 2 ;;
  esac
done

[ -x "$JARVIS" ] || { printf 'Jarvis is not installed in %s: %s is missing.\n' "$PREFIX" "$JARVIS" >&2; exit 1; }
LOCKS="$("$JARVIS" paths locksDir)"

DATA_FOLDER=""
OWNED=""
CREATED_FOLDER="false"
if [ "$DELETE" = "1" ] && [ -f "$STATE/jarvis.sqlite" ]; then
  DATA_FOLDER="$("$NODE" -e '
    const { DatabaseSync } = require("node:sqlite");
    try { const d = new DatabaseSync(process.argv[1], { readOnly: true }); const r = d.prepare("select json from config where id = 1").get(); process.stdout.write(r ? (JSON.parse(r.json).dataFolder ?? "") : ""); } catch {}
  ' "$STATE/jarvis.sqlite" 2>/dev/null || true)"
  if [ -n "$DATA_FOLDER" ] && [ -f "$DATA_FOLDER/.jarvis/owned.json" ]; then
    # Only entries Jarvis created are ever deleted; files the user already had stay.
    CREATED_FOLDER="$("$NODE" -e 'const o = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(o.createdFolder === true ? "true" : "false")' "$DATA_FOLDER/.jarvis/owned.json" 2>/dev/null || echo false)"
    OWNED="$("$NODE" -e 'const o = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); for (const e of o.created ?? []) if (/^[A-Za-z.][A-Za-z0-9._-]*$/.test(e)) console.log(e)' "$DATA_FOLDER/.jarvis/owned.json" 2>/dev/null || true)"
  fi
fi

if [ "$DELETE" = "1" ] && [ "$YES" != "1" ]; then
  printf 'This deletes Jarvis service state, stored credentials%s. Type DELETE to continue: ' "${DATA_FOLDER:+ and your data folder $DATA_FOLDER}"
  read -r answer
  [ "$answer" = "DELETE" ] || { echo "Cancelled; nothing was deleted."; exit 1; }
fi

"$JARVIS" service uninstall >/dev/null || printf 'Could not remove the Jarvis background service; see the message above.\n' >&2

# Harnesses would otherwise keep calling a hook that no longer exists. Only this install's hooks are removed.
# Failures are reported per Harness on stderr; the uninstall carries on either way.
JARVIS_STATE_DIR="$STATE" "$JARVIS" agent-hooks uninstall --state-dir "$STATE" >/dev/null || true

if [ "$DELETE" = "1" ]; then
  JARVIS_STATE_DIR="$STATE" "$JARVIS" credentials clear --state-dir "$STATE" >/dev/null || printf 'Could not delete every stored credential; see the message above.\n' >&2
fi

"$JARVIS" wrappers uninstall >/dev/null || true
rm -rf "$PREFIX/app" "$PREFIX/current"

if [ "$DELETE" = "1" ]; then
  rm -rf "$STATE"
  if [ -n "$DATA_FOLDER" ] && [ -d "$DATA_FOLDER" ]; then
    if [ "$CREATED_FOLDER" = "true" ]; then
      rm -rf "$DATA_FOLDER"
    else
      printf '%s\n' "$OWNED" | while read -r entry; do
        [ -n "$entry" ] && rm -rf "$DATA_FOLDER/$entry"
      done
      echo "Kept your own files in $DATA_FOLDER; removed only what Jarvis created there."
    fi
  fi
  # Writer locks are released when the service stops; the folder is shared by every instance, so only an empty one goes.
  rmdir "$LOCKS" 2>/dev/null || true
  rmdir "$PREFIX" 2>/dev/null || true
  echo "Jarvis removed, including its data."
else
  echo "Jarvis removed. Your data folder and service state in $STATE were kept; reinstall to continue where you left off."
fi
