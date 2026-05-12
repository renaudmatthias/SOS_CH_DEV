// ── Configuration Valhalla ──
// Instance publique OSM (pas besoin de clé, limites fair-use)
// Pour la prod, utilise Stadia Maps (https://stadiamaps.com) avec clé gratuite
const VALHALLA_BASE = "https://valhalla1.openstreetmap.de";

// Profil urgence : auto rapide, autoroutes et péages autorisés, vitesse max
const VALHALLA_COSTING = "auto";
const VALHALLA_COSTING_OPTIONS = {
  auto: { use_highways: 1.0, use_tolls: 1.0, top_speed: 130 }
};

// ── Projection LV95 ──
const extent = [2420000, 1030000, 2900000, 1360000];
proj4.defs(
  "EPSG:2056",
  "+proj=somerc +lat_0=46.95240555555556 +lon_0=7.439583333333333 +k_0=1 +x_0=2600000" +
  " +y_0=1200000 +ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs"
);
ol.proj.proj4.register(proj4);
const projection = new ol.proj.Projection({ code: "EPSG:2056", extent });

// ── Carte ──
const map = new ol.Map({
  target: "map",
  layers: [
    new ol.layer.Tile({
      source: new ol.source.TileWMS({
        url: "https://wms.geo.admin.ch/",
        params: { LAYERS: "ch.swisstopo.pixelkarte-farbe", FORMAT: "image/png", VERSION: "1.3.0" },
        serverType: "mapserver",
        projection,
      }),
    }),
  ],
  view: new ol.View({
    projection,
    center: [2660000, 1190000],
    zoom: 2,
    minZoom: 2,
    extent: [2485000, 1075000, 2834000, 1296000],
    constrainOnlyCenter: true,
  }),
});

// ── Styles POI ──
const blueStyle  = new ol.style.Style({ image: new ol.style.Circle({ radius: 6, fill: new ol.style.Fill({ color: "blue" }),  stroke: new ol.style.Stroke({ color: "white", width: 2 }) }) });
const greenStyle = new ol.style.Style({ image: new ol.style.Circle({ radius: 6, fill: new ol.style.Fill({ color: "green" }), stroke: new ol.style.Stroke({ color: "white", width: 2 }) }) });
const redStyle   = new ol.style.Style({ image: new ol.style.Circle({ radius: 6, fill: new ol.style.Fill({ color: "red" }),   stroke: new ol.style.Stroke({ color: "white", width: 2 }) }) });

const selectedStyleMap = {
  blue:  new ol.style.Style({ image: new ol.style.Circle({ radius: 10, fill: new ol.style.Fill({ color: "blue" }),  stroke: new ol.style.Stroke({ color: "white", width: 3 }) }) }),
  green: new ol.style.Style({ image: new ol.style.Circle({ radius: 10, fill: new ol.style.Fill({ color: "green" }), stroke: new ol.style.Stroke({ color: "white", width: 3 }) }) }),
  red:   new ol.style.Style({ image: new ol.style.Circle({ radius: 10, fill: new ol.style.Fill({ color: "red" }),   stroke: new ol.style.Stroke({ color: "white", width: 3 }) }) }),
};
const defaultStyleMap = { blue: blueStyle, green: greenStyle, red: redStyle };

const layerTypeMap = {
  blue:  { label: "Caserne de pompiers", emoji: "🚒", color: "#1a56db" },
  green: { label: "Poste de police",      emoji: "👮", color: "#057a55" },
  red:   { label: "Hôpital",              emoji: "🏥", color: "#e02424" },
};

// ── DOM ──
const panel    = document.getElementById("poi-panel");
const elEmoji  = document.getElementById("poi-emoji");
const elType   = document.getElementById("poi-type");
const elName   = document.getElementById("poi-name");
const elBody   = document.getElementById("poi-body");
const btnClose = document.getElementById("poi-close");

let selectedFeature = null;
let selectedColor   = null;

