// ============================================================
// APP LOGIC — Insentif Dashboard
// Semua data ditarik LIVE dari Google Sheets tiap kali halaman
// dibuka / tombol Refresh ditekan. Tidak ada data yang di-hardcode.
// ============================================================

let RAW = {};        // { hubKey: [rows...] }
let map;             // leaflet instance
let markers = {};    // hubKey -> leaflet marker
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

async function fetchHubCsv(hub) {
  const url = buildCsvUrl(hub.sheet);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gagal ambil sheet "${hub.sheet}" (status ${res.status})`);
  const text = await res.text();
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
  return parsed.data;
}

async function loadAllData() {
  setStatus("Memuat data dari Google Sheets...", false);
  const results = await Promise.allSettled(HUBS.map((h) => fetchHubCsv(h)));

  let failedHubs = [];
  results.forEach((r, i) => {
    const hub = HUBS[i];
    if (r.status === "fulfilled") {
      RAW[hub.key] = r.value;
    } else {
      RAW[hub.key] = [];
      failedHubs.push(hub.label);
      console.error(r.reason);
    }
  });

  if (failedHubs.length) {
    setStatus(
      `Sebagian data gagal dimuat (${failedHubs.join(", ")}). Cek apakah nama tab di config.js sudah persis sama, dan sheet sudah "Anyone with link can view".`,
      true
    );
  } else {
    const now = new Date();
    setStatus("Data live tersambung ke Google Sheets.", false);
    document.getElementById("updated-pill").textContent =
      "Update: " + now.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) +
      " " + now.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
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
  const legendList = document.getElementById("legend-list");
  legendList.innerHTML = "";

  HUBS.forEach((hub) => {
    const m = hubMetrics(hub.key);
    const item = document.createElement("div");
    item.className = "legend-item";
    item.style.background = hub.color;
    item.innerHTML = `<div class="l-name">${hub.label}</div><div class="l-value">${rupiah(m.insentif)}</div>`;
    item.addEventListener("click", () => openHubModal(hub));
    legendList.appendChild(item);

    // update / create marker
    if (markers[hub.key]) {
      markers[hub.key].setRadius(markerRadius(m.trip));
    } else {
      const marker = L.circleMarker([hub.lat, hub.lng], {
        radius: markerRadius(m.trip),
        color: "white",
        weight: 2,
        fillColor: hub.color,
        fillOpacity: 0.9,
      }).addTo(map);
      marker.bindTooltip(`${hub.label}`, { permanent: false, direction: "top" });
      marker.on("click", () => openHubModal(hub));
      markers[hub.key] = marker;
    }
  });
}

function markerRadius(trip) {
  return Math.max(6, Math.min(18, 6 + Math.sqrt(trip) * 0.6));
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
  const title = key === "all" ? "Semua Site" : "Hub " + HUBS.find((h) => h.key === key).label;
  document.getElementById("btn-site-scope").textContent = title;
  renderKpis();
}

function wireControls() {
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

// ---------------- INIT ----------------

function initMap() {
  map = L.map("map", { scrollWheelZoom: false }).setView([-5.5, 108], 5);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    maxZoom: 12,
  }).addTo(map);
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("version-pill").textContent = "v1.0";
  initMap();
  buildHubNav();
  wireControls();
  loadAllData();
});
