// Questboard — replaces the contents of the top-bar date/time popup with an
// Eisenhower-matrix quest board, a Google-synced day calendar and timers.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Dashboard} from './dashboard.js';
import {Store} from './store.js';
import {fmtTimer} from './util.js';

const MIN_W = 760;
const MIN_H = 540;

export default class QuestboardExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._store = new Store();
        this._dateMenu = Main.panel.statusArea.dateMenu;
        const menu = this._dateMenu.menu;

        // Remember the original size so we can open at the same footprint.
        this._origSize = this._measureOriginal(menu);

        // Hide (don't destroy) the stock calendar/notification content.
        this._hidden = menu.box.get_children().filter(c => c.visible);

        this._dashboard = new Dashboard({
            store: this._store,
            settings: this._settings,
            closeMenu: () => menu.close(),
            openPrefs: () => this.openPreferences(),
            showClassic: () => this._setClassic(true),
        });
        menu.box.add_child(this._dashboard.actor);
        this._setClassic(false);
        this._applySize();

        this._openId = menu.connect('open-state-changed', (_m, open) => {
            if (open) {
                this._setClassic(false);
                this._applySize();
                this._dashboard.onOpen();
            } else {
                this._dashboard.onClose();
            }
            this._ensureTick();
        });

        this._buildPanelBadge();

        this._unsub = this._store.subscribe(() => {
            this._ensureTick();
            this._updatePanelBadge();
        });

        this._settingsIds = [
            this._settings.connect('changed::popup-width', () => this._applySize()),
            this._settings.connect('changed::popup-height', () => this._applySize()),
            this._settings.connect('changed::show-panel-timer', () => this._updatePanelBadge()),
        ];

        this._dashboard.render();
        this._ensureTick();
        this._updatePanelBadge();
    }

    disable() {
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
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
        this._badge = null;
        this._badgeLabel = null;

        this._store?.destroy();
        this._store = null;
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
            console.debug(`[Questboard] could not measure date menu: ${e}`);
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

    /** Toggle between the dashboard and GNOME's stock notifications/calendar. */
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
        const now = Date.now();
        const finished = this._store.tick(now);
        for (const t of finished)
            this._notifyFinished(t);
        this._updatePanelBadge(now);
        if (this._dateMenu.menu.isOpen)
            this._dashboard.tick(now);
        if (!this._needsTick()) {
            this._tickId = 0;
            return GLib.SOURCE_REMOVE;
        }
        return GLib.SOURCE_CONTINUE;
    }

    _notifyFinished(t) {
        const quest = t.questId ? this._store.getQuest(t.questId) : null;
        let title, body;
        if (t.kind === 'pomodoro') {
            title = 'Pomodoro complete · +10 XP';
            body = quest ? `Nice work on “${quest.title}”. Time for a break.` : 'Time for a break.';
        } else if (t.kind === 'break') {
            title = 'Break over';
            body = 'Back to your quests!';
        } else {
            title = 'Timer finished';
            body = t.label;
        }
        try {
            Main.notify(title, body);
        } catch (e) {
            console.error(`[Questboard] notify failed: ${e}`);
        }
        try {
            global.display.get_sound_player().play_from_theme('complete', title, null);
        } catch {
            // sound is optional
        }
    }

    // ---- panel badge -----------------------------------------------------

    _buildPanelBadge() {
        const clock = this._dateMenu._clockDisplay;
        const parent = clock?.get_parent();
        if (!parent)
            return;
        this._badge = new St.BoxLayout({style_class: 'qb-panel-badge', visible: false, y_align: Clutter.ActorAlign.CENTER});
        this._badge.add_child(new St.Icon({icon_name: 'alarm-symbolic', style_class: 'qb-panel-badge-icon'}));
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
