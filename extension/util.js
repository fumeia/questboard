// Small UI + formatting helpers shared by the Questboard widgets.
// Written to work on GNOME Shell 45 – 50 (handles the BoxLayout
// `vertical` -> `orientation` and ScrollView API changes).

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

let _hasOrientation = null;

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

export function icon(icon_name, style_class = 'qb-icon') {
    return new St.Icon({icon_name, style_class});
}

export function iconButton(iconName, style_class, onClick, accessible_name = '') {
    const b = new St.Button({
        style_class: `qb-icon-btn ${style_class}`,
        child: icon(iconName),
        can_focus: true,
        y_align: Clutter.ActorAlign.CENTER,
        accessible_name,
    });
    b.connect('clicked', () => onClick());
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
    b.connect('clicked', () => onClick());
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
    b.connect('clicked', () => onClick());
    return b;
}

export function scroll(child, params = {}) {
    const sv = new St.ScrollView({
        style_class: 'qb-scroll vfade',
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
