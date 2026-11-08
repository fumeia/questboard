// Day timeline: Google Calendar events (read via the shell's calendar server,
// written via eds-helper.js) merged with quests scheduled into time slots.
//
// Interaction: click once = start, click again = end → a confirm panel opens
// (new quest / existing quest / calendar event). Clicking a quest block edits its
// time; clicking an event edits the event. Quests can be *linked* to an event
// (quest.gcal) — then the event itself shows the quest marker, no duplicate block.
//
// Performance: the hour grid is built once per width; only the blocks layer is
// rebuilt, and only when its content signature changes.

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
const SNAP = 15; // minutes

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

const minsOf = d => d.getHours() * 60 + d.getMinutes();
const linkKey = (source, uid, rid) => `${source}\n${uid}\n${rid ?? ''}`;

export class CalendarView {
    constructor(ctx) {
        this._ctx = ctx;
        this._store = ctx.store;
        this._settings = ctx.settings;
        this._eds = ctx.eds;
        this._log = ctx.log;
        this._viewDate = startOfDay(new Date());
        this._pick = null; // first click {start}
        this._editor = null;
        this._status = null;
        this._source = null;
        this._sourceIds = [];
        this._renderId = 0;
        this._pendingScroll = null;
        this._tlWidth = 280;
        this._blocksSig = '';
        this._open = false;
        this._calError = null;
        this._stale = true;      // something changed while the popup was closed → rebuild on the next open
        this._lastForce = 0;     // last forced re-query of the shell's calendar server
        this._timers = new Set();
        // calendar list (colours, writable calendars) comes from a separate gjs process: fetch it once in the
        // background after login, so opening the popup never waits for it
        this._later(20000, () => this._loadCalendars());

        this.actor = box({vertical: true, style_class: 'qb-cal', y_expand: true});
        this.actor.connect('destroy', () => this._onDestroy());

        const head = box({style_class: 'qb-cal-head'});
        head.add_child(iconButton('go-previous-symbolic', 'qb-flat', () => this.setDate(addDays(this._viewDate, -1)), 'Previous day'));
        this._todayBtn = textButton('Today', 'qb-flat qb-small', () => this.setDate(new Date()));
        head.add_child(this._todayBtn);
        head.add_child(iconButton('go-next-symbolic', 'qb-flat', () => this.setDate(addDays(this._viewDate, 1)), 'Next day'));
        this._title = label('', 'qb-cal-title', {ellipsize: true, x_expand: true});
        head.add_child(this._title);
        head.add_child(iconButton('qb-plus', 'qb-flat', () => this._openSlot(this._defaultStart(), null), 'New'));
        this.actor.add_child(head);

        this._week = box({style_class: 'qb-week'});
        this.actor.add_child(this._week);
        this._allDay = box({vertical: true, style_class: 'qb-allday'});
        this.actor.add_child(this._allDay);
        this._hint = box({style_class: 'qb-quick qb-pick-hint', visible: false});
        this.actor.add_child(this._hint);
        this._editorBox = box({vertical: true, style_class: 'qb-editor', visible: false});
        this.actor.add_child(this._editorBox);

        // timeline: [bg grid][hit layer][selection][blocks][now line]
        this._timeline = new St.Widget({style_class: 'qb-timeline'});
        this._timeline.set_height(24 * HOUR_H);
        this._bg = new St.Widget();
        this._timeline.add_child(this._bg);
        this._hit = new St.Widget({reactive: true, style_class: 'qb-slot-layer'});
        this._hit.connect('button-release-event', guard((_a, ev) => this._onTimelineClick(ev), 'timeline'));
        this._timeline.add_child(this._hit);
        this._sel = new St.Widget({style_class: 'qb-slot selected', visible: false});
        this._timeline.add_child(this._sel);
        this._blocks = new St.Widget();
        this._timeline.add_child(this._blocks);
        this._nowLine = new St.Widget({style_class: 'qb-now-line', visible: false});
        this._timeline.add_child(this._nowLine);

        const tlWrap = box({vertical: true});
        tlWrap.add_child(this._timeline);
        this._scroll = scroll(tlWrap, {y_expand: true, style_class: 'qb-scroll qb-cal-scroll vfade'});
        this.actor.add_child(this._scroll);
        const adj = vadjustment(this._scroll);
        if (adj)
            this._adjId = adj.connect('changed', () => this._applyScroll());

        this._footer = box({style_class: 'qb-cal-foot'});
        this.actor.add_child(this._footer);
    }

    setWidth(w) {
        this.actor.set_width(w);
        this._tlWidth = Math.max(160, w - 28);
        this._timeline.set_width(this._tlWidth);
        this._buildGrid();
        this._blocksSig = '';
    }

