#!/bin/sh
# Attache installer for macOS and Linux. Runs from an extracted release. Uses
# only tools every such computer has (sh, cp, ln, mkdir); the Node.js runtime
# is bundled, and everything that differs per operating system (where files
# go, the background service, the command-line wrappers) is done by the
# bundled `attache` itself through its platform modules.
#
#   ./install.sh                 install or upgrade, start the service, open setup
#   ATTACHE_NO_OPEN=1 ./install.sh   do not open the browser
#
# Environment overrides (for tests and advanced use):
#   ATTACHE_PREFIX     install location   (default: ~/Library/Application Support/Attache on macOS, ~/.local/share/attache on Linux)
#   ATTACHE_STATE_DIR  service state      (default: <prefix>/state on macOS, ~/.local/state/attache on Linux)
#   ATTACHE_PORT       service port       (default: 7427)
#   ATTACHE_INSTANCE   instance name      (default: default; also names the background service)
#   ATTACHE_RELEASE_DIR  the release folder holding the signed manifest, its signature and the
#                      archive this release came from (default: the folder this release was unpacked in,
#                      which is where the one-step installer puts them)
#   ATTACHE_UNATTENDED=1  an Update the running service started: never pair or open the browser, and write
#                      the outcome to <state>/updates/outcome.json, where the service reads it after the restart
set -eu

SRC="$(cd "$(dirname "$0")" && pwd)"
VERSION="$(cat "$SRC/VERSION")"
TARGET="$(cat "$SRC/TARGET")"
NEW="$SRC/bin/attache"

UNATTENDED="${ATTACHE_UNATTENDED:-0}"
PREVIOUS=""
STATE=""
# The pre-Update backup taken just before the switch, which a rollback restores the database from; empty when none was.
BACKUP=""
# What a rollback did with the database: restored, no_backup or restore_failed.
DATABASE=""
# How far the install got: an outcome was written, the running service was stopped, `current` was switched.
DONE=0
STOPPED=0
SWITCHED=0

say() { printf '%s\n' "$*"; }

# Unattended, the outcome goes where the service reads it: { outcome, from, to, at, reason?, database?, backup? }
# (apps/service/src/updates/install-records.ts). The bundled runtime writes the JSON, so any reason is escaped.
outcome() {
  DONE=1
  [ "$UNATTENDED" = "1" ] || return 0
  dir="${STATE:-${ATTACHE_STATE_DIR:-}}"
  [ -n "$dir" ] || return 0
  mkdir -p "$dir/updates" &&
    ATTACHE_OUTCOME_FILE="$dir/updates/outcome.json" ATTACHE_OUTCOME="$1" ATTACHE_OUTCOME_FROM="$PREVIOUS" ATTACHE_OUTCOME_TO="$VERSION" ATTACHE_OUTCOME_REASON="${2:-}" ATTACHE_OUTCOME_DATABASE="$DATABASE" ATTACHE_OUTCOME_BACKUP="$BACKUP" \
      "$SRC/runtime/node" -e "$OUTCOME_SCRIPT" 2>/dev/null ||
    printf 'Attache install: could not write the outcome to %s\n' "$dir/updates/outcome.json" >&2
}
OUTCOME_SCRIPT="const fs = require('node:fs'); const e = process.env; const r = { outcome: e.ATTACHE_OUTCOME, from: e.ATTACHE_OUTCOME_FROM || '', to: e.ATTACHE_OUTCOME_TO, at: new Date().toISOString() }; if (e.ATTACHE_OUTCOME_REASON) r.reason = e.ATTACHE_OUTCOME_REASON; if (e.ATTACHE_OUTCOME_DATABASE) r.database = e.ATTACHE_OUTCOME_DATABASE; if (e.ATTACHE_OUTCOME_DATABASE && e.ATTACHE_OUTCOME_BACKUP) r.backup = e.ATTACHE_OUTCOME_BACKUP; fs.writeFileSync(e.ATTACHE_OUTCOME_FILE + '.tmp', JSON.stringify(r, null, 2) + '\\n', { mode: 0o600 }); fs.renameSync(e.ATTACHE_OUTCOME_FILE + '.tmp', e.ATTACHE_OUTCOME_FILE);"

# Stopped before anything changed: an installed version that was stopped runs again.
fail() {
  printf 'Attache install failed: %s\n' "$*" >&2
  if [ "$STOPPED" = "1" ] && [ "$SWITCHED" = "0" ]; then "$NEW" service start >/dev/null 2>&1 || true; fi
  outcome failed "$*"
  exit 1
}

