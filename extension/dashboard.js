// The popup content: header (level / XP / streak / tabs), a left pane with
// Matrix | Quests | Timers pages, and the day calendar on the right.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {CalendarView} from './calendarView.js';
import {QUADRANTS, levelInfo} from './store.js';
import {
    box, clearChildren, fmtMinutes, fmtSpent, fmtTimer, icon, iconButton, iconTextButton,
    label, scroll, textButton,
} from './util.js';

const XP_BAR_W = 84;

export class Dashboard {
    constructor({store, settings, closeMenu, openPrefs, showClassic}) {
        this._store = store;
        this._settings = settings;
        this._closeMenu = closeMenu;
        this._openPrefs = openPrefs;
        this._showClassic = showClassic;

        this._page = 'matrix';
        this._expanded = null; // quest id with its action row open
        this._pickerFor = null; // 'new' | timer id — which quest picker is open
        this._newTimerQuest = null;
        this._questTimeLabels = new Map();
        this._timerWidgets = new Map();

        this.actor = box({vertical: true, style_class: 'qb-root'});
        this.actor.connect('destroy', () => this._unsub?.());

        this._buildHeader();

        const body = box({style_class: 'qb-body', x_expand: true, y_expand: true});
        this._left = box({vertical: true, style_class: 'qb-left', x_expand: true, y_expand: true});
        this._pages = {
            matrix: this._buildMatrix(),
            quests: this._buildQuestsPage(),
            timers: this._buildTimersPage(),
        };
        for (const p of Object.values(this._pages))
            this._left.add_child(p);
        body.add_child(this._left);

        this.calendar = new CalendarView({
            store,
            settings,
            closeMenu,
            onQuestClick: id => this.focusQuest(id),
        });
        body.add_child(this.calendar.actor);
        this.actor.add_child(body);

        this._unsub = store.subscribe(() => this.render());
        this._setPage('matrix');
    }

    applySize(width, height) {
        this.actor.set_size(width, height);
        const calW = Math.round(Math.min(380, Math.max(250, width * 0.38)));
        this.calendar.setWidth(calW);
    }

    onOpen() {
        this._expanded = null;
        this._pickerFor = null;
        this._setPage('matrix');
        this.calendar.onOpen();
    }

    onClose() {
        this._expanded = null;
        this._pickerFor = null;
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

        this._statsLabel = label('', 'qb-stats', {ellipsize: true});
        h.add_child(this._statsLabel);

        h.add_child(new St.Widget({x_expand: true}));

        this._chip = new St.Button({style_class: 'qb-chip', visible: false, can_focus: true, y_align: Clutter.ActorAlign.CENTER});
        const chipBox = box({});
        chipBox.add_child(icon('alarm-symbolic'));
        this._chipLabel = label('', 'qb-chip-label');
        chipBox.add_child(this._chipLabel);
        this._chip.set_child(chipBox);
        this._chip.connect('clicked', () => this._setPage('timers'));
        h.add_child(this._chip);

        const tabs = box({style_class: 'qb-tabs', y_align: Clutter.ActorAlign.CENTER});
        this._tabs = {};
        for (const [id, text] of [['matrix', 'Matrix'], ['quests', 'Quests'], ['timers', 'Timers']]) {
            const b = textButton(text, 'qb-tab', () => this._setPage(id));
            this._tabs[id] = b;
            tabs.add_child(b);
        }
        h.add_child(tabs);

        h.add_child(iconButton('mail-unread-symbolic', 'qb-flat', () => this._showClassic(), 'Notifications (classic view)'));
        h.add_child(iconButton('preferences-system-symbolic', 'qb-flat', () => {
            this._closeMenu();
            this._openPrefs();
        }, 'Settings'));
        this.actor.add_child(h);
    }

    _renderHeader(now = Date.now()) {
        const info = levelInfo(this._store.xp);
        this._lvlLabel.text = `Lv ${info.level}`;
        this._xpFill.set_width(Math.max(2, Math.round(XP_BAR_W * info.frac)));
        this._xpLabel.text = `${info.into} / ${info.span} XP`;

        const streak = this._store.streak();
        const parts = [];
        if (streak > 0)
            parts.push(`🔥 ${streak}d`);
        parts.push(`✓ ${this._store.completedOn()}`);
        const focus = fmtSpent(this._store.focusOn(undefined, now));
        if (focus)
            parts.push(`⏱ ${focus}`);
        this._statsLabel.text = parts.join('   ');

        const running = this._store.runningTimers();
        this._tabs.timers.label = running.length ? `Timers · ${running.length}` : 'Timers';
        const t = running[0];
        if (t) {
            const shown = t.mode === 'countdown' ? this._store.timerRemaining(t, now) : this._store.timerElapsed(t, now);
            this._chipLabel.text = fmtTimer(shown);
            this._chip.show();
        } else {
            this._chip.hide();
        }
    }

