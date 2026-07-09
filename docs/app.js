// ============================================================
// APP LOGIC — Insentif Dashboard
// Data GAK di-fetch langsung dari Google Sheets di browser. Alurnya:
//   1. GitHub Actions menjalankan scripts/fetch_sheets.py secara
//      berkala, menulis docs/data.json, lalu me-render
//      docs/template.html -> docs/index.html.
//   2. Halaman ini (index.html hasil generate) membaca dua file JSON
//      statis di folder yang sama: hub_coords.json (config tampilan,
//      jarang berubah) dan data.json (data transaksi, auto-update).
// ============================================================

let HUBS = [];       // dimuat dari hub_coords.json saat startup
let RAW = {};         // { hubKey: [rows...] }, dimuat dari data.json
let map;              // leaflet instance
let markers = {};     // hubKey -> leaflet marker
let currentSite = "all";
let currentMonth = "all"; // "all" | "YYYY-MM"

const rupiah = (n) => "Rp " + formatCompact(n);
const numFmt = (n) => new Intl.NumberFormat("id-ID").format(Math.round(n || 0));

function formatCompact(n) {
  n = n || 0;
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + " M";
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + " Jt";
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + " Rb";
  return numFmt(n);
}

function toNumber(val) {
  if (val === null || val === undefined) return 0;
  if (typeof val === "number") return val;
  const cleaned = String(val).replace(/[^0-9.-]/g, "");
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

function parseTanggal(val) {
  // Format sumber: M/D/YYYY
  if (!val) return null;
  const parts = String(val).split("/");
  if (parts.length !== 3) return null;
  const [m, d, y] = parts.map((p) => parseInt(p, 10));
  if (!m || !d || !y) return null;
  return new Date(y, m - 1, d);
}

function monthKey(date) {
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0");
}

// ---------------- DATA LOADING ----------------
// data.json dibuat & diupdate otomatis oleh GitHub Actions. Dashboard
// ini cuma baca file itu — lebih cepat & tidak tergantung status
// share Google Sheets di sisi client.

async function loadHubCoords() {
  const res = await fetch("hub_coords.json?_=" + Date.now());
  if (!res.ok) throw new Error(`Gagal fetch hub_coords.json (status ${res.status})`);
  const json = await res.json();
  HUBS = json.hubs || [];
}

async function loadAllData() {
  setStatus("Memuat data.json...", false);
  try {
    // cache-bust biar browser tidak nyangkut ke versi data.json lama
    const res = await fetch("data.json?_=" + Date.now());
    if (!res.ok) throw new Error(`Gagal fetch data.json (status ${res.status})`);
    const json = await res.json();
    RAW = json.hubs || {};

    const emptyHubs = HUBS.filter((h) => !(RAW[h.key] && RAW[h.key].length)).map((h) => h.label);
    if (emptyHubs.length) {
      setStatus(
        `data.json termuat, tapi hub berikut kosong: ${emptyHubs.join(", ")}. Cek log run terakhir di tab Actions repo.`,
        true
      );
    } else {
      setStatus("Data dimuat dari data.json (auto-update oleh GitHub Actions).", false);
    }

    const generatedAt = json.generated_at ? new Date(json.generated_at) : null;
    document.getElementById("updated-pill").textContent = generatedAt
      ? "Update: " +
        generatedAt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) +
        " " +
        generatedAt.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })
      : "Update: --";
  } catch (err) {
    console.error(err);
    setStatus(
      "Gagal memuat data.json: " + err.message + ". Pastikan file data.json ada di root repo (dibuat otomatis oleh GitHub Actions setelah workflow pertama jalan).",
      true
    );
  }

  populateMonthOptions();
  renderAll();
}

function setStatus(msg, isError) {
  const el = document.getElementById("status-line");
  el.textContent = msg;
  el.classList.toggle("error", !!isError);
}

// ---------------- FILTER HELPERS ----------------

