// Explore view: a 3D flyover of the wine's region beside a panel on how its
// vintage's growing season compares with normal and with the great years.
// Loaded on demand (dynamic import) so the cellar map stays light.

import { loadClimate, describe, rank } from './climate.js';
import { placeFor, familyFor, getPlaces } from './places.js';
import { temperatureChart, gddChart, rainChart, climateSpace, stripes, TIER_COLORS, tip } from './charts.js';
import { Flyover } from './map3d.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const $ = (s, el = document) => el.querySelector(s);
const TIER_NAMES = { 5: 'Exceptional', 4: 'Excellent', 3: 'Good', 2: 'Mixed', 1: 'Difficult' };
const PIN_COLORS = { red: '#d0475f', white: '#f0d27e', rose: '#f2a294', sparkling: '#f6e2a6', other: '#b07ad0' };

let root, fly, flyReady, ctx, token = 0;

function build() {
  if (!document.querySelector('link[href="css/explore.css"]')) {
    document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'css/explore.css' }));
  }
  root = document.createElement('div');
  root.className = 'ex';
  root.innerHTML = `
    <section class="ex-map">
      <div class="ex-canvas"></div>
      <div class="ex-vignette"></div>
      <header class="ex-top">
        <button class="ex-back" data-x="close" aria-label="Back to the cellar">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z"/></svg><span>Cellar</span>
        </button>
        <div class="ex-title"><p class="ex-kicker"></p><h1></h1><p class="ex-blurb"></p></div>
      </header>
      <div class="ex-caption" hidden></div>
      <div class="ex-controls">
        <button class="ex-btn" data-x="toggle"></button>
        <button class="ex-btn ghost" data-x="replay">Replay</button>
        <button class="ex-btn ghost" data-x="globe" title="All your regions on the globe">Globe</button>
      </div>
      <div class="ex-loading"><span></span>Loading terrain…</div>
    </section>
    <aside class="ex-panel"></aside>`;
  document.body.appendChild(root);
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-x]');
    if (!b) return;
    const x = b.dataset.x;
    if (x === 'close') ctx?.onClose();
    if (x === 'toggle') ['touring', 'intro', 'orbit'].includes(fly.state) ? fly.pause() : fly.resume();
    if (x === 'replay') fly.replay();
    if (x === 'globe') ctx?.onGlobe();
    if (x === 'stop') fly.goToStop(+b.dataset.i);
    if (x === 'wine') ctx?.onOpenWine(b.dataset.id);
  });
  addEventListener('resize', () => fly?.resize());
}

function setState(s) {
  const btn = $('[data-x="toggle"]', root);
  if (!btn) return;
  const moving = ['touring', 'intro', 'orbit'].includes(s);
  btn.innerHTML = moving
    ? '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>Pause'
    : `<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>${s === 'free' || s === 'paused' ? 'Resume tour' : 'Play'}`;
}

function showCaption(i, stop, total) {
  const el = $('.ex-caption', root);
  el.hidden = false;
  el.innerHTML = `<p class="ex-cap-n">${i + 1} / ${total}</p><h3>${esc(stop.name)}</h3><p>${esc(stop.note || '')}</p>`;
  el.classList.remove('in');
  void el.offsetWidth;
  el.classList.add('in');
}

async function ensureMap(start) {
  if (!fly) {
    fly = new Flyover($('.ex-canvas', root), {
      onState: setState,
      onStop: (i, s) => showCaption(i, s, ctx.place?.tour?.length || 0),
      onPickPlace: (key) => ctx.onPickPlace(key),
    });
    flyReady = fly.init(start).then(async () => {
      fly.setCellar(await cellarPins(ctx.wines, ctx.styleOf));
      $('.ex-loading', root).classList.add('done');
    });
  }
  return flyReady;
}

// One glowing pin per region in the cellar.
async function cellarPins(wines, styleOf) {
  const places = await getPlaces();
  const byKey = new Map();
  for (const w of wines) {
    if (w.bottles <= 0) continue;
    const p = places.find((pl) => new RegExp(pl.match, 'i').test(w.region)) || places.find((pl) => new RegExp(pl.match, 'i').test(w.wine_name));
    if (!p?.center) continue;
    const e = byKey.get(p.key) || { key: p.key, name: p.name, center: p.center, bottles: 0, styles: {} };
    e.bottles += w.bottles;
    const st = styleOf(w).replace('sparkling-', '').replace(/^sparkling$/, 'sparkling');
    e.styles[st] = (e.styles[st] || 0) + w.bottles;
    byKey.set(p.key, e);
  }
  return [...byKey.values()].map((e) => {
    const top = Object.entries(e.styles).sort((a, b) => b[1] - a[1])[0][0];
    return { key: e.key, name: e.name, center: e.center, bottles: e.bottles, color: PIN_COLORS[top] || PIN_COLORS.red };
  });
}

