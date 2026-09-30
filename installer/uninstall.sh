#!/bin/sh
# Remove Jarvis. By default your data folder, service state (settings, jobs,
# drafts, receipts, backups) and Keychain credentials are KEPT, so reinstalling
# picks up where you left off.
#
#   jarvis-uninstall                      remove the app and service, keep data
#   jarvis-uninstall --delete-data --yes  also delete service state, credentials and the data folder
set -eu

PREFIX="${JARVIS_PREFIX:-$HOME/Library/Application Support/Jarvis}"
INSTANCE="${JARVIS_INSTANCE:-default}"
if [ "$INSTANCE" = "default" ]; then LABEL="dev.jarvis.service"; else LABEL="dev.jarvis.$INSTANCE"; fi
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
STATE="$PREFIX/state"
DELETE=0
YES=0
for a in "$@"; do
  case "$a" in
    --delete-data) DELETE=1 ;;
    --yes) YES=1 ;;
    *) printf 'Unknown option %s\n' "$a" >&2; exit 2 ;;
  esac
done

DATA_FOLDER=""
if [ "$DELETE" = "1" ] && [ -f "$STATE/jarvis.sqlite" ] && [ -x "$PREFIX/current/runtime/node" ]; then
  DATA_FOLDER="$("$PREFIX/current/runtime/node" -e '
    const { DatabaseSync } = require("node:sqlite");
    try { const d = new DatabaseSync(process.argv[1], { readOnly: true }); const r = d.prepare("select json from config where id = 1").get(); process.stdout.write(r ? (JSON.parse(r.json).dataFolder ?? "") : ""); } catch {}
  ' "$STATE/jarvis.sqlite" 2>/dev/null || true)"
fi

if [ "$DELETE" = "1" ] && [ "$YES" != "1" ]; then
  printf 'This deletes Jarvis service state, stored credentials%s. Type DELETE to continue: ' "${DATA_FOLDER:+ and your data folder $DATA_FOLDER}"
  read -r answer
  [ "$answer" = "DELETE" ] || { echo "Cancelled; nothing was deleted."; exit 1; }
fi

launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
rm -f "$PLIST"

if [ "$DELETE" = "1" ]; then
  if [ -f "$STATE/keychain-index.json" ] && [ -x "$PREFIX/current/runtime/node" ]; then
    "$PREFIX/current/runtime/node" -e 'for (const k of JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))) console.log(k)' "$STATE/keychain-index.json" | while read -r key; do
      /usr/bin/security delete-generic-password -s "dev.jarvis.$INSTANCE" -a "$key" >/dev/null 2>&1 || true
    done
  fi
fi

rm -rf "$PREFIX/app" "$PREFIX/current"
rm -f "$HOME/.local/bin/jarvis" "$HOME/.local/bin/jarvis-uninstall"

if [ "$DELETE" = "1" ]; then
  rm -rf "$STATE"
  if [ -n "$DATA_FOLDER" ] && [ -d "$DATA_FOLDER" ] && [ -f "$DATA_FOLDER/README.md" ] && [ -d "$DATA_FOLDER/memory" ]; then rm -rf "$DATA_FOLDER"; fi
  rmdir "$PREFIX" 2>/dev/null || true
  echo "Jarvis removed, including its data."
else
  echo "Jarvis removed. Your data folder and service state in $STATE were kept; reinstall to continue where you left off."
fi
