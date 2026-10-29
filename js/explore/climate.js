// Growing-season climate for a vineyard, from ERA5 reanalysis via the free
// Open-Meteo historical archive.
//
// Known places load a precomputed file (data/climate/<key>.json, built by
// scripts/build-climate.mjs and refreshed monthly by a GitHub Action).
// Anything else is fetched live once and kept in the browser's Cache Storage.
//
// Season = Apr 1 – Oct 31 of the vintage (north) or Oct 1 – Apr 29 ending in
// the vintage year (south). Normal = 1991–2020 median.

export const SEASON = {
  north: { startMonth: 3, len: 214 },
  south: { startMonth: 9, len: 211 },
};
export const BASE_FROM = 1991, BASE_TO = 2020;
const GDD_BASE = 10; // °C, the standard base for grapevines
const DAY = 86400000;

export const seasonStart = (year, south) =>
  south ? Date.UTC(year - 1, SEASON.south.startMonth, 1) : Date.UTC(year, SEASON.north.startMonth, 1);

// ---------- data sources ----------

const API = 'https://archive-api.open-meteo.com/v1/archive';
const CACHE = 'wg-climate-v1';

async function cachedFetch(url) {
  const cache = typeof caches !== 'undefined' ? await caches.open(CACHE).catch(() => null) : null;
  let res = cache && (await cache.match(url));
  if (!res) {
    res = await fetch(url);
    if (!res.ok) throw new Error(res.status === 429 ? 'The weather archive is busy — try again in a minute.' : `Open-Meteo ${res.status}`);
    if (cache) await cache.put(url, res.clone()).catch(() => {});
  }
  return res.json();
}

// Live: one request for the whole record, sliced into seasons.
async function liveSeasons(lat, lon) {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - DAY); // monthly-stable URL
  const url = `${API}?latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}&start_date=1990-10-01` +
    `&end_date=${end.toISOString().slice(0, 10)}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=GMT&cell_selection=land`;
  const d = await cachedFetch(url);
  const t0 = Date.parse(`${d.daily.time[0]}T00:00:00Z`);
  const south = lat < 0;
  const { len } = south ? SEASON.south : SEASON.north;
  const seasons = {};
  for (let y = 1991; y <= end.getUTCFullYear() + 1; y++) {
    const i0 = Math.round((seasonStart(y, south) - t0) / DAY);
    if (i0 < 0 || i0 >= d.daily.time.length) continue;
    const take = (arr) => arr.slice(i0, i0 + len).filter((v) => v != null);
    const x = take(d.daily.temperature_2m_max);
    seasons[y] = { x, n: take(d.daily.temperature_2m_min).slice(0, x.length), p: take(d.daily.precipitation_sum).slice(0, x.length) };
  }
  return { lat, lon, elevation: d.elevation, south, seasons, source: 'live' };
}

// Precomputed file: temperatures and rain stored as integers × 10.
async function fileSeasons(key) {
  const res = await fetch(`data/climate/${key}.json`);
  if (!res.ok) return null;
  const f = await res.json();
  const seasons = {};
  for (const [y, s] of Object.entries(f.seasons)) {
    seasons[y] = { x: s.x.map((v) => v / 10), n: s.n.map((v) => v / 10), p: s.p.map((v) => v / 10) };
  }
  return { lat: f.lat, lon: f.lon, elevation: f.elevation, south: f.south, seasons, source: 'file', updated: f.updated };
}

export async function loadClimate({ key, lat, lon }) {
  const data = (key && (await fileSeasons(key).catch(() => null))) || (await liveSeasons(lat, lon));
  return analyze(data);
}

// ---------- analysis ----------

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
const median = (vals) => quantile(vals.filter((v) => v != null && !Number.isNaN(v)).sort((a, b) => a - b), 0.5);

export function smooth(arr, k = 3) {
  return arr.map((_, i) => {
    let s = 0, n = 0;
    for (let j = Math.max(0, i - k); j <= Math.min(arr.length - 1, i + k); j++) if (arr[j] != null) { s += arr[j]; n++; }
    return n ? s / n : null;
  });
}

