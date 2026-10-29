import { STORAGE, boxSlots, parseSlot, slotLabel, slotShort, accessRank } from './storage.js';
import { store, today } from './store.js';
import { CONFIG } from './config.js';

const YEAR = new Date().getFullYear();
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const money = (n) => `$${Math.round(n).toLocaleString()}`;

const ui = {
  view: 'cellar',
  q: '',
  type: 'all',
  drinkNow: false,
  selected: null,
  focusSlot: null,
  placing: null, // { id, from }  — from = null when giving an unplaced bottle a spot
  sort: 'soonest',
};

// ---------- wine helpers ----------

function style(w) {
  const t = fold(w.wine_type);
  if (t.includes('sparkling') && t.includes('rose')) return 'sparkling-rose';
  if (t.includes('sparkling') && t.includes('red')) return 'sparkling-red';
  if (t.includes('sparkling')) return 'sparkling';
  if (t.includes('rose')) return 'rose';
  if (t.includes('white')) return 'white';
  if (t.includes('red')) return 'red';
  return 'other';
}

const TYPE_FILTERS = [
  ['all', 'All'],
  ['red', 'Red'],
  ['white', 'White'],
  ['rose', 'Rosé'],
  ['sparkling', 'Sparkling'],
  ['other', 'Other'],
];

function windowStatus(w) {
  const { drink_start: s, drink_end: e, best_year_to_drink: b } = w;
  if (s == null || e == null) return { key: 'unknown', label: 'No drinking window yet', ready: false };
  if (YEAR < s) return { key: 'young', label: `Resting · opens ${s}`, ready: false };
  if (YEAR > e) return { key: 'past', label: `Past its window (${e}) — open soon`, ready: true };
  if (b === YEAR) return { key: 'peak', label: 'At its peak this year', ready: true };
  if (b != null && YEAR < b) return { key: 'ready', label: `Drinking well · peaks ${b}`, ready: true };
  return { key: 'late', label: `Past peak · drink by ${e}`, ready: true };
}

function matches(w) {
  if (ui.type !== 'all') {
    const st = style(w);
    if (ui.type === 'sparkling' ? !st.startsWith('sparkling') : st !== ui.type) return false;
  }
  if (ui.drinkNow && !drinkNow(w)) return false;
  const terms = fold(ui.q).split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = fold(
    [w.wine_name, w.vintage, w.region, w.varietal, w.wine_type, w.broad_flavor_notes, w.good_pairings, w.my_notes, w.locs.join(' ')].join(' '),
  );
  return terms.every((t) => hay.includes(t));
}

const filtering = () => ui.q.trim() !== '' || ui.type !== 'all' || ui.drinkNow;

// At or past its best year (or past the window entirely): open these first.
const drinkNow = (w) => {
  const st = windowStatus(w).key;
  return st === 'peak' || st === 'late' || st === 'past';
};

function occupancy() {
  const occ = new Map();
  for (const w of store.wines) for (const l of w.locs) occ.set(l, w);
  return occ;
}

// Bottles in the same box are interchangeable, so show them as one row.
function groupLocs(locs) {
  const groups = [];
  for (const l of sortLocs(locs)) {
    const s = parseSlot(l);
    const prev = groups[groups.length - 1];
    if (s?.unit === 'box' && prev?.box === s.box) prev.slots.push(l);
    else groups.push({ box: s?.unit === 'box' ? s.box : null, slots: [l] });
  }
  return groups.map((g) => ({
    ...g,
    slot: g.slots[0],
    code: g.box ? `BOX ${g.box}` : g.slots[0],
    label: g.box ? `Box ${g.box} · ${plural(g.slots.length, 'bottle')}` : slotLabel(g.slots[0]),
  }));
}

const sortLocs = (locs) => [...locs].sort((a, b) => accessRank(a) - accessRank(b) || a.localeCompare(b, undefined, { numeric: true }));

function whereSummary(w) {
  const parts = [...new Set(sortLocs(w.locs).map(slotShort))];
  const unplaced = w.bottles - w.locs.length;
  if (unplaced > 0) parts.push(`${unplaced} unplaced`);
  return parts.join(' · ') || (w.bottles ? 'No spot yet' : 'All gone');
}

// ---------- rendering: shell ----------

function render() {
  renderStatus();
  renderStats();
  renderChips();
  if (ui.view === 'cellar') renderCellar();
  if (ui.view === 'collection') renderCollection();
  if (ui.view === 'journal') renderJournal();
  if (ui.selected) renderDrawer();
  renderPlacingBanner();
}

function renderStatus() {
  const el = $('#sync-status');
  const pending = store.remote ? store.outbox.length : 0;
  let text;
  if (store.source === 'loading') text = 'Opening the cellar…';
  else if (store.error === 'unauthorized') text = 'Needs your passphrase to save — open settings';
  else if (store.error) text = store.error;
  else if (pending) text = `Saving ${plural(pending, 'change')} to the sheet…`;
  else if (store.source === 'live') text = 'Live from your Google Sheet';
  else if (store.source === 'local') text = 'Changes saved in this browser — connect the sheet in settings';
  else text = 'Snapshot of the sheet — connect it in settings to save notes';
  el.textContent = text;
  el.dataset.state = store.error ? 'warn' : pending ? 'busy' : store.source;
}

