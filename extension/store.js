// Questboard data model (v2) — shared contract with the Android app, see docs/DATA_MODEL.md.
//
// Synced collections hold records {id, updatedAt, deleted?, ...}. They merge with
// last-writer-wins per record through the sync server. XP, coin balance, streaks
// and time-per-quest are *derived* from append-only records (ledger, sessions,
// checkins), so concurrent edits on phone and desktop never double-count.
//
// Timers are device-local live state and are not synced; when a timer pauses
// or finishes, the time it ran becomes a synced `sessions` record.

import GLib from 'gi://GLib';

import {dateKey} from './util.js';

export const QUADRANTS = [
    {id: 'q1', title: 'Do first', short: 'Do', subtitle: 'Urgent · Important', xp: 30},
    {id: 'q2', title: 'Schedule', short: 'Plan', subtitle: 'Important · Not urgent', xp: 40},
    {id: 'q3', title: 'Delegate', short: 'Delegate', subtitle: 'Urgent · Not important', xp: 15},
    {id: 'q4', title: 'Eliminate', short: 'Drop', subtitle: 'Not urgent · Not important', xp: 5},
];

export const COLLECTIONS = ['quests', 'habits', 'checkins', 'rewards', 'ledger', 'sessions'];
export const POMODORO_XP = 10;
export const STEP_XP = 10;
/** Finishing every step of a group pays the quest XP plus this share as a bonus. */
export const GROUP_BONUS = 0.5;
export const groupBonus = q => Math.max(10, Math.round(questXp(q) * GROUP_BONUS));
export const PICKABLE_ICONS = ['star', 'heart', 'book', 'dumbbell', 'drop', 'moon', 'music', 'game', 'film',
    'pizza', 'leaf', 'bolt', 'coffee', 'gift', 'target', 'trophy', 'sparkle', 'flame', 'shield', 'repeat'];

// Deterministic ids + updatedAt=1 so every device seeds the *same* records and
// any real edit wins.
const DEFAULT_REWARDS = [
    ['reward.coffee', 'Fancy coffee or a treat', 60, 'coffee'],
    ['reward.episode', 'Watch an episode', 80, 'film'],
    ['reward.gaming', 'One hour of gaming', 120, 'game'],
    ['reward.movie', 'Movie night', 250, 'star'],
    ['reward.takeout', 'Order takeout', 300, 'pizza'],
    ['reward.lazyday', 'Guilt-free lazy day', 800, 'moon'],
    ['reward.purchase', 'Buy something nice', 1500, 'gift'],
];

const quadXp = id => QUADRANTS.find(q => q.id === id)?.xp ?? 10;
/** Quests may carry their own XP (e.g. Notion exams); otherwise the quadrant decides. */
export const questXp = q => (q.xp > 0 ? q.xp : quadXp(q.quadrant));

/** Days until a quest's due date (negative = overdue), or null. */
export function dueInDays(q, now = new Date()) {
    if (!q?.due?.date)
        return null;
    const [y, m, d] = q.due.date.split('-').map(Number);
    const due = new Date(y, m - 1, d);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((due - today) / 86400000);
}
const DAY_MS = 86400000;
const TOMBSTONE_TTL = 60 * DAY_MS;

/** XP needed to *reach* level L is 50·L·(L-1): 0, 100, 300, 600, 1000 … */
export function levelInfo(xp) {
    let level = 1;
    while (50 * (level + 1) * level <= xp)
        level++;
    const base = 50 * level * (level - 1);
    const next = 50 * (level + 1) * level;
    return {level, into: xp - base, span: next - base, frac: (xp - base) / (next - base)};
}

export function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Habit check-in XP: base, +20 % from a 3-day streak, +50 % from 7 days. */
export function habitXp(base, streakIncludingToday) {
    if (streakIncludingToday >= 7)
        return Math.round(base * 1.5);
    if (streakIncludingToday >= 3)
        return Math.round(base * 1.2);
    return base;
}

const emptyColls = () => Object.fromEntries(COLLECTIONS.map(c => [c, {}]));

const emptyData = () => ({
    version: 2,
    deviceId: `desk-${uid()}`,
    cursor: 0,
    dirty: {}, // "coll/id" -> updatedAt that still needs pushing
    colls: emptyColls(),
    timers: [],
    reminded: {},
    seeded: false,
});

