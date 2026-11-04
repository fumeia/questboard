#!/usr/bin/env bash
# Runs the store/sync and Notion integration tests (needs node + python3, nothing else).
set -euo pipefail
cd "$(dirname "$0")"
T=$(mktemp -d); trap 'kill $SRV 2>/dev/null; rm -rf "$T"' EXIT
export T QB_TOKEN=testtoken_testtoken QB_URL=http://127.0.0.1:18787
# 1) desktop store + real server, two simulated devices
mkdir -p build/mock
cp ../extension/store.js ../extension/util.js build/
cp mock_glib.js build/mock/glib.js; cp mock_empty.js build/mock/empty.js
sed -i "s#'gi://GLib'#'./mock/glib.js'#; s#'gi://\(Clutter\|Gio\|Pango\|St\)'#'./mock/empty.js'#" build/store.js build/util.js
QB_DATA=$T/srv QB_PORT=18787 python3 ../server/qb_server.py >/dev/null 2>&1 & SRV=$!
mkdir -p $T/srv
for i in $(seq 30); do curl -sf $QB_URL/api/health >/dev/null && break; python3 -c 'import time;time.sleep(0.2)'; done
QB_DIR=$T node sync_test.mjs
# 2) Notion two-way sync against a mock Notion API
mkdir -p $T/notion && python3 notion_test.py ../server $T/notion 2>&1 | grep -v '^INFO'
rm -rf build