    _setPage(page) {
        this._page = page;
        for (const [id, p] of Object.entries(this._pages))
            p.visible = id === page;
        for (const [id, b] of Object.entries(this._tabs)) {
            if (id === page)
                b.add_style_pseudo_class('checked');
            else
                b.remove_style_pseudo_class('checked');
        }
        this.render();
    }

    // ---- matrix ----------------------------------------------------------

    _buildMatrix() {
        const grid = new Clutter.GridLayout({
            column_homogeneous: true,
            row_homogeneous: true,
            column_spacing: 8,
            row_spacing: 8,
        });
        const w = new St.Widget({layout_manager: grid, x_expand: true, y_expand: true, style_class: 'qb-matrix'});
        this._quads = {};
        QUADRANTS.forEach((q, i) => {
            const card = box({vertical: true, style_class: `qb-quad qb-${q.id}`, x_expand: true, y_expand: true});
            const head = box({style_class: 'qb-quad-head'});
            const tb = box({vertical: true, x_expand: true});
            tb.add_child(label(q.title, 'qb-quad-title', {ellipsize: true}));
            tb.add_child(label(q.subtitle, 'qb-quad-sub', {ellipsize: true}));
            head.add_child(tb);
            const count = label('', 'qb-quad-count');
            head.add_child(count);
            card.add_child(head);

            const list = box({vertical: true, style_class: 'qb-quest-list'});
            card.add_child(scroll(list, {y_expand: true}));

            const entry = new St.Entry({style_class: 'qb-entry', hint_text: '+ Add quest…', can_focus: true, x_expand: true});
            entry.clutter_text.connect('activate', () => {
                if (this._store.addQuest(entry.get_text(), q.id))
                    entry.set_text('');
            });
            card.add_child(entry);

            grid.attach(card, i % 2, Math.floor(i / 2), 1, 1);
            this._quads[q.id] = {list, count};
        });
        return w;
    }

