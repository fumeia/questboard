# Data model & sync contract

Implemented identically in `extension/store.js` and `android/.../data/Store.kt`; the server stores records
opaquely. Every record: `{id, updatedAt (ms), deleted?: true, ...}`. Merge = **last writer wins per record**
(higher `updatedAt`; server breaks ties by content). Deletions are tombstones `{id, deleted:true}`, pruned after 60 days.

| Collection | Fields | Notes |
|---|---|---|
| `quests` | title, quadrant `q1..q4`, done, doneAt, createdAt, notes, scheduled `{date, start (min), duration}`, due `{date, time?}`, xp?, quadrantManual?, source?, link?, kind?, topic? | Notion quests: id `notion.<pageid>`; Physics RPG: id `rpg.<course>`, source `physics-rpg` |
| `habits` | title, icon, xp, target (1–7 per week), archived, createdAt | |
| `checkins` | habitId, date | id = `<habitId>.<YYYY-MM-DD>` (deterministic → no duplicates) |
| `rewards` | title, cost, icon, repeatable, redeemedAt? | defaults: ids `reward.*`, `updatedAt: 1` |
| `ledger` | at, amount (±), kind `quest/habit/pomodoro/purchase/bonus/step/rpg`, ref, note | ids: `quest.<questId>`, `habit.<checkinId>`, `pomo.<timerId>.<ms>`, `buy.<uid>`, `rpg.<course>.<YYYY-MM-DD>` / `rpg.<course>.earlier` (game XP per course and day, amount updated in place) |
| `sessions` | questId, kind, start, end, durationMs, date | one per timer run segment |

Derived, never stored: **XP** = sum of positive ledger amounts (→ level: XP to reach level L = 50·L·(L−1));
**coins** = sum of all ledger amounts; **streak** = consecutive days with a quest completion, habit
check-in or Physics RPG XP; **time per quest / focus today** = sum of sessions. Because XP entries have deterministic ids,
completing the same quest on two devices (or in Notion) can never pay twice.

Quadrant XP: Do first 30, Schedule 40, Delegate 15, Eliminate 5 (unless the quest has its own `xp`).
Habit XP: base, ×1.2 from a 3-day streak, ×1.5 from 7 days. Pomodoro: +10.

Device-local (not synced): running timers, reminder bookkeeping, sync cursor, dirty set.

Server API: see the docstring at the top of `server/qb_server.py`.

**Physics RPG XP** is pushed by the game's server (`physics-rpg/deploy/questboard_sync.py`, a timer every 3 min) through
`POST /api/sync` like any device: three quests `rpg.qm`, `rpg.solid-state`, `rpg.astrophysics` (topic = the course) and
ledger entries of kind `rpg`. The bridge only sets topic/source/link/notes on existing quests, so the user's quadrant,
tick, schedule and title survive; a deleted quest is not recreated.
