// Persistent model for quests, timers and gamification stats.
// Saved as JSON in ~/.local/share/questboard/data.json (atomic writes).

import GLib from 'gi://GLib';

import {dateKey} from './util.js';

export const QUADRANTS = [
    {id: 'q1', title: 'Do first', short: 'Do', subtitle: 'Urgent · Important', xp: 30},
    {id: 'q2', title: 'Schedule', short: 'Plan', subtitle: 'Important · Not urgent', xp: 40},
    {id: 'q3', title: 'Delegate', short: 'Delegate', subtitle: 'Urgent · Not important', xp: 15},
    {id: 'q4', title: 'Eliminate', short: 'Drop', subtitle: 'Not urgent · Not important', xp: 5},
];

export const POMODORO_XP = 10;

const quadXp = id => QUADRANTS.find(q => q.id === id)?.xp ?? 10;

/** XP needed to *reach* level L is 50·L·(L-1): 0, 100, 300, 600, 1000 … */
export function levelInfo(xp) {
    let level = 1;
    while (50 * (level + 1) * level <= xp)
        level++;
    const base = 50 * level * (level - 1);
    const next = 50 * (level + 1) * level;
    return {level, into: xp - base, span: next - base, frac: (xp - base) / (next - base)};
}

function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

const emptyData = () => ({
    version: 1,
    quests: [],
    timers: [],
    deleted: [], // tombstones {id, at} so a future sync server can propagate deletions
    xp: 0,
    stats: {days: {}, focus: {}},
});

