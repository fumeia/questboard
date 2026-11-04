import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class QuestboardPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({title: 'Questboard', icon_name: 'x-office-calendar-symbolic'});

        const spin = (title, subtitle, key, lower, upper, step = 1) => {
            const row = new Adw.ActionRow({title, subtitle});
            const sb = new Gtk.SpinButton({
                adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 10}),
                valign: Gtk.Align.CENTER,
                numeric: true,
            });
            sb.value = settings.get_int(key);
            sb.connect('value-changed', () => settings.set_int(key, sb.get_value_as_int()));
            row.add_suffix(sb);
            row.activatable_widget = sb;
            return row;
        };

        const size = new Adw.PreferencesGroup({title: 'Popup size', description: '0 = same size as GNOME’s calendar popup (minimum 760 × 540)'});
        size.add(spin('Width', 'Pixels', 'popup-width', 0, 3000, 10));
        size.add(spin('Height', 'Pixels', 'popup-height', 0, 2000, 10));
        page.add(size);

        const timers = new Adw.PreferencesGroup({title: 'Timers'});
        timers.add(spin('Pomodoro length', 'Minutes', 'pomodoro-minutes', 1, 180));
        timers.add(spin('Break length', 'Minutes', 'break-minutes', 1, 60));
        const sw = new Adw.SwitchRow
            ? new Adw.SwitchRow({title: 'Show running timer in top bar'})
            : null;
        if (sw) {
            sw.active = settings.get_boolean('show-panel-timer');
            sw.connect('notify::active', () => settings.set_boolean('show-panel-timer', sw.active));
            timers.add(sw);
        }
        page.add(timers);

        const cal = new Adw.PreferencesGroup({
            title: 'Calendar',
            description: 'Events come from GNOME Online Accounts. Add your Google account in Settings › Online Accounts and enable “Calendar”.',
        });
        cal.add(spin('Day view starts at', 'Hour the timeline scrolls to for other days', 'day-start-hour', 0, 23));
        page.add(cal);

        window.add(page);
    }
}
