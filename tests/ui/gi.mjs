// Minimal stand-ins for St / Clutter / Gio / GLib / Pango / Soup, enough to build and click through the Questboard popup in
// node (tests/ui/ui_test.mjs). Widgets keep a tree with style classes, pseudo classes, text and visibility, which
// render.mjs turns into HTML for a screenshot. Which module this file is comes from its URL (?m=St etc., see loader.mjs).
import fs from 'fs';

const which = new URL(import.meta.url).searchParams.get('m');
const G = globalThis.__qbMock ??= {timers: new Map(), nextId: 1, focus: null, opened: []};

class Signals {
    connect(sig, fn) {
        (this._sig ??= new Map());
        const id = G.nextId++;
        this._sig.set(id, [sig, fn]);
        return id;
    }
    disconnect(id) {
        this._sig?.delete(id);
    }
    emit(sig, ...args) {
        let r;
        for (const [s, fn] of [...(this._sig?.values() ?? [])])
            if (s === sig)
                r = fn(this, ...args);
        return r;
    }
}

class Actor extends Signals {
    constructor(params = {}) {
        super();
        this.children = [];
        this.parent = null;
        this.visible = true;
        this.style_class = '';
        this._pseudo = new Set();
        this.width = 0;
        this.height = 0;
        this.x = 0;
        this.y = 0;
        this.destroyed = false;
        const {child, ...rest} = params;
        Object.assign(this, rest);
        if (this.layout_manager)
            this.layout_manager._container = this;
        if (child)
            this.set_child(child);
    }
    get kind() {
        return this.constructor.name;
    }
    add_child(c) {
        if (c.parent)
            c.parent.remove_child(c);
        c.parent = this;
        this.children.push(c);
    }
    add_actor(c) {
        this.add_child(c);
    }
    insert_child_below(c, sib) {
        const i = this.children.indexOf(sib);
        c.parent = this;
        this.children.splice(i < 0 ? 0 : i, 0, c);
    }
    remove_child(c) {
        this.children = this.children.filter(x => x !== c);
        c.parent = null;
    }
    get_children() {
        return [...this.children];
    }
    get_parent() {
        return this.parent;
    }
    get_first_child() {
        return this.children[0] ?? null;
    }
    destroy_all_children() {
        for (const c of [...this.children])
            c.destroy();
    }
    remove_all_children() {
        for (const c of [...this.children])
            this.remove_child(c);
    }
    destroy() {
        if (this.destroyed)
            return;
        for (const c of [...this.children])
            c.destroy();
        this.emit('destroy');
        this.destroyed = true;
        this.parent?.remove_child(this);
    }
    set_child(c) {
        for (const x of [...this.children])
            this.remove_child(x);
        if (c)
            this.add_child(c);
        this.child = c;
    }
    get_child() {
        return this.child ?? null;
    }
    show() {
        this.visible = true;
    }
    hide() {
        this.visible = false;
    }
    set_size(w, h) {
        this.width = w;
        this.height = h;
        this._fixedW = w;
        this._fixedH = h;
    }
    set_width(w) {
        this.width = w;
        this._fixedW = w;
    }
    set_height(h) {
        this.height = h;
        this._fixedH = h;
    }
    set_position(x, y) {
        this.x = x;
        this.y = y;
        this._abs = true;
    }
    set_y(y) {
        this.y = y;
    }
    set_style(s) {
        this._style = s;
    }
    add_style_class_name(c) {
        if (!this.style_class.split(/\s+/).includes(c))
            this.style_class = `${this.style_class} ${c}`.trim();
    }
    remove_style_class_name(c) {
        this.style_class = this.style_class.split(/\s+/).filter(x => x && x !== c).join(' ');
    }
    has_style_class_name(c) {
        return this.style_class.split(/\s+/).includes(c);
    }
    add_style_pseudo_class(p) {
        this._pseudo.add(p);
    }
    remove_style_pseudo_class(p) {
        this._pseudo.delete(p);
    }
    has_style_pseudo_class(p) {
        return this._pseudo.has(p);
    }
    get_preferred_width() {
        return [0, 400];
    }
    get_preferred_height() {
        return [0, 300];
    }
    transform_stage_point(x, y) {
        return [true, x, y];
    }
    queue_relayout() {}
    grab_key_focus() {
        const old = G.focus;
        G.focus = this;
        if (old && old !== this)
            old.clutter_text?.emit('key-focus-out');
    }
}

class ClutterText extends Signals {
    constructor(owner) {
        super();
        this.owner = owner;
        this.ellipsize = 0;
        this.line_wrap = false;
    }
    get text() {
        return this.owner.text;
    }
    set text(t) {
        this.owner.text = t;
    }
}

class Label extends Actor {
    constructor(params = {}) {
        super({text: '', ...params});
        this.clutter_text = new ClutterText(this);
    }
}

class Entry extends Actor {
    constructor(params = {}) {
        super({text: '', hint_text: '', ...params});
        this.clutter_text = new ClutterText(this);
    }
    get_text() {
        return this.text;
    }
    set_text(t) {
        this.text = t;
        this.clutter_text.emit('text-changed');
    }
    /** Test helper: type text and press Enter. */
    type(t, enter = true) {
        this.grab_key_focus();
        this.set_text(t);
        if (enter)
            this.clutter_text.emit('activate');
    }
}

