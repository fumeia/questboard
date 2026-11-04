// Habits strip (on the Matrix page), Habits page and Rewards shop.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {PICKABLE_ICONS, habitXp} from './store.js';
import {
    addDays, box, button, clearChildren, dateKey, entry, fmtDate, icon, iconButton, iconLabel,
    iconTextButton, label, scroll, startOfDay, startOfWeek, textButton,
} from './util.js';

/** A row of icon choices; returns {actor, value}. */
function iconPicker(current, onPick) {
    const wrap = box({style_class: 'qb-icon-picker'});
    for (const name of PICKABLE_ICONS) {
        const b = button({style_class: name === current ? 'qb-pick-icon checked' : 'qb-pick-icon', child: icon(`qb-${name}`),
            accessible_name: name}, () => onPick(name), 'icon-pick');
        wrap.add_child(b);
    }
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

    render() {
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
                {text: h.title, x_expand: true}));
            const r = box({style_class: 'qb-actions-row'});
            r.add_child(cycleButton(TARGETS, target, v => this._store.updateHabit(h.id, {target: v})));
            r.add_child(cycleButton(XP_STEPS, h.xp ?? 10, v => this._store.updateHabit(h.id, {xp: v})));
            r.add_child(new St.Widget({x_expand: true}));
            r.add_child(iconButton('user-trash-symbolic', 'qb-flat qb-tiny qb-danger', () => {
                this._expanded = null;
                this._store.deleteHabit(h.id);
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
                {text: r.title, x_expand: true}));
            row.add_child(entry('Cost', 'qb-mins', t => {
                const c = parseInt(t, 10);
                if (c > 0)
                    this._store.updateReward(r.id, {cost: c});
            }, {text: String(r.cost)}));
            ed.add_child(row);
            const r2 = box({style_class: 'qb-actions-row'});
            r2.add_child(cycleButton([[true, 'Repeatable'], [false, 'One-time']], r.repeatable !== false,
                v => this._store.updateReward(r.id, {repeatable: v})));
            r2.add_child(new St.Widget({x_expand: true}));
            r2.add_child(iconButton('user-trash-symbolic', 'qb-flat qb-tiny qb-danger', () => {
                this._expanded = null;
                this._store.deleteReward(r.id);
            }, 'Delete reward'));
            ed.add_child(r2);
            ed.add_child(iconPicker(r.icon, n => this._store.updateReward(r.id, {icon: n})));
            card.add_child(ed);
        }
        return card;
    }
}
