// Screens and event handling. Scheduling logic is in engine.js; the plan is program/program.json.
import * as E from './engine.js';
import * as S from './store.js';
import { parseGarminCsv, mergeGarmin, toSeconds } from './garmin.js';
import { lineChart } from './charts.js';

let program;
let state = S.load();
const ui = { tab: 'today', date: null, weekStart: null, sheet: null, moveFrom: null, flash: '' };

const $ = (s) => document.querySelector(s);
const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const todayKey = () => E.dkey(new Date());
const persist = () => { if (!S.save(state)) ui.flash = 'Could not save. Storage may be full: export a backup in Settings.'; };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const niceDate = (k) => { const d = E.parseKey(k); return `${E.DAY_NAMES[E.dayIndex(k)].slice(0, 3)}, ${MONTHS[d.getMonth()]} ${d.getDate()}`; };
const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
const seconds = (t) => (t && !String(t).includes(':') ? Number(t) * 60 || null : toSeconds(t));

const LOG_FIELDS = {
  distance_mi: { label: 'Distance (mi)', mode: 'decimal' },
  distance_yd: { label: 'Total yards', mode: 'numeric' },
  time: { label: 'Time (mm:ss)', mode: 'text' },
  avg_rep: { label: 'Avg rep (m:ss)', mode: 'text' },
  rounds: { label: 'Rounds', mode: 'decimal' },
  continuous_min: { label: 'Nonstop min', mode: 'decimal' },
  rpe: { label: 'RPE 1-10', mode: 'decimal' },
  notes: { label: 'Notes', mode: 'text', wide: true },
};

// ---------- context for one date ----------
function ctx(k) {
  const pos = E.position(program, state, k);
  const wk = E.getWeek(program, state, pos.weekStart);
  const entry = wk.plan[pos.dayIdx];
  const day = state.days[k] || {};
  let sessionId = day.session?.done ? day.session.sessionId : E.plannedSessionId(program, entry);
  if (!program.sessions[sessionId]) sessionId = E.plannedSessionId(program, entry);
  const session = program.sessions[sessionId];
  const rec = day.session && day.session.sessionId === sessionId ? day.session : { parts: {} };
  const variant = session.variants ? rec.variant || 'gym' : 'gym';
  const parts = E.resolveParts(program, sessionId, variant, pos.weekIdx);
  return { k, pos, wk, entry, day, sessionId, session, rec, variant, parts };
}

function sessionRec(k, sessionId) {
  const day = E.dayRecord(state, k);
  if (!day.session || (!day.session.done && day.session.sessionId !== sessionId)) {
    day.session = { sessionId, variant: 'gym', parts: {} };
  }
  return day.session;
}
function partRec(c, pi) {
  const s = sessionRec(c.k, c.sessionId);
  return (s.parts[pi] ||= {});
}
function itemRec(c, pi, ii) {
  const p = partRec(c, pi);
  p.items ||= {};
  const item = c.parts[pi].items[ii];
  return (p.items[ii] ||= { key: item.ex, name: program.exercises[item.ex].name, sets: [] });
}

// ---------- rendering ----------
function render() {
  const view = $('#view');
  view.innerHTML = (ui.flash ? `<div class="flash">${h(ui.flash)}</div>` : '') + ({ today: viewToday, week: viewWeek, progress: viewProgress, settings: viewSettings }[ui.tab])();
  ui.flash = '';
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === ui.tab));
  if (ui.tab === 'progress') mountCharts();
  $('#sheet').innerHTML = ui.sheet ? viewSheet() : '';
  $('#sheet').classList.toggle('open', !!ui.sheet);
}

function routineMinutes(r) {
  return Math.round(r.steps.reduce((n, s) => n + s.seconds * (s.perSide ? 2 : 1), 0) / 60);
}