function getFilteredRows(hubKey) {
  const rows = RAW[hubKey] || [];
  if (currentMonth === "all") return rows;
  return rows.filter((r) => {
    const d = parseTanggal(r["Tanggal"]);
    if (!d) return false;
    return monthKey(d) === currentMonth;
  });
}

function hubMetrics(hubKey) {
  const rows = getFilteredRows(hubKey);
  let trip = rows.length;
  let doTotal = 0, titik = 0, ujp = 0, insentif = 0;
  rows.forEach((r) => {
    doTotal += toNumber(r["Jumlah_do"]);
    titik += toNumber(r["jumlah_titik"]);
    ujp += toNumber(r["UJP"]);
    insentif += toNumber(r["total_insentif"]);
  });
  return { trip, doTotal, titik, ujp, insentif };
}

function activeHubKeys() {
  return currentSite === "all" ? HUBS.map((h) => h.key) : [currentSite];
}

// ---------------- RENDERING ----------------

function populateMonthOptions() {
  const monthSet = new Set();
  Object.values(RAW).forEach((rows) => {
    rows.forEach((r) => {
      const d = parseTanggal(r["Tanggal"]);
      if (d) monthSet.add(monthKey(d));
    });
  });
  const months = Array.from(monthSet).sort();
  const sel = document.getElementById("month-select");
  sel.innerHTML = '<option value="all">Semua Bulan</option>';
  const monthNames = ["Jan","Feb","Mar","Apr","Mei","Jun","Jul","Agu","Sep","Okt","Nov","Des"];
  months.forEach((mk) => {
    const [y, m] = mk.split("-");
    const opt = document.createElement("option");
    opt.value = mk;
    opt.textContent = `${monthNames[parseInt(m,10)-1]} ${y}`;
    sel.appendChild(opt);
  });
  if (months.length) {
    currentMonth = months[months.length - 1];
    sel.value = currentMonth;
  }
}

function renderAll() {
  renderKpis();
  renderSidebarCounts();
  renderLegendAndMap();
  renderPageTitle();
  if (isMppViewActive()) renderMppView();
}

function renderPageTitle() {
  const monthLabel = document.getElementById("month-select").selectedOptions[0]?.textContent || "";
  document.getElementById("map-title").textContent = "Sebaran Site — " + (monthLabel || "2026");
}

function renderKpis() {
  const keys = activeHubKeys();
  let trip = 0, doTotal = 0, titik = 0, ujp = 0, insentif = 0;
  keys.forEach((k) => {
    const m = hubMetrics(k);
    trip += m.trip; doTotal += m.doTotal; titik += m.titik; ujp += m.ujp; insentif += m.insentif;
  });
  document.getElementById("kpi-trip").textContent = numFmt(trip);
  document.getElementById("kpi-trip-sub").textContent = `${keys.length} site`;
  document.getElementById("kpi-do").textContent = numFmt(doTotal);
  document.getElementById("kpi-titik").textContent = numFmt(titik);
  document.getElementById("kpi-ujp").textContent = rupiah(ujp);
  document.getElementById("kpi-insentif").textContent = rupiah(insentif);
}

function renderSidebarCounts() {
  document.getElementById("count-all").textContent = HUBS.length;
  document.getElementById("count-hub").textContent = HUBS.length;
}

