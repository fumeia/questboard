// Small UI + formatting helpers shared by the Questboard widgets.
// Written to work on GNOME Shell 45 – 50 (handles the BoxLayout
// `vertical` -> `orientation` and ScrollView API changes).

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

let _hasOrientation = null;
let _iconDir = null;
let _errorHandler = e => console.error(`[Questboard] ${e}\n${e?.stack ?? ''}`);

/** Folder holding qb-<name>-symbolic.svg files. */
export function setIconDir(dir) {
    _iconDir = dir;
}

/** Route exceptions from button handlers to the logger. */
export function setErrorHandler(fn) {
    _errorHandler = fn;
}

export function guard(fn, where = 'ui') {
    return (...args) => {
        try {
            const r = fn(...args);
            if (r?.catch)
                r.catch(e => _errorHandler(e, where));
            return r;
        } catch (e) {
            _errorHandler(e, where);
            return undefined;
        }
    };
}

function hasOrientation() {
    if (_hasOrientation === null) {
        const probe = new St.BoxLayout();
        _hasOrientation = probe.orientation !== undefined;
        probe.destroy();
    }
    return _hasOrientation;
}

/** St.BoxLayout factory; pass `vertical: true` for a column. */
export function box(params = {}) {
    const {vertical, ...rest} = params;
    const b = new St.BoxLayout(rest);
    if (vertical) {
        if (hasOrientation())
            b.orientation = Clutter.Orientation.VERTICAL;
        else
            b.vertical = true;
    }
    return b;
}

export function label(text, style_class = '', {ellipsize = false, wrap = false, ...rest} = {}) {
    const l = new St.Label({text, style_class, y_align: Clutter.ActorAlign.CENTER, ...rest});
    if (ellipsize)
        l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    if (wrap) {
        l.clutter_text.line_wrap = true;
        l.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    }
    return l;
}

const _giconCache = new Map();

/** Gio.Icon for a bundled ('qb-…') or theme icon name. */
export function gicon(name) {
    let g = _giconCache.get(name);
    if (!g) {
        g = name.startsWith('qb-') && _iconDir
            ? Gio.FileIcon.new(Gio.File.new_for_path(`${_iconDir}/${name}-symbolic.svg`))
            : Gio.ThemedIcon.new(name);
        _giconCache.set(name, g);
    }
    return g;
}

/** 'qb-flame' style names load our bundled SVGs; anything else is a theme icon. */
export function icon(name, style_class = 'qb-icon') {
    return new St.Icon({gicon: gicon(name), style_class});
}

/** Icon + label in one row (for stats, headers…). */
export function iconLabel(iconName, text, style_class = '') {
    const b = box({style_class: `qb-iconlabel ${style_class}`});
    b.add_child(icon(iconName));
    const l = label(text);
    b.add_child(l);
    b.labelActor = l;
    return b;
}

export function iconButton(iconName, style_class, onClick, accessible_name = '') {
    const b = new St.Button({
        style_class: `qb-icon-btn ${style_class}`,
        child: icon(iconName),
        can_focus: true,
        y_align: Clutter.ActorAlign.CENTER,
        accessible_name,
    });
    b.connect('clicked', guard(() => onClick(), accessible_name || iconName));
    return b;
}

export function textButton(text, style_class, onClick, extra = {}) {
    const b = new St.Button({
        style_class: `qb-btn ${style_class}`,
        label: text,
        can_focus: true,
        y_align: Clutter.ActorAlign.CENTER,
        ...extra,
    });
    b.connect('clicked', guard(() => onClick(), text));
    return b;
}

/** Button with an icon and a text label side by side. */
export function iconTextButton(iconName, text, style_class, onClick) {
    const inner = box({style_class: 'qb-btn-inner'});
    inner.add_child(icon(iconName));
    inner.add_child(label(text));
    const b = new St.Button({
        style_class: `qb-btn ${style_class}`,
        child: inner,
        can_focus: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    b.connect('clicked', guard(() => onClick(), text));
    return b;
}

/** Plain St.Button with a guarded click handler. */
export function button(params, onClick, where = 'button') {
    const b = new St.Button({can_focus: true, ...params});
    b.connect('clicked', guard(() => onClick(), where));
    return b;
}

// Edit fields (commit: true) whose text has not been saved yet. flushEdits() saves them: on focus-out, before every
// re-render (which would otherwise throw the typed text away) and when the popup closes.
const _editEntries = new Set();
let _flushQueued = 0;

/**
 * Entry that calls onSubmit(text, entry) on Enter. With `commit: true` it is an edit field: it also saves when it
 * loses focus or the view is rebuilt, so typed text is never lost. "Add …" fields leave it off (no accidental adds).
 */
export function entry(hint, style_class, onSubmit, params = {}) {
    const {commit = false, ...rest} = params;
    const e = new St.Entry({hint_text: hint, style_class: `qb-entry ${style_class}`, can_focus: true, ...rest});
    e.clutter_text.connect('activate', guard(() => {
        e._qbCommitted = e.get_text();
        onSubmit(e.get_text(), e);
    }, 'entry'));
    if (commit) {
        e._qbCommitted = e.get_text();
        e._qbSubmit = onSubmit;
        _editEntries.add(e);
        e.connect('destroy', () => _editEntries.delete(e));
        // deferred: saving re-renders, and rebuilding widgets in the middle of a focus change is not safe
        e.clutter_text.connect('key-focus-out', () => {
            if (_flushQueued)
                return;
            _flushQueued = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                _flushQueued = 0;
                flushEdits();
                return GLib.SOURCE_REMOVE;
            });
        });
    }
    return e;
}