export async function openExplore(wine, options) {
  ctx = { ...options, wine };
  if (!root) build();
  root.hidden = false;
  document.body.classList.add('ex-open');
  const my = ++token;

  const [place, family] = await Promise.all([placeFor(wine), familyFor(wine)]);
  if (my !== token) return;
  ctx.place = place;

  $('.ex-kicker', root).textContent = `${wine.wine_name} · ${wine.vintage || 'NV'}`;
  $('.ex-title h1', root).textContent = place?.name || wine.region || 'Unknown region';
  $('.ex-blurb', root).textContent = place?.blurb || (place?.geocoded ? `Located from “${wine.region}”.` : '');
  $('.ex-caption', root).hidden = true;
  renderPanelSkeleton(wine);

  // Map and outline in parallel with the climate data.
  const mapP = (async () => {
    await ensureMap({ center: place?.center, zoom: 1.4 });
    if (my !== token) return;
    let outline = null;
    if (place?.outline) outline = await fetch(place.outline).then((r) => r.json()).catch(() => null);
    fly.show(place ? { ...place, outline } : null);
    if (!place) fly.globe?.();
  })();

  if (!place) {
    $('.ex-panel', root).innerHTML = `<div class="ex-empty"><h2>Where is this from?</h2>
      <p>I couldn't place “${esc(wine.region || 'this region')}” on the map. Give it a fuller region in the sheet (e.g. “Montsant, Catalonia, Spain”) and it will appear here.</p></div>`;
    return mapP;
  }

  try {
    const point = place.tour?.find((s) => place.name.toLowerCase().startsWith(s.name.toLowerCase()))?.at || place.center;
    const clim = await loadClimate({ key: place.key, lat: point[1], lon: point[0] });
    if (my !== token) return;
    const tiers = family?.years || {};
    const vintage = parseInt(wine.vintage, 10);
    renderPanel({ wine, place, family, tiers, clim, year: vintage });
  } catch (err) {
    if (my !== token) return;
    $('.ex-panel', root).innerHTML = `<div class="ex-empty"><h2>Weather unavailable</h2><p>${esc(err.message)}</p></div>`;
  }
  return mapP;
}

export async function openGlobe(options) {
  ctx = { ...options, wine: null, place: null };
  if (!root) build();
  root.hidden = false;
  document.body.classList.add('ex-open');
  ++token;
  $('.ex-kicker', root).textContent = 'Your cellar';
  $('.ex-title h1', root).textContent = 'Around the world';
  $('.ex-blurb', root).textContent = 'Each column is a region in the cellar — taller means more bottles. Tap one to fly there.';
  $('.ex-caption', root).hidden = true;
  const pins = await cellarPins(options.wines, options.styleOf);
  const places = await getPlaces();
  const groups = pins
    .map((p) => ({ ...p, wines: options.wines.filter((w) => w.bottles > 0 && (places.find((pl) => new RegExp(pl.match, 'i').test(w.region)) || places.find((pl) => new RegExp(pl.match, 'i').test(w.wine_name)))?.key === p.key) }))
    .sort((a, b) => b.bottles - a.bottles);
  $('.ex-panel', root).innerHTML = `
    <div class="ex-section">
      <p class="ex-eyebrow">${groups.length} regions · ${groups.reduce((n, g) => n + g.bottles, 0)} bottles</p>
      <h2 class="ex-h2">Your cellar, region by region</h2>
      <ul class="ex-regions">${groups.map((g) => `<li>
        <button data-x="wine" data-id="${g.wines[0]?.id}"><i style="background:${g.color}"></i><b>${esc(g.name)}</b><span>${g.bottles}</span></button>
        <p>${g.wines.map((w) => `${esc(w.wine_name)} <em>${esc(w.vintage || 'NV')}</em>`).join(' · ')}</p></li>`).join('')}</ul>
    </div>`;
  await ensureMap({ center: [5, 35], zoom: 1.3 });
  fly.show(null);
  fly.globe();
}

export function closeExplore() {
  token++;
  if (!root) return;
  root.hidden = true;
  document.body.classList.remove('ex-open');
  fly?.stop();
  tip({}, null);
}

// ---------- panel ----------