# While the service is stopped: put back the database from the pre-Update backup, so the version going back never
# runs on a database this version migrated. Only the database: the data folder is not rolled back, and paired clients
# and connections stay as they are. Without that backup (the installed version could not open the database a newer
# Attache wrote, see below), the database stays as it is.
restore_database() {
  if [ -z "$BACKUP" ]; then
    DATABASE=no_backup
    say "The database was not restored, because Attache $PREVIOUS could not open it to back it up before the Update."
  elif "$NEW" restore "$BACKUP" --database-only --state-dir "$STATE" >/dev/null; then
    DATABASE=restored
    say "The database was restored from the backup taken just before the Update."
  else
    DATABASE=restore_failed
    say "The database could not be restored from $BACKUP. To restore it, run attache stop, then attache restore \"$BACKUP\" --database-only, then attache start."
  fi
}

# After the switch: go back to the version that was installed, with its database, and start it.
rollback() {
  if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$VERSION" ] && [ -d "$PREFIX/app/$PREVIOUS" ]; then
    say "Rolling back to $PREVIOUS"
    "$NEW" service stop >/dev/null 2>&1 || true
    restore_database
    ln -sfn "$PREFIX/app/$PREVIOUS" "$PREFIX/current"
    "$NEW" service start >/dev/null 2>&1 || true
    printf 'Attache install failed: %s\n' "$1" >&2
    outcome rolled_back "$1"
    exit 1
  fi
  SWITCHED=0
  fail "$1"
}

# A command that failed under `set -e` ends the script without a word: say so, as fail and rollback do.
on_exit() {
  code=$?
  trap - EXIT
  [ "$code" = "0" ] || [ "$DONE" = "1" ] || {
    if [ "$SWITCHED" = "1" ]; then rollback "the installer stopped unexpectedly (exit code $code)"; fi
    fail "the installer stopped unexpectedly (exit code $code)"
  }
  exit "$code"
}
trap on_exit EXIT

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) HOST="macos-arm64" ;;
  Linux-x86_64) HOST="linux-x64" ;;
  *) HOST="$(uname -s) on $(uname -m)" ;;
esac
[ "$HOST" = "$TARGET" ] || fail "this release is for $TARGET, and this computer is $HOST. Download the release for this computer."
"$SRC/runtime/node" --version >/dev/null 2>&1 || fail "the bundled runtime does not run on this computer"

export ATTACHE_INSTANCE="${ATTACHE_INSTANCE:-default}"
PREFIX="${ATTACHE_PREFIX:-$("$NEW" paths installPrefix)}"
PORT="${ATTACHE_PORT:-7427}"
# An install moved with ATTACHE_PREFIX keeps its state inside it, as it always has.
STATE="${ATTACHE_STATE_DIR:-${ATTACHE_PREFIX:+$ATTACHE_PREFIX/state}}"
[ -n "$STATE" ] || STATE="$("$NEW" paths stateDir)"
APP="$PREFIX/app/$VERSION"

if [ -L "$PREFIX/current" ]; then PREVIOUS="$(basename "$(readlink "$PREFIX/current")")"; fi

say "Installing Attache $VERSION${PREVIOUS:+ (currently $PREVIOUS)}"

# Over an existing install, the installed version checks this release against its signed manifest with the
# key it holds, before anything changes (ADR 0007). A first install has nothing to check against.
if [ -n "$PREVIOUS" ] && [ -x "$PREFIX/current/bin/attache" ]; then
  INSTALLED="$PREFIX/current/bin/attache"
  if "$INSTALLED" verify-release --supported >/dev/null 2>&1; then
    RELEASE_DIR="${ATTACHE_RELEASE_DIR:-$(cd "$SRC/.." && pwd)}"
    "$INSTALLED" verify-release "$RELEASE_DIR" --version "$VERSION" --target "$TARGET" --state-dir "$STATE" >/dev/null ||
      fail "Attache $PREVIOUS could not confirm that this release is signed by Attache; nothing was changed. Download the installer again from the Attache releases page."
    say "Attache $PREVIOUS checked that this release is signed by Attache."
  else
    say "Attache $PREVIOUS cannot check signed releases, so this release is installed without that check."
  fi
fi
mkdir -p "$PREFIX/app" "$STATE/logs"
chmod 700 "$PREFIX" "$STATE"

