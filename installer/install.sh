#!/bin/sh
# Jarvis installer. Runs from an extracted release. Uses only tools that ship
# with macOS (sh, cp, ln, launchctl, curl, open); the Node.js runtime is bundled.
#
#   ./install.sh                 install or upgrade, start the service, open setup
#   JARVIS_NO_OPEN=1 ./install.sh   do not open the browser
#
# Environment overrides (for tests and advanced use):
#   JARVIS_PREFIX    install location   (default: ~/Library/Application Support/Jarvis)
#   JARVIS_PORT      service port       (default: 7427)
#   JARVIS_INSTANCE  instance name      (default: default; also names the LaunchAgent)
set -eu

SRC="$(cd "$(dirname "$0")" && pwd)"
VERSION="$(cat "$SRC/VERSION")"
PREFIX="${JARVIS_PREFIX:-$HOME/Library/Application Support/Jarvis}"
PORT="${JARVIS_PORT:-7427}"
INSTANCE="${JARVIS_INSTANCE:-default}"
if [ "$INSTANCE" = "default" ]; then LABEL="dev.jarvis.service"; else LABEL="dev.jarvis.$INSTANCE"; fi
STATE="$PREFIX/state"
APP="$PREFIX/app/$VERSION"
AGENTS="$HOME/Library/LaunchAgents"
PLIST="$AGENTS/$LABEL.plist"
BIN="$HOME/.local/bin"
UID_NUM="$(id -u)"

say() { printf '%s\n' "$*"; }
fail() { printf 'Jarvis install failed: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "this installer targets macOS"
[ "$(uname -m)" = "arm64" ] || fail "this build is for Apple silicon (arm64); found $(uname -m)"
"$SRC/runtime/node" --version >/dev/null 2>&1 || fail "the bundled runtime does not run on this Mac"

PREVIOUS=""
if [ -L "$PREFIX/current" ]; then PREVIOUS="$(basename "$(readlink "$PREFIX/current")")"; fi

say "Installing Jarvis $VERSION${PREVIOUS:+ (currently $PREVIOUS)}"
mkdir -p "$PREFIX/app" "$STATE/logs" "$AGENTS" "$BIN"
chmod 700 "$PREFIX" "$STATE"

# If a service is already running, back it up before changing anything.
if [ -n "$PREVIOUS" ] && [ -x "$PREFIX/current/bin/jarvis" ]; then
  say "Backing up the existing installation"
  JARVIS_STATE_DIR="$STATE" JARVIS_INSTANCE="$INSTANCE" "$PREFIX/current/bin/jarvis" backup --out "$STATE/backups/pre-upgrade-$PREVIOUS-to-$VERSION-$(date +%Y%m%d%H%M%S).tar.gz" >/dev/null || fail "could not back up the existing installation; nothing was changed"
fi

# Stop the running service (if any) and wait until launchd has really unloaded it.
stop_agent() {
  launchctl bootout "gui/$UID_NUM/$LABEL" >/dev/null 2>&1 || true
  n=0
  while launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1; do
    n=$((n + 1))
    [ "$n" -gt 40 ] && break
    sleep 0.25
  done
}
start_agent() {
  n=0
  until launchctl bootstrap "gui/$UID_NUM" "$PLIST" 2>/dev/null; do
    n=$((n + 1))
    [ "$n" -gt 5 ] && return 1
    sleep 1
  done
  launchctl kickstart -k "gui/$UID_NUM/$LABEL" >/dev/null 2>&1 || true
}
stop_agent

# Copy this version into place atomically, then point "current" at it.
TMP="$PREFIX/app/.$VERSION.installing.$$"
rm -rf "$TMP"
mkdir -p "$TMP"
cp -R "$SRC/runtime" "$SRC/service" "$SRC/web" "$SRC/bin" "$SRC/obsidian-plugin" "$SRC/VERSION" "$SRC/uninstall.sh" "$TMP/"
rm -rf "$APP"
mv "$TMP" "$APP"
# -n replaces the existing link itself instead of descending into the directory it points at.
ln -sfn "$APP" "$PREFIX/current"
[ "$(readlink "$PREFIX/current")" = "$APP" ] || fail "could not switch to version $VERSION"

# Command-line entry points.
cat > "$BIN/jarvis" <<EOF
#!/bin/sh
export JARVIS_STATE_DIR="\${JARVIS_STATE_DIR:-$STATE}"
export JARVIS_INSTANCE="\${JARVIS_INSTANCE:-$INSTANCE}"
export JARVIS_PORT="\${JARVIS_PORT:-$PORT}"
exec "$PREFIX/current/bin/jarvis" "\$@"
EOF
cat > "$BIN/jarvis-uninstall" <<EOF
#!/bin/sh
JARVIS_PREFIX="$PREFIX" JARVIS_INSTANCE="$INSTANCE" exec /bin/sh "$PREFIX/current/uninstall.sh" "\$@"
EOF
chmod 755 "$BIN/jarvis" "$BIN/jarvis-uninstall"

# LaunchAgent: starts at login, restarts on crash, independent of any browser or Obsidian.
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PREFIX/current/runtime/node</string>
    <string>$PREFIX/current/service/jarvis-service.mjs</string>
    <string>serve</string>
    <string>--port</string><string>$PORT</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>JARVIS_STATE_DIR</key><string>$STATE</string>
    <key>JARVIS_INSTANCE</key><string>$INSTANCE</string>
    <key>JARVIS_WEB_DIR</key><string>$PREFIX/current/web</string>
    <key>HOME</key><string>$HOME</string>
    <key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$STATE/logs/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$STATE/logs/launchd.err.log</string>
</dict>
</plist>
EOF

rollback() {
  if [ -n "$PREVIOUS" ] && [ -d "$PREFIX/app/$PREVIOUS" ]; then
    say "Rolling back to $PREVIOUS"
    stop_agent
    ln -sfn "$PREFIX/app/$PREVIOUS" "$PREFIX/current"
    start_agent || true
  fi
  fail "$1"
}

start_agent || rollback "launchctl could not load $PLIST"

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
say "Obsidian plugin files: $PREFIX/current/obsidian-plugin"