export class Store {
    constructor() {
        this._dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'questboard']);
        this._path = GLib.build_filenamev([this._dir, 'data.json']);
        this._listeners = new Set();
        this._saveId = 0;
        this.data = this._load();
    }

    // ---- persistence -----------------------------------------------------

    _load() {
        let bytes;
        try {
            [, bytes] = GLib.file_get_contents(this._path);
        } catch {
            return emptyData(); // first run
        }
        try {
            const d = JSON.parse(new TextDecoder().decode(bytes));
            const base = emptyData();
            return {
                ...base,
                ...d,
                quests: Array.isArray(d.quests) ? d.quests : [],
                timers: Array.isArray(d.timers) ? d.timers : [],
                deleted: Array.isArray(d.deleted) ? d.deleted : [],
                stats: {...base.stats, ...(d.stats ?? {})},
            };
        } catch (e) {
            // Never silently overwrite a file we failed to parse.
            const backup = `${this._path}.corrupt-${Date.now()}`;
            GLib.rename(this._path, backup);
            console.error(`[Questboard] could not parse data, moved to ${backup}: ${e}`);
            return emptyData();
        }
    }

    _write() {
        try {
            GLib.mkdir_with_parents(this._dir, 0o700);
            GLib.file_set_contents(this._path, JSON.stringify(this.data, null, 1));
        } catch (e) {
            console.error(`[Questboard] save failed: ${e}`);
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
            this._write();
        }
    }

    destroy() {
        this.flush();
        this._listeners.clear();
    }

    subscribe(fn) {
        this._listeners.add(fn);
        return () => this._listeners.delete(fn);
    }

    _changed() {
        this._scheduleSave();
        for (const fn of [...this._listeners]) {
            try {
                fn();
            } catch (e) {
                console.error(`[Questboard] listener error: ${e}\n${e.stack}`);
            }
        }
    }

    // ---- stats -------------------------------------------------------------

    get xp() {
        return this.data.xp;
    }

    _bump(map, key, delta) {
        const v = (this.data.stats[map][key] ?? 0) + delta;
        if (v > 0)
            this.data.stats[map][key] = v;
        else
            delete this.data.stats[map][key];
    }

    completedOn(key = dateKey()) {
        return this.data.stats.days[key] ?? 0;
    }

    focusOn(key = dateKey(), now = Date.now()) {
        let ms = this.data.stats.focus[key] ?? 0;
        if (key === dateKey())
            for (const t of this.runningTimers())
                if (t.kind !== 'break')
                    ms += now - t.startedAt;
        return ms;
    }

    /** Consecutive days (ending today, or yesterday if today is still empty) with ≥1 completed quest. */
    streak() {
        const d = new Date();
        if (!this.completedOn(dateKey(d)))
            d.setDate(d.getDate() - 1);
        let n = 0;
        while (this.completedOn(dateKey(d))) {
            n++;
            d.setDate(d.getDate() - 1);
        }
        return n;
    }

    // ---- quests ----------------------------------------------------------

    get quests() {
        return this.data.quests;
    }

    getQuest(id) {
        return this.data.quests.find(q => q.id === id) ?? null;
    }

    openQuests() {
        return this.data.quests.filter(q => !q.done);
    }

    /** Open quests first, then quests completed today. Older completed quests are archived. */
    visibleQuests(quadrant) {
        const today = dateKey();
        const inQ = this.data.quests.filter(q => q.quadrant === quadrant);
        return [
            ...inQ.filter(q => !q.done),
            ...inQ.filter(q => q.done && q.doneAt && dateKey(new Date(q.doneAt)) === today),
        ];
    }

    archivedCount() {
        const today = dateKey();
        return this.data.quests.filter(q => q.done && (!q.doneAt || dateKey(new Date(q.doneAt)) !== today)).length;
    }

    addQuest(title, quadrant = 'q1', scheduled = null) {
        title = (title ?? '').trim();
        if (!title)
            return null;
        const q = {
            id: uid(),
            title,
            quadrant,
            done: false,
            doneAt: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            timeSpentMs: 0,
            xpAwarded: 0,
            scheduled,
        };
        this.data.quests.push(q);
        this._changed();
        return q;
    }

    updateQuest(id, patch) {
        const q = this.getQuest(id);
        if (!q)
            return;
        Object.assign(q, patch, {updatedAt: Date.now()});
        this._changed();
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
            q.done = true;
            q.doneAt = now;
            q.xpAwarded = quadXp(q.quadrant);
            this.data.xp += q.xpAwarded;
            this._bump('days', dateKey(), 1);
        } else {
            this.data.xp = Math.max(0, this.data.xp - (q.xpAwarded ?? 0));
            if (q.doneAt)
                this._bump('days', dateKey(new Date(q.doneAt)), -1);
            q.done = false;
            q.doneAt = null;
            q.xpAwarded = 0;
        }
        q.updatedAt = now;
        this._changed();
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
        this.data.quests = this.data.quests.filter(q => q.id !== id);
        this._tombstone([id]);
        this._changed();
    }

    clearCompleted() {
        const doneIds = new Set(this.data.quests.filter(q => q.done).map(q => q.id));
        for (const t of this.data.timers)
            if (doneIds.has(t.questId))
                t.questId = null;
        this.data.quests = this.data.quests.filter(q => !q.done);
        this._tombstone([...doneIds]);
        this._changed();
    }

    _tombstone(ids) {
        const at = Date.now();
        for (const id of ids)
            this.data.deleted.push({id, at});
        // keep tombstones for 90 days
        const cutoff = at - 90 * 86400000;
        this.data.deleted = this.data.deleted.filter(d => d.at >= cutoff);
    }

    questTimeMs(q, now = Date.now()) {
        let ms = q.timeSpentMs ?? 0;
        for (const t of this.data.timers)
            if (t.questId === q.id && t.startedAt)
                ms += this._liveSegment(t, now);
        return ms;
    }

    isQuestRunning(id) {
        return this.data.timers.some(t => t.questId === id && t.startedAt);
    }

    // ---- timers ----------------------------------------------------------

    get timers() {
        return this.data.timers;
    }

    getTimer(id) {
        return this.data.timers.find(t => t.id === id) ?? null;
    }

    runningTimers() {
        return this.data.timers.filter(t => t.startedAt);
    }

    /** ms counted by the running segment, clamped so countdowns never overshoot. */
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

    /** Move the running segment into elapsed/quest/focus totals and stop. */
    _credit(t, now) {
        const seg = this._liveSegment(t, now);
        t.elapsedMs += seg;
        t.startedAt = null;
        t.updatedAt = now;
        if (seg <= 0)
            return;
        const q = t.questId ? this.getQuest(t.questId) : null;
        if (q) {
            q.timeSpentMs = (q.timeSpentMs ?? 0) + seg;
            q.updatedAt = now;
        }
        if (t.kind !== 'break')
            this._bump('focus', dateKey(), seg);
    }

    addTimer({label, mode = 'countdown', kind = 'custom', durationMs = 25 * 60000, questId = null, start = true}) {
        const q = questId ? this.getQuest(questId) : null;
        const t = {
            id: uid(),
            label: label || q?.title || (mode === 'stopwatch' ? 'Stopwatch' : 'Timer'),
            mode,
            kind,
            durationMs,
            questId,
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
        const t = this.getTimer(id);
        if (t?.startedAt)
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
        // Credit what ran so far to the previous quest before switching.
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

    /** ▶ on a quest row: toggle its stopwatch (creating one if needed). */
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

    /** Called every second. Returns countdowns that just finished. */
    tick(now = Date.now()) {
        const finished = [];
        for (const t of this.data.timers) {
            if (t.mode !== 'countdown' || !t.startedAt)
                continue;
            if (this.timerElapsed(t, now) >= t.durationMs) {
                this._credit(t, now);
                t.finished = true;
                if (t.kind === 'pomodoro')
                    this.data.xp += POMODORO_XP;
                finished.push(t);
            }
        }
        if (finished.length)
            this._changed();
        return finished;
    }
}
