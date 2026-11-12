// Pure scheduling logic. No DOM, no storage: everything takes (program, state).
// Tested by test/engine.test.js.

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// ---------- dates (local time, keys are YYYY-MM-DD) ----------
export function dkey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function parseKey(k) {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}
export function addDays(k, n) {
  const d = parseKey(k);
  d.setDate(d.getDate() + n);
  return dkey(d);
}
export function dayIndex(k) {
  return (parseKey(k).getDay() + 6) % 7; // Monday = 0
}
export function mondayOf(k) {
  return addDays(k, -dayIndex(k));
}
function daysBetween(a, b) {
  return Math.round((parseKey(b) - parseKey(a)) / 86400000);
}

// ---------- where a date falls in the program ----------
export function position(program, state, dateKey) {
  const start = mondayOf(state.settings?.startDate || program.meta.startDate);
  const weekStart = mondayOf(dateKey);
  let w = Math.max(0, Math.floor(daysBetween(start, weekStart) / 7));
  const total = program.blocks.reduce((n, b) => n + b.weeks.length, 0);
  const finished = w >= total;
  let blockIdx = 0;
  if (finished) {
    // Past the end: keep repeating the last block until a new one is written.
    blockIdx = program.blocks.length - 1;
    const before = total - program.blocks[blockIdx].weeks.length;
    w = (w - before) % program.blocks[blockIdx].weeks.length;
  } else {
    while (w >= program.blocks[blockIdx].weeks.length) {
      w -= program.blocks[blockIdx].weeks.length;
      blockIdx++;
    }
  }
  const block = program.blocks[blockIdx];
  return { block, blockIdx, weekIdx: w, week: block.weeks[w], finished, weekStart, dayIdx: dayIndex(dateKey) };
}

// ---------- the week plan ----------
// state.weeks[weekStart] = { plan: [{ base, light, note }] x 7, notes: [] }
export function getWeek(program, state, weekStart) {
  state.weeks ||= {};
  let wk = state.weeks[weekStart];
  const { block } = position(program, state, weekStart);
  if (!wk) {
    wk = { plan: DAYS.map((d) => ({ base: block.template[d], light: false })), notes: [] };
    state.weeks[weekStart] = wk;
  }
  // If the program file was rewritten and a session no longer exists, fall back to the template.
  wk.plan.forEach((p, i) => {
    if (!program.sessions[p.base]) p.base = block.template[DAYS[i]];
  });
  return wk;
}

export function plannedSessionId(program, entry) {
  const s = program.sessions[entry.base];
  return entry.light && s.lightAlt ? s.lightAlt : entry.base;
}

export function dayRecord(state, dateKey) {
  state.days ||= {};
  return (state.days[dateKey] ||= {});
}

function isLocked(state, dateKey) {
  const d = state.days?.[dateKey];
  return !!(d && (d.swap || d.session?.done));
}

const ZERO = { legs: 0, upper: 0, intensity: 0 };

// What a day cost (or will cost) the body.
export function dayLoad(program, state, dateKey, todayKey) {
  const d = state.days?.[dateKey];
  if (d?.swap) return d.swap.load;
  const wk = getWeek(program, state, mondayOf(dateKey));
  const sid = d?.session?.done ? d.session.sessionId : plannedSessionId(program, wk.plan[dayIndex(dateKey)]);
  if (d?.session?.done) return program.sessions[sid]?.load || ZERO;
  if (dateKey < todayKey) return ZERO; // past and never logged: treated as missed
  return program.sessions[sid].load;
}

