import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Soup from 'gi://Soup?version=3.0';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

export default class QuestboardPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(620, 720);

        const spin = (title, subtitle, key, lower, upper, step = 1) => {
            const row = new Adw.ActionRow({title, subtitle});
            const sb = new Gtk.SpinButton({
                adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 10}),
                valign: Gtk.Align.CENTER, numeric: true,
            });
            sb.value = settings.get_int(key);
            sb.connect('value-changed', () => settings.set_int(key, sb.get_value_as_int()));
            row.add_suffix(sb);
            row.activatable_widget = sb;
            return row;
        };
        const toggle = (title, subtitle, key) => {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            return row;
        };
        const text = (title, key, password = false) => {
            const row = password ? new Adw.PasswordEntryRow({title}) : new Adw.EntryRow({title});
            row.text = settings.get_string(key);
            row.show_apply_button = true;
            row.connect('apply', () => settings.set_string(key, row.text.trim()));
            return row;
        };
        const buttonRow = (title, subtitle, label, onClick) => {
            const row = new Adw.ActionRow({title, subtitle});
            const b = new Gtk.Button({label, valign: Gtk.Align.CENTER});
            b.connect('clicked', () => onClick(row, b));
            row.add_suffix(b);
            return row;
        };

        // ---- General
        const general = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});
        const look = new Adw.PreferencesGroup({title: 'Appearance'});
        const themes = ['auto', 'light', 'dark'];
        const themeRow = new Adw.ComboRow({title: 'Theme', subtitle: 'Auto follows Settings › Appearance (Default / Dark)',
            model: Gtk.StringList.new(['Auto', 'Light', 'Dark'])});
        themeRow.selected = Math.max(0, themes.indexOf(settings.get_string('theme')));
        themeRow.connect('notify::selected', () => settings.set_string('theme', themes[themeRow.selected]));
        look.add(themeRow);
        general.add(look);
        const size = new Adw.PreferencesGroup({title: 'Popup size', description: '0 = same size as GNOME’s calendar popup (minimum 780 × 560)'});
        size.add(spin('Width', 'Pixels', 'popup-width', 0, 3000, 10));
        size.add(spin('Height', 'Pixels', 'popup-height', 0, 2000, 10));
        general.add(size);
        const timers = new Adw.PreferencesGroup({title: 'Timers & reminders'});
        timers.add(spin('Pomodoro length', 'Minutes', 'pomodoro-minutes', 1, 180));
        timers.add(spin('Break length', 'Minutes', 'break-minutes', 1, 60));
        timers.add(toggle('Show running timer in the top bar', '', 'show-panel-timer'));
        timers.add(toggle('Add finished Pomodoros to Google Calendar', 'Written to the default calendar (set when you add an event)', 'focus-to-calendar'));
        timers.add(toggle('Remind me when a scheduled quest starts', '', 'quest-reminders'));
        general.add(timers);
        const cal = new Adw.PreferencesGroup({
            title: 'Calendar',
            description: 'Events come from GNOME Online Accounts (Settings › Online Accounts › Google, “Calendar” on). '
                + 'Editing needs: sudo apt install gir1.2-ecal-2.0 gir1.2-edataserver-1.2',
        });
        cal.add(spin('Day view starts at', 'Hour the timeline scrolls to for other days', 'day-start-hour', 0, 23));
        general.add(cal);
        window.add(general);

        // ---- Sync
        const syncPage = new Adw.PreferencesPage({title: 'Sync', icon_name: 'emblem-synchronizing-symbolic'});
        const server = new Adw.PreferencesGroup({
            title: 'Questboard server',
            description: 'Your self-hosted server keeps desktop and phone in sync and receives debug logs. '
                + 'Press Enter (or the check mark) after editing a field.',
        });
        server.add(text('Server URL (e.g. http://192.168.1.20:8787)', 'server-url'));
        server.add(text('Token (QB_TOKEN from the server’s .env)', 'server-token', true));
        server.add(text('Device name (optional)', 'device-name'));
        server.add(toggle('Sync enabled', '', 'sync-enabled'));
        server.add(buttonRow('Test connection', 'Checks URL and token', 'Test', async (row, b) => {
            b.sensitive = false;
            row.subtitle = 'Testing…';
            try {
                const url = settings.get_string('server-url').trim().replace(/\/+$/, '');
                const session = new Soup.Session({timeout: 10});
                const msg = Soup.Message.new('GET', `${url}/api/devices`);
                if (!msg)
                    throw new Error('invalid URL');
                msg.request_headers.append('Authorization', `Bearer ${settings.get_string('server-token')}`);
                const bytes = await session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
                const st = msg.get_status();
                if (st === 401)
                    throw new Error('server reachable, but the token is wrong');
                if (st !== 200)
                    throw new Error(`HTTP ${st}`);
                const j = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                row.subtitle = `Connected ✓ — ${j.devices.length} device(s) known to the server`;
            } catch (e) {
                row.subtitle = `Failed: ${e.message}`;
            } finally {
                b.sensitive = true;
            }
        }));
        server.add(buttonRow('Sync now', '', 'Sync', () => settings.set_int('sync-request', settings.get_int('sync-request') + 1)));
        syncPage.add(server);
        window.add(syncPage);

        // ---- Debug & updates
        const dbg = new Adw.PreferencesPage({title: 'Debug', icon_name: 'dialog-warning-symbolic'});
        const logs = new Adw.PreferencesGroup({title: 'Logging',
            description: 'Logs go to the system journal, to ~/.local/share/questboard/questboard.log and (if enabled) to your server’s console.'});
        const levels = ['debug', 'info', 'warn', 'error'];
        const lvl = new Adw.ComboRow({title: 'Log level', model: Gtk.StringList.new(levels)});
        lvl.selected = Math.max(0, levels.indexOf(settings.get_string('log-level')));
        lvl.connect('notify::selected', () => settings.set_string('log-level', levels[lvl.selected]));
        logs.add(lvl);
        logs.add(toggle('Send logs to the server', 'So problems can be debugged remotely', 'remote-logging'));
        logs.add(buttonRow('Log file', '~/.local/share/questboard/questboard.log', 'Open', () => {
            const f = GLib.build_filenamev([GLib.get_user_data_dir(), 'questboard', 'questboard.log']);
            Gio.AppInfo.launch_default_for_uri(Gio.File.new_for_path(f).get_uri(), null);
        }));
        dbg.add(logs);
        const upd = new Adw.PreferencesGroup({title: 'Updates',
            description: `Installed version: ${this.metadata.version}. New versions published to your server install automatically; log out and back in to load them.`});
        upd.add(toggle('Install updates automatically', '', 'auto-update'));
        upd.add(buttonRow('Check for updates', '', 'Check now', () => settings.set_int('update-request', settings.get_int('update-request') + 1)));
        dbg.add(upd);
        window.add(dbg);
    }
}
