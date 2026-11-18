// Popup content: header (level / XP / coins / streak / sync), a deadline row (goals with a date: exams),
// left pane with Matrix (grid or list) | Habits | Timers | Shop | Progress, and the day calendar on the right.
//
// Performance: nothing is rebuilt while the popup is closed — changes only mark
// the view stale, and the next open renders once.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {CalendarView} from './calendarView.js';
import {HabitStrip, HabitsPage, LevelPage, ProgressPage, ShopPage} from './pages.js';
import {QUADRANTS, STEP_XP, dueInDays, groupBonus, levelInfo, parseDueDate, questXp, rankName} from './store.js';
import {
    addDays, box, button, checkButton, clearChildren, dateKey, entry, flushEdits, fmtDate, fmtMinutes, fmtSpent, fmtTimer, gicon,
    icon, iconButton, iconLabel, iconTextButton, label, levelRing, openUri, scroll, textButton,
} from './util.js';

const TABS = [
    ['matrix', 'qb-grid', 'Matrix'],
    ['habits', 'qb-repeat', 'Habits'],
    ['timers', 'qb-stopwatch', 'Timers'],
    ['shop', 'qb-shop', 'Shop'],
    ['progress', 'qb-trophy', 'Progress'],
];
/** Reopening the popup within this time keeps the page you were on (e.g. after copying something from a PDF). */
const KEEP_PAGE_MS = 2 * 60000;
const UNDO_SECONDS = 6;
const DEADLINE_CHIPS = 4;

/** Physics RPG quests: the game records the study time itself, so they get an "open the game" button, not a timer. */
const isRpg = q => q?.source === 'physics-rpg';

/** Reviews due in the game: the course quest carries progress.respawns, the "respawns due" quest its own count. */
function rpgReviews(q) {
    if (!isRpg(q))
        return 0;
    if (q.kind === 'respawn')
        return q.respawns ?? (parseInt(/: (\d+) respawns? due/.exec(q.title ?? '')?.[1] ?? '0', 10) || 0);
    return q.progress?.respawns | 0;
}

/**
 * Title as shown in a row. "Physics RPG · Quantenmechanik: 3 respawns due" was cut to "Physics RPG · Quan…" in a matrix cell:
 * the game icon says where it comes from, the chip says how many are due, so the row shows just the course.
 */
function rowTitle(q) {
    if (!isRpg(q) || !q.title?.startsWith('Physics RPG · '))
        return q.title;
    const t = q.title.slice('Physics RPG · '.length);
    return q.kind === 'respawn' ? (q.topic || t.replace(/:.*$/, '')) : t;
}

function dueText(dd) {
    return dd < 0 ? `${-dd}d late` : dd === 0 ? 'today' : dd === 1 ? 'tomorrow' : `in ${dd}d`;
}

export class Dashboard {
    constructor(ctx) {
        this.ctx = ctx; // {store, settings, closeMenu, openPrefs, showClassic, sync, eds, log}
        this._store = ctx.store;
        this._settings = ctx.settings;

        this._open = false;
        this._stale = true;
        this._page = 'matrix';
        this._matrixMode = 'grid'; // or 'list'
        this._closedAt = 0;
        this._pickerFor = null;
        this._stepGoalPick = null; // "questId/stepId" whose goal list is open
        this._openGroups = new Set(); // quests whose steps are shown inline
        this._detailId = null;
        this._newTimerQuest = null;
        this._showNewTimer = false;
        this._tKind = 'pomodoro';
        this._tMinByKind = {}; // minutes picked for the next timer; the defaults in Settings stay as they are
        this._undo = null;
        this._undoId = 0;
        this._questTimeLabels = new Map();
        this._stepTimeLabels = new Map();
        this._timerWidgets = new Map();

        this.actor = box({vertical: true, style_class: 'qb-root'});
        this.actor.connect('destroy', () => this._cleanup());

        this._buildHeader();
        this._deadlines = box({style_class: 'qb-deadlines', visible: false});
        this.actor.add_child(this._deadlines);

        const body = box({style_class: 'qb-body', x_expand: true, y_expand: true});
        this._left = box({vertical: true, style_class: 'qb-left', x_expand: true, y_expand: true});
        this._left.add_child(this._buildTabs());

        this.habitStrip = new HabitStrip(this);
        this.habitsPage = new HabitsPage(this);
        this.shopPage = new ShopPage(this);
        this.progressPage = new ProgressPage(this);
        this.levelPage = new LevelPage(this);
        this._pages = {
            matrix: this._buildMatrixPage(),
            habits: this.habitsPage.actor,
            timers: this._buildTimersPage(),
            shop: this.shopPage.actor,
            progress: this.progressPage.actor,
            detail: this._buildDetailPage(),
            trash: this._buildTrashPage(),
            level: this.levelPage.actor,    // no tab: the level badge opens it  // no tab: opened from "Recently deleted" under the matrix (like the phone)
        };
        for (const p of Object.values(this._pages))
            this._left.add_child(p);

        this._undoBar = box({style_class: 'qb-undo', visible: false});
        this._left.add_child(this._undoBar);
        body.add_child(this._left);

        this.calendar = new CalendarView({...ctx, onQuestClick: id => this.openQuest(id)});
        body.add_child(this.calendar.actor);
        this.actor.add_child(body);

        this._unsub = this._store.subscribe(() => this.render());
        this._unsubSync = ctx.sync?.onStatus(() => this._renderSync());
        this._setPage('matrix', false);
    }

    applySize(width, height) {
        this.actor.set_size(width, height);
        this.calendar.setWidth(Math.round(Math.min(380, Math.max(250, width * 0.37))));
    }

    /** Popup opened: rebuild only what changed while it was closed (a full rebuild costs seconds on a slow laptop). */
    onOpen() {
        const t0 = Date.now();
        this._open = true;
        this._pickerFor = null;
        const calRebuild = this.calendar.onOpen();
        const day = dateKey();
        // back within a couple of minutes: same page (a quest you had open stays open); otherwise start at the Matrix
        const keep = t0 - this._closedAt < KEEP_PAGE_MS && this._renderedDay === day;
        const page = keep ? this._page : 'matrix';
        if (page !== this._page || this._page !== 'matrix' || this._stale || this._renderedDay !== day) {
            this._setPage(page);      // full render, calendar included
        } else {
            this._renderHeader(t0);
            this._renderDeadlines(t0);
            this._renderSync();
            if (calRebuild)
                this.calendar.render();
        }
        this._log?.debug?.('perf', `popup ready in ${Date.now() - t0} ms`);
    }

    /** Full rebuild of the current page and the calendar (fallback when opening failed). */
    rebuild() {
        this._open = true;
        this._stale = true;
        this.calendar.markStale();
        this.calendar._open = true;
        this._setPage('matrix');
    }

    showPage(page) {
        if (page === 'quests') {
            this._matrixMode = 'list';
            page = 'matrix';
        }
        if (this._pages[page])
            this._setPage(page);
    }

    onClose() {
        flushEdits();             // text typed but not confirmed with Enter is saved, not lost
        this._open = false;
        this._closedAt = Date.now();
        this.shopPage?.collapse();
        this.habitsPage?.collapse();
        this._pickerFor = null;
        this._stepGoalPick = null;
        this._clearUndo();
        this.calendar.onClose();
    }

    focusQuest(id) {
        this.openQuest(id);
    }

    // ---- header ----------------------------------------------------------