// Re-derive every "light" flag for days that can still change.
export function recompute(program, state, weekStart, todayKey) {
  const R = program.rules;
  const wk = getWeek(program, state, weekStart);
  const open = (i) => {
    const k = addDays(weekStart, i);
    return k >= todayKey && !isLocked(state, k) && !program.sessions[wk.plan[i].base].fixed;
  };
  for (let i = 0; i < 7; i++) if (open(i)) { wk.plan[i].light = false; delete wk.plan[i].note; }

  // Rule 1: no two hard leg days back to back.
  for (let i = 0; i < 7; i++) {
    if (!open(i)) continue;
    const s = program.sessions[wk.plan[i].base];
    if (!s.lightAlt) continue;
    const y = dayLoad(program, state, addDays(weekStart, i - 1), todayKey);
    if (y.legs + s.load.legs >= R.backToBackLegLimit) {
      wk.plan[i].light = true;
      wk.plan[i].note = 'Lightened: hard leg day the day before.';
    }
  }

  // Rule 2: cap the number of hard days in the week.
  const hardDays = () => DAYS.filter((_, i) => dayLoad(program, state, addDays(weekStart, i), todayKey).intensity >= R.hardIntensity).length;
  let guard = 7;
  while (hardDays() > R.maxHardDaysPerWeek && guard--) {
    const candidates = DAYS.map((_, i) => i)
      .filter((i) => open(i) && !wk.plan[i].light && program.sessions[wk.plan[i].base].lightAlt
        && program.sessions[wk.plan[i].base].load.intensity >= R.hardIntensity)
      .sort((a, b) => (program.sessions[wk.plan[b].base].priority || 9) - (program.sessions[wk.plan[a].base].priority || 9));
    if (!candidates.length) break;
    const i = candidates[0];
    wk.plan[i].light = true;
    wk.plan[i].note = `Lightened: already ${R.maxHardDaysPerWeek} hard days this week.`;
  }
  return wk;
}

// Log "I did something else" and rebalance the rest of the week.
// swap = { activityId, intensity: 'easy'|'moderate'|'hard', minutes, notes }
export function logSwap(program, state, dateKey, swap, todayKey) {
  const weekStart = mondayOf(dateKey);
  const wk = getWeek(program, state, weekStart);
  const i = dayIndex(dateKey);
  const act = program.swapActivities.find((a) => a.id === swap.activityId);
  const day = dayRecord(state, dateKey);
  const displacedId = wk.plan[i].base;
  const displaced = program.sessions[displacedId];
  const covers = swap.intensity === 'easy' ? [] : act.covers;
  const messages = [];

  day.swap = {
    ...swap,
    name: act.name,
    load: act.load[swap.intensity],
    replaced: displacedId,
    prevPlan: JSON.parse(JSON.stringify(wk.plan)),
  };

  const isRecovery = program.rules.slideIntoStimulus.includes(displaced.stimulus);
  if (displaced.fixed || isRecovery) {
    // nothing to reschedule
  } else if (covers.includes(displaced.stimulus)) {
    messages.push(`${act.name} counts as your "${displaced.name}" session.`);
  } else {
    // Slide the missed session into the next recovery slot this week.
    let moved = false;
    for (let j = i + 1; j < 7; j++) {
      const k = addDays(weekStart, j);
      const target = program.sessions[wk.plan[j].base];
      if (k < todayKey || isLocked(state, k)) continue;
      if (!program.rules.slideIntoStimulus.includes(target.stimulus)) continue;
      wk.plan[j] = { base: displacedId, light: false };
      messages.push(`"${displaced.name}" moved to ${DAY_NAMES[j]} (replaces "${target.name}").`);
      moved = true;
      break;
    }
    if (!moved) messages.push(`No open day left for "${displaced.name}", so it is dropped this week.`);
  }

  recompute(program, state, weekStart, todayKey);
  // Sunday's load carries into next Monday.
  if (i === 6) recompute(program, state, addDays(weekStart, 7), todayKey);
  wk.plan.forEach((p, j) => {
    if (p.note && addDays(weekStart, j) > dateKey) messages.push(`${DAY_NAMES[j]}: ${p.note}`);
  });
  day.swap.messages = messages;
  return messages;
}

export function removeSwap(program, state, dateKey, todayKey) {
  const day = state.days?.[dateKey];
  if (!day?.swap) return;
  const weekStart = mondayOf(dateKey);
  const wk = getWeek(program, state, weekStart);
  // Restore the plan, but keep anything already logged where it is.
  day.swap.prevPlan.forEach((p, j) => {
    if (!isLocked(state, addDays(weekStart, j)) || j === dayIndex(dateKey)) wk.plan[j] = p;
  });
  delete day.swap;
  recompute(program, state, weekStart, todayKey);
}

export function moveSession(program, state, weekStart, i, j, todayKey) {
  const wk = getWeek(program, state, weekStart);
  [wk.plan[i], wk.plan[j]] = [{ base: wk.plan[j].base, light: false }, { base: wk.plan[i].base, light: false }];
  recompute(program, state, weekStart, todayKey);
}