function renderPanelSkeleton(wine) {
  $('.ex-panel', root).innerHTML = `<div class="ex-section"><p class="ex-eyebrow">${esc(wine.region)}</p>
    <div class="ex-skel w60"></div><div class="ex-skel w90"></div><div class="ex-skel tiles"></div><div class="ex-skel chart"></div></div>`;
}

function pct(v, n) {
  const d = ((v - n) / Math.max(1e-9, Math.abs(n))) * 100;
  return `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(0)}%`;
}

function rankPhrase(r, hiWord, loWord) {
  if (r == null) return '';
  if (r >= 0.97) return `${hiWord}est on record`;
  if (r <= 0.03) return `${loWord}est on record`;
  if (r >= 0.5) return `${hiWord}er than ${Math.round(r * 100)}% of seasons`;
  return `${loWord}er than ${Math.round((1 - r) * 100)}% of seasons`;
}

// Nearest great vintage by (heat, rain, harvest rain), each scaled by its spread.
function closestGreat(clim, season, tiers) {
  const pool = clim.seasons.filter((s) => s.complete && tiers[s.year] >= 5 && s.year !== season.year);
  if (!pool.length) return null;
  const sd = (k) => {
    const v = clim.seasons.filter((s) => s.complete).map((s) => s[k]);
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) || 1;
  };
  const S = { gdd: sd('gdd'), rain: sd('rain'), harvestRain: sd('harvestRain') };
  const dist = (s) => Math.hypot((s.gdd - season.gdd) / S.gdd, (s.rain - season.rain) / S.rain, (s.harvestRain - season.harvestRain) / S.harvestRain);
  return pool.map((s) => ({ s, d: dist(s) })).sort((a, b) => a.d - b.d)[0];
}

