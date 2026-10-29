// Wine → place (for the map) and wine → vintage family (for "great years").
// Both are driven by regex rules in data/, so a new wine in the sheet usually
// just works. If no place rule matches, the region text is geocoded with
// OpenStreetMap Nominatim and remembered in this browser.

let placesP, vintagesP;
const loadJSON = (url) => fetch(url).then((r) => r.json());
export const getPlaces = () => (placesP ||= loadJSON('data/places.json').then((d) => d.places));
export const getVintages = () => (vintagesP ||= loadJSON('data/vintages.json'));

const test = (pattern, ...texts) => {
  const re = new RegExp(pattern, 'i');
  return texts.some((t) => t && re.test(t));
};

function firstMatch(rules, wine) {
  // Region text decides first; the wine's name is a tie-breaker.
  return rules.find((r) => test(r.match, wine.region)) || rules.find((r) => test(r.match, wine.wine_name)) || null;
}

export async function placeFor(wine) {
  const places = await getPlaces();
  const hit = firstMatch(places, wine);
  if (hit) return hit;
  return geocodeRegion(wine.region);
}

export async function familyFor(wine) {
  const v = await getVintages();
  return firstMatch(v.families, wine);
}

const GEO_KEY = 'wg.geocode.v1';
async function geocodeRegion(region) {
  if (!region || /^(tbd|unknown|n\/?a)$/i.test(region.trim())) return null;
  let memo = {};
  try { memo = JSON.parse(localStorage.getItem(GEO_KEY) || '{}'); } catch {}
  if (memo[region] !== undefined) return memo[region];
  // Try the full text, then progressively drop the most specific part.
  const parts = region.split(/\s*[,/]\s*/).filter(Boolean);
  let place = null;
  for (let i = 0; i < parts.length && !place; i++) {
    const q = parts.slice(i).join(', ');
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q, format: 'jsonv2', limit: '1' })}`).catch(() => null);
    const hit = res?.ok ? (await res.json())[0] : null;
    if (hit) {
      const [s, n, w, e] = hit.boundingbox.map(Number);
      place = {
        key: null,
        name: parts[0],
        blurb: '',
        center: [+(+hit.lon).toFixed(4), +(+hit.lat).toFixed(4)],
        bounds: [w, s, e, n],
        tour: [],
        geocoded: hit.display_name,
      };
    }
  }
  memo[region] = place;
  try { localStorage.setItem(GEO_KEY, JSON.stringify(memo)); } catch {}
  return place;
}
