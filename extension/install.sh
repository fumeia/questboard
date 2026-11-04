#!/usr/bin/env bash
# Installs Questboard into your user GNOME Shell extensions folder.
set -euo pipefail
UUID="questboard@marci.local"
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

mkdir -p "$DEST/schemas"
cp "$SRC"/{metadata.json,extension.js,prefs.js,dashboard.js,calendarView.js,store.js,util.js,stylesheet.css} "$DEST/"
cp "$SRC"/schemas/*.gschema.xml "$DEST/schemas/"
glib-compile-schemas "$DEST/schemas"

echo "Installed to $DEST"
if gnome-extensions info "$UUID" >/dev/null 2>&1; then
  gnome-extensions enable "$UUID" && echo "Enabled. (If you just updated it, log out and back in to reload.)"
else
  echo "GNOME Shell hasn't seen it yet: log out and back in (Wayland), then run:"
  echo "  gnome-extensions enable $UUID"
fi
