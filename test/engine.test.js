import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as E from '../js/engine.js';
import { parseGarminCsv, mergeGarmin, toSeconds } from '../js/garmin.js';

const program = JSON.parse(readFileSync(new URL('../program/program.json', import.meta.url)));
const fresh = () => ({ settings: {}, days: {}, weeks: {}, bodyweight: [], garmin: [] });
const MON = '2026-11-09'; // program start, a Monday
const planIds = (state, ws) => E.getWeek(program, state, ws).plan.map((p) => E.plannedSessionId(program, p));

test('program file is internally consistent', () => {
  for (const b of program.blocks) {
    for (const d of E.DAYS) assert.ok(program.sessions[b.template[d]], `template ${d}`);
  }
  for (const [id, s] of Object.entries(program.sessions)) {
    if (s.lightAlt) assert.ok(program.sessions[s.lightAlt], `${id} lightAlt`);
    const all = [s.parts, ...Object.values(s.variants || {})].flat();
    for (const p of all) {
      if (p.kind === 'routine') assert.ok(program.routines[p.routine], `${id} routine`);
      if (p.kind === 'work' && !p.byWeek) assert.ok(Array.isArray(p.lines), `${id} lines`);
      for (const v of p.byWeek || []) assert.ok(Array.isArray(v.lines), `${id} byWeek lines`);
      for (const it of p.items || []) {
        assert.ok(program.exercises[it.ex], `${id} exercise ${it.ex}`);
        assert.ok(program.progressions[it.prog], `${id} progression ${it.prog}`);
      }
    }
  }
  const morning = program.routines.morning.steps.reduce((n, s) => n + s.seconds * (s.perSide ? 2 : 1), 0);
  assert.equal(morning, 600, 'morning routine is 10 minutes');
});

test('dates and program position', () => {
  assert.equal(E.dayIndex('2026-11-12'), 3); // Thursday
  assert.equal(E.mondayOf('2026-11-12'), MON);
  const s = fresh();
  assert.equal(E.position(program, s, '2026-11-12').weekIdx, 0);
  assert.equal(E.position(program, s, '2026-11-30').week.label, 'Deload');
  const after = E.position(program, s, '2026-12-08');
  assert.equal(after.finished, true);
  assert.equal(after.weekIdx, 0);
});

test('default week needs no adjustment', () => {
  const s = fresh();
  E.recompute(program, s, MON, MON);
  assert.deepEqual(planIds(s, MON), ['run-speed', 'team-lift', 'upper-mixed', 'swim-recovery', 'team-lift', 'athlete-day', 'recovery-easy']);
});

test('swap that does not cover the session slides it to the next recovery day', () => {
  const s = fresh();
  // Wednesday: hockey instead of the upper session
  const msgs = E.logSwap(program, s, '2026-11-11', { activityId: 'hockey', intensity: 'moderate' }, '2026-11-11');
  assert.equal(planIds(s, MON)[3], 'upper-mixed');
  assert.match(msgs.join(' '), /moved to Thursday/);
  E.removeSwap(program, s, '2026-11-11', '2026-11-11');
  assert.equal(planIds(s, MON)[3], 'swim-recovery');
  assert.equal(s.days['2026-11-11'].swap, undefined);
});

test('swap that covers the session does not reschedule it', () => {
  const s = fresh();
  const msgs = E.logSwap(program, s, MON, { activityId: 'run', intensity: 'hard' }, MON);
  assert.match(msgs.join(' '), /counts as/);
  assert.equal(planIds(s, MON)[3], 'swim-recovery');
});

test('hard leg day before the run turns intervals into an easy run', () => {
  const s = fresh();
  // Sunday before week 2: hard hockey. Monday of week 2 is speed work.
  E.logSwap(program, s, '2026-11-15', { activityId: 'hockey', intensity: 'hard' }, '2026-11-15');
  assert.equal(planIds(s, '2026-11-16')[0], 'run-easy');
});