function renderStats() {
  const ws = store.wines;
  const bottles = ws.reduce((n, w) => n + w.bottles, 0);
  const value = ws.reduce((n, w) => n + w.bottles * (w.retail_price_usd || 0), 0);
  const now = ws.filter(drinkNow).reduce((n, w) => n + w.bottles, 0);
  const aging = ws.filter((w) => w.best_year_to_drink > YEAR).reduce((n, w) => n + w.bottles, 0);
  const opened = store.log.filter((l) => l.event === 'drank').length;
  const stat = (n, label, extra = '') => `<div class="stat ${extra}"><b>${n}</b><span>${label}</span></div>`;
  // "drink now" = at or past its best year; "still improving" = best year is ahead.
  $('#stats').innerHTML = [
    stat(bottles, 'bottles'),
    stat(ws.filter((w) => w.bottles > 0).length, 'wines'),
    stat(money(value), 'est. retail'),
    stat(now, 'drink now', 'stat-gold'),
    stat(aging, 'still improving', 'stat-ok'),
    stat(opened, 'opened & logged'),
  ].join('');
}

function renderChips() {
  $('#type-chips').innerHTML = TYPE_FILTERS.map(
    ([k, label]) =>
      `<button class="chip${ui.type === k ? ' on' : ''}" data-type="${k}" aria-pressed="${ui.type === k}">${
        k === 'all' ? '' : `<i class="dot st-${k}"></i>`
      }${label}</button>`,
  ).join('');
}

// ---------- rendering: cellar map ----------

function bottleSVG(slot, cx, cy, r, occ, hits) {
  const w = occ.get(slot);
  const placing = ui.placing;
  if (!w) {
    return `<g class="slot empty${placing ? ' target' : ''}${ui.focusSlot === slot ? ' focus' : ''}" data-slot="${slot}">
      <circle cx="${cx}" cy="${cy}" r="${r - 1.5}"/></g>`;
  }
  const st = style(w);
  const cls = ['slot', 'bottle', `st-${st}`];
  if (hits) cls.push(hits.has(w.id) ? 'hit' : 'dim');
  if (ui.selected === w.id) cls.push('sel');
  if (ui.focusSlot === slot) cls.push('focus');
  if (placing && placing.from === slot) cls.push('moving');
  else if (placing && placing.from) cls.push('swap');
  const sparkle = st.startsWith('sparkling')
    ? `<circle class="foil" cx="${cx}" cy="${cy}" r="${(r * 0.62).toFixed(1)}"/>`
    : `<circle class="punt" cx="${cx}" cy="${cy}" r="${(r * 0.4).toFixed(1)}"/>`;
  return `<g class="${cls.join(' ')}" data-slot="${slot}" data-id="${w.id}" tabindex="0" role="button"
      aria-label="${esc(`${w.wine_name} ${w.vintage}, ${slotLabel(slot)}`)}">
    <circle class="halo" cx="${cx}" cy="${cy}" r="${r + 4.5}"/>
    <circle class="glass" cx="${cx}" cy="${cy}" r="${r}" fill="url(#g-${st})"/>
    ${sparkle}
    <ellipse class="shine" cx="${(cx - r * 0.34).toFixed(1)}" cy="${(cy - r * 0.38).toFixed(1)}" rx="${(r * 0.3).toFixed(1)}" ry="${(r * 0.15).toFixed(1)}" transform="rotate(-35 ${(cx - r * 0.34).toFixed(1)} ${(cy - r * 0.38).toFixed(1)})"/>
  </g>`;
}

function fridgeSVG(occ, hits) {
  const F = STORAGE.fridge;
  const W = 480;
  const gx = 64, gw = 384; // glass interior
  const top = 66;
  const shelfH = 58;
  const step = gw / F.front;
  const fx = (p) => gx + step / 2 + (p - 1) * step;
  const bx = (p) => gx + step + (p - 1) * step;
  let shelves = '';
  for (let s = 1; s <= F.shelves; s++) {
    const y = top + (s - 1) * shelfH;
    let back = '', front = '';
    for (let p = 1; p <= F.back; p++) back += bottleSVG(`F${s}-B${p}`, bx(p), y + 18, 15, occ, hits);
    for (let p = 1; p <= F.front; p++) front += bottleSVG(`F${s}-F${p}`, fx(p), y + 32, 21, occ, hits);
    shelves += `<g class="shelf">
      <text class="shelf-num" x="22" y="${y + 37}">${s}</text>
      <rect class="shelf-rail" x="${gx - 4}" y="${y + 10}" width="${gw + 8}" height="2" rx="1"/>
      ${back}${front}
      <rect x="${gx - 6}" y="${y + 50}" width="${gw + 12}" height="7" rx="2" fill="url(#g-wood)"/>
    </g>`;
  }
  const bulkTop = top + F.shelves * shelfH + 14;
  // Bulk area: bottles lying stacked, 5 per layer, offset like a pile.
  let bulk = '';
  const perRow = 5;
  const rows = Math.ceil(F.bulk / perRow);
  for (let n = 1; n <= F.bulk; n++) {
    const row = Math.floor((n - 1) / perRow);
    const col = (n - 1) % perRow;
    const off = row % 2 ? step * 0.55 : 0;
    const x = gx + 44 + col * 70 + off;
    const y = bulkTop + 28 + (rows - 1 - row) * 36;
    bulk += bottleSVG(`FX-${n}`, x, y, 20, occ, hits);
  }
  const bulkH = rows * 36 + 34;
  const H = bulkTop + bulkH + 50;
  return `<svg class="map fridge" viewBox="0 0 ${W} ${H}" role="group" aria-label="Wine fridge, ${F.shelves} shelves and a bulk area">
    <rect x="40" y="6" width="${W - 46}" height="${H - 12}" rx="22" fill="url(#g-steel)"/>
    <rect x="46" y="12" width="${W - 58}" height="38" rx="14" fill="#141518"/>
    <text class="fridge-temp" x="${W - 40}" y="37" text-anchor="end">55°F</text>
    <circle cx="70" cy="31" r="3" fill="#7ec8ff" opacity=".8"/>
    <rect x="${gx - 12}" y="${top - 12}" width="${gw + 24}" height="${H - top - 34}" rx="10" fill="url(#g-glass)" stroke="rgba(255,255,255,.08)"/>
    <rect x="${gx - 12}" y="${top - 12}" width="${gw + 24}" height="160" fill="url(#g-led)"/>
    ${shelves}
    <rect x="${gx - 4}" y="${bulkTop}" width="${gw + 8}" height="${bulkH}" rx="8" fill="rgba(255,255,255,.025)" stroke="rgba(255,255,255,.06)"/>
    <text class="shelf-num small" x="22" y="${bulkTop + bulkH / 2 + 4}">bulk</text>
    ${bulk}
    <rect x="${gx}" y="${H - 34}" width="${gw}" height="10" rx="3" fill="#0d0d10"/>
    ${Array.from({ length: 18 }, (_, i) => `<rect x="${gx + 10 + i * 21}" y="${H - 32}" width="12" height="6" rx="2" fill="#1d1e22"/>`).join('')}
  </svg>`;
}

