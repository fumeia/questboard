// Networking for the extension: logger (journal + file + server), sync client
// and self-updater. All HTTP goes through libsoup 3 (bundled with GNOME Shell).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const LEVELS = {debug: 0, info: 1, warn: 2, error: 3};
const enc = new TextEncoder();
const dec = new TextDecoder();

// ------------------------------------------------------------------ HTTP

export class Api {
    constructor(settings) {
        this._settings = settings;
        this._session = new Soup.Session({timeout: 20, user_agent: 'Questboard-Extension'});
    }

    get configured() {
        return !!(this.baseUrl && this._settings.get_string('server-token'));
    }

    get baseUrl() {
        return this._settings.get_string('server-url').trim().replace(/\/+$/, '');
    }

    async request(method, path, {json = null, raw = false} = {}) {
        if (!this.configured)
            throw new Error('server not configured');
        const msg = Soup.Message.new(method, `${this.baseUrl}${path}`);
        if (!msg)
            throw new Error(`bad server URL: ${this.baseUrl}`);
        msg.request_headers.append('Authorization', `Bearer ${this._settings.get_string('server-token')}`);
        if (json !== null)
            msg.set_request_body_from_bytes('application/json', new GLib.Bytes(enc.encode(JSON.stringify(json))));
        const bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
        const status = msg.get_status();
        const data = bytes.get_data() ?? new Uint8Array();
        if (status < 200 || status >= 300) {
            let detail = '';
            try {
                detail = JSON.parse(dec.decode(data)).error ?? '';
            } catch {}
            throw new Error(`HTTP ${status}${detail ? `: ${detail}` : ''} (${path})`);
        }
        return raw ? data : JSON.parse(dec.decode(data) || '{}');
    }

    destroy() {
        this._session.abort();
    }
}

// ---------------------------------------------------------------- Logger

export class Logger {
    constructor({settings, version}) {
        this._settings = settings;
        this._version = String(version);
        this._ring = [];
        this._remote = [];
        this._fileLines = [];
        this._dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'questboard']);
        this._file = GLib.build_filenamev([this._dir, 'questboard.log']);
        this.api = null;
        this.deviceId = '';
        this._flushId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 10, () => {
            this.flush();
            return GLib.SOURCE_CONTINUE;
        });
    }

    get recent() {
        return this._ring;
    }

    _log(level, tag, msg, ctx) {
        const min = LEVELS[this._settings.get_string('log-level')] ?? 1;
        if (LEVELS[level] < min)
            return;
        const entry = {ts: Date.now(), level, tag, msg: String(msg), ctx: ctx ?? null};
        this._ring.push(entry);
        if (this._ring.length > 300)
            this._ring.shift();
        const line = `[Questboard] ${level.toUpperCase()} [${tag}] ${entry.msg}${ctx ? ` ${safeJson(ctx)}` : ''}`;
        if (level === 'error')
            console.error(line);
        else if (level === 'warn')
            console.warn(line);
        else
            console.log(line);
        this._fileLines.push(`${new Date(entry.ts).toISOString()} ${line}`);
        if (this._settings.get_boolean('remote-logging')) {
            this._remote.push(entry);
            if (this._remote.length > 1000)
                this._remote.shift();
        }
        if (level === 'error')
            GLib.idle_add(GLib.PRIORITY_LOW, () => {
                this.flush();
                return GLib.SOURCE_REMOVE;
            });
    }

    debug(tag, msg, ctx) {
        this._log('debug', tag, msg, ctx);
    }

    info(tag, msg, ctx) {
        this._log('info', tag, msg, ctx);
    }

    warn(tag, msg, ctx) {
        this._log('warn', tag, msg, ctx);
    }

    error(tag, msg, ctx) {
        this._log('error', tag, msg, ctx);
    }

    /** Log an exception with its stack. */
    exception(tag, e, ctx = {}) {
        this.error(tag, e?.message ?? String(e), {...ctx, stack: e?.stack?.split('\n').slice(0, 8).join('\n')});
    }

    flush() {
        this._flushFile();
        this._flushRemote().catch(() => {});
    }

    _flushFile() {
        if (!this._fileLines.length)
            return;
        const text = `${this._fileLines.join('\n')}\n`;
        this._fileLines = [];
        try {
            GLib.mkdir_with_parents(this._dir, 0o700);
            const f = Gio.File.new_for_path(this._file);
            try {
                const info = f.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
                if (info.get_size() > 1024 * 1024)
                    f.move(Gio.File.new_for_path(`${this._file}.1`), Gio.FileCopyFlags.OVERWRITE, null, null);
            } catch {}
            const out = f.append_to(Gio.FileCreateFlags.NONE, null);
            out.write_all(enc.encode(text), null);
            out.close(null);
        } catch (e) {
            console.error(`[Questboard] log file write failed: ${e}`);
        }
    }

    async _flushRemote() {
        if (this._sending || !this._remote.length || !this.api?.configured)
            return;
        this._sending = true;
        const batch = this._remote.splice(0, 500);
        try {
            await this.api.request('POST', '/api/logs', {json: {
                device: this.deviceId, platform: 'extension', version: this._version,
                name: this._settings.get_string('device-name') || GLib.get_host_name(), entries: batch,
            }});
        } catch {
            this._remote.unshift(...batch); // retry later; don't log (would recurse)
            if (this._remote.length > 1000)
                this._remote.splice(0, this._remote.length - 1000);
        } finally {
            this._sending = false;
        }
    }

    destroy() {
        if (this._flushId)
            GLib.source_remove(this._flushId);
        this._flushId = 0;
        this._flushFile();
    }
}

