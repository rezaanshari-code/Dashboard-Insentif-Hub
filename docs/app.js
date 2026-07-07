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
  const active = new Set(activeHubKeys());

  HUBS.forEach((hub) => {
    const m = hubMetrics(hub.key);
    const isActive = active.has(hub.key);

    // ---- legend card (always show all hubs, no scroll) ----
    const item = document.createElement("div");
    item.className = "legend-item" + (isActive ? "" : " dimmed");
    item.style.background = hub.color;
    item.innerHTML = `<div class="l-name">${hub.label}</div><div class="l-value">${rupiah(m.insentif)}</div>`;
    item.addEventListener("click", () => {
      const btn = document.querySelector(`.nav-item[data-site="${hub.key}"]`);
      selectSite(currentSite === hub.key ? "all" : hub.key, btn);
    });
    legendList.appendChild(item);

    // ---- marker (only shown on map when active) ----
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
        const { direction, offset } = tooltipPlacement(hub.labelDir, hub.labelOffset);
        marker.bindTooltip("Hub " + hub.label, {
          permanent: true,
          direction,
          offset,
          className: "hub-label",
        });
        marker.on("click", () => openHubModal(hub));
        markers[hub.key] = marker;
      }
    } else if (markers[hub.key] && map.hasLayer(markers[hub.key])) {
      map.removeLayer(markers[hub.key]);
    }
  });

  fitMapToActiveHubs();
}

function markerRadius(trip) {
  return Math.max(6, Math.min(18, 6 + Math.sqrt(trip) * 0.6));
}

// Setiap hub bisa punya "labelDir" ("top"|"bottom"|"left"|"right") dan/atau
// "labelOffset" custom [x,y] sendiri di hub_coords.json, supaya label nama
// tidak numpuk di area yang padat (mis. cluster Jabodetabek). Kalau
// labelOffset nggak diisi, dipakai jarak default sesuai labelDir.
function tooltipPlacement(labelDir, customOffset) {
  const defaults = {
    top:    { direction: "top",    offset: [0, -10] },
    bottom: { direction: "bottom", offset: [0, 10] },
    left:   { direction: "left",   offset: [-10, 0] },
    right:  { direction: "right",  offset: [10, 0] },
  };
  const base = defaults[labelDir] || defaults.right;
  if (Array.isArray(customOffset) && customOffset.length === 2) {
    return { direction: base.direction, offset: customOffset };
  }
  return base;
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
  // Initial view is temporary — fitMapToActiveHubs() re-frames it
  // to the actual hub markers as soon as data loads.
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
