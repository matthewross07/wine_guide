// 3D flyover: MapLibre GL on a globe with AWS terrain, Esri imagery and a
// dusk hillshade. Glowing pillars mark tour stops (a nod to sonic_ray) and,
// from orbit, every region in the cellar. The tour camera glides along a
// smooth path through the stops, river-runner style.

const VERSION = '5.24.0';
const CDN = `https://cdn.jsdelivr.net/npm/maplibre-gl@${VERSION}/dist`;

let libP;
export function loadMapLibre() {
  if (window.maplibregl) return Promise.resolve(window.maplibregl);
  return (libP ||= new Promise((resolve, reject) => {
    const css = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: `${CDN}/maplibre-gl.css` });
    const js = Object.assign(document.createElement('script'), { src: `${CDN}/maplibre-gl.js`, async: true });
    js.onload = () => resolve(window.maplibregl);
    js.onerror = () => reject(new Error('Could not load the map library'));
    document.head.append(css, js);
  }));
}

const STYLE = {
  version: 8,
  projection: { type: 'globe' },
  sources: {
    sat: {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      maxzoom: 18,
      attribution: 'Imagery © <a href="https://www.esri.com">Esri</a>, Maxar, Earthstar Geographics',
    },
    dem: {
      type: 'raster-dem',
      tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 14,
      encoding: 'terrarium',
      attribution: 'Terrain: <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a>',
    },
    hs: {
      type: 'raster-dem',
      tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 14,
      encoding: 'terrarium',
    },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#04060b' } },
    {
      id: 'sat', type: 'raster', source: 'sat',
      paint: { 'raster-brightness-max': 0.8, 'raster-saturation': -0.18, 'raster-contrast': 0.06, 'raster-fade-duration': 250 },
    },
    {
      id: 'hillshade', type: 'hillshade', source: 'hs',
      paint: {
        'hillshade-exaggeration': 0.45,
        'hillshade-shadow-color': '#090d24',
        'hillshade-highlight-color': 'rgba(255, 226, 180, 0.22)',
        'hillshade-accent-color': '#0d1330',
        'hillshade-illumination-direction': 300,
      },
    },
  ],
  sky: {
    'sky-color': '#0b1124',
    'horizon-color': '#33304c',
    'fog-color': '#161a2e',
    'sky-horizon-blend': 0.55,
    'horizon-fog-blend': 0.6,
    'fog-ground-blend': 0.55,
    'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 0.8, 8, 0],
  },
};

// ---------- geometry helpers ----------
const R = 6371008.8;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

function circle([lon, lat], meters, steps = 28) {
  const ring = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    const dx = (meters * Math.cos(a)) / (R * Math.cos(toRad(lat)));
    const dy = (meters * Math.sin(a)) / R;
    ring.push([lon + toDeg(dx), lat + toDeg(dy)]);
  }
  return [ring];
}

function bearing(a, b) {
  const [l1, p1, l2, p2] = [toRad(a[0]), toRad(a[1]), toRad(b[0]), toRad(b[1])];
  const y = Math.sin(l2 - l1) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(l2 - l1);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

const metersBetween = (a, b) => {
  const dLat = toRad(b[1] - a[1]), dLon = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

// Centripetal-ish Catmull-Rom through the stops, sampled per segment.
function splinePath(pts, samples = 90) {
  const P = [pts[0], ...pts, pts[pts.length - 1]];
  const segs = [];
  for (let i = 1; i < P.length - 2; i++) {
    const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]];
    const seg = [];
    for (let s = 0; s <= samples; s++) {
      const t = s / samples, t2 = t * t, t3 = t2 * t;
      seg.push([0, 1].map((j) => 0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3)));
    }
    segs.push(seg);
  }
  return segs;
}

const ease = (t) => 0.5 - Math.cos(Math.PI * t) / 2;
const lerpAngle = (a, b, t) => a + ((((b - a) % 360) + 540) % 360 - 180) * t;

// ---------- the flyover ----------

export class Flyover {
  constructor(container, { onStop, onState, onPickPlace } = {}) {
    this.container = container;
    this.onStop = onStop || (() => {});
    this.onState = onState || (() => {});
    this.onPickPlace = onPickPlace || (() => {});
    this.markers = [];
    this.raf = 0;
    this.state = 'idle';
  }

