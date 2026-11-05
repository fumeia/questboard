# Questboard

A productivity "game" that lives where you already look:

- **Desktop (GNOME):** clicking the date/time in the top bar opens Questboard instead of the stock
  notification/calendar popup. Same place, same size.
- **Phone (Android):** a native app with the same data.
- **Your server (Docker):** keeps both in sync, imports your Notion *Studienplaner*, collects debug logs,
  and hands out app updates.

What's inside:

| Feature | Desktop | Android |
|---|---|---|
| Eisenhower matrix (Do first / Schedule / Delegate / Eliminate) with quests | ✔ | ✔ |
| XP, levels, daily streak | ✔ | ✔ |
| Long-term goals: link whole quests or single steps, progress + time per goal, +100 XP when reached | ✔ | ✔ |
| Steps inside quests, each with its own Pomodoro timer and time tracking | ✔ | ✔ |
| Calendar: pick start + end, then a new quest, a quest from the matrix, or an event; Pomodoros appear as focus blocks | ✔ | ✔ |
| Habits with weekly grid, streak bonus XP (+20 % from 3 days, +50 % from 7) | ✔ | ✔ |
| Rewards shop: spend coins (= XP earned − spent) on default or your own rewards | ✔ | ✔ |
| Google Calendar day view, create / edit / delete events | ✔ (via GNOME Online Accounts) | ✔ (phone calendar) |
| Schedule quests into time slots, due dates, reminders | ✔ | ✔ |
| Timers: Pomodoro, break, stopwatch, countdown — linked to quests | ✔ (top-bar badge) | ✔ (live notification) |
| Notion Studienplaner tasks as quests (two-way, XP by task type) | via server | via server |
| Physics RPG XP as one quest per course (topic = course, counts for the streak) | via server | via server |
| Remote logs, crash reports, self-update | ✔ | ✔ |

```
repo/
├── extension/   GNOME Shell extension (GJS, GNOME 45–50)
├── android/     Android app (Kotlin + Jetpack Compose, Android 8+)
├── server/      Sync + dev server (Python stdlib + SQLite, Docker)
├── tools/qb     Developer CLI: publish updates, tail logs, inspect data
├── tools/gen_icons.py   One icon source → GNOME SVGs + Android vector drawables
└── docs/DATA_MODEL.md   The sync contract shared by all three
```

---

## 1. Server (Ubuntu + Docker) — do this first

```bash
git clone <this repo> questboard && cd questboard/server     # or copy the server/ folder over
cp .env.example .env
python3 -c 'import secrets;print(secrets.token_urlsafe(32))'  # paste the output as QB_TOKEN in .env
docker compose up -d --build
curl http://localhost:8787/api/health                        # → {"ok": true, ...}
```

- Data lives in `server/data/` (SQLite + published releases). Back that folder up. The server keeps only the newest 3 app builds per platform (`QB_KEEP_RELEASES`, set to 0 to keep all).
- Port 8787 can be changed in `docker-compose.yml` (left side of `"8787:8787"`).
- **Reaching it from outside your home network:** easiest is Tailscale on server + laptop + phone, then use
  the server's Tailscale IP. If you already run a reverse proxy (Caddy/Traefik/nginx) for your other
  containers, put Questboard behind it with HTTPS — the token is sent with every request.
- Web console with live logs from all devices: open `http://<server>:8787/` and paste the token.

### 1b. Notion Studienplaner sync (optional)

The server polls your **Objekte DB** (the database behind the Studienplaner's Kanban board and
"Anstehende Leistungen") every 2 minutes.

1. Go to <https://www.notion.so/profile/integrations> → **New integration** → type *Internal* → name
   "Questboard" → copy the **Internal Integration Secret**.
2. In Notion open the **Objekte DB** database itself (Studienplaner → Datenbank → Objekte DB) →
   `•••` → **Connections** → add "Questboard". Do the same for **Module DB** (needed for module names).
3. Add to `server/.env`:
   ```
   NOTION_TOKEN=ntn_...your secret...
   ```
4. `docker compose up -d` (recreates the container). Within ~2 minutes your open Übungsblätter,
   Prüfungen, Präsentationen, Projekte and Hausarbeiten appear as quests, e.g. "Analysis II · Übungsblatt 5".

How it maps (change it by copying `server/notion.json` to `server/data/notion.json` and editing):

