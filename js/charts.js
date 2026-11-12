// One small single-series line chart, drawn as SVG. Tap or hover a point to read it.

const NS = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}, text) => {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
};
const shortDate = (k) => {
  const [, m, d] = k.split('-').map(Number);
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${d}`;
};

// points: [{ date: 'YYYY-MM-DD', value: number }], sorted by date
export function lineChart(points, { format = (v) => String(v), label = '' } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'chart';
  if (!points.length) {
    wrap.innerHTML = '<p class="muted small">No data yet.</p>';
    return wrap;
  }
  const W = 340, H = 160, L = 8, R = 8, T = 22, B = 36;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${label}: ${points.length} entries, latest ${format(points[points.length - 1].value)}` });
  const vals = points.map((p) => p.value);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (lo === hi) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.12;
  lo -= pad; hi += pad;
  const t0 = Date.parse(points[0].date), t1 = Date.parse(points[points.length - 1].date);
  const x = (p, i) => (t1 === t0 ? (L + W - R) / 2 : L + ((Date.parse(p.date) - t0) / (t1 - t0)) * (W - L - R));
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);

  // recessive grid: top and bottom value only
  const vmax = Math.max(...vals), vmin = Math.min(...vals);
  for (const v of vmax === vmin ? [vmax] : [vmax, vmin]) {
    svg.append(el('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'grid' }));
    // max label sits above its line, min label below, so neither covers a point
    svg.append(el('text', { x: L, y: v === vmax ? y(v) - 7 : y(v) + 14, class: 'axis' }, format(v)));
  }
  svg.append(el('text', { x: L, y: H - 6, class: 'axis' }, shortDate(points[0].date)));
  if (points.length > 1) svg.append(el('text', { x: W - R, y: H - 6, 'text-anchor': 'end', class: 'axis' }, shortDate(points[points.length - 1].date)));

  if (points.length > 1) {
    svg.append(el('path', { d: points.map((p, i) => `${i ? 'L' : 'M'}${x(p, i).toFixed(1)},${y(p.value).toFixed(1)}`).join(''), class: 'line' }));
  }
  const tip = document.createElement('div');
  tip.className = 'tip';
  const show = (p) => { tip.textContent = `${shortDate(p.date)}: ${format(p.value)}`; };
  points.forEach((p, i) => {
    svg.append(el('circle', { cx: x(p, i), cy: y(p.value), r: 4, class: 'dot' }));
    const hit = el('circle', { cx: x(p, i), cy: y(p.value), r: 14, class: 'hit', tabindex: 0 });
    hit.append(el('title', {}, `${shortDate(p.date)}: ${format(p.value)}`));
    for (const ev of ['pointerenter', 'click', 'focus']) hit.addEventListener(ev, () => show(p));
    svg.append(hit);
  });
  show(points[points.length - 1]);
  wrap.append(tip, svg);
  return wrap;
}
