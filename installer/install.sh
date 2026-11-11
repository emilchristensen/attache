#!/bin/sh
# Jarvis installer for macOS. Runs from an extracted release. Uses only tools
# that ship with macOS (sh, cp, ln, curl); the Node.js runtime is bundled, and
# everything that differs per operating system (where files go, the
# background service, the command-line wrappers) is done by the bundled
# `jarvis` itself through its platform modules.
#
#   ./install.sh                 install or upgrade, start the service, open setup
#   JARVIS_NO_OPEN=1 ./install.sh   do not open the browser
#
# Environment overrides (for tests and advanced use):
#   JARVIS_PREFIX    install location   (default: ~/Library/Application Support/Jarvis)
#   JARVIS_PORT      service port       (default: 7427)
#   JARVIS_INSTANCE  instance name      (default: default; also names the background service)
set -eu

SRC="$(cd "$(dirname "$0")" && pwd)"
VERSION="$(cat "$SRC/VERSION")"
NEW="$SRC/bin/jarvis"

say() { printf '%s\n' "$*"; }
fail() { printf 'Jarvis install failed: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "this installer targets macOS"
[ "$(uname -m)" = "arm64" ] || fail "this build is for Apple silicon (arm64); found $(uname -m)"
"$SRC/runtime/node" --version >/dev/null 2>&1 || fail "the bundled runtime does not run on this Mac"

export JARVIS_INSTANCE="${JARVIS_INSTANCE:-default}"
PREFIX="${JARVIS_PREFIX:-$("$NEW" paths installPrefix)}"
PORT="${JARVIS_PORT:-7427}"
STATE="$PREFIX/state"
APP="$PREFIX/app/$VERSION"

PREVIOUS=""
if [ -L "$PREFIX/current" ]; then PREVIOUS="$(basename "$(readlink "$PREFIX/current")")"; fi

say "Installing Jarvis $VERSION${PREVIOUS:+ (currently $PREVIOUS)}"
mkdir -p "$PREFIX/app" "$STATE/logs"
chmod 700 "$PREFIX" "$STATE"

# If a service is already running, back it up before changing anything.
if [ -n "$PREVIOUS" ] && [ -x "$PREFIX/current/bin/jarvis" ]; then
  say "Backing up the existing installation"
  JARVIS_STATE_DIR="$STATE" "$PREFIX/current/bin/jarvis" backup --out "$STATE/backups/pre-upgrade-$PREVIOUS-to-$VERSION-$(date +%Y%m%d%H%M%S).tar.gz" >/dev/null || fail "could not back up the existing installation; nothing was changed"
fi

# Stop the running service (if any) and wait until it has really stopped.
"$NEW" service stop >/dev/null || fail "could not stop the running Jarvis service; nothing was changed"

# Copy this version into place atomically, then point "current" at it.
TMP="$PREFIX/app/.$VERSION.installing.$$"
rm -rf "$TMP"
mkdir -p "$TMP"
cp -R "$SRC/runtime" "$SRC/service" "$SRC/web" "$SRC/bin" "$SRC/VERSION" "$SRC/uninstall.sh" "$TMP/"
rm -rf "$APP"
mv "$TMP" "$APP"
# -n replaces the existing link itself instead of descending into the directory it points at.
ln -sfn "$APP" "$PREFIX/current"
[ "$(readlink "$PREFIX/current")" = "$APP" ] || fail "could not switch to version $VERSION"

# Command-line entry points, and the background service: starts at login, restarts on crash, independent of any browser.
"$NEW" wrappers install --prefix "$PREFIX" --state-dir "$STATE" --port "$PORT" >/dev/null || fail "could not install the jarvis command"
"$NEW" service install --prefix "$PREFIX" --state-dir "$STATE" --port "$PORT" >/dev/null || fail "could not set up the background service"
BIN="$("$NEW" paths binDir)"

rollback() {
  if [ -n "$PREVIOUS" ] && [ -d "$PREFIX/app/$PREVIOUS" ]; then
    say "Rolling back to $PREVIOUS"
    "$NEW" service stop >/dev/null 2>&1 || true
    ln -sfn "$PREFIX/app/$PREVIOUS" "$PREFIX/current"
    "$NEW" service start >/dev/null 2>&1 || true
  fi
  fail "$1"
}

"$NEW" service start >/dev/null || rollback "the background service could not be started"

say "Starting the Jarvis service on http://127.0.0.1:$PORT"
i=0
until /usr/bin/curl -fsS "http://127.0.0.1:$PORT/api/v1/health" 2>/dev/null | grep -q "\"version\":\"$VERSION\""; do
  i=$((i + 1))
  [ "$i" -gt 60 ] && rollback "the service did not become healthy; see $STATE/logs/launchd.err.log"
  sleep 0.5
done

say "Jarvis $VERSION is running."
if [ "${JARVIS_NO_OPEN:-0}" = "1" ]; then
  "$BIN/jarvis" pair
else
  "$BIN/jarvis" pair --open
fi
say ""
say "Command line: $BIN/jarvis (status, pair, backup, restore). Uninstall: $BIN/jarvis-uninstall"
