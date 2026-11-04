// Day timeline: Google Calendar events (via GNOME Online Accounts /
// evolution-data-server, the same source GNOME's own calendar popup uses)
// merged with quests that have been scheduled into time slots.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Calendar from 'resource:///org/gnome/shell/ui/calendar.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';

import {QUADRANTS} from './store.js';
import {
    addDays, box, clearChildren, dateKey, fmtDate, fmtHour, fmtMinutes, iconButton,
    label, sameDay, scroll, startOfDay, startOfWeek, textButton, vadjustment,
} from './util.js';

const HOUR_H = 44;
const GUTTER = 46;
const DAY_MS = 86400000;

/** Assign side-by-side columns to overlapping items. */
function layoutColumns(items) {
    items.sort((a, b) => a.start - b.start || b.end - a.end);
    let cluster = [];
    let colEnds = [];
    let clusterEnd = -Infinity;
    const flush = () => {
        for (const it of cluster)
            it.ncols = colEnds.length;
        cluster = [];
        colEnds = [];
        clusterEnd = -Infinity;
    };
    for (const it of items) {
        if (cluster.length && it.start >= clusterEnd)
            flush();
        let c = colEnds.findIndex(e => e <= it.start);
        if (c < 0) {
            c = colEnds.length;
            colEnds.push(it.end);
        } else {
            colEnds[c] = it.end;
        }
        it.col = c;
        cluster.push(it);
        clusterEnd = Math.max(clusterEnd, it.end);
    }
    flush();
    return items;
}

export class CalendarView {
    constructor({store, settings, onQuestClick, closeMenu}) {
        this._store = store;
        this._settings = settings;
        this._onQuestClick = onQuestClick;
        this._closeMenu = closeMenu;
        this._viewDate = startOfDay(new Date());
        this._selSlot = null;
        this._quickQuadrant = 'q2';
        this._source = null;
        this._sourceIds = [];
        this._renderId = 0;
        this._pendingScroll = null;
        this._tlWidth = 280;

        this.actor = box({vertical: true, style_class: 'qb-cal', y_expand: true});
        this.actor.connect('destroy', () => this._onDestroy());

        // header
        const head = box({style_class: 'qb-cal-head'});
        head.add_child(iconButton('go-previous-symbolic', 'qb-flat', () => this.setDate(addDays(this._viewDate, -1)), 'Previous day'));
        this._todayBtn = textButton('Today', 'qb-flat qb-small', () => this.setDate(new Date()));
        head.add_child(this._todayBtn);
        head.add_child(iconButton('go-next-symbolic', 'qb-flat', () => this.setDate(addDays(this._viewDate, 1)), 'Next day'));
        this._title = label('', 'qb-cal-title', {ellipsize: true, x_expand: true});
        head.add_child(this._title);
        head.add_child(iconButton('x-office-calendar-symbolic', 'qb-flat', () => this._launchCalendarApp(), 'Open calendar app'));
        this.actor.add_child(head);

        this._week = box({style_class: 'qb-week'});
        this.actor.add_child(this._week);

        this._allDay = box({vertical: true, style_class: 'qb-allday'});
        this.actor.add_child(this._allDay);

        // quick add (shown after clicking an empty slot)
        this._quick = box({vertical: true, style_class: 'qb-quick', visible: false});
        const qTop = box({style_class: 'qb-quick-top'});
        this._quickLabel = label('', 'qb-quick-label', {x_expand: true});
        qTop.add_child(this._quickLabel);
        this._quickDots = {};
        for (const q of QUADRANTS) {
            const b = new St.Button({style_class: `qb-qdot qb-${q.id}`, can_focus: true, accessible_name: q.title, y_align: Clutter.ActorAlign.CENTER});
            b.connect('clicked', () => {
                this._quickQuadrant = q.id;
                this._syncQuickDots();
            });
            this._quickDots[q.id] = b;
            qTop.add_child(b);
        }
        qTop.add_child(iconButton('window-close-symbolic', 'qb-flat qb-tiny', () => this._selectSlot(null), 'Cancel'));
        this._quick.add_child(qTop);
        this._quickEntry = new St.Entry({style_class: 'qb-entry', hint_text: 'Quest for this slot…', can_focus: true, x_expand: true});
        this._quickEntry.clutter_text.connect('activate', () => this._quickAdd());
        this._quick.add_child(this._quickEntry);
        this.actor.add_child(this._quick);

        // timeline
        this._timeline = new St.Widget({style_class: 'qb-timeline', reactive: false});
        this._timeline.set_height(24 * HOUR_H);
        const tlWrap = box({vertical: true});
        tlWrap.add_child(this._timeline);
        this._scroll = scroll(tlWrap, {y_expand: true, style_class: 'qb-scroll qb-cal-scroll vfade'});
        this.actor.add_child(this._scroll);
        const adj = vadjustment(this._scroll);
        if (adj)
            this._adjId = adj.connect('changed', () => this._applyScroll());

        // footer
        this._footer = box({style_class: 'qb-cal-foot'});
        this.actor.add_child(this._footer);

        this._nowLine = null;
    }

