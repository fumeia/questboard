// Builds the real popup (extension/dashboard.js + pages + calendar) on the stand-in widgets, clicks through it and checks
// the flows; with SHOTS=<dir> it also writes an HTML page per view (tests/ui/shoot.mjs turns them into PNGs).
//   node --import ./tests/ui/loader.mjs tests/ui/ui_test.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import {fileURLToPath} from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(HERE, '..', '..', 'extension');
process.env.QB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-ui-'));

const G = globalThis.__qbMock ??= {timers: new Map(), nextId: 1, focus: null, opened: []};
const {Store, parseDueDate} = await import(path.join(EXT, 'store.js'));
const {Dashboard} = await import(path.join(EXT, 'dashboard.js'));
const util = await import(path.join(EXT, 'util.js'));
const {writeHtml} = await import(path.join(HERE, 'render.mjs'));

let failed = 0;
const check = (ok, what) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
    if (!ok)
        failed++;
};
const errors = [];
util.setErrorHandler((e, where) => {
    errors.push(`${where}: ${e?.stack ?? e}`);
});
util.setIconDir(path.join(EXT, 'icons'));

// ---- settings + context
const ints = {'pomodoro-minutes': 25, 'break-minutes': 5, 'day-start-hour': 8, 'popup-width': 0, 'popup-height': 0};
const settings = {
    get_int: k => ints[k] ?? 0, set_int: (k, v) => (ints[k] = v),
    get_string: k => ({theme: 'dark'}[k] ?? ''), set_string() {},
    get_boolean: () => false, set_boolean() {}, connect: () => 1, disconnect() {},
};
const store = new Store({log: {debug() {}, info() {}, warn() {}, error() {}, exception: (w, e) => errors.push(`${w}: ${e}`)}});
let menuOpen = true;
const ctx = {
    store, settings, eds: null,
    sync: {onStatus: () => () => {}, status: {state: 'idle'}, enabled: true, syncNow() {}},
    log: {debug() {}, info() {}, warn() {}, exception: (w, e) => errors.push(`${w}: ${e?.stack ?? e}`)},
    closeMenu: () => (menuOpen = false), openPrefs() {}, showClassic() {}, toggleTheme() {}, isDark: () => true, notify() {},
};

// ---- seed: three exam goals, quests of every kind (long titles, Notion, steps, due dates, time slots), the game's quests
const today = new Date();
const key = n => util.dateKey(util.addDays(today, n));
const gQM = store.addGoal('5.5 in QM 1', {targetDate: key(57)});
const gFKP = store.addGoal('5.0 in Festkörperphysik', {targetDate: key(63)});
const gAstro = store.addGoal('5.5 in Astro', {targetDate: key(70)});
const q1 = store.addQuest('Analysis II · Übungsblatt 5 abgeben und korrigieren', 'q1', null, {due: {date: key(0)}, source: 'notion', topic: 'Analysis II'});
store.addQuest('QM Übungsblatt 7: Störungstheorie Aufgaben 1–3', 'q1', null, {due: {date: key(1)}, topic: 'Quantenmechanik', goalId: gQM.id});
const q2 = store.addQuest('Festkörper Skript Kapitel 4 durcharbeiten (Phononen)', 'q2', null, {topic: 'Festkörperphysik', goalId: gFKP.id});
store.addStep(q2.id, 'Abschnitt 4.1 lineare Kette');
store.addStep(q2.id, 'Abschnitt 4.2 zweiatomige Kette');
store.addQuest('Astro: Altklausur 2023 rechnen', 'q2', {date: key(0), start: 14 * 60, duration: 90}, {topic: 'Astrophysik', due: {date: key(5)}});
store.addQuest('Bibliotheksbuch zurückgeben', 'q3', null, {due: {date: key(-1)}});
store.addQuest('Mails beantworten', 'q3');
store.addQuest('Serie weiterschauen', 'q4');
for (const t of ['Topic A', 'Topic B', 'Topic C', 'Topic D'])
    store.addQuest(`Filler ${t}`, 'q4', null, {topic: t});
// the game's records, as deploy/questboard_sync.py sends them
store._put('quests', {id: 'rpg.qm', title: 'Physics RPG · Quantenmechanik', quadrant: 'q2', done: false, createdAt: Date.now(), source: 'physics-rpg',
    topic: 'Quantenmechanik', link: 'https://rpg.example/', inMatrix: false, goalId: gQM.id,
    progress: {done: 41, total: 180, text: '41/180 exercises · 3/22 rooms cleared · 6h 10m studied', respawns: 3}});