    _renderMatrix(now) {
        for (const q of QUADRANTS) {
            const {list, count} = this._quads[q.id];
            clearChildren(list);
            const quests = this._store.visibleQuests(q.id);
            const open = quests.filter(x => !x.done).length;
            count.text = open ? String(open) : '';
            if (!quests.length)
                list.add_child(label(q.id === 'q4' ? 'Nothing to drop 🎉' : 'No quests yet', 'qb-empty'));
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

        const check = new St.Button({
            style_class: q.done ? 'qb-check checked' : 'qb-check',
            child: icon('object-select-symbolic', 'qb-check-icon'),
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: q.done ? 'Mark as not done' : 'Complete quest',
        });
        check.connect('clicked', () => this._store.setDone(q.id, !q.done));
        row.add_child(check);

        if (showDot)
            row.add_child(new St.Widget({style_class: `qb-dot qb-${q.quadrant}`, y_align: Clutter.ActorAlign.CENTER}));

        const titleLbl = label(q.title, 'qb-quest-title', {ellipsize: true, x_expand: true, x_align: Clutter.ActorAlign.START});
        const title = new St.Button({style_class: 'qb-quest-title-btn', child: titleLbl, x_expand: true, can_focus: true});
        title.connect('clicked', () => {
            this._expanded = expanded ? null : q.id;
            this.render();
        });
        row.add_child(title);

        if (q.scheduled)
            row.add_child(label(fmtMinutes(q.scheduled.start), 'qb-quest-sched'));

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

        const rename = new St.Entry({style_class: 'qb-entry qb-rename', text: q.title, can_focus: true, x_expand: true});
        rename.clutter_text.connect('activate', () => {
            const t = rename.get_text().trim();
            if (t)
                this._store.updateQuest(q.id, {title: t});
        });
        panel.add_child(rename);

        const r1 = box({style_class: 'qb-actions-row'});
        for (const quad of QUADRANTS) {
            if (quad.id === q.quadrant)
                continue;
            const b = textButton(quad.short, `qb-small qb-move qb-${quad.id}`, () => this._store.updateQuest(q.id, {quadrant: quad.id}));
            r1.add_child(b);
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
            r2.add_child(iconTextButton('alarm-symbolic', `${pomo}m focus`, 'qb-small', () => this._store.startPomodoro(q.id, pomo)));
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
        const all = this._store.quests;
        const open = all.filter(q => !q.done);
        for (const quad of QUADRANTS) {
            const qs = open.filter(q => q.quadrant === quad.id);
            if (!qs.length)
                continue;
            const head = box({style_class: `qb-section qb-${quad.id}`});
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
        bar.add_child(iconTextButton('alarm-symbolic', 'Pomodoro', 'qb-small qb-accent', () =>
            this._store.startPomodoro(this._newTimerQuest, this._settings.get_int('pomodoro-minutes'))));
        bar.add_child(textButton('☕ Break', 'qb-small', () => this._store.startBreak(this._settings.get_int('break-minutes'))));
        bar.add_child(textButton('⏱ Stopwatch', 'qb-small', () =>
            this._store.addTimer({mode: 'stopwatch', kind: 'stopwatch', durationMs: 0, questId: this._newTimerQuest})));
        const mins = new St.Entry({style_class: 'qb-entry qb-mins', hint_text: 'min', can_focus: true});
        const addCustom = () => {
            const m = parseFloat(mins.get_text());
            if (!(m > 0))
                return;
            this._store.addTimer({mode: 'countdown', kind: 'custom', durationMs: Math.round(m * 60000), questId: this._newTimerQuest});
            mins.set_text('');
        };
        mins.clutter_text.connect('activate', addCustom);
        bar.add_child(mins);
        bar.add_child(iconButton('list-add-symbolic', 'qb-flat', addCustom, 'Add countdown'));
        page.add_child(bar);

        this._newLinkRow = box({vertical: true, style_class: 'qb-link-row'});
        page.add_child(this._newLinkRow);

        this._timersList = box({vertical: true, style_class: 'qb-timer-list'});
        page.add_child(scroll(this._timersList, {y_expand: true}));
        return page;
    }

    _questPicker(currentId, onPick) {
        const p = box({vertical: true, style_class: 'qb-picker'});
        const none = textButton('— No quest —', currentId ? 'qb-pick' : 'qb-pick checked', () => onPick(null));
        p.add_child(none);
        for (const q of this._store.openQuests()) {
            const inner = box({});
            inner.add_child(new St.Widget({style_class: `qb-dot qb-${q.quadrant}`, y_align: Clutter.ActorAlign.CENTER}));
            inner.add_child(label(q.title, '', {ellipsize: true, x_expand: true}));
            const b = new St.Button({style_class: q.id === currentId ? 'qb-btn qb-pick checked' : 'qb-btn qb-pick', child: inner, x_expand: true, can_focus: true});
            b.connect('clicked', () => onPick(q.id));
            p.add_child(b);
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
        const b = new St.Button({style_class: 'qb-btn qb-small qb-link', child: inner, can_focus: true, y_align: Clutter.ActorAlign.CENTER});
        b.connect('clicked', () => {
            this._pickerFor = this._pickerFor === key ? null : key;
            this.render();
        });
        return b;
    }

    _renderTimersPage(now) {
        clearChildren(this._newLinkRow);
        if (this._newTimerQuest && !this._store.getQuest(this._newTimerQuest))
            this._newTimerQuest = null;
        const lr = box({});
        lr.add_child(label('New timers count toward:', 'qb-muted'));
        lr.add_child(this._linkButton(this._newTimerQuest, 'new'));
        this._newLinkRow.add_child(lr);
        if (this._pickerFor === 'new') {
            this._newLinkRow.add_child(this._questPicker(this._newTimerQuest, id => {
                this._newTimerQuest = id;
                this._pickerFor = null;
                this.render();
            }));
        }

        clearChildren(this._timersList);
        this._timerWidgets.clear();
        const timers = this._store.timers;
        if (!timers.length) {
            this._timersList.add_child(label('No timers. Start a Pomodoro, or press ▶ on any quest.', 'qb-empty', {wrap: true}));
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
            r.add_child(label(`+10 XP earned`, 'qb-muted', {x_expand: true}));
            r.add_child(textButton(`☕ ${this._settings.get_int('break-minutes')}m break`, 'qb-small qb-accent', () => {
                this._store.removeTimer(t.id);
                this._store.startBreak(this._settings.get_int('break-minutes'));
            }));
            r.add_child(textButton('Again', 'qb-small', () => this._store.startTimer(t.id)));
            card.add_child(r);
        }

        if (this._pickerFor === t.id) {
            card.add_child(this._questPicker(t.questId, id => {
                this._pickerFor = null;
                this._store.linkTimer(t.id, id);
            }));
        }

        this._timerWidgets.set(t.id, {time, bar, card, timer: t});
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
            const track = w.bar.get_parent();
            const tw = track.width || (this._left.width - 40);
            w.bar.set_width(Math.max(0, Math.round(tw * frac)));
        } else {
            w.time.text = fmtTimer(this._store.timerElapsed(t, now));
        }
    }

    // ---- render / tick ---------------------------------------------------

    render() {
        const now = Date.now();
        this._questTimeLabels.clear();
        this._renderHeader(now);
        if (this._page === 'matrix')
            this._renderMatrix(now);
        else if (this._page === 'quests')
            this._renderQuestsPage(now);
        else
            this._renderTimersPage(now);
        this.calendar.render();
    }

    /** Called every second while the popup is open. */
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

    destroy() {
        this._unsub?.();
        this._unsub = null;
        this.actor.destroy();
    }
}