function viewToday() {
  const c = ctx(ui.date);
  const isToday = ui.date === todayKey();
  const m = program.routines.morning;
  const morningDone = c.day.morning?.done;
  let out = `
    <header class="top">
      <button class="ghost" data-a="day" data-d="-1" aria-label="Previous day">&#8249;</button>
      <div><h1>${isToday ? 'Today' : h(niceDate(ui.date))}</h1>
        <p class="muted small">${isToday ? h(niceDate(ui.date)) + ' · ' : ''}${h(c.pos.block.name)} · Week ${c.pos.weekIdx + 1} of ${c.pos.block.weeks.length} (${h(c.pos.week.label)})</p></div>
      <button class="ghost" data-a="day" data-d="1" aria-label="Next day">&#8250;</button>
    </header>
    ${isToday ? '' : '<button class="link" data-a="gotoday">Back to today</button>'}
    <section class="card ${morningDone ? 'done' : ''}">
      <div class="row"><div><h2>${h(m.name)}</h2><p class="muted small">${routineMinutes(m)} min · ${m.steps.length} moves, guided with timers</p></div>
      <button class="${morningDone ? 'ok' : 'primary'}" data-a="routine" data-r="morning" data-target="morning">${morningDone ? 'Done ✓' : 'Start'}</button></div>
    </section>`;

  if (c.day.swap) {
    const s = c.day.swap;
    out += `<section class="card"><p class="tag">Logged instead of "${h(program.sessions[s.replaced]?.name || '')}"</p>
      <h2>${h(s.name)}</h2>
      <p class="muted">${h(s.intensity)}${s.minutes ? ` · ${h(s.minutes)} min` : ''}${s.notes ? ` · ${h(s.notes)}` : ''}</p>
      ${(s.messages || []).map((x) => `<p class="note">${h(x)}</p>`).join('')}
      <button class="link" data-a="unswap">Undo this swap</button></section>`;
    return out;
  }

  const done = c.rec.done;
  out += `<section class="card ${done ? 'done' : ''}">
    <p class="tag">${h(c.session.minutes)} min${c.entry.light && !done ? ' · adjusted' : ''}</p>
    <h2>${h(c.session.name)}</h2>
    <p class="muted">${h(c.session.why || '')}</p>
    ${c.entry.note && !done ? `<p class="note">${h(c.entry.note)}</p>` : ''}
    ${c.session.variants ? `<div class="chips">${['gym', ...Object.keys(c.session.variants)].map((v) => `<button class="chip ${v === c.variant ? 'on' : ''}" data-a="variant" data-v="${v}">${v === 'gym' ? 'Full gym' : v === 'hotel' ? 'Hotel gym' : 'Bodyweight'}</button>`).join('')}</div>` : ''}
  </section>`;

  c.parts.forEach((p, pi) => { out += viewPart(c, p, pi); });

  out += `<section class="card">
    ${done ? `<h2>Session finished ✓</h2><p class="muted">RPE ${h(c.rec.rpe || '-')}${c.rec.notes ? ' · ' + h(c.rec.notes) : ''}</p><button class="link" data-a="reopen">Reopen</button>`
    : `<div class="fields"><label>Session RPE 1-10<input inputmode="decimal" data-f="sess" data-k="rpe" value="${h(c.rec.rpe || '')}"></label>
       <label class="wide">Notes (how the back felt, anything off)<input data-f="sess" data-k="notes" value="${h(c.rec.notes || '')}"></label></div>
       <button class="primary big" data-a="finish">Finish session</button>
       <button class="secondary big" data-a="swap">I did something else</button>`}
  </section>`;
  return out;
}

function viewPart(c, p, pi) {
  const pr = c.rec.parts?.[pi] || {};
  if (p.kind === 'routine') {
    const r = program.routines[p.routine];
    return `<section class="card ${pr.done ? 'done' : ''}"><div class="row"><div><h3>${h(p.title)}</h3><p class="muted small">${h(r.name)} · ${routineMinutes(r)} min</p></div>
      <button class="${pr.done ? 'ok' : 'secondary'}" data-a="routine" data-r="${h(p.routine)}" data-target="${pi}">${pr.done ? 'Done ✓' : 'Start'}</button></div></section>`;
  }
  if (p.kind === 'work') {
    return `<section class="card ${pr.done ? 'done' : ''}"><div class="row"><h3>${h(p.title)}</h3>
      <button class="check ${pr.done ? 'on' : ''}" data-a="partdone" data-p="${pi}" aria-label="Mark done">✓</button></div>
      <ul class="lines">${p.lines.map((l) => `<li>${h(l)}</li>`).join('')}</ul>
      ${p.log ? `<div class="fields">${p.log.map((f) => `<label class="${LOG_FIELDS[f].wide ? 'wide' : ''}">${LOG_FIELDS[f].label}<input inputmode="${LOG_FIELDS[f].mode}" data-f="log" data-p="${pi}" data-k="${f}" value="${h(pr.log?.[f] || '')}"></label>`).join('')}</div>` : ''}
    </section>`;
  }
  // strength
  return `<section class="card"><h3>${h(p.title)}</h3>${p.items.map((item, ii) => viewItem(c, item, pi, ii, pr.items?.[ii])).join('')}</section>`;
}

