# Roadmap

## Done

**v1: cellar + journal**
- Cellar map of fridge, rack and boxes, driven by the sheet's `locations` column
- Search across name, region, grape, flavours, pairings and notes, with matches lit on the map
- Open a bottle → rating, food, notes → sheet (`bottles`, `locations`, `my_notes`, `my_rating`, `tasting_log` tab)
- Move, swap and place bottles; tray of unplaced bottles
- Journal view; "Pick for tonight"; deep links (`#wine=w044`)

**v2: Explore**
- `#explore=<id>`: MapLibre globe → fly-in → camera tour through 3–6 villages per region,
  glowing pillars at each stop, appellation outline (UC Davis AVAs / OSM communes),
  terrain with dusk hillshade over Esri imagery
- `#globe`: every cellar region as a column of light; hover for name, click to fly there
- Vintage panel: plain-language season summary, tiles (heat, rain, harvest rain, hot days,
  frost) with rank vs every season since 1991, season stripes, GDD accumulation against
  great years, daily high/low bands (WeatherSpark-style), monthly rain, heat × rain
  "climate space" scatter, closest-weather great vintage
- Data pipeline: `places.src.json` → `build-places.mjs`; `build-climate.mjs` (incremental,
  rate-limit aware); monthly GitHub Action keeps it all current
- Installable on a phone home screen (manifest + icons)

## Next ideas

### Explore
- **Rivers that glow:** pull the main river for each region (Gironde, Dordogne, Rhône,
  Tanaro, Duero, Minho, Columbia…) from OpenStreetMap at build time and draw it as a luminous
  line. That's the sonic_ray look, and the tour camera could follow it, river-runner style.
- **Producer pins:** add optional `lat`/`lon` columns to the sheet for an estate or vineyard.
  The tour would end on its own pillar, and the weather would use that exact spot.
- **Soil + elevation layer:** toggle a hypsometric tint or slope/aspect shading to show *why*
  certain slopes are prized (south-facing, 250–450 m in Barolo, etc.).
- **Time-lapse season:** scrub through the vintage's days and watch the temperature ribbon
  and a cumulative-heat gauge advance while the light on the terrain shifts with the sun
  position for that date.
- **Wind/air particles** (earth.nullschool style) for the Gironde estuary, Van Duzer
  corridor or Petaluma Gap, using ERA5 wind from Open-Meteo.
- **Vintage tiers from your own ratings:** once the journal has enough entries, show your
  average rating per vintage alongside the critics' tiers.

### Cellar
- "Remove bottle" action (gift / corked) that logs a reason without a tasting note
- Edit or delete a journal entry from the site
- Re-shelve helper: suggest moves as wines approach their peak (drink-soon to eye level)
- "Add a new wine" form that appends a row to the sheet (via the Apps Script)
- Label photos (Apps Script → Drive folder) shown in the drawer
- Offline: a small service worker so the cellar map works with no signal in the basement