| Notion | Questboard |
|---|---|
| `Titel` + `Modul` | quest title "Modul · Titel" |
| `Zieldatum` | due date (chip "today", "in 2d", deadline chip in the calendar) |
| `Status` = 🏆 Completed / Resolved / No action | done (XP once) |
| `Type` | XP: Prüfung 100, Projekt/Hausarbeit 80, Präsentation 60, Übungsblatt 40 |
| due within 3 days, or Status Off Track / ⚠️ At Risk | **Do first**, otherwise **Schedule** — re-sorted automatically as deadlines approach (unless you moved it by hand) |

Ticking a quest in Questboard sets the Notion status to 🏆 Completed (unticking → Not started);
renaming or changing the due date is written back too. Deleting a Notion quest in Questboard only hides it
from Questboard — it never deletes anything in Notion. `Termin` and `Thema` entries are not imported.

### 1c. Physics RPG XP (optional)

If the Physics RPG (github.com/fumeia/physics-rpg) runs on the same server, its XP shows up here as three quests,
"Physics RPG · Quantenmechanik / Festkörperphysik / Astrophysik", each with its course as topic, and the game's XP per
course and day in the XP total (a day with game XP also keeps the streak alive). On the server:
```
sudo bash /opt/physics-rpg/deploy/questboard-setup.sh
```
It finds `~/questboard-server/.env` by itself (token + port), tests the connection and sends every 3 minutes. Topic names
are in `/etc/physics-rpg/questboard.env`. Nothing in this server changes; the game talks to `/api/sync` like a device.

---

## 2. Desktop (GNOME, Ubuntu)

```bash
sudo apt install gir1.2-ecal-2.0 gir1.2-edataserver-1.2   # lets Questboard edit calendar events
cd questboard
python3 tools/qb install                                  # packs + installs the extension
```
`qb install` also enables it. Log out and back in (required on Wayland) and it's active.
(Don't use `gnome-extensions enable` right after installing: on Wayland the running shell doesn't know the
new extension yet and answers "does not exist".) To try it without logging out, run a nested shell in a
window: `dbus-run-session -- gnome-shell --devkit` (GNOME 49+) or `--nested --wayland` (45–48).

**Google Calendar:** Settings → Online Accounts → Google → make sure **Calendar** is on. Questboard reads
and writes the same calendars GNOME uses — there is no separate Google login.

**Connect to the server:** click the clock → ⚙ (settings) → **Sync** tab → Server URL
(e.g. `http://192.168.1.20:8787`) and Token → press Enter in each field → **Test**.

Using it:
- Matrix is the first view. Type into a quadrant's "Add quest…" box + Enter. Click a quest title for
  actions: rename, notes, move quadrant, 25-min focus, schedule, due date, open in Notion, delete.
- Habit strip above the matrix: one click = today's check-in. Full habit management in the **Habits** tab.
- **Shop:** click the coin counter. "Redeem" twice to buy; undo within 24 h.
- **Calendar (right):** click an empty half-hour to add a quest or an event there; click an event to edit;
  `+` for a new event with all options.
- The inbox icon switches to GNOME's normal notifications until the popup closes.

Light on resources: it runs inside GNOME Shell (no extra process), does nothing while the popup is closed
except a 30-second reminder check and a sync every 2 minutes; the calendar helper process only runs for
the second it takes to save an event.

---

## 3. Android

**First install** (one time; later updates install from inside the app):
1. Build/publish the APK (from the development machine): `tools/qb publish android -m "first build"`.
2. On the phone open `http://<server>:8787/api/releases/android/download?token=<QB_TOKEN>` in the browser,
   download, and allow "Install unknown apps" for the browser when asked.
   (Alternative: `adb install android/app/build/outputs/apk/release/app-release.apk`.)
3. Open Questboard → allow **Calendar** and **Notifications**.
4. Tap the bug icon (top right) → Server URL + Token → **Save & test**.

Your phone's Google account must sync calendars (Android Settings → Accounts → Google → Calendar on).

Updates: when a new APK is published the app notifies you; Settings → **Install** downloads, verifies the
checksum and opens Android's install prompt. (Allow "Install unknown apps" for Questboard the first time.)

---

## 4. Debugging

| Where | How |
|---|---|
| All devices, live | `tools/qb logs -f` (filters: `--level warn`, `--platform android`, `--device desk`, `--grep sync`) |
| All devices, browser | `http://<server>:8787/` |
| Device overview | `tools/qb status` — last seen, last sync, version per device; published versions |
| Synced data | `tools/qb state quests` (or habits, ledger, rewards, sessions, checkins) |
| Desktop, local | `journalctl -f -o cat /usr/bin/gnome-shell \| grep -i questboard` and `~/.local/share/questboard/questboard.log` |
| Desktop calendar helper | `gjs -m ~/.local/share/gnome-shell/extensions/questboard@marci.local/eds-helper.js '{"cmd":"list"}'` |
| Android, on device | bug icon → log at the bottom; "Send logs now" |
| Android, USB | `adb logcat -s Questboard` |
| Server | `docker logs -f questboard` |