export class Store {
    constructor({log = null} = {}) {
        this._log = log;
        this._dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'questboard']);
        this._path = GLib.build_filenamev([this._dir, 'data.json']);
        this._listeners = new Set();
        this._saveId = 0;
        this._cache = null;
        this.data = this._load();
        this._seedDefaults();
    }

    // ---- persistence -----------------------------------------------------

    _load() {
        let bytes;
        try {
            [, bytes] = GLib.file_get_contents(this._path);
        } catch {
            return emptyData();
        }
        let d;
        try {
            d = JSON.parse(new TextDecoder().decode(bytes));
        } catch (e) {
            const backup = `${this._path}.corrupt-${Date.now()}`;
            GLib.rename(this._path, backup);
            this._log?.error('store', `could not parse data, moved to ${backup}`, {err: String(e)});
            return emptyData();
        }
        if (!d.version || d.version < 2)
            return this._migrateV1(d);
        const base = emptyData();
        return {
            ...base,
            ...d,
            colls: {...emptyColls(), ...(d.colls ?? {})},
            timers: Array.isArray(d.timers) ? d.timers : [],
            dirty: d.dirty ?? {},
            reminded: d.reminded ?? {},
        };
    }

    _migrateV1(old) {
        const d = emptyData();
        const now = Date.now();
        const mark = (c, r) => {
            d.colls[c][r.id] = r;
            d.dirty[`${c}/${r.id}`] = r.updatedAt;
        };
        for (const q of old.quests ?? []) {
            mark('quests', {
                id: q.id, title: q.title, quadrant: q.quadrant, done: !!q.done, doneAt: q.doneAt ?? null,
                createdAt: q.createdAt ?? now, scheduled: q.scheduled ?? null, notes: '', updatedAt: now,
            });
            if (q.timeSpentMs > 0) {
                mark('sessions', {id: uid(), questId: q.id, kind: 'stopwatch', start: now - q.timeSpentMs,
                    end: now, durationMs: q.timeSpentMs, date: dateKey(), updatedAt: now});
            }
            if (q.done && q.xpAwarded) {
                mark('ledger', {id: `quest.${q.id}`, at: q.doneAt ?? now, amount: q.xpAwarded, kind: 'quest',
                    ref: q.id, note: q.title, updatedAt: now});
            }
        }
        const questXp = Object.values(d.colls.ledger).reduce((s, l) => s + l.amount, 0);
        if ((old.xp ?? 0) > questXp) {
            mark('ledger', {id: `import.${d.deviceId}`, at: now, amount: old.xp - questXp, kind: 'bonus',
                note: 'Imported XP', updatedAt: now});
        }
        d.timers = (old.timers ?? []).filter(t => !t.startedAt);
        this._log?.info('store', 'migrated v1 data', {quests: (old.quests ?? []).length});
        GLib.file_set_contents(`${this._path}.v1-backup`, JSON.stringify(old));
        return d;
    }

    _seedDefaults() {
        if (this.data.seeded)
            return;
        for (const [id, title, cost, icon] of DEFAULT_REWARDS) {
            if (!this.data.colls.rewards[id]) {
                this.data.colls.rewards[id] = {id, title, cost, icon, repeatable: true, createdAt: 1, updatedAt: 1};
                this.data.dirty[`rewards/${id}`] = 1;
            }
        }
        this.data.seeded = true;
        this._scheduleSave();
    }

    _write() {
        try {
            GLib.mkdir_with_parents(this._dir, 0o700);
            GLib.file_set_contents(this._path, JSON.stringify(this.data));
        } catch (e) {
            this._log?.error('store', `save failed: ${e}`);
        }
    }

    _scheduleSave() {
        if (this._saveId)
            return;
        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._saveId = 0;
            this._write();
            return GLib.SOURCE_REMOVE;
        });
    }

    flush() {
        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._saveId = 0;
        }
        this._write();
    }

    destroy() {
        this.flush();
        this._listeners.clear();
    }

    subscribe(fn) {
        this._listeners.add(fn);
        return () => this._listeners.delete(fn);
    }

    _changed({local = true} = {}) {
        this._cache = null;
        this._scheduleSave();
        for (const fn of [...this._listeners]) {
            try {
                fn({local});
            } catch (e) {
                this._log?.error('store', `listener error: ${e}`, {stack: e.stack});
            }
        }
    }

    // ---- generic records -------------------------------------------------

    get(coll, id) {
        const r = this.data.colls[coll][id];
        return r && !r.deleted ? r : null;
    }

    all(coll) {
        return Object.values(this.data.colls[coll]).filter(r => !r.deleted);
    }

    /** Write a record and mark it for sync. Does not notify; call _changed(). */
    _put(coll, rec) {
        const old = this.data.colls[coll][rec.id];
        rec.updatedAt = Math.max(Date.now(), (old?.updatedAt ?? 0) + 1);
        this.data.colls[coll][rec.id] = rec;
        this.data.dirty[`${coll}/${rec.id}`] = rec.updatedAt;
        return rec;
    }

    _del(coll, id) {
        if (this.data.colls[coll][id] && !this.data.colls[coll][id].deleted)
            this._put(coll, {id, deleted: true});
    }

    _patch(coll, id, patch) {
        const r = this.get(coll, id);
        if (!r)
            return null;
        return this._put(coll, {...r, ...patch});
    }

    // ---- sync hooks --------------------------------------------------------

    get deviceId() {
        return this.data.deviceId;
    }

    get cursor() {
        return this.data.cursor;
    }

    dirtyCount() {
        return Object.keys(this.data.dirty).length;
    }

    /** Snapshot of records to push + the marks they correspond to. */
    collectDirty(max = 2000) {
        const changes = [];
        const marks = {};
        for (const [key, at] of Object.entries(this.data.dirty)) {
            if (changes.length >= max)
                break;
            const slash = key.indexOf('/');
            const c = key.slice(0, slash);
            const id = key.slice(slash + 1);
            const r = this.data.colls[c]?.[id];
            if (!r) {
                delete this.data.dirty[key];
                continue;
            }
            changes.push({c, r});
            marks[key] = at;
        }
        return {changes, marks};
    }

    /** Merge a server response. Records we changed again mid-flight stay dirty. */
    applyRemote(changes, cursor, marks = {}) {
        let touched = 0;
        for (const [key, at] of Object.entries(marks))
            if (this.data.dirty[key] === at)
                delete this.data.dirty[key];
        for (const {c, r} of changes) {
            if (!this.data.colls[c] || !r?.id)
                continue;
            const local = this.data.colls[c][r.id];
            if (this.data.dirty[`${c}/${r.id}`] && local && local.updatedAt > r.updatedAt)
                continue; // our newer edit will be pushed next round
            if (!local || r.updatedAt >= local.updatedAt) {
                if (!local || JSON.stringify(local) !== JSON.stringify(r)) {
                    this.data.colls[c][r.id] = r;
                    touched++;
                }
            }
        }
        this.data.cursor = Math.max(this.data.cursor, cursor ?? 0);
        this._pruneTombstones();
        this._changed({local: false});
        return touched;
    }

    _pruneTombstones() {
        const cutoff = Date.now() - TOMBSTONE_TTL;
        for (const c of COLLECTIONS) {
            for (const [id, r] of Object.entries(this.data.colls[c])) {
                if (r.deleted && r.updatedAt < cutoff && !this.data.dirty[`${c}/${id}`])
                    delete this.data.colls[c][id];
            }
        }
    }

    // ---- derived (cached until next change) ------------------------------

    _derived() {
        if (this._cache)
            return this._cache;
        let lifetime = 0, balance = 0;
        const doneByDay = {}, activeDays = new Set(), questMs = {}, focusByDay = {};
        for (const l of this.all('ledger')) {
            balance += l.amount;
            if (l.amount > 0)
                lifetime += l.amount;
            const day = dateKey(new Date(l.at));
            if (l.kind === 'quest') {
                doneByDay[day] = (doneByDay[day] ?? 0) + 1;
                activeDays.add(day);
            } else if (l.kind === 'habit') {
                activeDays.add(day);
            }
        }
        for (const s of this.all('sessions')) {
            if (s.questId)
                questMs[s.questId] = (questMs[s.questId] ?? 0) + s.durationMs;
            if (s.kind !== 'break')
                focusByDay[s.date] = (focusByDay[s.date] ?? 0) + s.durationMs;
        }
        const checkins = new Set(this.all('checkins').map(c => c.id));
        this._cache = {lifetime, balance, doneByDay, activeDays, questMs, focusByDay, checkins};
        return this._cache;
    }

    get xp() {
        return this._derived().lifetime;
    }

    get balance() {
        return this._derived().balance;
    }

    completedOn(key = dateKey()) {
        return this._derived().doneByDay[key] ?? 0;
    }

    focusOn(key = dateKey(), now = Date.now()) {
        let ms = this._derived().focusByDay[key] ?? 0;
        if (key === dateKey())
            for (const t of this.runningTimers())
                if (t.kind !== 'break')
                    ms += this._liveSegment(t, now);
        return ms;
    }

    /** Consecutive days with a completed quest or habit check-in. */
    streak() {
        const days = this._derived().activeDays;
        const d = new Date();
        if (!days.has(dateKey(d)))
            d.setDate(d.getDate() - 1);
        let n = 0;
        while (days.has(dateKey(d))) {
            n++;
            d.setDate(d.getDate() - 1);
        }
        return n;
    }

    // ---- quests ----------------------------------------------------------

    get quests() {
        return this.all('quests');
    }

    getQuest(id) {
        return this.get('quests', id);
    }

    openQuests() {
        return this.quests.filter(q => !q.done).sort((a, b) => a.createdAt - b.createdAt);
    }

    visibleQuests(quadrant) {
        const today = dateKey();
        // due soonest first, then oldest
        const order = q => (q.due?.date ? new Date(`${q.due.date}T00:00`).getTime() : 8.64e15);
        const inQ = this.quests.filter(q => q.quadrant === quadrant).sort((a, b) => order(a) - order(b) || a.createdAt - b.createdAt);
        return [
            ...inQ.filter(q => !q.done),
            ...inQ.filter(q => q.done && q.doneAt && dateKey(new Date(q.doneAt)) === today),
        ];
    }

    archivedCount() {
        const today = dateKey();
        return this.quests.filter(q => q.done && (!q.doneAt || dateKey(new Date(q.doneAt)) !== today)).length;
    }

    addQuest(title, quadrant = 'q1', scheduled = null, extra = {}) {
        title = (title ?? '').trim();
        if (!title)
            return null;
        const q = this._put('quests', {
            id: uid(), title, quadrant, done: false, doneAt: null, createdAt: Date.now(), scheduled, notes: '', due: null, ...extra,
        });
        this._changed();
        return q;
    }

    updateQuest(id, patch) {
        if ('quadrant' in patch)
            patch = {...patch, quadrantManual: true}; // the Notion sync won't re-sort it
        if (this._patch('quests', id, patch)) {
            if ('scheduled' in patch)
                delete this.data.reminded[id];
            this._changed();
        }
    }

    setDone(id, done) {
        const q = this.getQuest(id);
        if (!q || q.done === done)
            return;
        const now = Date.now();
        if (done) {
            for (const t of this.data.timers)
                if (t.questId === id && t.startedAt)
                    this._credit(t, now);
            // Ticking a group ticks all its steps (each pays STEP_XP) and adds the group bonus.
            const steps = (q.steps ?? []).map(st => ({...st}));
            for (const st of steps) {
                if (!st.done) {
                    st.done = true;
                    this._put('ledger', {id: `step.${id}.${st.id}`, at: now, amount: STEP_XP, kind: 'step', ref: id, note: st.title});
                }
            }
            this._patch('quests', id, {done: true, doneAt: now, ...(steps.length ? {steps} : {})});
            const bonus = steps.length ? groupBonus(q) : 0;
            this._put('ledger', {id: `quest.${id}`, at: now, amount: questXp(q) + bonus, kind: 'quest', ref: id,
                note: bonus ? `${q.title} (+${bonus} group bonus)` : q.title});
        } else {
            this._patch('quests', id, {done: false, doneAt: null});
            this._del('ledger', `quest.${id}`);
        }
        this._changed();
    }

    // ---- steps (a quest with steps is a "group") ---------------------------

    addStep(questId, title) {
        const q = this.getQuest(questId);
        title = (title ?? '').trim();
        if (!q || !title)
            return;
        const steps = [...(q.steps ?? []), {id: uid(), title, done: false}];
        // adding a step to a finished quest re-opens it
        this._patch('quests', questId, {steps, ...(q.done ? {done: false, doneAt: null} : {})});
        if (q.done)
            this._del('ledger', `quest.${questId}`);
        this._changed();
    }

    toggleStep(questId, stepId) {
        const q = this.getQuest(questId);
        if (!q)
            return;
        const now = Date.now();
        const steps = (q.steps ?? []).map(st => ({...st}));
        const st = steps.find(x => x.id === stepId);
        if (!st)
            return;
        st.done = !st.done;
        if (st.done)
            this._put('ledger', {id: `step.${questId}.${stepId}`, at: now, amount: STEP_XP, kind: 'step', ref: questId, note: st.title});
        else
            this._del('ledger', `step.${questId}.${stepId}`);
        const allDone = steps.length > 0 && steps.every(x => x.done);
        if (allDone && !q.done) {
            this._patch('quests', questId, {steps});
            this._changed();
            this.setDone(questId, true); // pays quest XP + group bonus
            return;
        }
        if (!st.done && q.done) {
            this._patch('quests', questId, {steps, done: false, doneAt: null});
            this._del('ledger', `quest.${questId}`);
        } else {
            this._patch('quests', questId, {steps});
        }
        this._changed();
    }

    renameStep(questId, stepId, title) {
        const q = this.getQuest(questId);
        title = (title ?? '').trim();
        if (!q || !title)
            return;
        this._patch('quests', questId, {steps: (q.steps ?? []).map(st => (st.id === stepId ? {...st, title} : st))});
        this._changed();
    }

    deleteStep(questId, stepId) {
        const q = this.getQuest(questId);
        if (!q)
            return;
        this._patch('quests', questId, {steps: (q.steps ?? []).filter(st => st.id !== stepId)});
        this._changed(); // XP already earned for that step stays
    }

    stepProgress(q) {
        const steps = q?.steps ?? [];
        return {done: steps.filter(s => s.done).length, total: steps.length};
    }

    deleteQuest(id) {
        const now = Date.now();
        for (const t of this.data.timers) {
            if (t.questId !== id)
                continue;
            if (t.startedAt)
                this._credit(t, now);
            t.questId = null;
        }
        this._del('quests', id); // earned XP stays in the ledger
        this._changed();
    }

    clearCompleted() {
        for (const q of this.quests.filter(x => x.done)) {
            for (const t of this.data.timers)
                if (t.questId === q.id)
                    t.questId = null;
            this._del('quests', q.id);
        }
        this._changed();
    }

    questTimeMs(q, now = Date.now()) {
        let ms = this._derived().questMs[q.id] ?? 0;
        for (const t of this.data.timers)
            if (t.questId === q.id && t.startedAt)
                ms += this._liveSegment(t, now);
        return ms;
    }

    isQuestRunning(id) {
        return this.data.timers.some(t => t.questId === id && t.startedAt);
    }

    /** Open quests due on a given day (shown as deadline chips in the calendar). */
    dueOn(key) {
        return this.openQuests().filter(q => q.due?.date === key);
    }

    /** Quests whose scheduled start has just been reached (for reminders). */
    dueReminders(now = Date.now()) {
        const out = [];
        const today = dateKey(new Date(now));
        const mins = new Date(now).getHours() * 60 + new Date(now).getMinutes();
        for (const q of this.openQuests()) {
            const s = q.scheduled;
            if (!s || s.date !== today || mins < s.start || mins > s.start + 10)
                continue;
            const key = `${s.date}@${s.start}`;
            if (this.data.reminded[q.id] === key)
                continue;
            this.data.reminded[q.id] = key;
            out.push(q);
        }
        if (out.length)
            this._scheduleSave();
        return out;
    }

    // ---- topics & stats ----------------------------------------------------

    /** All topics in use (quests + past sessions), most recently used first. */
    topics() {
        const seen = new Map();
        for (const q of this.quests)
            if (q.topic)
                seen.set(q.topic, Math.max(seen.get(q.topic) ?? 0, q.updatedAt ?? 0));
        for (const s of this.all('sessions'))
            if (s.topic)
                seen.set(s.topic, Math.max(seen.get(s.topic) ?? 0, s.end ?? 0));
        return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
    }

    /**
     * Stats for the last `days` days (0 = all time).
     * Session time is attributed to the topic stored on the session, falling back
     * to the quest's current topic (older sessions), then "No topic".
     */
    stats(days = 7, now = new Date()) {
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const from = days > 0 ? dateKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - days + 1)) : '';
        const inRange = key => !from || key >= from;
        const byTopic = new Map();
        const byQuest = new Map();
        let focusMs = 0, pomodoros = 0;
        for (const s of this.all('sessions')) {
            if (s.kind === 'break' || !inRange(s.date))
                continue;
            focusMs += s.durationMs;
            const q = s.questId ? this.data.colls.quests[s.questId] : null;
            const topic = s.topic || (q && !q.deleted ? q.topic : null) || 'No topic';
            byTopic.set(topic, (byTopic.get(topic) ?? 0) + s.durationMs);
            if (s.questId)
                byQuest.set(s.questId, (byQuest.get(s.questId) ?? 0) + s.durationMs);
        }
        let xp = 0, questsDone = 0, habitChecks = 0;
        for (const l of this.all('ledger')) {
            const key = dateKey(new Date(l.at));
            if (!inRange(key))
                continue;
            if (l.amount > 0)
                xp += l.amount;
            if (l.kind === 'quest')
                questsDone++;
            else if (l.kind === 'habit')
                habitChecks++;
            else if (l.kind === 'pomodoro')
                pomodoros++;
        }
        // last 7 days, always (for the bar chart)
        const daily = [];
        const d = this._derived();
        for (let i = 6; i >= 0; i--) {
            const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
            const k = dateKey(day);
            daily.push({date: k, focusMs: d.focusByDay[k] ?? 0, done: d.doneByDay[k] ?? 0});
        }
        // best streak over all time
        const daysSorted = [...d.activeDays].sort();
        let best = 0, run = 0, prev = null;
        for (const k of daysSorted) {
            const cur = new Date(`${k}T12:00`);
            run = prev && Math.round((cur - prev) / 86400000) === 1 ? run + 1 : 1;
            best = Math.max(best, run);
            prev = cur;
        }
        const titles = id => this.data.colls.quests[id]?.title ?? '(deleted quest)';
        return {
            focusMs, xp, questsDone, habitChecks, pomodoros,
            byTopic: [...byTopic.entries()].map(([topic, ms]) => ({topic, ms})).sort((a, b) => b.ms - a.ms),
            topQuests: [...byQuest.entries()].map(([id, ms]) => ({id, title: titles(id), ms})).sort((a, b) => b.ms - a.ms).slice(0, 5),
            daily, streak: this.streak(), bestStreak: best,
        };
    }

    // ---- habits ----------------------------------------------------------

    habits() {
        return this.all('habits').filter(h => !h.archived).sort((a, b) => (a.order ?? a.createdAt) - (b.order ?? b.createdAt));
    }

    addHabit(title, icon = 'star', xp = 10, target = 7) {
        title = (title ?? '').trim();
        if (!title)
            return null;
        const h = this._put('habits', {id: uid(), title, icon, xp: Math.max(1, xp | 0), target: Math.min(7, Math.max(1, target | 0)),
            createdAt: Date.now(), archived: false});
        this._changed();
        return h;
    }

    updateHabit(id, patch) {
        if (this._patch('habits', id, patch))
            this._changed();
    }

    deleteHabit(id) {
        this._del('habits', id); // check-ins & XP history stay
        this._changed();
    }

    isChecked(habitId, key = dateKey()) {
        return this._derived().checkins.has(`${habitId}.${key}`);
    }

    /** Consecutive checked days ending today (or yesterday if today is open). */
    habitStreak(habitId) {
        const d = new Date();
        if (!this.isChecked(habitId, dateKey(d)))
            d.setDate(d.getDate() - 1);
        let n = 0;
        while (this.isChecked(habitId, dateKey(d))) {
            n++;
            d.setDate(d.getDate() - 1);
        }
        return n;
    }

    /** Check-ins in the Monday-based week containing `day`. */
    habitWeekCount(habitId, day = new Date()) {
        const start = new Date(day);
        start.setHours(0, 0, 0, 0);
        start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
        let n = 0;
        for (let i = 0; i < 7; i++) {
            const d = new Date(start);
            d.setDate(start.getDate() + i);
            if (this.isChecked(habitId, dateKey(d)))
                n++;
        }
        return n;
    }

    toggleCheckin(habitId, key = dateKey()) {
        const h = this.get('habits', habitId);
        if (!h)
            return;
        const id = `${habitId}.${key}`;
        if (this.isChecked(habitId, key)) {
            this._del('checkins', id);
            this._del('ledger', `habit.${id}`);
        } else {
            this._put('checkins', {id, habitId, date: key});
            this._cache = null;
            // streak including this check-in
            const d = new Date(`${key}T12:00:00`);
            let n = 0;
            while (this._derived().checkins.has(`${habitId}.${dateKey(d)}`)) {
                n++;
                d.setDate(d.getDate() - 1);
            }
            const at = key === dateKey() ? Date.now() : new Date(`${key}T12:00:00`).getTime();
            this._put('ledger', {id: `habit.${id}`, at, amount: habitXp(h.xp, n), kind: 'habit', ref: habitId, note: h.title});
        }
        this._changed();
    }

    // ---- rewards shop ----------------------------------------------------

    rewards() {
        return this.all('rewards').filter(r => !r.redeemedAt).sort((a, b) => a.cost - b.cost);
    }

    addReward(title, cost, icon = 'gift', repeatable = true) {
        title = (title ?? '').trim();
        cost = Math.round(Number(cost));
        if (!title || !(cost > 0))
            return null;
        const r = this._put('rewards', {id: uid(), title, cost, icon, repeatable, createdAt: Date.now()});
        this._changed();
        return r;
    }

    updateReward(id, patch) {
        if (this._patch('rewards', id, patch))
            this._changed();
    }

    deleteReward(id) {
        this._del('rewards', id);
        this._changed();
    }

    buy(rewardId) {
        const r = this.get('rewards', rewardId);
        if (!r || this.balance < r.cost)
            return false;
        const now = Date.now();
        this._put('ledger', {id: `buy.${uid()}`, at: now, amount: -r.cost, kind: 'purchase', ref: r.id, note: r.title});
        if (!r.repeatable)
            this._patch('rewards', r.id, {redeemedAt: now});
        this._changed();
        return true;
    }

    purchases(limit = 20) {
        return this.all('ledger').filter(l => l.kind === 'purchase').sort((a, b) => b.at - a.at).slice(0, limit);
    }

    refund(ledgerId) {
        const l = this.get('ledger', ledgerId);
        if (!l || l.kind !== 'purchase')
            return;
        this._del('ledger', ledgerId);
        const r = this.data.colls.rewards[l.ref];
        if (r && !r.deleted && r.redeemedAt)
            this._put('rewards', {...r, redeemedAt: null});
        this._changed();
    }

    recentLedger(limit = 30) {
        return this.all('ledger').sort((a, b) => b.at - a.at).slice(0, limit);
    }

    // ---- timers (device-local) -------------------------------------------

    get timers() {
        return this.data.timers;
    }

    getTimer(id) {
        return this.data.timers.find(t => t.id === id) ?? null;
    }

    runningTimers() {
        return this.data.timers.filter(t => t.startedAt);
    }

    _liveSegment(t, now) {
        if (!t.startedAt)
            return 0;
        let seg = Math.max(0, now - t.startedAt);
        if (t.mode === 'countdown')
            seg = Math.min(seg, Math.max(0, t.durationMs - t.elapsedMs));
        return seg;
    }

    timerElapsed(t, now = Date.now()) {
        return t.elapsedMs + this._liveSegment(t, now);
    }

    timerRemaining(t, now = Date.now()) {
        return Math.max(0, t.durationMs - this.timerElapsed(t, now));
    }

    /** Stop the running segment and record it as a synced session. */
    _credit(t, now) {
        const seg = this._liveSegment(t, now);
        t.elapsedMs += seg;
        t.startedAt = null;
        if (seg < 1000)
            return;
        const q = t.questId ? this.getQuest(t.questId) : null;
        this._put('sessions', {
            id: uid(), questId: t.questId ?? null, kind: t.kind, start: now - seg, end: now,
            durationMs: seg, date: dateKey(new Date(now - seg)), topic: q?.topic || null,
        });
    }

    addTimer({label, mode = 'countdown', kind = 'custom', durationMs = 25 * 60000, questId = null, start = true}) {
        const q = questId ? this.getQuest(questId) : null;
        const t = {
            id: uid(),
            label: label || q?.title || (mode === 'stopwatch' ? 'Stopwatch' : 'Timer'),
            mode, kind, durationMs, questId,
            elapsedMs: 0,
            startedAt: start ? Date.now() : null,
            finished: false,
        };
        this.data.timers.unshift(t);
        this._changed();
        return t;
    }

    startTimer(id) {
        const t = this.getTimer(id);
        if (!t || t.startedAt)
            return;
        if (t.finished || (t.mode === 'countdown' && t.elapsedMs >= t.durationMs)) {
            t.elapsedMs = 0;
            t.finished = false;
        }
        t.startedAt = Date.now();
        this._changed();
    }

    pauseTimer(id) {
        const t = this.getTimer(id);
        if (!t || !t.startedAt)
            return;
        this._credit(t, Date.now());
        this._changed();
    }

    toggleTimer(id) {
        if (this.getTimer(id)?.startedAt)
            this.pauseTimer(id);
        else
            this.startTimer(id);
    }

    resetTimer(id) {
        const t = this.getTimer(id);
        if (!t)
            return;
        if (t.startedAt)
            this._credit(t, Date.now());
        t.elapsedMs = 0;
        t.finished = false;
        this._changed();
    }

    removeTimer(id) {
        const t = this.getTimer(id);
        if (!t)
            return;
        if (t.startedAt)
            this._credit(t, Date.now());
        this.data.timers = this.data.timers.filter(x => x.id !== id);
        this._changed();
    }

    linkTimer(id, questId) {
        const t = this.getTimer(id);
        if (!t)
            return;
        if (t.startedAt) {
            this._credit(t, Date.now());
            t.startedAt = Date.now();
        }
        t.questId = questId;
        const q = questId ? this.getQuest(questId) : null;
        if (q && (t.kind === 'stopwatch' || t.kind === 'custom'))
            t.label = q.title;
        this._changed();
    }

    toggleQuestTimer(questId) {
        const running = this.data.timers.find(t => t.questId === questId && t.startedAt);
        if (running) {
            this.pauseTimer(running.id);
            return;
        }
        const existing = this.data.timers.find(t => t.questId === questId && t.mode === 'stopwatch');
        if (existing)
            this.startTimer(existing.id);
        else
            this.addTimer({mode: 'stopwatch', kind: 'stopwatch', questId, durationMs: 0});
    }

    startPomodoro(questId, minutes) {
        return this.addTimer({mode: 'countdown', kind: 'pomodoro', durationMs: minutes * 60000, questId,
            label: questId ? this.getQuest(questId)?.title : 'Focus'});
    }

    startBreak(minutes) {
        return this.addTimer({mode: 'countdown', kind: 'break', durationMs: minutes * 60000, label: 'Break'});
    }

    /** Called every second while something runs. Returns countdowns that just finished. */
    tick(now = Date.now()) {
        const finished = [];
        for (const t of this.data.timers) {
            if (t.mode !== 'countdown' || !t.startedAt)
                continue;
            if (this.timerElapsed(t, now) >= t.durationMs) {
                this._credit(t, now);
                t.finished = true;
                if (t.kind === 'pomodoro') {
                    this._put('ledger', {id: `pomo.${t.id}.${now}`, at: now, amount: POMODORO_XP, kind: 'pomodoro',
                        ref: t.questId ?? null, note: t.label});
                }
                finished.push(t);
            }
        }
        if (finished.length)
            this._changed();
        return finished;
    }
}
