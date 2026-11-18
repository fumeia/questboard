// Habits strip (on the Matrix page), Habits page, Rewards shop and Progress (goals + stats).

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {GOAL_XP, PICKABLE_ICONS, habitXp} from './store.js';
import {
    addDays, box, button, checkButton, clearChildren, dateKey, entry, flushEdits, fmtDate, fmtSpent, icon, iconButton, iconLabel,
    iconTextButton, label, scroll, startOfDay, startOfWeek, textButton,
} from './util.js';

/** A row of icon choices; returns {actor, value}. */
function iconPicker(current, onPick) {
    // rows of 10: one long row made the left side wider than the popup and pushed the calendar out of the window
    const wrap = box({vertical: true, style_class: 'qb-icon-picker'});
    let row = null;
    PICKABLE_ICONS.forEach((name, i) => {
        if (i % 10 === 0) {
            row = box({style_class: 'qb-icon-picker-row'});
            wrap.add_child(row);
        }
        row.add_child(button({style_class: name === current ? 'qb-pick-icon checked' : 'qb-pick-icon', child: icon(`qb-${name}`),
            accessible_name: name}, () => onPick(name), 'icon-pick'));
    });
    return wrap;
}

/** Cycles through options on click. */
function cycleButton(options, value, onChange, style = 'qb-small') {
    const idx = Math.max(0, options.findIndex(o => o[0] === value));
    return textButton(options[idx][1], style, () => onChange(options[(idx + 1) % options.length][0]));
}

const TARGETS = [[7, 'Daily'], [6, '6× / week'], [5, '5× / week'], [4, '4× / week'], [3, '3× / week'], [2, '2× / week'], [1, 'Weekly']];
const XP_STEPS = [[5, '5 XP'], [10, '10 XP'], [15, '15 XP'], [20, '20 XP'], [30, '30 XP'], [50, '50 XP']];

// ---------------------------------------------------------------- strip

export class HabitStrip {
    constructor(dash) {
        this._dash = dash;
        this._store = dash.ctx.store;
        this.actor = box({style_class: 'qb-habit-strip'});
    }

    render() {
        clearChildren(this.actor);
        const habits = this._store.habits();
        this.actor.visible = habits.length > 0;
        if (!habits.length)
            return;
        this.actor.add_child(label('Today', 'qb-strip-label'));
        for (const h of habits) {
            const done = this._store.isChecked(h.id);
            const inner = box({style_class: 'qb-strip-inner'});
            inner.add_child(icon(`qb-${h.icon || 'star'}`));
            const streak = this._store.habitStreak(h.id);
            if (streak > 1)
                inner.add_child(label(String(streak), 'qb-strip-streak'));
            this.actor.add_child(button({
                style_class: done ? 'qb-strip-habit checked' : 'qb-strip-habit',
                child: inner,
                accessible_name: h.title,
                y_align: Clutter.ActorAlign.CENTER,
            }, () => this._store.toggleCheckin(h.id), 'habit-strip'));
        }
        this.actor.add_child(new St.Widget({x_expand: true}));
        const done = habits.filter(h => this._store.isChecked(h.id)).length;
        this.actor.add_child(label(`${done}/${habits.length}`, 'qb-muted'));
    }
}

// ---------------------------------------------------------------- habits

export class HabitsPage {
    constructor(dash) {
        this._dash = dash;
        this._store = dash.ctx.store;
        this._expanded = null;
        this._newIcon = 'star';
        this._showNewIcons = false;

        this.actor = box({vertical: true, style_class: 'qb-page', x_expand: true, y_expand: true});
        this._list = box({vertical: true, style_class: 'qb-habit-list'});
        this.actor.add_child(scroll(this._list, {y_expand: true}));

        const add = box({vertical: true, style_class: 'qb-add-box'});
        const row = box({style_class: 'qb-actions-row'});
        this._newIconBtn = button({style_class: 'qb-pick-icon', child: icon('qb-star'), accessible_name: 'Choose icon'}, () => {
            this._showNewIcons = !this._showNewIcons;
            this.render();
        }, 'habit-icon');
        row.add_child(this._newIconBtn);
        row.add_child(entry('New habit, e.g. Read 20 pages', '', (text, e) => {
            if (this._store.addHabit(text, this._newIcon, 10, 7)) {
                e.set_text('');
                this._showNewIcons = false;
            }
        }, {x_expand: true}));
        add.add_child(row);
        this._newPicker = box({});
        add.add_child(this._newPicker);
        this.actor.add_child(add);
    }

    collapse() {
        this._expanded = null;
        this._showNewIcons = false;
    }