function rackSVG(occ, hits) {
  const R = STORAGE.rack;
  const step = 64, r = 24, left = 52, top = 22, rowH = 62;
  const W = left + R.cols * step + 22;
  const H = top + R.rows * rowH + 18;
  let body = '';
  for (let row = 1; row <= R.rows; row++) {
    const y = top + (row - 1) * rowH;
    body += `<text class="shelf-num" x="18" y="${y + 36}">${row}</text>`;
    body += `<rect x="${left - 10}" y="${y + 52}" width="${R.cols * step + 20}" height="6" rx="3" fill="url(#g-bamboo)"/>`;
    for (let c = 1; c <= R.cols; c++) body += bottleSVG(`R${row}-${c}`, left + step / 2 + (c - 1) * step, y + 28, r, occ, hits);
  }
  return `<svg class="map rack" viewBox="0 0 ${W} ${H}" role="group" aria-label="Bamboo rack, ${R.rows} rows of ${R.cols}">
    <rect x="${left - 18}" y="${top - 12}" width="10" height="${H - top}" rx="4" fill="url(#g-bamboo)"/>
    <rect x="${W - 22}" y="${top - 12}" width="10" height="${H - top}" rx="4" fill="url(#g-bamboo)"/>
    ${body}
    <g class="col-nums">${Array.from({ length: R.cols }, (_, i) => `<text x="${left + step / 2 + i * step}" y="${top - 2}">${i + 1}</text>`).join('')}</g>
  </svg>`;
}

function boxSVG(letter, occ, hits) {
  const slots = boxSlots(letter);
  const cols = 4;
  const rows = Math.ceil(slots.length / cols);
  const step = 46, r = 18, pad = 20;
  const W = pad * 2 + cols * step, H = 46 + rows * step + 14;
  const used = slots.filter((s) => occ.has(s)).length;
  const inner = slots
    .map((s, i) => bottleSVG(s, pad + step / 2 + (i % cols) * step, 44 + step / 2 + Math.floor(i / cols) * step, r, occ, hits))
    .join('');
  const grid = Array.from({ length: cols - 1 }, (_, i) => `<line x1="${pad + (i + 1) * step}" y1="44" x2="${pad + (i + 1) * step}" y2="${H - 12}"/>`).join('')
    + Array.from({ length: rows - 1 }, (_, i) => `<line x1="${pad}" y1="${44 + (i + 1) * step}" x2="${W - pad}" y2="${44 + (i + 1) * step}"/>`).join('');
  return `<figure class="box">
    <svg class="map" viewBox="0 0 ${W} ${H}" role="group" aria-label="Box ${letter}">
      <rect x="4" y="8" width="${W - 8}" height="${H - 12}" rx="8" fill="url(#g-kraft)"/>
      <rect x="${pad - 4}" y="40" width="${W - pad * 2 + 8}" height="${H - 48}" rx="5" fill="#3a2a19"/>
      <g class="box-grid">${grid}</g>
      <text class="box-label" x="${pad}" y="30">BOX ${letter}</text>
      <text class="box-count" x="${W - pad}" y="30" text-anchor="end">${used}/${slots.length}</text>
      ${inner}
    </svg>
  </figure>`;
}

function unitHead(title, model, used, cap) {
  const pct = cap ? Math.round((used / cap) * 100) : 0;
  return `<header class="unit-head">
    <div><h2>${title}</h2><p>${model}</p></div>
    <div class="fill" title="${used} of ${cap} spots used"><span>${used}<small>/${cap}</small></span><i style="--p:${pct}%"></i></div>
  </header>`;
}