function closePanel() {
  panel.style.display = "none";
  if (selectedFeature) {
    selectedFeature.setStyle(defaultStyleMap[selectedColor]);
    selectedFeature = null;
    selectedColor   = null;
  }
}
btnClose.addEventListener("click", closePanel);

// ── Couches Valhalla ──
let routeLayer     = null;
let isochroneLayer = null;

function clearRoute() {
  if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
  const rs = document.getElementById("route-summary");
  if (rs) rs.remove();
}
function clearIsochrones() {
  if (isochroneLayer) { map.removeLayer(isochroneLayer); isochroneLayer = null; }
}

// ── Conversion ──
function lv95ToWgs84(coord) { return ol.proj.transform(coord, "EPSG:2056", "EPSG:4326"); }
function wgs84ToLv95(coord) { return ol.proj.transform(coord, "EPSG:4326", "EPSG:2056"); }

// ── Trouver le POI le plus proche ──
const poiSources = {};
const CANDIDATES = 5; // nb de candidats à vol d'oiseau avant de les comparer en durée réelle

// Retourne les N features les plus proches à vol d'oiseau
function getNearestCandidates(lv95Coord, color, n = CANDIDATES) {
  const source = poiSources[color];
  if (!source) return [];
  return source.getFeatures()
    .filter(f => f.getGeometry())
    .map(f => {
      const c = f.getGeometry().getCoordinates();
      return { feature: f, dist: Math.hypot(c[0] - lv95Coord[0], c[1] - lv95Coord[1]) };
    })
    .sort((a, b) => a.dist - b.dist)
    .slice(0, n)
    .map(x => x.feature);
}

// Lance N requêtes Valhalla en parallèle et retourne { feature, data } du plus rapide
async function findFastestPOI(fromLv95, color) {
  const candidates = getNearestCandidates(fromLv95, color);
  if (!candidates.length) return null;

  const fromWgs84 = lv95ToWgs84(fromLv95);

  const results = await Promise.all(
    candidates.map(async f => {
      const toWgs84 = lv95ToWgs84(f.getGeometry().getCoordinates());
      try {
        const data = await getRoute(fromWgs84, toWgs84);
        const time = data.trip?.summary?.time ?? Infinity;
        return { feature: f, data, time };
      } catch {
        return { feature: f, data: null, time: Infinity };
      }
    })
  );

  // Garder le plus rapide
  return results.reduce((best, r) => (r.time < best.time ? r : best), results[0]);
}

// ── Décoder polyline encodé (Valhalla utilise precision=6) ──
function decodePolyline(encoded, precision = 6) {
  const factor = Math.pow(10, precision);
  const coords = [];
  let i = 0, lat = 0, lng = 0;
  while (i < encoded.length) {
    let b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    coords.push([lng / factor, lat / factor]);
  }
  return coords;
}

// ── Appel Valhalla /route ──
async function getRoute(fromWgs84, toWgs84) {
  const res = await fetch(`${VALHALLA_BASE}/route`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      locations: [
        { lon: fromWgs84[0], lat: fromWgs84[1] },
        { lon: toWgs84[0],   lat: toWgs84[1] },
      ],
      costing: VALHALLA_COSTING,
      costing_options: VALHALLA_COSTING_OPTIONS,
      units: "km",
    }),
  });
  if (!res.ok) throw new Error(`Valhalla /route HTTP ${res.status}`);
  return res.json();
}

// ── Appel Valhalla /isochrone ──
async function getIsochrones(fromWgs84, minutes = [5, 10, 15]) {
  const res = await fetch(`${VALHALLA_BASE}/isochrone`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      locations: [{ lon: fromWgs84[0], lat: fromWgs84[1] }],
      costing: VALHALLA_COSTING,
      costing_options: VALHALLA_COSTING_OPTIONS,
      contours: minutes.map(m => ({ time: m })),
      polygons: true,
      denoise: 0.5,
      generalize: 150,
    }),
  });
  if (!res.ok) throw new Error(`Valhalla /isochrone HTTP ${res.status}`);
  return res.json();
}

