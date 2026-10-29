// Data layer. The Google Sheet (through the Apps Script web app) is the source
// of truth. Every change is applied locally first, queued in an outbox kept in
// localStorage, and sent to the sheet; the sheet's reply replaces local state.
// With no Apps Script URL, changes live in this browser only.

import { CONFIG } from './config.js';

const KEYS = {
  cache: 'wg.cache.v1',
  local: 'wg.local.v1',
  outbox: 'wg.outbox.v1',
  token: 'wg.token',
  url: 'wg.url',
};

const ls = {
  get(k, fallback = null) {
    try {
      const v = localStorage.getItem(k);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
  del(k) {
    try {
      localStorage.removeItem(k);
    } catch {}
  },
};

export const splitLocs = (s) =>
  (Array.isArray(s) ? s : String(s ?? '').split(/[;,]/)).map((x) => String(x).trim()).filter(Boolean);

export const today = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));

function normWine(w) {
  return {
    ...w,
    id: String(w.id),
    vintage: w.vintage == null ? '' : String(w.vintage),
    bottles: num(w.bottles) ?? 0,
    retail_price_usd: num(w.retail_price_usd),
    drink_start: num(w.drink_start),
    drink_end: num(w.drink_end),
    best_year_to_drink: num(w.best_year_to_drink),
    my_rating: num(w.my_rating),
    my_notes: w.my_notes ?? '',
    locs: splitLocs(w.locations),
  };
}

function normLog(l) {
  return { ...l, id: String(l.id), rating: num(l.rating), date: String(l.date ?? '').slice(0, 10) };
}

async function getJSON(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body),
  });
  return res.json();
}

class Store extends EventTarget {
  wines = [];
  log = [];
  source = 'loading'; // live | cache | snapshot | local
  syncedAt = null;
  error = null;
  flushing = false;

  get url() {
    return ls.get(KEYS.url) || CONFIG.appsScriptUrl || '';
  }
  set url(v) {
    v ? ls.set(KEYS.url, v.trim()) : ls.del(KEYS.url);
  }
  get token() {
    return ls.get(KEYS.token, '');
  }
  set token(v) {
    ls.set(KEYS.token, v);
  }
  get remote() {
    return Boolean(this.url);
  }
  get outbox() {
    return ls.get(KEYS.outbox, []);
  }
  set outbox(v) {
    ls.set(KEYS.outbox, v);
  }

  byId(id) {
    return this.wines.find((w) => w.id === id);
  }

  setData(data, source) {
    this.wines = (data.wines || []).filter((w) => w.wine_name).map(normWine);
    this.log = (data.log || []).map(normLog);
    this.source = source;
    if (source === 'live') this.syncedAt = new Date();
  }

  emit() {
    this.dispatchEvent(new Event('change'));
  }

  async load() {
    this.error = null;
    if (this.remote) {
      try {
        const data = await getJSON(`${this.url}?action=get`);
        this.setData(data, 'live');
        ls.set(KEYS.cache, data);
      } catch (err) {
        const cached = ls.get(KEYS.cache);
        if (cached) this.setData(cached, 'cache');
        else this.setData(await getJSON(CONFIG.snapshotUrl), 'snapshot');
        this.error = `Couldn't reach the Google Sheet (${err.message}).`;
      }
      for (const op of this.outbox) this.applyLocal(op);
      this.emit();
      if (this.outbox.length) this.flush();
    } else {
      const local = ls.get(KEYS.local);
      if (local) this.setData(local, 'local');
      else this.setData(await getJSON(CONFIG.snapshotUrl), 'snapshot');
      this.emit();
    }
  }

  async apply(op) {
    op = { ...op, date: op.date || today(), opId: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
    this.applyLocal(op);
    if (this.remote) {
      this.outbox = [...this.outbox, op];
      this.emit();
      await this.flush();
    } else {
      this.source = 'local';
      ls.set(KEYS.local, this.serialize());
      this.emit();
    }
  }

  async flush() {
    if (this.flushing || !this.remote) return;
    this.flushing = true;
    this.error = null;
    let stale = false;
    try {
      while (this.outbox.length) {
        const [op] = this.outbox;
        const res = await postJSON(this.url, { ...op, token: this.token });
        if (res.error === 'unauthorized') {
          this.error = 'unauthorized';
          this.dispatchEvent(new Event('auth'));
          break;
        }
        this.outbox = this.outbox.slice(1);
        if (res.error) {
          this.error = `The sheet rejected a change: ${res.error}`;
          stale = true;
        } else if (!this.outbox.length) {
          this.setData(res, 'live');
          ls.set(KEYS.cache, res);
          stale = false;
        }
      }
    } catch (err) {
      this.error = `Offline — ${this.outbox.length} change(s) will sync when the sheet is reachable.`;
    } finally {
      this.flushing = false;
    }
    if (stale) await this.load();
    else this.emit();
  }

  // Mirrors the Apps Script so the page updates instantly.
  applyLocal(op) {
    const w = this.byId(op.id);
    if (!w) return;
    const logEntry = (event) => ({
      logged_at: new Date().toISOString(),
      date: op.date,
      event,
      id: w.id,
      wine_name: w.wine_name,
      vintage: w.vintage,
      rating: op.rating || null,
      notes: op.notes || '',
      food: op.food || '',
      slot: event === 'drank' ? op.slot || '' : '',
      pending: this.remote,
    });
    const addNote = () => {
      const stars = op.rating ? ` ${'★'.repeat(op.rating)}` : '';
      const food = op.food ? ` (with ${op.food})` : '';
      const line = `[${op.date}]${stars}${food}${op.notes ? ` ${op.notes}` : ''}`;
      w.my_notes = w.my_notes ? `${w.my_notes}\n${line}` : line;
      const ratings = this.log.filter((l) => l.id === w.id && l.rating > 0).map((l) => l.rating);
      if (ratings.length) w.my_rating = Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10;
    };

    if (op.action === 'drink') {
      const i = op.slot ? w.locs.indexOf(op.slot) : w.locs.length - 1;
      if (i >= 0) w.locs.splice(i, 1);
      w.bottles = Math.max(0, w.bottles - 1);
      this.log.push(logEntry('drank'));
      addNote();
    } else if (op.action === 'note') {
      this.log.push(logEntry('note'));
      addNote();
    } else if (op.action === 'move') {
      const i = w.locs.indexOf(op.from);
      if (i < 0) return;
      const other = this.wines.find((x) => x.locs.includes(op.to));
      if (other) other.locs[other.locs.indexOf(op.to)] = op.from;
      w.locs[i] = op.to;
    } else if (op.action === 'place') {
      if (this.wines.some((x) => x.locs.includes(op.to))) return;
      w.locs.push(op.to);
    }
  }

  serialize() {
    return {
      wines: this.wines.map(({ locs, ...w }) => ({ ...w, locations: locs.join('; ') })),
      log: this.log,
    };
  }

  resetLocal() {
    ls.del(KEYS.local);
    ls.del(KEYS.outbox);
    return this.load();
  }

  toCSV() {
    const rows = this.serialize().wines;
    const cols = Object.keys(rows[0] || {});
    const cell = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
  }
}

export const store = new Store();