function safeJson(v) {
    try {
        return JSON.stringify(v);
    } catch {
        return String(v);
    }
}

// ------------------------------------------------------------ Sync client

export class SyncClient {
    constructor({store, settings, api, log, version}) {
        this._store = store;
        this._settings = settings;
        this._api = api;
        this._log = log;
        this._version = String(version);
        this.status = {state: 'idle', at: 0, error: null};
        this._listeners = new Set();
        this._debounceId = 0;
        this._periodicId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 120, () => {
            this.syncNow('periodic');
            return GLib.SOURCE_CONTINUE;
        });
        this._unsub = store.subscribe(({local}) => {
            if (local)
                this.schedule();
        });
    }

    get enabled() {
        return this._settings.get_boolean('sync-enabled') && this._api.configured;
    }

    onStatus(fn) {
        this._listeners.add(fn);
        return () => this._listeners.delete(fn);
    }

    _setStatus(s) {
        this.status = {...this.status, ...s};
        for (const fn of this._listeners)
            fn(this.status);
    }

    /** Debounced push after local edits. */
    schedule(delayMs = 2500) {
        if (!this.enabled)
            return;
        if (this._debounceId)
            GLib.source_remove(this._debounceId);
        this._debounceId = GLib.timeout_add(GLib.PRIORITY_LOW, delayMs, () => {
            this._debounceId = 0;
            this.syncNow('edit');
            return GLib.SOURCE_REMOVE;
        });
    }

    async syncNow(reason = 'manual') {
        if (!this.enabled) {
            this._setStatus({state: 'off', error: null});
            return;
        }
        if (this._busy) {
            this._again = true;
            return;
        }
        this._busy = true;
        this._setStatus({state: 'syncing'});
        const t0 = Date.now();
        try {
            let rounds = 0, pushed = 0, pulled = 0, more = true;
            while (more && rounds++ < 20) {
                const {changes, marks} = this._store.collectDirty();
                const res = await this._api.request('POST', '/api/sync', {json: {
                    device: this._store.deviceId, platform: 'extension', version: this._version,
                    name: this._settings.get_string('device-name') || GLib.get_host_name(),
                    since: this._store.cursor, changes,
                }});
                pushed += changes.length;
                pulled += this._store.applyRemote(res.changes ?? [], res.cursor, marks);
                more = res.more || this._store.dirtyCount() > 0 && changes.length >= 2000;
                if (res.rejected)
                    this._log.warn('sync', `server rejected ${res.rejected} record(s)`);
            }
            this._setStatus({state: 'ok', at: Date.now(), error: null});
            if (pushed || pulled || reason === 'manual')
                this._log.info('sync', `${reason}: pushed ${pushed}, merged ${pulled} in ${Date.now() - t0} ms`);
        } catch (e) {
            this._setStatus({state: 'error', error: e.message});
            this._log.warn('sync', `${reason} failed: ${e.message}`);
        } finally {
            this._busy = false;
            if (this._again) {
                this._again = false;
                this.schedule(500);
            }
        }
    }

    destroy() {
        this._unsub?.();
        for (const id of [this._debounceId, this._periodicId])
            if (id)
                GLib.source_remove(id);
        this._debounceId = this._periodicId = 0;
        this._listeners.clear();
    }
}

