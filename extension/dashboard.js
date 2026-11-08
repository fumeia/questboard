// Popup content: header (level / XP / coins / streak / sync), left pane with
// Matrix | Habits | Quests | Timers | Shop, and the day calendar on the right.
//
// Performance: nothing is rebuilt while the popup is closed — changes only mark
// the view stale, and the next open renders once.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';

import {CalendarView} from './calendarView.js';
import {HabitStrip, HabitsPage, ProgressPage, ShopPage} from './pages.js';
import {QUADRANTS, STEP_XP, dueInDays, groupBonus, levelInfo, questXp} from './store.js';
import {
    addDays, box, button, clearChildren, dateKey, entry, fmtDate, fmtMinutes, fmtSpent, fmtTimer, gicon, icon, iconButton, iconLabel,
    iconTextButton, label, scroll, textButton,
} from './util.js';

const XP_BAR_W = 78;
const TABS = [
    ['matrix', 'qb-grid', 'Matrix'],
    ['habits', 'qb-repeat', 'Habits'],
    ['quests', 'qb-list', 'Quests'],
    ['timers', 'qb-stopwatch', 'Timers'],
    ['shop', 'qb-shop', 'Shop'],
    ['progress', 'qb-trophy', 'Progress'],
];

export class Dashboard {
    constructor(ctx) {
        this.ctx = ctx; // {store, settings, closeMenu, openPrefs, showClassic, sync, eds, log}
        this._store = ctx.store;
        this._settings = ctx.settings;

        this._open = false;
        this._stale = true;
        this._page = 'matrix';
        this._pickerFor = null;
        this._openGroups = new Set(); // quests whose steps are shown inline
        this._detailId = null;
        this._newTimerQuest = null;
        this._questTimeLabels = new Map();
        this._stepTimeLabels = new Map();
        this._timerWidgets = new Map();

        this.actor = box({vertical: true, style_class: 'qb-root'});
        this.actor.connect('destroy', () => this._cleanup());

        this._buildHeader();

        const body = box({style_class: 'qb-body', x_expand: true, y_expand: true});
        this._left = box({vertical: true, style_class: 'qb-left', x_expand: true, y_expand: true});
        this._left.add_child(this._buildTabs());

        this.habitStrip = new HabitStrip(this);
        this.habitsPage = new HabitsPage(this);
        this.shopPage = new ShopPage(this);
        this.progressPage = new ProgressPage(this);
        this._pages = {
            matrix: this._buildMatrixPage(),
            habits: this.habitsPage.actor,
            quests: this._buildQuestsPage(),
            timers: this._buildTimersPage(),
            shop: this.shopPage.actor,
            progress: this.progressPage.actor,
            detail: this._buildDetailPage(),
        };
        for (const p of Object.values(this._pages))
            this._left.add_child(p);
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
        if (this._page !== 'matrix' || this._stale || this._renderedDay !== day) {
            this._setPage('matrix');      // full render, calendar included
        } else {
            this._renderHeader(t0);
            this._renderSync();
            if (calRebuild)
                this.calendar.render();
        }
        this._log?.debug?.('perf', `popup ready in ${Date.now() - t0} ms`);
    }

    /** Full rebuild of the matrix page and the calendar (fallback when opening failed). */
    rebuild() {
        this._open = true;
        this._stale = true;
        this.calendar.markStale();
        this.calendar._open = true;
        this._setPage('matrix');
    }

    showPage(page) {
        if (this._pages[page])
            this._setPage(page);
    }

    onClose() {
        this._open = false;
        this.shopPage?.collapse();
        this.habitsPage?.collapse();
        this._pickerFor = null;
        this.calendar.onClose();
    }

    focusQuest(id) {
        this.openQuest(id);
    }

    // ---- header ----------------------------------------------------------