    setWidth(w) {
        this.actor.set_width(w);
        // padding (2×8) + overlay scrollbar room
        this._tlWidth = Math.max(160, w - 28);
        this._timeline.set_width(this._tlWidth);
        this.render();
    }

    // ---- event source ----------------------------------------------------

    _ensureSource() {
        if (this._source)
            return;
        try {
            this._source = Main.sessionMode.showCalendarEvents ? new Calendar.DBusEventSource() : new Calendar.EmptyEventSource();
        } catch (e) {
            console.error(`[Questboard] calendar source failed: ${e}`);
            this._source = new Calendar.EmptyEventSource();
        }
        this._sourceIds = [
            this._source.connect('changed', () => this._queueRender()),
            this._source.connect('notify::has-calendars', () => this._queueRender()),
        ];
    }

    /** The shell's calendar server keeps one shared range; claim ours. */
    _requestRange(force = false) {
        if (!this._source)
            return;
        const ws = startOfWeek(this._viewDate);
        if (!force && this._rangeBegin && ws >= this._rangeBegin && addDays(ws, 7) <= this._rangeEnd)
            return;
        this._rangeBegin = addDays(ws, -7);
        this._rangeEnd = addDays(ws, 35);
        if (force && '_lastRequestBegin' in this._source)
            this._source._lastRequestBegin = null; // make requestRange re-send even if unchanged
        this._source.requestRange(this._rangeBegin, this._rangeEnd);
    }