function viewItem(c, item, pi, ii, ir) {
  const ex = program.exercises[item.ex];
  const key = ir?.key || item.ex;
  const subbed = key !== item.ex;
  const rx = E.prescription(program, item, c.pos.weekIdx);
  const sug = E.suggestWeight(program, state, key, rx, c.k);
  const noLoad = !subbed && ex.noLoad;
  const sets = ir?.sets || [];
  const n = Math.max(rx.sets, sets.length);
  let rows = '';
  for (let s = 0; s < n; s++) {
    const v = sets[s] || {};
    rows += `<div class="set ${v.done ? 'on' : ''}"><span class="n">${s + 1}</span>
      ${noLoad ? '<span class="grow"></span>' : `<input inputmode="decimal" placeholder="${sug ? sug.weight : 'lb'}" data-f="set" data-p="${pi}" data-i="${ii}" data-s="${s}" data-k="w" value="${h(v.w ?? '')}" aria-label="Weight"><span class="x">lb</span>`}
      <input inputmode="numeric" placeholder="${typeof rx.reps === 'number' ? rx.reps : 'reps'}" data-f="set" data-p="${pi}" data-i="${ii}" data-s="${s}" data-k="r" value="${h(v.r ?? '')}" aria-label="Reps"><span class="x">reps</span>
      <input inputmode="decimal" placeholder="${rx.rpe || 'RPE'}" data-f="set" data-p="${pi}" data-i="${ii}" data-s="${s}" data-k="rpe" value="${h(v.rpe ?? '')}" aria-label="RPE">
      <button class="check ${v.done ? 'on' : ''}" data-a="setdone" data-p="${pi}" data-i="${ii}" data-s="${s}" aria-label="Set done">✓</button></div>`;
  }
  return `<div class="ex">
    <div class="row"><div><b>${h(ir?.name || ex.name)}</b>${subbed ? ' <span class="tag">substitute</span>' : ''}
      <div class="rx">${rx.sets} × ${h(rx.reps)}${ex.perSide && typeof rx.reps === 'number' ? ' each side' : ''}${rx.rpe ? ` @ RPE ${rx.rpe}` : ''}</div></div>
      <button class="link" data-a="sub" data-p="${pi}" data-i="${ii}">Swap</button></div>
    ${subbed ? '' : `<p class="muted small">${h(ex.cue || '')}</p>`}
    ${sug ? `<p class="small sug">Suggested: ${sug.weight} lb <span class="muted">(${h(sug.basis)})</span></p>` : ''}
    ${rows}
    <button class="link" data-a="addset" data-p="${pi}" data-i="${ii}">+ set</button>
  </div>`;
}