function trayHTML() {
  const unplaced = store.wines.filter((w) => w.bottles > w.locs.length);
  const over = store.wines.filter((w) => w.locs.length > w.bottles);
  if (!unplaced.length && !over.length) return '';
  return `<div class="tray">
    ${unplaced.length ? `<div><h3>Needs a spot</h3><div class="tray-items">${unplaced
      .map((w) => `<button class="tray-item" data-place="${w.id}"><i class="dot st-${style(w)}"></i>${esc(w.wine_name)} <em>${esc(w.vintage)}</em> <b>×${w.bottles - w.locs.length}</b></button>`)
      .join('')}</div></div>` : ''}
    ${over.length ? `<div><h3>More spots than bottles</h3><p class="muted">The sheet lists fewer bottles than mapped spots for: ${over
      .map((w) => `<a href="#" data-open="${w.id}">${esc(w.wine_name)}</a>`).join(', ')}. Fix the <code>locations</code> cell in the sheet.</p></div>` : ''}
  </div>`;
}

function renderCellar() {
  const occ = occupancy();
  const hits = filtering() ? new Set(store.wines.filter(matches).map((w) => w.id)) : null;
  const count = (re) => [...occ.keys()].filter((k) => re.test(k)).length;
  const F = STORAGE.fridge, R = STORAGE.rack, B = STORAGE.boxes;
  const fridgeCap = F.shelves * (F.front + F.back) + F.bulk;
  const boxCap = B.letters.length * B.perBox;
  let hitLine = '';
  if (hits) {
    const hw = store.wines.filter((w) => hits.has(w.id));
    const placed = hw.reduce((n, w) => n + w.locs.length, 0);
    hitLine = `<p class="hit-line">${placed ? `<b>${plural(placed, 'bottle')}</b> of ${plural(hw.length, 'wine')} lit up below` : 'Nothing in the cellar matches'} · <button class="link" data-clear>clear</button></p>`;
  }
  $('#view-cellar').innerHTML = `
    ${trayHTML()}
    ${hitLine}
    <div class="cellar-grid${ui.placing ? ' placing' : ''}">
      <article class="unit unit-fridge">
        ${unitHead(STORAGE.fridge.label, STORAGE.fridge.model, count(/^F/), fridgeCap)}
        ${fridgeSVG(occ, hits)}
        <p class="legend">Shelf 1 is the top · front row faces you, back row sits behind it</p>
      </article>
      <div class="cellar-side">
        <article class="unit unit-rack">
          ${unitHead(STORAGE.rack.label, STORAGE.rack.model, count(/^R/), R.rows * R.cols)}
          ${rackSVG(occ, hits)}
          <p class="legend">Row 1 is the top · columns count from the left</p>
        </article>
        <article class="unit unit-boxes">
          ${unitHead(STORAGE.boxes.label, STORAGE.boxes.model, count(/^BOX/), boxCap)}
          <div class="boxes">${B.letters.map((L) => boxSVG(L, occ, hits)).join('')}</div>
        </article>
        <div class="key">
          ${[['red', 'Red'], ['white', 'White'], ['rose', 'Rosé'], ['sparkling', 'Sparkling'], ['sparkling-rose', 'Sparkling rosé'], ['other', 'Liqueur']]
            .map(([k, l]) => `<span><i class="dot st-${k}"></i>${l}</span>`).join('')}
        </div>
      </div>
    </div>`;
  if (ui.focusSlot) {
    const el = $(`[data-slot="${ui.focusSlot}"]`, $('#view-cellar'));
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

// ---------- rendering: collection ----------

const SORTS = {
  soonest: ['Drink soonest', (a, b) => (a.best_year_to_drink ?? 9999) - (b.best_year_to_drink ?? 9999) || (a.drink_end ?? 9999) - (b.drink_end ?? 9999)],
  name: ['Name', (a, b) => a.wine_name.localeCompare(b.wine_name)],
  region: ['Region', (a, b) => a.region.localeCompare(b.region)],
  bottles: ['Most bottles', (a, b) => b.bottles - a.bottles],
  value: ['Highest price', (a, b) => (b.retail_price_usd || 0) - (a.retail_price_usd || 0)],
  vintage: ['Oldest vintage', (a, b) => (parseInt(a.vintage) || 9999) - (parseInt(b.vintage) || 9999)],
  rating: ['My rating', (a, b) => (b.my_rating || 0) - (a.my_rating || 0)],
};

function windowBar(w, compact = false) {
  const { drink_start: s, drink_end: e, best_year_to_drink: b } = w;
  if (s == null || e == null) return '';
  const lo = Math.min(s, YEAR) - 1, hi = Math.max(e, YEAR) + 1;
  const pos = (y) => ((y - lo) / (hi - lo)) * 100;
  const st = windowStatus(w);
  return `<div class="wbar${compact ? ' compact' : ''} st-${st.key}" aria-label="Drink ${s}–${e}, best ${b ?? '—'}">
    <div class="wbar-track">
      <span class="wbar-win" style="left:${pos(s)}%;width:${pos(e) - pos(s)}%"></span>
      ${b != null ? `<span class="wbar-best" style="left:${pos(b)}%" title="Best ${b}"></span>` : ''}
      <span class="wbar-now" style="left:${pos(YEAR)}%"></span>
    </div>
    ${compact ? '' : `<div class="wbar-labels"><span style="left:${pos(s)}%">${s}</span>${b != null && b !== s && b !== e ? `<span class="best" style="left:${pos(b)}%">${b}</span>` : ''}<span style="left:${pos(e)}%">${e}</span><span class="now" style="left:${pos(YEAR)}%">now</span></div>`}
  </div>`;
}

function renderCollection() {
  const list = store.wines.filter(matches).sort(SORTS[ui.sort][1]);
  const inStock = list.filter((w) => w.bottles > 0);
  const gone = list.filter((w) => w.bottles <= 0);
  const row = (w) => {
    const st = windowStatus(w);
    return `<li><button class="wine-row${ui.selected === w.id ? ' sel' : ''}" data-open="${w.id}">
      <i class="swatch st-${style(w)}"></i>
      <span class="wr-main">
        <span class="wr-name">${esc(w.wine_name)}</span>
        <span class="wr-sub">${esc(w.vintage || 'NV')} · ${esc(w.region)} · ${esc(w.varietal)}</span>
      </span>
      <span class="wr-window">${windowBar(w, true)}<span class="wr-status st-${st.key}">${st.label}</span></span>
      <span class="wr-where">${esc(whereSummary(w))}</span>
      <span class="wr-count"><b>${w.bottles}</b>${w.my_rating ? `<span class="stars-mini">${'★'.repeat(Math.round(w.my_rating))}</span>` : ''}</span>
    </button></li>`;
  };
  $('#view-collection').innerHTML = `
    <div class="list-head">
      <p><b>${plural(inStock.length, 'wine')}</b> · ${plural(inStock.reduce((n, w) => n + w.bottles, 0), 'bottle')}${filtering() ? ' matching' : ''}</p>
      <label class="select">Sort <select id="sort">${Object.entries(SORTS)
        .map(([k, [label]]) => `<option value="${k}"${k === ui.sort ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
    </div>
    <ul class="wine-list">${inStock.map(row).join('') || '<li class="empty-state">No wines match.</li>'}</ul>
    ${gone.length ? `<h3 class="section-label">Finished</h3><ul class="wine-list gone">${gone.map(row).join('')}</ul>` : ''}`;
}

// ---------- rendering: journal ----------

function stars(n) {
  if (!n) return '';
  return `<span class="stars" aria-label="${n} of 5">${'★'.repeat(n)}<span class="off">${'★'.repeat(5 - n)}</span></span>`;
}

function entryHTML(l, withName = true) {
  const w = store.byId(l.id);
  const date = l.date ? new Date(`${l.date}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  return `<article class="entry${l.pending ? ' pending' : ''}">
    <div class="entry-meta"><time>${esc(date)}</time><span class="entry-kind">${l.event === 'drank' ? 'Opened' : 'Note'}</span>${l.pending ? '<span class="entry-kind">syncing</span>' : ''}</div>
    ${withName ? `<button class="entry-wine" data-open="${esc(l.id)}"><i class="dot st-${w ? style(w) : 'other'}"></i>${esc(l.wine_name)} <em>${esc(l.vintage)}</em></button>` : ''}
    ${stars(l.rating)}
    ${l.food ? `<p class="entry-food">with ${esc(l.food)}</p>` : ''}
    ${l.notes ? `<p class="entry-notes">${esc(l.notes)}</p>` : ''}
  </article>`;
}

const byNewest = (a, b) => String(b.date).localeCompare(String(a.date)) || String(b.logged_at).localeCompare(String(a.logged_at));

function renderJournal() {
  const q = fold(ui.q);
  const entries = store.log
    .filter((l) => !q || fold([l.wine_name, l.notes, l.food].join(' ')).includes(q))
    .sort(byNewest);
  $('#view-journal').innerHTML = entries.length
    ? `<div class="journal">${entries.map((l) => entryHTML(l)).join('')}</div>`
    : `<div class="empty-state big">
        <h2>The journal is empty</h2>
        <p>Open a bottle from the map or the collection, choose <b>Open a bottle tonight</b>, and jot down what you thought. Notes land here and in the <code>my_notes</code> column of the sheet.</p>
      </div>`;
}

// ---------- drawer ----------

function openDrawer(id, slot = null) {
  ui.selected = id;
  ui.focusSlot = slot;
  history.replaceState(null, '', `#wine=${id}`);
  $('#drawer').hidden = false;
  $('#scrim').hidden = false;
  document.body.classList.add('drawer-open');
  render();
  $('#drawer').scrollTop = 0;
}

function closeDrawer() {
  ui.selected = null;
  ui.focusSlot = null;
  history.replaceState(null, '', location.pathname + location.search);
  $('#drawer').hidden = true;
  $('#scrim').hidden = true;
  document.body.classList.remove('drawer-open');
  render();
}

function renderDrawer() {
  const w = store.byId(ui.selected);
  if (!w) return;
  const st = windowStatus(w);
  const locs = sortLocs(w.locs);
  const unplaced = Math.max(0, w.bottles - w.locs.length);
  const entries = store.log.filter((l) => l.id === w.id).sort(byNewest);
  const legacyNotes = !entries.length && w.my_notes;
  $('#drawer').innerHTML = `
    <header class="d-head st-${style(w)}">
      <button class="icon-btn d-close" data-close aria-label="Close">✕</button>
      <p class="eyebrow"><i class="dot st-${style(w)}"></i>${esc(w.wine_type)} · ${esc(w.vintage || 'NV')}</p>
      <h2>${esc(w.wine_name)}</h2>
      <p class="d-region">${esc(w.region)}</p>
      <p class="d-varietal">${esc(w.varietal)}${w.retail_price_usd ? ` · ~${money(w.retail_price_usd)}` : ''}</p>
    </header>
    <div class="d-body">
      <section class="d-window">
        <div class="d-row"><h3>Drinking window</h3><span class="status st-${st.key}">${st.label}</span></div>
        ${windowBar(w)}
      </section>

      <section>
        <div class="d-row"><h3>Where it is</h3><span class="muted">${plural(w.bottles, 'bottle')}</span></div>
        <ul class="locs">
          ${groupLocs(locs).map((g) => `<li class="${g.slots.includes(ui.focusSlot) ? 'focus' : ''}">
              <button class="loc" data-show="${g.slot}"><code>${g.code}</code><span>${esc(g.label)}</span></button>
              <button class="loc-move" data-move="${g.slot}" title="Move ${g.box ? 'one of these bottles' : 'this bottle'}">Move</button>
            </li>`).join('')}
        </ul>
        ${unplaced ? `<p class="warn">${plural(unplaced, 'bottle')} without a spot. <button class="link" data-place="${w.id}">Give it a spot</button></p>` : ''}
        ${!w.bottles ? '<p class="muted">All bottles have been opened.</p>' : ''}
      </section>

      <div class="d-actions">
        <button class="btn primary" data-act="drink" ${w.bottles < 1 ? 'disabled' : ''}>Open a bottle tonight</button>
        <button class="btn" data-act="note">Add a note</button>
      </div>

      <section class="d-notes">
        <div class="d-row"><h3>My notes</h3>${w.my_rating ? `<span class="muted">avg ${stars(Math.round(w.my_rating))} ${w.my_rating}</span>` : ''}</div>
        ${entries.length ? entries.map((l) => entryHTML(l, false)).join('') : ''}
        ${legacyNotes ? `<p class="pre">${esc(w.my_notes)}</p>` : ''}
        ${!entries.length && !legacyNotes ? '<p class="muted">Nothing yet. Open one and tell future-you what you thought.</p>' : ''}
      </section>

      <section>
        <h3>In the glass</h3>
        <p>${esc(w.broad_flavor_notes)}</p>
        <h3>At the table</h3>
        <p>${esc(w.good_pairings)}</p>
      </section>

      <section class="teaser">
        <h3>Explore ${esc(w.region.split(',')[0])}</h3>
        <p>A 3D flyover of the vineyards and how the ${esc(w.vintage || 'vintage')} growing season compared with an average year. Coming soon.</p>
      </section>
    </div>`;
}

// ---------- dialogs ----------

function openDialog(html, onSubmit) {
  const dlg = $('#dialog');
  dlg.innerHTML = html;
  const form = $('form', dlg);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    dlg.close();
    await onSubmit(data);
  });
  $$('[data-cancel]', dlg).forEach((b) => b.addEventListener('click', () => dlg.close()));
  dlg.showModal();
  $('textarea, input:not([type=radio]):not([type=hidden])', dlg)?.focus();
}

function starInput(name = 'rating') {
  return `<fieldset class="star-input"><legend>Rating</legend>
    ${[5, 4, 3, 2, 1].map((n) => `<input type="radio" id="${name}-${n}" name="${name}" value="${n}"><label for="${name}-${n}" title="${n} star${n > 1 ? 's' : ''}">★</label>`).join('')}
  </fieldset>`;
}

function drinkDialog(w) {
  const locs = sortLocs(w.locs);
  const unplaced = w.bottles > w.locs.length;
  const choices = [
    ...groupLocs(locs).map((g, i) => `<label class="radio"><input type="radio" name="slot" value="${g.box ? g.slots[g.slots.length - 1] : g.slot}" ${i === 0 && !unplaced ? 'checked' : ''}><code>${g.code}</code><span>${esc(g.label)}</span></label>`),
    unplaced ? `<label class="radio"><input type="radio" name="slot" value="" checked><code>—</code><span>A bottle without a spot</span></label>` : '',
  ].join('');
  openDialog(
    `<form class="form">
      <p class="eyebrow">Opening tonight</p>
      <h2>${esc(w.wine_name)} <em>${esc(w.vintage)}</em></h2>
      <fieldset class="choices"><legend>Which bottle?</legend>${choices}</fieldset>
      <div class="form-row">
        <label>Date<input type="date" name="date" value="${today()}" required></label>
        ${starInput()}
      </div>
      <label>What did you eat?<input name="food" placeholder="${esc((w.good_pairings || '').split(',')[0])}"></label>
      <label>Notes<textarea name="notes" rows="4" placeholder="Nose, palate, how it opened up, buy again?"></textarea></label>
      <p class="hint">You can come back and add more notes later.</p>
      <div class="form-actions"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Log it &amp; free the spot</button></div>
    </form>`,
    async (d) => {
      await store.apply({ action: 'drink', id: w.id, slot: d.slot || '', date: d.date, rating: Number(d.rating) || null, food: d.food.trim(), notes: d.notes.trim() });
      toast(d.slot ? `Enjoy! ${slotLabel(d.slot)} is free now.` : 'Enjoy! Logged in your journal.');
    },
  );
}

function noteDialog(w) {
  openDialog(
    `<form class="form">
      <p class="eyebrow">Add a note</p>
      <h2>${esc(w.wine_name)} <em>${esc(w.vintage)}</em></h2>
      <div class="form-row">
        <label>Date<input type="date" name="date" value="${today()}" required></label>
        ${starInput()}
      </div>
      <label>Notes<textarea name="notes" rows="5" required placeholder="Day-two impressions, a friend's bottle of the same wine, what to pair next time…"></textarea></label>
      <div class="form-actions"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Save note</button></div>
    </form>`,
    async (d) => {
      await store.apply({ action: 'note', id: w.id, date: d.date, rating: Number(d.rating) || null, notes: d.notes.trim() });
      toast('Note saved.');
    },
  );
}

function settingsDialog() {
  const url = store.url;
  openDialog(
    `<form class="form">
      <p class="eyebrow">Settings</p>
      <h2>Sync with Google Sheets</h2>
      <p class="hint">Notes, opened bottles and moves are saved to the sheet through a small Apps Script. Setup steps are in the repo's README.</p>
      <label>Apps Script web app URL<input name="url" type="url" value="${esc(url)}" placeholder="https://script.google.com/macros/s/…/exec"></label>
      <label>Passphrase<input name="token" type="password" value="${esc(store.token)}" autocomplete="current-password" placeholder="The WRITE_TOKEN you set in Apps Script"></label>
      <p class="hint">Saved only in this browser. Status: <b>${esc($('#sync-status').textContent)}</b></p>
      <div class="form-extra">
        <button type="button" class="btn" id="export-csv">Download CSV</button>
        ${!store.remote ? '<button type="button" class="btn" id="reset-local">Discard local changes</button>' : ''}
      </div>
      <div class="form-actions"><button type="button" class="btn" data-cancel>Close</button><button class="btn primary">Save &amp; reload</button></div>
    </form>`,
    async (d) => {
      store.url = d.url === CONFIG.appsScriptUrl ? '' : d.url;
      store.token = d.token;
      await store.load();
      if (store.remote && store.outbox.length) await store.flush();
      toast(store.source === 'live' ? 'Connected to the sheet.' : 'Saved.');
    },
  );
  $('#export-csv').addEventListener('click', () => {
    const blob = new Blob([store.toCSV()], { type: 'text/csv' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `wine-collection-${today()}.csv` });
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $('#reset-local')?.addEventListener('click', async () => {
    if (!confirm('Discard every change made in this browser and reload the snapshot?')) return;
    $('#dialog').close();
    await store.resetLocal();
    toast('Back to the snapshot.');
  });
}

// ---------- placing / moving ----------

function startPlacing(id, from) {
  ui.placing = { id, from };
  if (ui.view !== 'cellar') setView('cellar');
  if (matchMedia('(max-width: 900px)').matches) {
    $('#drawer').hidden = true;
    $('#scrim').hidden = true;
    document.body.classList.remove('drawer-open');
  }
  render();
}

function stopPlacing() {
  ui.placing = null;
  if (ui.selected) {
    $('#drawer').hidden = false;
    $('#scrim').hidden = false;
    document.body.classList.add('drawer-open');
  }
  render();
}

function renderPlacingBanner() {
  const el = $('#placing-banner');
  const p = ui.placing;
  el.hidden = !p;
  if (!p) return;
  const w = store.byId(p.id);
  el.innerHTML = `<span><i class="dot st-${style(w)}"></i><b>${esc(w.wine_name)}</b> — ${
    p.from ? `moving from <code>${p.from}</code>. Tap an empty spot, or another bottle to swap.` : 'tap an empty spot for it.'
  }</span><button class="btn" data-stop-placing>Cancel</button>`;
}

async function handlePlace(slot) {
  const p = ui.placing;
  const occ = occupancy();
  const other = occ.get(slot);
  if (slot === p.from) return stopPlacing();
  if (!p.from && other) return toast('That spot is taken — pick an empty one.');
  if (other && other.id !== p.id && !confirm(`Swap with ${other.wine_name} ${other.vintage}?`)) return;
  ui.placing = null;
  ui.focusSlot = slot;
  await store.apply(p.from ? { action: 'move', id: p.id, from: p.from, to: slot } : { action: 'place', id: p.id, to: slot });
  toast(`Now at ${slotLabel(slot)}.`);
  stopPlacing();
}

// ---------- misc ui ----------

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3200);
}

function setView(v) {
  ui.view = v;
  $$('.tabs button').forEach((b) => (b.getAttribute('data-view') === v ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  for (const name of ['cellar', 'collection', 'journal']) $(`#view-${name}`).hidden = name !== v;
  render();
}

function showTooltip(e, slot) {
  const w = occupancy().get(slot);
  const tip = $('#tooltip');
  tip.innerHTML = w
    ? `<b>${esc(w.wine_name)}</b><span>${esc(w.vintage || 'NV')} · ${esc(w.region.split(',')[0])}</span><code>${slot}</code> <span>${esc(windowStatus(w).label)}</span>`
    : `<code>${slot}</code> <span>Empty${ui.placing ? ' — tap to place here' : ''}</span>`;
  tip.hidden = false;
  const pad = 14;
  const { innerWidth: vw, innerHeight: vh } = window;
  const r = tip.getBoundingClientRect();
  let x = e.clientX + pad, y = e.clientY + pad;
  if (x + r.width > vw - 8) x = e.clientX - r.width - pad;
  if (y + r.height > vh - 8) y = e.clientY - r.height - pad;
  tip.style.transform = `translate(${x}px, ${y}px)`;
}

function surprise() {
  const pool = store.wines.filter((w) => w.bottles > 0 && matches(w) && windowStatus(w).ready && accessRank(sortLocs(w.locs)[0]) < 5);
  if (!pool.length) return toast('Nothing ready matches — loosen the filters.');
  // Favour wines at or past their peak.
  const weight = (w) => (w.best_year_to_drink != null && w.best_year_to_drink <= YEAR ? 3 : 1);
  let r = Math.random() * pool.reduce((n, w) => n + weight(w), 0);
  const pick = pool.find((w) => (r -= weight(w)) < 0) || pool[0];
  if (ui.view !== 'cellar') setView('cellar');
  openDrawer(pick.id, sortLocs(pick.locs)[0] || null);
}

// ---------- events ----------

function bind() {
  $('#sheet-link').href = CONFIG.sheetUrl;

  $('.tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (b) setView(b.dataset.view);
  });

  let qTimer;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      ui.q = e.target.value;
      render();
    }, 80);
  });
  $('#type-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-type]');
    if (!b) return;
    ui.type = b.dataset.type;
    render();
  });
  $('#drink-now').addEventListener('change', (e) => {
    ui.drinkNow = e.target.checked;
    render();
  });
  $('#surprise').addEventListener('click', surprise);
  $('#settings-btn').addEventListener('click', settingsDialog);
  $('#scrim').addEventListener('click', closeDrawer);

  // One delegated handler for everything rendered dynamically.
  document.addEventListener('click', (e) => {
    const t = e.target;
    const slotEl = t.closest('[data-slot]');
    if (slotEl && t.closest('.map')) {
      if (ui.placing) return handlePlace(slotEl.dataset.slot);
      if (slotEl.dataset.id) return openDrawer(slotEl.dataset.id, slotEl.dataset.slot);
      return;
    }
    const open = t.closest('[data-open]');
    if (open) {
      e.preventDefault();
      return openDrawer(open.dataset.open);
    }
    if (t.closest('[data-close]')) return closeDrawer();
    if (t.closest('[data-clear]')) {
      ui.q = '';
      ui.type = 'all';
      ui.drinkNow = false;
      $('#q').value = '';
      $('#drink-now').checked = false;
      return render();
    }
    if (t.closest('[data-stop-placing]')) return stopPlacing();
    const place = t.closest('[data-place]');
    if (place) return startPlacing(place.dataset.place, null);
    const move = t.closest('[data-move]');
    if (move) return startPlacing(ui.selected, move.dataset.move);
    const show = t.closest('[data-show]');
    if (show) {
      ui.focusSlot = show.dataset.show;
      if (ui.view !== 'cellar') setView('cellar');
      else render();
      if (matchMedia('(max-width: 900px)').matches) {
        $('#drawer').hidden = true;
        $('#scrim').hidden = true;
        document.body.classList.remove('drawer-open');
        toast(slotLabel(show.dataset.show));
      }
      return;
    }
    const act = t.closest('[data-act]');
    if (act) {
      const w = store.byId(ui.selected);
      if (act.dataset.act === 'drink') drinkDialog(w);
      if (act.dataset.act === 'note') noteDialog(w);
    }
  });

  document.addEventListener('change', (e) => {
    if (e.target.id === 'sort') {
      ui.sort = e.target.value;
      render();
    }
  });

  document.addEventListener('keydown', (e) => {
    const typing = /input|textarea|select/i.test(document.activeElement?.tagName);
    if (e.key === '/' && !typing) {
      e.preventDefault();
      $('#q').focus();
    } else if (e.key === 'Escape' && !$('#dialog').open) {
      if (ui.placing) stopPlacing();
      else if (ui.selected) closeDrawer();
    } else if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('.map [data-slot]')) {
      e.preventDefault();
      e.target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
  });

  document.addEventListener('pointerover', (e) => {
    const s = e.target.closest?.('.map [data-slot]');
    if (s && e.pointerType === 'mouse') showTooltip(e, s.dataset.slot);
  });
  document.addEventListener('pointermove', (e) => {
    const s = e.target.closest?.('.map [data-slot]');
    if (s && e.pointerType === 'mouse') showTooltip(e, s.dataset.slot);
    else $('#tooltip').hidden = true;
  });

  const hideTip = () => ($('#tooltip').hidden = true);
  document.addEventListener('pointerdown', hideTip);
  window.addEventListener('scroll', hideTip, { passive: true });

  store.addEventListener('change', render);
  store.addEventListener('auth', () => {
    toast('The sheet needs your passphrase.');
    settingsDialog();
  });
  window.addEventListener('online', () => store.flush());
}

function openFromHash() {
  const m = /wine=([\w-]+)/.exec(location.hash);
  if (m && store.byId(m[1]) && ui.selected !== m[1]) openDrawer(m[1]);
}

bind();
window.addEventListener('hashchange', openFromHash);
store.load().then(openFromHash).catch((err) => {
  $('#sync-status').textContent = `Couldn't load the collection: ${err.message}`;
});
