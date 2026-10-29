// Fetches growing-season weather for every place in data/places.json and
// writes data/climate/<key>.json (daily highs, lows, rain × 10 as integers).
//
//   node scripts/build-climate.mjs              # add missing / unfinished seasons
//   node scripts/build-climate.mjs barolo napa  # just these places
//
// Incremental: finished seasons already on disk are never re-fetched, so the
// monthly GitHub Action only downloads the current season. Requests are paced
// to stay inside Open-Meteo's free limits (600 weighted calls/min, 5,000/hour,
// 10,000/day); each season request weighs ~5 calls.

import fs from 'node:fs';
import { SEASON, seasonStart } from '../js/explore/climate.js';

const API = 'https://archive-api.open-meteo.com/v1/archive';
const DAY = 86400000;
const only = process.argv.slice(2);
const { places } = JSON.parse(fs.readFileSync('data/places.json', 'utf8'));
fs.mkdirSync('data/climate', { recursive: true });

// The archive lags ~5 days behind today.
const lastAvailable = Date.now() - 6 * DAY;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The point we take weather for: the tour stop named like the place, else the
// stop nearest the middle, else the center.
function climatePoint(p) {
  const named = p.tour?.find((s) => p.name.toLowerCase().startsWith(s.name.toLowerCase()));
  if (named) return named.at;
  if (p.tour?.length) {
    const [cx, cy] = p.center;
    return [...p.tour].sort((a, b) => Math.hypot(a.at[0] - cx, a.at[1] - cy) - Math.hypot(b.at[0] - cx, b.at[1] - cy))[0].at;
  }
  return p.center;
}

let spentThisMinute = 0, minuteStart = Date.now();
async function getSeason(lat, lon, year, south) {
  const { len } = south ? SEASON.south : SEASON.north;
  const start = seasonStart(year, south);
  const end = Math.min(start + (len - 1) * DAY, lastAvailable);
  if (end < start) return null;
  const weight = Math.ceil((((end - start) / DAY + 1) / 14) * 0.3 * 10) / 10;
  if (Date.now() - minuteStart > 60000) { spentThisMinute = 0; minuteStart = Date.now(); }
  if (spentThisMinute + weight > 450) {
    await sleep(61000 - (Date.now() - minuteStart));
    spentThisMinute = 0; minuteStart = Date.now();
  }
  spentThisMinute += weight;
  const url = `${API}?latitude=${lat}&longitude=${lon}&start_date=${iso(start)}&end_date=${iso(end)}` +
    '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=GMT&cell_selection=land';
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(url);
    if (res.status === 429) {
      const body = await res.text();
      const wait = /hour/i.test(body) ? 10 * 60000 : /day/i.test(body) ? 60 * 60000 : 65000;
      console.log(`  rate limited (${body.slice(0, 60)}…) waiting ${wait / 60000} min`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const d = await res.json();
    const n = (v) => (v == null ? null : Math.round(v * 10));
    const x = d.daily.temperature_2m_max.map(n), mn = d.daily.temperature_2m_min.map(n), p = d.daily.precipitation_sum.map(n);
    const days = x.findIndex((v) => v == null);
    const cut = days === -1 ? x.length : days;
    return { elevation: d.elevation, x: x.slice(0, cut), n: mn.slice(0, cut), p: p.slice(0, cut).map((v) => v ?? 0) };
  }
  throw new Error('gave up after repeated rate limits');
}

for (const p of places) {
  if (only.length && !only.includes(p.key)) continue;
  const [lon, lat] = climatePoint(p).map((v) => +v.toFixed(3));
  const south = lat < 0;
  const { len } = south ? SEASON.south : SEASON.north;
  const file = `data/climate/${p.key}.json`;
  let doc = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  if (!doc || doc.lat !== lat || doc.lon !== lon) doc = { key: p.key, name: p.name, lat, lon, south, elevation: null, seasons: {} };

  const lastYear = new Date(lastAvailable).getUTCFullYear() + (south ? 1 : 0);
  let fetched = 0;
  for (let y = 1991; y <= lastYear; y++) {
    if (doc.seasons[y]?.x.length >= len) continue; // finished season already stored
    if (seasonStart(y, south) > lastAvailable) continue;
    const s = await getSeason(lat, lon, y, south);
    if (!s) continue;
    doc.elevation = s.elevation;
    doc.seasons[y] = { x: s.x, n: s.n, p: s.p };
    fetched++;
  }
  doc.updated = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(file, JSON.stringify(doc));
  console.log(`${p.key.padEnd(24)} ${lat},${lon}  +${fetched} seasons  (${Object.keys(doc.seasons).length} total)`);
}