function viewWeek() {
  const ws = ui.weekStart;
  const pos = E.position(program, state, ws);
  const wk = E.getWeek(program, state, ws);
  const today = todayKey();
  let rows = '';
  for (let i = 0; i < 7; i++) {
    const k = E.addDays(ws, i);
    const c = ctx(k);
    const locked = !!(c.day.swap || c.rec.done);
    const movable = k >= today && !locked;
    let status = '';
    if (c.day.swap) status = '<span class="badge">swapped</span>';
    else if (c.rec.done) status = '<span class="badge ok">done ✓</span>';
    else if (k < today) status = '<span class="badge dim">not logged</span>';
    else if (c.entry.light) status = '<span class="badge warn">adjusted</span>';
    let action = '';
    if (ui.moveFrom == null) { if (movable) action = `<button class="link" data-a="movefrom" data-i="${i}">Move</button>`; }
    else if (ui.moveFrom === i) action = '<button class="link" data-a="movecancel">Cancel</button>';
    else if (movable) action = `<button class="chip on" data-a="moveto" data-i="${i}">Swap with this</button>`;
    rows += `<div class="dayrow ${k === today ? 'today' : ''}">
      <button class="daymain" data-a="open" data-k="${k}"><span class="dname">${E.DAY_NAMES[i].slice(0, 3)} ${E.parseKey(k).getDate()}</span>
        <span><b>${h(c.day.swap ? c.day.swap.name : c.session.name)}</b> ${status}<br><span class="muted small">${c.day.swap ? h(c.day.swap.intensity) : h(c.session.minutes) + ' min'}</span></span></button>
      ${action}</div>`;
  }
  const notes = wk.plan.map((p, i) => (p.note && p.light ? `${E.DAY_NAMES[i]}: ${p.note}` : null)).filter(Boolean);
  return `<header class="top">
      <button class="ghost" data-a="week" data-d="-1" aria-label="Previous week">&#8249;</button>
      <div><h1>Week ${pos.weekIdx + 1} of ${pos.block.weeks.length}</h1><p class="muted small">${h(pos.block.name)} · ${h(pos.week.label)} · starts ${h(niceDate(ws))}</p></div>
      <button class="ghost" data-a="week" data-d="1" aria-label="Next week">&#8250;</button>
    </header>
    ${pos.finished ? '<p class="note">You have finished the written program, so the last block is repeating. Send Claude your backup file and ask for the next block.</p>' : ''}
    <p class="muted">${h(pos.block.focus)}</p>
    ${notes.map((n) => `<p class="note">${h(n)}</p>`).join('')}
    <section class="card flush">${rows}</section>
    <p class="muted small">Tap a day to open it. "Move" trades two days, for when the team lift or your schedule shifts.</p>`;
}

function viewProgress() {
  const charts = Object.entries(program.exercises).filter(([, e]) => e.chart)
    .map(([id, e]) => `<section class="card"><h3>${h(e.name.replace(' (team lift)', ''))}</h3><p class="muted small">Estimated one-rep max, lb</p><div data-chart="lift" data-id="${id}"></div></section>`).join('');
  const recent = Object.keys(state.days).sort().reverse().filter((k) => state.days[k].swap || state.days[k].session?.done).slice(0, 14);
  return `<header class="top"><div><h1>Progress</h1></div></header>
    <section class="card"><h3>Bodyweight</h3>
      <div class="row"><input inputmode="decimal" id="bw" placeholder="lb today" aria-label="Bodyweight in pounds"><button class="primary" data-a="bw">Log</button></div>
      <div data-chart="bw"></div></section>
    ${charts}
    <section class="card"><h3>Run pace</h3><p class="muted small">Minutes per mile, every logged or imported run (easy and hard mixed)</p><div data-chart="pace"></div></section>
    <section class="card"><h3>Swim: nonstop minutes</h3><p class="muted small">At 10, swimming becomes conditioning</p><div data-chart="swim"></div></section>
    <section class="card"><h3>Recent</h3>${recent.length ? recent.map(viewHistoryRow).join('') : '<p class="muted small">Nothing logged yet.</p>'}</section>`;
}

function viewHistoryRow(k) {
  const d = state.days[k];
  if (d.swap) return `<div class="hist"><b>${h(niceDate(k))}</b> ${h(d.swap.name)} <span class="muted small">${h(d.swap.intensity)}</span></div>`;
  const bits = [];
  for (const p of Object.values(d.session.parts || {})) {
    for (const it of Object.values(p.items || {})) {
      const top = (it.sets || []).filter((s) => s.done && s.w).sort((a, b) => b.w - a.w)[0];
      if (top) bits.push(`${it.name} ${top.w}×${top.r}`);
    }
    const l = p.log || {};
    if (l.avg_rep) bits.push(`reps avg ${l.avg_rep}`);
    if (l.distance_mi) bits.push(`${l.distance_mi} mi${l.time ? ' in ' + l.time : ''}`);
    if (l.rounds) bits.push(`${l.rounds} rounds`);
    else if (l.time && !l.distance_mi) bits.push(l.time);
    if (l.continuous_min) bits.push(`${l.continuous_min} min nonstop swim`);
  }
  return `<button class="hist" data-a="open" data-k="${k}"><b>${h(niceDate(k))}</b> ${h(program.sessions[d.session.sessionId]?.name || '')}${d.session.rpe ? ` <span class="muted small">RPE ${h(d.session.rpe)}</span>` : ''}
    ${bits.length ? `<br><span class="muted small">${h(bits.join(' · '))}</span>` : ''}</button>`;
}