- Every button handler is wrapped: an exception shows up as an `ERROR [ui:...]` log line with a stack
  instead of silently breaking the UI. Android crashes are saved and sent on the next start (`[crash]`).
- Both clients log a heartbeat every 30 min (desktop includes GNOME Shell memory use `rssMb`).
- Log level (desktop): Settings → Debug → Log level `debug` for more detail.
- Data files: desktop `~/.local/share/questboard/data.json`, Android app-private `data.json`.
  A file that fails to parse is moved aside (`data.json.corrupt-…`), never overwritten.

---

## 5. Developing / pushing updates

One-time on your laptop: **`tools/qb login`** — saves the server URL + token to
`~/.config/questboard/qb.env`, outside the project folder (so nothing working inside the project,
including Claude, can read them). `tools/deploy-server.sh` already does this for you.

```bash
tools/qb publish extension --bump -m "what changed"   # zips + uploads; desktops install it automatically
tools/qb publish android   --bump -m "what changed"   # builds a signed release APK + uploads; phone offers it
tools/qb logs -f                                      # watch what happens on the devices
```

- Desktop: auto-update runs `gnome-extensions install --force`; the new version loads after the next
  log-out/in (a GNOME Wayland limitation). For quick UI iteration without logging out use a nested
  shell: `dbus-run-session -- gnome-shell --devkit` (GNOME 49+) or `--nested --wayland` (older).
- Android builds need JDK 17 + Android SDK; in the Claude container they are in `/workspace/.buildtools`
  and `tools/qb` finds them automatically. Elsewhere: install Android Studio or set `JAVA_HOME` /
  `ANDROID_HOME`.
- **Signing key:** `/workspace/.buildtools/keystore/questboard-release.jks` (+ `keystore.properties`).
  **Back it up.** Android only installs updates signed with the same key; losing it means uninstalling
  the app once (data stays on the server).
- Icons: edit `tools/gen_icons.py`, run it — regenerates GNOME SVGs, Android drawables and the Kotlin map.
- Data model changes: update `extension/store.js`, `android/.../data/Store.kt` and `docs/DATA_MODEL.md`
  together. Unknown fields survive round-trips, so adding fields is safe.
- Tests: `tests/run.sh` (node + python3 only) — two simulated devices syncing through a real server
  (XP, habits, timers, purchases, conflicts, deletes) and the Notion two-way sync against a mock Notion API.
  Run it after touching `store.js`, the server or `notion_sync.py`.
- Run the server locally without Docker: `QB_TOKEN=$(openssl rand -hex 16) QB_DATA=/tmp/qb python3 server/qb_server.py`.

### Working on this with Claude (privacy)
Claude only sees the project folder. Secrets and personal data stay outside it:

| Lives | Where | Claude can see it? |
|---|---|---|
| Server URL + token (laptop) | `~/.config/questboard/`, GNOME settings | no |
| Synced quests, habits, logs | your server | no (no credentials) |
| Google account / events | GNOME Online Accounts, Android | no |
| Code, builds (`dist/`, APK) | project folder | yes |

Update loop: Claude changes code and builds → you run `tools/qb publish extension --bump` /
`tools/qb publish android --bump` in your own terminal → devices update. When something breaks, tell Claude
what you see, or run `tools/qb logs --level warn` yourself and share only what you want to share.
Calendar problems: `gjs -m ~/.local/share/gnome-shell/extensions/questboard@marci.local/eds-helper.js '{"cmd":"diag","connect":true}'`
prints counts and timings only — no calendar names or e-mail addresses.

---

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| Clock popup unchanged | `gnome-extensions info questboard@marci.local` — enabled? Log out/in after install. Check journal for errors. |
| "Calendar editing needs two system packages" | `sudo apt install gir1.2-ecal-2.0 gir1.2-edataserver-1.2` |
| No events shown (desktop) | Online Accounts → Google → Calendar switch on; open GNOME Calendar once. |
| Sync icon red | Settings → Test. 401 = wrong token; timeout = URL/port/firewall (`sudo ufw allow 8787/tcp`). |
| Notion tasks don't appear | `tools/qb logs --grep notion`; usually the database isn't shared with the integration (step 1b.2). |
| Android: no timer notification | Allow notifications; on Android 14 also allow "Alarms & reminders" for exact timer ends. |
| Android update won't install | Allow "Install unknown apps" for Questboard; APK must be signed with the same key. |