function renderLegendAndMap() {
  const active = new Set(activeHubKeys());
  const leftCol = document.getElementById("label-col-left");
  const rightCol = document.getElementById("label-col-right");
  leftCol.innerHTML = "";
  rightCol.innerHTML = "";

  HUBS.forEach((hub) => {
    const m = hubMetrics(hub.key);
    const isActive = active.has(hub.key);

    // ---- side label box (only for active hubs; leader line drawn to it) ----
    if (isActive) {
      const box = document.createElement("div");
      box.className = "leader-label";
      box.style.background = hub.color;
      box.dataset.hubKey = hub.key;
      box.innerHTML = `<div class="l-name">${hub.label}</div><div class="l-value">${rupiah(m.insentif)}</div>`;
      box.addEventListener("click", () => openHubModal(hub));
      (hub.labelSide === "right" ? rightCol : leftCol).appendChild(box);
    }

    // ---- marker (only shown on map when active, no permanent tooltip) ----
    if (isActive) {
      if (markers[hub.key]) {
        markers[hub.key].setRadius(markerRadius(m.trip));
        if (!map.hasLayer(markers[hub.key])) markers[hub.key].addTo(map);
      } else {
        const marker = L.circleMarker([hub.lat, hub.lng], {
          radius: markerRadius(m.trip),
          color: "white",
          weight: 2,
          fillColor: hub.color,
          fillOpacity: 0.9,
        }).addTo(map);
        marker.on("click", () => openHubModal(hub));
        markers[hub.key] = marker;
      }
    } else if (markers[hub.key] && map.hasLayer(markers[hub.key])) {
      map.removeLayer(markers[hub.key]);
    }
  });

  fitMapToActiveHubs();
  // Layout needs a tick to settle (labels just got added to DOM) before
  // measuring box positions for the leader lines.
  requestAnimationFrame(drawLeaderLines);
}

function markerRadius(trip) {
  return Math.max(6, Math.min(18, 6 + Math.sqrt(trip) * 0.6));
}

// Draws dashed SVG leader lines connecting each visible side-label box to
// its hub's actual marker position on the map. Re-run on every map
// move/zoom/resize so the lines stay glued to the markers.
function drawLeaderLines() {
  const svg = document.getElementById("leader-svg");
  const stage = document.getElementById("map-stage");
  if (!svg || !stage || !map) return;

  const stageRect = stage.getBoundingClientRect();
  svg.setAttribute("viewBox", `0 0 ${stageRect.width} ${stageRect.height}`);
  svg.innerHTML = "";

  const active = activeHubKeys();
  HUBS.forEach((hub) => {
    if (!active.includes(hub.key)) return;
    const box = document.querySelector(`.leader-label[data-hub-key="${hub.key}"]`);
    if (!box) return;

    const boxRect = box.getBoundingClientRect();
    const isRight = hub.labelSide === "right";
    const anchorX = (isRight ? boxRect.left : boxRect.right) - stageRect.left;
    const anchorY = boxRect.top + boxRect.height / 2 - stageRect.top;

    const point = map.latLngToContainerPoint([hub.lat, hub.lng]);
    const midX = isRight
      ? anchorX - Math.max(30, (anchorX - point.x) * 0.35)
      : anchorX + Math.max(30, (point.x - anchorX) * 0.35);

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute(
      "d",
      `M ${anchorX} ${anchorY} L ${midX} ${anchorY} L ${point.x} ${point.y}`
    );
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", hub.color);
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("stroke-dasharray", "4 4");
    path.setAttribute("opacity", "0.85");
    svg.appendChild(path);
  });
}

function fitMapToActiveHubs() {
  const keys = activeHubKeys();
  const hubs = HUBS.filter((h) => keys.includes(h.key));
  if (!hubs.length) return;

  if (hubs.length === 1) {
    map.setView([hubs[0].lat, hubs[0].lng], 10);
    return;
  }

  const bounds = L.latLngBounds(hubs.map((h) => [h.lat, h.lng]));
  map.fitBounds(bounds, { padding: [40, 40], maxZoom: 8 });
}

function openHubModal(hub) {
  const m = hubMetrics(hub.key);
  document.getElementById("modal-title").textContent = hub.label;
  document.getElementById("modal-body").innerHTML = `
    <div class="modal-row"><span>Total Trip</span><span>${numFmt(m.trip)}</span></div>
    <div class="modal-row"><span>Total DO</span><span>${numFmt(m.doTotal)}</span></div>
    <div class="modal-row"><span>Drop Point</span><span>${numFmt(m.titik)}</span></div>
    <div class="modal-row"><span>Total UJP</span><span>${rupiah(m.ujp)}</span></div>
    <div class="modal-row"><span>Total Insentif</span><span>${rupiah(m.insentif)}</span></div>
  `;
  document.getElementById("modal-backdrop").classList.add("show");
}

