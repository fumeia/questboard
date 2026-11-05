import assert from 'assert';
import {Store, levelInfo, habitXp} from './build/store.js';
const U=process.env.QB_URL, H={Authorization:'Bearer '+process.env.QB_TOKEN,'Content-Type':'application/json'};
process.env.QB_DIR = process.env.T+'/desk'; const desk = new Store();
process.env.QB_DIR = process.env.T+'/phone'; const phone = new Store();
async function sync(s){ const {changes,marks}=s.collectDirty(); const r=await (await fetch(U+'/api/sync',{method:'POST',headers:H,body:JSON.stringify({device:s.deviceId,platform:'test',since:s.cursor,changes})})).json(); s.applyRemote(r.changes,r.cursor,marks); return r; }
assert.equal(desk.rewards().length, 7);
const q = desk.addQuest('Ship v2','q1');
desk.setDone(q.id,true); assert.equal(desk.xp,30); assert.equal(desk.balance,30);
const h = desk.addHabit('Read','book',10,7);
desk.toggleCheckin(h.id); assert.equal(desk.xp,40); assert.equal(desk.streak(),1);
// yesterday + day before → 3-day streak bonus applies to today's re-check
desk.toggleCheckin(h.id); assert.equal(desk.xp,30);
const y=new Date();y.setDate(y.getDate()-1); const y2=new Date();y2.setDate(y2.getDate()-2);
const k=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
desk.toggleCheckin(h.id,k(y2)); desk.toggleCheckin(h.id,k(y)); desk.toggleCheckin(h.id);
assert.equal(desk.habitStreak(h.id),3); assert.equal(desk.xp, 30+10+10+12);
// timer → session → quest time
const q2 = desk.addQuest('Focus thing','q2'); desk.toggleQuestTimer(q2.id); desk.runningTimers()[0].startedAt -= 600000; desk.toggleQuestTimer(q2.id);
assert(Math.abs(desk.questTimeMs(q2)-600000)<100);
await sync(desk); await sync(phone);
assert.equal(phone.xp, desk.xp, 'phone sees same XP'); assert.equal(phone.habits().length,1);
assert(Math.abs(phone.questTimeMs(phone.getQuest(q2.id))-600000)<100, 'session synced');
assert.equal(phone.rewards().length, 7, 'default rewards not duplicated');
// buy on phone, refund semantics, concurrent edits
const bal = phone.balance; assert(phone.buy('reward.coffee')); assert.equal(phone.balance, bal-60);
assert(!phone.buy('reward.purchase'), 'cannot afford');
phone.updateQuest(q2.id,{title:'Phone title'});
await new Promise(r=>setTimeout(r,5));
desk.updateQuest(q2.id,{title:'Desk title (newer)'});
await sync(phone); await sync(desk); await sync(phone);
assert.equal(desk.getQuest(q2.id).title,'Desk title (newer)'); assert.equal(phone.getQuest(q2.id).title,'Desk title (newer)');
assert.equal(desk.balance, phone.balance); assert.equal(desk.dirtyCount(),0); assert.equal(phone.dirtyCount(),0);
// delete propagates
phone.deleteQuest(q.id); await sync(phone); await sync(desk); assert.equal(desk.getQuest(q.id), null);
assert.equal(desk.xp, phone.xp, 'xp kept after delete');
// groups: steps pay STEP_XP, finishing all steps completes the quest with a bonus
const g = desk.addQuest('Uni sheet 5', 'q1');
desk.addStep(g.id, 'Exercise 1'); desk.addStep(g.id, 'Exercise 2'); desk.addStep(g.id, 'Exercise 3');
const steps = desk.getQuest(g.id).steps; const xp0 = desk.xp;
desk.toggleStep(g.id, steps[0].id); desk.toggleStep(g.id, steps[1].id);
assert.equal(desk.xp, xp0 + 20); assert(!desk.getQuest(g.id).done);
desk.toggleStep(g.id, steps[2].id);
assert(desk.getQuest(g.id).done, 'last step completes the group');
assert.equal(desk.xp, xp0 + 30 + 30 + 15, 'steps + quest XP + 50% bonus');
desk.toggleStep(g.id, steps[2].id);
assert(!desk.getQuest(g.id).done); assert.equal(desk.xp, xp0 + 20, 'unticking a step reopens + removes quest XP');
desk.setDone(g.id, true);
assert.equal(desk.xp, xp0 + 30 + 30 + 15, 'ticking the group ticks the rest');
await sync(desk); await sync(phone); assert.equal(phone.getQuest(g.id).steps.length, 3); assert.equal(phone.xp, desk.xp);
// topics & stats: session time goes to the quest's topic
const tq = desk.addQuest('Read chapter 3', 'q2'); desk.updateQuest(tq.id, {topic: 'Analysis II'});
desk.toggleQuestTimer(tq.id); desk.runningTimers()[0].startedAt -= 30 * 60000; desk.toggleQuestTimer(tq.id);
const st = desk.stats(7);
assert(st.byTopic.find(t => t.topic === 'Analysis II').ms >= 30 * 60000 - 100, 'topic time');
assert(desk.topics().includes('Analysis II'));
assert.equal(st.daily.length, 7);
// goals: quests + single steps link to a long-term goal; progress, time and XP
const goal = desk.addGoal('Pass the semester');
const gq = desk.addQuest('Exam prep', 'q2', null, {goalId: goal.id});
const other = desk.addQuest('Sheet 6', 'q1'); desk.addStep(other.id, 'Ex 1'); desk.addStep(other.id, 'Ex 2');
const [s1, s2] = desk.getQuest(other.id).steps;
desk.setStepGoal(other.id, s1.id, goal.id);
let gi = desk.goalItems(goal.id); assert.equal(gi.quests.length, 1); assert.equal(gi.steps.length, 1);
assert.equal(desk.goalProgress(goal.id).total, 2); assert.equal(desk.goalProgress(goal.id).done, 0);
// step pomodoro: its own timer, time lands on the step, the quest and the goal
const pt = desk.toggleStepPomodoro(other.id, s1.id, 25);
assert.equal(pt.stepId, s1.id); assert.equal(pt.label, 'Sheet 6 › Ex 1'); assert(desk.isStepRunning(other.id, s1.id));
assert(!desk.isStepRunning(other.id, s2.id));
desk.runningTimers()[0].startedAt -= 25 * 60000; const xpP = desk.xp; desk.tick();
assert.equal(desk.xp, xpP + 10, 'step pomodoro pays');
assert(Math.abs(desk.stepTimeMs(other.id, s1.id) - 25 * 60000) < 100, 'step time');
assert.equal(desk.stepTimeMs(other.id, s2.id), 0);
assert(Math.abs(desk.questTimeMs(desk.getQuest(other.id)) - 25 * 60000) < 100, 'counts for the quest too');
assert(Math.abs(desk.goalProgress(goal.id).ms - 25 * 60000) < 100, 'and for the goal');
desk.toggleStep(other.id, s1.id); desk.setDone(gq.id, true);
assert.equal(desk.goalProgress(goal.id).done, 2); assert.equal(desk.goalProgress(goal.id).frac, 1);
const sg = desk.stats(7).byGoal; assert.equal(sg.length, 1); assert(Math.abs(sg[0].ms - 25 * 60000) < 100, 'time per goal in stats');
const xpG = desk.xp; desk.setGoalDone(goal.id, true); assert.equal(desk.xp, xpG + 100, 'goal XP');
await sync(desk); await sync(phone);
assert.equal(phone.goals().length, 1, 'goal synced'); assert.equal(phone.goalProgress(goal.id).total, 2);
assert(Math.abs(phone.stepTimeMs(other.id, s1.id) - 25 * 60000) < 100, 'step session synced');
assert.equal(phone.xp, desk.xp);
phone.setGoalDone(goal.id, false); await sync(phone); await sync(desk); assert.equal(desk.xp, xpG, 'un-achieving refunds');
desk.deleteGoal(goal.id); assert.equal(desk.goals().length, 0); assert.equal(desk.goalProgress(goal.id).total, 2, 'links kept, harmless');
// deleting a step detaches its timer but keeps it on the quest
desk.toggleStepPomodoro(other.id, s2.id, 25); desk.deleteStep(other.id, s2.id);
assert.equal(desk.runningTimers()[0].stepId, null); assert.equal(desk.runningTimers()[0].questId, other.id);
desk.removeTimer(desk.runningTimers()[0].id);
// pomodoros show up in the calendar: running → until planned end, then as the session
const fq = desk.addQuest('Calendar focus', 'q1'); const ft = desk.startPomodoro(fq.id, 25);
let fb = desk.focusBlocks().filter(b => b.id === ft.id); assert.equal(fb.length, 1); assert(fb[0].live);
assert.equal(fb[0].end - fb[0].start, 25 * 60000, 'live block runs to the planned end');
ft.startedAt -= 25 * 60000; desk.tick();
fb = desk.focusBlocks().filter(b => b.questId === fq.id); assert.equal(fb.length, 1); assert(!fb[0].live);
assert.equal(fb[0].title, 'Calendar focus'); assert(Math.abs(fb[0].end - fb[0].start - 25 * 60000) < 100);
await sync(desk); await sync(phone); assert(phone.focusBlocks().some(b => b.questId === fq.id), 'focus block synced');
// ticking a quest that had a time slot counts the slot (minus timer time inside it) for quest + goal
{
    const now = Date.now(); const s0 = new Date(now - 2 * 3600000); s0.setSeconds(0, 0);
    const sg2 = desk.addGoal('Slot goal');
    const sq = desk.addQuest('Lecture', 'q2', {date: k(s0), start: s0.getHours() * 60 + s0.getMinutes(), duration: 60}, {goalId: sg2.id});
    desk.toggleQuestTimer(sq.id); desk.runningTimers()[0].startedAt = s0.getTime() + 40 * 60000; desk.toggleQuestTimer(sq.id);
    const before = desk.questTimeMs(desk.getQuest(sq.id));
    desk.setDone(sq.id, true);
    const added = desk.questTimeMs(desk.getQuest(sq.id)) - before;
    assert(Math.abs(added - 40 * 60000) < 1000, `slot adds only the untracked part (${added})`);
    assert(Math.abs(desk.goalProgress(sg2.id).ms - desk.questTimeMs(desk.getQuest(sq.id))) < 1000, 'goal gets it too');
    await sync(desk); await sync(phone);
    assert(Math.abs(phone.questTimeMs(phone.getQuest(sq.id)) - desk.questTimeMs(desk.getQuest(sq.id))) < 1000, 'slot time synced');
    phone.setDone(sq.id, false); assert(Math.abs(phone.questTimeMs(phone.getQuest(sq.id)) - before) < 1000, 'unticking removes it');
    const fut = desk.addQuest('Tomorrow thing', 'q1', {date: k(new Date(now + 86400000)), start: 600, duration: 60});
    desk.setDone(fut.id, true); assert.equal(desk.questTimeMs(desk.getQuest(fut.id)), 0, 'future slot not counted');
}
// Physics RPG bridge (physics-rpg/deploy/questboard_sync.py): quests + ledger kind "rpg" pushed by the server
const xpR = phone.xp, noon = new Date(); noon.setHours(12, 0, 0, 0); const now = Date.now();
await fetch(U+'/api/sync',{method:'POST',headers:H,body:JSON.stringify({device:'physics-rpg',platform:'physics-rpg',since:2**53,changes:[
  {c:'quests',r:{id:'rpg.qm',updatedAt:now,title:'Physics RPG · Quantenmechanik',quadrant:'q2',done:false,createdAt:now,topic:'Quantenmechanik',source:'physics-rpg',link:'https://rpg.example.com'}},
  {c:'ledger',r:{id:`rpg.qm.${k(noon)}`,updatedAt:now,at:noon.getTime(),amount:75,kind:'rpg',ref:'rpg.qm',note:'Physics RPG · Quantenmechanik'}}]})});
