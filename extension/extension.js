// Questboard — replaces the top-bar date/time popup with an Eisenhower quest
// board, habits, a rewards shop, a Google-synced editable calendar and timers.
// Syncs with the Questboard server (see server/) and the Android app.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Dashboard} from './dashboard.js';
import {Eds} from './eds.js';
import {Api, Logger, SyncClient, Updater} from './net.js';
import {Store} from './store.js';
import {fmtTimer, gicon, setErrorHandler, setIconDir} from './util.js';

const MIN_W = 780;
const MIN_H = 560;

function rssMb() {
    try {
        const [, bytes] = GLib.file_get_contents('/proc/self/status');
        const m = /VmRSS:\s+(\d+)/.exec(new TextDecoder().decode(bytes));
        return m ? Math.round(parseInt(m[1], 10) / 1024) : null;
    } catch {
        return null;
    }
}

export default class QuestboardExtension extends Extension {
    enable() {
        this._version = this.metadata.version ?? 0;
        this._settings = this.getSettings();
        setIconDir(GLib.build_filenamev([this.path, 'icons']));

        this._log = new Logger({settings: this._settings, version: this._version});
        setErrorHandler((e, where) => this._log.exception(`ui:${where}`, e));
        try {
            this._enable();
        } catch (e) {
            this._log.exception('enable', e);
            this.disable();
            throw e;
        }
    }

    _enable() {
        const t0 = Date.now();
        this._api = new Api(this._settings);
        this._log.api = this._api;
        this._store = new Store({log: this._log});
        this._log.deviceId = this._store.deviceId;
        this._sync = new SyncClient({store: this._store, settings: this._settings, api: this._api, log: this._log, version: this._version});
        this._updater = new Updater({api: this._api, settings: this._settings, log: this._log, version: this._version,
            notify: (t, b) => this._notify(t, b)});
        this._eds = new Eds({dir: this.path, log: this._log});

        this._dateMenu = Main.panel.statusArea.dateMenu;
        const menu = this._dateMenu.menu;
        this._origSize = this._measureOriginal(menu);
        this._hidden = menu.box.get_children().filter(c => c.visible);

        this._dashboard = new Dashboard({
            store: this._store,
            settings: this._settings,
            sync: this._sync,
            eds: this._eds,
            log: this._log,
            closeMenu: () => menu.close(),
            openPrefs: () => this.openPreferences(),
            showClassic: () => this._setClassic(true),
            notify: (t, b) => this._notify(t, b),
        });
        menu.box.add_child(this._dashboard.actor);
        this._setClassic(false);
        this._applySize();

        this._openId = menu.connect('open-state-changed', (_m, open) => {
            try {
                if (open) {
                    this._setClassic(false);
                    this._applySize();
                    this._dashboard.onOpen();
                    this._sync.syncNow('open');
                    this._updater.maybeCheck();
                } else {
                    this._dashboard.onClose();
                }
                this._ensureTick();
            } catch (e) {
                this._log.exception('menu', e);
            }
        });

        this._buildPanelBadge();
        this._unsub = this._store.subscribe(() => {
            this._ensureTick();
            this._updatePanelBadge();
        });

        const s = this._settings;
        this._settingsIds = [
            s.connect('changed::popup-width', () => this._applySize()),
            s.connect('changed::popup-height', () => this._applySize()),
            s.connect('changed::show-panel-timer', () => this._updatePanelBadge()),
            s.connect('changed::sync-request', () => this._sync.syncNow('manual')),
            s.connect('changed::update-request', () => this._updater.check({manual: true})),
            s.connect('changed::server-url', () => this._sync.schedule(1000)),
            s.connect('changed::server-token', () => this._sync.schedule(1000)),
            s.connect('changed::sync-enabled', () => this._sync.schedule(500)),
        ];

        // Housekeeping every 30 s: quest reminders. Heartbeat every 30 min.
        this._houseN = 0;
        this._houseId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 30, () => {
            try {
                this._housekeeping();
            } catch (e) {
                this._log.exception('housekeeping', e);
            }
            return GLib.SOURCE_CONTINUE;
        });