// ── Afficher l'itinéraire ──
function displayRoute(data, color) {
  clearRoute();
  const shape = data.trip?.legs?.[0]?.shape;
  if (!shape) return;

  const typeColors = { blue: "#1a56db", green: "#057a55", red: "#e02424" };
  const lineColor  = typeColors[color] || "#ff6600";

  const wgs84Coords = decodePolyline(shape);
  const lv95Coords  = wgs84Coords.map(([lon, lat]) => wgs84ToLv95([lon, lat]));

  const feature = new ol.Feature({ geometry: new ol.geom.LineString(lv95Coords) });
  feature.setStyle([
    new ol.style.Style({ stroke: new ol.style.Stroke({ color: "white",    width: 7 }) }),
    new ol.style.Style({ stroke: new ol.style.Stroke({ color: lineColor,  width: 4, lineDash: [12, 6] }) }),
  ]);

  routeLayer = new ol.layer.Vector({ source: new ol.source.Vector({ features: [feature] }), zIndex: 500 });
  map.addLayer(routeLayer);
}

// ── Afficher les isochrones ──
function displayIsochrones(geojson) {
  clearIsochrones();

  // Couleurs : rouge (5 min) → orange (10 min) → vert (15 min)
  const palette = [
    { fill: "rgba(229,57,53,0.20)",  stroke: "rgba(229,57,53,0.9)",  label: "5 min" },
    { fill: "rgba(255,152,0,0.16)",  stroke: "rgba(255,152,0,0.9)",  label: "10 min" },
    { fill: "rgba(67,160,71,0.13)",  stroke: "rgba(67,160,71,0.9)",  label: "15 min" },
  ];

  const features = new ol.format.GeoJSON().readFeatures(geojson, {
    dataProjection: "EPSG:4326",
    featureProjection: "EPSG:2056",
  });

  // Trier du plus grand contour au plus petit (affichage en couches)
  features.sort((a, b) => (b.get("contour") || 0) - (a.get("contour") || 0));

  features.forEach((f, i) => {
    const c = palette[i % palette.length];
    f.setStyle(new ol.style.Style({
      fill:   new ol.style.Fill({ color: c.fill }),
      stroke: new ol.style.Stroke({ color: c.stroke, width: 2 }),
    }));
  });

  isochroneLayer = new ol.layer.Vector({
    source: new ol.source.Vector({ features }),
    zIndex: 400,
  });
  map.addLayer(isochroneLayer);
}

