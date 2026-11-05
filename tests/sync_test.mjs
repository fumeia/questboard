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
console.log('level', levelInfo(desk.xp), 'balance', desk.balance, '\nALL SYNC TESTS PASSED');
