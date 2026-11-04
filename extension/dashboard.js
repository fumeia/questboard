// Popup content: header (level / XP / coins / streak / sync), left pane with
// Matrix | Habits | Quests | Timers | Shop, and the day calendar on the right.
//
// Performance: nothing is rebuilt while the popup is closed — changes only mark
// the view stale, and the next open renders once.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';

import {CalendarView} from './calendarView.js';
import {HabitStrip, HabitsPage, ShopPage} from './pages.js';
import {QUADRANTS, dueInDays, levelInfo, questXp} from './store.js';
import {
    addDays, box, button, clearChildren, dateKey, entry, fmtMinutes, fmtSpent, fmtTimer, gicon, icon, iconButton, iconLabel,
    iconTextButton, label, scroll, textButton,
} from './util.js';

const XP_BAR_W = 78;
const TABS = [
    ['matrix', 'qb-grid', 'Matrix'],
    ['habits', 'qb-repeat', 'Habits'],
    ['quests', 'qb-list', 'Quests'],
    ['timers', 'qb-stopwatch', 'Timers'],
    ['shop', 'qb-shop', 'Shop'],
];

export class Dashboard {
    constructor(ctx) {
        this.ctx = ctx; // {store, settings, closeMenu, openPrefs, showClassic, sync, eds, log}
        this._store = ctx.store;
        this._settings = ctx.settings;

        this._open = false;
        this._stale = true;
        this._page = 'matrix';
        this._expanded = null;
        this._pickerFor = null;
        this._newTimerQuest = null;
        this._questTimeLabels = new Map();
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
        this._pages = {
            matrix: this._buildMatrixPage(),
            habits: this.habitsPage.actor,
            quests: this._buildQuestsPage(),
            timers: this._buildTimersPage(),
            shop: this.shopPage.actor,
        };
        for (const p of Object.values(this._pages))
            this._left.add_child(p);
        body.add_child(this._left);

        this.calendar = new CalendarView({...ctx, onQuestClick: id => this.focusQuest(id)});
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

    onOpen() {
        this._open = true;
        this._expanded = null;
        this._pickerFor = null;
        this._page = 'matrix';
        this.calendar.onOpen();
        this._setPage('matrix');
    }

    onClose() {
        this._open = false;
        this._expanded = null;
        this._pickerFor = null;
        this.calendar.onClose();
    }

    focusQuest(id) {
        this._expanded = id;
        this._setPage('matrix');
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
        const w = new St.Widget({layout_manager: grid, x_expand: true, y_expand: true, style_class: 'qb-matrix'});
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
            card.add_child(scroll(list, {y_expand: true}));
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
        const expanded = this._expanded === q.id;
        let cls = 'qb-quest';
        if (q.done)
            cls += ' done';
        if (expanded)
            cls += ' expanded';
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
        row.add_child(button({style_class: 'qb-quest-title-btn', child: titleLbl, x_expand: true}, () => {
            this._expanded = expanded ? null : q.id;
            this.render(true);
        }, 'quest-title'));

        if (q.source === 'notion')
            row.add_child(icon('qb-book', 'qb-icon qb-src-icon'));
        if (q.scheduled)
            row.add_child(label(fmtMinutes(q.scheduled.start), 'qb-quest-sched'));
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
        if (expanded)
            wrap.add_child(this._questActions(q));
        return wrap;
    }

    _questActions(q) {
        const panel = box({vertical: true, style_class: 'qb-actions'});
        panel.add_child(entry('Title', 'qb-rename', t => {
            if (t.trim())
                this._store.updateQuest(q.id, {title: t.trim()});
        }, {text: q.title, x_expand: true}));
        panel.add_child(entry('Notes', 'qb-rename', t => this._store.updateQuest(q.id, {notes: t}), {text: q.notes ?? '', x_expand: true}));

        const r1 = box({style_class: 'qb-actions-row'});
        for (const quad of QUADRANTS) {
            if (quad.id !== q.quadrant)
                r1.add_child(textButton(quad.short, `qb-small qb-move qb-${quad.id}`, () => this._store.updateQuest(q.id, {quadrant: quad.id})));
        }
        r1.add_child(new St.Widget({x_expand: true}));
        r1.add_child(iconButton('user-trash-symbolic', 'qb-flat qb-tiny qb-danger', () => {
            this._expanded = null;
            this._store.deleteQuest(q.id);
        }, 'Delete quest'));
        panel.add_child(r1);

        if (!q.done) {
            const r2 = box({style_class: 'qb-actions-row'});
            const pomo = this._settings.get_int('pomodoro-minutes');
            r2.add_child(iconTextButton('qb-target', `${pomo}m focus`, 'qb-small', () => this._store.startPomodoro(q.id, pomo)));
            const slot = this.calendar.selectedSlotLabel;
            r2.add_child(iconTextButton('x-office-calendar-symbolic', slot ? `At ${slot}` : 'Schedule', 'qb-small',
                () => this.calendar.scheduleQuest(q.id)));
            if (q.scheduled) {
                r2.add_child(iconButton('edit-clear-symbolic', 'qb-flat qb-tiny', () => this._store.updateQuest(q.id, {scheduled: null}), 'Unschedule'));
                for (const [txt, mins] of [['30m', 30], ['1h', 60], ['2h', 120]]) {
                    const cls = (q.scheduled.duration ?? 60) === mins ? 'qb-small qb-dur checked' : 'qb-small qb-dur';
                    r2.add_child(textButton(txt, cls, () => this._store.updateQuest(q.id, {scheduled: {...q.scheduled, duration: mins}})));
                }
            }
            panel.add_child(r2);

            const r3 = box({style_class: 'qb-actions-row'});
            r3.add_child(label('Due', 'qb-muted'));
            const today = new Date();
            for (const [txt, days] of [['Today', 0], ['Tomorrow', 1], ['+1 week', 7]]) {
                const key = dateKey(addDays(today, days));
                const cls = q.due?.date === key ? 'qb-small qb-dur checked' : 'qb-small qb-dur';
                r3.add_child(textButton(txt, cls, () => this._store.updateQuest(q.id, {due: {date: key}})));
            }
            if (q.due)
                r3.add_child(iconButton('edit-clear-symbolic', 'qb-flat qb-tiny', () => this._store.updateQuest(q.id, {due: null}), 'Clear due date'));
            r3.add_child(new St.Widget({x_expand: true}));
            r3.add_child(label(`${questXp(q)} XP`, 'qb-muted'));
            if (q.link) {
                r3.add_child(iconButton('external-link-symbolic', 'qb-flat qb-tiny', () => {
                    Gio.AppInfo.launch_default_for_uri(q.link, null);
                    this.ctx.closeMenu();
                }, 'Open in Notion'));
            }
            panel.add_child(r3);
        }
        return panel;
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
            return;
        }
        this._stale = false;
        const now = Date.now();
        this._questTimeLabels.clear();
        this._renderHeader(now);
        this._renderSync();
        switch (this._page) {
        case 'matrix': this._renderMatrix(now); break;
        case 'habits': this.habitsPage.render(); break;
        case 'quests': this._renderQuestsPage(now); break;
        case 'timers': this._renderTimersPage(now); break;
        case 'shop': this.shopPage.render(); break;
        }
        this.calendar.render();
    }

    /** Every second while open: only text updates, no rebuilds. */
    tick(now) {
        this._renderHeader(now);
        for (const {label: l, quest} of this._questTimeLabels.values())
            if (this._store.isQuestRunning(quest.id))
                l.text = fmtSpent(this._store.questTimeMs(quest, now));
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