class Button extends Actor {
    constructor(params = {}) {
        super({label: null, ...params});
    }
    click() {
        if (this.reactive === false)
            return;
        this.emit('clicked');
    }
}

class ScrollView extends Actor {
    constructor(params = {}) {
        super(params);
        this.vadjustment = new Signals();
        Object.assign(this.vadjustment, {value: 0, upper: 0, page_size: 0, lower: 0});
    }
}

class Adjustment extends Signals {}

const St = {
    Widget: class Widget extends Actor {},
    BoxLayout: class BoxLayout extends Actor {
        constructor(p = {}) {
            super(p);
            this.orientation ??= 0;
        }
    },
    Bin: class Bin extends Actor {},
    Label,
    Entry,
    Button,
    Icon: class Icon extends Actor {},
    ScrollView,
    Adjustment,
    PolicyType: {NEVER: 0, AUTOMATIC: 1, ALWAYS: 2},
    Side: {TOP: 0},
};

const Clutter = {
    ActorAlign: {FILL: 0, START: 1, CENTER: 2, END: 3},
    Orientation: {HORIZONTAL: 0, VERTICAL: 1},
    GridLayout: class GridLayout {
        constructor(p) {
            Object.assign(this, p);
            this.cells = [];
        }
        attach(child, col, row) {
            child._grid = {col, row};
            this._container?.add_child(child);
        }
    },
    BinLayout: class BinLayout {},
    EVENT_STOP: true,
    EVENT_PROPAGATE: false,
};

const GLib = {
    build_filenamev: a => a.join('/'),
    get_user_data_dir: () => process.env.QB_DIR,
    file_get_contents: p => {
        if (!fs.existsSync(p))
            throw new Error('NOENT');
        return [true, fs.readFileSync(p)];
    },
    file_set_contents: (p, s) => fs.writeFileSync(p, s),
    mkdir_with_parents: d => fs.mkdirSync(d, {recursive: true}),
    rename: (a, b) => fs.renameSync(a, b),
    timeout_add: (_p, ms, fn) => {
        const id = G.nextId++;
        G.timers.set(id, {ms, fn});
        return id;
    },
    timeout_add_seconds: (_p, s, fn) => GLib.timeout_add(_p, s * 1000, fn),
    idle_add: (_p, fn) => GLib.timeout_add(_p, 0, fn),
    source_remove: id => G.timers.delete(id),
    PRIORITY_DEFAULT: 0, PRIORITY_LOW: 300, PRIORITY_DEFAULT_IDLE: 200, PRIORITY_HIGH: -100,
    SOURCE_REMOVE: false, SOURCE_CONTINUE: true,
    get_monotonic_time: () => Date.now() * 1000,
    getenv: k => process.env[k] ?? null,
    get_home_dir: () => '/tmp',
    file_test: () => false,
    FileTest: {EXISTS: 1},
    DateTime: {
        new_from_unix_local: s => {
            const d = new Date(s * 1000);
            const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
            const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
            const p2 = n => String(n).padStart(2, '0');
            const f = {a: DAYS[d.getDay()].slice(0, 3), A: DAYS[d.getDay()], b: MON[d.getMonth()].slice(0, 3), B: MON[d.getMonth()],
                e: String(d.getDate()).padStart(2, ' '), d: p2(d.getDate()), Y: d.getFullYear(), m: p2(d.getMonth() + 1),
                H: p2(d.getHours()), M: p2(d.getMinutes()), k: String(d.getHours()).padStart(2, ' '), '-d': d.getDate(), '-H': d.getHours()};
            return {format: fmt => fmt.replace(/%(-?[a-zA-Z])/g, (_, c) => f[c] ?? c), get_hour: () => d.getHours(), get_minute: () => d.getMinutes()};
        },
    },
};
/** Test helper: run due timeouts / idles (maxMs: only those at most this long). */
G.runTimers = (maxMs = 0) => {
    for (const [id, t] of [...G.timers]) {
        if (t.ms > maxMs)
            continue;
        if (!G.timers.has(id))
            continue;
        const again = t.fn();
        if (!again)
            G.timers.delete(id);
    }
};

const Gio = {
    FileIcon: {new: f => ({file: f})},
    File: {new_for_path: p => ({path: p, get_uri: () => `file://${p}`})},
    ThemedIcon: {new: n => ({name: n})},
    AppInfo: {launch_default_for_uri: uri => G.opened.push(uri)},
    Settings: class {
        constructor() {
            this.v = {};
        }
        get_string(k) {
            return this.v[k] ?? '';
        }
        connect() {
            return 1;
        }
        disconnect() {}
    },
    _promisify: () => {},
    Subprocess: class {},
    SubprocessFlags: {},
};

const Pango = {EllipsizeMode: {NONE: 0, END: 3}, WrapMode: {WORD_CHAR: 2}};
const Soup = {Session: class {}, Message: {new: () => null}};

export default {St, Clutter, GLib, Gio, Pango, Soup}[which] ?? {};
