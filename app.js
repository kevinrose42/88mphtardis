(async function () {
  const data = await fetch("data/photos.json").then((r) => r.json());
  document.getElementById("title").textContent = data.album || "Photo Map";
  document.title = `${data.album} – Photo Map`;
  document.getElementById("stats").textContent =
    `${data.photos.length} of ${data.total} photos have location data`;

  // Google Photos image URLs accept size suffixes (=w800, =w2048-h2048, ...).
  const sized = (p, w) => `${p.url}=w${w}`;
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const caption = (p) => p.description || "";

  // Group photos that share the exact same coordinates into one pin.
  const groups = new Map();
  for (const p of data.photos) {
    const k = `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }

  await loadMaps(window.GOOGLE_MAPS_API_KEY);
  const { Map: GoogleMap, InfoWindow } = await google.maps.importLibrary("maps");
  const { AdvancedMarkerElement, PinElement } = await google.maps.importLibrary("marker");

  const map = new GoogleMap(document.getElementById("map"), {
    mapId: "DEMO_MAP_ID",
    center: { lat: 37.45, lng: -122.18 },
    zoom: 13,
    gestureHandling: "greedy",
  });
  const info = new InfoWindow();
  const bounds = new google.maps.LatLngBounds();

  const markers = [];
  for (const photos of groups.values()) {
    const pos = { lat: photos[0].lat, lng: photos[0].lng };
    bounds.extend(pos);
    const el = document.createElement("div");
    el.className = "pin";
    el.appendChild(new PinElement({ background: "#d93025", borderColor: "#a50e0e", glyphColor: "#fff" }).element);
    if (photos.length > 1) {
      const b = document.createElement("span");
      b.className = "badge";
      b.textContent = photos.length;
      el.appendChild(b);
    }
    const marker = new AdvancedMarkerElement({ position: pos, content: el, title: caption(photos[0]) || "Photo" });
    marker.addListener("click", () => openInfo(marker, photos, 0));
    markers.push(marker);
  }
  new markerClusterer.MarkerClusterer({ map, markers });
  // Fit to the main cluster (pins within ~50 km of the median) so a few far-away
  // photos don't force a whole-world view. They're still on the map.
  const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const mLat = med(data.photos.map((p) => p.lat)), mLng = med(data.photos.map((p) => p.lng));
  const core = new google.maps.LatLngBounds();
  for (const m of markers) {
    const { lat, lng } = m.position;
    const la = typeof lat === "function" ? lat() : lat, ln = typeof lng === "function" ? lng() : lng;
    if (Math.abs(la - mLat) < 0.5 && Math.abs(ln - mLng) < 0.5) core.extend({ lat: la, lng: ln });
  }
  const fit = core.isEmpty() ? bounds : core;
  if (!fit.isEmpty()) map.fitBounds(fit, 40);

  function openInfo(marker, photos, i) {
    const p = photos[i];
    const box = document.createElement("div");
    box.className = "iw";
    box.innerHTML = `
      <img src="${sized(p, 600)}" alt="${esc(caption(p))}" />
      ${caption(p) ? `<p class="cap">${esc(caption(p))}</p>` : ""}
      <div class="meta">${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</div>
      ${photos.length > 1 ? `<div class="nav"><button data-d="-1" ${i === 0 ? "disabled" : ""}>&lsaquo; Prev</button>
        <span>${i + 1} / ${photos.length}</span>
        <button data-d="1" ${i === photos.length - 1 ? "disabled" : ""}>Next &rsaquo;</button></div>` : ""}`;
    box.querySelector("img").addEventListener("click", () => openLightbox(photos, i));
    box.querySelectorAll("button[data-d]").forEach((b) =>
      b.addEventListener("click", () => openInfo(marker, photos, i + Number(b.dataset.d))));
    info.setContent(box);
    info.open({ map, anchor: marker });
  }

  // Lightbox
  const lb = document.getElementById("lightbox");
  const lbImg = document.getElementById("lb-img");
  const lbCap = document.getElementById("lb-cap");
  const prev = lb.querySelector(".lb-prev"), next = lb.querySelector(".lb-next");
  let lbList = [], lbIdx = 0;
  function showLb() {
    const p = lbList[lbIdx];
    lbImg.src = `${p.url}=w2048-h2048`;
    lbCap.textContent = caption(p);
    prev.hidden = lbIdx === 0;
    next.hidden = lbIdx === lbList.length - 1;
  }
  function openLightbox(list, i) { lbList = list; lbIdx = i; showLb(); lb.hidden = false; }
  const closeLb = () => { lb.hidden = true; lbImg.src = ""; };
  lb.querySelector(".lb-close").onclick = closeLb;
  prev.onclick = (e) => { e.stopPropagation(); lbIdx--; showLb(); };
  next.onclick = (e) => { e.stopPropagation(); lbIdx++; showLb(); };
  lb.addEventListener("click", (e) => { if (e.target === lb) closeLb(); });
  document.addEventListener("keydown", (e) => {
    if (lb.hidden) return;
    if (e.key === "Escape") closeLb();
    if (e.key === "ArrowLeft" && lbIdx > 0) { lbIdx--; showLb(); }
    if (e.key === "ArrowRight" && lbIdx < lbList.length - 1) { lbIdx++; showLb(); }
  });

  // Google's recommended dynamic bootstrap loader.
  function loadMaps(key) {
    return new Promise((resolve, reject) => {
      window.__mapsReady = resolve;
      const s = document.createElement("script");
      s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=__mapsReady`;
      s.async = true;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }
})();
