#!/usr/bin/env bash
# Try Questboard in a nested GNOME Shell window (no logout needed).
# The log is written to nested.log in the repo folder so it can be read for debugging.
cd "$(dirname "$0")/.."
LOG="$PWD/nested.log"
python3 tools/qb install >/dev/null || { echo "install failed"; exit 1; }
VER=$(gnome-shell --version | grep -oE '[0-9]+' | head -1)
if [ "$VER" -ge 49 ]; then FLAGS="--devkit"; else FLAGS="--nested --wayland"; fi
echo "GNOME $VER — starting nested shell ($FLAGS). Close the window to stop. Log: $LOG"
{ echo "=== $(date) GNOME $(gnome-shell --version) session=$XDG_SESSION_TYPE"; } > "$LOG"
MUTTER_DEBUG_DUMMY_MODE_SPECS=${QB_SIZE:-1366x768} dbus-run-session -- gnome-shell $FLAGS >>"$LOG" 2>&1
echo "Nested shell closed. Questboard lines in the log:"
grep -iE "questboard|JS ERROR" "$LOG" | tail -20