store._put('quests', {id: 'rpg.qm.respawn', title: 'Physics RPG · Quantenmechanik: 3 respawns due', quadrant: 'q2', done: false,
    createdAt: Date.now(), source: 'physics-rpg', topic: 'Quantenmechanik', kind: 'respawn', respawns: 3, link: 'https://rpg.example/', inMatrix: true});
store._changed();
store.addHabit('Read 20 pages', 'book');
store.addHabit('Sport', 'dumbbell');
store.addReward('Kino', 300, 'film');
store.setTimerPresets([{label: 'Focus', kind: 'pomodoro', min: 25}, {label: 'Deep work', kind: 'custom', min: 50}, {label: 'Break', kind: 'break', min: 5}]);
store.startPomodoro(q2.id, 25);
check(errors.length === 0, `seeding without errors ${errors.join('\n')}`);

// ---- build and open
const dash = new Dashboard(ctx);
dash.applySize(780, 560);
dash.onOpen();
check(errors.length === 0, `popup opens without errors ${errors.slice(0, 3).join('\n')}`);

// ---- tree helpers
function* walk(a, all = false) {
    if (!a || a.destroyed || (!all && a.visible === false))
        return;
    yield a;
    for (const c of a.children)
        yield* walk(c, all);
}
const text = a => [...walk(a)].filter(x => x.kind === 'Label' || (x.kind === 'Button' && x.label != null)).map(x => x.text ?? x.label).join(' ');
const buttons = (root = dash.actor) => [...walk(root)].filter(x => x.kind === 'Button');
const btn = (name, root = dash.actor) => buttons(root).find(b => b.label === name || b.accessible_name === name || text(b).trim() === name);
const btnIn = (name, root) => btn(name, root);
const entries = (root = dash.actor) => [...walk(root)].filter(x => x.kind === 'Entry');
const has = (cls, root = dash.actor) => [...walk(root)].some(x => x.style_class?.split(/\s+/).includes(cls));
const byClass = (cls, root = dash.actor) => [...walk(root)].filter(x => x.style_class?.split(/\s+/).includes(cls));
const click = b => {
    if (!b)
        throw new Error('button not found');
    b.click();
};
const shots = process.env.SHOTS;
const shot = (name, theme = 'dark') => {
    if (shots)
        writeHtml(path.join(shots, `${name}.html`), dash.actor, {theme, stylesheet: fs.readFileSync(path.join(EXT, 'stylesheet.css'), 'utf8'), iconDir: path.join(EXT, 'icons'), title: name});
};

// ---- deadline row
const chips = byClass('qb-deadline');
check(chips.length === 3 && text(chips[0]).startsWith('5.5 in QM 1') && text(chips[0]).includes('57d'), `deadline row: three exams, nearest first (${chips.map(text).join(' | ')})`);
check(text(dash.actor).includes('done') && text(dash.actor).includes('focus') === false, 'header says "N done" (no focus yet today)');

// ---- matrix: two-line rows, compact chips, RPG respawn quest
shot('1-matrix');
shot('1-matrix-light', 'light');
const rows = byClass('qb-quest');
const rpgRow = rows.find(r => text(r).includes('Quantenmechanik') && text(r).includes('reviews due'));
check(!!rpgRow, 'game review quest shows as "Quantenmechanik" with a "3 reviews due" chip');
check(rpgRow && !text(rpgRow).includes('Physics RPG ·'), 'no "Physics RPG ·" prefix eating the title');
check(rows.every(r => byClass('qb-quest-meta', r).every(m => m.children.length <= 2)), 'matrix rows show at most two chips');
const late = rows.find(r => text(r).includes('Bibliotheksbuch'));
check(late && text(late).includes('1d late'), 'overdue chip on the second line');
G.opened.length = 0;
click(btn('Open Physics RPG', rpgRow));
check(G.opened[0] === 'https://rpg.example/' && !store.isQuestRunning('rpg.qm.respawn'), 'game quests: the button opens the game and starts no timer (no double counting)');
check(!menuOpen, '…and closes the popup');
menuOpen = true;

// ---- list view (the old Quests tab)
click(btn('List view'));
check(dash._listView.visible && !dash._grid.visible && text(dash.actor).includes('Recently deleted'), 'list view shows the quest log with Recently deleted');
shot('2-list');
check(!btn('Quests'), 'no separate Quests tab any more');
click(btn('Matrix view'));

