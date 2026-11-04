// Day timeline: Google Calendar events (read via the shell's calendar server,
// written via eds-helper.js) merged with quests scheduled into time slots.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Calendar from 'resource:///org/gnome/shell/ui/calendar.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';

import {parseEventId} from './eds.js';
import {QUADRANTS} from './store.js';
import {
    addDays, box, button, clearChildren, dateKey, entry, fmtDate, fmtHour, fmtMinutes, guard, icon, iconButton,
    iconTextButton, label, parseTime, sameDay, scroll, startOfDay, startOfWeek, textButton, vadjustment,
} from './util.js';

const HOUR_H = 44;
const GUTTER = 46;

/** Assign side-by-side columns to overlapping items. */
function layoutColumns(items) {
    items.sort((a, b) => a.start - b.start || b.end - a.end);
    let cluster = [], colEnds = [], clusterEnd = -Infinity;
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

function hexToRgba(hex, a) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex ?? '');
    return m ? `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})` : null;
}

export class CalendarView {
    constructor(ctx) {
        this._ctx = ctx;
        this._store = ctx.store;
        this._settings = ctx.settings;
        this._eds = ctx.eds;
        this._log = ctx.log;
        this._onQuestClick = ctx.onQuestClick;
        this._viewDate = startOfDay(new Date());
        this._selSlot = null;
        this._quickMode = 'quest';
        this._quickQuadrant = 'q2';
        this._quickCal = null;
        this._source = null;
        this._sourceIds = [];
        this._renderId = 0;
        this._pendingScroll = null;
        this._tlWidth = 280;
        this._editor = null; // {mode:'new'|'edit', ...draft}
        this._status = null;
        this._open = false;

        this.actor = box({vertical: true, style_class: 'qb-cal', y_expand: true});
        this.actor.connect('destroy', () => this._onDestroy());

        const head = box({style_class: 'qb-cal-head'});
        head.add_child(iconButton('go-previous-symbolic', 'qb-flat', () => this.setDate(addDays(this._viewDate, -1)), 'Previous day'));
        this._todayBtn = textButton('Today', 'qb-flat qb-small', () => this.setDate(new Date()));
        head.add_child(this._todayBtn);
        head.add_child(iconButton('go-next-symbolic', 'qb-flat', () => this.setDate(addDays(this._viewDate, 1)), 'Next day'));
        this._title = label('', 'qb-cal-title', {ellipsize: true, x_expand: true});
        head.add_child(this._title);
        head.add_child(iconButton('qb-plus', 'qb-flat', () => this.openNewEvent(), 'New event'));
        this.actor.add_child(head);

        this._week = box({style_class: 'qb-week'});
        this.actor.add_child(this._week);
        this._allDay = box({vertical: true, style_class: 'qb-allday'});
        this.actor.add_child(this._allDay);
        this._quick = box({vertical: true, style_class: 'qb-quick', visible: false});
        this.actor.add_child(this._quick);
        this._editorBox = box({vertical: true, style_class: 'qb-editor', visible: false});
        this.actor.add_child(this._editorBox);

        this._timeline = new St.Widget({style_class: 'qb-timeline'});
        this._timeline.set_height(24 * HOUR_H);
        const tlWrap = box({vertical: true});
        tlWrap.add_child(this._timeline);
        this._scroll = scroll(tlWrap, {y_expand: true, style_class: 'qb-scroll qb-cal-scroll vfade'});
        this.actor.add_child(this._scroll);
        const adj = vadjustment(this._scroll);
        if (adj)
            this._adjId = adj.connect('changed', () => this._applyScroll());

        this._footer = box({style_class: 'qb-cal-foot'});
        this.actor.add_child(this._footer);
        this._nowLine = null;
    }

    setWidth(w) {
        this.actor.set_width(w);
        this._tlWidth = Math.max(160, w - 28);
        this._timeline.set_width(this._tlWidth);
    }

    // ---- event source ----------------------------------------------------

