// All personal data lives in this browser's localStorage. Nothing is sent anywhere.
const KEY = 'personal-fitness.v1';

const blank = () => ({ version: 1, settings: {}, days: {}, weeks: {}, bodyweight: [], garmin: [] });

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...blank(), ...JSON.parse(raw) } : blank();
  } catch {
    return blank();
  }
}

export function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function download(filename, text, type = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function exportJson(state) {
  return JSON.stringify(state, null, 2);
}

export function importJson(text) {
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object' || !data.days) throw new Error('Not a personal-fitness backup file.');
  return { ...blank(), ...data };
}

const esc = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// One row per logged set or logged piece of work: easy to open in Excel.
export function exportCsv(state, program) {
  const rows = [['date', 'session', 'type', 'name', 'set', 'weight_lb', 'reps', 'rpe', 'distance', 'time', 'score', 'notes']];
  for (const date of Object.keys(state.days).sort()) {
    const d = state.days[date];
    if (d.swap) rows.push([date, d.swap.name, 'swap', d.swap.intensity, '', '', '', '', '', d.swap.minutes ? `${d.swap.minutes} min` : '', '', d.swap.notes]);
    const s = d.session;
    if (!s) continue;
    const sname = program.sessions[s.sessionId]?.name || s.sessionId;
    for (const p of Object.values(s.parts || {})) {
      for (const it of Object.values(p.items || {})) {
        (it.sets || []).forEach((set, i) => {
          if (set.done) rows.push([date, sname, 'set', it.name, i + 1, set.w, set.r, set.rpe, '', '', '', '']);
        });
      }
      const l = p.log;
      if (l && Object.values(l).some((v) => v)) {
        rows.push([date, sname, 'work', p.title || '', '', '', '', l.rpe, l.distance_mi || l.distance_yd, l.time || l.avg_rep || l.continuous_min, l.rounds, l.notes]);
      }
    }
    if (s.done) rows.push([date, sname, 'session', 'finished', '', '', '', s.rpe, '', '', '', s.notes]);
  }
  for (const b of state.bodyweight) rows.push([b.date, '', 'bodyweight', '', '', b.lb, '', '', '', '', '', '']);
  return rows.map((r) => r.map(esc).join(',')).join('\n');
}