function mountCharts() {
  document.querySelectorAll('[data-chart]').forEach((node) => {
    const t = node.dataset.chart;
    let pts = [], format = (v) => `${Math.round(v)} lb`, label = t;
    if (t === 'lift') { pts = E.e1rmSeries(program, state, node.dataset.id); label = program.exercises[node.dataset.id].name; }
    if (t === 'bw') { pts = state.bodyweight.map((b) => ({ date: b.date, value: b.lb })); format = (v) => `${Math.round(v * 10) / 10} lb`; label = 'Bodyweight'; }
    if (t === 'pace') { pts = paceSeries(); format = (v) => `${mmss(v)} /mi`; label = 'Run pace'; }
    if (t === 'swim') { pts = swimSeries(); format = (v) => `${v} min`; label = 'Nonstop swim'; }
    node.replaceChildren(lineChart(pts, { format, label }));
  });
}

function paceSeries() {
  const pts = [];
  for (const [date, d] of Object.entries(state.days)) {
    for (const p of Object.values(d.session?.parts || {})) {
      const mi = parseFloat(p.log?.distance_mi), sec = seconds(p.log?.time);
      if (mi > 0 && sec > 0) pts.push({ date, value: sec / mi });
    }
  }
  const km = state.settings.garminUnit === 'km';
  for (const a of state.garmin) {
    if (a.kind === 'run' && a.distance > 0 && a.seconds > 0) pts.push({ date: a.date, value: a.seconds / (km ? a.distance * 0.621371 : a.distance) });
  }
  return pts.sort((a, b) => a.date.localeCompare(b.date));
}
function swimSeries() {
  const pts = [];
  for (const [date, d] of Object.entries(state.days)) {
    for (const p of Object.values(d.session?.parts || {})) {
      const m = parseFloat(p.log?.continuous_min);
      if (m > 0) pts.push({ date, value: m });
    }
  }
  return pts.sort((a, b) => a.date.localeCompare(b.date));
}

function viewSettings() {
  const runs = state.garmin.filter((a) => a.kind === 'run').length, swims = state.garmin.length - runs;
  return `<header class="top"><div><h1>Settings</h1></div></header>
    <section class="card"><h3>Your data</h3>
      <p class="muted small">Everything you log is stored on this phone only. Export a backup now and then; it is also what you send Claude when you want the next block written.</p>
      <button class="primary big" data-a="export-json">Export backup (JSON)</button>
      <button class="secondary big" data-a="export-csv">Export log for Excel (CSV)</button>
      <label class="file secondary big">Restore from backup<input type="file" accept=".json,application/json" data-f="import-json"></label>
    </section>
    <section class="card"><h3>Garmin</h3>
      <p class="muted small">In Garmin Connect on the web: Activities, All Activities, Export CSV. Then import the file here. Runs and swims are added to your charts.</p>
      <label class="file secondary big">Import Garmin CSV<input type="file" accept=".csv,text/csv" data-f="import-garmin"></label>
      <div class="fields"><label>Garmin distances are in<select data-f="setting" data-k="garminUnit"><option value="mi" ${state.settings.garminUnit !== 'km' ? 'selected' : ''}>miles</option><option value="km" ${state.settings.garminUnit === 'km' ? 'selected' : ''}>kilometers</option></select></label></div>
      <p class="muted small">Imported so far: ${runs} runs, ${swims} swims.</p>
    </section>
    <section class="card"><h3>Program</h3>
      <p><b>${h(program.meta.name)}</b> <span class="muted small">v${h(program.meta.version)}</span></p>
      <ul class="lines">${program.meta.limitations.map((l) => `<li>${h(l)}</li>`).join('')}</ul>
      <div class="fields"><label>Week 1 starts (a Monday)<input type="date" data-f="setting" data-k="startDate" value="${h(state.settings.startDate || program.meta.startDate)}"></label>
      <label class="wide">Notes for the next rewrite (injuries, what you want changed)<textarea rows="3" data-f="setting" data-k="coachNotes">${h(state.settings.coachNotes || '')}</textarea></label></div>
    </section>`;
}