    _buildHeader() {
        const h = box({style_class: 'qb-header'});

        const lvl = box({style_class: 'qb-level', y_align: Clutter.ActorAlign.CENTER});
        this._lvlLabel = label('', 'qb-level-badge');
        lvl.add_child(this._lvlLabel);
        const xpCol = box({vertical: true, y_align: Clutter.ActorAlign.CENTER});
        const track = new St.Widget({style_class: 'qb-xp-track', width: XP_BAR_W});
        this._xpFill = new St.Widget({style_class: 'qb-xp-fill'});
        track.add_child(this._xpFill);
        xpCol.add_child(track);
        this._xpLabel = label('', 'qb-xp-label');
        xpCol.add_child(this._xpLabel);
        lvl.add_child(xpCol);
        h.add_child(lvl);

        this._coins = iconLabel('qb-coin', '', 'qb-stat qb-coins');
        this._streak = iconLabel('qb-flame', '', 'qb-stat qb-streak');
        this._doneToday = iconLabel('qb-check', '', 'qb-stat');
        this._focus = iconLabel('qb-stopwatch', '', 'qb-stat');
        const coinBtn = button({style_class: 'qb-stat-btn', child: this._coins, y_align: Clutter.ActorAlign.CENTER},
            () => this._setPage('shop'), 'coins');
        h.add_child(coinBtn);
        for (const s of [this._streak, this._doneToday, this._focus])
            h.add_child(s);

        h.add_child(new St.Widget({x_expand: true}));

        const chipBox = box({});
        chipBox.add_child(icon('qb-stopwatch'));
        this._chipLabel = label('', 'qb-chip-label');
        chipBox.add_child(this._chipLabel);
        this._chip = button({style_class: 'qb-chip', child: chipBox, visible: false, y_align: Clutter.ActorAlign.CENTER},
            () => this._setPage('timers'), 'chip');
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
        this._lvlLabel.text = `Lv ${info.level}`;
        this._xpFill.set_width(Math.max(2, Math.round(XP_BAR_W * info.frac)));
        this._xpLabel.text = `${info.into} / ${info.span} XP`;
        this._coins.labelActor.text = this._store.balance.toLocaleString();
        const streak = this._store.streak();
        this._streak.labelActor.text = `${streak}d`;
        this._streak.visible = streak > 0;
        this._doneToday.labelActor.text = String(this._store.completedOn());
        const focus = fmtSpent(this._store.focusOn(undefined, now));
        this._focus.labelActor.text = focus;
        this._focus.visible = !!focus;

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

    /** Called by the extension when light/dark switches. */
    onThemeChanged() {
        // show what a click will switch *to*
        this._themeIcon.gicon = gicon(this.ctx.isDark?.() ? 'qb-sun' : 'qb-moon');
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

    // ---- matrix ----------------------------------------------------------

    _buildMatrixPage() {
        const page = box({vertical: true, style_class: 'qb-page', x_expand: true, y_expand: true});
        page.add_child(this.habitStrip.actor);

        const grid = new Clutter.GridLayout({column_homogeneous: true, row_homogeneous: true, column_spacing: 8, row_spacing: 8});
        const w = new St.Widget({layout_manager: grid, x_expand: true, y_expand: true, style_class: 'qb-matrix',
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
        page.add_child(w);
        return page;
    }

    _renderMatrix(now) {
        this.habitStrip.render();
        for (const q of QUADRANTS) {
            const {list, count} = this._quads[q.id];
            clearChildren(list);
            const quests = this._store.visibleQuests(q.id);
            const open = quests.filter(x => !x.done).length;
            count.text = open ? String(open) : '';
            count.visible = open > 0;
            if (!quests.length)
                list.add_child(label(q.id === 'q4' ? 'Nothing to drop' : 'No quests yet', 'qb-empty'));
            for (const quest of quests)
                list.add_child(this._questRow(quest, now));
        }
    }

    // ---- quest row -------------------------------------------------------

    _questRow(q, now, {showDot = false} = {}) {
        const steps = q.steps ?? [];
        const groupOpen = this._openGroups.has(q.id);
        let cls = 'qb-quest';
        if (q.done)
            cls += ' done';
        const wrap = box({vertical: true, style_class: cls});
        const row = box({style_class: 'qb-quest-row'});

        row.add_child(button({
            style_class: q.done ? 'qb-check checked' : 'qb-check',
            child: icon('qb-check', 'qb-check-icon'),
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: q.done ? 'Mark as not done' : 'Complete quest',
        }, () => this._store.setDone(q.id, !q.done), 'check'));

        if (showDot)
            row.add_child(new St.Widget({style_class: `qb-dot qb-${q.quadrant}`, y_align: Clutter.ActorAlign.CENTER}));

        const titleLbl = label(q.title, 'qb-quest-title', {ellipsize: true, x_expand: true, x_align: Clutter.ActorAlign.START});
        row.add_child(button({style_class: 'qb-quest-title-btn', child: titleLbl, x_expand: true},
            () => this.openQuest(q.id), 'quest-title'));

        if (steps.length) {
            const pr = this._store.stepProgress(q);
            const inner = box({});
            inner.add_child(label(`${pr.done}/${pr.total}`, 'qb-progress-pill-label'));
            inner.add_child(icon(groupOpen ? 'pan-up-symbolic' : 'pan-down-symbolic', 'qb-icon qb-tiny-icon'));
            row.add_child(button({style_class: pr.done === pr.total ? 'qb-progress-pill full' : 'qb-progress-pill', child: inner,
                y_align: Clutter.ActorAlign.CENTER, accessible_name: 'Show steps'}, () => {
                if (groupOpen)
                    this._openGroups.delete(q.id);
                else
                    this._openGroups.add(q.id);
                this.render(true);
            }, 'group-toggle'));
        }
        if (this._store.getGoal(q.goalId))
            row.add_child(icon('qb-star', 'qb-icon qb-src-icon'));
        const ext = this._store.extProgress(q);
        if (ext)
            row.add_child(label(`${ext.done}/${ext.total}`, ext.done === ext.total ? 'qb-progress-pill full' : 'qb-progress-pill',
                {y_align: Clutter.ActorAlign.CENTER}));
        if (q.source === 'notion')
            row.add_child(icon('qb-book', 'qb-icon qb-src-icon'));
        if (q.gcal)
            row.add_child(icon('x-office-calendar-symbolic', 'qb-icon qb-src-icon'));
        const t = q.scheduled?.start ?? q.eventTime?.start;
        if (t !== undefined && t !== null)
            row.add_child(label(fmtMinutes(t), 'qb-quest-sched'));
        const dd = q.done ? null : dueInDays(q);
        if (dd !== null) {
            const txt = dd < 0 ? `${-dd}d late` : dd === 0 ? 'today' : dd === 1 ? 'tomorrow' : `in ${dd}d`;
            row.add_child(label(txt, dd <= 0 ? 'qb-due urgent' : dd <= 3 ? 'qb-due soon' : 'qb-due'));
        }

        const spent = label(fmtSpent(this._store.questTimeMs(q, now)), 'qb-quest-time');
        this._questTimeLabels.set(q.id, {label: spent, quest: q});
        row.add_child(spent);

        if (!q.done) {
            const running = this._store.isQuestRunning(q.id);
            row.add_child(iconButton(
                running ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic',
                running ? 'qb-flat qb-tiny qb-running' : 'qb-flat qb-tiny',
                () => this._store.toggleQuestTimer(q.id),
                running ? 'Pause timer' : 'Start timer'));
        }
        wrap.add_child(row);
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
        row.add_child(button({style_class: st.done ? 'qb-check qb-check-small checked' : 'qb-check qb-check-small',
            child: icon('qb-check', 'qb-check-icon'), y_align: Clutter.ActorAlign.CENTER}, () => this._store.toggleStep(q.id, st.id), 'step'));
        const goal = this._store.getGoal(st.goalId);
        if (editable) {
            row.add_child(entry('Step', 'qb-step-entry', txt => this._store.renameStep(q.id, st.id, txt), {text: st.title, x_expand: true}));
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
        if (!st.done || running) {
            const pomo = this._settings.get_int('pomodoro-minutes');
            row.add_child(iconButton(running ? 'media-playback-pause-symbolic' : 'qb-target',
                running ? 'qb-flat qb-tiny qb-running' : 'qb-flat qb-tiny',
                () => this._store.toggleStepPomodoro(q.id, st.id, pomo),
                running ? 'Pause step timer' : `${pomo}m focus on this step`));
        }
        if (editable) {
            // cycle: no goal → each open goal → no goal
            const goals = this._store.goals().filter(g => !g.done);
            if (goals.length || goal) {
                const ids = [null, ...goals.map(g => g.id)];
                const next = ids[(ids.indexOf(goal?.id ?? null) + 1) % ids.length];
                const gb = textButton(goal ? goal.title : 'Goal…', 'qb-small qb-seg qb-step-goal',
                    () => this._store.setStepGoal(q.id, st.id, next));
                if (goal)
                    gb.add_style_pseudo_class('checked');
                row.add_child(gb);
            }
            row.add_child(iconButton('window-close-symbolic', 'qb-flat qb-tiny', () => this._store.deleteStep(q.id, st.id), 'Remove step'));
        }
        return row;
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

    _renderDetail(now) {
        const b = this._detailBody;
        clearChildren(b);
        const q = this._detailId ? this._store.getQuest(this._detailId) : null;
        const head = box({style_class: 'qb-actions-row'});
        head.add_child(iconTextButton('go-previous-symbolic', 'Back', 'qb-small', () => this._setPage(this._returnPage ?? 'matrix')));
        head.add_child(new St.Widget({x_expand: true}));
        if (q) {
            head.add_child(iconButton('user-trash-symbolic', 'qb-flat qb-danger', () => {
                this._store.deleteQuest(q.id);
                this._setPage(this._returnPage ?? 'matrix');
            }, 'Delete quest'));
        }
        b.add_child(head);
        if (!q) {
            b.add_child(label('This quest no longer exists.', 'qb-empty'));
            return;
        }

        const titleRow = box({style_class: 'qb-actions-row'});
        titleRow.add_child(button({style_class: q.done ? 'qb-check checked' : 'qb-check', child: icon('qb-check', 'qb-check-icon'),
            y_align: Clutter.ActorAlign.CENTER}, () => this._store.setDone(q.id, !q.done), 'detail-check'));
        titleRow.add_child(entry('Title', 'qb-detail-title', t => t.trim() && this._store.updateQuest(q.id, {title: t.trim()}),
            {text: q.title, x_expand: true}));
        b.add_child(titleRow);
        b.add_child(entry('Notes (Enter to save)', '', t => this._store.updateQuest(q.id, {notes: t}), {text: q.notes ?? '', x_expand: true}));

        const ext = this._store.extProgress(q);
        if (ext)
            b.add_child(label(ext.text, 'qb-muted', {x_align: Clutter.ActorAlign.START}));

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

        // topic / course
        b.add_child(label('Topic / course', 'qb-section-title'));
        const tr0 = box({style_class: 'qb-actions-row qb-wrap-row'});
        for (const t of this._store.topics().slice(0, 6)) {
            const btn = textButton(t, 'qb-small qb-seg', () => this._store.updateQuest(q.id, {topic: q.topic === t ? null : t}));
            if (q.topic === t)
                btn.add_style_pseudo_class('checked');
            tr0.add_child(btn);
        }
        tr0.add_child(entry(q.topic ? 'Rename / new topic' : 'New topic — Enter', 'qb-topic-entry', txt => {
            if (txt.trim())
                this._store.updateQuest(q.id, {topic: txt.trim()});
        }, {x_expand: true}));
        b.add_child(tr0);

        // long-term goal
        b.add_child(label('Goal', 'qb-section-title'));
        const gr = box({style_class: 'qb-actions-row qb-wrap-row'});
        const goals = this._store.goals().filter(g => !g.done || g.id === q.goalId);
        if (!goals.length)
            gr.add_child(label('No goals yet. Add long-term goals on the Progress tab; single steps can be linked too.', 'qb-muted', {wrap: true}));
        for (const g of goals) {
            const btn = textButton(g.title, 'qb-small qb-seg', () => this._store.updateQuest(q.id, {goalId: q.goalId === g.id ? null : g.id}));
            if (q.goalId === g.id)
                btn.add_style_pseudo_class('checked');
            gr.add_child(btn);
        }
        b.add_child(gr);

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
        if (q.due)
            dr.add_child(label(fmtDate(new Date(`${q.due.date}T12:00`), '%a %e %b'), 'qb-muted'));
        if (q.due)
            dr.add_child(iconButton('edit-clear-symbolic', 'qb-flat qb-tiny', () => this._store.updateQuest(q.id, {due: null}), 'Clear due date'));
        b.add_child(dr);

        const tr = box({style_class: 'qb-actions-row'});
        const s = q.scheduled;
        tr.add_child(label(s ? `Time slot: ${fmtDate(new Date(`${s.date}T12:00`), '%a %e %b')}, ${fmtMinutes(s.start)} – ${fmtMinutes(s.start + (s.duration ?? 60))}`
            : q.gcal ? 'Linked to a calendar event' : 'No time slot', 'qb-muted', {x_expand: true}));
        tr.add_child(iconTextButton('x-office-calendar-symbolic', s ? 'Change time' : 'Pick a time', 'qb-small',
            () => this.calendar.scheduleQuest(q.id)));
        if (s)
            tr.add_child(iconButton('edit-clear-symbolic', 'qb-flat qb-tiny', () => this._store.updateQuest(q.id, {scheduled: null}), 'Unschedule'));
        b.add_child(tr);

        // focus + links
        if (!q.done) {
            const fr = box({style_class: 'qb-actions-row'});
            const pomo = this._settings.get_int('pomodoro-minutes');
            fr.add_child(iconTextButton('qb-target', `${pomo}m focus`, 'qb-small', () => this._store.startPomodoro(q.id, pomo)));
            const running = this._store.isQuestRunning(q.id);
            fr.add_child(iconTextButton(running ? 'qb-pause' : 'qb-play', running ? 'Pause stopwatch' : 'Stopwatch', 'qb-small',
                () => this._store.toggleQuestTimer(q.id)));
            fr.add_child(new St.Widget({x_expand: true}));
            if (q.link) {
                const label = q.source === 'physics-rpg' ? 'Open Physics RPG' : q.source === 'notion' ? 'Open in Notion' : 'Open link';
                fr.add_child(iconTextButton('qb-book', label, 'qb-small', () => {
                    Gio.AppInfo.launch_default_for_uri(q.link, null);
                    this.ctx.closeMenu();
                }));
            }
            b.add_child(fr);
        }
    }

    // ---- quests page -----------------------------------------------------

    _buildQuestsPage() {
        const page = box({vertical: true, style_class: 'qb-page', x_expand: true, y_expand: true});
        this._questsList = box({vertical: true, style_class: 'qb-quest-list'});
        page.add_child(scroll(this._questsList, {y_expand: true}));
        const foot = box({style_class: 'qb-page-foot'});
        this._archiveLabel = label('', 'qb-muted', {x_expand: true});
        foot.add_child(this._archiveLabel);
        foot.add_child(textButton('Clear completed', 'qb-small', () => this._store.clearCompleted()));
        page.add_child(foot);
        return page;
    }

    _renderQuestsPage(now) {
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
            this._questsList.add_child(label('Your quest log is empty. Add quests in the Matrix.', 'qb-empty'));
        const arch = this._store.archivedCount();
        this._archiveLabel.text = arch ? `${arch} older completed quest${arch === 1 ? '' : 's'} archived` : '';
    }

    // ---- timers page -----------------------------------------------------

    _buildTimersPage() {
        const page = box({vertical: true, style_class: 'qb-page', x_expand: true, y_expand: true});
        const bar = box({style_class: 'qb-new-timer'});
        bar.add_child(iconTextButton('qb-target', 'Pomodoro', 'qb-small qb-accent', () =>
            this._store.startPomodoro(this._newTimerQuest, this._settings.get_int('pomodoro-minutes'))));
        bar.add_child(iconTextButton('qb-coffee', 'Break', 'qb-small', () => this._store.startBreak(this._settings.get_int('break-minutes'))));
        bar.add_child(iconTextButton('qb-stopwatch', 'Stopwatch', 'qb-small', () =>
            this._store.addTimer({mode: 'stopwatch', kind: 'stopwatch', durationMs: 0, questId: this._newTimerQuest})));
        const addCustom = (text, e) => {
            const m = parseFloat(text);
            if (!(m > 0))
                return;
            this._store.addTimer({mode: 'countdown', kind: 'custom', durationMs: Math.round(m * 60000), questId: this._newTimerQuest});
            e.set_text('');
        };
        const mins = entry('min', 'qb-mins', addCustom);
        bar.add_child(mins);
        bar.add_child(iconButton('qb-plus', 'qb-flat', () => addCustom(mins.get_text(), mins), 'Add countdown'));
        page.add_child(bar);

        this._newLinkRow = box({vertical: true, style_class: 'qb-link-row'});
        page.add_child(this._newLinkRow);
        this._timersList = box({vertical: true, style_class: 'qb-timer-list'});
        page.add_child(scroll(this._timersList, {y_expand: true}));
        return page;
    }

    questPicker(currentId, onPick) {
        const p = box({vertical: true, style_class: 'qb-picker'});
        p.add_child(textButton('No quest', currentId ? 'qb-pick' : 'qb-pick checked', () => onPick(null)));
        for (const q of this._store.openQuests()) {
            const inner = box({});
            inner.add_child(new St.Widget({style_class: `qb-dot qb-${q.quadrant}`, y_align: Clutter.ActorAlign.CENTER}));
            inner.add_child(label(q.title, '', {ellipsize: true, x_expand: true}));
            p.add_child(button({style_class: q.id === currentId ? 'qb-btn qb-pick checked' : 'qb-btn qb-pick', child: inner, x_expand: true},
                () => onPick(q.id), 'pick'));
        }
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
        clearChildren(this._newLinkRow);
        if (this._newTimerQuest && !this._store.getQuest(this._newTimerQuest))
            this._newTimerQuest = null;
        const lr = box({style_class: 'qb-link-line'});
        lr.add_child(label('New timers count toward', 'qb-muted'));
        lr.add_child(this._linkButton(this._newTimerQuest, 'new'));
        this._newLinkRow.add_child(lr);
        if (this._pickerFor === 'new') {
            this._newLinkRow.add_child(this.questPicker(this._newTimerQuest, id => {
                this._newTimerQuest = id;
                this._pickerFor = null;
                this.render(true);
            }));
        }

        clearChildren(this._timersList);
        this._timerWidgets.clear();
        const timers = this._store.timers;
        if (!timers.length) {
            this._timersList.add_child(label('No timers yet. Start a Pomodoro, or press play on any quest.', 'qb-empty', {wrap: true}));
            return;
        }
        for (const t of timers)
            this._timersList.add_child(this._timerCard(t, now));
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
        const kindText = {pomodoro: 'Pomodoro', break: 'Break', stopwatch: 'Stopwatch', custom: 'Countdown'}[t.kind] ?? 'Timer';
        meta.add_child(label(t.finished ? `${kindText} · done` : kindText, 'qb-timer-kind'));
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
        this._stale = false;
        this._renderedDay = dateKey();
        const now = Date.now();
        this._questTimeLabels.clear();
        this._stepTimeLabels.clear();
        this._renderHeader(now);
        this._renderSync();
        switch (this._page) {
        case 'matrix': this._renderMatrix(now); break;
        case 'habits': this.habitsPage.render(); break;
        case 'quests': this._renderQuestsPage(now); break;
        case 'timers': this._renderTimersPage(now); break;
        case 'shop': this.shopPage.render(); break;
        case 'detail': this._renderDetail(now); break;
        case 'progress': this.progressPage.render(now); break;
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
    }

    destroy() {
        this._cleanup();
        this.actor.destroy();
    }
}
