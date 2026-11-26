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
set -eu

SRC="$(cd "$(dirname "$0")" && pwd)"
VERSION="$(cat "$SRC/VERSION")"
TARGET="$(cat "$SRC/TARGET")"
NEW="$SRC/bin/attache"

say() { printf '%s\n' "$*"; }
fail() { printf 'Attache install failed: %s\n' "$*" >&2; exit 1; }

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

PREVIOUS=""
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

# If a service is already running, back it up before changing anything.
if [ -n "$PREVIOUS" ] && [ -x "$PREFIX/current/bin/attache" ]; then
  say "Backing up the existing installation"
  ATTACHE_STATE_DIR="$STATE" "$PREFIX/current/bin/attache" backup --out "$STATE/backups/pre-upgrade-$PREVIOUS-to-$VERSION-$(date +%Y%m%d%H%M%S).tar.gz" >/dev/null || fail "could not back up the existing installation; nothing was changed"
fi

# Stop the running service (if any) and wait until it has really stopped.
"$NEW" service stop >/dev/null || fail "could not stop the running Attache service; nothing was changed"

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
"$NEW" wrappers install --prefix "$PREFIX" --state-dir "$STATE" --port "$PORT" >/dev/null || fail "could not install the attache command"
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
if [ "${ATTACHE_NO_OPEN:-0}" = "1" ]; then
  "$BIN/attache" pair
else
  "$BIN/attache" pair --open
fi
say ""
say "Command line: $BIN/attache (status, pair, backup, restore). Uninstall: $BIN/attache-uninstall"
