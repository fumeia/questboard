# Questboard

Eisenhower-matrix quest board + habits + XP rewards shop + Google calendar + focus timers,
on the GNOME desktop (replaces the date/time popup) and on Android, synced through your own server.

| Part | Folder | State |
|---|---|---|
| Sync / dev server (Docker) | `server/` | done, tested (sync, logs, releases, Notion two-way sync) |
| GNOME extension v2 | `extension/` | done, syntax-checked + store/sync tested; not yet run on a real desktop |
| `qb` developer CLI | `tools/qb` | done, tested against the server |
| Android app (Kotlin/Compose) | `android/` | **in progress** — data/sync/notifications/calendar layers written, UI screens next, not built yet |

## Status / next steps (where we stopped)
1. Android: write the Compose UI (`ui/`: MainActivity, Matrix, Habits, Calendar, Timers, Shop, Settings), then build with
   `tools/qb publish android` (JDK + SDK live in `/workspace/.buildtools`, release key in `/workspace/.buildtools/keystore/`).
2. Write the full install/debug/development guide (this README) once the app builds.
3. First real-desktop run of the extension; fix whatever the logs show.

## Quick start (already usable: server + desktop)
```bash
# on the Ubuntu server
cd server && cp .env.example .env   # put a long random QB_TOKEN in it
# optional Notion sync: add NOTION_TOKEN=secret_... to .env (share "Objekte DB" + "Module DB" with the integration)
docker compose up -d --build

# on the desktop (repo root)
sudo apt install gir1.2-ecal-2.0 gir1.2-edataserver-1.2   # needed for editing calendar events
python3 tools/qb install                                    # then log out/in, gnome-extensions enable questboard@marci.local
# Questboard settings → Sync: server URL + token → Test
```
Dev loop: `.qb.env` in the repo root with `QB_URL=` / `QB_TOKEN=`, then `tools/qb status`, `tools/qb logs -f`,
`tools/qb publish extension --bump -m "notes"`. Live log console: `http://<server>:8787/`.