    _buildHeader() {
        const h = box({style_class: 'qb-header'});

        // the level number in a ring that fills toward the next level (no numbers here; the Level page has them)
        const lvl = box({style_class: 'qb-level', y_align: Clutter.ActorAlign.CENTER});
        this._ring = levelRing(30);
        lvl.add_child(this._ring);
        this._rankLabel = label('', 'qb-rank-mini', {y_align: Clutter.ActorAlign.CENTER});
        lvl.add_child(this._rankLabel);
        // the badge explains itself: a click opens the Level page (ranks, where XP comes from, achievements)
        h.add_child(button({style_class: 'qb-stat-btn qb-level-btn', child: lvl, y_align: Clutter.ActorAlign.CENTER,
            accessible_name: 'Level, ranks and achievements'}, () => this._setPage('level'), 'level'));

        this._coins = iconLabel('qb-coin', '', 'qb-stat qb-coins');
        this._streak = iconLabel('qb-flame', '', 'qb-stat qb-streak');
        this._focus = iconLabel('qb-stopwatch', '', 'qb-stat');
        const coinBtn = button({style_class: 'qb-stat-btn', child: this._coins, y_align: Clutter.ActorAlign.CENTER,
            accessible_name: 'Coins: open the shop'}, () => this._setPage('shop'), 'coins');
        h.add_child(coinBtn);
        for (const s of [this._streak, this._focus])
            h.add_child(s);

        h.add_child(new St.Widget({x_expand: true}));

        const chipBox = box({});
        chipBox.add_child(icon('qb-stopwatch'));
        this._chipLabel = label('', 'qb-chip-label');
        chipBox.add_child(this._chipLabel);
        this._chip = button({style_class: 'qb-chip', child: chipBox, visible: false, y_align: Clutter.ActorAlign.CENTER,
            accessible_name: 'Running timer'}, () => this._setPage('timers'), 'chip');
        h.add_child(this._chip);

        this._syncIcon = icon('qb-cloud');
        this._syncBtn = button({style_class: 'qb-icon-btn qb-flat qb-sync', child: this._syncIcon, y_align: Clutter.ActorAlign.CENTER,
            accessible_name: 'Sync now'}, () => this.ctx.sync?.syncNow('manual'), 'sync');
        h.add_child(this._syncBtn);
        this._themeIcon = icon('qb-moon');
        h.add_child(button({style_class: 'qb-icon-btn qb-flat', child: this._themeIcon, y_align: Clutter.ActorAlign.CENTER,
            accessible_name: 'Light / dark'}, () => this.ctx.toggleTheme?.(), 'theme'));
        h.add_child(iconButton('qb-inbox', 'qb-flat', () => this.ctx.showClassic(), 'Notifications (classic view)'));
        h.add_child(iconButton('preferences-system-symbolic', 'qb-flat', () => {
            this.ctx.closeMenu();
            this.ctx.openPrefs();
        }, 'Settings'));
        this.actor.add_child(h);
    }

    _renderHeader(now = Date.now()) {
        const info = levelInfo(this._store.xp);
        this._ring.setLevel(info.level, info.frac, this.ctx.isDark?.() ?? true);
        this._rankLabel.text = rankName(info.level);
        this._coins.labelActor.text = this._store.balance.toLocaleString();
        const streak = this._store.streak();
        this._streak.labelActor.text = `${streak}d`;
        this._streak.visible = streak > 0;
        // focus today, nothing else (the target and the rest are on the Level page); green once the daily target is reached
        this._focus.labelActor.text = fmtSpent(this._store.focusOn(undefined, now)) || '0m';
        const hit = this._store.dailyHit();
        if (hit)
            this._focus.add_style_class_name('qb-target-hit');
        else
            this._focus.remove_style_class_name('qb-target-hit');

        const running = this._store.runningTimers();
        this._tabs.timers.labelActor.text = running.length ? `Timers ${running.length}` : 'Timers';
        const t = running[0];
        if (t) {
            const shown = t.mode === 'countdown' ? this._store.timerRemaining(t, now) : this._store.timerElapsed(t, now);
            this._chipLabel.text = fmtTimer(shown);
            this._chip.show();
        } else {
            this._chip.hide();
        }
    }

    /** Goals with a date (exams): days left, red when behind pace. A click opens the goal on the Progress page. */
    _renderDeadlines(now = Date.now()) {
        const row = this._deadlines;
        clearChildren(row);
        const today = dateKey(new Date(now));
        const goals = this._store.goals().filter(g => !g.done && g.targetDate && g.targetDate >= today)
            .sort((a, b) => a.targetDate.localeCompare(b.targetDate));
        row.visible = goals.length > 0;
        if (!goals.length)
            return;
        row.add_child(icon('qb-target', 'qb-icon qb-deadline-icon'));
        for (const g of goals.slice(0, DEADLINE_CHIPS)) {
            const pace = this._store.goalPace(g.id, now);
            const days = pace?.daysLeft ?? 0;
            const inner = box({style_class: 'qb-deadline-inner'});
            inner.add_child(label(g.title, 'qb-deadline-title', {ellipsize: true}));
            inner.add_child(label(days === 0 ? 'today' : `${days}d`, 'qb-deadline-days'));
            let cls = 'qb-deadline';
            if (pace && !pace.onTrack)
                cls += ' behind';
            else if (days <= 7)
                cls += ' soon';
            row.add_child(button({style_class: cls, child: inner, y_align: Clutter.ActorAlign.CENTER,
                accessible_name: `${g.title}: ${days} days left${pace && !pace.onTrack ? ', behind pace' : ''}`}, () => {
                this.progressPage.expandGoal(g.id);
                this._setPage('progress');
            }, 'deadline'));
        }
        if (goals.length > DEADLINE_CHIPS)
            row.add_child(label(`+${goals.length - DEADLINE_CHIPS}`, 'qb-muted'));
    }

    /** Called by the extension when light/dark switches. */
    onThemeChanged() {
        // show what a click will switch *to*
        this._themeIcon.gicon = gicon(this.ctx.isDark?.() ? 'qb-sun' : 'qb-moon');
        if (this._ring)
            this._renderHeader();
    }

    _renderSync() {
        if (!this._open)
            return;
        const s = this.ctx.sync?.status ?? {state: 'off'};
        const off = !this.ctx.sync?.enabled;
        this._syncIcon.gicon = gicon(off || s.state === 'error' ? 'qb-cloud-off' : 'qb-cloud');
        for (const c of ['error', 'syncing', 'off'])
            this._syncBtn.remove_style_class_name(c);
        if (off)
            this._syncBtn.add_style_class_name('off');
        else if (s.state === 'error' || s.state === 'syncing')
            this._syncBtn.add_style_class_name(s.state);
    }

    _buildTabs() {
        const tabs = box({style_class: 'qb-tabs'});
        this._tabs = {};
        for (const [id, ic, text] of TABS) {
            const inner = iconLabel(ic, text);
            const b = button({style_class: 'qb-tab', child: inner, x_expand: true}, () => this._setPage(id), `tab:${id}`);
            b.labelActor = inner.labelActor;
            this._tabs[id] = b;
            tabs.add_child(b);
        }
        return tabs;
    }