function analyze(data) {
  const { south } = data;
  const { len, startMonth } = south ? SEASON.south : SEASON.north;

  // Day index where each season month starts (Apr, May, … or Oct, Nov, …)
  const monthStarts = [];
  for (let m = 0; m <= 7; m++) {
    const ref = Date.UTC(2001, startMonth + m, 1) - Date.UTC(2001, startMonth, 1);
    monthStarts.push(Math.min(len, Math.round(ref / DAY)));
  }

  const seasons = Object.entries(data.seasons)
    .map(([y, s]) => {
      const days = s.x.length;
      let gdd = 0, rain = 0, heat = 0, frost = 0, harvestRain = 0, meanSum = 0;
      const cumGdd = [];
      for (let k = 0; k < days; k++) {
        const mean = (s.x[k] + s.n[k]) / 2;
        meanSum += mean;
        gdd += Math.max(0, mean - GDD_BASE);
        rain += s.p[k];
        if (s.x[k] >= 35) heat++;
        if (k < 61 && s.n[k] < 0) frost++;
        if (k >= len - 61) harvestRain += s.p[k];
        cumGdd.push(gdd);
      }
      const months = monthStarts.slice(0, 7).map((a, m) => {
        const b = monthStarts[m + 1];
        if (days < b) return null;
        let r = 0;
        for (let k = a; k < b; k++) r += s.p[k];
        return r;
      });
      return {
        year: +y, days, complete: days >= len - 1,
        gdd, rain, heat, frost, harvestRain, mean: days ? meanSum / days : null,
        tmax: s.x, tmin: s.n, prcp: s.p, cumGdd, months,
      };
    })
    .filter((s) => s.days > 20)
    .sort((a, b) => a.year - b.year);

  const base = seasons.filter((s) => s.complete && s.year >= BASE_FROM && s.year <= BASE_TO);
  const band = (key) => {
    const out = { p10: [], p25: [], p50: [], p75: [], p90: [] };
    const sm = base.map((s) => smooth(s[key]));
    for (let k = 0; k < len; k++) {
      const vals = sm.map((a) => a[k]).filter((v) => v != null).sort((a, b) => a - b);
      for (const [q, name] of [[0.1, 'p10'], [0.25, 'p25'], [0.5, 'p50'], [0.75, 'p75'], [0.9, 'p90']]) out[name].push(quantile(vals, q));
    }
    return out;
  };
  const normal = {
    tmax: band('tmax'),
    tmin: band('tmin'),
    cumGdd: Array.from({ length: len }, (_, k) => median(base.map((s) => s.cumGdd[k]))),
    months: Array.from({ length: 7 }, (_, m) => median(base.map((s) => s.months[m]))),
  };
  for (const k of ['gdd', 'rain', 'harvestRain', 'heat', 'frost', 'mean']) normal[k] = median(base.map((s) => s[k]));

  return {
    ...data, len, startMonth, monthStarts, seasons, normal,
    dayDate: (k) => new Date(Date.UTC(2001, startMonth, 1) + k * DAY),
  };
}

// Share of complete seasons below this value (0 = lowest on record, 1 = highest).
export function rank(clim, key, value) {
  const vals = clim.seasons.filter((s) => s.complete).map((s) => s[key]);
  if (vals.length < 2) return null;
  return vals.filter((v) => v < value).length / (vals.length - 1);
}

// One plain-language line about the season.
export function describe(clim, s) {
  const n = clim.normal;
  const warm = (s.gdd - n.gdd) / n.gdd;
  const wet = (s.rain - n.rain) / Math.max(1, n.rain);
  const hw = (s.harvestRain - n.harvestRain) / Math.max(1, n.harvestRain);
  const temp = warm > 0.12 ? 'A hot' : warm > 0.05 ? 'A warm' : warm < -0.08 ? 'A cool' : warm < -0.03 ? 'A slightly cool' : 'A near-normal';
  const rain = wet > 0.3 ? 'very wet' : wet > 0.1 ? 'wet' : wet < -0.3 ? 'very dry' : wet < -0.1 ? 'dry' : 'normally rainy';
  const bits = [`${temp}, ${rain} growing season`];
  if (hw > 0.4) bits.push('with a rainy harvest');
  else if (hw < -0.4) bits.push('with a dry harvest');
  if (s.frost >= 2 && s.frost > n.frost + 1) bits.push(`and ${s.frost} spring frost nights`);
  if (s.heat >= 4 && s.heat > n.heat * 2 + 1) bits.push(`and ${s.heat} days above 35 °C`);
  return `${bits.join(' ')}.`;
}