// --------------------------------------------------------------- Updater

export class Updater {
    constructor({api, settings, log, version, notify}) {
        this._api = api;
        this._settings = settings;
        this._log = log;
        this._version = version;
        this._notify = notify;
        this._lastCheck = 0;
        this._id = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 6 * 3600, () => {
            this.check();
            return GLib.SOURCE_CONTINUE;
        });
        this._firstId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 45, () => {
            this._firstId = 0;
            this.check();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Throttled check, e.g. whenever the popup opens. */
    maybeCheck() {
        if (Date.now() - this._lastCheck > 10 * 60000)
            this.check();
    }

    async check({manual = false} = {}) {
        if (!this._api.configured || (!manual && !this._settings.get_boolean('auto-update')))
            return null;
        this._lastCheck = Date.now();
        try {
            const rel = await this._api.request('GET', '/api/releases/extension/latest');
            const pending = this._settings.get_int('pending-update-code');
            if (rel.code <= this._version || rel.code <= pending) {
                if (manual)
                    this._notify('Questboard is up to date', rel.code <= this._version
                        ? `Running version ${this._version}.` : `Version ${pending} is installed — log out and back in to load it.`);
                return null;
            }
            this._log.info('update', `downloading extension v${rel.code} (${rel.name})`);
            const data = await this._api.request('GET', '/api/releases/extension/download', {raw: true});
            const sha = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, new GLib.Bytes(data));
            if (sha !== rel.sha256)
                throw new Error('checksum mismatch');
            const path = GLib.build_filenamev([GLib.get_tmp_dir(), `questboard-${rel.code}.zip`]);
            GLib.file_set_contents(path, data);
            const proc = Gio.Subprocess.new(['gnome-extensions', 'install', '--force', path],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            const [, , stderr] = await proc.communicate_utf8_async(null, null);
            if (!proc.get_successful())
                throw new Error(`gnome-extensions install failed: ${stderr}`);
            this._settings.set_int('pending-update-code', rel.code);
            this._log.info('update', `installed v${rel.code}; active after re-login`);
            this._notify(`Questboard ${rel.name} installed`, `${rel.notes ? `${rel.notes}\n` : ''}Log out and back in to load it.`);
            return rel;
        } catch (e) {
            if (!/HTTP 404/.test(e.message))
                this._log.warn('update', `check failed: ${e.message}`);
            if (manual)
                this._notify('Update check failed', e.message);
            return null;
        }
    }

    destroy() {
        for (const id of [this._id, this._firstId])
            if (id)
                GLib.source_remove(id);
        this._id = this._firstId = 0;
    }
}

// ------------------------------------------------------------ subprocess

/** Run a command, return {ok, stdout, stderr}. */
export async function run(argv, {input = null, timeoutSec = 40} = {}) {
    const proc = Gio.Subprocess.new(argv,
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE |
        (input !== null ? Gio.SubprocessFlags.STDIN_PIPE : 0));
    let timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeoutSec, () => {
        timer = 0;
        proc.force_exit();
        return GLib.SOURCE_REMOVE;
    });
    try {
        const [, stdout, stderr] = await proc.communicate_utf8_async(input, null);
        return {ok: proc.get_successful(), stdout: stdout ?? '', stderr: stderr ?? '', timedOut: !timer};
    } finally {
        if (timer)
            GLib.source_remove(timer);
    }
}
