# Data model & sync contract

Implemented identically in `extension/store.js` and `android/.../data/Store.kt`; the server stores records
opaquely. Every record: `{id, updatedAt (ms), deleted?: true, ...}`. Merge = **last writer wins per record**
(higher `updatedAt`; server breaks ties by content). Deletions are tombstones `{id, deleted:true}`, pruned after 60 days.

| Collection | Fields | Notes |
|---|---|---|
| `quests` | title, quadrant `q1..q4`, done, doneAt, createdAt, notes, scheduled `{date, start (min), duration}`, due `{date, time?}`, xp?, quadrantManual?, source?, link?, kind?, topic?, goalId?, steps? `[{id, title, done, goalId?}]` | Notion quests: id `notion.<pageid>` |
| `goals` | title, notes, icon, targetDate?, done, doneAt, createdAt | long-term; quests link via `goalId`, single steps via `steps[].goalId` |
| `habits` | title, icon, xp, target (1–7 per week), archived, createdAt | |
| `checkins` | habitId, date | id = `<habitId>.<YYYY-MM-DD>` (deterministic → no duplicates) |
| `rewards` | title, cost, icon, repeatable, redeemedAt? | defaults: ids `reward.*`, `updatedAt: 1` |
| `ledger` | at, amount (±), kind `quest/step/habit/pomodoro/goal/purchase/bonus`, ref, note | ids: `quest.<questId>`, `step.<questId>.<stepId>`, `habit.<checkinId>`, `pomo.<timerId>.<ms>`, `goal.<goalId>`, `buy.<uid>` |
| `sessions` | questId, stepId?, kind, start, end, durationMs, date, topic? | one per timer run segment; `stepId` = a step's own timer. `slot.<questId>` (kind `slot`): ticking a quest off credits the passed part of its time slot / linked event not already covered by timer sessions |

Derived, never stored: **XP** = sum of positive ledger amounts (→ level: XP to reach level L = 50·L·(L−1));
**coins** = sum of all ledger amounts; **streak** = consecutive days with a quest completion or habit
check-in; **time per quest / step / focus today** = sum of sessions; **goal progress** = linked quests
(an open quest with steps counts by its finished share) + linked single steps of other quests, goal time = their sessions. Because XP entries have deterministic ids,
completing the same quest on two devices (or in Notion) can never pay twice.

Quadrant XP: Do first 30, Schedule 40, Delegate 15, Eliminate 5 (unless the quest has its own `xp`).
Habit XP: base, ×1.2 from a 3-day streak, ×1.5 from 7 days. Pomodoro: +10. Step: +10. Goal reached: +100.

Device-local (not synced): running timers, reminder bookkeeping, sync cursor, dirty set.

Server API: see the docstring at the top of `server/qb_server.py`.