    _setPage(page, doRender = true) {
        if (page !== this._page) {
            this.shopPage?.collapse();
            this.habitsPage?.collapse();
            this._stepGoalPick = null;
        }
        this._page = page;
        for (const [id, p] of Object.entries(this._pages))
            p.visible = id === page;
        for (const [id, b] of Object.entries(this._tabs)) {
            if (id === page)
                b.add_style_pseudo_class('checked');
            else
                b.remove_style_pseudo_class('checked');
        }
        if (doRender)
            this.render(true);
    }

    // ---- undo ------------------------------------------------------------

    /** "Deleted … · Undo" for a few seconds after a delete. */
    showUndo(text, undo) {
        this._clearUndo();
        this._undo = {text, undo};
        const bar = this._undoBar;
        bar.add_child(icon('user-trash-symbolic', 'qb-icon qb-undo-icon'));
        bar.add_child(label(text, 'qb-undo-label', {ellipsize: true, x_expand: true}));
        bar.add_child(iconTextButton('qb-undo', 'Undo', 'qb-small qb-accent', () => {
            const u = this._undo;
            this._clearUndo();
            u?.undo();
        }));
        bar.add_child(iconButton('window-close-symbolic', 'qb-flat qb-tiny', () => this._clearUndo(), 'Dismiss'));
        bar.show();
        this._undoId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, UNDO_SECONDS, () => {
            this._undoId = 0;
            this._clearUndo();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearUndo() {
        if (this._undoId) {
            GLib.source_remove(this._undoId);
            this._undoId = 0;
        }
        this._undo = null;
        if (this._undoBar) {
            clearChildren(this._undoBar);
            this._undoBar.hide();
        }
    }

    deleteQuest(q) {
        this._store.deleteQuest(q.id);
        this.showUndo(`Deleted “${q.title}”`, () => this._store.restoreQuest(q.id));
    }

    // ---- matrix ----------------------------------------------------------

    _buildMatrixPage() {
        const page = box({vertical: true, style_class: 'qb-page', x_expand: true, y_expand: true});
        const top = box({style_class: 'qb-matrix-top'});
        top.add_child(this.habitStrip.actor);
        top.add_child(new St.Widget({x_expand: true}));
        const views = box({style_class: 'qb-viewswitch', y_align: Clutter.ActorAlign.CENTER});
        this._viewBtns = {};
        for (const [mode, ic, name] of [['grid', 'qb-grid', 'Matrix view'], ['list', 'qb-list', 'List view']]) {
            const b = iconButton(ic, 'qb-flat qb-tiny qb-view-btn', () => {
                this._matrixMode = mode;
                this.render(true);
            }, name);
            this._viewBtns[mode] = b;
            views.add_child(b);
        }
        top.add_child(views);
        page.add_child(top);

        const grid = new Clutter.GridLayout({column_homogeneous: true, row_homogeneous: true, column_spacing: 8, row_spacing: 8});
        this._grid = new St.Widget({layout_manager: grid, x_expand: true, y_expand: true, style_class: 'qb-matrix',
            natural_height: 200, clip_to_allocation: true});
        this._quads = {};
        QUADRANTS.forEach((q, i) => {
            const card = box({vertical: true, style_class: `qb-quad qb-${q.id}`, x_expand: true, y_expand: true});
            const head = box({style_class: 'qb-quad-head'});
            const tb = box({vertical: true, x_expand: true});
            tb.add_child(label(q.title, 'qb-quad-title', {ellipsize: true}));
            tb.add_child(label(`${q.subtitle} · ${q.xp} XP`, 'qb-quad-sub', {ellipsize: true}));
            head.add_child(tb);
            const count = label('', 'qb-quad-count');
            head.add_child(count);
            card.add_child(head);

            const list = box({vertical: true, style_class: 'qb-quest-list'});
            // small natural height: the list takes the space that's left and scrolls,
            // instead of pushing the card (and its input) past the popup's bottom edge
            card.add_child(scroll(list, {y_expand: true, natural_height: 24}));
            card.add_child(entry('Add quest…', '', (text, e) => {
                if (this._store.addQuest(text, q.id))
                    e.set_text('');
            }, {x_expand: true}));

            grid.attach(card, i % 2, Math.floor(i / 2), 1, 1);
            this._quads[q.id] = {list, count};
        });
        page.add_child(this._grid);
        // deleted by mistake? shown only when there is something to bring back
        this._trashLink = button({style_class: 'qb-btn qb-flat qb-trash-link', x_align: Clutter.ActorAlign.START, visible: false,
            child: iconLabel('qb-undo', '', 'qb-muted')}, () => this._setPage('trash'), 'trash-link');
        page.add_child(this._trashLink);

        this._listView = this._buildQuestList();
        page.add_child(this._listView);
        return page;
    }

    _renderMatrix(now) {
        this.habitStrip.render();
        const list = this._matrixMode === 'list';
        this._grid.visible = !list;
        this._listView.visible = list;
        for (const [mode, b] of Object.entries(this._viewBtns)) {
            if (mode === this._matrixMode)
                b.add_style_pseudo_class('checked');
            else
                b.remove_style_pseudo_class('checked');
        }
        const gone = this._store.deletedQuests().length;
        this._trashLink.child.labelActor.text = `Recently deleted · ${gone}  (click to restore)`;
        this._trashLink.visible = gone > 0 && !list;
        if (list) {
            this._renderQuestList(now);
            return;
        }
        for (const q of QUADRANTS) {
            const {list: l, count} = this._quads[q.id];
            clearChildren(l);
            const quests = this._store.visibleQuests(q.id);
            const open = quests.filter(x => !x.done).length;
            count.text = open ? String(open) : '';
            count.visible = open > 0;
            if (!quests.length)
                l.add_child(label(q.id === 'q4' ? 'Nothing to drop' : 'No quests yet', 'qb-empty'));
            for (const quest of quests)
                l.add_child(this._questRow(quest, now, {compact: true}));
        }
    }

    // ---- quest row -------------------------------------------------------

    openRpg(q) {
        if (!q?.link)
            return;
        this.ctx.closeMenu();
        openUri(q.link);
    }

    /**
     * Two lines: [check] title [steps] [timer/play] on top, the details as small chips below.
     * compact (matrix cells, ~210 px wide): at most two chips, in the order due date, reviews due, time slot, progress, time.
     */
    _questRow(q, now, {showDot = false, compact = false} = {}) {
        const steps = q.steps ?? [];
        const groupOpen = this._openGroups.has(q.id);
        let cls = 'qb-quest';
        if (q.done)
            cls += ' done';
        const wrap = box({vertical: true, style_class: cls});
        const row = box({style_class: 'qb-quest-row'});

        row.add_child(checkButton(q.done, () => this._store.setDone(q.id, !q.done),
            {accessible_name: q.done ? 'Mark as not done' : 'Complete quest'}));

        if (showDot)
            row.add_child(new St.Widget({style_class: `qb-dot qb-${q.quadrant}`, y_align: Clutter.ActorAlign.CENTER}));

        if (isRpg(q))
            row.add_child(new St.Icon({gicon: gicon('qb-game'), style_class: 'qb-icon qb-src-icon', y_align: Clutter.ActorAlign.CENTER}));
        const titleLbl = label(rowTitle(q), 'qb-quest-title', {ellipsize: true, x_expand: true, x_align: Clutter.ActorAlign.START});
        row.add_child(button({style_class: 'qb-quest-title-btn', child: titleLbl, x_expand: true},
            () => this.openQuest(q.id), 'quest-title'));

        if (steps.length) {
            const pr = this._store.stepProgress(q);
            const inner = box({});
            inner.add_child(label(`${pr.done}/${pr.total}`, 'qb-progress-pill-label'));
            inner.add_child(icon(groupOpen ? 'pan-up-symbolic' : 'pan-down-symbolic', 'qb-icon qb-tiny-icon'));
            row.add_child(button({style_class: pr.done === pr.total ? 'qb-progress-pill full' : 'qb-progress-pill', child: inner,
                y_align: Clutter.ActorAlign.CENTER, accessible_name: groupOpen ? 'Hide steps' : 'Show steps'}, () => {
                if (groupOpen)
                    this._openGroups.delete(q.id);
                else
                    this._openGroups.add(q.id);
                this.render(true);
            }, 'group-toggle'));
        }

        const running = this._store.isQuestRunning(q.id);
        const spentText = fmtSpent(this._store.questTimeMs(q, now));
        if (running) {
            const spent = label(spentText, 'qb-quest-time running');
            this._questTimeLabels.set(q.id, {label: spent, quest: q});
            row.add_child(spent);
        }
        if (!q.done) {
            if (isRpg(q) && q.link) {
                row.add_child(iconButton('qb-game', 'qb-flat qb-tiny', () => this.openRpg(q), 'Open Physics RPG'));
            } else {
                row.add_child(iconButton(
                    running ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic',
                    running ? 'qb-flat qb-tiny qb-running' : 'qb-flat qb-tiny',
                    () => this._store.toggleQuestTimer(q.id),
                    running ? 'Pause timer' : 'Start timer'));
            }
        }
        wrap.add_child(row);

        // second line: chips by importance
        const chips = [];
        const dd = q.done ? null : dueInDays(q);
        if (dd !== null)
            chips.push(() => label(dueText(dd), dd <= 0 ? 'qb-due urgent' : dd <= 3 ? 'qb-due soon' : 'qb-due'));
        const reviews = q.done ? 0 : rpgReviews(q);
        if (reviews > 0)
            chips.push(() => label(`${reviews} review${reviews === 1 ? '' : 's'} due`, 'qb-due soon'));
        const t = q.scheduled?.start ?? q.eventTime?.start;
        if (t !== undefined && t !== null)
            chips.push(() => label(fmtMinutes(t), 'qb-quest-sched'));
        const ext = this._store.extProgress(q);
        if (ext)
            chips.push(() => label(`${ext.done}/${ext.total}`, ext.done === ext.total ? 'qb-progress-pill full' : 'qb-progress-pill'));
        if (!running && spentText) {
            chips.push(() => {
                const spent = label(spentText, 'qb-quest-time');
                this._questTimeLabels.set(q.id, {label: spent, quest: q});
                return spent;
            });
        }
        const icons = [];
        if (!compact) {
            if (this._store.getGoal(q.goalId))
                icons.push('qb-star');
            if (q.source === 'notion')
                icons.push('qb-book');
            if (q.gcal)
                icons.push('x-office-calendar-symbolic');
        }
        const shown = compact ? chips.slice(0, 2) : chips;
        if (shown.length || icons.length) {
            const meta = box({style_class: showDot ? 'qb-quest-meta qb-quest-meta-dot' : 'qb-quest-meta'});
            for (const make of shown)
                meta.add_child(make());
            for (const ic of icons)
                meta.add_child(icon(ic, 'qb-icon qb-src-icon'));
            wrap.add_child(meta);
        }

        if (groupOpen && steps.length) {
            const list = box({vertical: true, style_class: 'qb-steps'});
            for (const st of steps)
                list.add_child(this._stepRow(q, st, false, now));
            wrap.add_child(list);
        }
        return wrap;
    }

    _stepRow(q, st, editable, now = Date.now()) {
        const row = box({style_class: st.done ? 'qb-step done' : 'qb-step'});
        row.add_child(checkButton(st.done, () => this._store.toggleStep(q.id, st.id),
            {small: true, accessible_name: st.done ? 'Mark step as not done' : 'Complete step', where: 'step'}));
        const goal = this._store.getGoal(st.goalId);
        if (editable) {
            row.add_child(entry('Step', 'qb-step-entry', txt => txt.trim() && this._store.renameStep(q.id, st.id, txt.trim()),
                {text: st.title, x_expand: true, commit: true}));
        } else {
            row.add_child(label(st.title, 'qb-step-title', {ellipsize: true, x_expand: true}));
            if (goal)
                row.add_child(icon('qb-star', 'qb-icon qb-src-icon'));
        }
        // every step has its own Pomodoro + time
        const spent = label(fmtSpent(this._store.stepTimeMs(q.id, st.id, now)), 'qb-quest-time', {y_align: Clutter.ActorAlign.CENTER});
        this._stepTimeLabels.set(`${q.id}/${st.id}`, {label: spent, questId: q.id, stepId: st.id});
        row.add_child(spent);
        const running = this._store.isStepRunning(q.id, st.id);
        if ((!st.done || running) && !isRpg(q)) {
            const pomo = this._settings.get_int('pomodoro-minutes');
            row.add_child(iconButton(running ? 'media-playback-pause-symbolic' : 'qb-target',
                running ? 'qb-flat qb-tiny qb-running' : 'qb-flat qb-tiny',
                () => this._store.toggleStepPomodoro(q.id, st.id, pomo),
                running ? 'Pause step timer' : `${pomo}m focus on this step`));
        }
        if (!editable)
            return row;

        // goal: a small list to pick from (cycling through every goal took one click per goal)
        const key = `${q.id}/${st.id}`;
        const goals = this._store.goals().filter(g => !g.done);
        if (goals.length || goal) {
            const gb = textButton(goal ? goal.title : 'Goal…', 'qb-small qb-seg qb-step-goal', () => {
                this._stepGoalPick = this._stepGoalPick === key ? null : key;
                this.render(true);
            });
            if (goal)
                gb.add_style_pseudo_class('checked');
            row.add_child(gb);
        }
        row.add_child(iconButton('window-close-symbolic', 'qb-flat qb-tiny', () => this._store.deleteStep(q.id, st.id), 'Remove step'));
        if (this._stepGoalPick !== key)
            return row;
        const col = box({vertical: true});
        col.add_child(row);
        const pick = box({vertical: true, style_class: 'qb-picker'});
        const choose = id => {
            this._stepGoalPick = null;
            this._store.setStepGoal(q.id, st.id, id);
        };
        pick.add_child(textButton('No goal', goal ? 'qb-pick' : 'qb-pick checked', () => choose(null)));
        for (const g of goals) {
            const b = textButton(g.title, g.id === goal?.id ? 'qb-pick checked' : 'qb-pick', () => choose(g.id));
            pick.add_child(b);
        }
        col.add_child(pick);
        return col;
    }

    // ---- quest details (full-width page) ---------------------------------

    openQuest(id) {
        this._detailId = id;
        this._returnPage = this._page === 'detail' ? (this._returnPage ?? 'matrix') : this._page;
        this._setPage('detail');
    }

    _buildDetailPage() {
        const page = box({vertical: true, style_class: 'qb-page qb-detail', x_expand: true, y_expand: true});
        this._detailBody = box({vertical: true, style_class: 'qb-detail-body'});
        page.add_child(scroll(this._detailBody, {y_expand: true}));
        return page;
    }

    /** Rows of n buttons (St boxes do not wrap; one long row would push the calendar out of the popup). */
    _rows(parent, buttons, n = 3) {
        let row = null;
        buttons.forEach((b, i) => {
            if (i % n === 0) {
                row = box({style_class: 'qb-actions-row'});
                parent.add_child(row);
            }
            row.add_child(b);
        });
    }

    _renderDetail(now) {
        const b = this._detailBody;
        clearChildren(b);
        const q = this._detailId ? this._store.getQuest(this._detailId) : null;
        const head = box({style_class: 'qb-actions-row'});
        head.add_child(iconTextButton('go-previous-symbolic', 'Back', 'qb-small', () => this._setPage(this._returnPage ?? 'matrix')));
        head.add_child(new St.Widget({x_expand: true}));
        if (q) {
            head.add_child(iconButton('user-trash-symbolic', 'qb-flat qb-danger', () => {
                this.deleteQuest(q);
                this._setPage(this._returnPage ?? 'matrix');
            }, 'Delete quest'));
        }
        b.add_child(head);
        if (!q) {
            b.add_child(label('This quest no longer exists.', 'qb-empty'));
            return;
        }

        const titleRow = box({style_class: 'qb-actions-row'});
        titleRow.add_child(checkButton(q.done, () => this._store.setDone(q.id, !q.done),
            {accessible_name: q.done ? 'Mark as not done' : 'Complete quest', where: 'detail-check'}));
        titleRow.add_child(entry('Title', 'qb-detail-title', t => t.trim() && this._store.updateQuest(q.id, {title: t.trim()}),
            {text: q.title, x_expand: true, commit: true}));
        b.add_child(titleRow);

        // the things you came here to do, right under the title
        if (!q.done) {
            const fr = box({style_class: 'qb-actions-row'});
            if (isRpg(q)) {
                if (q.link)
                    fr.add_child(iconTextButton('qb-game', 'Open Physics RPG', 'qb-small qb-accent', () => this.openRpg(q)));
                fr.add_child(label('Study time comes from the game, so there is no timer here (it would count twice).',
                    'qb-muted', {wrap: true, x_expand: true}));
            } else {
                const pomo = this._settings.get_int('pomodoro-minutes');
                fr.add_child(iconTextButton('qb-target', `${pomo}m focus`, 'qb-small qb-accent', () => this._store.startPomodoro(q.id, pomo)));
                const running = this._store.isQuestRunning(q.id);
                fr.add_child(iconTextButton(running ? 'qb-pause' : 'qb-play', running ? 'Pause stopwatch' : 'Stopwatch', 'qb-small',
                    () => this._store.toggleQuestTimer(q.id)));
                fr.add_child(new St.Widget({x_expand: true}));
                if (q.link) {
                    const text = q.source === 'notion' ? 'Open in Notion' : 'Open link';
                    fr.add_child(iconTextButton('qb-book', text, 'qb-small', () => {
                        this.ctx.closeMenu();
                        openUri(q.link);
                    }));
                }
            }
            b.add_child(fr);
        }

        b.add_child(entry('Notes', '', t => this._store.updateQuest(q.id, {notes: t}), {text: q.notes ?? '', x_expand: true, commit: true}));

        const ext = this._store.extProgress(q);
        const reviews = rpgReviews(q);
        if (reviews > 0)
            b.add_child(label(`${reviews} review${reviews === 1 ? '' : 's'} due in the game: do those first.`, 'qb-due soon', {x_align: Clutter.ActorAlign.START}));
        if (ext)
            b.add_child(label(ext.text, 'qb-muted', {x_align: Clutter.ActorAlign.START, wrap: true}));

        // XP line
        const xpRow = box({style_class: 'qb-actions-row'});
        const steps = q.steps ?? [];
        xpRow.add_child(iconLabel('qb-sparkle', steps.length
            ? `${questXp(q)} XP + ${groupBonus(q)} group bonus + ${STEP_XP} per step`
            : `${questXp(q)} XP`, 'qb-muted'));
        xpRow.add_child(new St.Widget({x_expand: true}));
        const spent = fmtSpent(this._store.questTimeMs(q, now));
        if (spent)
            xpRow.add_child(iconLabel('qb-stopwatch', spent, 'qb-muted'));
        b.add_child(xpRow);

        // quadrant
        b.add_child(label('Quadrant', 'qb-section-title'));
        const qr = box({style_class: 'qb-actions-row'});
        for (const quad of QUADRANTS) {
            const btn = textButton(quad.title, `qb-small qb-move qb-${quad.id}`, () => this._store.updateQuest(q.id, {quadrant: quad.id}));
            if (quad.id === q.quadrant)
                btn.add_style_pseudo_class('checked');
            qr.add_child(btn);
        }
        b.add_child(qr);

        // long-term goal
        b.add_child(label('Goal', 'qb-section-title'));
        const goals = this._store.goals().filter(g => !g.done || g.id === q.goalId);
        if (!goals.length)
            b.add_child(label('No goals yet. Add long-term goals on the Progress tab; single steps can be linked too.', 'qb-muted', {wrap: true}));
        this._rows(b, goals.map(g => {
            const btn = textButton(g.title, 'qb-small qb-seg', () => this._store.updateQuest(q.id, {goalId: q.goalId === g.id ? null : g.id}));
            if (q.goalId === g.id)
                btn.add_style_pseudo_class('checked');
            return btn;
        }), 2);

        // steps
        b.add_child(label(steps.length ? `Steps · ${this._store.stepProgress(q).done}/${steps.length}` : 'Steps (turn this into a group)', 'qb-section-title'));
        const sl = box({vertical: true, style_class: 'qb-steps qb-steps-edit'});
        for (const st of steps)
            sl.add_child(this._stepRow(q, st, true, now));
        sl.add_child(entry('Add a step, e.g. Exercise 1 — Enter', '', (txt, e) => {
            this._store.addStep(q.id, txt);
            e.set_text('');
        }, {x_expand: true}));
        b.add_child(sl);

        // due + time
        b.add_child(label('When', 'qb-section-title'));
        const dr = box({style_class: 'qb-actions-row'});
        dr.add_child(label('Due', 'qb-muted'));
        const today = new Date();
        for (const [txt, days] of [['Today', 0], ['Tomorrow', 1], ['+1 week', 7]]) {
            const key = dateKey(addDays(today, days));
            const btn = textButton(txt, 'qb-small qb-dur', () => this._store.updateQuest(q.id, {due: {date: key}}));
            if (q.due?.date === key)
                btn.add_style_pseudo_class('checked');
            dr.add_child(btn);
        }
        b.add_child(dr);
        // any date: a day at a time from the current due date, or typed (24.12. · 24.12.2026 · 2026-12-24 · +3 · Fr)
        const dd = box({style_class: 'qb-actions-row'});
        const base = q.due?.date ? new Date(`${q.due.date}T12:00`) : today;
        dd.add_child(textButton('−1 day', 'qb-small', () => this._store.updateQuest(q.id, {due: {date: dateKey(addDays(base, -1))}})));
        dd.add_child(textButton('+1 day', 'qb-small', () => this._store.updateQuest(q.id, {due: {date: dateKey(addDays(base, 1))}})));
        dd.add_child(this._dateEntry(q.due?.date, key => this._store.updateQuest(q.id, {due: {date: key}})));
        if (q.due)
            dd.add_child(iconButton('edit-clear-symbolic', 'qb-flat qb-tiny', () => this._store.updateQuest(q.id, {due: null}), 'Clear due date'));
        b.add_child(dd);

        const tr = box({style_class: 'qb-actions-row'});
        const s = q.scheduled;
        tr.add_child(label(s ? `Time slot: ${fmtDate(new Date(`${s.date}T12:00`), '%a %e %b')}, ${fmtMinutes(s.start)} – ${fmtMinutes(s.start + (s.duration ?? 60))}`
            : q.gcal ? 'Linked to a calendar event' : 'No time slot', 'qb-muted', {x_expand: true}));
        tr.add_child(iconTextButton('x-office-calendar-symbolic', s ? 'Change time' : 'Pick a time', 'qb-small',
            () => this.calendar.scheduleQuest(q.id)));
        if (s)
            tr.add_child(iconButton('edit-clear-symbolic', 'qb-flat qb-tiny', () => this._store.updateQuest(q.id, {scheduled: null}), 'Unschedule'));
        b.add_child(tr);
    }

    /**
     * Date field. Empty, with the current date as its hint (so typing "15.1." needs no clearing first).
     * Takes 24.12., 24.12.2026, 2026-12-24, +3 or a weekday (Fr); saves on Enter or when you click elsewhere.
     */
    _dateEntry(current, onDate) {
        const shown = current ? fmtDate(new Date(`${current}T12:00`), '%a %e %b %Y').replace(/\s+/g, ' ') : 'Date: 24.12. · +3 · Fr';
        const e = entry(shown, current ? 'qb-date has-value' : 'qb-date', t => {
            if (!t.trim())
                return;
            const key = parseDueDate(t);
            if (key)
                onDate(key);
            else
                e.add_style_pseudo_class('error');
        }, {commit: true});
        e.clutter_text.connect('text-changed', () => e.remove_style_pseudo_class('error'));
        return e;
    }

    // ---- list view of the matrix (was the Quests tab) ---------------------

    _buildQuestList() {
        const page = box({vertical: true, x_expand: true, y_expand: true, visible: false});
        this._questsList = box({vertical: true, style_class: 'qb-quest-list'});
        page.add_child(scroll(this._questsList, {y_expand: true}));
        const foot = box({style_class: 'qb-page-foot'});
        this._archiveLabel = label('', 'qb-muted', {x_expand: true});
        foot.add_child(this._archiveLabel);
        this._trashBtn = textButton('Recently deleted', 'qb-small', () => this._setPage('trash'));
        foot.add_child(this._trashBtn);
        foot.add_child(textButton('Clear completed', 'qb-small', () => this._store.clearCompleted()));
        page.add_child(foot);
        return page;
    }

    _renderQuestList(now) {
        clearChildren(this._questsList);
        const open = this._store.openQuests();
        for (const quad of QUADRANTS) {
            const qs = open.filter(q => q.quadrant === quad.id);
            if (!qs.length)
                continue;
            const head = box({style_class: 'qb-section'});
            head.add_child(new St.Widget({style_class: `qb-dot qb-${quad.id}`, y_align: Clutter.ActorAlign.CENTER}));
            head.add_child(label(`${quad.title}  ·  ${qs.length}`, 'qb-section-title'));
            this._questsList.add_child(head);
            for (const q of qs)
                this._questsList.add_child(this._questRow(q, now));
        }
        const doneToday = QUADRANTS.flatMap(quad => this._store.visibleQuests(quad.id).filter(q => q.done));
        if (doneToday.length) {
            this._questsList.add_child(label(`Completed today · ${doneToday.length}`, 'qb-section-title qb-section-done'));
            for (const q of doneToday)
                this._questsList.add_child(this._questRow(q, now, {showDot: true}));
        }
        if (!open.length && !doneToday.length)
            this._questsList.add_child(label('Your quest log is empty. Switch to the matrix view to add quests.', 'qb-empty'));
        const arch = this._store.archivedCount();
        this._archiveLabel.text = arch ? `${arch} older completed quest${arch === 1 ? '' : 's'} archived` : '';
        this._trashBtn.label = `Recently deleted (${this._store.deletedQuests().length})`;
    }

    // ---- recently deleted (no tab: from the link under the matrix or the list view's footer) ----

    _buildTrashPage() {
        const page = box({vertical: true, style_class: 'qb-page', x_expand: true, y_expand: true});
        const head = box({style_class: 'qb-actions-row'});
        head.add_child(iconTextButton('qb-chevron-left', 'Matrix', 'qb-small', () => this._setPage('matrix')));
        head.add_child(label('Recently deleted', 'qb-section-title', {x_expand: true}));
        page.add_child(head);
        this._trashList = box({vertical: true, style_class: 'qb-quest-list'});
        page.add_child(scroll(this._trashList, {y_expand: true}));
        return page;
    }

    /** Quests deleted in the last 30 days; Restore puts them back as they were (quadrant, goal, steps, time). */
    _renderTrashPage() {
        clearChildren(this._trashList);
        const gone = this._store.deletedQuests();
        if (!gone.length)
            this._trashList.add_child(label('Nothing deleted in the last 30 days.', 'qb-empty'));
        for (const q of gone) {
            const row = box({style_class: 'qb-history-row'});
            const days = Math.floor((Date.now() - (q.deletedAt ?? q.updatedAt ?? 0)) / 86400000);
            row.add_child(label(q.title, 'qb-history-title', {ellipsize: true, x_expand: true}));
            row.add_child(label(`${days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`}${q.done ? ' · was done' : ''}`, 'qb-muted'));
            row.add_child(textButton('Restore', 'qb-small qb-accent', () => this._store.restoreQuest(q.id)));
            this._trashList.add_child(row);
        }
    }

    // ---- timers page -----------------------------------------------------
    // Order: your timers first, then one-click presets, then "+ Custom timer" (the full form, folded away by default).

    _buildTimersPage() {
        const page = box({vertical: true, style_class: 'qb-page', x_expand: true, y_expand: true});
        const body = box({vertical: true, style_class: 'qb-timer-list'});
        this._timersList = box({vertical: true, style_class: 'qb-timer-list'});
        body.add_child(this._timersList);
        this._startBox = box({vertical: true, style_class: 'qb-preset-box'});
        body.add_child(this._startBox);
        this._newTimerBox = box({vertical: true, style_class: 'qb-new-timer-box'});
        body.add_child(this._newTimerBox);
        page.add_child(scroll(body, {y_expand: true}));
        return page;
    }

    _kindMinutes(kind) {
        if (this._tMinByKind[kind])
            return this._tMinByKind[kind];
        if (kind === 'pomodoro')
            return this._settings.get_int('pomodoro-minutes');
        if (kind === 'break')
            return this._settings.get_int('break-minutes');
        return this._store.data.countdownMin ?? 45;
    }

    /** Minutes for the next timer only. The default lengths live in Settings (and in presets). */
    _setKindMinutes(m) {
        this._tMinByKind[this._tKind] = Math.max(1, Math.min(600, Math.round(m)));
        this.render(true);
    }

    _startNew(kind, min, text) {
        this._store.startKind(kind, min, text, kind === 'break' ? null : this._newTimerQuest);
        this._showNewTimer = false;
    }

    /** Presets (one click starts) and which quest new timers count toward. */
    _renderStart() {
        const pb = this._startBox;
        clearChildren(pb);
        const presets = this._store.timerPresets;
        const head = box({style_class: 'qb-actions-row'});
        head.add_child(label('Start a timer', 'qb-section-title', {x_expand: true}));
        if (presets.length) {
            head.add_child(textButton(this._editPresets ? 'Done' : 'Edit presets', 'qb-small', () => {
                this._editPresets = !this._editPresets;
                this.render(true);
            }));
        }
        pb.add_child(head);

        if (this._newTimerQuest && !this._store.getQuest(this._newTimerQuest))
            this._newTimerQuest = null;
        const lr = box({style_class: 'qb-link-line'});
        lr.add_child(label('Counts toward', 'qb-muted'));
        lr.add_child(this._linkButton(this._newTimerQuest, 'new'));
        pb.add_child(lr);
        if (this._pickerFor === 'new') {
            pb.add_child(this.questPicker(this._newTimerQuest, id => {
                this._newTimerQuest = id;
                this._pickerFor = null;
                this.render(true);
            }));
        }

        const buttons = presets.map((p, i) => {
            const txt = `${p.label}${p.kind === 'stopwatch' ? '' : ` · ${p.min}m`}`;
            return this._editPresets
                ? iconTextButton('window-close-symbolic', txt, 'qb-small qb-danger', () => this._store.setTimerPresets(presets.filter((_, j) => j !== i)))
                : textButton(txt, 'qb-small', () => this._store.startKind(p.kind, p.min, p.label, p.kind === 'break' ? null : this._newTimerQuest));
        });
        const formOpen = this._showNewTimer || !presets.length;
        if (!formOpen) {
            buttons.push(iconTextButton('qb-plus', 'Custom timer', 'qb-small qb-accent', () => {
                this._showNewTimer = true;
                this.render(true);
            }));
        }
        this._rows(pb, buttons);
        if (!presets.length)
            pb.add_child(label('Set up a timer below and click “Save as preset” to start it with one click next time.', 'qb-muted', {wrap: true}));
        return formOpen;
    }

    /** Custom timer: kind, minutes (−5 −1 +1 +5, quick picks, or typed), optional label; break after Focus. */
    _renderNewTimer(open) {
        const KINDS = [['pomodoro', 'Focus'], ['break', 'Break'], ['custom', 'Countdown'], ['stopwatch', 'Stopwatch']];
        const nb = this._newTimerBox;
        clearChildren(nb);
        nb.visible = open;
        if (!open)
            return;
        const min = this._kindMinutes(this._tKind);
        const kinds = box({style_class: 'qb-actions-row'});
        for (const [k, name] of KINDS) {
            const b = textButton(name, 'qb-small qb-seg', () => {
                this._tKind = k;
                this.render(true);
            });
            if (k === this._tKind)
                b.add_style_pseudo_class('checked');
            kinds.add_child(b);
        }
        kinds.add_child(new St.Widget({x_expand: true}));
        if (this._store.timerPresets.length) {
            kinds.add_child(iconButton('window-close-symbolic', 'qb-flat qb-tiny', () => {
                this._showNewTimer = false;
                this.render(true);
            }, 'Close'));
        }
        nb.add_child(kinds);
        if (this._tKind !== 'stopwatch') {
            const r = box({style_class: 'qb-actions-row'});
            for (const [txt, d] of [['−5', -5], ['−1', -1]])
                r.add_child(textButton(txt, 'qb-small', () => this._setKindMinutes(min + d)));
            r.add_child(label(`${min} min`, 'qb-timer-time qb-new-min', {x_expand: true, x_align: Clutter.ActorAlign.CENTER}));
            for (const [txt, d] of [['+1', 1], ['+5', 5]])
                r.add_child(textButton(txt, 'qb-small', () => this._setKindMinutes(min + d)));
            r.add_child(entry('min', 'qb-mins', t => {
                const m = parseFloat(t);
                if (m > 0)
                    this._setKindMinutes(m);
            }));
            nb.add_child(r);
            // quick picks in short rows (one long row would push the calendar out of the popup)
            for (const row of [[5, 10, 15, 25, 30], [45, 50, 60, 90]]) {
                const q = box({style_class: 'qb-actions-row'});
                for (const m of row) {
                    const b = textButton(String(m), 'qb-small qb-dur', () => this._setKindMinutes(m));
                    if (m === min)
                        b.add_style_pseudo_class('checked');
                    q.add_child(b);
                }
                nb.add_child(q);
            }
        }
        const kindName = KINDS.find(k => k[0] === this._tKind)[1];
        const lbl = entry(this._tKind === 'break' ? 'Break' : 'Label (optional, else the quest\'s name)', 'qb-rename', () => start(), {x_expand: true});
        const start = () => this._startNew(this._tKind, min, lbl.get_text());
        nb.add_child(lbl);
        const act = box({style_class: 'qb-actions-row'});
        act.add_child(textButton(`Start ${kindName.toLowerCase()}${this._tKind === 'stopwatch' ? '' : ` · ${min} min`}`, 'qb-small qb-accent', start));
        act.add_child(new St.Widget({x_expand: true}));
        act.add_child(textButton('Save as preset', 'qb-small', () => {
            const name = lbl.get_text().trim() || kindName;
            this._store.setTimerPresets([...this._store.timerPresets, {label: name, kind: this._tKind, min: this._tKind === 'stopwatch' ? 0 : min}]);
        }));
        nb.add_child(act);
        const auto = !!this._store.data.autoBreak;
        const ab = box({style_class: 'qb-actions-row'});
        ab.add_child(label(`Break after each Focus (${this._settings.get_int('break-minutes')} min, starts by itself)`, 'qb-muted', {x_expand: true, ellipsize: true}));
        ab.add_child(textButton(auto ? 'On' : 'Off', auto ? 'qb-small qb-accent' : 'qb-small', () => {
            this._store.data.autoBreak = !auto;
            this._store.autoBreakMin = !auto ? this._settings.get_int('break-minutes') : 0;
            this.render(true);
        }));
        nb.add_child(ab);
    }

    questPicker(currentId, onPick) {
        const p = box({vertical: true, style_class: 'qb-picker'});
        // search filters the rows in place (no re-render, so typing keeps the focus); at most 12 shown
        const search = entry('Search quests', 'qb-rename', () => {}, {x_expand: true});
        p.add_child(search);
        p.add_child(textButton('No quest', currentId ? 'qb-pick' : 'qb-pick checked', () => onPick(null)));
        const rows = [];
        for (const q of this._store.openQuests()) {
            const inner = box({});
            inner.add_child(new St.Widget({style_class: `qb-dot qb-${q.quadrant}`, y_align: Clutter.ActorAlign.CENTER}));
            inner.add_child(label(q.title, '', {ellipsize: true, x_expand: true}));
            const b = button({style_class: q.id === currentId ? 'qb-btn qb-pick checked' : 'qb-btn qb-pick', child: inner, x_expand: true},
                () => onPick(q.id), 'pick');
            rows.push([q.title.toLowerCase(), b]);
            p.add_child(b);
        }
        const more = label('', 'qb-muted');
        p.add_child(more);
        const filter = () => {
            const t = search.get_text().trim().toLowerCase();
            let n = 0;
            for (const [title, b] of rows) {
                b.visible = (!t || title.includes(t)) && n < 12;
                if (b.visible)
                    n++;
            }
            const hidden = rows.length - n;
            more.text = hidden > 0 ? `${hidden} more: type to search` : '';
            more.visible = hidden > 0;
        };
        search.clutter_text.connect('text-changed', filter);
        filter();
        return p;
    }

    _linkButton(questId, key) {
        const q = questId ? this._store.getQuest(questId) : null;
        const inner = box({});
        if (q)
            inner.add_child(new St.Widget({style_class: `qb-dot qb-${q.quadrant}`, y_align: Clutter.ActorAlign.CENTER}));
        inner.add_child(label(q ? q.title : 'Link quest…', 'qb-link-label', {ellipsize: true}));
        inner.add_child(icon('pan-down-symbolic'));
        return button({style_class: 'qb-btn qb-small qb-link', child: inner, y_align: Clutter.ActorAlign.CENTER}, () => {
            this._pickerFor = this._pickerFor === key ? null : key;
            this.render(true);
        }, 'link');
    }

    _renderTimersPage(now) {
        clearChildren(this._timersList);
        this._timerWidgets.clear();
        const timers = this._store.timers;
        if (!timers.length)
            this._timersList.add_child(label('No timer yet. Start one below, or press play on any quest.', 'qb-empty', {wrap: true}));
        for (const t of timers)
            this._timersList.add_child(this._timerCard(t, now));
        const formOpen = this._renderStart();
        this._renderNewTimer(formOpen);
    }

    _timerCard(t, now) {
        const running = !!t.startedAt;
        let cls = `qb-timer qb-kind-${t.kind}`;
        if (running)
            cls += ' running';
        if (t.finished)
            cls += ' finished';
        const card = box({vertical: true, style_class: cls});
        const top = box({style_class: 'qb-timer-top'});
        const time = label('', 'qb-timer-time');
        top.add_child(time);

        const meta = box({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const kindText = {pomodoro: 'Focus', break: 'Break', stopwatch: 'Stopwatch', custom: 'Countdown'}[t.kind] ?? 'Timer';
        meta.add_child(label(t.finished ? `${kindText} · done` : running ? kindText : `${kindText} · paused`, 'qb-timer-kind'));
        meta.add_child(entry('Name', 'qb-rename qb-timer-name', txt => this._store.renameTimer(t.id, txt),
            {text: t.label ?? '', x_expand: true, commit: true}));
        if (t.kind !== 'break')
            meta.add_child(this._linkButton(t.questId, t.id));
        top.add_child(meta);

        top.add_child(iconButton(running ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic',
            running ? 'qb-round qb-running' : 'qb-round', () => this._store.toggleTimer(t.id), running ? 'Pause' : 'Start'));
        top.add_child(iconButton('view-refresh-symbolic', 'qb-flat qb-tiny', () => this._store.resetTimer(t.id), 'Reset'));
        top.add_child(iconButton('window-close-symbolic', 'qb-flat qb-tiny', () => this._store.removeTimer(t.id), 'Remove'));
        card.add_child(top);

        let bar = null;
        if (t.mode === 'countdown') {
            const track = new St.Widget({style_class: 'qb-timer-track', x_expand: true});
            bar = new St.Widget({style_class: 'qb-timer-fill'});
            track.add_child(bar);
            card.add_child(track);
        }

        if (t.mode === 'countdown' && !t.finished) {
            const adj = box({style_class: 'qb-actions-row'});
            adj.add_child(textButton('−5 min', 'qb-small', () => this._store.shortenTimer(t.id, 5 * 60000)));
            adj.add_child(textButton('+5 min', 'qb-small', () => this._store.extendTimer(t.id, 5 * 60000)));
            adj.add_child(textButton('+15 min', 'qb-small', () => this._store.extendTimer(t.id, 15 * 60000)));
            card.add_child(adj);
        }

        if (t.finished && t.kind === 'pomodoro') {
            const r = box({style_class: 'qb-actions-row'});
            r.add_child(iconLabel('qb-sparkle', '+10 XP earned', 'qb-muted qb-earned'));
            r.add_child(new St.Widget({x_expand: true}));
            const brk = this._settings.get_int('break-minutes');
            r.add_child(iconTextButton('qb-coffee', `${brk}m break`, 'qb-small qb-accent', () => {
                this._store.removeTimer(t.id);
                this._store.startBreak(brk);
            }));
            r.add_child(textButton('Again', 'qb-small', () => this._store.startTimer(t.id)));
            card.add_child(r);
        }

        if (this._pickerFor === t.id) {
            card.add_child(this.questPicker(t.questId, id => {
                this._pickerFor = null;
                this._store.linkTimer(t.id, id);
            }));
        }

        this._timerWidgets.set(t.id, {time, bar, timer: t});
        this._updateTimerWidget(t.id, now);
        return card;
    }

    _updateTimerWidget(id, now) {
        const w = this._timerWidgets.get(id);
        if (!w)
            return;
        const t = w.timer;
        if (t.mode === 'countdown') {
            w.time.text = fmtTimer(this._store.timerRemaining(t, now));
            const frac = t.durationMs > 0 ? Math.min(1, this._store.timerElapsed(t, now) / t.durationMs) : 0;
            const tw = w.bar.get_parent().width || (this._left.width - 40);
            w.bar.set_width(Math.max(0, Math.round(tw * frac)));
        } else {
            w.time.text = fmtTimer(this._store.timerElapsed(t, now));
        }
    }

    // ---- render / tick ---------------------------------------------------

    /** Rebuild the visible page. Skipped (marked stale) while the popup is closed. */
    render(force = false) {
        void force;
        if (!this._open) {
            this._stale = true;
            this.calendar?.markStale();
            return;
        }
        // save typed-but-unconfirmed text before its field is rebuilt (saving re-renders by itself; that nested render is fine)
        if (!this._flushing) {
            this._flushing = true;
            try {
                flushEdits();
            } finally {
                this._flushing = false;
            }
        }
        this._stale = false;
        this._renderedDay = dateKey();
        const now = Date.now();
        this._questTimeLabels.clear();
        this._stepTimeLabels.clear();
        this._renderHeader(now);
        this._renderDeadlines(now);
        this._renderSync();
        switch (this._page) {
        case 'matrix': this._renderMatrix(now); break;
        case 'habits': this.habitsPage.render(); break;
        case 'timers': this._renderTimersPage(now); break;
        case 'shop': this.shopPage.render(); break;
        case 'detail': this._renderDetail(now); break;
        case 'progress': this.progressPage.render(now); break;
        case 'trash': this._renderTrashPage(); break;
        case 'level': this.levelPage.render(now); break;
        }
        this.calendar.render();
    }

    /** Every second while open: only text updates, no rebuilds. */
    tick(now) {
        this._renderHeader(now);
        for (const {label: l, quest} of this._questTimeLabels.values())
            if (this._store.isQuestRunning(quest.id))
                l.text = fmtSpent(this._store.questTimeMs(quest, now));
        for (const {label: l, questId, stepId} of this._stepTimeLabels.values())
            if (this._store.isStepRunning(questId, stepId))
                l.text = fmtSpent(this._store.stepTimeMs(questId, stepId, now));
        if (this._page === 'timers')
            for (const id of this._timerWidgets.keys())
                this._updateTimerWidget(id, now);
        this.calendar.tick(now);
    }

    _cleanup() {
        this._unsub?.();
        this._unsubSync?.();
        this._unsub = this._unsubSync = null;
        if (this._undoId) {
            GLib.source_remove(this._undoId);
            this._undoId = 0;
        }
    }

    destroy() {
        this._cleanup();
        this.actor.destroy();
    }
}
