/**
 * Wine Guide — Google Sheets backend.
 *
 * Paste this into the sheet's Extensions → Apps Script editor, set the
 * WRITE_TOKEN script property, and deploy as a web app (see README.md).
 *
 * GET  ?action=get          → { wines: [...], log: [...] }
 * POST {token, action, ...} → same payload after applying the change
 *   drink  {id, slot, date, rating, notes, food}   open a bottle + log it
 *   note   {id, date, rating, notes}               log a note, no bottle used
 *   move   {id, from, to}                          move a bottle (swaps if `to` is taken)
 *   place  {id, to}                                give an unplaced bottle a slot
 *
 * POST bodies are sent as text/plain so the browser skips the CORS preflight.
 */

const WINE_SHEET = 'Sheet1';
const LOG_SHEET = 'tasting_log';
const EXTRA_COLS = ['id', 'locations', 'my_rating', 'my_notes'];
const LOG_COLS = ['logged_at', 'date', 'event', 'id', 'wine_name', 'vintage', 'rating', 'notes', 'food', 'slot'];

function doGet() {
  return json_(readAll_());
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ error: 'Bad JSON' });
  }
  const token = PropertiesService.getScriptProperties().getProperty('WRITE_TOKEN');
  if (!token || req.token !== token) return json_({ error: 'unauthorized' });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const t = wineTable_();
    const row = t.rows.find((r) => r.values.id === req.id);
    if (!row) return json_({ error: 'Unknown wine id ' + req.id });

    if (req.action === 'drink') {
      const locs = splitLocs_(row.values.locations);
      const i = req.slot ? locs.indexOf(req.slot) : locs.length - 1;
      if (i >= 0) locs.splice(i, 1);
      t.set(row, 'locations', locs.join('; '));
      t.set(row, 'bottles', Math.max(0, Number(row.values.bottles || 0) - 1));
      appendLog_(req, row.values, 'drank');
      appendNote_(t, row, req);
    } else if (req.action === 'note') {
      appendLog_(req, row.values, 'note');
      appendNote_(t, row, req);
    } else if (req.action === 'move') {
      const locs = splitLocs_(row.values.locations);
      const i = locs.indexOf(req.from);
      if (i < 0) return json_({ error: req.from + ' is not a bottle of this wine' });
      const other = t.rows.find((r) => splitLocs_(r.values.locations).indexOf(req.to) >= 0);
      if (other && other !== row) {
        const o = splitLocs_(other.values.locations);
        o[o.indexOf(req.to)] = req.from;
        t.set(other, 'locations', o.join('; '));
        locs[i] = req.to;
      } else if (other === row) {
        locs[locs.indexOf(req.to)] = req.from;
        locs[i] = req.to;
      } else {
        locs[i] = req.to;
      }
      t.set(row, 'locations', locs.join('; '));
    } else if (req.action === 'place') {
      if (t.rows.some((r) => splitLocs_(r.values.locations).indexOf(req.to) >= 0)) {
        return json_({ error: req.to + ' is already taken' });
      }
      const locs = splitLocs_(row.values.locations);
      locs.push(req.to);
      t.set(row, 'locations', locs.join('; '));
    } else {
      return json_({ error: 'Unknown action ' + req.action });
    }
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  return json_(readAll_());
}

// ---------- sheet helpers ----------

function wineTable_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(WINE_SHEET);
  let header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  EXTRA_COLS.forEach((c) => {
    if (header.indexOf(c) < 0) {
      sh.getRange(1, header.length + 1).setValue(c);
      header.push(c);
    }
  });
  const n = Math.max(0, sh.getLastRow() - 1);
  const data = n ? sh.getRange(2, 1, n, header.length).getValues() : [];
  const col = (name) => header.indexOf(name) + 1;
  const rows = data
    .map((r, i) => ({ rowNum: i + 2, values: Object.fromEntries(header.map((h, j) => [h, r[j]])) }))
    .filter((r) => String(r.values.wine_name || '').trim() !== '');

  // Give new rows a stable id.
  let max = rows.reduce((m, r) => Math.max(m, Number(String(r.values.id).replace(/\D/g, '')) || 0), 0);
  rows.forEach((r) => {
    if (!r.values.id) {
      r.values.id = 'w' + String(++max).padStart(3, '0');
      sh.getRange(r.rowNum, col('id')).setValue(r.values.id);
    }
  });

  return {
    header,
    rows,
    set(row, name, value) {
      row.values[name] = value;
      sh.getRange(row.rowNum, col(name)).setValue(value);
    },
  };
}

function logSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(LOG_SHEET);
  if (!sh) {
    sh = ss.insertSheet(LOG_SHEET);
    sh.appendRow(LOG_COLS);
  }
  return sh;
}

function appendLog_(req, wine, event) {
  logSheet_().appendRow([
    new Date().toISOString(),
    req.date || today_(),
    event,
    wine.id,
    wine.wine_name,
    wine.vintage,
    req.rating || '',
    req.notes || '',
    req.food || '',
    event === 'drank' ? req.slot || '' : '',
  ]);
}

// my_notes keeps a human-readable running journal in the main sheet;
// my_rating is the average of every rating logged for the wine.
function appendNote_(t, row, req) {
  const stars = req.rating ? ' ' + '★'.repeat(Number(req.rating)) : '';
  const food = req.food ? ' (with ' + req.food + ')' : '';
  const line = '[' + (req.date || today_()) + ']' + stars + food + (req.notes ? ' ' + req.notes : '');
  const prev = String(row.values.my_notes || '').trim();
  t.set(row, 'my_notes', prev ? prev + '\n' + line : line);

  const ratings = readLog_()
    .filter((l) => l.id === row.values.id && Number(l.rating) > 0)
    .map((l) => Number(l.rating));
  if (ratings.length) {
    t.set(row, 'my_rating', Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10);
  }
}

function readLog_() {
  const sh = logSheet_();
  const values = sh.getDataRange().getValues();
  const header = values.shift().map(String);
  return values.map((r) => Object.fromEntries(header.map((h, j) => [h, r[j] instanceof Date ? isoDate_(r[j]) : r[j]])));
}

function readAll_() {
  const t = wineTable_();
  const wines = t.rows.map((r) =>
    Object.fromEntries(Object.entries(r.values).map(([k, v]) => [k, v instanceof Date ? isoDate_(v) : v])));
  return { wines, log: readLog_(), fetched: new Date().toISOString() };
}

function splitLocs_(s) {
  return String(s || '').split(/[;,]/).map((x) => x.trim()).filter(Boolean);
}

function today_() {
  return isoDate_(new Date());
}

function isoDate_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
