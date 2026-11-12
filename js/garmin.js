// Garmin import, v1: the CSV that Garmin Connect (web) produces from
// Activities > All Activities > Export CSV. Runs and swims are kept.

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

// "h:mm:ss", "mm:ss" or "mm:ss.s" -> seconds
export function toSeconds(t) {
  if (!t) return null;
  const parts = String(t).trim().split(':').map(Number);
  if (parts.some(Number.isNaN)) return null;
  return parts.reduce((a, b) => a * 60 + b, 0);
}

export function parseGarminCsv(text) {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  if (rows.length < 2) throw new Error('That file has no activities in it.');
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name) => head.indexOf(name);
  const iType = col('activity type'), iDate = col('date'), iDist = col('distance'), iTime = col('time');
  if (iType < 0 || iDate < 0) throw new Error('This does not look like a Garmin Connect activities export (no "Activity Type" and "Date" columns).');
  const iTitle = col('title'), iHr = col('avg hr'), iPace = col('avg pace');
  const out = [];
  for (const r of rows.slice(1)) {
    const type = (r[iType] || '').toLowerCase();
    const kind = type.includes('run') ? 'run' : type.includes('swim') ? 'swim' : null;
    if (!kind) continue;
    const date = (r[iDate] || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const distance = parseFloat(String(r[iDist] || '').replace(/,/g, '')) || null;
    const seconds = toSeconds(r[iTime]);
    out.push({
      id: `${r[iDate]}|${r[iType]}|${r[iDist]}`,
      date, kind,
      title: iTitle >= 0 ? r[iTitle] : '',
      distance, seconds,
      avgPace: iPace >= 0 ? r[iPace] : '',
      avgHr: iHr >= 0 ? parseInt(r[iHr], 10) || null : null,
    });
  }
  return out;
}

// Add new activities, skip ones already imported. Returns how many were added.
export function mergeGarmin(state, activities) {
  state.garmin ||= [];
  const seen = new Set(state.garmin.map((a) => a.id));
  let added = 0;
  for (const a of activities) {
    if (seen.has(a.id)) continue;
    state.garmin.push(a);
    seen.add(a.id);
    added++;
  }
  state.garmin.sort((a, b) => a.date.localeCompare(b.date));
  return added;
}
