/* Trek4Free – Explore map (save selected point for details page) */
(function initExploreMap() {
  if (window.__t4fMapBooted) return;
  window.__t4fMapBooted = true;

  if (typeof L === "undefined") { console.error("[map.js] Leaflet not found."); return; }
  const mapEl = document.getElementById("map");
  if (!mapEl) { console.error("[map.js] #map element missing."); return; }

  // ---- Persisted view ----
  const US_CENTER = [39.5, -98.35];
  const US_ZOOM = 4;

  let savedCenter = null, savedZoom = null, savedBase = "osm";
  try {
    savedCenter = JSON.parse(sessionStorage.getItem("mapCenter")) || null;
    const z = parseInt(sessionStorage.getItem("mapZoom"), 10);
    savedZoom = Number.isFinite(z) ? z : null;
    savedBase = sessionStorage.getItem("baseLayer") || "osm";
  } catch(_) {}

  // URL reset switch (?reset=1)
  const forceReset = new URL(window.location.href).searchParams.get("reset") === "1";
  if (forceReset) {
    try {
      sessionStorage.removeItem("mapCenter");
      sessionStorage.removeItem("mapZoom");
    } catch(_) {}
  }

  // ---- Map init ----
  const map = L.map(mapEl, {
    center: savedCenter || US_CENTER,
    zoom: savedZoom ?? US_ZOOM,
    zoomControl: true,
  });

  const persistView = () => {
    try {
      sessionStorage.setItem("mapCenter", JSON.stringify(map.getCenter()));
      sessionStorage.setItem("mapZoom", String(map.getZoom()));
    } catch(_) {}
  };
  map.on("moveend", persistView);
  map.on("zoomend", persistView);

  // ---- Base layers ----
  const baseLayers = {
    osm: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors", maxZoom: 19
    }),
    esri: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      attribution: "Tiles &copy; Esri, Maxar", maxZoom: 19
    }),
    opentopo: L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
      attribution: "Map data &copy; OpenTopoMap", maxZoom: 17
    }),
    usgs: L.tileLayer("https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}", {
      attribution: "Tiles courtesy of USGS", maxZoom: 16
    }),
  };

  let activeBase = baseLayers[savedBase] || baseLayers.osm;
  activeBase.addTo(map);

  // ---- Floating basemap toggles + Reset ----
  const wrap = document.querySelector(".map-wrap");
  if (wrap) {
    const toggles = document.createElement("div");
    toggles.className = "map-toggles";
    const defs = [
      { id: "osm", label: "🗺️ OSM" },
      { id: "esri", label: "🛰️ Satellite" },
      { id: "opentopo", label: "🗻 Topo" },
      { id: "usgs", label: "🧭 USGS" },
      { id: "reset", label: "↩︎ Reset" },
    ];
    defs.forEach(({ id, label }) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "map-toggle";
      btn.textContent = label;

      if (id === "reset") {
        btn.addEventListener("click", () => { map.setView(US_CENTER, US_ZOOM); persistView(); });
      } else {
        btn.dataset.layer = id;
        btn.setAttribute("aria-pressed", id === savedBase ? "true" : "false");
        btn.addEventListener("click", () => {
          if (id === savedBase) return;
          if (activeBase) map.removeLayer(activeBase);
          activeBase = baseLayers[id] || baseLayers.osm;
          activeBase.addTo(map);
          savedBase = id;
          try { sessionStorage.setItem("baseLayer", id); } catch(_) {}
          toggles.querySelectorAll(".map-toggle").forEach(b => b.setAttribute("aria-pressed","false"));
          btn.setAttribute("aria-pressed","true");
        });
      }
      toggles.appendChild(btn);
    });
    wrap.appendChild(toggles);
  }

  // ---- Mobile sidebar toggle ----
  const sidebar = document.getElementById("sidebar");
  const sidebarToggle = document.getElementById("sidebarToggle");
  if (sidebar && sidebarToggle) {
    const closeSidebar = () => { sidebar.classList.remove("is-open"); sidebarToggle.setAttribute("aria-expanded","false"); };
    const openSidebar  = () => { sidebar.classList.add("is-open"); sidebarToggle.setAttribute("aria-expanded","true"); };
    sidebarToggle.addEventListener("click", () => {
      if (sidebar.classList.contains("is-open")) closeSidebar(); else openSidebar();
    });
    map.on("click", () => {
      if (window.matchMedia("(max-width: 980px)").matches) closeSidebar();
    });
  }

  // ---- Marker icons ----
  L.Marker.prototype.options.icon = L.icon({
    iconUrl: "/images/markers/default.png",
    iconSize: [45, 45],
    iconAnchor: [22, 45],
    popupAnchor: [0, -40],
  });

  const getCustomIcon = (type = "default") => {
    const valid = ["hiking","camping","at","freecamping","swimming","backpackcamping"];
    const icon = valid.includes(type) ? type : "default";
    return L.icon({
      iconUrl: `/images/markers/${icon}.png`,
      iconSize: [45, 45],
      iconAnchor: [22, 45],
      popupAnchor: [0, -40],
    });
  };

  const truncate = (t, n = 160) => (t && t.length > n ? t.slice(0, n) + "…" : (t || ""));
  const slugify  = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

  // ---- Datasets + clustering ----
  const datasets = [
    { id: "hiking", urls: ["/data/trailheads-ridb.json", "/data/trailheads-usfs.json"], iconType: "hiking" },
    { id: "camping", urls: ["/data/campgrounds-usfs-ridb.json"], iconType: "camping" },
    { id: "freecamping", urls: ["/data/freecamping.json", "/data/freecamping-usfs.json"], iconType: "freecamping" },
    { id: "at", urls: ["/data/at-points.json"], iconType: "at" },
    { id: "swimming", urls: ["/data/swimming-holes.json"], iconType: "swimming" },
    { id: "backpackcamping-usfs", urls: ["/data/backpackcamping-usfs.json"], iconType: "backpackcamping" },
  ];

  const allMarkers = [];
  const layerMap = {};

  datasets.forEach(({ id, urls, iconType }) => {
    const clusterGroup = (L.markerClusterGroup ? L.markerClusterGroup() : L.layerGroup());

    Promise.all(urls.map(u => fetch(u).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })))
      .then(parts => parts.flat())
      .then(data => {
        data.forEach(point => {
          const lat = parseFloat(point.latitude ?? point.lat);
          const lon = parseFloat(point.longitude ?? point.lon);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

          const name = point.name || point.trail_name || point.site_name || "Unnamed";
          const desc = point.description || point.notes || "";
          const slug = point.slug || slugify(name);

          // Minimal payload used by /trail/[slug]
          const payload = {
            name,
            latitude: lat,
            longitude: lon,
            description: desc,
            site_type: point.site_type || point.type || point.category || "",
            source: point.source || "",
            location: point.location || point.agency || point.region || "",
            fee: point.fee, site_count: point.site_count, season: point.season,
            water: point.water, bathrooms: point.bathrooms,
            slug
          };

          const marker = L.marker([lat, lon], { icon: getCustomIcon(iconType) });
          marker.name = String(name);
          marker.__payload = payload;         // keep a copy on the marker

          // put a small, URL-safe JSON blob on the link
          const compact = encodeURIComponent(JSON.stringify(payload));

          marker.bindPopup(`
            <strong>${name}</strong><br>
            <p>${truncate(desc)}</p>
            <a href="#" class="map-popup-link"
               data-slug="${slug.replace(/"/g, "&quot;")}"
               data-p="${compact}">🔍 View Details</a>
          `);

          marker.on("popupopen", persistView);
          clusterGroup.addLayer(marker);
          allMarkers.push(marker);
        });

        layerMap[id] = clusterGroup;
        const checkbox = document.getElementById(id);
        if (checkbox?.checked) map.addLayer(clusterGroup);
      })
      .catch(err => console.warn(`[map.js] Failed to load dataset "${id}":`, err));
  });

  // ---- Filters (checkbox -> layer) ----
  document.querySelectorAll('input[type="checkbox"].filter').forEach(cb => {
    const label = cb.closest(".filter-chip");
    if (label) label.classList.toggle("is-active", cb.checked);

    cb.addEventListener("change", e => {
      const id = e.target.id;
      const layer = layerMap[id];
      if (label) label.classList.toggle("is-active", e.target.checked);
      if (!layer) return;
      e.target.checked ? map.addLayer(layer) : map.removeLayer(layer);
    });
  });

  // Clear Filters
  const clearBtn = document.getElementById("clearFilters");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      document.querySelectorAll('input[type="checkbox"].filter').forEach(cb => {
        cb.checked = false;
        const label = cb.closest(".filter-chip");
        if (label) label.classList.remove("is-active");
        const layer = layerMap[cb.id];
        if (layer) map.removeLayer(layer);
      });
    });
  }

  // ---- Search ----
  const searchBox = document.getElementById("search-box");
  const searchResults = document.getElementById("search-results");
  if (searchBox && searchResults) {
    searchBox.addEventListener("input", () => {
      const q = searchBox.value.toLowerCase().trim();
      searchResults.innerHTML = "";
      if (!q) return;

      const matches = allMarkers.filter(m => (m.name || "").toLowerCase().includes(q));
      matches.slice(0, 10).forEach(m => {
        const li = document.createElement("li");
        li.textContent = m.name;
        li.addEventListener("click", () => {
          map.setView(m.getLatLng(), 14);
          m.openPopup();
          searchResults.innerHTML = "";
          searchBox.value = "";
        });
        searchResults.appendChild(li);
      });
    });
  }

  // ---- Popup link -> detail page (now saves selection) ----
  document.addEventListener("click", e => {
    const a = e.target.closest(".map-popup-link");
    if (!a) return;
    e.preventDefault();

    try {
      const raw = a.dataset.p;
      if (raw) {
        const payload = JSON.parse(decodeURIComponent(raw));
        sessionStorage.setItem("selectedPoint", JSON.stringify(payload));
      }
    } catch(_) {}

    const slug = a.dataset.slug;
    if (slug) window.location.href = "/trail/" + slug;
  });
})();
