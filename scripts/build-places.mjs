// Resolves data/places.src.json → data/places.json + data/outlines/<key>.geojson
//
//   node scripts/build-places.mjs            # only fetches what isn't cached yet
//   node scripts/build-places.mjs --fresh    # ignore the cache
//
// Tour stops are geocoded with OpenStreetMap Nominatim (1 request/second, per
// their usage policy). Outlines come from the UC Davis AVA project (US) or
// OpenStreetMap administrative boundaries (communes / municipalities).

import fs from 'node:fs';
import path from 'node:path';

const SRC = 'data/places.src.json';
const OUT = 'data/places.json';
const OUTLINES = 'data/outlines';
const RIVERS = 'data/rivers';
const CACHE = 'scripts/.cache/geocode.json';
const UA = 'wine-guide-build/1.0 (https://github.com/matthewross07/wine_guide)';

const fresh = process.argv.includes('--fresh');
const cache = !fresh && fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};

// Reuse what the previous build resolved (so CI doesn't re-geocode everything).
if (!fresh && fs.existsSync(OUT)) {
  for (const p of JSON.parse(fs.readFileSync(OUT, 'utf8')).places) {
    for (const s of p.tour || []) if (s.q && s.src === 'osm') cache[`pt:${s.q}`] ??= { lon: s.at[0], lat: s.at[1] };
    if (p.outline && p.outlineSpec && fs.existsSync(p.outline)) cache[`outline:${p.outlineSpec}`] ??= p.outline;
  }
}
const saveCache = () => {
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(cache));
};

let last = 0;
async function nominatim(q, polygon = false) {
  const key = `${polygon ? 'poly' : 'pt'}:${q}`;
  if (key in cache) return cache[key];
  const wait = Math.max(0, last + 1100 - Date.now());
  await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  const params = new URLSearchParams({ q, format: 'jsonv2', limit: '3' });
  if (polygon) {
    params.set('polygon_geojson', '1');
    params.set('polygon_threshold', '0.0004');
  }
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Nominatim ${res.status} for ${q}`);
  const hits = await res.json();
  let out = null;
  if (polygon) {
    const h = hits.find((x) => /Polygon/.test(x.geojson?.type));
    if (h) out = { name: h.name, geometry: h.geojson };
  } else if (hits[0]) {
    out = { lon: +hits[0].lon, lat: +hits[0].lat, display: hits[0].display_name };
  }
  cache[key] = out;
  saveCache();
  return out;
}

async function ava(id) {
  const key = `ava:${id}`;
  if (!(key in cache)) {
    const res = await fetch(`https://raw.githubusercontent.com/UCDavisLibrary/ava/master/avas/${id}.geojson`);
    if (!res.ok) throw new Error(`AVA ${id}: ${res.status}`);
    const fc = await res.json();
    const f = fc.features ? fc.features[0] : fc;
    cache[key] = { name: f.properties?.name || id, geometry: f.geometry };
    saveCache();
  }
  return cache[key];
}

