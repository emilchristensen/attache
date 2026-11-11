#!/bin/sh
# Comments are for maintainers: sync, second brain.
SYNC_DIR="$HOME/sync"
say() { printf '%s\n' "$*"; }
say "Starting the sync now." # avoided
printf 'Your second brain is ready at %s\n' "$SYNC_DIR" # avoided
echo "Done."
