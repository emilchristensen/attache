#!/bin/sh
# Runs a command inside a throwaway Linux desktop session: a session bus, an
# unlocked GNOME Keyring (the Secret Service) and the dunst notification
# daemon on a virtual display. CI runs the real-desktop tests in it:
#
#   ATTACHE_TEST_REAL_DESKTOP=1 sh scripts/linux-desktop-session.sh pnpm vitest run apps/service/test/linux-desktop-real.test.ts
#
# Needs: dbus, gnome-keyring, libsecret-tools, libnotify-bin, dunst, xvfb.
set -eu

if [ "${ATTACHE_DESKTOP_SESSION:-}" != "bus" ]; then
  export ATTACHE_DESKTOP_SESSION=bus
  # The display first, so services the bus starts on demand can open it too.
  exec xvfb-run -a dbus-run-session -- sh "$0" "$@"
fi

# Unlocking with a password creates the login keyring and leaves it unlocked.
printf 'attache-ci' | gnome-keyring-daemon --unlock --components=secrets >/dev/null
dunst 2>/dev/null &
dunst_pid=$!
trap 'kill "$dunst_pid" 2>/dev/null || true' EXIT
i=0
until dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.NameHasOwner string:org.freedesktop.Notifications 2>/dev/null | grep -q "boolean true"; do
  i=$((i + 1))
  if [ "$i" -gt 50 ]; then echo "dunst did not start" >&2; exit 1; fi
  sleep 0.1
done
"$@"
