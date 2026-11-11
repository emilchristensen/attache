#!/bin/sh
# Jarvis installer for macOS and Linux. Runs from an extracted release. Uses
# only tools every such computer has (sh, cp, ln, mkdir); the Node.js runtime
# is bundled, and everything that differs per operating system (where files
# go, the background service, the command-line wrappers) is done by the
# bundled `jarvis` itself through its platform modules.
#
#   ./install.sh                 install or upgrade, start the service, open setup
#   JARVIS_NO_OPEN=1 ./install.sh   do not open the browser
#
# Environment overrides (for tests and advanced use):
#   JARVIS_PREFIX     install location   (default: ~/Library/Application Support/Jarvis on macOS, ~/.local/share/jarvis on Linux)
#   JARVIS_STATE_DIR  service state      (default: <prefix>/state on macOS, ~/.local/state/jarvis on Linux)
#   JARVIS_PORT       service port       (default: 7427)
#   JARVIS_INSTANCE   instance name      (default: default; also names the background service)
set -eu

SRC="$(cd "$(dirname "$0")" && pwd)"
VERSION="$(cat "$SRC/VERSION")"
TARGET="$(cat "$SRC/TARGET")"
NEW="$SRC/bin/jarvis"

say() { printf '%s\n' "$*"; }
fail() { printf 'Jarvis install failed: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) HOST="macos-arm64" ;;
  Linux-x86_64) HOST="linux-x64" ;;
  *) HOST="$(uname -s) on $(uname -m)" ;;
esac
[ "$HOST" = "$TARGET" ] || fail "this release is for $TARGET, and this computer is $HOST. Download the release for this computer."
"$SRC/runtime/node" --version >/dev/null 2>&1 || fail "the bundled runtime does not run on this computer"

export JARVIS_INSTANCE="${JARVIS_INSTANCE:-default}"
PREFIX="${JARVIS_PREFIX:-$("$NEW" paths installPrefix)}"
PORT="${JARVIS_PORT:-7427}"
# An install moved with JARVIS_PREFIX keeps its state inside it, as it always has.
STATE="${JARVIS_STATE_DIR:-${JARVIS_PREFIX:+$JARVIS_PREFIX/state}}"
[ -n "$STATE" ] || STATE="$("$NEW" paths stateDir)"
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

say "Jarvis $VERSION is running."
if [ "${JARVIS_NO_OPEN:-0}" = "1" ]; then
  "$BIN/jarvis" pair
else
  "$BIN/jarvis" pair --open
fi
say ""
say "Command line: $BIN/jarvis (status, pair, backup, restore). Uninstall: $BIN/jarvis-uninstall"