// Main rivers near a place, from OpenStreetMap via Overpass.
async function overpassRivers(names, [w, s, e, n]) {
  const key = `rivers:${names.join('|')}:${[w, s, e, n].map((v) => v.toFixed(2)).join(',')}`;
  if (key in cache) return cache[key];
  const alt = names.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const q = `[out:json][timeout:90];way["waterway"="river"]["name"~"(^|[ '’])(${alt})($|[ ,])",i](${s},${w},${n},${e});out geom;`;
  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise((r) => setTimeout(r, attempt ? 15000 * attempt : 2500));
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(q)}`,
    }).catch(() => null);
    const text = res ? await res.text() : '';
    if (!res?.ok || !text.startsWith('{')) continue; // busy: back off and retry
    const lines = JSON.parse(text).elements
      .filter((el) => el.geometry?.length > 1)
      .map((el) => ({ name: el.tags.name, coords: el.geometry.map((g) => [g.lon, g.lat]) }));
    cache[key] = lines;
    saveCache();
    return lines;
  }
  console.warn(`  Overpass gave up for ${names.join(', ')}`);
  return null;
}

// ---- geometry helpers ----
const round = (n) => Math.round(n * 1e4) / 1e4;

function simplifyRing(pts, tol) {
  if (pts.length < 5) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let max = 0, idx = -1;
    const [x1, y1] = pts[a], [x2, y2] = pts[b];
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
    for (let i = a + 1; i < b; i++) {
      // Closed rings start and end on the same point: fall back to distance from it.
      const d = len < 1e-12
        ? Math.hypot(pts[i][0] - x1, pts[i][1] - y1)
        : Math.abs(dy * pts[i][0] - dx * pts[i][1] + x2 * y1 - y2 * x1) / len;
      if (d > max) { max = d; idx = i; }
    }
    if (max > tol) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]).map(([x, y]) => [round(x), round(y)]);
}

// Tolerance scales with the shape's size (~1/1500 of its diagonal) so big AVAs stay light.
function simplify(geometry) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const b = bboxOf(polys);
  const tol = Math.max(0.0003, Math.hypot(b[2] - b[0], b[3] - b[1]) / 1500);
  const out = polys
    .map((poly) => poly.map((ring) => simplifyRing(ring, tol)).filter((r) => r.length >= 4))
    .filter((p) => p.length);
  return { type: 'MultiPolygon', coordinates: out };
}

function bboxOf(coords, box = [180, 90, -180, -90]) {
  for (const c of coords) {
    if (typeof c[0] === 'number') {
      box[0] = Math.min(box[0], c[0]); box[1] = Math.min(box[1], c[1]);
      box[2] = Math.max(box[2], c[0]); box[3] = Math.max(box[3], c[1]);
    } else bboxOf(c, box);
  }
  return box;
}

const km = (a, b) => {
  const R = 6371, toR = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toR, dLon = (b[0] - a[0]) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toR) * Math.cos(b[1] * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

// ---- main ----
const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const prior = new Map(fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')).places.map((p) => [p.key, p]) : []);
fs.mkdirSync(OUTLINES, { recursive: true });
const places = [];

for (const p of src.places) {
  const out = { key: p.key, name: p.name, match: p.match, blurb: p.blurb };
  if (p.zoom) out.zoom = p.zoom;

  // Tour stops
  out.tour = [];
  for (const stop of p.tour || []) {
    let at = null, how = '';
    const g = await nominatim(stop.q).catch((e) => (console.warn(e.message), null));
    if (g) { at = [round(g.lon), round(g.lat)]; how = 'osm'; }
    if (stop.at && (!at || km(at, stop.at) > 8)) {
      if (at) console.warn(`  ${p.key} / ${stop.name}: geocoder said ${at}, using hand-placed ${stop.at} (${km(at, stop.at).toFixed(0)} km apart)`);
      at = stop.at; how = 'hand';
    }
    if (!at) { console.warn(`  ${p.key} / ${stop.name}: not found, skipped`); continue; }
    out.tour.push({ name: stop.name, note: stop.note, at, src: how, q: stop.q });
  }

  // Outline (skipped when the spec is unchanged and the file is already there)
  const spec = p.outline ? JSON.stringify(p.outline) : null;
  const reuse = spec && cache[`outline:${spec}`] === `${OUTLINES}/${p.key}.geojson`;
  const features = reuse ? JSON.parse(fs.readFileSync(`${OUTLINES}/${p.key}.geojson`, 'utf8')).features : [];
  if (!reuse && p.outline?.ava) {
    const a = await ava(p.outline.ava);
    features.push({ type: 'Feature', properties: { name: a.name }, geometry: simplify(a.geometry) });
  }
  for (const q of reuse ? [] : p.outline?.osm || []) {
    const g = await nominatim(q, true).catch((e) => (console.warn(e.message), null));
    if (g) features.push({ type: 'Feature', properties: { name: g.name }, geometry: simplify(g.geometry) });
    else console.warn(`  ${p.key}: no boundary for ${q}`);
  }
  if (features.length) {
    const file = `${OUTLINES}/${p.key}.geojson`;
    if (!reuse) fs.writeFileSync(file, JSON.stringify({ type: 'FeatureCollection', features }));
    out.outline = file;
    out.outlineSpec = spec;
  }

  // Rivers, clipped to a box around the region
  if (p.rivers?.length) {
    const rspec = JSON.stringify(p.rivers);
    const file = `${RIVERS}/${p.key}.geojson`;
    const prev = prior.get(p.key);
    if (prev?.riversSpec === rspec && fs.existsSync(file)) {
      out.rivers = file;
      out.riversSpec = rspec;
    } else {
      const pts = [...features.map((f) => f.geometry.coordinates), ...out.tour.map((s) => [s.at])];
      if (pts.length) {
        const b = bboxOf(pts);
        const padX = Math.max(0.12, (b[2] - b[0]) * 0.45), padY = Math.max(0.1, (b[3] - b[1]) * 0.45);
        const box = [b[0] - padX, b[1] - padY, b[2] + padX, b[3] + padY];
        const lines = await overpassRivers(p.rivers, box);
        if (lines?.length) {
          const tol = Math.max(0.0002, Math.hypot(box[2] - box[0], box[3] - box[1]) / 3000);
          const byName = new Map();
          for (const l of lines) {
            const pts2 = simplifyRing(l.coords, tol);
            if (pts2.length < 2) continue;
            if (!byName.has(l.name)) byName.set(l.name, []);
            byName.get(l.name).push(pts2);
          }
          const fc = {
            type: 'FeatureCollection',
            features: [...byName].map(([name, parts]) => ({ type: 'Feature', properties: { name }, geometry: { type: 'MultiLineString', coordinates: parts } })),
          };
          fs.mkdirSync(RIVERS, { recursive: true });
          fs.writeFileSync(file, JSON.stringify(fc));
          out.rivers = file;
          out.riversSpec = rspec;
        }
      }
    }
  }

  // Center + bounds from outline and tour stops
  const coords = [...features.map((f) => f.geometry.coordinates), ...out.tour.map((s) => [s.at])];
  if (coords.length) {
    const b = bboxOf(coords);
    out.bounds = b.map(round);
    out.center = [round((b[0] + b[2]) / 2), round((b[1] + b[3]) / 2)];
  } else {
    const g = await nominatim(p.name);
    if (g) out.center = [round(g.lon), round(g.lat)];
  }

  // Sanity check: flag tour stops far from the rest
  for (const s of out.tour) {
    const d = km(s.at, out.center);
    if (d > 150) console.warn(`  ${p.key} / ${s.name}: ${d.toFixed(0)} km from center — check it`);
  }
  places.push(out);
  console.log(`${p.key.padEnd(24)} stops ${out.tour.length}  outline ${features.length}  center ${out.center}`);
}

fs.writeFileSync(OUT, JSON.stringify({ generated: new Date().toISOString(), places }, null, 1));
console.log(`wrote ${OUT}`);