// ---------- sheets (bottom dialogs) ----------
function viewSheet() {
  const s = ui.sheet;
  if (s.type === 'swap') {
    return `<div class="sheet-body"><h2>What did you do instead?</h2>
      <div class="fields"><label class="wide">Activity<select id="sw-act">${program.swapActivities.map((a) => `<option value="${a.id}">${h(a.name)}</option>`).join('')}</select></label>
      <label class="wide">How hard was it?<select id="sw-int"><option value="easy">Easy</option><option value="moderate" selected>Moderate</option><option value="hard">Hard</option></select></label>
      <label>Minutes<input id="sw-min" inputmode="numeric"></label><label class="wide">Notes<input id="sw-notes"></label></div>
      <button class="primary big" data-a="swap-save">Log it and rebalance my week</button>
      <button class="link" data-a="close">Cancel</button></div>`;
  }
  if (s.type === 'sub') {
    const c = ctx(ui.date);
    const item = c.parts[s.pi].items[s.ii];
    const ex = program.exercises[item.ex];
    return `<div class="sheet-body"><h2>Swap ${h(ex.name)}</h2><p class="muted small">Equipment taken or missing? Pick a substitute. It is logged under its own name.</p>
      ${ex.subs.map((n) => `<button class="secondary big" data-a="sub-pick" data-n="${h(n)}">${h(n)}</button>`).join('')}
      <button class="secondary big" data-a="sub-pick" data-n="">Back to ${h(ex.name)}</button>
      <button class="link" data-a="close">Cancel</button></div>`;
  }
  return '';
}

// ---------- guided routine player ----------
const player = { steps: [], i: 0, endsAt: 0, left: 0, paused: false, timer: null, target: null, lock: null };

function beep() {
  try {
    player.audio ||= new (window.AudioContext || window.webkitAudioContext)();
    const o = player.audio.createOscillator(), g = player.audio.createGain();
    o.frequency.value = 880; g.gain.value = 0.15;
    o.connect(g); g.connect(player.audio.destination);
    o.start(); o.stop(player.audio.currentTime + 0.25);
  } catch { /* sound is optional */ }
}

function startRoutine(id, target) {
  const r = program.routines[id];
  player.steps = r.steps.flatMap((s) => (s.perSide ? [{ ...s, name: `${s.name} (left)` }, { ...s, name: `${s.name} (right)` }] : [s]));
  player.i = 0; player.target = target; player.paused = false; player.name = r.name;
  navigator.wakeLock?.request('screen').then((l) => { player.lock = l; }).catch(() => {});
  beginStep();
  clearInterval(player.timer);
  player.timer = setInterval(tick, 250);
  $('#player').classList.add('open');
}
function beginStep() {
  player.left = player.steps[player.i].seconds;
  player.endsAt = Date.now() + player.left * 1000;
  drawPlayer();
}
function tick() {
  if (player.paused) return;
  player.left = Math.max(0, (player.endsAt - Date.now()) / 1000);
  if (player.left <= 0) {
    beep();
    if (player.i + 1 >= player.steps.length) return endRoutine(true);
    player.i++;
    return beginStep();
  }
  const t = $('#player .clock');
  if (t) t.textContent = mmss(Math.ceil(player.left));
}
function drawPlayer() {
  const s = player.steps[player.i], next = player.steps[player.i + 1];
  $('#player').innerHTML = `<div class="player-body">
    <p class="muted">${h(player.name)} · ${player.i + 1} of ${player.steps.length}</p>
    <h1>${h(s.name)}</h1><p class="cue">${h(s.cue || '')}</p>
    <div class="clock">${mmss(Math.ceil(player.left))}</div>
    <p class="muted">${next ? 'Next: ' + h(next.name) : 'Last one'}</p>
    <div class="row controls"><button class="secondary" data-a="pl-prev">Back</button>
      <button class="primary" data-a="pl-pause">${player.paused ? 'Resume' : 'Pause'}</button>
      <button class="secondary" data-a="pl-next">Skip</button></div>
    <button class="link" data-a="pl-close">Close without finishing</button></div>`;
}
function endRoutine(completed) {
  clearInterval(player.timer);
  player.lock?.release?.().catch(() => {});
  $('#player').classList.remove('open');
  $('#player').innerHTML = '';
  if (completed) {
    if (player.target === 'morning') E.dayRecord(state, ui.date).morning = { done: true };
    else partRec(ctx(ui.date), Number(player.target)).done = true;
    persist();
  }
  render();
}

