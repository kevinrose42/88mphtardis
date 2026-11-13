(async function () {
  const data = await fetch("data/photos.json").then((r) => r.json());
  document.getElementById("title").textContent = data.album || "Photo Map";
  document.title = `${data.album} – Photo Map`;
  document.getElementById("stats").textContent =
    `${data.photos.length} of ${data.total} photos have location data`;

  const rawAlignments = (window.STREETVIEW_ALIGNMENTS && window.STREETVIEW_ALIGNMENTS.byPhotoId) || {};
  const alignmentByPhotoId = new Map(Object.entries(rawAlignments));
  const alignmentByCatalogId = new Map(
    Object.values(rawAlignments)
      .filter((a) => a && a.catalogId)
      .map((a) => [String(a.catalogId), a])
  );

  for (const p of data.photos) {
    const ident = p.info && p.info.identifier ? String(p.info.identifier) : null;
    p._alignment =
      alignmentByPhotoId.get(p.id) ||
      (ident ? alignmentByCatalogId.get(ident) : null) ||
      null;
  }

  const alignedPhotos = data.photos.filter((p) => Boolean(p._alignment));
  const alignedCountEl = document.getElementById("aligned-count");
  if (alignedCountEl) alignedCountEl.textContent = String(alignedPhotos.length);

  // Google Photos image URLs accept size suffixes (=w800, =w2048-h2048, ...).
  const sized = (p, w) => `${p.url}=w${w}`;
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const caption = (p) => (p.info && p.info.title) || p.description || "";

  // Format structured JSON info blob if present on a photo.
  function renderInfoDetails(p) {
    const info = p.info;
    if (!info || typeof info !== "object") {
      return caption(p) ? `<p class="cap">${esc(caption(p))}</p>` : "";
    }

    const parts = [];
    if (info.title) {
      parts.push(`<h3 class="info-title">${esc(info.title)}</h3>`);
    }
    if (info.description) {
      parts.push(`<p class="cap">${esc(info.description)}</p>`);
    }

    // Ordered human-friendly fields to display from the JSON blob
    const fieldOrder = [
      ["date", "Date"],
      ["coverage", "Coverage"],
      ["creator", "Creator"],
      ["collection", "Collection"],
      ["subjects", "Subjects"],
      ["tags", "Tags"],
      ["relation", "Relation"],
      ["source", "Source"],
      ["publisher", "Publisher"],
      ["citation", "Citation"],
      ["type", "Type"],
      ["item_type", "Item Type"],
      ["original_format", "Original Format"],
      ["physical_dimensions", "Physical Dimensions"],
      ["dimensions", "Image Dimensions"],
      ["identifier", "Identifier"],
      ["item_id", "Item ID"],
      ["page", "Page"],
      ["location_confidence", "Location Confidence"],
      ["how_location_was_determined", "How Location Was Determined"],
      ["year_confidence", "Year Confidence"],
      ["how_year_was_determined", "How Year Was Determined"],
      ["rights", "Rights"],
    ];

    const shownKeys = new Set([
      "title",
      "description",
      "item_page_url",
      "original_image_url",
      "square_thumbnail_url",
      ...fieldOrder.map(([k]) => k),
    ]);

    const rows = [];
    const formatVal = (val) => {
      if (val === null || val === undefined || val === "") return "";
      if (Array.isArray(val)) {
        return esc(
          val
            .map((v) => (v && typeof v === "object" ? v.display || JSON.stringify(v) : String(v)))
            .join(", ")
        );
      }
      if (typeof val === "object") {
        if (val.display) return esc(val.display);
        return esc(JSON.stringify(val));
      }
      return esc(String(val));
    };

    for (const [key, label] of fieldOrder) {
      const formatted = formatVal(info[key]);
      if (formatted) {
        rows.push(`<div class="info-row"><dt>${esc(label)}</dt><dd>${formatted}</dd></div>`);
      }
    }

    // Include any additional unexpected keys in the JSON blob so nothing is hidden
    for (const [key, val] of Object.entries(info)) {
      if (shownKeys.has(key)) continue;
      const formatted = formatVal(val);
      if (formatted) {
        const label = key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        rows.push(`<div class="info-row"><dt>${esc(label)}</dt><dd>${formatted}</dd></div>`);
      }
    }

    if (rows.length) {
      parts.push(`<dl class="info-dl">${rows.join("")}</dl>`);
    }

    const links = [];
    if (p._alignment && p._alignment.streetViewPanoUrl) {
      links.push(`<a href="${esc(p._alignment.streetViewPanoUrl)}" target="_blank" rel="noopener">Matched 360&deg; Street View &#8599;</a>`);
    }
    if (info.item_page_url) {
      links.push(`<a href="${esc(info.item_page_url)}" target="_blank" rel="noopener">Library Record &#8599;</a>`);
    }
    if (info.original_image_url) {
      links.push(`<a href="${esc(info.original_image_url)}" target="_blank" rel="noopener">Original Image &#8599;</a>`);
    }
    if (links.length) {
      parts.push(`<div class="info-links">${links.join(" &middot; ")}</div>`);
    }

    return parts.join("");
  }

  // Group photos that share the exact same coordinates into one pin, surfacing aligned landmarks first.
  const groups = new Map();
  for (const p of data.photos) {
    const k = `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => Number(Boolean(b._alignment)) - Number(Boolean(a._alignment)));
  }

  // Interactive Lightbox & Past-in-Present Street View State (wired before map so header CTA works immediately even if Google Maps takes a moment)
  const lb = document.getElementById("lightbox");
  const lbTopbar = document.getElementById("lb-topbar");
  const lbModeTabs = document.getElementById("lb-mode-tabs");
  const lbPanoLink = document.getElementById("lb-pano-link");
  const lbPipStage = document.getElementById("lb-pip-stage");
  const lbPipCanvas = document.getElementById("lb-pip-canvas");
  const lbSvImg = document.getElementById("lb-sv-img");
  const lbInsetFrame = document.getElementById("lb-inset-frame");
  const lbInsetImg = document.getElementById("lb-inset-img");
  const lbWipeDivider = document.getElementById("lb-wipe-divider");
  const lbTagPast = document.getElementById("lb-tag-past");
  const lbTagNow = document.getElementById("lb-tag-now");
  const lbImg = document.getElementById("lb-img");
  const lbPipDock = document.getElementById("lb-pip-dock");
  const lbPipSlider = document.getElementById("lb-pip-slider");
  const lbPipVal = document.getElementById("lb-pip-val");
  const lbPresetNow = document.getElementById("lb-preset-now");
  const lbPresetGhost = document.getElementById("lb-preset-ghost");
  const lbPresetThen = document.getElementById("lb-preset-then");
  const lbFrameBtn = document.getElementById("lb-frame-btn");
  const lbCap = document.getElementById("lb-cap");
  const prev = lb.querySelector(".lb-prev"), next = lb.querySelector(".lb-next");

  let lbList = [], lbIdx = 0;
  let pipMode = "pip"; // 'pip' | 'wipe' | 'original'
  let pipOpacity = 100;
  let pipWipe = 50;
  let pipFramed = false;

  function syncLbPip() {
    const p = lbList[lbIdx];
    const al = p && p._alignment;
    if (!al) {
      lbTopbar.hidden = true;
      lbPipStage.hidden = true;
      lbPipDock.hidden = true;
      lbImg.hidden = false;
      return;
    }

    lbTopbar.hidden = false;
    lbPanoLink.href = al.streetViewPanoUrl;

    lbModeTabs.querySelectorAll(".lb-mode-btn").forEach((btn) => {
      const active = btn.dataset.mode === pipMode;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });

    if (pipMode === "original") {
      lbPipStage.hidden = true;
      lbPipDock.hidden = true;
      lbImg.hidden = false;
      return;
    }

    lbImg.hidden = true;
    lbPipStage.hidden = false;
    lbPipDock.hidden = false;

    lbInsetFrame.classList.toggle("framed", pipFramed);
    lbFrameBtn.setAttribute("aria-pressed", pipFramed ? "true" : "false");
    lbFrameBtn.classList.toggle("active", pipFramed);

    const isWipe = pipMode === "wipe";
    lbPipCanvas.classList.toggle("wipe-mode", isWipe);
    lbWipeDivider.hidden = !isWipe;

    if (isWipe) {
      const w = Math.max(0, Math.min(100, pipWipe));
      lbInsetImg.style.opacity = "1";
      lbPipCanvas.style.setProperty("--wipe-frac", (w / 100).toFixed(4));
      lbPipCanvas.style.setProperty("--wipe-pct", `${w.toFixed(2)}%`);
      lbWipeDivider.setAttribute("aria-valuenow", String(Math.round(w)));
      lbPipSlider.value = String(Math.round(w));
      lbPipVal.textContent = `${Math.round(w)}%`;
      lbPresetNow.classList.toggle("active", Math.round(w) === 0);
      lbPresetGhost.classList.toggle("active", Math.round(w) === 50);
      lbPresetGhost.textContent = "50%";
      lbPresetThen.classList.toggle("active", Math.round(w) === 100);
    } else {
      const o = Math.max(0, Math.min(100, pipOpacity));
      lbInsetImg.style.opacity = (o / 100).toFixed(3);
      lbPipSlider.value = String(Math.round(o));
      lbPipVal.textContent = `${Math.round(o)}%`;
      lbPresetNow.classList.toggle("active", Math.round(o) === 0);
      lbPresetGhost.classList.toggle("active", Math.round(o) === 55);
      lbPresetGhost.textContent = "55%";
      lbPresetThen.classList.toggle("active", Math.round(o) === 100);
    }
  }

  function showLb() {
    const p = lbList[lbIdx];
    lbImg.src = `${p.url}=w2048-h2048`;
    lbImg.alt = caption(p);

    const al = p._alignment;
    if (al) {
      if (lbSvImg.getAttribute("src") !== al.svImage) {
        lbSvImg.src = al.svImage;
      }
      lbInsetImg.src = al.insetImage;
      lbPipCanvas.style.setProperty("--inset-left", `${al.rectPct.left}%`);
      lbPipCanvas.style.setProperty("--inset-top", `${al.rectPct.top}%`);
      lbPipCanvas.style.setProperty("--inset-width", `${al.rectPct.width}%`);
      lbPipCanvas.style.setProperty("--inset-height", `${al.rectPct.height}%`);
      lbTagPast.textContent = al.historicalLabel || "Archival";
      lbTagNow.textContent = al.modernLabel || "Street View";
    }
    syncLbPip();

    const baseCap =
      p.info && (p.info.title || p.info.description)
        ? [p.info.title, p.info.description].filter(Boolean).join(" — ")
        : caption(p);
    lbCap.textContent = al
      ? `${baseCap}  [${al.inliers} LoFTR inliers · ${al.reprojErrorPx} px Street View registration]`
      : baseCap;

    prev.hidden = lbIdx === 0;
    next.hidden = lbIdx === lbList.length - 1;
  }

  function openLightbox(list, i, preferredMode) {
    lbList = list;
    lbIdx = i;
    if (preferredMode) {
      pipMode = preferredMode;
    } else if (list[i] && list[i]._alignment && pipMode === "original") {
      pipMode = "pip";
    }
    showLb();
    lb.hidden = false;
  }

  const closeLb = () => { lb.hidden = true; lbImg.src = ""; };
  lb.querySelector(".lb-close").onclick = closeLb;
  prev.onclick = (e) => { e.stopPropagation(); if (lbIdx > 0) { lbIdx--; showLb(); } };
  next.onclick = (e) => { e.stopPropagation(); if (lbIdx < lbList.length - 1) { lbIdx++; showLb(); } };
  lb.addEventListener("click", (e) => { if (e.target === lb) closeLb(); });

  lbModeTabs.addEventListener("click", (e) => {
    const btn = e.target.closest(".lb-mode-btn");
    if (!btn || !btn.dataset.mode) return;
    pipMode = btn.dataset.mode;
    syncLbPip();
  });

  lbPipSlider.addEventListener("input", (e) => {
    const v = Number(e.target.value);
    if (pipMode === "wipe") pipWipe = v;
    else pipOpacity = v;
    syncLbPip();
  });

  lbPresetNow.onclick = () => { if (pipMode === "wipe") pipWipe = 0; else pipOpacity = 0; syncLbPip(); };
  lbPresetGhost.onclick = () => { if (pipMode === "wipe") pipWipe = 50; else pipOpacity = 55; syncLbPip(); };
  lbPresetThen.onclick = () => { if (pipMode === "wipe") pipWipe = 100; else pipOpacity = 100; syncLbPip(); };
  lbFrameBtn.onclick = () => { pipFramed = !pipFramed; syncLbPip(); };

  // Pointer drag on Split Wipe curtain
  let draggingWipe = false;
  const setWipeFromPointer = (clientX) => {
    const rect = lbInsetFrame.getBoundingClientRect();
    if (rect.width <= 0) return;
    pipWipe = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
    syncLbPip();
  };
  lbPipCanvas.addEventListener("pointerdown", (e) => {
    if (pipMode !== "wipe") return;
    draggingWipe = true;
    if (lbPipCanvas.setPointerCapture) {
      try { lbPipCanvas.setPointerCapture(e.pointerId); } catch (_) {}
    }
    setWipeFromPointer(e.clientX);
  });
  lbPipCanvas.addEventListener("pointermove", (e) => {
    if (!draggingWipe || pipMode !== "wipe") return;
    setWipeFromPointer(e.clientX);
  });
  lbPipCanvas.addEventListener("pointerup", () => { draggingWipe = false; });
  lbPipCanvas.addEventListener("pointercancel", () => { draggingWipe = false; });

  document.addEventListener("keydown", (e) => {
    if (lb.hidden) return;
    if (e.target && e.target.matches("input, textarea, select")) return;
    if (e.key === "Escape") closeLb();
    if (e.key === "ArrowLeft" && lbIdx > 0) { lbIdx--; showLb(); }
    if (e.key === "ArrowRight" && lbIdx < lbList.length - 1) { lbIdx++; showLb(); }
  });

  const showcaseBtn = document.getElementById("open-showcase-btn");
  if (showcaseBtn) {
    showcaseBtn.addEventListener("click", () => {
      if (alignedPhotos.length > 0) {
        openLightbox(alignedPhotos, 0, "pip");
      }
    });
  }

  await loadMaps(window.GOOGLE_MAPS_API_KEY);
  const { Map: GoogleMap, InfoWindow } = await google.maps.importLibrary("maps");
  const { AdvancedMarkerElement, PinElement } = await google.maps.importLibrary("marker");

  const map = new GoogleMap(document.getElementById("map"), {
    mapId: "DEMO_MAP_ID",
    center: { lat: 37.2, lng: -122.1 },
    zoom: 10,
    gestureHandling: "greedy",
  });
  const info = new InfoWindow();
  const bounds = new google.maps.LatLngBounds();

  const allMarkers = [];
  const alignedMarkers = [];

  for (const photos of groups.values()) {
    const pos = { lat: photos[0].lat, lng: photos[0].lng };
    bounds.extend(pos);
    const hasAligned = photos.some((p) => Boolean(p._alignment));
    const el = document.createElement("div");
    el.className = hasAligned ? "pin pin-aligned" : "pin";
    el.appendChild(
      new PinElement(
        hasAligned
          ? { background: "#d97706", borderColor: "#92400e", glyphColor: "#fff" }
          : { background: "#d93025", borderColor: "#a50e0e", glyphColor: "#fff" }
      ).element
    );
    if (photos.length > 1) {
      const b = document.createElement("span");
      b.className = "badge";
      b.textContent = photos.length;
      el.appendChild(b);
    }
    const marker = new AdvancedMarkerElement({
      position: pos,
      content: el,
      title: (hasAligned ? "[Then & Now] " : "") + (caption(photos[0]) || "Photo"),
    });
    marker.addListener("click", () => openInfo(marker, photos, 0));
    allMarkers.push(marker);
    if (hasAligned) alignedMarkers.push(marker);
  }

  const clusterer = new markerClusterer.MarkerClusterer({ map, markers: allMarkers });
  // Fit to the main California/Bay Area + Santa Cruz region (pins within ~1.5 deg of the median)
  // so a few far-away photos (like Ireland) don't force a whole-world view. They're still on the map.
  const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const mLat = med(data.photos.map((p) => p.lat)), mLng = med(data.photos.map((p) => p.lng));
  const core = new google.maps.LatLngBounds();
  for (const m of allMarkers) {
    const { lat, lng } = m.position;
    const la = typeof lat === "function" ? lat() : lat, ln = typeof lng === "function" ? lng() : lng;
    if (Math.abs(la - mLat) < 1.5 && Math.abs(ln - mLng) < 1.5) core.extend({ lat: la, lng: ln });
  }
  const fit = core.isEmpty() ? bounds : core;
  if (!fit.isEmpty()) map.fitBounds(fit, 40);

  const filterAlignedBtn = document.getElementById("filter-aligned-btn");
  let showingAlignedOnly = false;
  if (filterAlignedBtn) {
    filterAlignedBtn.addEventListener("click", () => {
      showingAlignedOnly = !showingAlignedOnly;
      filterAlignedBtn.setAttribute("aria-pressed", showingAlignedOnly ? "true" : "false");
      info.close();
      clusterer.clearMarkers();
      const targetMarkers = showingAlignedOnly ? alignedMarkers : allMarkers;
      clusterer.addMarkers(targetMarkers);
      if (showingAlignedOnly && alignedMarkers.length > 0) {
        const ab = new google.maps.LatLngBounds();
        for (const m of alignedMarkers) ab.extend(m.position);
        map.fitBounds(ab, 60);
      } else if (!fit.isEmpty()) {
        map.fitBounds(fit, 40);
      }
    });
  }

  function openInfo(marker, photos, i) {
    const p = photos[i];
    const firstAlignedIdx = photos.findIndex((item) => Boolean(item._alignment));
    const box = document.createElement("div");
    box.className = p.info ? "iw iw-rich" : "iw";
    box.innerHTML = `
      ${photos.length > 1 ? `<div class="nav nav-top"><button data-d="-1" ${i === 0 ? "disabled" : ""}>&lsaquo; Prev</button>
        <span>${i + 1} / ${photos.length} at this spot</span>
        <button data-d="1" ${i === photos.length - 1 ? "disabled" : ""}>Next &rsaquo;</button></div>` : ""}
      <img src="${sized(p, 600)}" alt="${esc(caption(p))}" title="Click to view full size" />
      ${p._alignment
        ? `<button type="button" class="iw-pip-cta" data-pip="open">Compare Past-in-Present Street View</button>`
        : firstAlignedIdx >= 0
          ? `<button type="button" class="iw-pip-jump" data-jump="${firstAlignedIdx}">View aligned Then &amp; Now photo at this spot</button>`
          : ""}
      <div class="iw-body">
        ${renderInfoDetails(p)}
        <div class="meta">${p.album ? `${esc(p.album)} &middot; ` : ""}${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</div>
      </div>`;
    box.querySelector("img").addEventListener("click", () => openLightbox(photos, i));
    const pipBtn = box.querySelector('button[data-pip="open"]');
    if (pipBtn) {
      pipBtn.addEventListener("click", () => openLightbox(photos, i, "pip"));
    }
    const jumpBtn = box.querySelector("button[data-jump]");
    if (jumpBtn) {
      jumpBtn.addEventListener("click", () => openInfo(marker, photos, Number(jumpBtn.dataset.jump)));
    }
    box.querySelectorAll("button[data-d]").forEach((b) =>
      b.addEventListener("click", () => openInfo(marker, photos, i + Number(b.dataset.d))));
    info.setContent(box);
    info.open({ map, anchor: marker });
  }

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
