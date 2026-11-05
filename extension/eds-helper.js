#!/usr/bin/env -S gjs -m
// Out-of-process calendar writer for Questboard.
//
// Talks to evolution-data-server (where GNOME Online Accounts puts your Google
// calendars) so creating / editing / deleting events goes straight to Google.
// Runs as a subprocess so a slow or crashing backend can never freeze GNOME Shell.
//
//   gjs -m eds-helper.js '{"cmd":"list"}'
//   gjs -m eds-helper.js '{"cmd":"create","source":"<uid>","summary":"Gym","start":1793800000,"end":1793803600}'
//
// Output: one JSON object on stdout: {ok:true,...} or {ok:false,error,hint?}

import GLib from 'gi://GLib';
import System from 'system';

function out(obj) {
    print(JSON.stringify(obj));
}

let EDataServer, ECal, ICalGLib;
try {
    EDataServer = (await import('gi://EDataServer?version=1.2')).default;
    ECal = (await import('gi://ECal?version=2.0')).default;
    ICalGLib = (await import('gi://ICalGLib?version=3.0')).default;
} catch (e) {
    out({ok: false, error: 'missing-typelibs', detail: String(e),
        hint: 'sudo apt install gir1.2-ecal-2.0 gir1.2-edataserver-1.2'});
    System.exit(0);
}

const UTC = ICalGLib.Timezone.get_utc_timezone();

function icalTime(unixSec, allDay) {
    if (allDay) {
        const d = GLib.DateTime.new_from_unix_local(unixSec);
        const t = ICalGLib.Time.new_null_time();
        t.set_date(d.get_year(), d.get_month(), d.get_day_of_month());
        t.set_is_date(true);
        return t;
    }
    return ICalGLib.Time.new_from_timet_with_zone(unixSec, 0, UTC);
}

/** GJS returns [ok, out] for gboolean+out functions; normalise. */
const second = v => (Array.isArray(v) ? v[1] : v);

let registry = null;
function reg() {
    registry ??= EDataServer.SourceRegistry.new_sync(null);
    return registry;
}

function findSource(uid) {
    const s = reg().ref_source(uid);
    if (!s)
        throw new Error(`calendar ${uid} not found`);
    return s;
}

function connect(source) {
    return ECal.Client.connect_sync(source, ECal.ClientSourceType.EVENTS, 20, null);
}

function applyFields(comp, a) {
    if (a.summary !== undefined)
        comp.set_summary(a.summary);
    if (a.start !== undefined)
        comp.set_dtstart(icalTime(a.start, !!a.allDay));
    if (a.end !== undefined)
        comp.set_dtend(icalTime(a.end, !!a.allDay));
    if (a.description !== undefined)
        setTextProp(comp, ICalGLib.PropertyKind.DESCRIPTION_PROPERTY, a.description, v => comp.set_description(v));
    if (a.location !== undefined)
        setTextProp(comp, ICalGLib.PropertyKind.LOCATION_PROPERTY, a.location, v => comp.set_location(v));
}

function setTextProp(comp, kind, value, setter) {
    if (value) {
        setter(value);
        return;
    }
    let p;
    while ((p = comp.get_first_property(kind)))
        comp.remove_property(p);
}

function getComp(client, uid, rid) {
    if (rid) {
        try {
            return second(client.get_object_sync(uid, rid, null));
        } catch {
            // Instance not detached yet: derive it from the master.
            const master = second(client.get_object_sync(uid, null, null));
            const inst = master.clone();
            for (const kind of [ICalGLib.PropertyKind.RRULE_PROPERTY, ICalGLib.PropertyKind.EXDATE_PROPERTY,
                ICalGLib.PropertyKind.RDATE_PROPERTY]) {
                let p;
                while ((p = inst.get_first_property(kind)))
                    inst.remove_property(p);
            }
            inst.set_recurrenceid(ICalGLib.Time.new_from_string(rid));
            return inst;
        }
    }
    return second(client.get_object_sync(uid, null, null));
}

