// Builds the initial storage plan: gives every bottle a slot in the fridge,
// rack or a box, and writes data/wines.json (the site's offline snapshot).
//
//   node scripts/assign-layout.mjs <sheet-export.csv> [out.json]
//
// Strategy
//   Fridge (wine_fridge_storage = yes): sparkling goes in the bottom bulk area;
//     still wines fill shelves top-down, drink-soonest at eye level, longest
//     agers at the bottom. A wine is never split across shelves if avoidable;
//     each wine gets a front-row bottle (label visible) with extras behind it.
//   Rack (no): every wine gets at least one bottle on the rack so you can see
//     it, extra rack spots go to wines that should be drunk soonest. Rows run
//     sparkling → white → rosé → red.
//   Boxes: the remainder, each wine kept together in one box where possible.

import fs from 'node:fs';
import path from 'node:path';
import { STORAGE, boxSlots } from '../js/storage.js';

const [, , csvPath, outPath = 'data/wines.json'] = process.argv;
if (!csvPath) {
  console.error('usage: node scripts/assign-layout.mjs <sheet-export.csv> [out.json]');
  process.exit(1);
}

const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
const header = rows.shift();
const wines = rows
  .filter((r) => r.some((v) => v !== ''))
  .map((r, i) => {
    const o = Object.fromEntries(header.map((h, j) => [h, clean(r[j])]));
    o.id = o.id || `w${String(i + 1).padStart(3, '0')}`;
    o.bottles = Number(o.bottles) || 0;
    o.retail_price_usd = o.retail_price_usd === '' ? null : Number(o.retail_price_usd);
    for (const k of ['drink_start', 'drink_end', 'best_year_to_drink']) o[k] = o[k] === '' ? null : Number(o[k]);
    o.locations = [];
    o.my_rating = o.my_rating ?? '';
    o.my_notes = o.my_notes ?? '';
    return o;
  });

const TYPE_ORDER = ['Sparkling White', 'Sparkling Rosé', 'Sparkling Red', 'White', 'Rosé', 'Red', 'Liqueur'];
const typeRank = (w) => {
  const i = TYPE_ORDER.indexOf(w.wine_type);
  return i === -1 ? TYPE_ORDER.length : i;
};
const urgency = (a, b) =>
  (a.best_year_to_drink ?? 9999) - (b.best_year_to_drink ?? 9999) ||
  (a.drink_end ?? 9999) - (b.drink_end ?? 9999) ||
  a.wine_name.localeCompare(b.wine_name);
const isSparkling = (w) => /sparkling/i.test(w.wine_type);

// ---------- fridge ----------
const F = STORAGE.fridge;
const perShelf = F.front + F.back;
const fridgeWines = wines.filter((w) => /^y/i.test(w.wine_fridge_storage));
const sparkling = fridgeWines.filter(isSparkling).sort(urgency);
const still = fridgeWines.filter((w) => !isSparkling(w)).sort((a, b) => urgency(a, b) || typeRank(a) - typeRank(b));

// Bulk area: all sparkling, then top it up with the longest-aging still wines
// whose bottle count fills the leftover space exactly.
const bulkQueue = sparkling.map((w) => [w, w.bottles]);
let bulkFree = F.bulk - sparkling.reduce((n, w) => n + w.bottles, 0);
const queue = [...still];
for (let i = queue.length - 1; i >= 0 && bulkFree > 0; i--) {
  if (queue[i].bottles <= bulkFree) {
    bulkQueue.push([queue[i], queue[i].bottles]);
    bulkFree -= queue[i].bottles;
    queue.splice(i, 1);
  }
}

// Shelves, top-down. Each shelf takes the earliest-drinking wines whose
// counts fill it exactly (subset sum over the next few wines in line).
const shelves = Array.from({ length: F.shelves }, () => []); // [wine, count][]
for (let s = 0; s < F.shelves && queue.length; s++) {
  if (queue[0].bottles > perShelf) {
    // Bigger than a whole shelf: fill this shelf with part of it.
    shelves[s].push([queue[0], perShelf]);
    queue[0] = { ...queue[0], bottles: queue[0].bottles - perShelf, _ref: queue[0]._ref || queue[0] };
    continue;
  }
  const pick = bestSubset(queue.slice(0, 14).map((w) => w.bottles), perShelf);
  for (const i of pick) shelves[s].push([queue[i]._ref || queue[i], queue[i].bottles]);
  for (const i of [...pick].reverse()) queue.splice(i, 1);
}
// Whatever is left fills remaining gaps (split if needed), then the bulk area.
for (const w of queue) {
  let left = w.bottles;
  for (let s = F.shelves - 1; s >= 0 && left > 0; s--) {
    const room = perShelf - shelves[s].reduce((n, [, c]) => n + c, 0);
    const n = Math.min(room, left);
    if (n > 0) { shelves[s].push([w._ref || w, n]); left -= n; }
  }
  if (left > 0) bulkQueue.push([w._ref || w, left]);
}