// ── Toast ──
function showToast(msg, type = "info") {
  const existing = document.getElementById("valhalla-toast");
  if (existing) existing.remove();
  const toast = document.createElement("div");
  toast.id = "valhalla-toast";
  toast.className = `toast-${type}`;
  toast.textContent = msg;
  document.getElementById("map").appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

// ── Barre d'outils Valhalla ──
const valhallaToolbar = document.createElement("div");
valhallaToolbar.id = "valhalla-toolbar";
valhallaToolbar.innerHTML = `
  <button id="btn-route" class="vtool-btn" title="Cliquez sur la carte pour calculer l'itinéraire vers le service le plus proche">🚨 Itinéraire</button>
  <button id="btn-iso"   class="vtool-btn" title="Cliquez sur la carte pour afficher les isochrones">🕐 Isochrones</button>
  <button id="btn-clear-all" class="vtool-btn vtool-clear" title="Tout effacer">✕ Effacer</button>
`;
document.getElementById("map").appendChild(valhallaToolbar);

// ── Sélecteur POI (pour l'itinéraire) ──
const routeTypeSelector = document.createElement("div");
routeTypeSelector.id = "route-type-selector";
routeTypeSelector.style.display = "none";
routeTypeSelector.innerHTML = `
  <span class="rts-label">Vers :</span>
  <button class="rts-btn" data-color="blue">🚒 Pompiers</button>
  <button class="rts-btn" data-color="green">👮 Police</button>
  <button class="rts-btn selected" data-color="red">🏥 Hôpital</button>
`;
document.getElementById("map").appendChild(routeTypeSelector);

let activeValhallaMode  = null;
let selectedRouteColor  = "red";

function setValhallaMode(mode) {
  activeValhallaMode = activeValhallaMode === mode ? null : mode;
  document.getElementById("btn-route").classList.toggle("active", activeValhallaMode === "route");
  document.getElementById("btn-iso").classList.toggle("active",   activeValhallaMode === "iso");
  routeTypeSelector.style.display = activeValhallaMode === "route" ? "flex" : "none";
  map.getTargetElement().style.cursor = activeValhallaMode ? "crosshair" : "";

  if (activeValhallaMode === "route") showToast("Cliquez sur la carte pour calculer l'itinéraire", "info");
  if (activeValhallaMode === "iso")   showToast("Cliquez sur la carte pour afficher les isochrones 5/10/15 min", "info");
}

document.getElementById("btn-route").addEventListener("click", () => setValhallaMode("route"));
document.getElementById("btn-iso").addEventListener("click",   () => setValhallaMode("iso"));
document.getElementById("btn-clear-all").addEventListener("click", () => {
  clearRoute();
  clearIsochrones();
  setValhallaMode(null);
});

routeTypeSelector.querySelectorAll(".rts-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    selectedRouteColor = btn.dataset.color;
    routeTypeSelector.querySelectorAll(".rts-btn").forEach(b => b.classList.remove("selected"));
    btn.classList.add("selected");
  });
});

// ── Outil coordonnées ──
let coordToolActive = false;
const coordBtn = document.createElement("button");
coordBtn.id = "coord-tool-btn";
coordBtn.title = "Obtenir les coordonnées d'un point";
coordBtn.innerHTML = "📍 Coordonnées";
document.getElementById("map").appendChild(coordBtn);

const coordPanel = document.createElement("div");
coordPanel.id = "coord-panel";
coordPanel.style.display = "none";
coordPanel.innerHTML = `
  <div id="coord-header">
    <span>📍 Coordonnées</span>
    <button id="coord-close" title="Fermer">×</button>
  </div>
  <div id="coord-body">
    <div class="coord-row"><span>LV95 (E / N)</span><span id="coord-lv95">—</span></div>
    <div class="coord-row"><span>WGS84 (lat / lon)</span><span id="coord-wgs84">—</span></div>
    <div class="coord-row"><button id="coord-copy">📋 Copier WGS84</button></div>
  </div>
`;
document.getElementById("map").appendChild(coordPanel);

const coordStyle = document.createElement("style");
coordStyle.textContent = `
  #coord-tool-btn {
    position: absolute; bottom: 24px; right: 12px; z-index: 1000;
    background: white; border: none; border-radius: 8px;
    box-shadow: 0 2px 12px rgba(0,0,0,0.18); padding: 8px 14px;
    font-size: 13px; font-family: 'Segoe UI', Arial, sans-serif;
    cursor: pointer; transition: background 0.15s;
  }
  #coord-tool-btn.active { background: #1a56db; color: white; }
  #coord-tool-btn:hover:not(.active) { background: #f0f4ff; }
  #coord-panel {
    position: absolute; bottom: 70px; right: 12px; width: 280px;
    background: white; border-radius: 10px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.18);
    font-family: 'Segoe UI', Arial, sans-serif; overflow: hidden; z-index: 1000;
  }
  #coord-header {
    padding: 10px 16px; border-bottom: 1px solid #f0f0f0;
    display: flex; justify-content: space-between; align-items: center;
    font-weight: 600; font-size: 13px;
  }
  #coord-close { background: none; border: none; cursor: pointer; font-size: 20px; color: #aaa; line-height: 1; }
  #coord-close:hover { color: #333; }
  #coord-body { padding: 10px 16px; display: flex; flex-direction: column; gap: 8px; }
  .coord-row { display: flex; flex-direction: column; font-size: 12px; color: #888; gap: 2px; }
  .coord-row span:last-child { font-size: 13px; color: #111; font-weight: 500; }
  #coord-copy {
    margin-top: 4px; background: #f0f4ff; border: none; border-radius: 6px;
    padding: 6px 12px; font-size: 12px; cursor: pointer;
    color: #1a56db; font-weight: 600; width: 100%;
  }
  #coord-copy:hover { background: #dce8ff; }
`;
document.head.appendChild(coordStyle);