    _buildGrid() {
        clearChildren(this._bg);
        const width = this._tlWidth;
        for (let h = 0; h < 24; h++) {
            const y = h * HOUR_H;
            const line = new St.Widget({style_class: 'qb-hour-line'});
            line.set_position(GUTTER - 4, y);
            line.set_size(width - GUTTER + 4, 1);
            this._bg.add_child(line);
            const lbl = label(fmtHour(h), 'qb-hour-label');
            lbl.set_position(0, Math.max(0, y - 7));
            lbl.set_width(GUTTER - 8);
            this._bg.add_child(lbl);
        }
        this._hit.set_position(GUTTER, 0);
        this._hit.set_size(width - GUTTER - 2, 24 * HOUR_H);
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

    /** Run fn once after ms at low priority (cancelled on destroy). */
    _later(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_LOW, ms, () => {
            this._timers.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.add(id);
    }

    markStale() {
        this._stale = true;
    }

    _queueRender() {
        if (!this._open) {
            this._stale = true;
            return;
        }
        if (this._renderId)
            return;
        this._renderId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, 150, () => {
            this._renderId = 0;
            this.render();
            return GLib.SOURCE_REMOVE;
        });
    }

    _loadCalendars(force = false) {
        if (!this._eds || this._eds.unavailable)
            return;
        this._eds.calendars(force).then(() => {
            this._calError = null;
            this._blocksSig = '';
            this._queueRender();
        }).catch(e => {
            this._calError = e.message;
            this._log.warn('calendar', `list failed: ${e.message}`);
            this._queueRender();
        });
    }

    // ---- public ----------------------------------------------------------

    /**
     * Popup opened. Returns true when the calendar must be rebuilt; when nothing changed since the last open, the widgets from
     * last time are kept (only the now-line moves), which is what makes opening fast on a small laptop.
     */
    onOpen() {
        this._open = true;
        this._ensureSource();
        const today = startOfDay(new Date());
        const rebuild = this._stale || !sameDay(today, this._viewDate) || !!this._editor || !!this._pick || !!this._status;
        this._viewDate = today;
        this._pick = null;
        this._editor = null;
        this._status = null;
        // the shell pushes event changes by itself; a forced re-query only every 10 minutes
        const now = Date.now();
        if (now - this._lastForce > 10 * 60000) {
            this._lastForce = now;
            this._requestRange(true);
        } else {
            this._requestRange(false);
        }
        if (this._eds && !this._eds.unavailable && this._eds.cacheAgeMs() > 30 * 60000)
            this._later(4000, () => this._open && this._loadCalendars());
        this._scrollToFocus();
        if (rebuild)
            this._blocksSig = '';
        else
            this._renderNow(new Date());
        return rebuild;
    }

    onClose() {
        this._open = false;
        this._editor = null;
        this._pick = null;
    }

    setDate(d) {
        const day = startOfDay(d);
        const changed = !sameDay(day, this._viewDate);
        this._viewDate = day;
        this._pick = null;
        if (this._editor && this._editor.kind === 'slot' && !this._editor.questId)
            this._editor.date = day;
        this._requestRange(false);
        this.render();
        if (changed)
            this._scrollToFocus();
    }

    /** "Schedule" from the quest details page: open the slot editor for that quest. */
    scheduleQuest(id) {
        const q = this._store.getQuest(id);
        if (!q)
            return;
        const s = q.scheduled;
        if (s?.date) {
            const [y, m, d] = s.date.split('-').map(Number);
            this._viewDate = new Date(y, m - 1, d);
        }
        const start = s?.start ?? this._defaultStart();
        this._openSlot(start, start + (s?.duration ?? 60), {questId: id});
    }

    get selectedSlotLabel() {
        return null;
    }

    tick(now) {
        const d = new Date(now);
        if (this._nowLine.visible)
            this._nowLine.set_y(Math.round(minsOf(d) * HOUR_H / 60));
    }

    _defaultStart() {
        const now = new Date();
        return sameDay(now, this._viewDate)
            ? Math.min(23 * 60, Math.ceil((minsOf(now) + 1) / 30) * 30)
            : this._settings.get_int('day-start-hour') * 60;
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
        return (this._eds?.cachedCalendars ?? []).find(x => x.uid === uid)?.name ?? 'Calendar';
    }

    /** Quest linked to an event (or null). */
    _linkedQuest(source, uid, rid, date = null) {
        const k = linkKey(source, uid, rid);
        const kAll = linkKey(source, uid, '');
        return this._store.quests.find(q => q.gcal && (linkKey(q.gcal.source, q.gcal.uid, q.gcal.rid) === k ||
            (!q.gcal.rid && linkKey(q.gcal.source, q.gcal.uid, '') === kAll) ||
            // made on the phone: no GNOME calendar source, only the event's iCalendar UID
            // (a repeating event has one such quest per occurrence: its due date)
            (!q.gcal.source && q.gcal.uid && q.gcal.uid === uid && (!date || !q.due?.date || q.due.date === dateKey(date))))) ?? null;
    }

    // ---- two-click selection ---------------------------------------------

    _onTimelineClick(ev) {
        const [ok, , y] = this._hit.transform_stage_point(...ev.get_coords());
        if (!ok)
            return Clutter.EVENT_STOP;
        const m = Math.max(0, Math.min(24 * 60 - SNAP, Math.round(y / HOUR_H * 60 / SNAP) * SNAP));
        if (!this._pick) {
            this._editor = null;
            this._pick = {start: m};
            this._showSelection(m, m + SNAP);
            this._renderHint();
            this._renderEditor();
            return Clutter.EVENT_STOP;
        }
        let a = this._pick.start, b = m;
        if (b < a)
            [a, b] = [b, a];
        b = Math.max(b + (b === a ? 30 : 0), a + SNAP);
        this._pick = null;
        this._openSlot(a, b);
        return Clutter.EVENT_STOP;
    }

    _showSelection(start, end) {
        this._sel.set_position(GUTTER, start * HOUR_H / 60);
        this._sel.set_size(this._tlWidth - GUTTER - 2, Math.max(4, (end - start) * HOUR_H / 60));
        this._sel.show();
    }

    _renderHint() {
        clearChildren(this._hint);
        this._hint.visible = !!this._pick;
        if (!this._pick)
            return;
        this._hint.add_child(label(`Start ${fmtMinutes(this._pick.start)} — now click the end time`, 'qb-quick-label', {x_expand: true}));
        this._hint.add_child(iconButton('window-close-symbolic', 'qb-flat qb-tiny', () => {
            this._pick = null;
            this._sel.hide();
            this._renderHint();
        }, 'Cancel'));
    }

    // ---- editors -----------------------------------------------------------

    /** Confirm panel for a time range: new quest / existing quest / calendar event. */
    _openSlot(start, end, {questId = null} = {}) {
        end ??= start + 60;
        this._pick = null;
        const q = questId ? this._store.getQuest(questId) : null;
        this._editor = {
            kind: 'slot', date: this._viewDate, start, end, questId,
            title: q?.title ?? '', target: questId ? 'existing' : 'new', pickQuest: questId,
            quadrant: 'q2', source: this._defaultCal()?.uid ?? null, alsoGoogle: !!q?.gcal, location: '',
        };
        this._showSelection(start, end);
        this.render();
    }

    _openEvent(ev) {
        const {source, uid, rid} = parseEventId(ev.id);
        this._pick = null;
        this._sel.hide();
        this._editor = {kind: 'event', mode: 'edit', source, uid, rid, summary: ev.title, start: new Date(ev.date),
            end: new Date(ev.evEnd), allDay: ev.allDay, location: '', description: '', recurring: !!rid, scope: 'this', loading: true};
        this.render();
        if (!this._eds)
            return;
        const ed = this._editor;
        this._eds.call({cmd: 'get', source, uid, rid}).then(d => {
            if (this._editor !== ed)
                return;
            Object.assign(ed, {location: d.location, description: d.description, allDay: d.allDay, recurring: d.recurring, loading: false});
            this.render();
        }).catch(e => {
            if (this._editor !== ed)
                return;
            ed.loading = false;
            ed.loadError = e.message;
            this.render();
        });
    }

    _closeEditor() {
        this._editor = null;
        this._status = null;
        this._sel.hide();
        this.render();
    }

    _setStatus(kind, text) {
        this._status = {kind, text};
        this.render();
    }

    _timeRow(ed, onShift) {
        const tr = box({style_class: 'qb-actions-row'});
        const startE = entry('Start', 'qb-time', () => ed._save?.(), {text: fmtMinutes(ed.start)});
        const endE = entry('End', 'qb-time', () => ed._save?.(), {text: fmtMinutes(ed.end)});
        tr.add_child(startE);
        tr.add_child(label('–', 'qb-muted'));
        tr.add_child(endE);
        tr.add_child(new St.Widget({x_expand: true}));
        const read = () => {
            const s = parseTime(startE.get_text());
            const e = parseTime(endE.get_text());
            if (s === null || e === null) {
                this._setStatus('error', 'Times look like 14:30 or 2:30pm');
                return false;
            }
            ed.start = s;
            ed.end = e <= s ? Math.min(24 * 60, s + 30) : e;
            return true;
        };
        const shift = m => {
            if (!read())
                return;
            ed.start = Math.max(0, ed.start + m);
            ed.end = Math.min(24 * 60, ed.end + m);
            onShift?.();
            this._showSelection(ed.start, ed.end);
            this.render();
        };
        tr.add_child(textButton('−15', 'qb-small', () => shift(-15)));
        tr.add_child(textButton('+15', 'qb-small', () => shift(15)));
        return {row: tr, read};
    }

    _dateRow(ed, extra = null) {
        const dr = box({style_class: 'qb-actions-row'});
        const shiftDay = n => {
            ed.date = addDays(ed.date, n);
            this._viewDate = ed.date;
            this._requestRange(false);
            this.render();
        };
        dr.add_child(iconButton('go-previous-symbolic', 'qb-flat qb-tiny', () => shiftDay(-1), 'Day earlier'));
        dr.add_child(label(fmtDate(ed.date, '%a %e %b'), 'qb-editor-date', {x_expand: true, x_align: Clutter.ActorAlign.CENTER}));
        dr.add_child(iconButton('go-next-symbolic', 'qb-flat qb-tiny', () => shiftDay(1), 'Day later'));
        if (extra)
            dr.add_child(extra);
        return dr;
    }

    _seg(options, value, onPick) {
        const row = box({style_class: 'qb-actions-row'});
        for (const [v, text] of options) {
            const b = textButton(text, 'qb-small qb-seg', () => onPick(v));
            if (v === value)
                b.add_style_pseudo_class('checked');
            row.add_child(b);
        }
        return row;
    }

    _renderEditor() {
        clearChildren(this._editorBox);
        const ed = this._editor;
        this._editorBox.visible = !!ed;
        if (!ed)
            return;
        if (ed.kind === 'slot')
            this._renderSlotEditor(ed);
        else
            this._renderEventEditor(ed);
    }

    _renderSlotEditor(ed) {
        const box_ = this._editorBox;
        const editingQuest = ed.questId ? this._store.getQuest(ed.questId) : null;
        const head = box({style_class: 'qb-actions-row'});
        head.add_child(label(editingQuest ? 'Quest time' : 'New time slot', 'qb-editor-title', {x_expand: true}));
        head.add_child(iconButton('window-close-symbolic', 'qb-flat qb-tiny', () => this._closeEditor(), 'Close'));
        box_.add_child(head);

        if (!editingQuest) {
            box_.add_child(this._seg([['new', 'New quest'], ['existing', 'Existing quest'], ['event', 'Event']], ed.target, v => {
                ed.target = v;
                this.render();
            }));
        }

        if (editingQuest || ed.target !== 'existing') {
            const t = entry(ed.target === 'event' ? 'Event title' : 'Quest title', '', () => ed._save?.(), {text: ed.title, x_expand: true});
            t.clutter_text.connect('text-changed', () => (ed.title = t.get_text()));
            box_.add_child(t);
        }

        box_.add_child(this._dateRow(ed));
        const times = this._timeRow(ed);
        box_.add_child(times.row);

        if (!editingQuest && ed.target === 'existing') {
            const list = box({vertical: true, style_class: 'qb-picker'});
            const open = this._store.openQuests();
            if (!open.length)
                list.add_child(label('No open quests', 'qb-muted'));
            for (const q of open) {
                const inner = box({});
                inner.add_child(new St.Widget({style_class: `qb-dot qb-${q.quadrant}`, y_align: Clutter.ActorAlign.CENTER}));
                inner.add_child(label(q.title, '', {ellipsize: true, x_expand: true}));
                list.add_child(button({style_class: q.id === ed.pickQuest ? 'qb-btn qb-pick checked' : 'qb-btn qb-pick', child: inner,
                    x_expand: true}, () => {
                    ed.pickQuest = q.id;
                    this.render();
                }, 'pick-quest'));
            }
            box_.add_child(scroll(list, {style_class: 'qb-scroll qb-pick-scroll', natural_height: 120}));
        }

        if (!editingQuest && ed.target === 'new') {
            const row = box({style_class: 'qb-actions-row'});
            for (const q of QUADRANTS) {
                const b = button({style_class: `qb-qdot qb-${q.id}`, accessible_name: q.title, y_align: Clutter.ActorAlign.CENTER}, () => {
                    ed.quadrant = q.id;
                    this.render();
                }, 'qdot');
                if (q.id === ed.quadrant)
                    b.add_style_pseudo_class('checked');
                row.add_child(b);
            }
            row.add_child(label(QUADRANTS.find(q => q.id === ed.quadrant).title, 'qb-muted'));
            box_.add_child(row);
        }

        // Google: event target always; quests optionally (linked event)
        if (ed.target === 'event') {
            box_.add_child(this._calPicker(ed.source, uid => {
                ed.source = uid;
                this.render();
            }));
        } else {
            const already = editingQuest?.gcal;
            const g = textButton(already ? 'In Google Calendar ✓' : 'Also add to Google Calendar', 'qb-small qb-seg', () => {
                if (already)
                    return;
                ed.alsoGoogle = !ed.alsoGoogle;
                this.render();
            });
            if (ed.alsoGoogle || already)
                g.add_style_pseudo_class('checked');
            const gr = box({style_class: 'qb-actions-row'});
            gr.add_child(g);
            box_.add_child(gr);
            if (ed.alsoGoogle && !already)
                box_.add_child(this._calPicker(ed.source, uid => {
                    ed.source = uid;
                    this.render();
                }));
        }

        ed._save = guard(() => {
            if (!times.read())
                return;
            this._saveSlot(ed);
        }, 'slot-save');

        const actions = box({style_class: 'qb-actions-row'});
        if (editingQuest) {
            actions.add_child(textButton('Unschedule', 'qb-small', () => {
                this._store.updateQuest(editingQuest.id, {scheduled: null});
                this._closeEditor();
            }));
            actions.add_child(textButton('Details', 'qb-small', () => this._ctx.onQuestClick(editingQuest.id)));
        }
        actions.add_child(new St.Widget({x_expand: true}));
        if (this._status)
            actions.add_child(label(this._status.text, this._status.kind === 'error' ? 'qb-status error' : 'qb-status', {ellipsize: true}));
        actions.add_child(textButton(ed.saving ? 'Saving…' : 'Save', 'qb-small qb-accent', () => ed._save()));
        box_.add_child(actions);
    }

    async _saveSlot(ed) {
        const date = dateKey(ed.date);
        const scheduled = {date, start: ed.start, duration: Math.max(SNAP, ed.end - ed.start)};
        const startDate = new Date(startOfDay(ed.date).getTime() + ed.start * 60000);
        const endDate = new Date(startOfDay(ed.date).getTime() + ed.end * 60000);
        const editing = ed.questId ? this._store.getQuest(ed.questId) : null;
        let questId = null;

        if (ed.target === 'event' && !editing) {
            if (!ed.title.trim())
                return this._setStatus('error', 'Give it a title');
            return this._saveEvent({mode: 'new', source: ed.source, summary: ed.title, start: startDate, end: endDate, allDay: false,
                location: '', description: ''});
        }
        if (editing) {
            this._store.updateQuest(editing.id, {scheduled, ...(ed.title.trim() && ed.title !== editing.title ? {title: ed.title.trim()} : {})});
            questId = editing.id;
        } else if (ed.target === 'existing') {
            if (!ed.pickQuest)
                return this._setStatus('error', 'Pick a quest');
            this._store.updateQuest(ed.pickQuest, {scheduled});
            questId = ed.pickQuest;
        } else {
            const q = this._store.addQuest(ed.title, ed.quadrant, scheduled);
            if (!q)
                return this._setStatus('error', 'Give it a title');
            questId = q.id;
        }

        const q = this._store.getQuest(questId);
        try {
            if (q?.gcal) {
                // linked event follows the quest's time / title
                await this._eds.call({cmd: 'update', source: q.gcal.source, uid: q.gcal.uid, rid: q.gcal.rid, scope: 'this',
                    summary: q.title, start: Math.floor(startDate / 1000), end: Math.floor(endDate / 1000), allDay: false});
            } else if (ed.alsoGoogle && q) {
                if (!ed.source)
                    return this._setStatus('error', 'Pick a calendar (or untick Google)');
                const r = await this._eds.call({cmd: 'create', source: ed.source, summary: q.title,
                    start: Math.floor(startDate / 1000), end: Math.floor(endDate / 1000), allDay: false, location: '', description: 'Questboard quest'});
                this._store.updateQuest(q.id, {gcal: {source: ed.source, uid: r.uid, rid: ''}});
                this._settings.set_string('default-calendar', ed.source);
            }
        } catch (e) {
            this._log.warn('calendar', `google sync of quest failed: ${e.message}`);
            this._editor = null;
            this._sel.hide();
            return this._setStatus('error', `Saved as quest, Google failed: ${e.message.slice(0, 80)}`);
        }
        this._editor = null;
        this._status = null;
        this._sel.hide();
        this._requestRange(true);
        this.render();
    }

    _renderEventEditor(ed) {
        const bx = this._editorBox;
        if (this._eds?.unavailable) {
            bx.add_child(label(this._eds.unavailable.error, 'qb-editor-title'));
            bx.add_child(label(`Run once in a terminal:\n${this._eds.unavailable.hint}`, 'qb-muted', {wrap: true}));
            const r = box({style_class: 'qb-actions-row'});
            r.add_child(new St.Widget({x_expand: true}));
            r.add_child(textButton('Close', 'qb-small', () => this._closeEditor()));
            bx.add_child(r);
            return;
        }
        const head = box({style_class: 'qb-actions-row'});
        head.add_child(label(ed.mode === 'new' ? 'New event' : (ed.loading ? 'Loading…' : 'Event'), 'qb-editor-title', {x_expand: true}));
        head.add_child(iconButton('window-close-symbolic', 'qb-flat qb-tiny', () => this._closeEditor(), 'Close'));
        bx.add_child(head);

        const linked = ed.mode === 'edit' ? this._linkedQuest(ed.source, ed.uid, ed.rid) : null;
        if (linked) {
            const lr = box({style_class: 'qb-actions-row qb-linked'});
            lr.add_child(button({style_class: linked.done ? 'qb-check checked' : 'qb-check', child: icon('qb-check', 'qb-check-icon'),
                y_align: Clutter.ActorAlign.CENTER}, () => this._store.setDone(linked.id, !linked.done), 'linked-check'));
            lr.add_child(label(`Quest: ${linked.title}`, '', {ellipsize: true, x_expand: true}));
            lr.add_child(textButton('Open', 'qb-small', () => this._ctx.onQuestClick(linked.id)));
            lr.add_child(iconButton('edit-clear-symbolic', 'qb-flat qb-tiny', () => {
                this._store.updateQuest(linked.id, {gcal: null});
                this.render();
            }, 'Unlink'));
            bx.add_child(lr);
        }

        const title = entry('Title', '', () => save(), {text: ed.summary ?? '', x_expand: true});
        title.clutter_text.connect('text-changed', () => (ed.summary = title.get_text()));
        bx.add_child(title);

        const dayEd = {date: startOfDay(ed.start)};
        const allDayBtn = textButton('All day', 'qb-small qb-seg', () => {
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
            allDayBtn.add_style_pseudo_class('checked');
        const dr = this._dateRow(dayEd, allDayBtn);
        bx.add_child(dr);
        // keep date edits in sync with ed.start/end
        const syncDay = () => {
            const delta = dayEd.date - startOfDay(ed.start);
            if (delta) {
                ed.start = new Date(ed.start.getTime() + delta);
                ed.end = new Date(ed.end.getTime() + delta);
            }
        };

        let times = null;
        const tEd = {start: minsOf(ed.start), end: Math.max(minsOf(ed.start) + SNAP, minsOf(ed.end) || 24 * 60)};
        if (!ed.allDay) {
            times = this._timeRow(tEd);
            bx.add_child(times.row);
        }
        const applyTimes = () => {
            syncDay();
            if (times && !times.read())
                return false;
            if (!ed.allDay) {
                const day = startOfDay(ed.start);
                ed.start = new Date(day.getTime() + tEd.start * 60000);
                ed.end = new Date(day.getTime() + tEd.end * 60000);
            }
            return true;
        };

        const loc = entry('Location', '', () => save(), {text: ed.location ?? '', x_expand: true});
        loc.clutter_text.connect('text-changed', () => (ed.location = loc.get_text()));
        bx.add_child(loc);
        const notes = entry('Notes', '', () => save(), {text: ed.description ?? '', x_expand: true});
        notes.clutter_text.connect('text-changed', () => (ed.description = notes.get_text()));
        bx.add_child(notes);

        if (ed.mode === 'new') {
            bx.add_child(this._calPicker(ed.source, uid => {
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
            bx.add_child(info);
        }

        const save = guard(() => {
            if (!applyTimes())
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
                if (!linked) {
                    actions.add_child(iconTextButton('qb-target', 'Link as quest', 'qb-small', () => {
                        // No copy in the calendar: the quest just points at this event.
                        const q = this._store.addQuest(ed.summary || 'Event', 'q2', null, {
                            gcal: {source: ed.source, uid: ed.uid, rid: ed.rid ?? ''},
                            due: {date: dateKey(ed.start)},
                            eventTime: ed.allDay ? null : {start: minsOf(ed.start), end: minsOf(ed.end)},
                        });
                        if (q)
                            this._setStatus('ok', 'Linked — it is in your matrix now');
                    }));
                }
            }
        }
        actions.add_child(new St.Widget({x_expand: true}));
        if (this._status)
            actions.add_child(label(this._status.text, this._status.kind === 'error' ? 'qb-status error' : 'qb-status', {ellipsize: true}));
        actions.add_child(textButton(ed.saving ? 'Saving…' : 'Save', 'qb-small qb-accent', save));
        bx.add_child(actions);
        if (ed.loadError)
            bx.add_child(label(ed.loadError, 'qb-status error', {wrap: true}));
    }

    _calPicker(currentUid, onPick) {
        const row = box({style_class: 'qb-actions-row'});
        if (this._eds?.unavailable) {
            row.add_child(label(`Google editing needs: ${this._eds.unavailable.hint}`, 'qb-muted', {wrap: true, x_expand: true}));
            return row;
        }
        const cals = this._writableCals();
        if (!cals.length) {
            const why = this._calError ? `Couldn't load your calendars: ${this._calError}` : 'Loading calendars…';
            row.add_child(label(why, this._calError ? 'qb-status error' : 'qb-muted', {wrap: true, x_expand: true}));
            row.add_child(textButton('Retry', 'qb-small', () => {
                this._calError = null;
                this._loadCalendars(true);
                this.render();
            }));
            return row;
        }
        const idx = Math.max(0, cals.findIndex(c => c.uid === currentUid));
        const cal = cals[idx];
        if (currentUid !== cal.uid)
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                onPick(cal.uid);
                return GLib.SOURCE_REMOVE;
            });
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
        return row;
    }

    async _saveEvent(ed) {
        if (!this._eds)
            return;
        if (!ed.source)
            return this._setStatus('error', 'Pick a calendar first');
        if (!(ed.summary ?? '').trim())
            return this._setStatus('error', 'Give it a title');
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
                const linked = this._linkedQuest(ed.source, ed.uid, ed.rid);
                if (linked && linked.title !== args.summary)
                    this._store.updateQuest(linked.id, {title: args.summary});
            }
            this._settings.set_string('default-calendar', ed.source);
            this._editor = null;
            this._status = null;
            this._sel.hide();
            this._requestRange(true);
            this.render();
        } catch (e) {
            ed.saving = false;
            if (!this._editor)
                this._editor = ed;
            this._log.warn('calendar', `save failed: ${e.message}`);
            this._setStatus('error', e.message.slice(0, 120));
        }
    }

    async _deleteEvent(ed) {
        try {
            await this._eds.call({cmd: 'delete', source: ed.source, uid: ed.uid, rid: ed.rid, scope: ed.scope});
            this._log.info('calendar', 'event deleted');
            const linked = this._linkedQuest(ed.source, ed.uid, ed.rid);
            if (linked)
                this._store.updateQuest(linked.id, {gcal: null});
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
        const shownLinks = new Set();
        const events = this._source ? this._source.getEvents(begin, end) : [];
        for (const ev of events) {
            const {source, uid, rid} = parseEventId(ev.id);
            const color = this._eds?.colorFor(source);
            const quest = this._linkedQuest(source, uid, rid, ev.date);
            if (quest)
                shownLinks.add(quest.id);
            const base = {kind: 'event', id: ev.id, title: ev.summary, date: ev.date, evEnd: ev.end, color, quest};
            if (ev.date <= begin && ev.end >= end) {
                allDay.push({...base, allDay: true});
                continue;
            }
            const s = Math.max(ev.date.getTime(), begin.getTime());
            const e = Math.min(ev.end.getTime(), end.getTime());
            const start = (s - begin.getTime()) / 60000;
            const stop = (e - begin.getTime()) / 60000;
            timed.push({...base, allDay: false, start, end: Math.max(start + 15, stop),
                label: `${fmtMinutes(start)} – ${fmtMinutes(stop)}`});
        }
        const key = dateKey(begin);
        for (const q of this._store.quests) {
            if (q.scheduled?.date !== key || shownLinks.has(q.id))
                continue; // linked quests are shown on their event
            const start = q.scheduled.start;
            const dur = q.scheduled.duration ?? 60;
            timed.push({kind: 'quest', id: q.id, title: q.title, quadrant: q.quadrant, done: q.done,
                start, end: start + Math.max(15, dur), label: `${fmtMinutes(start)} – ${fmtMinutes(start + dur)}`});
        }
        // Pomodoros: finished ones as they happened, a running one until its planned end
        for (const f of this._store.focusBlocks(key)) {
            const start = Math.max(0, (f.start - begin.getTime()) / 60000);
            const stop = Math.min(24 * 60, (f.end - begin.getTime()) / 60000);
            timed.push({kind: 'focus', id: f.id, title: `Focus · ${f.title}`, questId: f.questId, live: f.live,
                start, end: Math.max(start + 10, stop), label: `${fmtMinutes(start)} – ${fmtMinutes(stop)}${f.live ? ' · running' : ''}`});
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
        if (!this._open) {
            this._stale = true;
            return;
        }
        this._stale = false;
        const today = new Date();
        this._title.text = fmtDate(this._viewDate, '%A, %e %B');
        if (sameDay(today, this._viewDate))
            this._todayBtn.add_style_pseudo_class('checked');
        else
            this._todayBtn.remove_style_pseudo_class('checked');
        const items = this._itemsFor(this._viewDate);
        this._renderWeek(today);
        this._renderAllDay(items.allDay);
        this._renderHint();
        this._renderEditor();
        this._renderBlocks(items.timed);
        this._renderNow(today);
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

    _renderAllDay(allDay) {
        clearChildren(this._allDay);
        const due = this._store.dueOn(dateKey(this._viewDate)).filter(q => !q.gcal);
        this._allDay.visible = allDay.length + due.length > 0;
        for (const q of due) {
            const inner = box({style_class: 'qb-due-chip-inner'});
            inner.add_child(icon('qb-target'));
            inner.add_child(label(`Due: ${q.title}`, '', {ellipsize: true, x_expand: true}));
            this._allDay.add_child(button({style_class: `qb-allday-item qb-due-chip qb-${q.quadrant}`, child: inner, x_expand: true},
                () => this._ctx.onQuestClick(q.id), 'due-chip'));
        }
        for (const ev of allDay) {
            const inner = box({style_class: 'qb-due-chip-inner'});
            if (ev.quest)
                inner.add_child(icon(ev.quest.done ? 'qb-check' : 'qb-target'));
            inner.add_child(label(ev.title, '', {ellipsize: true, x_expand: true}));
            const b = button({style_class: ev.quest?.done ? 'qb-allday-item done' : 'qb-allday-item', child: inner, x_expand: true},
                () => this._openEvent(ev), 'allday');
            const bg = hexToRgba(ev.color, 0.45);
            if (bg)
                b.set_style(`background-color: ${bg};`);
            this._allDay.add_child(b);
        }
    }

    /** Rebuild only when the visible blocks actually changed. */
    _renderBlocks(timed) {
        const sig = `${dateKey(this._viewDate)}|${this._tlWidth}|` + timed.map(t =>
            `${t.kind}:${t.id}:${t.start}:${t.end}:${t.title}:${t.done ? 1 : 0}:${t.live ? 'L' : ''}:${t.quest ? (t.quest.done ? 'qd' : 'q') : ''}:${t.color ?? ''}`).join(';');
        if (sig === this._blocksSig)
            return;
        this._blocksSig = sig;
        clearChildren(this._blocks);
        const area = this._tlWidth - GUTTER - 2;
        for (const it of layoutColumns(timed)) {
            const colW = area / it.ncols;
            const x = GUTTER + it.col * colW + 1;
            const y = it.start * HOUR_H / 60;
            const h = Math.max(18, (it.end - it.start) * HOUR_H / 60 - 2);
            const content = box({vertical: true, x_expand: true});
            const top = box({});
            if (it.quest)
                top.add_child(icon(it.quest.done ? 'qb-check' : 'qb-target', 'qb-icon qb-block-icon'));
            if (it.kind === 'focus')
                top.add_child(icon('qb-target', 'qb-icon qb-block-icon'));
            top.add_child(label(it.title, 'qb-block-title', {ellipsize: true, x_expand: true}));
            content.add_child(top);
            if (h >= 34)
                content.add_child(label(it.label, 'qb-block-time', {ellipsize: true}));
            let cls = it.kind === 'event' ? (it.quest ? `qb-block qb-qblock qb-${it.quest.quadrant}` : 'qb-block qb-event')  // a linked event looks like a quest
                : it.kind === 'focus' ? `qb-block qb-focus${it.live ? ' live' : ''}` : `qb-block qb-qblock qb-${it.quadrant}`;
            if (it.done || it.quest?.done)
                cls += ' done';
            if (it.quest)
                cls += ' linked';
            const btn = button({style_class: cls, child: content, x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.FILL},
                () => {
                    if (it.kind === 'quest')
                        this.scheduleQuest(it.id);
                    else if (it.kind === 'focus')
                        it.questId && this._store.getQuest(it.questId) && this._ctx.onQuestClick(it.questId);
                    else
                        this._openEvent(it);
                }, 'block');
            if (it.kind === 'event' && !it.quest) {
                const bg = hexToRgba(it.color, 0.5);
                const border = it.color && /^#/.test(it.color) ? it.color.slice(0, 7) : null;
                if (bg)
                    btn.set_style(`background-color: ${bg};${border ? ` border-left-color: ${border};` : ''}`);
            }
            btn.set_position(Math.round(x), Math.round(y) + 1);
            btn.set_size(Math.max(20, Math.round(colW - 3)), Math.round(h));
            this._blocks.add_child(btn);
        }
    }

    _renderNow(today) {
        const show = sameDay(today, this._viewDate);
        this._nowLine.visible = show;
        if (show) {
            this._nowLine.set_position(GUTTER - 6, Math.round(minsOf(today) * HOUR_H / 60));
            this._nowLine.set_size(this._tlWidth - GUTTER + 6, 2);
        }
        if (!this._editor && !this._pick)
            this._sel.hide();
    }

    _renderFooter() {
        clearChildren(this._footer);
        const src = this._source;
        if (src && src.hasCalendars) {
            const n = this._writableCals().length;
            const txt = src.isLoading ? 'Syncing calendars…'
                : this._eds?.unavailable ? 'Read-only · install gir1.2-ecal-2.0 to edit'
                    : this._calError ? 'Calendar list failed — open an event for details'
                        : `Google via Online Accounts${n ? ` · ${n} editable` : ''} · click start, then end`;
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
        for (const id of this._timers)
            GLib.source_remove(id);
        this._timers.clear();
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