test('ran hard on a recovery day: next day leg session adjusts only if both are hard', () => {
  const s = fresh();
  // Thursday hard run, Friday is the fixed team lift (never changed)
  E.logSwap(program, s, '2026-11-12', { activityId: 'run', intensity: 'hard' }, '2026-11-12');
  assert.equal(planIds(s, MON)[4], 'team-lift');
  assert.equal(planIds(s, MON)[5], 'athlete-day');
});

test('too many hard days lightens the lowest-priority session', () => {
  const s = fresh();
  // Monday to Wednesday done as planned (3 hard days), then Thursday (recovery)
  // becomes a hard workout: with Friday and Saturday that would be 6 hard days.
  const ids = ['run-speed', 'team-lift', 'upper-mixed'];
  ids.forEach((sessionId, i) => { s.days[E.addDays(MON, i)] = { session: { sessionId, done: true, parts: {} } }; });
  E.logSwap(program, s, '2026-11-12', { activityId: 'workout-upper', intensity: 'hard' }, '2026-11-12');
  assert.equal(planIds(s, MON)[5], 'athlete-light');
});

test('moving sessions trades two days', () => {
  const s = fresh();
  E.moveSession(program, s, MON, 1, 2, MON); // team lift to Wednesday
  assert.equal(planIds(s, MON)[1], 'upper-mixed');
  assert.equal(planIds(s, MON)[2], 'team-lift');
});

test('weight suggestions', () => {
  const s = fresh();
  const rx1 = program.progressions.main[0];
  assert.equal(E.suggestWeight(program, s, 'bench-press', rx1, MON).weight, 195);
  assert.equal(E.suggestWeight(program, s, 'weighted-pull-up', rx1, MON).weight, 20);
  assert.equal(E.suggestWeight(program, s, 'box-jump', program.progressions.power[0], MON), null);
  assert.equal(E.suggestWeight(program, s, 'suitcase-carry', program.progressions.carry[0], MON).weight, 70);
  // Log week 1 as prescribed; week 2 (RPE 7) should go up, deload should come down.
  s.days['2026-11-11'] = { session: { sessionId: 'upper-mixed', done: true, parts: { 1: { items: { 0: { key: 'bench-press', name: 'Bench press', sets: [{ w: 195, r: 5, rpe: 6, done: true }] } } } } } };
  const w2 = E.suggestWeight(program, s, 'bench-press', program.progressions.main[1], '2026-11-18').weight;
  const deload = E.suggestWeight(program, s, 'bench-press', program.progressions.main[3], '2026-11-18').weight;
  assert.ok(w2 > 195 && w2 <= 210, `week 2 ${w2}`);
  assert.ok(deload < 195, `deload ${deload}`);
  assert.equal(E.e1rmSeries(program, s, 'bench-press').length, 1);
  // A substitute is suggested from its own history only.
  assert.equal(E.suggestWeight(program, s, 'sub:DB bench press', rx1, MON), null);
});

test('resolveParts picks the week and the variant', () => {
  const p = E.resolveParts(program, 'run-speed', 'gym', 2);
  assert.match(p[2].lines[0], /8 x 400/);
  assert.equal(E.resolveParts(program, 'upper-mixed', 'bodyweight', 0).length, 1);
});

test('garmin csv import', () => {
  const csv = 'Activity Type,Date,Favorite,Title,Distance,Calories,Time,Avg HR,Max HR,Avg Pace\n'
    + 'Running,2026-11-08 07:10:11,false,"Cambridge, Running",3.02,380,00:25:40,152,171,8:30\n'
    + 'Lap Swimming,2026-11-07 18:00:00,false,Pool Swim,"1,000",200,00:28:00,120,140,2:48\n'
    + 'Cycling,2026-11-06 18:00:00,false,Ride,10,300,00:40:00,120,140,--\n';
  const acts = parseGarminCsv(csv);
  assert.equal(acts.length, 2);
  assert.equal(acts[0].kind, 'run');
  assert.equal(acts[0].seconds, 1540);
  assert.equal(acts[1].distance, 1000);
  const s = fresh();
  assert.equal(mergeGarmin(s, acts), 2);
  assert.equal(mergeGarmin(s, acts), 0);
  assert.equal(toSeconds('1:02:03'), 3723);
  assert.throws(() => parseGarminCsv('a,b\n1,2\n'));
});