const commands = {
    /** Fast: no backend connections (those can take 20 s each for offline/readonly calendars). */
    list() {
        const sources = reg().list_sources(EDataServer.SOURCE_EXTENSION_CALENDAR);
        const cals = [];
        for (const s of sources) {
            if (!s.get_enabled())
                continue;
            const ext = s.get_extension(EDataServer.SOURCE_EXTENSION_CALENDAR);
            const parent = s.get_parent() ? reg().ref_source(s.get_parent()) : null;
            const backend = ext.get_backend_name?.() ?? '';
            // read-only kinds: birthdays (contacts), weather, subscribed webcal feeds
            const writable = !['contacts', 'weather', 'webcal'].includes(backend);
            cals.push({
                uid: s.get_uid(),
                name: s.get_display_name(),
                account: parent?.get_display_name() ?? '',
                color: ext.get_color?.() ?? null,
                selected: ext.get_selected?.() ?? true,
                backend: ext.get_backend_name?.() ?? '',
                writable,
            });
        }
        return {calendars: cals};
    },

    /** Privacy-safe diagnostics: counts, timings, error types — no names or accounts. */
    diag(a) {
        const t0 = Date.now();
        const sources = reg().list_sources(EDataServer.SOURCE_EXTENSION_CALENDAR).filter(s => s.get_enabled());
        const out = {typelibs: 'ok', registryMs: Date.now() - t0, calendars: sources.length, backends: {}, connect: []};
        for (const s of sources) {
            const b = s.get_extension(EDataServer.SOURCE_EXTENSION_CALENDAR).get_backend_name?.() ?? '?';
            out.backends[b] = (out.backends[b] ?? 0) + 1;
        }
        if (a.connect) {
            for (const s of sources.slice(0, 8)) {
                const t = Date.now();
                const b = s.get_extension(EDataServer.SOURCE_EXTENSION_CALENDAR).get_backend_name?.() ?? '?';
                try {
                    const c = ECal.Client.connect_sync(s, ECal.ClientSourceType.EVENTS, 5, null);
                    out.connect.push({backend: b, ms: Date.now() - t, readonly: c.is_readonly()});
                } catch (e) {
                    out.connect.push({backend: b, ms: Date.now() - t, error: e.constructor?.name ?? 'Error',
                        code: e.code ?? null});
                }
            }
        }
        return out;
    },

    get(a) {
        const comp = getComp(connect(findSource(a.source)), a.uid, a.rid);
        return {
            summary: comp.get_summary() ?? '',
            description: comp.get_description() ?? '',
            location: comp.get_location() ?? '',
            allDay: !!comp.get_dtstart()?.is_date(),
            recurring: !!comp.get_first_property(ICalGLib.PropertyKind.RRULE_PROPERTY) || !!a.rid,
        };
    },

    create(a) {
        const client = connect(findSource(a.source));
        const comp = ICalGLib.Component.new_vevent();
        comp.set_uid(GLib.uuid_string_random());
        comp.set_dtstamp(ICalGLib.Time.new_current_with_zone(UTC));
        applyFields(comp, a);
        const uid = second(client.create_object_sync(comp, ECal.OperationFlags.NONE, null));
        return {uid: uid ?? comp.get_uid()};
    },

    update(a) {
        const client = connect(findSource(a.source));
        const comp = getComp(client, a.uid, a.rid);
        applyFields(comp, a);
        const mod = a.rid && a.scope !== 'all' ? ECal.ObjModType.THIS : ECal.ObjModType.ALL;
        client.modify_object_sync(comp, mod, ECal.OperationFlags.NONE, null);
        return {};
    },

    delete(a) {
        const client = connect(findSource(a.source));
        const mod = a.rid && a.scope !== 'all' ? ECal.ObjModType.THIS : ECal.ObjModType.ALL;
        client.remove_object_sync(a.uid, a.scope === 'all' ? null : (a.rid || null), mod, ECal.OperationFlags.NONE, null);
        return {};
    },

    /** Move an event to another calendar = create there + delete here. */
    move(a) {
        const from = connect(findSource(a.source));
        const comp = getComp(from, a.uid, null);
        const to = connect(findSource(a.target));
        const copy = comp.clone();
        copy.set_uid(GLib.uuid_string_random());
        const uid = second(to.create_object_sync(copy, ECal.OperationFlags.NONE, null));
        from.remove_object_sync(a.uid, null, ECal.ObjModType.ALL, ECal.OperationFlags.NONE, null);
        return {uid};
    },
};

try {
    const raw = System.programArgs[0] ?? '{}';
    const args = JSON.parse(raw || '{}');
    const fn = commands[args.cmd];
    if (!fn)
        throw new Error(`unknown cmd ${args.cmd}`);
    out({ok: true, ...fn(args)});
} catch (e) {
    out({ok: false, error: e.message ?? String(e)});
}