// ---- quest details: actions on top, notes saved without Enter, all topics, date field, step goal picker
dash.openQuest(q2.id);
const body = dash._detailBody;
const order = body.children.map(c => text(c));
const focusIdx = order.findIndex(t => t.includes('25m focus'));
const notesIdx = body.children.findIndex(c => c.kind === 'Entry' && c.hint_text === 'Notes');
check(focusIdx > 0 && focusIdx < notesIdx, 'focus / stopwatch sit right under the title, above the notes');
check(!text(body).includes('Topic / course'), 'no topic picker: goals replace topics on screen');
check(buttons(body).some(b => b.label === '+1 day') && entries(body).some(e => e.style_class.includes('qb-date')), 'due date: ±1 day and a typed date');
shot('3-detail');
// type notes, no Enter, go back
const notes = entries(body).find(e => e.hint_text === 'Notes');
notes.type('Phononen: Dispersionsrelation herleiten', false);
click(btn('Back'));
check(store.getQuest(q2.id).notes === 'Phononen: Dispersionsrelation herleiten', 'notes typed without Enter are saved when you leave the page');
dash.openQuest(q2.id);
// title edit committed on focus-out
const title = entries(dash._detailBody).find(e => e.hint_text === 'Title');
title.type('Festkörper Kapitel 4: Phononen', false);
entries(dash._detailBody).find(e => e.hint_text === 'Notes').grab_key_focus();
G.runTimers(0);
check(store.getQuest(q2.id).title === 'Festkörper Kapitel 4: Phononen', 'title saved when the field loses focus');
// due date typed
const due = entries(dash._detailBody).find(e => e.style_class.includes('qb-date'));
due.type('+12');
check(store.getQuest(q2.id).due?.date === key(12), 'due date typed as +12 is saved');
const bad = entries(dash._detailBody).find(e => e.style_class.includes('qb-date'));
bad.type('31.2.');
check(bad.has_style_pseudo_class('error') && store.getQuest(q2.id).due?.date === key(12), 'an impossible date is marked, not saved');
// step goal picker
const stepGoal = buttons(dash._detailBody).find(b => b.label === 'Goal…');
click(stepGoal);
const picker = byClass('qb-picker', dash._detailBody)[0];
check(picker && btn('5.5 in Astro', picker), 'Goal… opens a list of goals');
click(btn('5.5 in Astro', picker));
check(store.getQuest(q2.id).steps[0].goalId === gAstro.id, 'picking a goal links the step (one click, no cycling)');
shot('3b-detail-steps');

// ---- delete with undo
click(btn('Delete quest', dash._detailBody));
check(!store.getQuest(q2.id) && dash._undoBar.visible && text(dash._undoBar).includes('Deleted'), 'deleting shows "Deleted … · Undo"');
shot('4-undo');
click(btn('Undo', dash._undoBar));
check(!!store.getQuest(q2.id) && !dash._undoBar.visible, 'Undo brings the quest back');
store.deleteQuest(store.visibleQuests('q4')[0].id);
dash.showPage('matrix');
check(dash._trashLink.visible && text(dash._trashLink).includes('Recently deleted · 1'), 'a deleted quest shows "Recently deleted" under the matrix');
click(dash._trashLink);
check(dash._page === 'trash' && btn('Restore', dash._pages.trash), 'it opens the Recently deleted page with Restore');

// ---- remember the page on a quick reopen
dash.openQuest(q1.id);
dash.onClose();
dash.onOpen();
check(dash._page === 'detail' && dash._detailId === q1.id, 'reopening within 2 minutes keeps the open quest');
dash.onClose();
dash._closedAt -= 3 * 60000;
dash.onOpen();
check(dash._page === 'matrix', 'after longer, it starts at the Matrix again');

// ---- timers
dash.showPage('timers');
const tl = dash._pages.timers;
const tText = text(tl);
check(tText.indexOf('Focus') < tText.indexOf('Start a timer'), 'running timer comes first, presets after it');
check(!dash._newTimerBox.visible && btn('Custom timer', tl), 'custom form folded behind "+ Custom timer" when presets exist');
shot('5-timers');
click(btn('Custom timer', tl));
check(dash._newTimerBox.visible, '"+ Custom timer" opens the form');
click(btn('+5', tl));
check(ints['pomodoro-minutes'] === 25 && text(dash._newTimerBox).includes('30 min'), '+5 changes only the next timer, not the default in Settings');
shot('5b-timers-form');
click(btn('Edit presets', tl));
check(buttons(tl).filter(b => b.style_class.includes('qb-danger')).length === 3, 'preset editing uses icon buttons');
click(btn('Done', tl));