coordBtn.addEventListener("click", () => {
  coordToolActive = !coordToolActive;
  coordBtn.classList.toggle("active", coordToolActive);
  if (!coordToolActive) coordPanel.style.display = "none";
});
document.getElementById("coord-close").addEventListener("click", () => {
  coordPanel.style.display = "none";
  coordToolActive = false;
  coordBtn.classList.remove("active");
});
document.getElementById("coord-copy").addEventListener("click", () => {
  const txt = document.getElementById("coord-wgs84").textContent;
  navigator.clipboard.writeText(txt).then(() => {
    const btn = document.getElementById("coord-copy");
    btn.textContent = "✅ Copié !";
    setTimeout(() => btn.textContent = "📋 Copier WGS84", 1500);
  });
});

// ── Curseur ──
map.on("pointermove", (e) => {
  const isActive = coordToolActive || activeValhallaMode;
  map.getTargetElement().style.cursor =
    isActive ? "crosshair" : map.hasFeatureAtPixel(e.pixel) ? "pointer" : "";
});

// ── Clic carte ──
map.on("singleclick", async (e) => {
  // Coordonnées
  if (coordToolActive) {
    const lv95  = e.coordinate;
    const wgs84 = lv95ToWgs84(lv95);
    document.getElementById("coord-lv95").textContent =
      `E ${Math.round(lv95[0]).toLocaleString("fr-CH")}  /  N ${Math.round(lv95[1]).toLocaleString("fr-CH")}`;
    document.getElementById("coord-wgs84").textContent =
      `${wgs84[1].toFixed(6)}, ${wgs84[0].toFixed(6)}`;
    coordPanel.style.display = "block";
    return;
  }

  // Itinéraire
  if (activeValhallaMode === "route") {
    const fromLv95  = e.coordinate;
    const candidates = getNearestCandidates(fromLv95, selectedRouteColor);
    if (!candidates.length) { showToast("Données pas encore chargées, réessaie dans un instant.", "error"); return; }

    showToast(`Comparaison de ${candidates.length} candidats en parallèle…`, "info");

    try {
      const best = await findFastestPOI(fromLv95, selectedRouteColor);
      if (!best || !best.data) { showToast("Aucun itinéraire trouvé.", "error"); return; }

      displayRoute(best.data, selectedRouteColor);

      const typeInfo = layerTypeMap[selectedRouteColor];
      elEmoji.textContent = typeInfo.emoji;
      elType.style.color  = typeInfo.color;
      elType.textContent  = typeInfo.label;
      const props = best.feature.getProperties();
      elName.textContent  =
        props.name || props.Name || props.NAME ||
        props.bezeichnung || props.Bezeichnung ||
        props.nom || props.Nom || "Sans nom";

      elBody.innerHTML = "";

      const summary = best.data.trip?.summary;
      if (summary) {
        const mins = Math.round(summary.time / 60);
        const km   = summary.length.toFixed(1);
        const routeInfo = document.createElement("div");
        routeInfo.id = "route-summary";
        routeInfo.innerHTML = `
          <div class="route-row">🚨 <strong>${mins} min</strong> &nbsp;·&nbsp; ${km} km</div>
          <div class="route-note">✓ Le plus rapide parmi ${candidates.length} candidats</div>
          <button id="clear-route-btn">✕ Effacer l'itinéraire</button>
        `;
        elBody.prepend(routeInfo);
        document.getElementById("clear-route-btn").addEventListener("click", clearRoute);
      }
      panel.style.display = "block";
      showToast(`Itinéraire calculé ✓  — ${Math.round(best.time / 60)} min`, "success");
    } catch (err) {
      console.error(err);
      showToast("Erreur Valhalla : " + err.message, "error");
    }
    return;
  }

  // Isochrones
  if (activeValhallaMode === "iso") {
    const fromWgs84 = lv95ToWgs84(e.coordinate);
    showToast("Calcul des isochrones…", "info");
    try {
      const data = await getIsochrones(fromWgs84, [5, 10, 15]);
      displayIsochrones(data);
      showToast("Isochrones 5 / 10 / 15 min affichées ✓", "success");
    } catch (err) {
      console.error(err);
      showToast("Erreur Valhalla : " + err.message, "error");
    }
    return;
  }

  // Clic normal POI
  let found = false;
  map.forEachFeatureAtPixel(e.pixel, (feature, layer) => {
    if (found) return;
    if (layer === searchMarkerLayer) return;
    found = true;

    if (selectedFeature) selectedFeature.setStyle(defaultStyleMap[selectedColor]);
    selectedFeature = feature;
    selectedColor   = layer.get("poiColor");
    feature.setStyle(selectedStyleMap[selectedColor]);

    const typeInfo = layerTypeMap[selectedColor] || { label: "Point d'intérêt", emoji: "📍", color: "#666" };
    elEmoji.textContent = typeInfo.emoji;
    elType.style.color  = typeInfo.color;
    elType.textContent  = typeInfo.label;

    const props = feature.getProperties();
    elName.textContent =
      props.name || props.Name || props.NAME ||
      props.bezeichnung || props.Bezeichnung ||
      props.nom || props.Nom || "Sans nom";

    const excluded = new Set(["geometry", "name", "Name", "NAME", "nom", "Nom", "bezeichnung", "Bezeichnung"]);
    const entries  = Object.entries(props).filter(([k, v]) => !excluded.has(k) && v !== null && v !== undefined && v !== "");

    elBody.innerHTML = "";
    if (entries.length === 0) {
      elBody.innerHTML = "<p>Aucune information supplémentaire disponible.</p>";
    } else {
      const table = document.createElement("table");
      entries.forEach(([key, value]) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td>${formatKey(key)}</td><td>${value}</td>`;
        table.appendChild(tr);
      });
      elBody.appendChild(table);
    }
    panel.style.display = "block";
  });

  if (!found) closePanel();
});

function formatKey(key) {
  return key.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\b\w/g, c => c.toUpperCase());
}

// ── Chargement GeoJSON ──
function loadGeoJSON(url, style, color) {
  fetch(url)
    .then(res => res.json())
    .then(geojson => {
      const features = new ol.format.GeoJSON().readFeatures(geojson, {
        dataProjection: "EPSG:2056",
        featureProjection: "EPSG:2056",
      });
      const source = new ol.source.Vector({ features });
      poiSources[color] = source;
      const layer = new ol.layer.Vector({ source, style });
      layer.set("poiColor", color);
      map.addLayer(layer);
    });
}

loadGeoJSON("./fire_station.geojson", blueStyle,  "blue");
loadGeoJSON("./police_v2.geojson",    greenStyle, "green");
loadGeoJSON("./hospital.geojson",     redStyle,   "red");

// ── Recherche d'adresse (Nominatim) ──
const searchInput   = document.getElementById("search-input");
const searchClear   = document.getElementById("search-clear");
const searchResults = document.getElementById("search-results");

let searchMarkerLayer = null;
let searchDebounce    = null;

searchInput.addEventListener("input", () => {
  searchClear.style.display = searchInput.value.length > 0 ? "flex" : "none";
  clearTimeout(searchDebounce);
  if (searchInput.value.trim().length >= 3) {
    searchDebounce = setTimeout(() => searchAddress(searchInput.value), 350);
  } else {
    searchResults.style.display = "none";
  }
});

searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { clearTimeout(searchDebounce); searchAddress(searchInput.value); }
  if (e.key === "Escape") closeSearch();
});

searchClear.addEventListener("click", () => {
  searchInput.value = "";
  searchClear.style.display = "none";
  searchResults.style.display = "none";
  if (searchMarkerLayer) { map.removeLayer(searchMarkerLayer); searchMarkerLayer = null; }
  searchInput.focus();
});

async function searchAddress(query) {
  if (!query.trim()) return;
  searchResults.innerHTML = "<li class='search-loading'>Recherche…</li>";
  searchResults.style.display = "block";
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&countrycodes=ch&format=json&limit=6&addressdetails=1`;
    const res  = await fetch(url, { headers: { "Accept-Language": "fr" } });
    const data = await res.json();
    searchResults.innerHTML = "";
    if (!data.length) { searchResults.innerHTML = "<li class='search-no-result'>Aucun résultat trouvé</li>"; return; }
    data.forEach(item => {
      const li = document.createElement("li");
      const mainText = formatMainText(item);
      const subText  = formatSubText(item);
      li.innerHTML = `
        <span class="result-icon">${getResultIcon(item.type, item.class)}</span>
        <span class="result-text">
          <span class="result-main">${mainText}</span>
          ${subText ? `<span class="result-sub">${subText}</span>` : ""}
        </span>`;
      li.addEventListener("click", () => {
        goToResult(item);
        searchResults.style.display = "none";
        searchInput.value = mainText;
        searchClear.style.display = "flex";
      });
      searchResults.appendChild(li);
    });
    searchResults.style.display = "block";
  } catch {
    searchResults.innerHTML = "<li class='search-no-result'>Erreur de connexion</li>";
  }
}

function getResultIcon(type, cls) {
  if (cls === "highway" || type === "road") return "🛣️";
  if (cls === "place" && (type === "city" || type === "town")) return "🏙️";
  if (cls === "place" && type === "village") return "🏡";
  if (cls === "amenity" && type === "hospital") return "🏥";
  if (cls === "building") return "🏢";
  return "📌";
}

function formatMainText(item) {
  const a = item.address || {};
  return a.road || a.pedestrian || a.suburb || a.city || a.town || a.village || item.display_name.split(",")[0];
}

function formatSubText(item) {
  const a = item.address || {};
  const parts = [];
  if (a.postcode) parts.push(a.postcode);
  if (a.city || a.town || a.village) parts.push(a.city || a.town || a.village);
  if (a.state) parts.push(a.state);
  return parts.join(", ");
}

function goToResult(item) {
  const coords = ol.proj.transform([parseFloat(item.lon), parseFloat(item.lat)], "EPSG:4326", "EPSG:2056");
  if (searchMarkerLayer) map.removeLayer(searchMarkerLayer);
  const marker = new ol.Feature({ geometry: new ol.geom.Point(coords) });
  marker.setStyle(new ol.style.Style({
    image: new ol.style.RegularShape({
      points: 4, radius: 10, radius2: 0, angle: Math.PI / 4,
      fill: new ol.style.Fill({ color: "orange" }),
      stroke: new ol.style.Stroke({ color: "white", width: 2 }),
    }),
  }));
  searchMarkerLayer = new ol.layer.Vector({ source: new ol.source.Vector({ features: [marker] }), zIndex: 999 });
  map.addLayer(searchMarkerLayer);
  map.getView().animate({ center: coords, zoom: 7, duration: 700 });
}

function closeSearch() { searchResults.style.display = "none"; }
document.addEventListener("click", (e) => { if (!e.target.closest("#search-bar")) closeSearch(); });
