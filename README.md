# Cellar Book

A map of the cellar, a tasting journal, and notes on every bottle. It's a static
site with no build step, served free on GitHub Pages. The Google Sheet
*Wine Collection Inventory* stays the source of truth.

**Site:** https://matthewross07.github.io/wine_guide/

- **Cellar map:** the Vinotemp fridge (9 shelves + bulk area), the VEVOR rack (8 × 9) and
  numbered 12-bottle boxes, drawn bottle by bottle. Search for a wine, region, grape or a
  dish ("lamb", "oysters") and every matching bottle lights up.
- **Open a bottle tonight:** pick which bottle, rate it, note what you ate and what you
  thought. The spot frees up on the map, `bottles` drops by one, and the note is saved
  to the sheet.
- **Move / place bottles:** tap *Move* next to any location, then tap an empty spot (or
  another bottle to swap).
- **Journal:** every tasting and note, newest first.

## How locations work

Each bottle has a slot code in the sheet's `locations` column (separated by `; `):

| Code     | Meaning                                                        |
|----------|----------------------------------------------------------------|
| `F3-F2`  | Fridge, shelf 3 (1 = top), front row, 2nd from left            |
| `F3-B4`  | Fridge, shelf 3, back row, 4th from left                       |
| `FX-7`   | Fridge bulk area at the bottom (Champagne / odd shapes)        |
| `R5-9`   | Rack, row 5 (1 = top), 9th column from left                    |
| `BOXA-3` | Box A, bottle 3                                                |

The starting layout came from `scripts/assign-layout.mjs`:

- **Fridge:** sparkling goes in the bulk area. Still wines fill the shelves top-down,
  with the soonest to drink at eye level and the longest-agers lower. Each wine sits
  together, with one bottle in the front row so you can see the label.
- **Rack:** every non-fridge wine has at least one bottle on the rack. The wines to drink
  soonest get more spots there.
- **Boxes:** whatever's left, with each wine kept in one box where possible.

The shelf sizes (6 front + 5 back per shelf, 15 in the bulk area) are my best guess
for the EL-100SBB. If your shelves hold a different number, edit `js/storage.js` and
re-run the layout (see below).

## One-time setup: let the site write to the sheet

Until this is done, the site shows a snapshot (`data/wines.json`) and keeps any changes
in your browser only.

1. Open the sheet → **Extensions → Apps Script**. Replace the editor contents with
   [`apps-script/Code.gs`](apps-script/Code.gs) and save.
2. **Project Settings (gear) → Script properties → Add**: `WRITE_TOKEN` = a passphrase
   of your choice.
3. **Deploy → New deployment → Web app**. Set *Execute as*: **Me** and
   *Who has access*: **Anyone**. Authorize when prompted, then copy the URL that ends
   in `/exec`.
4. On the site, open **Settings (gear)**, paste the URL and your passphrase, and click
   **Save & reload**. The status under the title should say *Live from your Google Sheet*.

Repeat step 4 on each device (phone, laptop); it's saved per browser. Keeping the URL out
of the public repo means strangers who open the site see only the snapshot, not your
notes. If you'd rather not paste it per device, put it in `js/config.js`. Anyone who
opens the site could then *read* the sheet, but only someone with the passphrase can
write to it.

When you change `Code.gs`, use **Deploy → Manage deployments → Edit → New version** so
the URL stays the same.

## Day-to-day

- **New wine:** add a row to the sheet with `bottles` filled in, and leave `id` and
  `locations` blank. The site gives it an id and lists it under **Needs a spot**. Tap it,
  then tap an empty slot.
- **More bottles of a wine you have:** raise `bottles` in the sheet, then place the extras
  the same way.
- **Gave a bottle away:** for now, edit `bottles` and remove the slot from `locations`
  in the sheet.

## Scripts

```bash
# Pull the sheet to CSV (uses your cached googlesheets4 login)
WINE_GOOGLE_EMAIL=matthew.r.v.ross@gmail.com Rscript scripts/sheet-sync.R pull /tmp/wines.csv

# Recompute the whole layout from scratch → data/wines.json
# (only do this if you're going to physically re-shelve everything)
node scripts/assign-layout.mjs /tmp/wines.csv

# Write ids + locations back to the sheet (backs up Sheet1 first)
WINE_GOOGLE_EMAIL=matthew.r.v.ross@gmail.com Rscript scripts/sheet-sync.R push
```

## Local preview

```bash
python3 -m http.server 8765
```

Then open http://localhost:8765.

## Files

```
index.html            page shell
css/style.css         all styling
js/app.js             UI: map, collection, journal, drawer, dialogs
js/store.js           data: Apps Script sync, offline outbox, local mode
js/storage.js         physical layout of fridge / rack / boxes (shared with scripts)
js/config.js          Apps Script URL (optional), sheet link
data/wines.json       snapshot used before the sheet is connected
apps-script/Code.gs   Google Sheets backend
scripts/              layout + sheet sync helpers
ROADMAP.md            next layers, incl. the 3D region explorer
```