# Stop the running service (if any) and wait until it has really stopped: the backup below then holds its last write.
STOPPED=1
"$NEW" service stop >/dev/null || fail "could not stop the running Attache service; nothing was changed"

# If a service was installed, back it up before changing anything: the pre-Update backup, which a rollback
# restores the database from (only the newest 3 stay, see below; the owner's own backups are never touched).
# A service that refused to start on a database a newer Attache wrote (refused-to-start) cannot open that database to
# back it up, and could not run on a copy of it either: installing a version that reads it is the way out, so it goes
# ahead without that backup, and a rollback then leaves the database as it is.
if [ -n "$PREVIOUS" ] && [ -f "$STATE/refused-to-start" ]; then
  say "Attache $PREVIOUS cannot open this Machine's database, which a newer Attache wrote, so Attache $VERSION is installed without a backup first."
elif [ -n "$PREVIOUS" ] && [ -x "$PREFIX/current/bin/attache" ]; then
  say "Backing up the existing installation"
  # The pre-update- label tells it apart from the owner's backups (apps/service/src/updates/pre-update-backups.ts).
  BACKUP="$STATE/backups/pre-update-$PREVIOUS-to-$VERSION-$(date +%Y%m%d%H%M%S).tar.gz"
  ATTACHE_STATE_DIR="$STATE" "$PREFIX/current/bin/attache" backup --out "$BACKUP" >/dev/null || {
    BACKUP=""
    # fail starts the installed version again.
    fail "could not back up the existing installation; nothing was changed"
  }
fi

# Copy this version into place atomically, then point "current" at it.
TMP="$PREFIX/app/.$VERSION.installing.$$"
rm -rf "$TMP"
mkdir -p "$TMP"
cp -R "$SRC/runtime" "$SRC/service" "$SRC/web" "$SRC/bin" "$SRC/VERSION" "$SRC/uninstall.sh" "$TMP/"
rm -rf "$APP"
mv "$TMP" "$APP"
# -n replaces the existing link itself instead of descending into the directory it points at.
SWITCHED=1
ln -sfn "$APP" "$PREFIX/current"
[ "$(readlink "$PREFIX/current")" = "$APP" ] || rollback "could not switch to version $VERSION"

# Command-line entry points, and the background service: starts at login, restarts on crash, independent of any browser.
"$NEW" wrappers install --prefix "$PREFIX" --state-dir "$STATE" --port "$PORT" >/dev/null || rollback "could not install the attache command"
"$NEW" service install --prefix "$PREFIX" --state-dir "$STATE" --port "$PORT" >/dev/null || rollback "could not set up the background service"
BIN="$("$NEW" paths binDir)"

"$NEW" service start >/dev/null || rollback "the background service could not be started"

say "Starting the Attache service on http://127.0.0.1:$PORT"
# The bundled runtime asks the service for its version, so no curl is needed.
healthy() {
  "$SRC/runtime/node" -e '
    fetch(process.argv[1]).then((r) => r.json()).then((h) => process.exit(h.version === process.argv[2] ? 0 : 1), () => process.exit(1));
  ' "http://127.0.0.1:$PORT/api/v1/health" "$VERSION" 2>/dev/null
}
i=0
until healthy; do
  i=$((i + 1))
  [ "$i" -gt 60 ] && rollback "the service did not become healthy; see the logs in $STATE/logs"
  sleep 0.5
done

say "Attache $VERSION is running."

# Only the 3 newest pre-Update backups stay; the owner's own backups are never touched.
"$NEW" prune-backups --state-dir "$STATE" >/dev/null || say "Could not remove older backups taken before an Update; the next install tries again."

# Keep this version and the one it replaced, for going back; remove the rest, and folders an earlier install left.
if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$VERSION" ]; then
  for OLD in "$PREFIX/app"/* "$PREFIX/app"/.[!.]*; do
    [ -e "$OLD" ] || continue
    case "$(basename "$OLD")" in "$VERSION" | "$PREVIOUS") continue ;; esac
    rm -rf "$OLD" 2>/dev/null || say "Could not remove $OLD; the next install tries again."
  done
fi

if [ "$UNATTENDED" = "1" ]; then
  outcome updated
  exit 0
fi
if [ "${ATTACHE_NO_OPEN:-0}" = "1" ]; then
  "$BIN/attache" pair
else
  "$BIN/attache" pair --open
fi
say ""
say "Command line: $BIN/attache (status, pair, backup, restore). Uninstall: $BIN/attache-uninstall"
