const $ = (id) => document.getElementById(id);

let meta = null;
let currentCases = [];
let currentIndex = -1;
let currentDetail = null;
let lastRenderedKey = "";
let saveInFlight = null;
let stats = null;
const volumeInfoCache = new Map(); // key: `${barcode}|${file}`

// Performance tuning
const PREVIEW_MAX = 256; // px, for "low" quality while dragging
const PREFETCH_RADIUS = 6; // slices to prefetch around current
const PREFETCH_DELAY_MS = 200;
const PREFETCH_MAX_IMAGES = 12;

// Viewer pan/zoom state (applied on <img> via CSS transform)
const view = {
  scale: 1,
  tx: 0,
  ty: 0,
  minScale: 0.05,
  maxScale: 8,
  autoFit: true,
};

let pendingRenderTimer = null;
let wheelHighResTimer = null;
let viewRafPending = false;
let prefetchTimer = null;
let prefetchGen = 0;
const prefetchImages = new Map(); // url -> Image

function setStatus(msg) {
  $("status").textContent = msg || "";
}

function setBoot(msg, opts = {}) {
  const el = $("boot");
  if (!el) return;
  if (!msg) {
    el.style.display = "none";
    return;
  }
  el.style.display = "block";
  el.textContent = msg;
  if (opts.error) {
    el.style.borderColor = "rgba(248, 113, 113, 0.55)";
  }
}

function isTypingTarget(el) {
  if (!el) return false;
  const tag = (el.tagName || "").toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select";
}

async function apiGet(path) {
  const res = await fetch(path);
  if (!res.ok) {
    let text = "";
    try {
      text = await res.text();
    } catch (_) {}
    throw new Error(`${res.status} ${res.statusText}${text ? `: ${text}` : ""}`);
  }
  return await res.json();
}

