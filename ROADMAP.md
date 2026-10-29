# Roadmap

## Done (v1)

- Cellar map of fridge, rack and boxes, driven by the sheet's `locations` column
- Search across name, region, grape, flavours, pairings and notes, with matches lit on the map
- Open a bottle → rating, food, notes → sheet (`bottles`, `locations`, `my_notes`, `my_rating`, `tasting_log` tab)
- Move, swap and place bottles; tray of unplaced bottles
- Journal view; "Pick for tonight"; deep links (`#wine=w044`)

## Next: Explore the region (3D tour + vintage weather)

The goal: tap a wine → *Explore* → fly over its vineyards in 3D, with a panel showing how
that vintage's growing season compared to normal and to the great years.

### 1. Geography data (one-time script → `data/regions.json`)

- Normalise `region` to an appellation key: "Montalcino, Tuscany, Italy" →
  `brunello-di-montalcino`. Several wines share a key (two Michel Genet Champagnes,
  three Barolos/Barbaresco).
- Give each key a centroid, a camera (center, zoom, pitch, bearing), and, where available,
  a boundary polygon:
  - **US AVAs:** UC Davis AVA Digitizing Project, GeoJSON for every AVA
    (github.com/UCDavisLibrary/ava). Covers Napa, Alexander Valley, Chalk Hill, Red Mountain,
    Horse Heaven Hills, Walla Walla, Willamette, Paso Robles, Lime Kiln Valley.
  - **EU PDOs:** Candiago et al. 2022, *A geospatial inventory of regulatory information for
    wine protected designations of origin in Europe* (Scientific Data), with PDO polygons for
    Bordeaux communes, Châteauneuf, Barolo, Rioja, Dão, Vinho Verde, Champagne, etc.
  - **Fallback:** Nominatim geocode of the region string (one request/second, cached).
  - Mendoza/Uco, Western Cape: hand-placed centroid + camera.
- Simplify polygons (mapshaper) so the file stays small.

### 2. 3D flyover (free, no backend)

- **MapLibre GL JS** (open source) with terrain from the free AWS Terrain Tiles
  (`raster-dem`, `encoding: 'terrarium'`) and `map.setTerrain({ exaggeration: 1.4 })`.
- Imagery options:
  1. Esri World Imagery tiles (beautiful, attribution required; check terms for personal use).
  2. MapTiler free tier: satellite + terrain, key restricted to the github.io domain.
  3. EOX Sentinel-2 cloudless (open, slightly softer).
- Tour: `flyTo` from a continental view → appellation at pitch 60–70°, then a slow orbit
  (`rotateTo` in a loop, or a camera path along the polygon outline). Draw the appellation
  outline as a glowing line plus a soft fill. Pin the producer if we geocode the estate.
- Upgrade path if it needs to look even better: CesiumJS + Google Photorealistic 3D Tiles
  (needs an API key and billing account; free monthly quota is generous for personal use).

### 3. Vintage weather panel

- **Open-Meteo Historical Weather API** (`archive-api.open-meteo.com/v1/archive`): free,
  no key, CORS-enabled, daily data back to 1940 (ERA5).
  - Request `temperature_2m_max`, `temperature_2m_min`, `precipitation_sum` at the centroid
    for the vintage year and for 1991–2020 (baseline). Cache in localStorage per region.
- Metrics for the growing season (Apr–Oct north, Oct–Apr south, e.g. Mendoza, Western Cape):
  - Growing degree days (base 10 °C) and Huglin index → warmth
  - Season rainfall and harvest-window rain (Sep–Oct north) → dilution / rot risk
  - Spring frost days (min < 0 °C, Apr–May) and heat days (max > 35 °C)
- Visuals: a ribbon chart of daily mean temperature vs the baseline's 10–90% band, plus
  tiles for "GDD +8% vs normal", "harvest rain 40% below normal", etc.
- **"Great years":** no free API exists, so hand-curate `data/vintage-ratings.json` by region
  family (Left/Right Bank Bordeaux, N/S Rhône, Champagne, Piedmont, Brunello, Chianti
  Classico, Rioja, Ribera, Napa, Washington, Willamette, Mendoza). Use 0–100 scores from
  public vintage charts. Then show:
  - a timeline of scored vintages with this bottle's year highlighted
  - "closest weather match": nearest-neighbour great vintage on (GDD, season rain, harvest rain)
- NV wines (Champagne, the Bordeaux 12-pack): skip the vintage panel and show the region's
  recent seasons instead.

### 4. UI integration

- The drawer's "Explore" teaser becomes a button → full-screen `#explore=w044` view: 3D map
  on the left, vintage panel on the right (stacked on mobile).
- Lazy-load MapLibre only when Explore opens, so the main site stays fast.

## Other ideas

- "Remove bottle" action (gift / corked) that logs a reason without a tasting note
- Edit or delete a journal entry from the site
- Re-shelve helper: suggest moves as wines approach their peak (drink-soon to eye level)
- Purchase log + "add a new wine" form that appends a row to the sheet
- Label photos (Apps Script → Drive folder) shown in the drawer
- PWA manifest so it installs on a phone home screen and works offline