function renderPanel(state) {
  const { wine, place, family, tiers, clim } = state;
  const complete = clim.seasons.filter((s) => s.complete);
  const latest = complete.at(-1);
  let year = state.year;
  let note = '';
  if (!year) {
    year = latest.year;
    note = `Non-vintage wine — showing the most recent full season (${year}).`;
  } else if (!clim.seasons.find((s) => s.year === year)) {
    note = `No weather record for ${year} here; showing ${latest.year}.`;
    year = latest.year;
  }
  const season = clim.seasons.find((s) => s.year === year);
  const n = clim.normal;
  const tier = tiers[year];
  const great = Object.entries(tiers).filter(([, t]) => t === 5).map(([y]) => +y).sort((a, b) => a - b);
  const match = closestGreat(clim, season, tiers);
  const isVintage = String(year) === String(parseInt(wine.vintage, 10));
  const pick = (y) => renderPanel({ ...state, year: y });

  const tile = (label, value, unit, delta, phrase, cls = '') => `<div class="ex-tile ${cls}">
    <p class="ex-tile-label">${label}</p>
    <p class="ex-tile-value">${value}<small>${unit}</small></p>
    <p class="ex-tile-delta">${delta}</p>
    <p class="ex-tile-rank">${phrase}</p></div>`;

  const panel = $('.ex-panel', root);
  panel.innerHTML = `
    <div class="ex-section ex-hero">
      <p class="ex-eyebrow">${esc(place.name)} · ${isVintage ? 'your vintage' : 'comparing'}${!season.complete ? ' · season in progress' : ''}</p>
      <h2 class="ex-h2">The ${year} growing season</h2>
      <p class="ex-lede">${describe(clim, season)}</p>
      ${note ? `<p class="ex-note">${note}</p>` : ''}
      ${!isVintage && parseInt(wine.vintage, 10) ? `<button class="ex-link" data-pick="${parseInt(wine.vintage, 10)}">← back to ${parseInt(wine.vintage, 10)}, your vintage</button>` : ''}
      <div class="ex-verdict">
        ${tier ? `<span class="ex-tier" style="--c:${TIER_COLORS[tier]}"><i></i>${TIER_NAMES[tier]} vintage in ${esc(family.name)}</span>` : family ? `<span class="ex-tier muted"><i></i>${year} not rated for ${esc(family.name)}</span>` : ''}
        ${match ? `<span class="ex-match">Weather most like <button class="ex-link" data-pick="${match.s.year}">${match.s.year}</button>, a great year</span>` : ''}
      </div>
    </div>

    <div class="ex-tiles">
      ${tile('Heat', Math.round(season.gdd).toLocaleString(), ' °C·days', `${pct(season.gdd, n.gdd)} vs normal`, rankPhrase(season.complete ? rank(clim, 'gdd', season.gdd) : null, 'warm', 'cool'), season.gdd > n.gdd ? 'warm' : 'cool')}
      ${tile('Season rain', Math.round(season.rain), ' mm', `${pct(season.rain, n.rain)} vs normal`, rankPhrase(season.complete ? rank(clim, 'rain', season.rain) : null, 'wett', 'dri'), season.rain > n.rain ? 'wet' : 'dry')}
      ${tile(clim.south ? 'Harvest rain · Mar–Apr' : 'Harvest rain · Sep–Oct', season.days >= clim.len - 61 ? Math.round(season.harvestRain) : '—', season.days >= clim.len - 61 ? ' mm' : '', season.days >= clim.len - 61 ? `${pct(season.harvestRain, n.harvestRain)} vs normal` : 'not yet', '', season.harvestRain > n.harvestRain ? 'wet' : 'dry')}
      ${tile('Hot days', season.heat, ' ≥ 35 °C', `normal ${Math.round(n.heat)}`, '')}
      ${tile('Spring frosts', season.frost, ' nights', `normal ${Math.round(n.frost)}`, '')}
    </div>

    <div class="ex-section">
      <h3 class="ex-h3">Every season since ${clim.seasons[0].year}</h3>
      <p class="ex-sub">Growing-season temperature: blue cooler, red warmer than the 1991–2020 normal. Dots mark rated vintages. Tap a year to compare.</p>
      <div class="ex-chart" data-chart="stripes"></div>
      <div class="ex-legend">${[5, 4, 3, 2, 1].map((t) => `<span><i style="background:${TIER_COLORS[t]}"></i>${TIER_NAMES[t]}</span>`).join('')}</div>
    </div>

    <div class="ex-section">
      <h3 class="ex-h3">Heat building through the season</h3>
      <p class="ex-sub">Growing degree days (°C above 10, summed daily) — the warmth vines bank toward ripeness. Grey lines are every season; <span class="k-great">gold</span> are great vintages.</p>
      <div class="ex-chart" data-chart="gdd"></div>
    </div>

    <div class="ex-section">
      <h3 class="ex-h3">Daily highs and lows</h3>
      <p class="ex-sub">${year} (7-day average) against the 1991–2020 range: darker band holds half of all years, lighter band 80%.</p>
      <div class="ex-chart" data-chart="temp"></div>
    </div>

    <div class="ex-section">
      <h3 class="ex-h3">Rain, month by month</h3>
      <p class="ex-sub"><span class="k-rain">${year}</span> against the <span class="k-normal">normal</span> month.</p>
      <div class="ex-chart" data-chart="rain"></div>
    </div>

    <div class="ex-section">
      <h3 class="ex-h3">Where ${year} sits</h3>
      <p class="ex-sub">Every season by total heat and rain; dashed lines are normal. Great vintages here tend to cluster — see where yours falls.</p>
      <div class="ex-chart" data-chart="space"></div>
    </div>

    <div class="ex-section ex-wines">
      <h3 class="ex-h3">From here in your cellar</h3>
      ${ctx.wines.filter((w) => w !== wine && w.bottles > 0 && new RegExp(place.match || '^$', 'i').test(w.region)).map((w) => `<button class="ex-wine" data-x="wine" data-id="${w.id}">${esc(w.wine_name)} <em>${esc(w.vintage || 'NV')}</em></button>`).join('') || '<p class="ex-sub">Just this one.</p>'}
    </div>

    <footer class="ex-foot">
      Weather: ERA5 reanalysis (ECMWF) via <a href="https://open-meteo.com" target="_blank" rel="noopener">Open-Meteo</a>, for the grid cell at
      ${Math.abs(clim.lat).toFixed(2)}°${clim.lat >= 0 ? 'N' : 'S'} ${Math.abs(clim.lon).toFixed(2)}°${clim.lon >= 0 ? 'E' : 'W'}${clim.elevation != null ? ` (${Math.round(clim.elevation)} m)` : ''}.
      Season ${clim.south ? 'Oct–Apr' : 'Apr–Oct'}; normal = 1991–2020 median.
      ${family ? `Vintage ratings are approximate consensus tiers from published vintage charts${great.length ? ` (great years: ${great.join(', ')})` : ''} — edit <code>data/vintages.json</code>.` : 'No vintage ratings for this region yet — add a family to <code>data/vintages.json</code>.'}
    </footer>`;

  const mount = (name, el) => $(`[data-chart="${name}"]`, panel).appendChild(el);
  mount('stripes', stripes(clim, season, tiers, pick));
  mount('gdd', gddChart(clim, season, tiers));
  mount('temp', temperatureChart(clim, season));
  mount('rain', rainChart(clim, season));
  mount('space', climateSpace(clim, season, tiers, pick));
  panel.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => pick(+b.dataset.pick)));
}