// Call after finishing a session so tomorrow reflects what actually happened.
export function afterFinish(program, state, dateKey, todayKey) {
  const weekStart = mondayOf(dateKey);
  recompute(program, state, weekStart, todayKey);
  if (dayIndex(dateKey) === 6) recompute(program, state, addDays(weekStart, 7), todayKey);
}

// ---------- sessions ----------
export function resolveParts(program, sessionId, variant, weekIdx) {
  const s = program.sessions[sessionId];
  const parts = (variant && variant !== 'gym' && s.variants?.[variant]) || s.parts;
  return parts.map((p) => {
    if (!p.byWeek) return p;
    const v = p.byWeek[Math.min(weekIdx, p.byWeek.length - 1)];
    return { ...p, ...v, title: v.name ? `${p.title}: ${v.name}` : p.title };
  });
}

export function prescription(program, item, weekIdx) {
  const prog = program.progressions[item.prog] || [{ sets: 3, reps: 8 }];
  return prog[Math.min(weekIdx, prog.length - 1)];
}

// ---------- load suggestions ----------
// RPE-adjusted Epley: reps in reserve count as reps.
export function e1rm(weight, reps, rpe) {
  const r = Number(reps) + (10 - (rpe ? Number(rpe) : 8));
  return weight * (1 + r / 30);
}
function weightFor(oneRm, reps, rpe) {
  return oneRm / (1 + (Number(reps) + (10 - (rpe || 8))) / 30);
}
export function currentBodyweight(program, state) {
  const bw = state.bodyweight || [];
  return bw.length ? bw[bw.length - 1].lb : program.athlete.bodyweightLb;
}

// Every logged set for an exercise key, oldest first.
export function setHistory(state, exKey) {
  const out = [];
  for (const date of Object.keys(state.days || {}).sort()) {
    const parts = state.days[date].session?.parts || {};
    for (const p of Object.values(parts)) {
      for (const it of Object.values(p.items || {})) {
        if (it.key !== exKey) continue;
        for (const s of it.sets || []) {
          if (s.done && s.w !== '' && s.w != null && s.r) out.push({ date, w: Number(s.w), r: Number(s.r), rpe: s.rpe ? Number(s.rpe) : null });
        }
      }
    }
  }
  return out;
}

// Best estimated 1RM per day, for charts.
export function e1rmSeries(program, state, exId) {
  const ex = program.exercises[exId];
  const bw = ex.bodyweightPlus ? currentBodyweight(program, state) : 0;
  const byDate = {};
  for (const s of setHistory(state, exId)) {
    const v = e1rm(s.w + bw, s.r, s.rpe) - bw;
    byDate[s.date] = Math.max(byDate[s.date] ?? -Infinity, v);
  }
  return Object.entries(byDate).map(([date, value]) => ({ date, value: Math.round(value) }));
}

export function suggestWeight(program, state, exKey, rx, beforeDate) {
  const ex = program.exercises[exKey];
  const hist = setHistory(state, exKey).filter((s) => s.date < beforeDate);
  const last = hist.length ? hist[hist.length - 1] : null;
  if (!ex) return last ? { weight: last.w, basis: `last time ${last.w} x ${last.r}` } : null; // a substitute
  if (ex.noLoad || ex.noSuggest) return null;
  const step = ex.step || 5;
  const round = (w) => Math.max(0, Math.round(w / step) * step);
  if (typeof rx.reps !== 'number') {
    const w = last ? last.w : ex.start;
    return w ? { weight: w, basis: last ? `last time ${last.w}` : 'starting point' } : null;
  }
  const bw = ex.bodyweightPlus ? currentBodyweight(program, state) : 0;
  let oneRm = ex.e1rm;
  let basis = 'starting estimate';
  if (last) {
    const lastDay = hist.filter((s) => s.date === last.date);
    oneRm = Math.max(...lastDay.map((s) => e1rm(s.w + bw, s.r, s.rpe)));
    const top = lastDay.reduce((a, b) => (b.w > a.w ? b : a));
    basis = `last time ${top.w} x ${top.r}${top.rpe ? ' @' + top.rpe : ''}`;
  } else if (!oneRm) {
    return ex.start ? { weight: ex.start, basis: 'starting point' } : null;
  }
  return { weight: round(weightFor(oneRm, rx.reps, rx.rpe) - bw), basis };
}