// ---------- events ----------
const actions = {
  day: (d) => { ui.date = E.addDays(ui.date, Number(d.d)); },
  gotoday: () => { ui.date = todayKey(); },
  week: (d) => { ui.weekStart = E.addDays(ui.weekStart, 7 * Number(d.d)); ui.moveFrom = null; },
  open: (d) => { ui.date = d.k; ui.tab = 'today'; window.scrollTo(0, 0); },
  routine: (d) => { startRoutine(d.r, d.target); return false; },
  variant: (d) => {
    const c = ctx(ui.date), rec = sessionRec(c.k, c.sessionId);
    if (rec.variant !== d.v) { rec.variant = d.v; rec.parts = {}; }
  },
  partdone: (d) => { const p = partRec(ctx(ui.date), d.p); p.done = !p.done; },
  setdone: (d) => {
    const c = ctx(ui.date), item = c.parts[d.p].items[d.i], ir = itemRec(c, d.p, d.i);
    const rx = E.prescription(program, item, c.pos.weekIdx);
    const set = (ir.sets[d.s] ||= {});
    for (let s = 0; s < d.s; s++) ir.sets[s] ||= {};
    if (!set.done) {
      const sug = E.suggestWeight(program, state, ir.key, rx, c.k);
      const prev = ir.sets.slice(0, d.s).reverse().find((x) => x.w);
      if ((set.w === undefined || set.w === '') && !program.exercises[ir.key]?.noLoad) set.w = prev?.w ?? sug?.weight ?? '';
      if (!set.r && typeof rx.reps === 'number') set.r = rx.reps;
      if (!set.r) set.r = 1;
    }
    set.done = !set.done;
  },
  addset: (d) => {
    const c = ctx(ui.date), ir = itemRec(c, d.p, d.i);
    const rx = E.prescription(program, c.parts[d.p].items[d.i], c.pos.weekIdx);
    while (ir.sets.length < rx.sets) ir.sets.push({});
    ir.sets.push({});
  },
  sub: (d) => { ui.sheet = { type: 'sub', pi: Number(d.p), ii: Number(d.i) }; },
  'sub-pick': (d) => {
    const c = ctx(ui.date), item = c.parts[ui.sheet.pi].items[ui.sheet.ii], ir = itemRec(c, ui.sheet.pi, ui.sheet.ii);
    ir.key = d.n ? `sub:${d.n}` : item.ex;
    ir.name = d.n || program.exercises[item.ex].name;
    ir.sets = ir.sets.filter((s) => s.done);
    ui.sheet = null;
  },
  swap: () => { ui.sheet = { type: 'swap' }; },
  'swap-save': () => {
    const msgs = E.logSwap(program, state, ui.date, { activityId: $('#sw-act').value, intensity: $('#sw-int').value, minutes: $('#sw-min').value, notes: $('#sw-notes').value }, todayKey());
    ui.sheet = null;
    ui.flash = msgs.length ? '' : 'Logged. No changes needed to the rest of the week.';
  },
  unswap: () => { E.removeSwap(program, state, ui.date, todayKey()); },
  close: () => { ui.sheet = null; },
  finish: () => {
    const c = ctx(ui.date), rec = sessionRec(c.k, c.sessionId);
    rec.done = true;
    E.afterFinish(program, state, c.k, todayKey());
    ui.flash = 'Session logged.';
  },
  reopen: () => { const c = ctx(ui.date); c.day.session.done = false; E.afterFinish(program, state, c.k, todayKey()); },
  movefrom: (d) => { ui.moveFrom = Number(d.i); },
  movecancel: () => { ui.moveFrom = null; },
  moveto: (d) => { E.moveSession(program, state, ui.weekStart, ui.moveFrom, Number(d.i), todayKey()); ui.moveFrom = null; },
  bw: () => {
    const lb = parseFloat($('#bw').value);
    if (!(lb > 50 && lb < 500)) { ui.flash = 'Enter a bodyweight in pounds.'; return; }
    const k = todayKey();
    state.bodyweight = state.bodyweight.filter((b) => b.date !== k).concat({ date: k, lb }).sort((a, b) => a.date.localeCompare(b.date));
  },
  'export-json': () => { S.download(`personal-fitness-backup-${todayKey()}.json`, S.exportJson(state)); return false; },
  'export-csv': () => { S.download(`personal-fitness-log-${todayKey()}.csv`, S.exportCsv(state, program), 'text/csv'); return false; },
  'pl-prev': () => { player.i = Math.max(0, player.i - 1); player.paused = false; beginStep(); return false; },
  'pl-next': () => { if (player.i + 1 >= player.steps.length) endRoutine(true); else { player.i++; player.paused = false; beginStep(); } return false; },
  'pl-pause': () => { player.paused = !player.paused; if (!player.paused) player.endsAt = Date.now() + player.left * 1000; drawPlayer(); return false; },
  'pl-close': () => { endRoutine(false); return false; },
};

