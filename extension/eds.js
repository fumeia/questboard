// Shell-side wrapper around eds-helper.js (calendar create/edit/delete).

import GLib from 'gi://GLib';

import {run} from './net.js';

export class Eds {
    constructor({dir, log}) {
        this._helper = GLib.build_filenamev([dir, 'eds-helper.js']);
        this._log = log;
        this._cals = null;
        this._calsAt = 0;
        this.unavailable = null; // {error, hint} once we know typelibs are missing
    }

    async call(args) {
        const gjs = GLib.find_program_in_path('gjs') ?? GLib.find_program_in_path('gjs-console');
        if (!gjs)
            throw new Error('gjs not found');
        const t0 = Date.now();
        const res = await run([gjs, '-m', this._helper, JSON.stringify(args)], {timeoutSec: args.cmd === 'list' ? 20 : 45});
        const line = res.stdout.trim().split('\n').pop() || '';
        let obj;
        try {
            obj = JSON.parse(line);
        } catch {
            const detail = redact(res.stderr.trim().split('\n').filter(Boolean).pop() || line || 'no output');
            throw new Error(`calendar helper failed${res.timedOut ? ' (timeout)' : ''}: ${detail.slice(0, 200)}`);
        }
        this._log.debug('eds', `${args.cmd} → ${obj.ok ? 'ok' : obj.error} (${Date.now() - t0} ms)`);
        if (!obj.ok) {
            if (obj.error === 'missing-typelibs')
                this.unavailable = {error: 'Calendar editing needs two system packages', hint: obj.hint};
            throw new Error(redact(obj.hint ? `${obj.error}: ${obj.hint}` : obj.error));
        }
        return obj;
    }

    /** Writable/visible calendars, cached for 10 minutes. */
    async calendars(force = false) {
        if (!force && this._cals && Date.now() - this._calsAt < 600000)
            return this._cals;
        const {calendars} = await this.call({cmd: 'list'});
        this._cals = calendars;
        this._calsAt = Date.now();
        return calendars;
    }

    get cachedCalendars() {
        return this._cals ?? [];
    }

    colorFor(sourceUid) {
        return this._cals?.find(c => c.uid === sourceUid)?.color ?? null;
    }
}

/** Strip e-mail addresses so calendar errors never put your account into logs. */
function redact(text) {
    return String(text).replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>');
}

/** The shell calendar server's event id is "sourceUid\nuid\nrid". */
export function parseEventId(id) {
    const [source = '', uid = '', rid = ''] = String(id).split('\n');
    return {source, uid, rid};
}