// ---------------- SIDEBAR / NAV WIRING ----------------

function buildHubNav() {
  const container = document.getElementById("hub-list");
  container.innerHTML = "";
  HUBS.forEach((hub) => {
    const btn = document.createElement("button");
    btn.className = "nav-item";
    btn.dataset.site = hub.key;
    btn.innerHTML = `<span class="dot" style="background:${hub.color}"></span> Hub ${hub.label}`;
    btn.addEventListener("click", () => selectSite(hub.key, btn));
    container.appendChild(btn);
  });
}

function selectSite(key, btnEl) {
  currentSite = key;
  document.querySelectorAll(".nav-item[data-site]").forEach((b) => b.classList.remove("active"));
  document.querySelector('.nav-item[data-site="all"]').classList.toggle("active", key === "all");
  if (btnEl) btnEl.classList.add("active");
  const title = key === "all" ? "All Hub" : "Hub " + HUBS.find((h) => h.key === key).label;
  document.getElementById("btn-site-scope").textContent = title;
  renderKpis();
  renderLegendAndMap();
  if (isMppViewActive()) renderMppView();
}

function isMppViewActive() {
  const el = document.getElementById("view-mpp");
  return el && el.style.display !== "none";
}

function wireControls() {
  document.querySelectorAll(".nav-item[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view, btn));
  });

  document.querySelector('.nav-item[data-site="all"]').addEventListener("click", (e) => selectSite("all", e.currentTarget));

  document.getElementById("month-select").addEventListener("change", (e) => {
    currentMonth = e.target.value;
    renderAll();
  });

  document.getElementById("btn-full-month").addEventListener("click", () => {
    document.getElementById("date-from").value = "";
    document.getElementById("date-to").value = "";
  });

  document.getElementById("btn-apply").addEventListener("click", () => {
    const from = document.getElementById("date-from").value;
    const to = document.getElementById("date-to").value;
    if (!from || !to) return;
    // Simple range filter: override currentMonth with a custom predicate
    currentMonth = "custom:" + from + ":" + to;
    renderAll();
  });

  document.getElementById("btn-refresh").addEventListener("click", () => {
    RAW = {};
    Object.values(markers).forEach((m) => map.removeLayer(m));
    markers = {};
    loadAllData();
  });

  document.getElementById("modal-close").addEventListener("click", () => {
    document.getElementById("modal-backdrop").classList.remove("show");
  });
  document.getElementById("modal-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "modal-backdrop") e.target.classList.remove("show");
  });
}

// override getFilteredRows to support custom date range
const _origGetFilteredRows = getFilteredRows;
getFilteredRows = function (hubKey) {
  const rows = RAW[hubKey] || [];
  if (currentMonth === "all") return rows;
  if (String(currentMonth).startsWith("custom:")) {
    const [, from, to] = currentMonth.split(":");
    const fromD = new Date(from), toD = new Date(to);
    return rows.filter((r) => {
      const d = parseTanggal(r["Tanggal"]);
      return d && d >= fromD && d <= toD;
    });
  }
  return rows.filter((r) => {
    const d = parseTanggal(r["Tanggal"]);
    if (!d) return false;
    return monthKey(d) === currentMonth;
  });
};

// ---------------- VIEW SWITCHING (sidebar Menu) ----------------

const VIEW_TITLES = { overview: "Overview", mpp: "Distribusi MPP", insight: "Insight" };

function switchView(view, btnEl) {
  document.querySelectorAll(".nav-item[data-view]").forEach((b) => b.classList.remove("active"));
  if (btnEl) btnEl.classList.add("active");

  ["overview", "mpp", "insight"].forEach((v) => {
    document.getElementById("view-" + v).style.display = v === view ? "" : "none";
  });
  document.getElementById("page-title").textContent = VIEW_TITLES[view] || "Overview";

  if (view === "mpp") renderMppView();
}

// ---------------- DISTRIBUSI MPP ----------------

let mppMonthlyChart = null;
let mppHistogramChart = null;