shelves.forEach((items, i) => {
  const shelf = i + 1;
  // Every wine gets a front-row bottle (label visible); spare front spots go
  // to the wines with the most bottles. Each wine sits together, left to
  // right, with its remaining bottles directly behind in the back row.
  const front = items.map(() => (items.length <= F.front ? 1 : 0));
  let spare = F.front - front.reduce((a, b) => a + b, 0);
  while (spare > 0) {
    let best = -1;
    items.forEach(([, c], k) => {
      if (front[k] < c && (best < 0 || c - front[k] > items[best][1] - front[best])) best = k;
    });
    if (best < 0) break;
    front[best]++;
    spare--;
  }
  let f = 1, b = 1;
  items.forEach(([w, c], k) => {
    for (let n = 0; n < front[k]; n++) w.locations.push(`F${shelf}-F${f++}`);
    for (let n = front[k]; n < c; n++) w.locations.push(`F${shelf}-B${b++}`);
  });
});

let bulkN = 1;
const overflow = [];
for (const [w, c] of bulkQueue) {
  for (let k = 0; k < c; k++) {
    if (bulkN <= F.bulk) w.locations.push(`FX-${bulkN++}`);
    else overflow.push(w);
  }
}

// ---------- rack ----------
const R = STORAGE.rack;
const rackCap = R.rows * R.cols;
const others = wines.filter((w) => !/^y/i.test(w.wine_fridge_storage));
const onRack = new Map(others.map((w) => [w, 0]));
const byUrgency = [...others].sort(urgency);
let used = 0;
for (let round = 1; used < rackCap; round++) {
  let placed = false;
  for (const w of byUrgency) {
    if (used >= rackCap) break;
    if (w.bottles >= round) { onRack.set(w, round); used++; placed = true; }
  }
  if (!placed) break;
}
const rackOrder = [...others]
  .sort((a, b) => typeRank(a) - typeRank(b) || a.region.localeCompare(b.region) || a.wine_name.localeCompare(b.wine_name))
  .flatMap((w) => Array(onRack.get(w)).fill(w));
rackOrder.forEach((w, k) => {
  const r = Math.floor(k / R.cols) + 1;
  const c = (k % R.cols) + 1;
  w.locations.push(`R${r}-${c}`);
});

// ---------- boxes ----------
const B = STORAGE.boxes;
const boxed = others
  .map((w) => [w, w.bottles - onRack.get(w)])
  .concat(overflow.map((w) => [w, 1]))
  .filter(([, c]) => c > 0)
  .sort((a, b) => b[1] - a[1] || urgency(a[0], b[0]));
const boxFill = B.letters.map(() => 0);
for (const [w, c] of boxed) {
  let left = c;
  // Prefer a single box that holds the whole lot; otherwise spill across boxes.
  let i = boxFill.findIndex((n) => B.perBox - n >= left);
  if (i === -1) i = boxFill.findIndex((n) => n < B.perBox);
  while (left > 0 && i !== -1 && i < B.letters.length) {
    const slots = boxSlots(B.letters[i]);
    while (left > 0 && boxFill[i] < B.perBox) {
      w.locations.push(slots[boxFill[i]++]);
      left--;
    }
    i = boxFill.findIndex((n) => n < B.perBox);
  }
  if (left > 0) console.warn(`No room left for ${left} bottle(s) of ${w.wine_name}`);
}

// ---------- output ----------
for (const w of wines) w.locations = w.locations.join('; ');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({ generated: new Date().toISOString(), wines, log: [] }, null, 2));

const count = (re) => wines.reduce((n, w) => n + w.locations.split('; ').filter((x) => re.test(x)).length, 0);
console.log(`wines: ${wines.length}, bottles: ${wines.reduce((n, w) => n + w.bottles, 0)}`);
console.log(`fridge shelves: ${count(/^F\d/)}, fridge bulk: ${count(/^FX/)}, rack: ${count(/^R/)}, boxes: ${count(/^BOX/)}`);
console.log(`wrote ${outPath}`);

// ---------- helpers ----------
// Indices (ascending) of a subset of `sizes` with the largest sum <= cap.
// Prefers subsets containing earlier items, so drink-soonest stays on top.
function bestSubset(sizes, cap) {
  let best = [], bestSum = -1;
  const walk = (i, sum, picked) => {
    if (sum > bestSum) { best = [...picked]; bestSum = sum; }
    if (bestSum === cap || i >= sizes.length) return;
    if (sum + sizes[i] <= cap) { picked.push(i); walk(i + 1, sum + sizes[i], picked); picked.pop(); }
    if (bestSum === cap) return;
    walk(i + 1, sum, picked);
  };
  walk(0, 0, []);
  return best;
}

function clean(v) {
  if (v == null) return '';
  const t = String(v).trim();
  return t === 'NA' ? '' : t;
}

function parseCsv(text) {
  const out = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); out.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); out.push(row); }
  return out;
}
