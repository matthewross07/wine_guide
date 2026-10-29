// Small hand-rolled SVG charts for the vintage panel. No chart library: each
// function returns a DOM element sized by viewBox, so it scales to its column.
// Styling lives in css/explore.css (classes prefixed `c-`).

import { smooth } from './climate.js';

const NS = 'http://www.w3.org/2000/svg';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const TIER_COLORS = { 5: '#f0c86e', 4: '#c9a36a', 3: '#8c8680', 2: '#6f7f98', 1: '#5268a6' };

const lin = (d0, d1, r0, r1) => (v) => r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0);
const f1 = (n) => (Math.round(n * 10) / 10).toFixed(1);

function linePath(xs, ys) {
  let d = '', pen = false;
  for (let i = 0; i < ys.length; i++) {
    if (ys[i] == null || Number.isNaN(ys[i])) { pen = false; continue; }
    d += `${pen ? 'L' : 'M'}${xs(i).toFixed(1)} ${ys[i].toFixed(1)}`;
    pen = true;
  }
  return d;
}

function areaPath(xs, lo, hi) {
  const top = hi.map((v, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)} ${v.toFixed(1)}`).join('');
  const bottom = lo.map((v, i) => [i, v]).reverse().map(([i, v]) => `L${xs(i).toFixed(1)} ${v.toFixed(1)}`).join('');
  return `${top}${bottom}Z`;
}

function svg(w, h, cls, inner) {
  const t = document.createElement('template');
  t.innerHTML = `<svg xmlns="${NS}" class="c-chart ${cls}" viewBox="0 0 ${w} ${h}" role="img">${inner}</svg>`;
  return t.content.firstElementChild;
}

// Shared floating tooltip.
let tipEl;
export function tip(e, html) {
  tipEl ||= Object.assign(document.createElement('div'), { className: 'c-tip' });
  if (!tipEl.isConnected) document.body.appendChild(tipEl);
  if (!html) { tipEl.hidden = true; return; }
  tipEl.innerHTML = html;
  tipEl.hidden = false;
  const r = tipEl.getBoundingClientRect();
  let x = e.clientX + 14, y = e.clientY + 14;
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 14;
  if (y + r.height > innerHeight - 8) y = e.clientY - r.height - 14;
  tipEl.style.transform = `translate(${x}px, ${y}px)`;
}

function monthAxis(clim, xs, y0, y1) {
  return clim.monthStarts.slice(0, 7).map((k, m) => {
    const x = xs(k);
    const mid = xs((k + clim.monthStarts[m + 1]) / 2);
    return `<line class="c-grid" x1="${x}" x2="${x}" y1="${y0}" y2="${y1}"/>
      <text class="c-axis" x="${mid}" y="${y1 + 16}" text-anchor="middle">${MONTHS[(clim.startMonth + m) % 12]}</text>`;
  }).join('');
}

function yAxis(ys, ticks, x0, x1, fmt = (v) => v) {
  return ticks.map((v) => `<line class="c-grid" x1="${x0}" x2="${x1}" y1="${ys(v)}" y2="${ys(v)}"/>
    <text class="c-axis" x="${x0 - 6}" y="${ys(v) + 4}" text-anchor="end">${fmt(v)}</text>`).join('');
}

function niceTicks(min, max, count = 4) {
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}

// Spread end-of-line labels so they don't overlap.
function spread(labels, minGap = 13) {
  labels.sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < minGap) labels[i].y = labels[i - 1].y + minGap;
  return labels;
}

function crosshair(el, { left, right, top, bottom, len, xs, html }) {
  el.querySelector('.c-cross-g').innerHTML = `<line class="c-cross" x1="0" x2="0" y1="${top}" y2="${bottom}"/>`;
  const line = el.querySelector('.c-cross');
  const overlay = el.querySelector('.c-hit');
  const move = (e) => {
    const pt = el.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const p = pt.matrixTransform(el.getScreenCTM().inverse());
    const k = Math.max(0, Math.min(len - 1, Math.round(((p.x - left) / (right - left)) * (len - 1))));
    line.setAttribute('x1', xs(k)); line.setAttribute('x2', xs(k));
    line.style.opacity = 1;
    tip(e, html(k));
  };
  overlay.addEventListener('pointermove', move);
  overlay.addEventListener('pointerleave', (e) => { line.style.opacity = 0; tip(e, null); });
}

const dateLabel = (clim, k) => clim.dayDate(k).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

// ---------- 1. Daily highs & lows vs normal (WeatherSpark-style bands) ----------

export function temperatureChart(clim, season) {
  const W = 640, H = 270, L = 38, R = 92, T = 14, B = 30;
  const n = clim.normal;
  const hi = smooth(season.tmax), lo = smooth(season.tmin);
  const all = [...n.tmax.p90, ...n.tmin.p10, ...hi, ...lo].filter((v) => v != null && !Number.isNaN(v));
  const yMin = Math.floor(Math.min(...all) - 1), yMax = Math.ceil(Math.max(...all) + 1);
  const xs = lin(0, clim.len - 1, L, W - R);
  const ys = lin(yMin, yMax, H - B, T);
  const Y = (arr) => arr.map((v) => (v == null || Number.isNaN(v) ? null : ys(v)));
  const lastK = hi.length - 1;
  const labels = spread([
    { y: ys(hi[lastK]), text: `${season.year} highs`, cls: 'c-lab-hi' },
    { y: ys(n.tmax.p50[clim.len - 1]), text: 'normal high', cls: 'c-lab-muted' },
    { y: ys(lo[lastK]), text: `${season.year} lows`, cls: 'c-lab-lo' },
    { y: ys(n.tmin.p50[clim.len - 1]), text: 'normal low', cls: 'c-lab-muted' },
  ]);
  const el = svg(W, H, 'c-temp', `
    ${yAxis(ys, niceTicks(yMin, yMax, 5), L, W - R, (v) => `${v}°`)}
    ${monthAxis(clim, xs, T, H - B)}
    <path class="c-band-hi-90" d="${areaPath(xs, Y(n.tmax.p10), Y(n.tmax.p90))}"/>
    <path class="c-band-hi-50" d="${areaPath(xs, Y(n.tmax.p25), Y(n.tmax.p75))}"/>
    <path class="c-band-lo-90" d="${areaPath(xs, Y(n.tmin.p10), Y(n.tmin.p90))}"/>
    <path class="c-band-lo-50" d="${areaPath(xs, Y(n.tmin.p25), Y(n.tmin.p75))}"/>
    <path class="c-normal" d="${linePath(xs, Y(n.tmax.p50))}"/>
    <path class="c-normal" d="${linePath(xs, Y(n.tmin.p50))}"/>
    <path class="c-line-hi" d="${linePath(xs, Y(hi))}"/>
    <path class="c-line-lo" d="${linePath(xs, Y(lo))}"/>
    ${labels.map((l) => `<text class="c-endlab ${l.cls}" x="${W - R + 6}" y="${l.y + 4}">${l.text}</text>`).join('')}
    <g class="c-cross-g"></g>
    <rect class="c-hit" x="${L}" y="${T}" width="${W - R - L}" height="${H - B - T}"/>`);
  crosshair(el, {
    left: L, right: W - R, top: T, bottom: H - B, len: clim.len, xs,
    html: (k) => `<b>${dateLabel(clim, k)}</b>
      ${hi[k] != null ? `<span class="c-tip-hi">${season.year} high ${f1(hi[k])}°</span><span class="c-tip-lo">${season.year} low ${f1(lo[k])}°</span>` : '<span>not yet recorded</span>'}
      <span class="c-tip-muted">normal ${f1(n.tmax.p50[k])}° / ${f1(n.tmin.p50[k])}°</span>`,
  });
  el.setAttribute('aria-label', `Daily high and low temperatures in ${season.year} against the 1991–2020 range`);
  return el;
}

// ---------- 2. Heat accumulation (growing degree days) ----------

export function gddChart(clim, season, tiers = {}) {
  const W = 640, H = 270, L = 44, R = 64, T = 14, B = 30;
  const complete = clim.seasons.filter((s) => s.complete);
  const yMax = Math.max(...clim.seasons.map((s) => s.gdd)) * 1.04;
  const xs = lin(0, clim.len - 1, L, W - R);
  const ys = lin(0, yMax, H - B, T);
  const Y = (arr) => arr.map((v) => (v == null ? null : ys(v)));
  const great = complete.filter((s) => tiers[s.year] >= 5 && s.year !== season.year);
  const labels = spread([
    ...great.map((s) => ({ y: ys(s.gdd), text: String(s.year), cls: 'c-lab-great', x: xs(s.days - 1) })),
    { y: ys(season.cumGdd.at(-1)), text: String(season.year), cls: 'c-lab-vintage', x: xs(season.days - 1) },
    { y: ys(clim.normal.gdd), text: 'normal', cls: 'c-lab-muted', x: xs(clim.len - 1) },
  ], 12);
  const el = svg(W, H, 'c-gdd', `
    ${yAxis(ys, niceTicks(0, yMax, 4), L, W - R, (v) => v.toLocaleString())}
    ${monthAxis(clim, xs, T, H - B)}
    ${complete.map((s) => `<path class="c-faint" d="${linePath(xs, Y(s.cumGdd))}"><title>${s.year}</title></path>`).join('')}
    ${great.map((s) => `<path class="c-great" d="${linePath(xs, Y(s.cumGdd))}"/>`).join('')}
    <path class="c-normal" d="${linePath(xs, Y(clim.normal.cumGdd))}"/>
    <path class="c-vintage" d="${linePath(xs, Y(season.cumGdd))}"/>
    ${labels.map((l) => `<text class="c-endlab ${l.cls}" x="${Math.max(l.x, xs(clim.len - 1)) + 6}" y="${l.y + 4}">${l.text}</text>`).join('')}
    <g class="c-cross-g"></g>
    <rect class="c-hit" x="${L}" y="${T}" width="${W - R - L}" height="${H - B - T}"/>`);
  crosshair(el, {
    left: L, right: W - R, top: T, bottom: H - B, len: clim.len, xs,
    html: (k) => {
      const v = season.cumGdd[k], nv = clim.normal.cumGdd[k];
      const diff = v != null ? ((v - nv) / nv) * 100 : null;
      return `<b>${dateLabel(clim, k)}</b>
        ${v != null ? `<span class="c-tip-vintage">${season.year}: ${Math.round(v).toLocaleString()} °C·days</span>` : ''}
        <span class="c-tip-muted">normal: ${Math.round(nv).toLocaleString()}</span>
        ${diff != null ? `<span>${diff >= 0 ? '+' : ''}${diff.toFixed(0)}% vs normal</span>` : ''}`;
    },
  });
  el.setAttribute('aria-label', `Accumulated growing degree days in ${season.year} compared with every season since 1991`);
  return el;
}

// ---------- 3. Rain by month ----------

export function rainChart(clim, season) {
  const W = 640, H = 210, L = 40, R = 16, T = 14, B = 30;
  const n = clim.normal.months;
  const v = season.months;
  const yMax = Math.max(...n, ...v.filter((x) => x != null)) * 1.12 || 10;
  const band = (W - L - R) / 7;
  const ys = lin(0, yMax, H - B, T);
  const bars = v.map((r, m) => {
    const x = L + m * band;
    const month = MONTHS[(clim.startMonth + m) % 12];
    const normal = `<rect class="c-rain-normal" x="${x + band * 0.18}" y="${ys(n[m])}" width="${band * 0.64}" height="${ys(0) - ys(n[m])}"/>`;
    const actual = r == null ? '' : `<rect class="c-rain" x="${x + band * 0.3}" y="${ys(r)}" width="${band * 0.4}" height="${ys(0) - ys(r)}" rx="2"/>`;
    const tipText = r == null ? `${month}: not yet recorded` : `${month} ${season.year}: ${Math.round(r)} mm · normal ${Math.round(n[m])} mm`;
    return `<g class="c-rain-g" data-tip="${tipText}">${normal}${actual}
      <rect class="c-hit" x="${x}" y="${T}" width="${band}" height="${H - B - T}"/>
      <text class="c-axis" x="${x + band / 2}" y="${H - B + 16}" text-anchor="middle">${month}</text></g>`;
  }).join('');
  const el = svg(W, H, 'c-rainc', `${yAxis(ys, niceTicks(0, yMax, 3), L, W - R, (x) => `${x}`)}${bars}`);
  el.querySelectorAll('.c-rain-g').forEach((g) => {
    g.addEventListener('pointermove', (e) => tip(e, g.dataset.tip));
    g.addEventListener('pointerleave', (e) => tip(e, null));
  });
  el.setAttribute('aria-label', `Monthly rainfall in ${season.year} against the normal`);
  return el;
}

// ---------- 4. Climate space: every season by warmth and rain ----------

export function climateSpace(clim, season, tiers, onPick) {
  const W = 640, H = 330, L = 52, R = 20, T = 18, B = 40;
  const ss = clim.seasons.filter((s) => s.complete || s.year === season.year);
  const gx = ss.map((s) => s.gdd), ry = ss.map((s) => s.rain);
  const padX = (Math.max(...gx) - Math.min(...gx)) * 0.08, padY = (Math.max(...ry) - Math.min(...ry)) * 0.1;
  const xs = lin(Math.min(...gx) - padX, Math.max(...gx) + padX, L, W - R);
  const ys = lin(Math.max(0, Math.min(...ry) - padY), Math.max(...ry) + padY, H - B, T);
  const nx = xs(clim.normal.gdd), ny = ys(clim.normal.rain);
  const dots = ss
    .map((s) => {
      const tier = tiers[s.year];
      const me = s.year === season.year;
      const r = me ? 8 : tier ? 5.5 : 4;
      const fill = tier ? TIER_COLORS[tier] : '#5b524d';
      const label = me || tier === 5 ? `<text class="c-dot-lab${me ? ' me' : ''}" x="${xs(s.gdd) + r + 3}" y="${ys(s.rain) + 4}">${s.year}${me && !s.complete ? ' (so far)' : ''}</text>` : '';
      return `<g class="c-dot${me ? ' me' : ''}" data-year="${s.year}" tabindex="0">
        <circle cx="${xs(s.gdd)}" cy="${ys(s.rain)}" r="${r}" fill="${fill}"/>${label}</g>`;
    })
    .join('');
  const xt = niceTicks(Math.min(...gx), Math.max(...gx), 4), yt = niceTicks(Math.min(...ry), Math.max(...ry), 4);
  const el = svg(W, H, 'c-space', `
    ${xt.map((v) => `<line class="c-grid" x1="${xs(v)}" x2="${xs(v)}" y1="${T}" y2="${H - B}"/><text class="c-axis" x="${xs(v)}" y="${H - B + 16}" text-anchor="middle">${v.toLocaleString()}</text>`).join('')}
    ${yt.map((v) => `<line class="c-grid" x1="${L}" x2="${W - R}" y1="${ys(v)}" y2="${ys(v)}"/><text class="c-axis" x="${L - 6}" y="${ys(v) + 4}" text-anchor="end">${v}</text>`).join('')}
    <line class="c-normal" x1="${nx}" x2="${nx}" y1="${T}" y2="${H - B}"/>
    <line class="c-normal" x1="${L}" x2="${W - R}" y1="${ny}" y2="${ny}"/>
    <text class="c-quad" x="${W - R - 6}" y="${H - B - 8}" text-anchor="end">warm &amp; dry</text>
    <text class="c-quad" x="${L + 8}" y="${T + 12}">cool &amp; wet</text>
    <text class="c-axis-title" x="${(L + W - R) / 2}" y="${H - 4}" text-anchor="middle">heat (growing degree days) →</text>
    <text class="c-axis-title" x="14" y="${(T + H - B) / 2}" text-anchor="middle" transform="rotate(-90 14 ${(T + H - B) / 2})">season rain (mm) →</text>
    ${dots}`);
  el.querySelectorAll('.c-dot').forEach((g) => {
    const s = ss.find((x) => x.year === +g.dataset.year);
    const tier = tiers[s.year];
    const html = `<b>${s.year}${tier ? ` · ${['', 'Difficult', 'Mixed', 'Good', 'Excellent', 'Exceptional'][tier]}` : ''}</b>
      <span>${Math.round(s.gdd).toLocaleString()} °C·days · ${Math.round(s.rain)} mm rain</span><span class="c-tip-muted">click to see this season</span>`;
    g.addEventListener('pointermove', (e) => tip(e, html));
    g.addEventListener('pointerleave', (e) => tip(e, null));
    g.addEventListener('click', () => onPick?.(s.year));
    g.addEventListener('keydown', (e) => e.key === 'Enter' && onPick?.(s.year));
  });
  el.setAttribute('aria-label', 'Each growing season since 1991 placed by total heat and rain');
  return el;
}

// ---------- 5. Season stripes (Ed Hawkins-style warming stripes) ----------

const STOPS = [[-2, [31, 78, 140]], [-1, [91, 143, 199]], [0, [232, 226, 218]], [1, [224, 138, 107]], [2, [163, 35, 58]]];
function anomalyColor(a) {
  a = Math.max(-2, Math.min(2, a));
  for (let i = 1; i < STOPS.length; i++) {
    if (a <= STOPS[i][0]) {
      const [a0, c0] = STOPS[i - 1], [a1, c1] = STOPS[i];
      const t = (a - a0) / (a1 - a0);
      return `rgb(${c0.map((c, j) => Math.round(c + (c1[j] - c) * t)).join(',')})`;
    }
  }
  return 'rgb(163,35,58)';
}

export function stripes(clim, season, tiers, onPick) {
  const ss = clim.seasons;
  const W = 640, H = 92, T = 4, SH = 56;
  const w = W / ss.length;
  const bars = ss.map((s, i) => {
    const a = s.mean - clim.normal.mean;
    const tier = tiers[s.year];
    const me = s.year === season.year;
    return `<g class="c-stripe${me ? ' me' : ''}" data-year="${s.year}">
      <rect x="${i * w}" y="${T}" width="${w + 0.5}" height="${SH}" fill="${anomalyColor(a)}"/>
      ${tier ? `<circle cx="${i * w + w / 2}" cy="${T + SH + 10}" r="${Math.min(4, w / 2.6)}" fill="${TIER_COLORS[tier]}"/>` : ''}
      ${me ? `<rect class="c-stripe-me" x="${i * w + 1}" y="${T + 1}" width="${w - 2}" height="${SH - 2}"/>` : ''}
    </g>`;
  }).join('');
  const first = ss[0]?.year, last = ss.at(-1)?.year;
  const el = svg(W, H, 'c-stripes', `${bars}
    <text class="c-axis" x="0" y="${H - 2}">${first}</text>
    <text class="c-axis" x="${W}" y="${H - 2}" text-anchor="end">${last}</text>`);
  el.querySelectorAll('.c-stripe').forEach((g) => {
    const s = ss.find((x) => x.year === +g.dataset.year);
    const a = s.mean - clim.normal.mean;
    const tier = tiers[s.year];
    const html = `<b>${s.year}${s.complete ? '' : ' (so far)'}</b><span>${a >= 0 ? '+' : ''}${f1(a)} °C vs normal season</span>${tier ? `<span class="c-tip-muted">${['', 'Difficult', 'Mixed', 'Good', 'Excellent', 'Exceptional'][tier]} vintage</span>` : ''}`;
    g.addEventListener('pointermove', (e) => tip(e, html));
    g.addEventListener('pointerleave', (e) => tip(e, null));
    g.addEventListener('click', () => onPick?.(s.year));
  });
  el.setAttribute('aria-label', 'Growing season temperature for every year since 1991, blue cooler and red warmer than normal');
  return el;
}