    _queueRender() {
        if (this._renderId)
            return;
        this._renderId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._renderId = 0;
            this.render();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---- public ----------------------------------------------------------

    onOpen() {
        this._ensureSource();
        this._viewDate = startOfDay(new Date());
        this._selSlot = null;
        this._quick.hide();
        this._requestRange(true);
        this.render();
        this._scrollToFocus();
    }

    setDate(d) {
        const day = startOfDay(d);
        const changed = !sameDay(day, this._viewDate);
        this._viewDate = day;
        this._selectSlot(null);
        this._requestRange(false);
        this.render();
        if (changed)
            this._scrollToFocus();
    }

    /** Put an existing quest into the selected slot (or the next sensible one). */
    scheduleQuest(id) {
        let start = this._selSlot;
        if (start === null) {
            const now = new Date();
            if (sameDay(now, this._viewDate))
                start = Math.min(23 * 60, Math.ceil((now.getHours() * 60 + now.getMinutes()) / 30) * 30);
            else
                start = this._settings.get_int('day-start-hour') * 60;
        }
        this._store.updateQuest(id, {scheduled: {date: dateKey(this._viewDate), start, duration: 60}});
        this._selectSlot(null);
    }

    get selectedSlotLabel() {
        return this._selSlot === null ? null : fmtMinutes(this._selSlot);
    }

    tick(now) {
        if (!this._nowLine)
            return;
        const d = new Date(now);
        this._nowLine.set_y(Math.round((d.getHours() * 60 + d.getMinutes()) * HOUR_H / 60));
    }

    // ---- interaction -----------------------------------------------------

    _selectSlot(minutes) {
        this._selSlot = minutes;
        if (minutes === null) {
            this._quick.hide();
        } else {
            this._quickLabel.text = `${fmtDate(this._viewDate, '%a %e %b')} · ${fmtMinutes(minutes)}`;
            this._syncQuickDots();
            this._quick.show();
            this._quickEntry.grab_key_focus();
        }
        this._renderTimeline();
    }

    _syncQuickDots() {
        for (const [id, b] of Object.entries(this._quickDots)) {
            if (id === this._quickQuadrant)
                b.add_style_pseudo_class('checked');
            else
                b.remove_style_pseudo_class('checked');
        }
    }

    _quickAdd() {
        const text = this._quickEntry.get_text();
        if (this._selSlot === null || !text.trim())
            return;
        this._store.addQuest(text, this._quickQuadrant, {date: dateKey(this._viewDate), start: this._selSlot, duration: 60});
        this._quickEntry.set_text('');
        this._selectSlot(null);
    }

    _launchCalendarApp() {
        const app = Shell.AppSystem.get_default().lookup_app('org.gnome.Calendar.desktop');
        if (app) {
            app.activate();
        } else {
            const d = this._viewDate;
            Gio.AppInfo.launch_default_for_uri(
                `https://calendar.google.com/calendar/r/day/${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`, null);
        }
        this._closeMenu();
    }

    _openOnlineAccounts() {
        Util.spawn(['gnome-control-center', 'online-accounts']);
        this._closeMenu();
    }

    _scrollToFocus() {
        const now = new Date();
        const hour = sameDay(now, this._viewDate)
            ? Math.max(0, now.getHours() - 1)
            : this._settings.get_int('day-start-hour');
        this._pendingScroll = hour * HOUR_H;
        this._applyScroll();
        GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this._applyScroll();
            return GLib.SOURCE_REMOVE;
        });
    }

    _applyScroll() {
        const adj = vadjustment(this._scroll);
        if (!adj || this._pendingScroll === null || adj.upper <= 0 || adj.page_size <= 0)
            return;
        adj.value = Math.min(this._pendingScroll, Math.max(0, adj.upper - adj.page_size));
        this._pendingScroll = null;
    }

    // ---- data ------------------------------------------------------------

    _itemsFor(day) {
        const begin = startOfDay(day);
        const end = addDays(begin, 1);
        const allDay = [];
        const timed = [];

        const events = this._source ? this._source.getEvents(begin, end) : [];
        for (const ev of events) {
            if (ev.date <= begin && ev.end >= end) {
                allDay.push({kind: 'event', title: ev.summary});
                continue;
            }
            const s = Math.max(ev.date.getTime(), begin.getTime());
            const e = Math.min(ev.end.getTime(), end.getTime());
            const start = (s - begin.getTime()) / 60000;
            timed.push({
                kind: 'event',
                title: ev.summary,
                start,
                end: Math.max(start + 15, (e - begin.getTime()) / 60000),
                label: `${fmtMinutes(start)} – ${fmtMinutes((e - begin.getTime()) / 60000)}`,
            });
        }

        const key = dateKey(begin);
        for (const q of this._store.quests) {
            if (q.scheduled?.date !== key)
                continue;
            const start = q.scheduled.start;
            const dur = q.scheduled.duration ?? 60;
            timed.push({
                kind: 'quest', id: q.id, title: q.title, quadrant: q.quadrant, done: q.done,
                start, end: start + Math.max(15, dur),
                label: `${fmtMinutes(start)} – ${fmtMinutes(start + dur)}`,
            });
        }
        return {allDay, timed};
    }

    _hasItems(day) {
        const begin = startOfDay(day);
        if (this._source?.hasEvents?.(begin))
            return true;
        const key = dateKey(begin);
        return this._store.quests.some(q => q.scheduled?.date === key);
    }

    // ---- rendering -------------------------------------------------------

    render() {
        const today = new Date();
        this._title.text = fmtDate(this._viewDate, '%A, %e %B');
        if (sameDay(today, this._viewDate))
            this._todayBtn.add_style_pseudo_class('checked');
        else
            this._todayBtn.remove_style_pseudo_class('checked');

        this._renderWeek(today);
        this._renderAllDay();
        this._renderTimeline();
        this._renderFooter();
    }

    _renderWeek(today) {
        clearChildren(this._week);
        const ws = startOfWeek(this._viewDate);
        for (let i = 0; i < 7; i++) {
            const d = addDays(ws, i);
            const col = box({vertical: true, style_class: 'qb-day-inner'});
            col.add_child(label(fmtDate(d, '%a').slice(0, 2), 'qb-day-name', {x_align: Clutter.ActorAlign.CENTER}));
            col.add_child(label(String(d.getDate()), 'qb-day-num', {x_align: Clutter.ActorAlign.CENTER}));
            col.add_child(new St.Widget({style_class: this._hasItems(d) ? 'qb-day-dot' : 'qb-day-dot empty', x_align: Clutter.ActorAlign.CENTER}));
            let cls = 'qb-day';
            if (sameDay(d, today))
                cls += ' today';
            if (sameDay(d, this._viewDate))
                cls += ' selected';
            const b = new St.Button({style_class: cls, child: col, x_expand: true, can_focus: true});
            b.connect('clicked', () => this.setDate(d));
            this._week.add_child(b);
        }
    }

    _renderAllDay() {
        clearChildren(this._allDay);
        const {allDay} = this._itemsFor(this._viewDate);
        this._allDay.visible = allDay.length > 0;
        for (const ev of allDay)
            this._allDay.add_child(label(ev.title, 'qb-allday-item', {ellipsize: true}));
    }

    _renderTimeline() {
        const tl = this._timeline;
        clearChildren(tl);
        this._nowLine = null;
        const width = this._tlWidth;
        const area = width - GUTTER - 2;

        for (let h = 0; h < 24; h++) {
            const y = h * HOUR_H;
            const line = new St.Widget({style_class: h === 0 ? 'qb-hour-line first' : 'qb-hour-line'});
            line.set_position(GUTTER - 4, y);
            line.set_size(width - GUTTER + 4, 1);
            tl.add_child(line);
            const lbl = label(fmtHour(h), 'qb-hour-label');
            lbl.set_position(0, Math.max(0, y - 7));
            lbl.set_width(GUTTER - 8);
            tl.add_child(lbl);
        }

        // half-hour click targets
        for (let i = 0; i < 48; i++) {
            const minutes = i * 30;
            const slot = new St.Button({
                style_class: this._selSlot === minutes ? 'qb-slot selected' : 'qb-slot',
                reactive: true,
                can_focus: false,
            });
            slot.set_position(GUTTER, i * HOUR_H / 2);
            slot.set_size(area, HOUR_H / 2);
            slot.connect('clicked', () => this._selectSlot(this._selSlot === minutes ? null : minutes));
            tl.add_child(slot);
        }

        const {timed} = this._itemsFor(this._viewDate);
        for (const it of layoutColumns(timed)) {
            const colW = area / it.ncols;
            const x = GUTTER + it.col * colW + 1;
            const y = it.start * HOUR_H / 60;
            const h = Math.max(18, (it.end - it.start) * HOUR_H / 60 - 2);

            const content = box({vertical: true});
            content.add_child(label(it.title, 'qb-block-title', {ellipsize: true}));
            if (h >= 34)
                content.add_child(label(it.label, 'qb-block-time', {ellipsize: true}));

            let cls = it.kind === 'event' ? 'qb-block qb-event' : `qb-block qb-qblock qb-${it.quadrant}`;
            if (it.done)
                cls += ' done';
            const btn = new St.Button({style_class: cls, child: content, can_focus: true, x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.FILL});
            content.x_expand = true;
            btn.set_position(Math.round(x), Math.round(y) + 1);
            btn.set_size(Math.max(20, Math.round(colW - 3)), Math.round(h));
            if (it.kind === 'quest')
                btn.connect('clicked', () => this._onQuestClick(it.id));
            else
                btn.connect('clicked', () => this._launchCalendarApp());
            tl.add_child(btn);
        }

        const now = new Date();
        if (sameDay(now, this._viewDate)) {
            const line = new St.Widget({style_class: 'qb-now-line'});
            line.set_position(GUTTER - 6, Math.round((now.getHours() * 60 + now.getMinutes()) * HOUR_H / 60));
            line.set_size(width - GUTTER + 6, 2);
            tl.add_child(line);
            this._nowLine = line;
        }
    }

    _renderFooter() {
        clearChildren(this._footer);
        const src = this._source;
        if (src && src.hasCalendars) {
            this._footer.add_child(label(src.isLoading ? 'Syncing calendars…' : 'Synced via GNOME Online Accounts', 'qb-muted', {x_expand: true, ellipsize: true}));
        } else {
            this._footer.add_child(label('No calendar linked', 'qb-muted', {x_expand: true, ellipsize: true}));
            this._footer.add_child(textButton('Connect Google', 'qb-small qb-accent', () => this._openOnlineAccounts()));
        }
    }

    _onDestroy() {
        if (this._renderId) {
            GLib.source_remove(this._renderId);
            this._renderId = 0;
        }
        const adj = vadjustment(this._scroll);
        if (adj && this._adjId)
            adj.disconnect(this._adjId);
        if (this._source) {
            for (const id of this._sourceIds)
                this._source.disconnect(id);
            this._source.destroy?.();
            this._source = null;
        }
    }
}