    _ensureSource() {
        if (this._source)
            return;
        try {
            this._source = Main.sessionMode.showCalendarEvents ? new Calendar.DBusEventSource() : new Calendar.EmptyEventSource();
        } catch (e) {
            this._log.exception('calendar', e);
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
            this._source._lastRequestBegin = null;
        this._source.requestRange(this._rangeBegin, this._rangeEnd);
    }

    _queueRender() {
        if (this._renderId || !this._open)
            return;
        this._renderId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, 120, () => {
            this._renderId = 0;
            this.render();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---- public ----------------------------------------------------------

    onOpen() {
        this._open = true;
        this._ensureSource();
        this._viewDate = startOfDay(new Date());
        this._selSlot = null;
        this._editor = null;
        this._status = null;
        this._requestRange(true);
        this._scrollToFocus();
        if (this._eds && !this._eds.unavailable)
            this._eds.calendars().then(() => this._queueRender()).catch(e => this._log.warn('calendar', `list failed: ${e.message}`));
    }

    onClose() {
        this._open = false;
        this._editor = null;
        this._selSlot = null;
    }

    setDate(d) {
        const day = startOfDay(d);
        const changed = !sameDay(day, this._viewDate);
        this._viewDate = day;
        this._selSlot = null;
        if (this._editor?.mode === 'new')
            this._editor.date = day;
        this._requestRange(false);
        this.render();
        if (changed)
            this._scrollToFocus();
    }

    scheduleQuest(id) {
        let start = this._selSlot;
        if (start === null) {
            const now = new Date();
            start = sameDay(now, this._viewDate)
                ? Math.min(23 * 60, Math.ceil((now.getHours() * 60 + now.getMinutes()) / 30) * 30)
                : this._settings.get_int('day-start-hour') * 60;
        }
        this._selSlot = null;
        this._store.updateQuest(id, {scheduled: {date: dateKey(this._viewDate), start, duration: 60}});
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

    // ---- calendars -------------------------------------------------------

    _writableCals() {
        return (this._eds?.cachedCalendars ?? []).filter(c => c.writable);
    }

    _defaultCal() {
        const cals = this._writableCals();
        const pref = this._settings.get_string('default-calendar');
        return cals.find(c => c.uid === pref) ?? cals.find(c => /google/i.test(c.backend) || /@/.test(c.account)) ?? cals[0] ?? null;
    }

    _calName(uid) {
        const c = (this._eds?.cachedCalendars ?? []).find(x => x.uid === uid);
        return c ? c.name : 'Calendar';
    }

    // ---- quick add (click on empty slot) --------------------------------

    _selectSlot(minutes) {
        this._selSlot = minutes;
        this._editor = null;
        this.render();
        if (minutes !== null)
            this._quickEntry?.grab_key_focus();
    }

    _renderQuick() {
        clearChildren(this._quick);
        this._quickEntry = null;
        this._quick.visible = this._selSlot !== null && !this._editor;
        if (!this._quick.visible)
            return;
        const top = box({style_class: 'qb-quick-top'});
        top.add_child(label(`${fmtDate(this._viewDate, '%a %e %b')} · ${fmtMinutes(this._selSlot)}`, 'qb-quick-label', {x_expand: true}));
        for (const [m, text] of [['quest', 'Quest'], ['event', 'Event']]) {
            const b = textButton(text, 'qb-small qb-seg', () => {
                this._quickMode = m;
                this.render();
                this._quickEntry?.grab_key_focus();
            });
            if (this._quickMode === m)
                b.add_style_pseudo_class('checked');
            top.add_child(b);
        }
        top.add_child(iconButton('window-close-symbolic', 'qb-flat qb-tiny', () => this._selectSlot(null), 'Cancel'));
        this._quick.add_child(top);

        const row = box({style_class: 'qb-quick-top'});
        const isEvent = this._quickMode === 'event';
        this._quickEntry = entry(isEvent ? 'Event title… (Enter)' : 'Quest for this slot… (Enter)', '', t => this._quickAdd(t), {x_expand: true});
        row.add_child(this._quickEntry);
        if (isEvent) {
            row.add_child(iconButton('document-edit-symbolic', 'qb-flat qb-tiny', () =>
                this.openNewEvent(this._selSlot, this._quickEntry.get_text()), 'More options'));
        } else {
            for (const q of QUADRANTS) {
                const b = button({style_class: `qb-qdot qb-${q.id}`, accessible_name: q.title, y_align: Clutter.ActorAlign.CENTER}, () => {
                    this._quickQuadrant = q.id;
                    this.render();
                    this._quickEntry?.grab_key_focus();
                }, 'qdot');
                if (q.id === this._quickQuadrant)
                    b.add_style_pseudo_class('checked');
                row.add_child(b);
            }
        }
        this._quick.add_child(row);
        if (isEvent) {
            const cal = this._quickCal ? this._writableCals().find(c => c.uid === this._quickCal) : this._defaultCal();
            this._quick.add_child(this._calPicker(cal?.uid ?? null, uid => {
                this._quickCal = uid;
                this.render();
            }));
        }
    }

    _quickAdd(text) {
        text = text.trim();
        if (this._selSlot === null || !text)
            return;
        if (this._quickMode === 'quest') {
            this._store.addQuest(text, this._quickQuadrant, {date: dateKey(this._viewDate), start: this._selSlot, duration: 60});
            this._selSlot = null;
            this.render();
            return;
        }
        const start = new Date(this._viewDate.getTime() + this._selSlot * 60000);
        const cal = this._quickCal ?? this._defaultCal()?.uid;
        this._selSlot = null;
        this._saveEvent({mode: 'new', source: cal, summary: text, start, end: new Date(start.getTime() + 3600000), allDay: false});
    }

    // ---- event editor ----------------------------------------------------

    openNewEvent(slot = null, title = '') {
        const startMin = slot ?? (sameDay(new Date(), this._viewDate)
            ? Math.ceil((new Date().getHours() * 60 + new Date().getMinutes() + 1) / 30) * 30
            : this._settings.get_int('day-start-hour') * 60);
        const start = new Date(this._viewDate.getTime() + Math.min(startMin, 23 * 60) * 60000);
        this._selSlot = null;
        this._editor = {mode: 'new', source: this._defaultCal()?.uid ?? null, summary: title, start,
            end: new Date(start.getTime() + 3600000), allDay: false, location: '', description: ''};
        this.render();
    }

    _openEvent(ev) {
        const {source, uid, rid} = parseEventId(ev.id);
        const allDay = ev.allDay;
        this._selSlot = null;
        this._editor = {mode: 'edit', source, uid, rid, summary: ev.title, start: new Date(ev.date), end: new Date(ev.evEnd),
            allDay, location: '', description: '', recurring: !!rid, scope: 'this', loading: true};
        this.render();
        if (!this._eds)
            return;
        const ed = this._editor;
        this._eds.call({cmd: 'get', source, uid, rid}).then(d => {
            if (this._editor !== ed)
                return;
            Object.assign(ed, {location: d.location, description: d.description, allDay: d.allDay,
                recurring: d.recurring, loading: false});
            this.render();
        }).catch(e => {
            if (this._editor !== ed)
                return;
            ed.loading = false;
            ed.loadError = e.message;
            this.render();
        });
    }

    _renderEditor() {
        clearChildren(this._editorBox);
        const ed = this._editor;
        this._editorBox.visible = !!ed;
        if (!ed)
            return;
        if (this._eds?.unavailable) {
            this._editorBox.add_child(label(this._eds.unavailable.error, 'qb-editor-title'));
            this._editorBox.add_child(label(`Run once in a terminal:\n${this._eds.unavailable.hint}`, 'qb-muted', {wrap: true}));
            const r = box({style_class: 'qb-actions-row'});
            r.add_child(new St.Widget({x_expand: true}));
            r.add_child(textButton('Close', 'qb-small', () => this._closeEditor()));
            this._editorBox.add_child(r);
            return;
        }

        const head = box({style_class: 'qb-actions-row'});
        head.add_child(label(ed.mode === 'new' ? 'New event' : (ed.loading ? 'Loading…' : 'Edit event'), 'qb-editor-title', {x_expand: true}));
        head.add_child(iconButton('window-close-symbolic', 'qb-flat qb-tiny', () => this._closeEditor(), 'Close'));
        this._editorBox.add_child(head);

        const title = entry('Title', '', () => save(), {text: ed.summary ?? '', x_expand: true});
        title.clutter_text.connect('text-changed', () => (ed.summary = title.get_text()));
        this._editorBox.add_child(title);

        // date row
        const dr = box({style_class: 'qb-actions-row'});
        const shiftDays = n => {
            ed.start = addDays(ed.start, n);
            ed.end = addDays(ed.end, n);
            this.render();
        };
        dr.add_child(iconButton('go-previous-symbolic', 'qb-flat qb-tiny', () => shiftDays(-1), 'Day earlier'));
        dr.add_child(label(fmtDate(ed.start, '%a %e %b'), 'qb-editor-date', {x_expand: true, x_align: Clutter.ActorAlign.CENTER}));
        dr.add_child(iconButton('go-next-symbolic', 'qb-flat qb-tiny', () => shiftDays(1), 'Day later'));
        const ad = textButton('All day', 'qb-small qb-seg', () => {
            ed.allDay = !ed.allDay;
            if (ed.allDay) {
                ed.start = startOfDay(ed.start);
                ed.end = addDays(ed.start, 1);
            } else {
                ed.start = new Date(startOfDay(ed.start).getTime() + this._settings.get_int('day-start-hour') * 3600000);
                ed.end = new Date(ed.start.getTime() + 3600000);
            }
            this.render();
        });
        if (ed.allDay)
            ad.add_style_pseudo_class('checked');
        dr.add_child(ad);
        this._editorBox.add_child(dr);

        // time row
        let startE = null, endE = null;
        if (!ed.allDay) {
            const tr = box({style_class: 'qb-actions-row'});
            const minsOf = d => d.getHours() * 60 + d.getMinutes();
            startE = entry('Start', 'qb-time', () => save(), {text: fmtMinutes(minsOf(ed.start))});
            endE = entry('End', 'qb-time', () => save(), {text: fmtMinutes(minsOf(ed.end))});
            tr.add_child(startE);
            tr.add_child(label('–', 'qb-muted'));
            tr.add_child(endE);
            tr.add_child(new St.Widget({x_expand: true}));
            const shift = m => {
                readTimes();
                ed.start = new Date(ed.start.getTime() + m * 60000);
                ed.end = new Date(ed.end.getTime() + m * 60000);
                this.render();
            };
            tr.add_child(textButton('−15', 'qb-small', () => shift(-15)));
            tr.add_child(textButton('+15', 'qb-small', () => shift(15)));
            this._editorBox.add_child(tr);
        }
        const readTimes = () => {
            if (!startE)
                return true;
            const s = parseTime(startE.get_text());
            const e = parseTime(endE.get_text());
            if (s === null || e === null) {
                this._setStatus('error', 'Times look like 14:30 or 2:30pm');
                return false;
            }
            const day = startOfDay(ed.start);
            ed.start = new Date(day.getTime() + s * 60000);
            ed.end = new Date(day.getTime() + (e <= s ? e + 1440 : e) * 60000);
            return true;
        };

        const loc = entry('Location', '', () => save(), {text: ed.location ?? '', x_expand: true});
        loc.clutter_text.connect('text-changed', () => (ed.location = loc.get_text()));
        this._editorBox.add_child(loc);
        const notes = entry('Notes', '', () => save(), {text: ed.description ?? '', x_expand: true});
        notes.clutter_text.connect('text-changed', () => (ed.description = notes.get_text()));
        this._editorBox.add_child(notes);

        if (ed.mode === 'new') {
            this._editorBox.add_child(this._calPicker(ed.source, uid => {
                ed.source = uid;
                this.render();
            }));
        } else {
            const info = box({style_class: 'qb-actions-row'});
            info.add_child(label(this._calName(ed.source), 'qb-muted', {x_expand: true, ellipsize: true}));
            if (ed.recurring) {
                for (const [s, t] of [['this', 'This event'], ['all', 'All in series']]) {
                    const b = textButton(t, 'qb-small qb-seg', () => {
                        ed.scope = s;
                        this.render();
                    });
                    if (ed.scope === s)
                        b.add_style_pseudo_class('checked');
                    info.add_child(b);
                }
            }
            this._editorBox.add_child(info);
        }

        const save = guard(() => {
            if (!readTimes())
                return;
            this._saveEvent(ed);
        }, 'event-save');

        const actions = box({style_class: 'qb-actions-row'});
        if (ed.mode === 'edit') {
            if (ed.confirmDelete) {
                actions.add_child(textButton('Really delete', 'qb-small qb-danger-btn', () => this._deleteEvent(ed)));
                actions.add_child(textButton('Keep', 'qb-small', () => {
                    ed.confirmDelete = false;
                    this.render();
                }));
            } else {
                actions.add_child(iconButton('user-trash-symbolic', 'qb-flat qb-tiny qb-danger', () => {
                    ed.confirmDelete = true;
                    this.render();
                }, 'Delete event'));
                actions.add_child(iconTextButton('qb-target', 'To quest', 'qb-small', () => {
                    const m = ed.start.getHours() * 60 + ed.start.getMinutes();
                    this._store.addQuest(ed.summary || 'Event', 'q2', ed.allDay ? null
                        : {date: dateKey(ed.start), start: m, duration: Math.max(15, Math.round((ed.end - ed.start) / 60000))});
                    this._setStatus('ok', 'Added as a quest');
                }));
            }
        }
        actions.add_child(new St.Widget({x_expand: true}));
        if (this._status)
            actions.add_child(label(this._status.text, this._status.kind === 'error' ? 'qb-status error' : 'qb-status',
                {ellipsize: true}));
        actions.add_child(textButton(ed.saving ? 'Saving…' : 'Save', 'qb-small qb-accent', save));
        this._editorBox.add_child(actions);
        if (ed.loadError)
            this._editorBox.add_child(label(ed.loadError, 'qb-status error', {wrap: true}));
    }

    _calPicker(currentUid, onPick) {
        const cals = this._writableCals();
        const row = box({style_class: 'qb-actions-row'});
        if (!cals.length) {
            row.add_child(label(this._eds?.unavailable ? this._eds.unavailable.hint : 'No writable calendar found', 'qb-muted', {wrap: true}));
            return row;
        }
        const idx = Math.max(0, cals.findIndex(c => c.uid === currentUid));
        const cal = cals[idx];
        const inner = box({});
        const dot = new St.Widget({style_class: 'qb-dot', y_align: Clutter.ActorAlign.CENTER});
        if (cal.color)
            dot.set_style(`background-color: ${cal.color};`);
        inner.add_child(dot);
        inner.add_child(label(cal.account ? `${cal.name} · ${cal.account}` : cal.name, '', {ellipsize: true}));
        if (cals.length > 1)
            inner.add_child(icon('pan-down-symbolic'));
        row.add_child(button({style_class: 'qb-btn qb-small qb-link', child: inner, x_expand: true},
            () => onPick(cals[(idx + 1) % cals.length].uid), 'cal-pick'));
        if (currentUid !== cal.uid)
            onPick && GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                onPick(cal.uid);
                return GLib.SOURCE_REMOVE;
            });
        return row;
    }

    _closeEditor() {
        this._editor = null;
        this._status = null;
        this.render();
    }

    _setStatus(kind, text) {
        this._status = {kind, text};
        this.render();
    }

    async _saveEvent(ed) {
        if (!this._eds)
            return;
        if (!ed.source) {
            this._setStatus('error', 'Pick a calendar first');
            return;
        }
        if (!(ed.summary ?? '').trim()) {
            this._setStatus('error', 'Give it a title');
            return;
        }
        ed.saving = true;
        this.render();
        const args = {
            source: ed.source, summary: ed.summary.trim(), allDay: !!ed.allDay,
            start: Math.floor(ed.start.getTime() / 1000), end: Math.floor(ed.end.getTime() / 1000),
            location: ed.location ?? '', description: ed.description ?? '',
        };
        try {
            if (ed.mode === 'new') {
                await this._eds.call({cmd: 'create', ...args});
                this._log.info('calendar', 'event created', {start: args.start});
            } else {
                await this._eds.call({cmd: 'update', uid: ed.uid, rid: ed.rid, scope: ed.scope, ...args});
                this._log.info('calendar', 'event updated');
            }
            this._settings.set_string('default-calendar', ed.source);
            if (this._editor === ed)
                this._editor = null;
            this._status = null;
            this._requestRange(true);
            this.render();
            this._ctx.notifyQuiet?.('Saved to calendar');
        } catch (e) {
            ed.saving = false;
            if (!this._editor && ed.mode === 'new')
                this._editor = ed; // quick-add failed: reopen editor with the draft
            this._log.warn('calendar', `save failed: ${e.message}`);
            this._setStatus('error', e.message.slice(0, 120));
        }
    }

    async _deleteEvent(ed) {
        try {
            await this._eds.call({cmd: 'delete', source: ed.source, uid: ed.uid, rid: ed.rid, scope: ed.scope});
            this._log.info('calendar', 'event deleted');
            this._editor = null;
            this._status = null;
            this._requestRange(true);
            this.render();
        } catch (e) {
            this._log.warn('calendar', `delete failed: ${e.message}`);
            this._setStatus('error', e.message.slice(0, 120));
        }
    }

    // ---- scrolling -------------------------------------------------------

    _scrollToFocus() {
        const now = new Date();
        const hour = sameDay(now, this._viewDate) ? Math.max(0, now.getHours() - 1) : this._settings.get_int('day-start-hour');
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
            const color = this._eds?.colorFor(parseEventId(ev.id).source);
            if (ev.date <= begin && ev.end >= end) {
                allDay.push({kind: 'event', title: ev.summary, id: ev.id, date: ev.date, evEnd: ev.end, allDay: true, color});
                continue;
            }
            const s = Math.max(ev.date.getTime(), begin.getTime());
            const e = Math.min(ev.end.getTime(), end.getTime());
            const start = (s - begin.getTime()) / 60000;
            const stop = (e - begin.getTime()) / 60000;
            timed.push({kind: 'event', id: ev.id, title: ev.summary, date: ev.date, evEnd: ev.end, allDay: false, color,
                start, end: Math.max(start + 15, stop), label: `${fmtMinutes(start)} – ${fmtMinutes(stop)}`});
        }
        const key = dateKey(begin);
        for (const q of this._store.quests) {
            if (q.scheduled?.date !== key)
                continue;
            const start = q.scheduled.start;
            const dur = q.scheduled.duration ?? 60;
            timed.push({kind: 'quest', id: q.id, title: q.title, quadrant: q.quadrant, done: q.done,
                start, end: start + Math.max(15, dur), label: `${fmtMinutes(start)} – ${fmtMinutes(start + dur)}`});
        }
        return {allDay, timed};
    }

    _hasItems(day) {
        const begin = startOfDay(day);
        if (this._source?.hasEvents?.(begin))
            return true;
        const key = dateKey(begin);
        return this._store.quests.some(q => !q.done && (q.scheduled?.date === key || q.due?.date === key));
    }

    // ---- rendering -------------------------------------------------------

    render() {
        if (!this._open)
            return;
        const today = new Date();
        this._title.text = fmtDate(this._viewDate, '%A, %e %B');
        if (sameDay(today, this._viewDate))
            this._todayBtn.add_style_pseudo_class('checked');
        else
            this._todayBtn.remove_style_pseudo_class('checked');
        this._renderWeek(today);
        this._renderAllDay();
        this._renderQuick();
        this._renderEditor();
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
            this._week.add_child(button({style_class: cls, child: col, x_expand: true}, () => this.setDate(d), 'day'));
        }
    }