await sync(phone); assert.equal(phone.xp, xpR + 75, 'game XP counts in Questboard');
assert.equal(phone.getQuest('rpg.qm').topic, 'Quantenmechanik'); assert(phone.topics().includes('Quantenmechanik'));
process.env.QB_DIR = process.env.T+'/rpgonly'; const only = new Store();
only.applyRemote([{c:'ledger',r:{id:`rpg.qm.${k(noon)}`,updatedAt:now,at:noon.getTime(),amount:75,kind:'rpg'}}], 1, {});
assert.equal(only.xp, 75); assert.equal(only.streak(), 1, 'a day with only game XP counts for the streak');
// goal deadlines, pace and the weekly review
{
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const dl = desk.addGoal('Deadline goal'); desk.updateGoal(dl.id, {targetDate: fmt(new Date(Date.now() + 10 * 86400000))});
    const p1 = desk.goalPace(dl.id); assert.equal(p1.daysLeft, 10, 'days left'); assert(p1.onTrack, 'fresh goal is on track');
    const past = desk.addGoal('Missed goal'); desk.updateGoal(past.id, {targetDate: fmt(new Date(Date.now() - 3 * 86400000))});
    const p2 = desk.goalPace(past.id); assert(p2.daysLeft <= 0, 'overdue'); assert(!p2.onTrack, 'overdue and not done → off track');
    assert.equal(desk.goalPace(desk.addGoal('No deadline').id), null);
    desk.setGoalDone(past.id, true); assert(desk.goalPace(past.id).onTrack, 'reached goals stay on track');
    const wr = desk.weekReview();
    assert(wr.focusThis >= 25 * 60000, 'focus this week counts today'); assert(wr.questsThis >= 1, 'quests this week');
    assert(wr.goalsReached >= 1, 'goal reached this week'); assert.equal(typeof wr.streak, 'number');
    const ex = desk.startPomodoro(null, 1); desk.extendTimer(ex.id, 5 * 60000);
    assert.equal(desk.getTimer(ex.id).durationMs, 6 * 60000, 'extend adds to the countdown');
    desk.removeTimer(ex.id);
}
console.log('level', levelInfo(desk.xp), 'balance', desk.balance, '\nALL SYNC TESTS PASSED');