const MPP_FIELD = "Insentif per MPP";
const MONTH_NAMES_ID = ["Jan","Feb","Mar","Apr","Mei","Jun","Jul","Agu","Sep","Okt","Nov","Des"];

// Semua baris MPP untuk site aktif, HANYA menghormati filter bulan yang
// sedang dipilih di topbar (dipakai untuk KPI card & histogram & daftar driver).
function mppValuesFiltered() {
  const keys = activeHubKeys();
  const values = [];
  keys.forEach((k) => {
    getFilteredRows(k).forEach((r) => {
      values.push(toNumber(r[MPP_FIELD]));
    });
  });
  return values;
}

// Semua baris MPP untuk site aktif, TANPA filter bulan (dipakai untuk
// grafik "Kategori MPP per Bulan" yang memang menampilkan tren semua bulan).
function mppRowsAllMonths() {
  const keys = activeHubKeys();
  const rows = [];
  keys.forEach((k) => {
    (RAW[k] || []).forEach((r) => rows.push(r));
  });
  return rows;
}

function mppCategory(value) {
  if (value > 1500000) return "high";
  if (value < 500000) return "low";
  return "mid";
}

function mppCategoryCounts(values) {
  let high = 0, mid = 0, low = 0;
  values.forEach((v) => {
    const c = mppCategory(v);
    if (c === "high") high++;
    else if (c === "low") low++;
    else mid++;
  });
  return { high, mid, low, total: values.length };
}

function mppStats(values) {
  const n = values.length;
  if (!n) return { max: 0, min: 0, mean: 0, std: 0, n: 0 };
  const max = Math.max(...values);
  const min = Math.min(...values);
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
  return { max, min, mean, std: Math.sqrt(variance), n };
}

function renderMppView() {
  const filteredValues = mppValuesFiltered();
  const cat = mppCategoryCounts(filteredValues);

  document.getElementById("mpp-kpi-high").textContent = numFmt(cat.high);
  document.getElementById("mpp-kpi-mid").textContent = numFmt(cat.mid);
  document.getElementById("mpp-kpi-low").textContent = numFmt(cat.low);
  document.getElementById("mpp-kpi-total").textContent = numFmt(cat.total);

  const siteLabel = currentSite === "all" ? "Semua Site" : "Hub " + (HUBS.find((h) => h.key === currentSite)?.label || "");
  const monthLabel = document.getElementById("month-select").selectedOptions[0]?.textContent || "Semua Bulan";
  document.getElementById("mpp-monthly-sub").textContent = `${HUBS.length} site &middot; ${monthLabel}`.replace("&middot;", "\u00B7");
  document.getElementById("mpp-filter-aktif").textContent = `Filter aktif: ${siteLabel} \u00B7 ${monthLabel}`;

  renderMppMonthlyChart();
  renderMppHistogram(filteredValues);
  renderMppDriverStats(filteredValues, siteLabel, monthLabel);
}

function renderMppMonthlyChart() {
  const rows = mppRowsAllMonths();
  const byMonth = {}; // "YYYY-MM" -> {high,mid,low}
  rows.forEach((r) => {
    const d = parseTanggal(r["Tanggal"]);
    if (!d) return;
    const mk = monthKey(d);
    if (!byMonth[mk]) byMonth[mk] = { high: 0, mid: 0, low: 0 };
    const c = mppCategory(toNumber(r[MPP_FIELD]));
    byMonth[mk][c]++;
  });

  const sortedKeys = Object.keys(byMonth).sort();
  const labels = sortedKeys.map((mk) => MONTH_NAMES_ID[parseInt(mk.split("-")[1], 10) - 1]);
  const highData = sortedKeys.map((mk) => byMonth[mk].high);
  const midData = sortedKeys.map((mk) => byMonth[mk].mid);
  const lowData = sortedKeys.map((mk) => byMonth[mk].low);

  const ctx = document.getElementById("mpp-monthly-chart");
  if (mppMonthlyChart) mppMonthlyChart.destroy();
  mppMonthlyChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "High >1.5Jt", data: highData, backgroundColor: "#ef4444", stack: "s" },
        { label: "Mid 500Rb-1.5Jt", data: midData, backgroundColor: "#f59e0b", stack: "s" },
        { label: "Low <500Rb", data: lowData, backgroundColor: "#22c55e", stack: "s" },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } },
      plugins: { legend: { position: "top", labels: { boxWidth: 10, font: { size: 11 } } } },
    },
  });
}