    _renderAllDay() {
        clearChildren(this._allDay);
        const {allDay} = this._itemsFor(this._viewDate);
        const due = this._store.dueOn(dateKey(this._viewDate));
        this._allDay.visible = allDay.length + due.length > 0;
        for (const q of due) {
            const inner = box({style_class: 'qb-due-chip-inner'});
            inner.add_child(icon('qb-target'));
            inner.add_child(label(`Due: ${q.title}`, '', {ellipsize: true, x_expand: true}));
            this._allDay.add_child(button({style_class: `qb-allday-item qb-due-chip qb-${q.quadrant}`, child: inner, x_expand: true},
                () => this._onQuestClick(q.id), 'due-chip'));
        }
        for (const ev of allDay) {
            const b = button({style_class: 'qb-allday-item', child: label(ev.title, '', {ellipsize: true}), x_expand: true},
                () => this._openEvent(ev), 'allday');
            const bg = hexToRgba(ev.color, 0.45);
            if (bg)
                b.set_style(`background-color: ${bg};`);
            this._allDay.add_child(b);
        }
    }

    _renderTimeline() {
        const tl = this._timeline;
        clearChildren(tl);
        this._nowLine = null;
        const width = this._tlWidth;
        const area = width - GUTTER - 2;

        for (let h = 0; h < 24; h++) {
            const y = h * HOUR_H;
            const line = new St.Widget({style_class: 'qb-hour-line'});
            line.set_position(GUTTER - 4, y);
            line.set_size(width - GUTTER + 4, 1);
            tl.add_child(line);
            const lbl = label(fmtHour(h), 'qb-hour-label');
            lbl.set_position(0, Math.max(0, y - 7));
            lbl.set_width(GUTTER - 8);
            tl.add_child(lbl);
        }

        // One reactive layer for empty-slot clicks instead of 48 buttons.
        const hit = new St.Widget({reactive: true, style_class: 'qb-slot-layer'});
        hit.set_position(GUTTER, 0);
        hit.set_size(area, 24 * HOUR_H);
        hit.connect('button-release-event', guard((_a, ev) => {
            const [, y] = hit.transform_stage_point(...ev.get_coords());
            const slot = Math.max(0, Math.min(47, Math.floor(y / (HOUR_H / 2)))) * 30;
            this._selectSlot(this._selSlot === slot ? null : slot);
            return Clutter.EVENT_STOP;
        }, 'slot'));
        tl.add_child(hit);
        if (this._selSlot !== null) {
            const sel = new St.Widget({style_class: 'qb-slot selected'});
            sel.set_position(GUTTER, this._selSlot * HOUR_H / 60);
            sel.set_size(area, HOUR_H / 2);
            tl.add_child(sel);
        }

        const {timed} = this._itemsFor(this._viewDate);
        for (const it of layoutColumns(timed)) {
            const colW = area / it.ncols;
            const x = GUTTER + it.col * colW + 1;
            const y = it.start * HOUR_H / 60;
            const h = Math.max(18, (it.end - it.start) * HOUR_H / 60 - 2);

            const content = box({vertical: true, x_expand: true});
            content.add_child(label(it.title, 'qb-block-title', {ellipsize: true}));
            if (h >= 34)
                content.add_child(label(it.label, 'qb-block-time', {ellipsize: true}));

            let cls = it.kind === 'event' ? 'qb-block qb-event' : `qb-block qb-qblock qb-${it.quadrant}`;
            if (it.done)
                cls += ' done';
            const btn = button({style_class: cls, child: content, x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.FILL},
                () => (it.kind === 'quest' ? this._onQuestClick(it.id) : this._openEvent(it)), 'block');
            if (it.kind === 'event') {
                const bg = hexToRgba(it.color, 0.5);
                const border = it.color && /^#/.test(it.color) ? it.color.slice(0, 7) : null;
                if (bg)
                    btn.set_style(`background-color: ${bg};${border ? ` border-left-color: ${border};` : ''}`);
            }
            btn.set_position(Math.round(x), Math.round(y) + 1);
            btn.set_size(Math.max(20, Math.round(colW - 3)), Math.round(h));
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
            const n = this._writableCals().length;
            const txt = src.isLoading ? 'Syncing calendars…'
                : this._eds?.unavailable ? 'Read-only · install gir1.2-ecal-2.0 to edit'
                    : `Google via Online Accounts${n ? ` · ${n} editable` : ''}`;
            this._footer.add_child(label(txt, 'qb-muted', {x_expand: true, ellipsize: true}));
        } else {
            this._footer.add_child(label('No calendar linked', 'qb-muted', {x_expand: true, ellipsize: true}));
            this._footer.add_child(textButton('Connect Google', 'qb-small qb-accent', () => {
                Util.spawn(['gnome-control-center', 'online-accounts']);
                this._ctx.closeMenu();
            }));
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
