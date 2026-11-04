# Questboard — GNOME Shell extension

Clicking the date/time in the top bar opens **Questboard** instead of the stock
notifications/calendar popup, at the same size and position.

- **Eisenhower matrix** (first view): Do first · Schedule · Delegate · Eliminate.
  Type in a quadrant's box + Enter to add a quest. Click a quest's title for actions:
  rename, move quadrant, 25-min focus, schedule into the calendar, duration, delete.
- **Quests**: XP for completing quests (Q2 gives the most, on purpose), levels, a daily
  streak 🔥, quests done today and focus time today in the header.
- **Calendar** (right side): week strip + hour-by-hour day timeline. Google events
  come from **GNOME Online Accounts**. Click an empty half-hour slot to add a quest
  there; scheduled quests appear as colored blocks.
- **Timers**: Pomodoro / break / stopwatch / custom countdowns. Each can be linked to a
  quest and the time is added to that quest. ▶ on any quest row starts its stopwatch.
  The running timer shows next to the clock; you get a notification when it's done.
- The ✉ icon in the header switches to GNOME's notification/calendar view until the
  popup closes.

## Install
```bash
./install.sh
# Wayland: log out and back in, then:
gnome-extensions enable questboard@marci.local
```
Google Calendar: *Settings → Online Accounts → Google*, with **Calendar** turned on.
Settings (size, pomodoro length, …): `gnome-extensions prefs questboard@marci.local`.

Data: `~/.local/share/questboard/data.json`. Every item has an id and `updatedAt`,
and deletions are kept in `deleted[]`, so it's ready for a sync server.

Debug: `journalctl -f -o cat /usr/bin/gnome-shell | grep -i questboard`