function renderMppHistogram(values) {
  const bins = [
    { label: "<500K", test: (v) => v < 500000 },
    { label: "500K-1M", test: (v) => v >= 500000 && v < 1000000 },
    { label: "1M-1.5M", test: (v) => v >= 1000000 && v < 1500000 },
    { label: "1.5M-2M", test: (v) => v >= 1500000 && v < 2000000 },
    { label: ">2M", test: (v) => v >= 2000000 },
  ];
  const counts = bins.map((b) => values.filter(b.test).length);

  const { mean, std } = mppStats(values);
  const binMidpoints = [250000, 750000, 1250000, 1750000, 2250000];
  let curve = binMidpoints.map((x) =>
    std > 0 ? Math.exp(-0.5 * Math.pow((x - mean) / std, 2)) / (std * Math.sqrt(2 * Math.PI)) : 0
  );
  const maxCount = Math.max(...counts, 1);
  const maxCurve = Math.max(...curve, 1e-12);
  curve = curve.map((v) => (v / maxCurve) * maxCount); // skala visual ke tinggi bar

  const ctx = document.getElementById("mpp-histogram-chart");
  if (mppHistogramChart) mppHistogramChart.destroy();
  mppHistogramChart = new Chart(ctx, {
    data: {
      labels: bins.map((b) => b.label),
      datasets: [
        {
          type: "bar",
          label: "Jumlah Driver",
          data: counts,
          backgroundColor: "#fbbf6f",
          order: 2,
        },
        {
          type: "line",
          label: "Kurva Normal",
          data: curve,
          borderColor: "#1e3a8a",
          backgroundColor: "#1e3a8a",
          borderWidth: 2,
          pointRadius: 3,
          tension: 0.4,
          fill: false,
          order: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { y: { beginAtZero: true } },
      plugins: { legend: { position: "top", labels: { boxWidth: 10, font: { size: 11 } } } },
    },
  });
}

function renderMppDriverStats(values, siteLabel, monthLabel) {
  const s = mppStats(values);
  const subText = `${numFmt(s.n)} entri \u00B7 filter aktif`;
  document.getElementById("mpp-stat-max").textContent = rupiahFull(s.max);
  document.getElementById("mpp-stat-min").textContent = rupiahFull(s.min);
  document.getElementById("mpp-stat-mean").textContent = rupiahFull(s.mean);
  document.getElementById("mpp-stat-std").textContent = rupiahFull(s.std);
  ["max", "min", "mean", "std"].forEach((k) => {
    document.getElementById(`mpp-stat-${k}-sub`).textContent = subText;
  });
}

function rupiahFull(n) {
  return "Rp " + new Intl.NumberFormat("id-ID").format(Math.round(n || 0));
}

// ---------------- INIT ----------------

function initMap() {
  map = L.map("map", { scrollWheelZoom: false }).setView([-5.5, 108], 5);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    maxZoom: 12,
  }).addTo(map);
  // Initial view is temporary — fitMapToActiveHubs() re-frames it
  // to the actual hub markers as soon as data loads.

  // Keep leader lines glued to markers whenever the map view changes.
  map.on("move zoom moveend zoomend", drawLeaderLines);
  window.addEventListener("resize", () => requestAnimationFrame(drawLeaderLines));
}

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("version-pill").textContent = "v1.1";
  try {
    await loadHubCoords();
  } catch (err) {
    console.error(err);
    setStatus("Gagal memuat hub_coords.json: " + err.message, true);
    return;
  }
  initMap();
  buildHubNav();
  wireControls();
  loadAllData();
});