/** Save every edit field whose text changed since it was last saved. Returns how many were saved. */
export function flushEdits() {
    const pending = [];
    for (const e of _editEntries) {
        let t;
        try {
            t = e.get_text();
        } catch {
            continue;
        }
        if (t !== e._qbCommitted) {
            e._qbCommitted = t;
            pending.push([e, t]);
        }
    }
    // the first save may re-render and destroy the other entries: their text was read above
    for (const [e, t] of pending)
        guard(() => e._qbSubmit(t, e), 'entry-commit')();
    return pending.length;
}

/** Check box with a 24 px click area around the 16 px (or 12 px) box. */
export function checkButton(checked, onClick, {small = false, accessible_name = '', where = 'check'} = {}) {
    let cls = 'qb-check';
    if (small)
        cls += ' qb-check-small';
    if (checked)
        cls += ' checked';
    const inner = new St.Bin({style_class: cls, child: icon('qb-check', 'qb-check-icon')});
    return button({style_class: small ? 'qb-check-hit qb-check-hit-small' : 'qb-check-hit', child: inner,
        y_align: Clutter.ActorAlign.CENTER, accessible_name}, onClick, where);
}


/** Parse "14:30", "1430", "9", "2:30pm", "9 am" → minutes since midnight, or null. */
export function parseTime(text) {
    const m = String(text).trim().toLowerCase().match(/^(\d{1,2})(?::?(\d{2}))?\s*(am|pm)?$/);
    if (!m)
        return null;
    let h = parseInt(m[1], 10);
    const min = m[2] ? parseInt(m[2], 10) : 0;
    if (m[3] === 'pm' && h < 12)
        h += 12;
    if (m[3] === 'am' && h === 12)
        h = 0;
    if (h > 24 || min > 59 || (h === 24 && min > 0))
        return null;
    return h * 60 + min;
}

export function scroll(child, params = {}) {
    const sv = new St.ScrollView({
        style_class: 'qb-scroll', // no 'vfade': the shell's fade hid the first and last lines
        hscrollbar_policy: St.PolicyType.NEVER,
        vscrollbar_policy: St.PolicyType.AUTOMATIC,
        overlay_scrollbars: true,
        x_expand: true,
        ...params,
    });
    if (typeof sv.set_child === 'function')
        sv.set_child(child);
    else
        sv.add_actor(child);
    return sv;
}

export function vadjustment(sv) {
    return sv.vadjustment ?? sv.vscroll?.adjustment ?? null;
}

export function clearChildren(actor) {
    for (const c of actor.get_children())
        c.destroy();
}

// ---- formatting ---------------------------------------------------------

const pad = n => String(n).padStart(2, '0');

/** 1:02:03 / 25:00 — used for live timers. */
export function fmtTimer(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** "1h 05m" / "12m" / "" — compact time-spent label. */
export function fmtSpent(ms) {
    const mins = Math.floor(ms / 60000);
    if (mins <= 0)
        return ms >= 1000 ? '<1m' : '';
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h > 0 ? `${h}h ${pad(m)}m` : `${m}m`;
}

let _ifaceSettings = null;
function use24h() {
    try {
        _ifaceSettings ??= new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        return _ifaceSettings.get_string('clock-format') !== '12h';
    } catch {
        return true;
    }
}

/** Minutes since midnight -> "14:30" or "2:30 PM" depending on GNOME clock format. */
export function fmtMinutes(minutes) {
    const h = Math.floor(minutes / 60) % 24;
    const m = Math.round(minutes % 60);
    if (use24h())
        return `${pad(h)}:${pad(m)}`;
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
}

export function fmtHour(h) {
    if (use24h())
        return `${pad(h)}:00`;
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12} ${h < 12 ? 'AM' : 'PM'}`;
}

export function fmtDate(date, format) {
    const dt = GLib.DateTime.new_from_unix_local(Math.floor(date.getTime() / 1000));
    return dt ? dt.format(format) : date.toDateString();
}

// ---- dates --------------------------------------------------------------

export function startOfDay(d) {
    const r = new Date(d);
    r.setHours(0, 0, 0, 0);
    return r;
}

export function addDays(d, n) {
    const r = new Date(d);
    r.setDate(r.getDate() + n);
    return r;
}

/** Monday-based week start. */
export function startOfWeek(d) {
    const r = startOfDay(d);
    const dow = (r.getDay() + 6) % 7;
    return addDays(r, -dow);
}

export function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() &&
        a.getMonth() === b.getMonth() &&
        a.getDate() === b.getDate();
}

export function dateKey(d = new Date()) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
