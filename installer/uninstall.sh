#!/bin/sh
# Remove Attache. By default your data folder, service state (settings, jobs,
# drafts, receipts, backups) and stored credentials are KEPT, so reinstalling
# picks up where you left off.
#
#   attache-uninstall                      remove the app and service, keep data
#   attache-uninstall --delete-data --yes  also delete service state, credentials and the data folder
#
# The background service, the secret store and the command-line wrappers are
# removed by the installed `attache` itself, through its platform modules.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
export ATTACHE_INSTANCE="${ATTACHE_INSTANCE:-default}"
PREFIX="${ATTACHE_PREFIX:-$("$HERE/bin/attache" paths installPrefix)}"
# The same state folder the installer chose: `attache-uninstall` passes it on.
STATE="${ATTACHE_STATE_DIR:-${ATTACHE_PREFIX:+$ATTACHE_PREFIX/state}}"
[ -n "$STATE" ] || STATE="$("$HERE/bin/attache" paths stateDir)"
ATTACHE="$PREFIX/current/bin/attache"
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

[ -x "$ATTACHE" ] || { printf 'Attache is not installed in %s: %s is missing.\n' "$PREFIX" "$ATTACHE" >&2; exit 1; }
LOCKS="$("$ATTACHE" paths locksDir)"

DATA_FOLDER=""
OWNED=""
CREATED_FOLDER="false"
if [ "$DELETE" = "1" ]; then
  # The data folder and what Attache created in it; only those entries are ever deleted, files the owner already had stay.
  if PLAN="$("$ATTACHE" data-folder --state-dir "$STATE")"; then
    DATA_FOLDER="$(printf '%s' "$PLAN" | "$NODE" -e 'const p = JSON.parse(require("fs").readFileSync(0, "utf8")); process.stdout.write(p.dataFolder ?? "")')"
    CREATED_FOLDER="$(printf '%s' "$PLAN" | "$NODE" -e 'const p = JSON.parse(require("fs").readFileSync(0, "utf8")); process.stdout.write(String(p.createdFolder))')"
    OWNED="$(printf '%s' "$PLAN" | "$NODE" -e 'const p = JSON.parse(require("fs").readFileSync(0, "utf8")); for (const e of p.created) console.log(e)')"
  else
    printf 'Could not tell which data folder this install uses (see the message above), so no data folder will be deleted; remove it yourself if you want it gone.\n' >&2
  fi
fi

if [ "$DELETE" = "1" ] && [ "$YES" != "1" ]; then
  printf 'This deletes Attache service state, stored credentials%s. Type DELETE to continue: ' "${DATA_FOLDER:+ and your data folder $DATA_FOLDER}"
  read -r answer
  [ "$answer" = "DELETE" ] || { echo "Cancelled; nothing was deleted."; exit 1; }
fi

"$ATTACHE" service uninstall >/dev/null || printf 'Could not remove the Attache background service; see the message above.\n' >&2

# Harnesses would otherwise keep calling a hook that no longer exists. Only this install's hooks are removed.
# Failures are reported per Harness on stderr; the uninstall carries on either way.
ATTACHE_STATE_DIR="$STATE" "$ATTACHE" agent-hooks uninstall --state-dir "$STATE" >/dev/null || true

if [ "$DELETE" = "1" ]; then
  ATTACHE_STATE_DIR="$STATE" "$ATTACHE" credentials clear --state-dir "$STATE" >/dev/null || printf 'Could not delete every stored credential; see the message above.\n' >&2
  # A service that was killed outright (a crash, a power cut) leaves its writer lock; the service has stopped by now.
  "$ATTACHE" locks clear-stale --locks-dir "$LOCKS" >/dev/null || printf 'Could not remove the writer locks of stopped services; see the message above.\n' >&2
fi

"$ATTACHE" wrappers uninstall >/dev/null || true
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
      echo "Kept your own files in $DATA_FOLDER; removed only what Attache created there."
    fi
  fi
  # The locks folder is shared by every instance, so it goes only once no live service holds a lock in it.
  rmdir "$LOCKS" 2>/dev/null || true
  rmdir "$PREFIX" 2>/dev/null || true
  echo "Attache removed, including its data."
else
  echo "Attache removed. Your data folder and service state in $STATE were kept; reinstall to continue where you left off."
fi