async function apiPost(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

function currentCase() {
  if (currentIndex < 0 || currentIndex >= currentCases.length) return null;
  return currentCases[currentIndex];
}

function buildCasesList() {
  const list = $("list");
  list.innerHTML = "";
  $("count").textContent = `${currentCases.length} 条`;

  currentCases.forEach((c, idx) => {
    const div = document.createElement("div");
    div.className = "item" + (idx === currentIndex ? " active" : "");
    const badge = c.has_cta ? `<span class="badge ok">CTA</span>` : `<span class="badge bad">无CTA</span>`;
    const check = c.checked ? `<span class="badge ok">✓ 已勾</span>` : `<span class="badge">未勾</span>`;
    div.innerHTML = `
      <div class="top">
        <div style="font-weight:700; overflow:hidden; text-overflow:ellipsis;">${c.barcode}</div>
        <div style="display:flex; gap:6px; flex:0 0 auto;">${badge}${check}</div>
      </div>
      <div class="sub">${c.cta_category || ""}${c.folder ? ` · ${c.folder}` : ""}</div>
    `;
    div.addEventListener("click", () => loadByIndex(idx));
    list.appendChild(div);
  });
}

async function refreshCases() {
  const category = $("category").value;
  const barcode = $("barcode").value.trim();
  setStatus("加载病例列表中…");
  refreshStats().catch(console.error);
  const data = await apiGet(`/api/cases?category=${encodeURIComponent(category)}&barcode=${encodeURIComponent(barcode)}`);
  currentCases = data.items || [];
  currentIndex = currentCases.length ? 0 : -1;
  buildCasesList();
  if (currentIndex >= 0) await loadByIndex(currentIndex, { skipSave: true });
  setStatus("");
}

async function saveCurrentLabelIfNeeded() {
  const c = currentCase();
  if (!c) return;
  if (!currentDetail) return;
  const checked = $("checked").checked;

  if (saveInFlight) await saveInFlight;
  saveInFlight = apiPost(`/api/case/${encodeURIComponent(c.barcode)}/label`, { checked })
    .then((r) => {
      c.checked = !!r.checked;
      currentDetail.checked = !!r.checked;
      $("updatedAt").textContent = r.updated_at || "";
      buildCasesList();
      refreshStats().catch(console.error);
    })
    .catch((e) => {
      console.error(e);
      setStatus("保存失败（请看控制台）");
    })
    .finally(() => {
      saveInFlight = null;
    });
  await saveInFlight;
}

function preferredFile(files) {
  if (!files || !files.length) return "";
  const upper = files.map((f) => f.toUpperCase());
  const i1 = upper.indexOf("CTA_1.NII.GZ");
  if (i1 >= 0) return files[i1];
  const i3 = upper.indexOf("CTA_3.NII.GZ");
  if (i3 >= 0) return files[i3];
  return files[0];
}

function setSelectOptions(sel, options, value) {
  sel.innerHTML = "";
  (options || []).forEach((opt) => {
    const o = document.createElement("option");
    if (opt && typeof opt === "object") {
      o.value = String(opt.value ?? "");
      o.textContent = String(opt.label ?? opt.value ?? "");
    } else {
      o.value = opt;
      o.textContent = opt;
    }
    sel.appendChild(o);
  });
  const values = (options || []).map((o) => (o && typeof o === "object" ? String(o.value ?? "") : String(o)));
  if (value != null && values.includes(String(value))) sel.value = String(value);
}

function buildCategoryOptions(selected) {
  const byCat = new Map();
  if (stats && Array.isArray(stats.by_category)) {
    stats.by_category.forEach((x) => {
      if (!x) return;
      const k = String(x.cta_category || "");
      byCat.set(k, { total: Number(x.total || 0), checked: Number(x.checked || 0) });
    });
  }

  const out = [];
  const allTotal = stats ? Number(stats.total || 0) : Number(meta?.total || 0);
  const allChecked = stats ? Number(stats.checked || 0) : 0;
  out.push({ value: "all", label: `all（已勾 ${allChecked}/${allTotal}）` });

  (meta?.categories || []).forEach((c) => {
    const s = byCat.get(String(c)) || { total: 0, checked: 0 };
    out.push({ value: c, label: `${c}（已勾 ${s.checked}/${s.total}）` });
  });

  setSelectOptions($("category"), out, selected || "all");
}

async function refreshStats() {
  if (!meta) return;
  stats = await apiGet("/api/stats");
  const selected = $("category")?.value || "all";
  buildCategoryOptions(selected);
}

async function ensureVolumeInfo(barcode, file) {
  if (!barcode || !file) return null;
  const key = `${barcode}|${file}`;
  if (volumeInfoCache.has(key)) return volumeInfoCache.get(key);
  const info = await apiGet(`/api/case/${encodeURIComponent(barcode)}/volume_info?file=${encodeURIComponent(file)}`);
  volumeInfoCache.set(key, info);
  return info;
}

function applyShapeToSlider(shape) {
  const axis = $("axis").value;
  if (!shape || shape.length < 3) {
    $("slice").max = "0";
    $("slice").value = "0";
    updateSliceLabel();
    return;
  }
  const maxIdx = axis === "x" ? shape[0] - 1 : axis === "y" ? shape[1] - 1 : shape[2] - 1;
  const max = Math.max(0, maxIdx);
  const cur = Math.min(parseInt($("slice").value || "0", 10), max);
  $("slice").max = String(max);
  $("slice").value = String(isFinite(cur) ? cur : 0);
  updateSliceLabel();
}

function frameRect() {
  const f = $("imgFrame");
  if (!f) return null;
  return f.getBoundingClientRect();
}

function updateZoomText() {
  const z = $("zoomText");
  if (!z) return;
  z.textContent = `${Math.round(view.scale * 100)}%`;
}

function clampView() {
  const f = frameRect();
  const img = $("img");
  if (!f || !img || !img.naturalWidth || !img.naturalHeight) return;
  const fw = f.width;
  const fh = f.height;
  const iw = img.naturalWidth * view.scale;
  const ih = img.naturalHeight * view.scale;

  if (iw <= fw) view.tx = (fw - iw) / 2;
  else view.tx = Math.min(0, Math.max(fw - iw, view.tx));

  if (ih <= fh) view.ty = (fh - ih) / 2;
  else view.ty = Math.min(0, Math.max(fh - ih, view.ty));
}

function applyView() {
  const img = $("img");
  if (!img) return;
  clampView();
  img.style.transform = `translate3d(${view.tx}px, ${view.ty}px, 0) scale(${view.scale})`;
  updateZoomText();
}

function requestApplyView() {
  if (viewRafPending) return;
  viewRafPending = true;
  requestAnimationFrame(() => {
    viewRafPending = false;
    applyView();
  });
}

function fitToFrame() {
  const f = frameRect();
  const img = $("img");
  if (!f || !img || !img.naturalWidth || !img.naturalHeight) return;
  const s = Math.min(f.width / img.naturalWidth, f.height / img.naturalHeight);
  view.scale = Math.min(view.maxScale, Math.max(view.minScale, s || 1));
  view.tx = (f.width - img.naturalWidth * view.scale) / 2;
  view.ty = (f.height - img.naturalHeight * view.scale) / 2;
  requestApplyView();
}

function oneToOne() {
  const f = frameRect();
  const img = $("img");
  if (!f || !img || !img.naturalWidth || !img.naturalHeight) return;
  view.scale = 1;
  view.tx = (f.width - img.naturalWidth) / 2;
  view.ty = (f.height - img.naturalHeight) / 2;
  requestApplyView();
}

function zoomAt(frameX, frameY, factor) {
  const f = frameRect();
  const img = $("img");
  if (!f || !img || !img.naturalWidth || !img.naturalHeight) return;
  const old = view.scale;
  const next = Math.min(view.maxScale, Math.max(view.minScale, old * factor));
  if (next === old) return;

  // Keep the point under cursor stable.
  const ix = (frameX - view.tx) / old;
  const iy = (frameY - view.ty) / old;
  view.scale = next;
  view.tx = frameX - ix * next;
  view.ty = frameY - iy * next;
  view.autoFit = false;
  requestApplyView();
}

async function loadByIndex(idx, opts = {}) {
  if (idx < 0 || idx >= currentCases.length) return;
  if (!opts.skipSave) await saveCurrentLabelIfNeeded();

  currentIndex = idx;
  buildCasesList();
  const c = currentCases[currentIndex];
  setStatus(`加载 ${c.barcode} …`);
  const detail = await apiGet(`/api/case/${encodeURIComponent(c.barcode)}`);
  currentDetail = detail;

  $("curBarcode").textContent = detail.barcode || "";
  $("curCategory").textContent = detail.cta_category || "";
  $("curFolder").textContent = detail.folder || "(未匹配到文件夹)";
  $("ctaConclusion").textContent = (detail.cta_conclusion || "").trim() || "-";
  $("ctaFindings").textContent = (detail.cta_findings || "").trim() || "-";
  $("checked").checked = !!detail.checked;
  $("updatedAt").textContent = detail.updated_at || "";

  const files = detail.cta_files || [];
  const chosen = preferredFile(files);
  setSelectOptions($("ctaFile"), files, chosen);

  const file = $("ctaFile").value;
  if (file) {
    const info = detail.volume_info && detail.default_file === file ? detail.volume_info : await ensureVolumeInfo(detail.barcode, file);
    const shape = info ? info.shape : null;
    if (shape) {
      const axis = $("axis").value;
      const maxIdx = axis === "x" ? shape[0] - 1 : axis === "y" ? shape[1] - 1 : shape[2] - 1;
      $("slice").max = String(Math.max(0, maxIdx));
      $("slice").value = String(Math.floor(Math.max(0, maxIdx) / 2));
    } else {
      $("slice").max = "0";
      $("slice").value = "0";
    }
  } else {
    $("slice").max = "0";
    $("slice").value = "0";
  }
  updateSliceLabel();

  // Reset view when switching cases
  view.autoFit = true;
  await renderSlice({ force: true });
  setStatus("");
}

function buildSliceUrl(opts = {}) {
  const c = currentCase();
  if (!c) return "";
  const file = $("ctaFile").value;
  if (!file) return "";
  const axis = $("axis").value;
  const index = opts.index != null ? String(opts.index) : $("slice").value;
  const wc = $("wc").value.trim();
  const ww = $("ww").value.trim();
  const qs = new URLSearchParams({
    file,
    axis,
    index,
  });
  if (wc) qs.set("wc", wc);
  if (ww) qs.set("ww", ww);
  if (opts && opts.max) qs.set("max", String(opts.max));
  return `/api/case/${encodeURIComponent(c.barcode)}/slice?` + qs.toString();
}

async function renderSlice({ force = false, quality = "high" } = {}) {
  const max = quality === "low" ? PREVIEW_MAX : null;
  const url = buildSliceUrl({ max });
  if (!url) {
    $("img").src = "";
    $("img").alt = "无CTA文件";
    return;
  }
  const key = url;
  if (!force && key === lastRenderedKey) return;
  lastRenderedKey = key;

  $("img").alt = "加载中…";
  $("img").dataset.quality = quality;
  $("img").src = url;
}

function scheduleRender(quality) {
  if (pendingRenderTimer) clearTimeout(pendingRenderTimer);
  pendingRenderTimer = setTimeout(() => {
    pendingRenderTimer = null;
    renderSlice({ quality }).catch(console.error);
  }, 140);
}

function schedulePrefetch() {
  prefetchGen += 1;
  const gen = prefetchGen;
  if (prefetchTimer) clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(() => {
    prefetchTimer = null;
    runPrefetch(gen);
  }, PREFETCH_DELAY_MS);
}

function runPrefetch(gen) {
  if (gen !== prefetchGen) return;
  if (document.hidden) return;
  const c = currentCase();
  const slider = $("slice");
  if (!c || !slider) return;
  const maxIdx = parseInt(slider.max || "0", 10);
  const cur = parseInt(slider.value || "0", 10);
  if (!isFinite(maxIdx) || maxIdx <= 0 || !isFinite(cur)) return;

  const targets = [];
  for (let d = 1; d <= PREFETCH_RADIUS; d++) {
    const a = cur + d;
    const b = cur - d;
    if (a <= maxIdx) targets.push(a);
    if (b >= 0) targets.push(b);
    if (targets.length >= PREFETCH_MAX_IMAGES) break;
  }

  const urls = targets
    .map((i) => buildSliceUrl({ max: PREVIEW_MAX, index: i }))
    .filter((u) => !!u);

  urls.forEach((url) => {
    if (prefetchImages.has(url)) return;
    const im = new Image();
    im.decoding = "async";
    im.loading = "eager";
    im.src = url;
    prefetchImages.set(url, im);
  });

  // Limit memory
  while (prefetchImages.size > PREFETCH_MAX_IMAGES * 3) {
    const k = prefetchImages.keys().next().value;
    prefetchImages.delete(k);
  }
}

function updateSliceLabel() {
  $("sliceLabel").textContent = $("slice").value + " / " + $("slice").max;
}

function gotoPrev() {
  if (currentIndex <= 0) return;
  loadByIndex(currentIndex - 1);
}
function gotoNext() {
  if (currentIndex < 0 || currentIndex >= currentCases.length - 1) return;
  loadByIndex(currentIndex + 1);
}

function hookEvents() {
  $("refresh").addEventListener("click", () => refreshCases().catch(console.error));
  $("barcode").addEventListener("keydown", (e) => {
    if (e.key === "Enter") refreshCases().catch(console.error);
  });
  $("category").addEventListener("change", () => refreshCases().catch(console.error));

  $("checked").addEventListener("change", () => {
    // optimistic update list badge (real save happens on navigation or explicit save)
    const c = currentCase();
    if (c) {
      c.checked = $("checked").checked;
      buildCasesList();
    }
  });

  $("save").addEventListener("click", () => saveCurrentLabelIfNeeded().catch(console.error));
  $("prev").addEventListener("click", () => gotoPrev());
  $("next").addEventListener("click", () => gotoNext());

  $("ctaFile").addEventListener("change", async () => {
    try {
      const c = currentCase();
      if (!c) return;
      const file = $("ctaFile").value;
      if (!file) return;
      const info = await ensureVolumeInfo(c.barcode, file);
      applyShapeToSlider(info ? info.shape : null);
      view.autoFit = true;
      await renderSlice({ force: true });
    } catch (e) {
      console.error(e);
    }
  });
  $("axis").addEventListener("change", async () => {
    try {
      const c = currentCase();
      if (!c) return;
      const file = $("ctaFile").value;
      if (!file) return;
      const info = await ensureVolumeInfo(c.barcode, file);
      applyShapeToSlider(info ? info.shape : null);
      view.autoFit = true;
      await renderSlice({ force: true });
    } catch (e) {
      console.error(e);
    }
  });
  $("slice").addEventListener("input", () => {
    updateSliceLabel();
    scheduleRender("low");
  });
  $("slice").addEventListener("change", () => {
    renderSlice({ force: true, quality: "high" }).catch(console.error);
  });
  ["wc", "ww"].forEach((id) => {
    $(id).addEventListener("change", () => renderSlice({ force: true }).catch(console.error));
  });

  // Pan/zoom interactions
  const frame = $("imgFrame");
  const img = $("img");
  if (img) {
    img.addEventListener("load", () => {
      if (view.autoFit) fitToFrame();
      else applyView();
      if ((img.dataset.quality || "high") === "high") schedulePrefetch();
    });
    img.addEventListener("error", () => {
      setStatus("图像加载失败：请在网络面板查看 /api/case/<barcode>/slice 的返回");
    });
  }

  if (frame) {
    // wheel: zoom around cursor (trackpad pinch shows as ctrl+wheel in Chrome)
    frame.addEventListener(
      "wheel",
      (e) => {
        if (!img || !img.naturalWidth) return;
        e.preventDefault();
        const r = frame.getBoundingClientRect();
        const x = e.clientX - r.left;
        const y = e.clientY - r.top;
        // Pinch-to-zoom on Mac trackpad appears as ctrl+wheel in Chrome.
        if (e.ctrlKey || e.metaKey) {
          const k = Math.exp(-e.deltaY * 0.002);
          zoomAt(x, y, k);
          return;
        }

        // Hold Shift to pan with trackpad wheel.
        if (e.shiftKey) {
          view.tx -= e.deltaX;
          view.ty -= e.deltaY;
          view.autoFit = false;
          requestApplyView();
          return;
        }

        // Otherwise: wheel scroll slices (faster than dragging slider)
        const slider = $("slice");
        if (!slider) return;
        const max = parseInt(slider.max || "0", 10);
        if (!isFinite(max) || max <= 0) return;
        const cur = parseInt(slider.value || "0", 10) || 0;
        const step = Math.max(1, Math.round(Math.min(10, Math.abs(e.deltaY) / 30)));
        const next = Math.max(0, Math.min(max, cur + (e.deltaY > 0 ? step : -step)));
        if (next === cur) return;
        slider.value = String(next);
        updateSliceLabel();
        scheduleRender("low");
        if (wheelHighResTimer) clearTimeout(wheelHighResTimer);
        wheelHighResTimer = setTimeout(() => {
          wheelHighResTimer = null;
          renderSlice({ force: true, quality: "high" }).catch(console.error);
        }, 220);
      },
      { passive: false }
    );

    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    const pointers = new Map(); // id -> {x,y}
    let pinchState = null; // {dist}

    function setDragging(on) {
      dragging = on;
      frame.classList.toggle("grabbing", on);
    }

    frame.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      frame.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        setDragging(true);
        lastX = e.clientX;
        lastY = e.clientY;
      }
    });

    frame.addEventListener("pointermove", (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointers.size === 1 && dragging) {
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        view.tx += dx;
        view.ty += dy;
        view.autoFit = false;
        requestApplyView();
        return;
      }

      // pinch zoom (2 pointers)
      if (pointers.size === 2) {
        const pts = Array.from(pointers.values());
        const p0 = pts[0];
        const p1 = pts[1];
        const cx = (p0.x + p1.x) / 2;
        const cy = (p0.y + p1.y) / 2;
        const dist = Math.hypot(p0.x - p1.x, p0.y - p1.y);
        const prev = pinchState;
        if (!prev) {
          pinchState = { dist, cx, cy };
          return;
        }
        const factor = dist / (prev.dist || dist || 1);
        const r = frame.getBoundingClientRect();
        zoomAt(cx - r.left, cy - r.top, factor);
        pinchState = { dist, cx, cy };
        setDragging(false);
      }
    });

    frame.addEventListener("pointerup", (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size === 0) {
        setDragging(false);
        pinchState = null;
      }
    });
    frame.addEventListener("pointercancel", (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size === 0) {
        setDragging(false);
        pinchState = null;
      }
    });

    window.addEventListener("resize", () => {
      if (view.autoFit) fitToFrame();
      else requestApplyView();
    });
  }

  $("viewOverlay")?.addEventListener("pointerdown", (e) => e.stopPropagation());
  $("viewOverlay")?.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });

  $("fit")?.addEventListener("click", () => {
    view.autoFit = true;
    fitToFrame();
  });
  $("one")?.addEventListener("click", () => {
    view.autoFit = false;
    oneToOne();
  });
  $("zoomIn")?.addEventListener("click", () => {
    const f = frameRect();
    if (!f) return;
    zoomAt(f.width / 2, f.height / 2, 1.15);
  });
  $("zoomOut")?.addEventListener("click", () => {
    const f = frameRect();
    if (!f) return;
    zoomAt(f.width / 2, f.height / 2, 1 / 1.15);
  });

  window.addEventListener("keydown", async (e) => {
    if (isTypingTarget(document.activeElement)) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      gotoPrev();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      gotoNext();
    } else if (e.key === " ") {
      e.preventDefault();
      $("checked").checked = !$("checked").checked;
      const c = currentCase();
      if (c) {
        c.checked = $("checked").checked;
        buildCasesList();
      }
    }
  });
}

async function init() {
  setBoot("正在请求 /api/meta …");
  meta = await apiGet("/api/meta");
  $("total").textContent = String(meta.total || 0);
  setSelectOptions($("category"), ["all"].concat(meta.categories || []), "all");
  try {
    await refreshStats();
  } catch (e) {
    console.error(e);
  }
  setBoot("正在加载病例列表…");
  await refreshCases();
  setBoot("");
}

hookEvents();
init().catch((e) => {
  console.error(e);
  const msg = e && e.message ? String(e.message) : String(e);
  setBoot("初始化失败：无法请求后端 API（请确认后端正在运行/端口可达）。\n" + msg, { error: true });
  setStatus("初始化失败：请看左上角提示或打开控制台");
});