        this._ensureTick();
        this._updatePanelBadge();
        this._sync.syncNow('startup');
        this._log.info('lifecycle', `enabled v${this._version} in ${Date.now() - t0} ms`,
            {shell: Main.sessionMode?.currentMode, rssMb: rssMb(), size: this._origSize});
    }

    disable() {
        this._log?.info('lifecycle', 'disabled');
        for (const id of [this._tickId, this._houseId])
            if (id)
                GLib.source_remove(id);
        this._tickId = this._houseId = 0;
        this._settingsIds?.forEach(id => this._settings.disconnect(id));
        this._settingsIds = null;
        this._unsub?.();
        this._unsub = null;

        if (this._openId) {
            this._dateMenu.menu.disconnect(this._openId);
            this._openId = 0;
        }
        this._dashboard?.destroy();
        this._dashboard = null;
        for (const c of this._hidden ?? [])
            c.show();
        this._hidden = null;
        this._badge?.destroy();
        this._badge = this._badgeLabel = null;

        this._sync?.destroy();
        this._updater?.destroy();
        this._store?.destroy();
        this._log?.flush();
        this._log?.destroy();
        this._api?.destroy();
        this._sync = this._updater = this._store = this._log = this._api = this._eds = null;
        setErrorHandler(e => console.error(e));
        this._settings = null;
        this._dateMenu = null;
    }

    // ---- layout ----------------------------------------------------------

    _measureOriginal(menu) {
        try {
            const [, natW] = menu.box.get_preferred_width(-1);
            const [, natH] = menu.box.get_preferred_height(natW);
            if (natW > 0 && natH > 0)
                return [natW, natH];
        } catch (e) {
            this._log.debug('layout', `could not measure date menu: ${e}`);
        }
        return [MIN_W, MIN_H];
    }

    _applySize() {
        if (!this._dashboard)
            return;
        const monitor = Main.layoutManager.primaryMonitor;
        const maxW = monitor ? monitor.width - 40 : 1600;
        const maxH = monitor ? monitor.height - Main.panel.height - 60 : 1000;
        let w = this._settings.get_int('popup-width');
        let h = this._settings.get_int('popup-height');
        if (w <= 0)
            w = Math.max(MIN_W, this._origSize[0]);
        if (h <= 0)
            h = Math.max(MIN_H, this._origSize[1]);
        this._dashboard.applySize(Math.min(w, maxW), Math.min(h, maxH));
    }

    _setClassic(classic) {
        for (const c of this._hidden ?? [])
            c.visible = classic;
        if (this._dashboard)
            this._dashboard.actor.visible = !classic;
    }

    // ---- ticking ---------------------------------------------------------

    _needsTick() {
        return this._store.runningTimers().length > 0 || this._dateMenu.menu.isOpen;
    }

    _ensureTick() {
        if (this._tickId || !this._store || !this._needsTick())
            return;
        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => this._onTick());
    }

    _onTick() {
        try {
            const now = Date.now();
            for (const t of this._store.tick(now))
                this._notifyFinished(t);
            this._updatePanelBadge(now);
            if (this._dateMenu.menu.isOpen)
                this._dashboard.tick(now);
        } catch (e) {
            this._log.exception('tick', e);
        }
        if (!this._needsTick()) {
            this._tickId = 0;
            return GLib.SOURCE_REMOVE;
        }
        return GLib.SOURCE_CONTINUE;
    }

    _housekeeping() {
        if (this._settings.get_boolean('quest-reminders')) {
            for (const q of this._store.dueReminders())
                this._notify(`Starting now: ${q.title}`, `Scheduled quest · ${q.scheduled.duration ?? 60} min`);
        }
        if (++this._houseN % 60 === 1) {
            this._log.info('heartbeat', 'alive', {rssMb: rssMb(), dirty: this._store.dirtyCount(),
                timers: this._store.runningTimers().length, sync: this._sync.status.state});
        }
    }

    _notify(title, body) {
        try {
            Main.notify(title, body);
        } catch (e) {
            this._log.warn('notify', `failed: ${e}`);
        }
    }

    _notifyFinished(t) {
        const quest = t.questId ? this._store.getQuest(t.questId) : null;
        let title, body;
        if (t.kind === 'pomodoro') {
            title = 'Pomodoro complete · +10 XP';
            body = quest ? `Nice work on “${quest.title}”. Time for a break.` : 'Time for a break.';
        } else if (t.kind === 'break') {
            title = 'Break over';
            body = 'Back to your quests.';
        } else {
            title = 'Timer finished';
            body = t.label;
        }
        this._notify(title, body);
        try {
            global.display.get_sound_player().play_from_theme('complete', title, null);
        } catch {}
    }

    // ---- panel badge -----------------------------------------------------

    _buildPanelBadge() {
        const clock = this._dateMenu._clockDisplay;
        const parent = clock?.get_parent();
        if (!parent)
            return;
        this._badge = new St.BoxLayout({style_class: 'qb-panel-badge', visible: false, y_align: Clutter.ActorAlign.CENTER});
        this._badge.add_child(new St.Icon({
            gicon: gicon('qb-stopwatch'),
            style_class: 'qb-panel-badge-icon',
        }));
        this._badgeLabel = new St.Label({style_class: 'qb-panel-badge-label', y_align: Clutter.ActorAlign.CENTER});
        this._badge.add_child(this._badgeLabel);
        parent.insert_child_below(this._badge, clock);
    }

    _updatePanelBadge(now = Date.now()) {
        if (!this._badge)
            return;
        const running = this._store.runningTimers();
        const t = running.find(x => x.mode === 'countdown') ?? running[0];
        if (!t || !this._settings.get_boolean('show-panel-timer')) {
            this._badge.hide();
            return;
        }
        const ms = t.mode === 'countdown' ? this._store.timerRemaining(t, now) : this._store.timerElapsed(t, now);
        this._badgeLabel.text = fmtTimer(ms);
        this._badge.show();
    }
}