  async init(start) {
    const maplibregl = await loadMapLibre();
    this.lib = maplibregl;
    this.map = new maplibregl.Map({
      container: this.container,
      style: STYLE,
      center: start?.center || [10, 30],
      zoom: start?.zoom ?? 1.3,
      pitch: 0,
      maxPitch: 78,
      attributionControl: { compact: true },
      pixelRatio: Math.min(window.devicePixelRatio || 1, 1.75),
      fadeDuration: 0,
      canvasContextAttributes: { antialias: false, powerPreference: 'high-performance' },
    });
    if (location.hostname === 'localhost') window.__fly = this; // handy for debugging
    if (!matchMedia('(max-width: 900px)').matches) {
      this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true, showZoom: false }), 'bottom-right');
    }
    // style.load is enough to add layers; 'load' would also wait for the first full render.
    await new Promise((r) => (this.map.isStyleLoaded() ? r() : this.map.once('style.load', r)));
    this.map.setTerrain({ source: 'dem', exaggeration: 1.45 });

    const empty = { type: 'FeatureCollection', features: [] };
    this.map.addSource('outline', { type: 'geojson', data: empty });
    this.map.addSource('rivers', { type: 'geojson', data: empty });
    this.map.addSource('cellar', { type: 'geojson', data: empty });
    this.map.addSource('cellar-pillars', { type: 'geojson', data: empty });
    this.map.addSource('stops', { type: 'geojson', data: empty });

    // Rivers glow like sonic_ray's: a wide soft halo under a bright core.
    this.map.addLayer({
      id: 'river-glow', type: 'line', source: 'rivers', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#3d9bff',
        'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 5, 3, 10, 12, 14, 30],
        'line-blur': ['interpolate', ['linear'], ['zoom'], 5, 3, 14, 22],
        'line-opacity': 0.5,
      },
    });
    this.map.addLayer({
      id: 'river-core', type: 'line', source: 'rivers', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#c6ecff',
        'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 5, 0.6, 10, 1.6, 14, 3.5],
        'line-opacity': 0.95,
      },
    });
    this.map.addLayer({ id: 'outline-fill', type: 'fill', source: 'outline', paint: { 'fill-color': '#f0c86e', 'fill-opacity': 0.06 } });
    this.map.addLayer({ id: 'outline-glow', type: 'line', source: 'outline', paint: { 'line-color': '#f3c97a', 'line-width': 9, 'line-blur': 8, 'line-opacity': 0.45 } });
    this.map.addLayer({ id: 'outline-line', type: 'line', source: 'outline', paint: { 'line-color': '#ffe8b8', 'line-width': 1.3, 'line-opacity': 0.9 } });

    // Cellar regions seen from orbit: soft glow + tall light columns.
    this.map.addLayer({
      id: 'cellar-glow', type: 'circle', source: 'cellar', maxzoom: 6,
      paint: {
        'circle-color': ['get', 'color'],
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, ['+', 6, ['*', 1.2, ['sqrt', ['get', 'bottles']]]], 6, 28],
        'circle-blur': 1,
        'circle-opacity': ['interpolate', ['linear'], ['zoom'], 4, 0.85, 6, 0],
        'circle-pitch-alignment': 'map',
      },
    });
    // Columns only make sense from orbit; fade them before they become walls.
    this.map.addLayer({
      id: 'cellar-pillars', type: 'fill-extrusion', source: 'cellar-pillars', maxzoom: 5,
      paint: {
        'fill-extrusion-color': ['get', 'color'],
        'fill-extrusion-height': ['get', 'height'],
        'fill-extrusion-opacity': ['interpolate', ['linear'], ['zoom'], 3, 0.9, 4.6, 0],
        'fill-extrusion-vertical-gradient': true,
      },
    });

    // Tour stops up close.
    this.map.addLayer({
      id: 'stops-glow', type: 'circle', source: 'stops', minzoom: 7,
      paint: {
        'circle-color': '#ffd27a',
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 10, 14, 34],
        'circle-blur': 1,
        'circle-opacity': ['case', ['get', 'active'], 0.95, 0.5],
        'circle-pitch-alignment': 'map',
      },
    });
    this.map.addSource('stop-pillars', { type: 'geojson', data: empty });
    this.map.addLayer({
      id: 'stop-pillars', type: 'fill-extrusion', source: 'stop-pillars', minzoom: 7,
      paint: {
        'fill-extrusion-color': ['case', ['get', 'active'], '#ffe2a0', '#e2b464'],
        'fill-extrusion-height': ['get', 'height'],
        'fill-extrusion-opacity': 0.85,
        'fill-extrusion-vertical-gradient': true,
      },
    });

    const pop = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'fx-pop', offset: 14 });
    for (const id of ['cellar-glow', 'cellar-pillars']) {
      this.map.on('click', id, (e) => this.onPickPlace(e.features[0].properties.key));
      this.map.on('mousemove', id, (e) => {
        const p = e.features[0].properties;
        this.map.getCanvas().style.cursor = 'pointer';
        pop.setLngLat(JSON.parse(p.center)).setHTML(`<b>${p.name}</b><span>${p.bottles} bottle${p.bottles > 1 ? 's' : ''}</span>`).addTo(this.map);
      });
      this.map.on('mouseleave', id, () => {
        this.map.getCanvas().style.cursor = '';
        pop.remove();
      });
    }

    // Any manual camera move pauses the tour.
    const interrupt = (e) => {
      if (!e.originalEvent) return;
      if (this.state === 'touring' || this.state === 'intro' || this.state === 'orbit') this.pause(true);
    };
    for (const ev of ['dragstart', 'rotatestart', 'pitchstart', 'wheel', 'touchstart']) this.map.on(ev, interrupt);

    this.visibility = () => (document.hidden ? cancelAnimationFrame(this.raf) : this.state === 'touring' && this.loop());
    document.addEventListener('visibilitychange', this.visibility);
  }

  // Every region in the cellar, as pillars on the globe.
  setCellar(pins) {
    const pts = pins.map((p) => ({ type: 'Feature', properties: p, geometry: { type: 'Point', coordinates: p.center } }));
    const pillars = pins.map((p) => ({
      type: 'Feature',
      properties: { ...p, height: 120000 + p.bottles * 45000 },
      geometry: { type: 'Polygon', coordinates: circle(p.center, 14000, 18) },
    }));
    this.map.getSource('cellar').setData({ type: 'FeatureCollection', features: pts });
    this.map.getSource('cellar-pillars').setData({ type: 'FeatureCollection', features: pillars });
  }

  async show(place) {
    this.stop();
    this.place = place;
    this.markers.forEach((m) => m.remove());
    this.markers = [];
    const empty = { type: 'FeatureCollection', features: [] };
    this.map.getSource('outline').setData(place?.outline || empty);
    this.map.getSource('rivers').setData(place?.riverLines || empty);
    this.stops = (place?.tour || []).map((s) => s.at);
    this.setActiveStop(-1);
    for (const [i, s] of (place?.tour || []).entries()) {
      const el = document.createElement('button');
      el.className = 'fx-stop';
      el.innerHTML = `<span>${s.name}</span>`;
      el.addEventListener('click', () => this.goToStop(i));
      this.markers.push(new this.lib.Marker({ element: el, anchor: 'bottom', offset: [0, -6] }).setLngLat(s.at).addTo(this.map));
    }
    if (place) this.intro();
  }

  setActiveStop(i) {
    this.active = i;
    const tour = this.place?.tour || [];
    const feats = tour.map((s, k) => ({ type: 'Feature', properties: { active: k === i }, geometry: { type: 'Point', coordinates: s.at } }));
    const pillars = tour.map((s, k) => ({
      type: 'Feature',
      properties: { active: k === i, height: k === i ? 1100 : 600 },
      geometry: { type: 'Polygon', coordinates: circle(s.at, k === i ? 70 : 50, 20) },
    }));
    this.map.getSource('stops').setData({ type: 'FeatureCollection', features: feats });
    this.map.getSource('stop-pillars').setData({ type: 'FeatureCollection', features: pillars });
    this.markers.forEach((m, k) => m.getElement().classList.toggle('active', k === i));
    if (i >= 0) this.onStop(i, tour[i]);
  }

  // Zoom that frames a typical hop between stops.
  tourZoom() {
    const hops = this.stops.slice(1).map((p, i) => metersBetween(this.stops[i], p));
    const typical = hops.length ? hops.reduce((a, b) => a + b, 0) / hops.length : 8000;
    const lat = this.stops[0]?.[1] ?? this.place.center[1];
    const width = this.container.clientWidth || 800;
    const z = Math.log2((40075016 * Math.cos(toRad(lat)) * width) / (512 * typical * 2.4));
    return Math.max(9.4, Math.min(13.4, z));
  }

  overviewCamera() {
    const b = this.place.bounds;
    if (!b) return { center: this.place.center, zoom: this.place.zoom ?? 9, bearing: 0, pitch: 50 };
    const cam = this.map.cameraForBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 60, pitch: 0 }) || {};
    return { center: cam.center || this.place.center, zoom: Math.min(this.place.zoom ?? 13, (cam.zoom ?? 9) - 0.2), bearing: -20, pitch: 55 };
  }

  intro() {
    this.setState('intro');
    const done = () => (this.state === 'intro' ? (this.stops.length > 1 ? this.startTour() : this.orbit()) : null);
    if (this.stops.length > 1) {
      const path = splinePath(this.stops);
      this.path = path;
      const b0 = bearing(path[0][0], path[0][8]);
      this.map.flyTo({ center: this.stops[0], zoom: this.tourZoom(), pitch: 64, bearing: b0, duration: 7500, curve: 1.6, essential: true });
    } else {
      this.map.flyTo({ ...this.overviewCamera(), duration: 6500, curve: 1.6, essential: true });
    }
    this.map.once('moveend', done);
  }

  startTour(fromSeg = 0) {
    this.seg = fromSeg;
    this.t0 = performance.now();
    this.dwellUntil = this.t0 + 2200;
    this.camBearing = this.map.getBearing();
    this.setActiveStop(fromSeg);
    this.setState('touring');
    this.loop();
  }

  loop() {
    cancelAnimationFrame(this.raf);
    const step = (now) => {
      if (this.state !== 'touring') return;
      if (now < this.dwellUntil) {
        this.raf = requestAnimationFrame(step);
        return;
      }
      if (this.seg >= this.path.length) return this.orbit(); // lingered at the last stop
      const seg = this.path[this.seg];
      const meters = metersBetween(seg[0], seg[seg.length - 1]);
      const dur = Math.max(5200, Math.min(11000, meters / 2.2)); // ms
      const t = Math.min(1, (now - this.dwellUntil) / dur);
      const f = ease(t) * (seg.length - 1);
      const i = Math.floor(f), frac = f - i;
      const a = seg[i], b = seg[Math.min(seg.length - 1, i + 1)];
      const center = [a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac];
      const ahead = seg[Math.min(seg.length - 1, i + 12)];
      const target = metersBetween(center, ahead) > 5 ? bearing(center, ahead) : this.camBearing;
      this.camBearing = lerpAngle(this.camBearing, target, 0.035);
      this.map.jumpTo({ center, bearing: this.camBearing, pitch: 64 });
      if (t >= 1) {
        this.seg++;
        this.setActiveStop(this.seg);
        this.dwellUntil = now + 2600;
      }
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  // Slow orbit over the whole region once the tour ends.
  orbit() {
    this.setState('orbit');
    const cam = this.overviewCamera();
    this.map.easeTo({ ...cam, duration: 4000 });
    this.map.once('moveend', () => {
      if (this.state !== 'orbit') return;
      let last = performance.now();
      const spin = (now) => {
        if (this.state !== 'orbit') return;
        const dt = now - last;
        last = now;
        this.map.setBearing(this.map.getBearing() + dt * 0.0035);
        this.raf = requestAnimationFrame(spin);
      };
      this.raf = requestAnimationFrame(spin);
    });
  }

  // Whole-earth view of the cellar, slowly turning.
  globe() {
    this.stop();
    this.place = null;
    this.setState('orbit');
    this.map.flyTo({ center: [8, 30], zoom: Math.min(1.7, Math.log2(this.container.clientWidth / 400) + 1.15), pitch: 32, bearing: 0, duration: 3000, essential: true });
    this.map.once('moveend', () => {
      if (this.state !== 'orbit' || this.place) return;
      let last = performance.now();
      const spin = (now) => {
        if (this.state !== 'orbit' || this.place) return;
        const c = this.map.getCenter();
        this.map.setCenter([c.lng + (now - last) * 0.004, c.lat]);
        last = now;
        this.raf = requestAnimationFrame(spin);
      };
      this.raf = requestAnimationFrame(spin);
    });
  }

  goToStop(i) {
    this.stop();
    this.setActiveStop(i);
    this.setState('paused');
    this.map.flyTo({ center: this.stops[i], zoom: this.tourZoom() + 0.6, pitch: 66, duration: 2600, essential: true });
  }

  pause(byUser = false) {
    this.stop();
    this.setState(byUser ? 'free' : 'paused');
  }

  resume() {
    if (!this.place) return this.globe();
    if (this.stops.length > 1 && this.active >= 0 && this.active < this.path.length) {
      this.setState('intro');
      const seg = this.active;
      const b0 = bearing(this.path[seg][0], this.path[seg][8]);
      this.map.flyTo({ center: this.stops[seg], zoom: this.tourZoom(), pitch: 64, bearing: b0, duration: 2200, essential: true });
      this.map.once('moveend', () => this.state === 'intro' && this.startTour(seg));
    } else this.orbit();
  }

  replay() {
    if (!this.place) return this.globe();
    this.stop();
    if (this.stops.length > 1) {
      this.setState('intro');
      const b0 = bearing(this.path[0][0], this.path[0][8]);
      this.map.flyTo({ center: this.stops[0], zoom: this.tourZoom(), pitch: 64, bearing: b0, duration: 3500, essential: true });
      this.map.once('moveend', () => this.state === 'intro' && this.startTour(0));
    } else this.orbit();
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.map?.stop();
  }

  setState(s) {
    this.state = s;
    this.onState(s);
  }

  resize() {
    this.map?.resize();
  }

  destroy() {
    this.stop();
    document.removeEventListener('visibilitychange', this.visibility);
    this.markers.forEach((m) => m.remove());
    this.map?.remove();
  }
}