    render() {
        flushEdits(); // this page also re-renders on its own (open/close an editor): save typed text first
        this._newIconBtn.set_child(icon(`qb-${this._newIcon}`));
        clearChildren(this._newPicker);
        if (this._showNewIcons) {
            this._newPicker.add_child(iconPicker(this._newIcon, n => {
                this._newIcon = n;
                this._showNewIcons = false;
                this.render();
            }));
        }

        clearChildren(this._list);
        const habits = this._store.habits();
        if (!habits.length) {
            this._list.add_child(label('Build habits that pay XP every day. A 3-day streak gives +20 %, a 7-day streak +50 %.',
                'qb-empty', {wrap: true}));
            return;
        }
        const today = startOfDay(new Date());
        const ws = startOfWeek(today);
        for (const h of habits)
            this._list.add_child(this._card(h, ws, today));
    }

    _card(h, ws, today) {
        const expanded = this._expanded === h.id;
        const card = box({vertical: true, style_class: expanded ? 'qb-habit expanded' : 'qb-habit'});
        const top = box({style_class: 'qb-habit-top'});
        const doneToday = this._store.isChecked(h.id);

        top.add_child(button({style_class: doneToday ? 'qb-habit-icon checked' : 'qb-habit-icon',
            child: icon(`qb-${h.icon || 'star'}`), accessible_name: `Check in ${h.title}`, y_align: Clutter.ActorAlign.CENTER},
        () => this._store.toggleCheckin(h.id), 'habit-check'));

        const meta = box({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        meta.add_child(button({style_class: 'qb-quest-title-btn', child: label(h.title, 'qb-habit-title', {ellipsize: true, x_expand: true}),
            x_expand: true}, () => {
            this._expanded = expanded ? null : h.id;
            this.render();
        }, 'habit-title'));
        const streak = this._store.habitStreak(h.id);
        const week = this._store.habitWeekCount(h.id, today);
        const sub = box({style_class: 'qb-habit-sub'});
        sub.add_child(iconLabel('qb-flame', `${streak}d`, streak ? 'qb-streak' : 'qb-muted'));
        const target = h.target ?? 7;
        sub.add_child(label(target >= 7 ? `${week}/7 this week` : `${week}/${target} this week${week >= target ? ' · goal met' : ''}`, 'qb-muted'));
        const nextXp = habitXp(h.xp ?? 10, (doneToday ? streak : streak + 1));
        sub.add_child(iconLabel('qb-sparkle', `${nextXp} XP`, 'qb-muted'));
        meta.add_child(sub);
        top.add_child(meta);

        // this week's days
        const days = box({style_class: 'qb-habit-days', y_align: Clutter.ActorAlign.CENTER});
        for (let i = 0; i < 7; i++) {
            const d = addDays(ws, i);
            const key = dateKey(d);
            const future = d > today;
            let cls = 'qb-habit-day';
            if (this._store.isChecked(h.id, key))
                cls += ' checked';
            if (key === dateKey(today))
                cls += ' today';
            if (future)
                cls += ' future';
            const b = button({style_class: cls, child: label(fmtDate(d, '%a').slice(0, 1), 'qb-habit-day-label'),
                reactive: !future, accessible_name: fmtDate(d, '%A')}, () => this._store.toggleCheckin(h.id, key), 'habit-day');
            days.add_child(b);
        }
        top.add_child(days);
        card.add_child(top);

        if (expanded) {
            const ed = box({vertical: true, style_class: 'qb-actions'});
            ed.add_child(entry('Title', 'qb-rename', t => t.trim() && this._store.updateHabit(h.id, {title: t.trim()}),
                {text: h.title, x_expand: true, commit: true}));
            const r = box({style_class: 'qb-actions-row'});
            r.add_child(cycleButton(TARGETS, target, v => this._store.updateHabit(h.id, {target: v})));
            r.add_child(cycleButton(XP_STEPS, h.xp ?? 10, v => this._store.updateHabit(h.id, {xp: v})));
            r.add_child(new St.Widget({x_expand: true}));
            r.add_child(iconButton('user-trash-symbolic', 'qb-flat qb-tiny qb-danger', () => {
                this._expanded = null;
                const old = this._store.deleteHabit(h.id);
                if (old)
                    this._dash.showUndo(`Deleted habit “${h.title}”`, () => this._store.restoreRecord('habits', old));
            }, 'Delete habit'));
            ed.add_child(r);
            ed.add_child(iconPicker(h.icon, n => this._store.updateHabit(h.id, {icon: n})));
            card.add_child(ed);
        }
        return card;
    }
}

// ------------------------------------------------------------------ shop

export class ShopPage {
    constructor(dash) {
        this._dash = dash;
        this._store = dash.ctx.store;
        this._expanded = null;
        this._showAdd = false;
        this._newIcon = 'gift';
        this._newRepeat = true;
        this._confirm = null;

        this.actor = box({vertical: true, style_class: 'qb-page', x_expand: true, y_expand: true});

        const head = box({style_class: 'qb-shop-head'});
        const bal = box({vertical: true, x_expand: true});
        this._balance = iconLabel('qb-coin', '', 'qb-balance');
        bal.add_child(this._balance);
        bal.add_child(label('Coins = XP you earned minus what you spent. Your level never goes down.', 'qb-muted', {wrap: true}));
        head.add_child(bal);
        head.add_child(iconTextButton('qb-plus', 'Reward', 'qb-small qb-accent', () => {
            this._showAdd = !this._showAdd;
            this.render();
        }));
        this.actor.add_child(head);

        this._addBox = box({vertical: true, style_class: 'qb-add-box'});
        this.actor.add_child(this._addBox);

        this._list = box({vertical: true, style_class: 'qb-shop-list'});
        this.actor.add_child(scroll(this._list, {y_expand: true}));
    }

    /** Close editors when the popup closes or another page opens, so the shop always opens tidy. */
    collapse() {
        this._expanded = null;
        this._showAdd = false;
        this._confirm = null;
    }

    _renderAdd() {
        clearChildren(this._addBox);
        this._addBox.visible = this._showAdd;
        if (!this._showAdd)
            return;
        const row = box({style_class: 'qb-actions-row'});
        const title = entry('What do you want to earn?', '', () => submit(), {x_expand: true});
        const cost = entry('Cost', 'qb-mins', () => submit());
        const submit = () => {
            if (this._store.addReward(title.get_text(), parseInt(cost.get_text(), 10), this._newIcon, this._newRepeat)) {
                this._showAdd = false;
                this.render();
            }
        };
        row.add_child(title);
        row.add_child(cost);
        this._addBox.add_child(row);
        const r2 = box({style_class: 'qb-actions-row'});
        r2.add_child(cycleButton([[true, 'Repeatable'], [false, 'One-time']], this._newRepeat, v => {
            this._newRepeat = v;
            this.render();
        }));
        r2.add_child(new St.Widget({x_expand: true}));
        r2.add_child(textButton('Add reward', 'qb-small qb-accent', submit));
        this._addBox.add_child(r2);
        this._addBox.add_child(iconPicker(this._newIcon, n => {
            this._newIcon = n;
            this.render();
        }));
    }

    render() {
        flushEdits(); // this page also re-renders on its own (open/close an editor): save typed text first
        const balance = this._store.balance;
        this._balance.labelActor.text = `${balance.toLocaleString()} coins`;
        this._renderAdd();
        clearChildren(this._list);

        const rewards = this._store.rewards();
        if (!rewards.length)
            this._list.add_child(label('No rewards yet. Add something you would love to treat yourself to.', 'qb-empty', {wrap: true}));
        for (const r of rewards)
            this._list.add_child(this._rewardRow(r, balance));

        const hist = this._store.purchases(15);
        if (hist.length) {
            this._list.add_child(label('Recently redeemed', 'qb-section-title qb-section-done'));
            for (const l of hist) {
                const row = box({style_class: 'qb-history-row'});
                row.add_child(label(fmtDate(new Date(l.at), '%e %b'), 'qb-muted qb-history-date'));
                row.add_child(label(l.note || 'Reward', 'qb-history-title', {ellipsize: true, x_expand: true}));
                row.add_child(iconLabel('qb-coin', String(-l.amount), 'qb-muted'));
                if (Date.now() - l.at < 24 * 3600000)
                    row.add_child(iconButton('qb-undo', 'qb-flat qb-tiny', () => this._store.refund(l.id), 'Undo (refund)'));
                this._list.add_child(row);
            }
        }
    }

    _rewardRow(r, balance) {
        const expanded = this._expanded === r.id;
        const card = box({vertical: true, style_class: expanded ? 'qb-reward expanded' : 'qb-reward'});
        const top = box({style_class: 'qb-reward-top'});
        top.add_child(new St.Bin({style_class: 'qb-reward-icon', child: icon(`qb-${r.icon || 'gift'}`), y_align: Clutter.ActorAlign.CENTER}));
        const meta = box({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        meta.add_child(button({style_class: 'qb-quest-title-btn', child: label(r.title, 'qb-reward-title', {ellipsize: true, x_expand: true}),
            x_expand: true}, () => {
            this._expanded = expanded ? null : r.id;
            this.render();
        }, 'reward-title'));
        const affordable = balance >= r.cost;
        const sub = box({style_class: 'qb-habit-sub'});
        sub.add_child(iconLabel('qb-coin', r.cost.toLocaleString(), 'qb-cost'));
        if (!affordable)
            sub.add_child(label(`${(r.cost - balance).toLocaleString()} to go`, 'qb-muted'));
        if (!r.repeatable)
            sub.add_child(label('one-time', 'qb-muted'));
        meta.add_child(sub);
        if (!affordable) {
            const track = new St.Widget({style_class: 'qb-progress-track', x_expand: true});
            const fill = new St.Widget({style_class: 'qb-progress-fill'});
            track.add_child(fill);
            track.connect('notify::width', () => fill.set_width(Math.round(track.width * Math.max(0, balance) / r.cost)));
            meta.add_child(track);
        }
        top.add_child(meta);

        if (this._confirm === r.id) {
            top.add_child(textButton('Confirm', 'qb-small qb-buy', () => {
                this._confirm = null;
                if (this._store.buy(r.id))
                    this._dash.ctx.notify?.('Reward redeemed', `Enjoy: ${r.title}`);
            }));
            top.add_child(iconButton('window-close-symbolic', 'qb-flat qb-tiny', () => {
                this._confirm = null;
                this.render();
            }, 'Cancel'));
        } else {
            top.add_child(textButton('Redeem', affordable ? 'qb-small qb-buy' : 'qb-small qb-disabled', () => {
                if (!affordable)
                    return;
                this._confirm = r.id;
                this.render();
            }));
        }
        card.add_child(top);

        if (expanded) {
            const ed = box({vertical: true, style_class: 'qb-actions'});
            const row = box({style_class: 'qb-actions-row'});
            row.add_child(entry('Title', 'qb-rename', t => t.trim() && this._store.updateReward(r.id, {title: t.trim()}),
                {text: r.title, x_expand: true, commit: true}));
            row.add_child(entry('Cost', 'qb-mins', t => {
                const c = parseInt(t, 10);
                if (c > 0)
                    this._store.updateReward(r.id, {cost: c});
            }, {text: String(r.cost), commit: true}));
            ed.add_child(row);
            const r2 = box({style_class: 'qb-actions-row'});
            r2.add_child(cycleButton([[true, 'Repeatable'], [false, 'One-time']], r.repeatable !== false,
                v => this._store.updateReward(r.id, {repeatable: v})));
            r2.add_child(new St.Widget({x_expand: true}));
            r2.add_child(iconButton('user-trash-symbolic', 'qb-flat qb-tiny qb-danger', () => {
                this._expanded = null;
                const old = this._store.deleteReward(r.id);
                if (old)
                    this._dash.showUndo(`Deleted reward “${r.title}”`, () => this._store.restoreRecord('rewards', old));
            }, 'Delete reward'));
            ed.add_child(r2);
            ed.add_child(iconPicker(r.icon, n => this._store.updateReward(r.id, {icon: n})));
            const r3 = box({style_class: 'qb-actions-row'});
            r3.add_child(new St.Widget({x_expand: true}));
            r3.add_child(textButton('Done', 'qb-small qb-accent', () => {
                this._expanded = null;
                this.render();
            }));
            ed.add_child(r3);
            card.add_child(ed);
        }
        return card;
    }
}

// ------------------------------------------------------------------ progress (goals + stats)

/** Goal colours (same order as Store.kt): a goal keeps its colour; time without a goal is grey. */
const GOAL_COLORS = ['#3584e4', '#ffa348', '#2ec27e', '#c061cb', '#f8e45c', '#33c7de', '#e5534b', '#dc8add', '#8ff0a4', '#cdab8f'];
const goalColor = (order, id) => (id ? GOAL_COLORS[Math.max(0, order.indexOf(id)) % GOAL_COLORS.length] : 'rgba(255,255,255,0.4)');

const fmtDur = ms => {
    const m = Math.round(ms / 60000);
    const h = Math.floor(m / 60);
    return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
};

export class ProgressPage {
    constructor(dash) {
        this._dash = dash;
        this._store = dash.ctx.store;
        this._range = 7;
        this._goals = new GoalsSection(dash);
        this.actor = box({vertical: true, style_class: 'qb-page', x_expand: true, y_expand: true});
        this._body = box({vertical: true, style_class: 'qb-stats-body'});
        this.actor.add_child(scroll(this._body, {y_expand: true}));
    }

    /** Open a goal's card (the deadline chips under the header land here). */
    expandGoal(id) {
        this._goals.expand(id);
    }

    /** Stats: range (week / 30 days / all time), totals, a chart (bars by goal per day, or the heatmap for all time), time per goal. */
    _renderStats(b) {
        const st = this._store.stats(this._range);
        const order = this._store.goalOrder();
        const title = id => (id ? this._store.getGoal(id)?.title ?? '(deleted goal)' : 'No goal');
        const head = box({style_class: 'qb-actions-row'});
        head.add_child(label('Stats', 'qb-section-title', {x_expand: true}));
        for (const [v, t] of [[7, 'Week'], [30, '30 days'], [0, 'All time']]) {
            const btn = textButton(t, 'qb-small qb-seg', () => {
                this._range = v;
                this._picked = null;
                this._dash.render(true);
            });
            if (v === this._range)
                btn.add_style_pseudo_class('checked');
            head.add_child(btn);
        }
        b.add_child(head);

        const perDay = this._store.focusPerDay();
        const firstDay = Object.keys(perDay).filter(k => perDay[k] > 0).sort()[0];
        const days = this._range || (firstDay ? Math.round((startOfDay(new Date()) - new Date(`${firstDay}T00:00`)) / 86400000) + 1 : 1);
        const tiles = box({style_class: 'qb-tiles'});
        for (const [ic, value, caption] of [['qb-stopwatch', fmtDur(st.focusMs), 'focus'], ['qb-sun', fmtDur(st.focusMs / Math.max(1, days)), 'avg per day'],
            ['qb-sparkle', String(st.xp), 'XP'], ['qb-check', String(st.questsDone), 'quests done']]) {
            const t = box({vertical: true, style_class: 'qb-tile', x_expand: true});
            t.add_child(iconLabel(ic, value, 'qb-tile-value'));
            t.add_child(label(caption, 'qb-muted'));
            tiles.add_child(t);
        }
        b.add_child(tiles);
        b.add_child(iconLabel('qb-flame', `${st.streak}-day streak · best ${st.bestStreak} days · ${st.pomodoros} Pomodoros`, 'qb-muted'));

        if (this._range) {
            const bars = this._store.dailyByGoal(this._range);
            b.add_child(label(this._range === 7 ? 'Focus per day, by goal' : 'Focus per day, last 30 days, by goal', 'qb-section-title'));
            b.add_child(this._goalBars(bars, order, this._range === 7));
            const d = this._picked && bars.find(x => x.date === this._picked);
            b.add_child(label(d ? `${fmtDate(new Date(`${d.date}T12:00`), '%a %e %b')}: ${fmtDur(d.total)}${d.parts.length ? ' — ' +
                d.parts.map(p => `${title(p.id)} ${fmtDur(p.ms)}`).join(', ') : ''}` : 'Click a day for its details.', 'qb-muted', {wrap: true}));
        } else {
            b.add_child(label('Every day you studied', 'qb-section-title'));
            b.add_child(this._heatmap(perDay));
            const studied = Object.keys(perDay).filter(k => perDay[k] > 0).sort();
            let best = 0, run = 0, prev = null;
            for (const k of studied) {
                const c = new Date(`${k}T12:00`);
                run = prev && Math.round((c - prev) / 86400000) === 1 ? run + 1 : 1;
                best = Math.max(best, run);
                prev = c;
            }
            const total = Object.values(perDay).reduce((a, v) => a + v, 0);
            b.add_child(label(`${studied.length} days with focus time · longest run ${best} days · ${fmtDur(total)} in total`, 'qb-muted', {wrap: true}));
        }

        // time per goal, in the colours of the bars
        b.add_child(label('Time per goal', 'qb-section-title'));
        const gt = st.byGoal;
        if (!gt.length)
            b.add_child(label('No focus time yet. Link quests to goals and start a timer.', 'qb-empty', {wrap: true}));
        const gTotal = Math.max(1, gt.reduce((a, g) => a + g.ms, 0));
        for (const g of gt) {
            const color = goalColor(order, g.id);
            const row = box({vertical: true, style_class: 'qb-topic-row'});
            const top = box({});
            top.add_child(new St.Widget({style_class: 'qb-goal-swatch', style: `background-color: ${color};`, y_align: Clutter.ActorAlign.CENTER}));
            top.add_child(label(g.title, g.id ? 'qb-topic-name' : 'qb-muted', {ellipsize: true, x_expand: true}));
            top.add_child(label(`${fmtDur(g.ms)} · ${Math.round(100 * g.ms / gTotal)} %`, 'qb-muted'));
            row.add_child(top);
            const track = new St.Widget({style_class: 'qb-progress-track', x_expand: true});
            const fill = new St.Widget({style_class: 'qb-goal-fill', style: `background-color: ${color};`});
            track.add_child(fill);
            track.connect('notify::width', () => fill.set_width(Math.round(track.width * g.ms / gTotal)));
            row.add_child(track);
            b.add_child(row);
        }
    }

    /** One bar per day, stacked by goal (first goal at the bottom); click a bar for the day's breakdown. */
    _goalBars(bars, order, week) {
        const H = 90;
        const chart = box({style_class: week ? 'qb-chart' : 'qb-chart qb-chart-month'});
        const max = Math.max(1, ...bars.map(d => d.total));
        bars.forEach((d, i) => {
            const col = box({vertical: true, style_class: 'qb-chart-col', x_expand: true});
            if (week)
                col.add_child(label(d.total ? fmtDur(d.total) : '', 'qb-chart-value', {x_align: Clutter.ActorAlign.CENTER}));
            const area = new St.Widget({style_class: 'qb-chart-area', y_expand: true, x_expand: true, layout_manager: new Clutter.BinLayout()});
            const h = d.total ? Math.max(3, Math.round(H * d.total / max)) : 1;
            const stack = box({vertical: true, style_class: this._picked === d.date ? 'qb-stack picked' : 'qb-stack',
                x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.END, height: h});
            if (!d.total)
                stack.set_style('background-color: rgba(255,255,255,0.08);');
            let used = 0;
            const parts = [...d.parts].reverse();  // drawn top to bottom: the first goal ends up at the bottom
            parts.forEach((p, j) => {
                const ph = j === parts.length - 1 ? h - used : Math.max(1, Math.round(h * p.ms / d.total));
                used += ph;
                stack.add_child(new St.Widget({height: Math.max(0, ph), x_expand: true, style: `background-color: ${goalColor(order, p.id)};`}));
            });
            area.add_child(stack);
            col.add_child(area);
            const day = new Date(`${d.date}T12:00`);
            col.add_child(label(week ? fmtDate(day, '%a').slice(0, 2) : (i % 5 === 4 || i === bars.length - 1 ? String(day.getDate()) : ''),
                'qb-chart-day', {x_align: Clutter.ActorAlign.CENTER}));
            chart.add_child(button({style_class: 'qb-chart-btn', child: col, x_expand: true}, () => {
                this._picked = this._picked === d.date ? null : d.date;
                this._dash.render(true);
            }, 'chart-day'));
        });
        return chart;
    }

    /** Anki-style calendar: one column per week, one square per day, darker green = more focus. The last 26 weeks fit the popup. */
    _heatmap(perDay) {
        const today = startOfDay(new Date());
        const WEEKS = 26;
        const start = addDays(startOfWeek(today), -7 * (WEEKS - 1));  // a Monday
        const level = ms => {
            const m = ms / 60000;
            return m <= 0 ? 0 : m < 30 ? 0.25 : m < 60 ? 0.45 : m < 120 ? 0.65 : m < 180 ? 0.85 : 1;
        };
        const cellStyle = l => (l ? `background-color: rgba(46,194,126,${l});` : 'background-color: rgba(255,255,255,0.07);');
        const wrap = box({vertical: true, style_class: 'qb-heatmap'});
        const months = box({style_class: 'qb-heat-row'});
        const grid = box({style_class: 'qb-heat-row'});
        const names = box({vertical: true, style_class: 'qb-heat-col'});
        months.add_child(new St.Widget({style_class: 'qb-heat-name'}));
        for (let i = 0; i < 7; i++)
            names.add_child(label(i % 2 === 0 ? fmtDate(addDays(start, i), '%a').slice(0, 2) : '', 'qb-heat-name'));
        grid.add_child(names);
        for (let w = 0; w < WEEKS; w++) {
            const monday = addDays(start, 7 * w);
            const newMonth = w === 0 || monday.getMonth() !== addDays(monday, -7).getMonth();
            months.add_child(label(newMonth ? fmtDate(monday, '%b') : '', 'qb-heat-month'));
            const col = box({vertical: true, style_class: 'qb-heat-col'});
            for (let i = 0; i < 7; i++) {
                const day = addDays(monday, i);
                const cell = new St.Widget({style_class: 'qb-heat-cell'});
                if (day <= today)
                    cell.set_style(cellStyle(level(perDay[dateKey(day)] ?? 0)));
                col.add_child(cell);
            }
            grid.add_child(col);
        }
        wrap.add_child(months);
        wrap.add_child(grid);
        const legend = box({style_class: 'qb-heat-row'});
        legend.add_child(label('less ', 'qb-muted'));
        for (const l of [0, 0.25, 0.45, 0.65, 0.85, 1])
            legend.add_child(new St.Widget({style_class: 'qb-heat-cell', style: cellStyle(l), y_align: Clutter.ActorAlign.CENTER}));
        legend.add_child(label(' more  (under 30 min · 1 h · 2 h · 3 h · more)', 'qb-muted'));
        wrap.add_child(legend);
        return wrap;
    }

    /** Last 7 days against the 7 before. */
    _renderReview(b, now) {
        const r = this._store.weekReview(new Date(now));
        const tiles = box({style_class: 'qb-tiles'});
        const tile = (ic, value, caption, prev) => {
            const t = box({vertical: true, style_class: 'qb-tile', x_expand: true});
            t.add_child(iconLabel(ic, value, 'qb-tile-value'));
            t.add_child(label(prev === null ? caption : `${caption} · before ${prev}`, 'qb-muted'));
            tiles.add_child(t);
        };
        tile('qb-stopwatch', fmtSpent(r.focusThis) || '0m', 'focus', fmtSpent(r.focusPrev) || '0m');
        tile('qb-check', String(r.questsThis), 'quests done', String(r.questsPrev));
        tile('qb-star', String(r.goalsReached), 'goals reached', null);
        tile('qb-flame', `${r.streak}d`, 'streak', null);
        b.add_child(tiles);
    }

    render(now = Date.now()) {
        const b = this._body;
        clearChildren(b);
        b.add_child(label('This week', 'qb-section-title'));
        this._renderReview(b, now);
        b.add_child(label('Goals', 'qb-section-title'));
        this._goals.render(b, now);
        this._renderStats(b);
        const st = this._store.stats(this._range);
        if (st.topQuests.length) {
            b.add_child(label('Most time spent on', 'qb-section-title'));
            for (const q of st.topQuests) {
                const row = box({style_class: 'qb-history-row'});
                row.add_child(label(q.title, 'qb-history-title', {ellipsize: true, x_expand: true}));
                row.add_child(label(fmtDur(q.ms), 'qb-muted'));
                b.add_child(row);
            }
        }
    }
}

// ---------------------------------------------------------------- goals

/** Long-term goals (top of the Progress page). Whole quests or single steps link to one; progress + time roll up here. */
class GoalsSection {
    constructor(dash) {
        this._dash = dash;
        this._store = dash.ctx.store;
        this._open = new Set();
        this._linking = null; // goal whose quest picker is open
    }

    expand(id) {
        this._open.add(id);
    }

    render(parent, now = Date.now()) {
        parent.add_child(entry('New long-term goal, e.g. Pass the semester — Enter', '', (txt, e) => {
            const g = this._store.addGoal(txt);
            if (g) {
                this._open.add(g.id);
                e.set_text('');
            }
        }, {x_expand: true}));
        const b = box({vertical: true, style_class: 'qb-goal-list'});
        parent.add_child(b);
        const goals = this._store.goals();
        if (!goals.length) {
            b.add_child(label(`No goals yet. Add one above, then link quests — or single steps — to it in a quest's details. Reaching a goal: +${GOAL_XP} XP.`,
                'qb-empty', {wrap: true}));
            return;
        }
        for (const g of goals)
            b.add_child(this._card(g, now));
    }

    _card(g, now) {
        const open = this._open.has(g.id);
        const p = this._store.goalProgress(g.id, now);
        const card = box({vertical: true, style_class: g.done ? 'qb-goal done' : 'qb-goal'});

        const head = box({style_class: 'qb-actions-row'});
        head.add_child(checkButton(g.done, () => this._store.setGoalDone(g.id, !g.done),
            {accessible_name: g.done ? 'Not reached yet' : 'Goal reached', where: 'goal-check'}));
        const tb = box({vertical: true, x_expand: true});
        tb.add_child(label(g.title, 'qb-goal-title', {ellipsize: true}));
        const spent = fmtSpent(p.ms);
        tb.add_child(label([p.total ? `${p.done}/${p.total} done` : 'nothing linked yet', spent, g.done ? `reached · +${GOAL_XP} XP` : '']
            .filter(Boolean).join(' · '), 'qb-muted'));
        const pace = this._store.goalPace(g.id, now);
        if (pace && !g.done) {
            const when = pace.daysLeft >= 0 ? `${pace.daysLeft} day${pace.daysLeft === 1 ? '' : 's'} left` : `${-pace.daysLeft} day${pace.daysLeft === -1 ? '' : 's'} over`;
            tb.add_child(label(`${when} · ${pace.onTrack ? 'on track' : 'behind pace'}`,
                pace.onTrack ? 'qb-muted' : 'qb-due urgent'));
        }
        head.add_child(button({style_class: 'qb-quest-title-btn', child: tb, x_expand: true}, () => {
            if (open)
                this._open.delete(g.id);
            else
                this._open.add(g.id);
            this._dash.render(true);
        }, 'goal-toggle'));
        head.add_child(label(`${Math.round(p.frac * 100)} %`, p.frac >= 1 ? 'qb-goal-pct full' : 'qb-goal-pct'));
        head.add_child(icon(open ? 'pan-up-symbolic' : 'pan-down-symbolic', 'qb-icon qb-tiny-icon'));
        card.add_child(head);

        const track = new St.Widget({style_class: 'qb-progress-track', x_expand: true});
        const fill = new St.Widget({style_class: g.done ? 'qb-goal-fill done' : 'qb-goal-fill'});
        track.add_child(fill);
        track.connect('notify::width', () => fill.set_width(Math.round(track.width * Math.min(1, p.frac))));
        card.add_child(track);

        if (!open)
            return card;

        const {quests, steps} = this._store.goalItems(g.id);
        const list = box({vertical: true, style_class: 'qb-quest-list qb-goal-items'});
        // Lernplan sessions (lectures, tutorials): one summary line and today's sessions, not dozens of rows
        const today = dateKey(new Date());
        const cal = quests.filter(q => q.source === 'lernplan');
        if (cal.length) {
            const past = cal.filter(q => (q.due?.date ?? '') <= today).length;
            list.add_child(label(`Lernplan: ${cal.filter(q => q.done).length} of ${past} sessions so far attended · ${cal.length} in total`, 'qb-muted'));
        }
        for (const q of quests.filter(x => x.source !== 'lernplan' || x.due?.date === today))
            list.add_child(this._dash._questRow(q, now, {showDot: true}));
        for (const {quest, step} of steps) {
            const row = box({style_class: step.done ? 'qb-step done' : 'qb-step'});
            row.add_child(checkButton(step.done, () => this._store.toggleStep(quest.id, step.id),
                {small: true, accessible_name: step.done ? 'Mark step as not done' : 'Complete step', where: 'goal-step'}));
            const t = box({x_expand: true});
            t.add_child(label(step.title, 'qb-step-title', {ellipsize: true}));
            t.add_child(label(`  · ${quest.title}`, 'qb-muted', {ellipsize: true, x_expand: true}));
            row.add_child(button({style_class: 'qb-quest-title-btn', child: t, x_expand: true}, () => this._dash.openQuest(quest.id), 'goal-step-open'));
            row.add_child(label(fmtSpent(this._store.stepTimeMs(quest.id, step.id, now)), 'qb-quest-time'));
            list.add_child(row);
        }
        card.add_child(list);

        if (!g.done) {
            // deadline: quick choices or an exact date (an exam is on a fixed day)
            const dl = box({style_class: 'qb-actions-row'});
            dl.add_child(label('Deadline', 'qb-muted'));
            const today = new Date();
            for (const [txt, days] of [['+1 week', 7], ['+1 month', 30], ['+3 months', 91]]) {
                const key = dateKey(addDays(today, days));
                const btn = textButton(txt, 'qb-small qb-dur', () => this._store.updateGoal(g.id, {targetDate: key}));
                if (g.targetDate === key)
                    btn.add_style_pseudo_class('checked');
                dl.add_child(btn);
            }
            card.add_child(dl);
            // exact date on a line of its own: one long row would push the popup wider than the screen allows
            const dd = box({style_class: 'qb-actions-row'});
            dd.add_child(label('or on', 'qb-muted'));
            dd.add_child(this._dash._dateEntry(g.targetDate, key => this._store.updateGoal(g.id, {targetDate: key})));
            if (g.targetDate)
                dd.add_child(iconButton('edit-clear-symbolic', 'qb-flat qb-tiny', () => this._store.updateGoal(g.id, {targetDate: null}), 'Clear deadline'));
            card.add_child(dd);
            const act = box({style_class: 'qb-actions-row'});
            act.add_child(entry('Add a quest for this goal — Enter', '', (txt, e) => {
                if (this._store.addQuest(txt, 'q2', null, {goalId: g.id}))
                    e.set_text('');
            }, {x_expand: true}));
            act.add_child(textButton('Link quest…', 'qb-small', () => {
                this._linking = this._linking === g.id ? null : g.id;
                this._dash.render(true);
            }));
            card.add_child(act);
        }
        // rename and delete together, away from the everyday buttons; a delete can be undone for a few seconds
        const ren = box({style_class: 'qb-actions-row'});
        ren.add_child(entry('Goal name', '', t => t.trim() && this._store.updateGoal(g.id, {title: t.trim()}),
            {text: g.title, x_expand: true, commit: true}));
        ren.add_child(iconButton('user-trash-symbolic', 'qb-flat qb-danger', () => {
            this._open.delete(g.id);
            const old = this._store.deleteGoal(g.id);
            if (old)
                this._dash.showUndo(`Deleted goal “${g.title}”`, () => this._store.restoreRecord('goals', old));
        }, 'Delete goal'));
        card.add_child(ren);
        if (this._linking === g.id) {
            card.add_child(this._dash.questPicker(null, id => {
                this._linking = null;
                if (id)
                    this._store.updateQuest(id, {goalId: g.id});
                else
                    this._dash.render(true);
            }));
        }
        card.add_child(label('Single steps: open a quest and use the Goal… button next to a step.', 'qb-muted', {wrap: true}));
        return card;
    }
}
