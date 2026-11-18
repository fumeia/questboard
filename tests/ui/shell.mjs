// Stand-ins for the GNOME Shell modules the extension imports (main.js, calendar.js, util.js, extension.js).
class Source {
    connect() {
        return 1;
    }
    disconnect() {}
    requestRange() {}
    getEvents() {
        return globalThis.__qbMock?.events ?? [];
    }
    hasEvents() {
        return false;
    }
}
export class DBusEventSource extends Source {}
export class EmptyEventSource extends Source {}
export const sessionMode = {showCalendarEvents: true, currentMode: 'user'};
export const layoutManager = {primaryMonitor: {width: 1920, height: 1080}};
export const panel = {height: 32, statusArea: {}};
export function notify(title, body) {
    (globalThis.__qbMock.notes ??= []).push([title, body]);
}
export function spawn() {}
export function spawnCommandLine() {}
export class Extension {}