// ---- progress: deadline chip → goal; date field; delete goal with undo
click(byClass('qb-deadline')[1]);
check(dash._page === 'progress' && dash.progressPage._goals._open.has(gFKP.id), 'a deadline chip opens its goal on the Progress page');
const pg = dash._pages.progress;
const pText = text(pg);
check(pText.indexOf('Focus, last 7 days') === -1 || pText.indexOf('This week') < pText.indexOf('Goals'), 'Progress: this week first, then goals');
check(pText.indexOf('Stats Week 30 days All time') > pText.indexOf('Goals'), 'range buttons sit with the totals they change');
shot('6-progress');
const goalCard = byClass('qb-goal', pg).find(c => text(c).includes('Festkörperphysik'));
const gDate = entries(goalCard).find(e => e.style_class.includes('qb-date'));
gDate.type('20.1.2027');
check(store.getGoal(gFKP.id).targetDate === '2027-01-20', 'goal deadline can be an exact date (20.1.2027)');
const card2 = byClass('qb-goal', dash._pages.progress).find(c => text(c).includes('Festkörperphysik'));
click(btn('Delete goal', card2));
check(!store.getGoal(gFKP.id) && dash._undoBar.visible, 'goal delete shows Undo');
click(btn('Undo', dash._undoBar));
check(store.getGoal(gFKP.id)?.targetDate === '2027-01-20' && store.getQuest(q2.id).goalId === gFKP.id, 'Undo restores the goal, its date and its links');
const qmCard = byClass('qb-goal', dash._pages.progress).find(c => text(c).includes('QM 1'));
if (qmCard && !dash.progressPage._goals._open.has(gQM.id))
    click(buttons(qmCard).find(b => b.style_class === 'qb-quest-title-btn' && text(b).includes('QM 1')));
check(text(dash._pages.progress).includes('3 reviews due'), 'the QM course quest in its goal shows the reviews due');
shot('6b-progress-goal');

// ---- habits / shop delete with undo
dash.showPage('habits');
click(buttons(dash._pages.habits).find(b => text(b) === 'Sport'));
click(btn('Delete habit', dash._pages.habits));
check(!store.habits().some(h => h.title === 'Sport') && text(dash._undoBar).includes('Sport'), 'habit delete shows Undo');
click(btn('Undo', dash._undoBar));
check(store.habits().some(h => h.title === 'Sport'), 'Undo brings the habit back');
shot('7-habits');
dash.showPage('shop');
click(buttons(dash._pages.shop).find(b => text(b) === 'Kino'));
const cost = entries(dash._pages.shop).find(e => e.hint_text === 'Cost');
cost.type('250', false);
click(btn('Done', dash._pages.shop));
check(store.rewards().find(r => r.title === 'Kino')?.cost === 250, 'reward cost typed without Enter is saved on Done');
shot('8-shop');

// ---- undo bar times out
click(buttons(dash._pages.shop).find(b => text(b) === 'Kino'));
click(btn('Delete reward', dash._pages.shop));
check(dash._undoBar.visible, 'reward delete shows Undo');
G.runTimers(6000);
check(!dash._undoBar.visible && !store.rewards().some(r => r.title === 'Kino'), 'the Undo bar goes away by itself; the delete stays');

// ---- typed dates (store.parseDueDate, shared with the phone's rules)
const ref = new Date(2026, 10, 18);
const pd = t => parseDueDate(t, ref);
check(pd('15.1.') === '2027-01-15' && pd('20.12.') === '2026-12-20', 'dates: day.month. → the next such day');
check(pd('15.1.2027') === '2027-01-15' && pd('15.01.27') === '2027-01-15' && pd('2027-01-15') === '2027-01-15' && pd('+3') === '2026-11-21', 'dates: full dates and +N');
check(pd('31.2.') === null && pd('hello') === null && pd('') === null, 'dates: nonsense is rejected');

check(errors.length === 0, `no errors from any handler${errors.length ? `:\n${errors.slice(0, 5).join('\n')}` : ''}`);
dash.destroy();
store.destroy?.();
fs.rmSync(process.env.QB_DIR, {recursive: true, force: true});
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
