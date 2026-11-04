# Data model & sync contract

Implemented identically in `extension/store.js` and `android/.../data/Store.kt`; the server stores records
opaquely. Every record: `{id, updatedAt (ms), deleted?: true, ...}`. Merge = **last writer wins per record**
(higher `updatedAt`; server breaks ties by content). Deletions are tombstones `{id, deleted:true}`, pruned after 60 days.

| Collection | Fields | Notes |
|---|---|---|
| `quests` | title, quadrant `q1..q4`, done, doneAt, createdAt, notes, scheduled `{date, start (min), duration}`, due `{date, time?}`, xp?, quadrantManual?, source?, link?, kind? | Notion quests: id `notion.<pageid>` |
| `habits` | title, icon, xp, target (1–7 per week), archived, createdAt | |
| `checkins` | habitId, date | id = `<habitId>.<YYYY-MM-DD>` (deterministic → no duplicates) |
| `rewards` | title, cost, icon, repeatable, redeemedAt? | defaults: ids `reward.*`, `updatedAt: 1` |
| `ledger` | at, amount (±), kind `quest/habit/pomodoro/purchase/bonus`, ref, note | ids: `quest.<questId>`, `habit.<checkinId>`, `pomo.<timerId>.<ms>`, `buy.<uid>` |
| `sessions` | questId, kind, start, end, durationMs, date | one per timer run segment |

Derived, never stored: **XP** = sum of positive ledger amounts (→ level: XP to reach level L = 50·L·(L−1));
**coins** = sum of all ledger amounts; **streak** = consecutive days with a quest completion or habit
check-in; **time per quest / focus today** = sum of sessions. Because XP entries have deterministic ids,
completing the same quest on two devices (or in Notion) can never pay twice.

Quadrant XP: Do first 30, Schedule 40, Delegate 15, Eliminate 5 (unless the quest has its own `xp`).
Habit XP: base, ×1.2 from a 3-day streak, ×1.5 from 7 days. Pomodoro: +10.

Device-local (not synced): running timers, reminder bookkeeping, sync cursor, dirty set.

Server API: see the docstring at the top of `server/qb_server.py`.
