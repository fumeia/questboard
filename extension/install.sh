#!/usr/bin/env bash
# Install Questboard into your GNOME Shell (run on the desktop).
set -euo pipefail
cd "$(dirname "$0")/.."
python3 tools/qb install
