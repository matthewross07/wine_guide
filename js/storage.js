// Physical storage model, shared by the site and scripts/assign-layout.mjs.
// If a shelf in real life holds a different number of bottles, change it here.
//
// Slot codes (stored in the sheet's `locations` column, separated by "; "):
//   F3-F2   fridge, shelf 3 (1 = top), front row, position 2 (from left)
//   F3-B4   fridge, shelf 3, back row, position 4
//   FX-7    fridge bulk area at the bottom (Champagne / odd shapes), spot 7
//   R5-9    rack, row 5 (1 = top), column 9 (from left)
//   BOXA-3  box A, bottle 3

export const STORAGE = {
  fridge: {
    label: 'Wine fridge',
    model: 'Vinotemp EL-100SBB · single zone',
    shelves: 9,
    front: 6,
    back: 5,
    bulk: 15,
  },
  rack: {
    label: 'Bamboo rack',
    model: 'VEVOR 8-tier modular',
    rows: 8,
    cols: 9,
  },
  boxes: {
    label: 'Boxes',
    model: '12-bottle cases beside the rack',
    letters: ['A', 'B', 'C', 'D', 'E', 'F'],
    perBox: 12,
  },
};

export function fridgeSlots() {
  const { shelves, front, back, bulk } = STORAGE.fridge;
  const out = [];
  for (let s = 1; s <= shelves; s++) {
    for (let p = 1; p <= front; p++) out.push(`F${s}-F${p}`);
    for (let p = 1; p <= back; p++) out.push(`F${s}-B${p}`);
  }
  for (let n = 1; n <= bulk; n++) out.push(`FX-${n}`);
  return out;
}

export function rackSlots() {
  const { rows, cols } = STORAGE.rack;
  const out = [];
  for (let r = 1; r <= rows; r++) for (let c = 1; c <= cols; c++) out.push(`R${r}-${c}`);
  return out;
}

export function boxSlots(letter) {
  const letters = letter ? [letter] : STORAGE.boxes.letters;
  return letters.flatMap((L) =>
    Array.from({ length: STORAGE.boxes.perBox }, (_, i) => `BOX${L}-${i + 1}`));
}

export function allSlots() {
  return [...fridgeSlots(), ...rackSlots(), ...boxSlots()];
}

export function parseSlot(id) {
  if (!id) return null;
  let m = /^F(\d+)-([FB])(\d+)$/.exec(id);
  if (m) return { unit: 'fridge', shelf: +m[1], row: m[2] === 'F' ? 'front' : 'back', pos: +m[3] };
  m = /^FX-(\d+)$/.exec(id);
  if (m) return { unit: 'fridge', shelf: 'bulk', pos: +m[1] };
  m = /^R(\d+)-(\d+)$/.exec(id);
  if (m) return { unit: 'rack', row: +m[1], col: +m[2] };
  m = /^BOX([A-Z])-(\d+)$/.exec(id);
  if (m) return { unit: 'box', box: m[1], pos: +m[2] };
  return null;
}

export function slotLabel(id) {
  const s = parseSlot(id);
  if (!s) return id;
  if (s.unit === 'fridge' && s.shelf === 'bulk') return `Fridge · bottom bulk area · spot ${s.pos}`;
  if (s.unit === 'fridge') return `Fridge · shelf ${s.shelf} · ${s.row} row, ${ordinal(s.pos)} from left`;
  if (s.unit === 'rack') return `Rack · row ${s.row} · ${ordinal(s.col)} from left`;
  return `Box ${s.box} · bottle ${s.pos}`;
}

export function slotShort(id) {
  const s = parseSlot(id);
  if (!s) return id;
  if (s.unit === 'fridge' && s.shelf === 'bulk') return 'Fridge bulk';
  if (s.unit === 'fridge') return `Fridge shelf ${s.shelf}`;
  if (s.unit === 'rack') return `Rack row ${s.row}`;
  return `Box ${s.box}`;
}

// Lower = easier to grab. Used to suggest which bottle to pull first.
export function accessRank(id) {
  const s = parseSlot(id);
  if (!s) return 99;
  if (s.unit === 'rack') return 1;
  if (s.unit === 'fridge' && s.row === 'front') return 2;
  if (s.unit === 'fridge' && s.row === 'back') return 3;
  if (s.unit === 'fridge') return 4;
  return 5;
}

function ordinal(n) {
  const suf = n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th';
  return `${n}${suf}`;
}