document.addEventListener('click', (e) => {
  const tab = e.target.closest('nav button');
  if (tab) {
    ui.tab = tab.dataset.tab; ui.sheet = null; ui.moveFrom = null;
    if (ui.tab === 'week') ui.weekStart = E.mondayOf(todayKey());
    if (ui.tab === 'today') ui.date = todayKey();
    window.scrollTo(0, 0);
    return render();
  }
  const b = e.target.closest('[data-a]');
  if (!b || !actions[b.dataset.a]) return;
  const d = { ...b.dataset };
  for (const k of ['p', 'i', 's']) if (d[k] !== undefined && b.dataset.a !== 'movefrom' && b.dataset.a !== 'moveto') d[k] = Number(d[k]);
  if (actions[b.dataset.a](d) === false) return;
  persist();
  render();
});

document.addEventListener('input', (e) => {
  const t = e.target, f = t.dataset.f;
  if (!f || t.type === 'file') return;
  const c = ctx(ui.date);
  if (f === 'set') {
    const ir = itemRec(c, Number(t.dataset.p), Number(t.dataset.i));
    for (let s = 0; s <= Number(t.dataset.s); s++) ir.sets[s] ||= {};
    ir.sets[Number(t.dataset.s)][t.dataset.k] = t.value;
  } else if (f === 'log') {
    const p = partRec(c, Number(t.dataset.p));
    (p.log ||= {})[t.dataset.k] = t.value;
  } else if (f === 'sess') {
    sessionRec(c.k, c.sessionId)[t.dataset.k] = t.value;
  } else if (f === 'setting') {
    state.settings[t.dataset.k] = t.value;
  }
  persist();
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.type !== 'file' || !t.files[0]) return;
  try {
    const text = await t.files[0].text();
    if (t.dataset.f === 'import-json') {
      state = S.importJson(text);
      ui.flash = 'Backup restored.';
    } else {
      const acts = parseGarminCsv(text);
      const added = mergeGarmin(state, acts);
      ui.flash = `Garmin import: ${added} new activities added (${acts.length} runs and swims in the file).`;
    }
    persist();
  } catch (err) {
    ui.flash = `Import failed: ${err.message}`;
  }
  render();
});

// ---------- start ----------
async function start() {
  try {
    program = await (await fetch('program/program.json', { cache: 'no-cache' })).json();
  } catch {
    $('#view').innerHTML = '<p class="note">Could not load the program file. Check your connection and reload.</p>';
    return;
  }
  ui.date = todayKey();
  ui.weekStart = E.mondayOf(ui.date);
  E.recompute(program, state, ui.weekStart, ui.date);
  persist();
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  // Roll over to the new day if the app is left open overnight.
  let lastToday = ui.date;
  document.addEventListener('visibilitychange', () => {
    const now = todayKey();
    if (document.hidden || now === lastToday) return;
    if (ui.date === lastToday) ui.date = now;
    lastToday = now;
    E.recompute(program, state, E.mondayOf(now), now);
    if (!$('#player').classList.contains('open')) render();
  });
}
start();
