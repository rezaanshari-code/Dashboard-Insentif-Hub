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
let currentYear = null;   // "2025" | "2026" | ... -- diisi setelah data dimuat
let currentMonth = "all"; // "all" (= seluruh currentYear) | "YYYY-MM" | "custom:from:to"

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

// Parse "YYYY-MM-DD" (format bawaan <input type="date">) jadi Date LOCAL
// midnight -- sengaja TIDAK pakai `new Date(str)` karena itu di-parse
// sebagai UTC midnight oleh JS, yang mismatch sama parseTanggal() di atas.
function parseISODateLocal(str) {
  if (!str) return null;
  const parts = String(str).split("-");
  if (parts.length !== 3) return null;
  const [y, m, d] = parts.map((p) => parseInt(p, 10));
  if (!y || !m || !d) return null;
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

  populateYearOptions();
  populateMonthOptions();
  populateYtdYearOptions();
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
  if (String(currentMonth).startsWith("custom:")) {
    const [, from, to] = currentMonth.split(":");
    // PENTING: jangan pakai `new Date("YYYY-MM-DD")` -- string ISO
    // tanpa jam di-parse sebagai UTC midnight oleh JS, sedangkan
    // parseTanggal() bikin local midnight. Di timezone WIB (UTC+7) itu
    // beda 7 jam, dan bikin tanggal PALING AWAL di range ke-exclude
    // secara diam-diam. Parse dengan cara yang sama (local) biar konsisten.
    const fromD = parseISODateLocal(from);
    const toD = parseISODateLocal(to);
    return rows.filter((r) => {
      const d = parseTanggal(r["Tanggal"]);
      return d && fromD && toD && d >= fromD && d <= toD;
    });
  }
  if (currentMonth === "all") {
    // "all" = seluruh bulan dalam TAHUN yang lagi dipilih (bukan semua
    // tahun sekaligus) -- biar Kategori MPP per Bulan dkk tidak nyampur
    // 2025+2026 jadi satu grafik yang padat.
    return rows.filter((r) => {
      const d = parseTanggal(r["Tanggal"]);
      return d && String(d.getFullYear()) === String(currentYear);
    });
  }
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
    insentif += toNumber(r["Insentif Ref"]);
  });
  return { trip, doTotal, titik, ujp, insentif };
}

function activeHubKeys() {
  return currentSite === "all" ? HUBS.map((h) => h.key) : [currentSite];
}

// ---------------- RENDERING ----------------

// Isi dropdown "Tahun" (topbar) dari tahun-tahun yang ada di data.
// Dipanggil sekali setelah data.json dimuat. Default: tahun terbaru.
function populateYearOptions() {
  const years = new Set();
  Object.values(RAW).forEach((rows) => {
    rows.forEach((r) => {
      const d = parseTanggal(r["Tanggal"]);
      if (d) years.add(d.getFullYear());
    });
  });
  const sorted = Array.from(years).sort((a, b) => b - a); // terbaru dulu

  const sel = document.getElementById("year-select");
  sel.innerHTML = "";
  sorted.forEach((y) => {
    const opt = document.createElement("option");
    opt.value = String(y);
    opt.textContent = String(y);
    sel.appendChild(opt);
  });
  if (sorted.length) {
    currentYear = String(sorted[0]);
    sel.value = currentYear;
  }
}

// Isi dropdown "Bulan" HANYA dengan bulan-bulan yang ada di currentYear
// (dipanggil ulang tiap kali tahun diganti).
function populateMonthOptions() {
  const monthSet = new Set();
  Object.values(RAW).forEach((rows) => {
    rows.forEach((r) => {
      const d = parseTanggal(r["Tanggal"]);
      if (d && String(d.getFullYear()) === String(currentYear)) monthSet.add(monthKey(d));
    });
  });
  const months = Array.from(monthSet).sort();
  const sel = document.getElementById("month-select");
  sel.innerHTML = `<option value="all">Semua Bulan (${currentYear})</option>`;
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
  } else {
    currentMonth = "all";
    sel.value = "all";
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

const CUSTOM_MONTH_VALUE = "__custom__";

function formatShortDate(isoStr) {
  const d = parseISODateLocal(isoStr);
  if (!d) return isoStr;
  return `${d.getDate()} ${MONTH_NAMES_ID[d.getMonth()]} ${d.getFullYear()}`;
}

// Tampilkan/perbarui opsi "Custom: ..." di dropdown Bulan supaya dropdown
// itu selalu jadi SATU sumber kebenaran soal filter periode yang aktif --
// nggak ada lagi kondisi di mana dropdown nunjuk ke bulan tertentu padahal
// yang beneran ngefilter data adalah date range custom.
function setCustomMonthOption(from, to) {
  const sel = document.getElementById("month-select");
  let opt = sel.querySelector(`option[value="${CUSTOM_MONTH_VALUE}"]`);
  if (!opt) {
    opt = document.createElement("option");
    opt.value = CUSTOM_MONTH_VALUE;
    sel.appendChild(opt);
  }
  opt.textContent = `Custom: ${formatShortDate(from)} \u2013 ${formatShortDate(to)}`;
  sel.value = CUSTOM_MONTH_VALUE;
}

function removeCustomMonthOption() {
  const opt = document.querySelector(`#month-select option[value="${CUSTOM_MONTH_VALUE}"]`);
  if (opt) opt.remove();
}

function wireControls() {
  document.querySelectorAll(".nav-item[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view, btn));
  });

  document.querySelector('.nav-item[data-site="all"]').addEventListener("click", (e) => selectSite("all", e.currentTarget));

  document.getElementById("year-select").addEventListener("change", (e) => {
    currentYear = e.target.value;
    populateMonthOptions();
    renderAll();
  });

  document.getElementById("month-select").addEventListener("change", (e) => {
    removeCustomMonthOption();
    currentMonth = e.target.value;
    renderAll();
  });

  document.getElementById("ytd-year-select").addEventListener("change", (e) => {
    currentYtdYear = e.target.value;
    currentDriverPage = 1;
    renderDriverTable();
  });

  document.getElementById("btn-full-month").addEventListener("click", () => {
    document.getElementById("date-from").value = "";
    document.getElementById("date-to").value = "";
    removeCustomMonthOption();
    currentMonth = "all";
    document.getElementById("month-select").value = "all";
    renderAll();
  });

  document.getElementById("btn-apply").addEventListener("click", () => {
    const from = document.getElementById("date-from").value;
    const to = document.getElementById("date-to").value;
    if (!from || !to) return;
    // Simple range filter: override currentMonth with a custom predicate
    currentMonth = "custom:" + from + ":" + to;
    setCustomMonthOption(from, to);
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

// Bersihkan nilai NIK: string kosong / "nan" / "0" dianggap "tidak ada
// orang" (mis. trip tanpa kenek), jadi tidak ikut dihitung sebagai 1 MPP.
function cleanNik(v) {
  if (v === null || v === undefined) return "";
  const s = String(v).trim();
  if (!s || s.toLowerCase() === "nan" || s === "0") return "";
  return s;
}

// Inti logic MPP: 1 "MPP" = 1 ORANG (by NIK) DI 1 BULAN TERTENTU, nilainya
// SUM seluruh "Insentif per MPP" dari semua baris trip orang itu di bulan
// itu -- bukan dihitung per baris/per trip. Satu baris trip berkontribusi
// ke 2 entitas MPP sekaligus (driver via NIK1, kenek via nik2), kecuali
// kolom NIK-nya kosong (mis. trip tanpa kenek).
function personMonthTotals(rows) {
  const totals = {}; // "NIK|YYYY-MM" -> akumulasi total

  rows.forEach((r) => {
    const d = parseTanggal(r["Tanggal"]);
    if (!d) return;
    const mk = monthKey(d);
    const val = toNumber(r[MPP_FIELD]);

    const driverNik = cleanNik(r["NIK1"]);
    if (driverNik) {
      const key = driverNik + "|" + mk;
      totals[key] = (totals[key] || 0) + val;
    }

    const kenekNik = cleanNik(r["nik2"]);
    if (kenekNik) {
      const key = kenekNik + "|" + mk;
      totals[key] = (totals[key] || 0) + val;
    }
  });

  return Object.entries(totals).map(([key, total]) => {
    const sep = key.lastIndexOf("|");
    return { nik: key.slice(0, sep), month: key.slice(sep + 1), total };
  });
}

// Nilai MPP (sudah di-SUM per orang per bulan) untuk site aktif, menghormati
// filter bulan yang sedang dipilih di topbar (dipakai KPI card, histogram,
// & daftar driver). Kalau filter = "Semua Bulan", semua pasangan
// (orang, bulan) dari seluruh bulan ikut digabung (bukan di-total-kan lagi
// lintas bulan -- tiap bulan tetap entri terpisah, sesuai definisi "per bulan").
function mppValuesFiltered() {
  const keys = activeHubKeys();
  let rows = [];
  keys.forEach((k) => { rows = rows.concat(getFilteredRows(k)); });
  return personMonthTotals(rows).map((e) => e.total);
}

// Semua baris MPP untuk site aktif, TANPA filter bulan (dipakai untuk
// grafik "Kategori MPP per Bulan" yang memang menampilkan tren semua bulan).
// Semua baris untuk site aktif, TANPA filter bulan tapi TETAP dibatasi ke
// TAHUN yang lagi dipilih di topbar (dipakai grafik "Kategori MPP per
// Bulan" & banner "Driver High berulang" -- biar nggak nyampur 2025+2026
// jadi satu grafik yang padat).
function mppRowsAllMonths() {
  const keys = activeHubKeys();
  const rows = [];
  keys.forEach((k) => {
    (RAW[k] || []).forEach((r) => {
      const d = parseTanggal(r["Tanggal"]);
      if (d && String(d.getFullYear()) === String(currentYear)) rows.push(r);
    });
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
  currentDriverPage = 1;
  const filteredValues = mppValuesFiltered();
  const cat = mppCategoryCounts(filteredValues);

  document.getElementById("mpp-kpi-high").textContent = numFmt(cat.high);
  document.getElementById("mpp-kpi-mid").textContent = numFmt(cat.mid);
  document.getElementById("mpp-kpi-low").textContent = numFmt(cat.low);
  document.getElementById("mpp-kpi-total").textContent = numFmt(cat.total);

  const siteLabel = currentSite === "all" ? "Semua Site" : "Hub " + (HUBS.find((h) => h.key === currentSite)?.label || "");
  const monthLabel = document.getElementById("month-select").selectedOptions[0]?.textContent || "Semua Bulan";
  document.getElementById("mpp-filter-aktif").textContent = `Filter aktif: ${siteLabel} \u00B7 ${monthLabel}`;

  renderMppMonthlyChart();
  renderMppHistogram(filteredValues);
  renderMppDriverStats(filteredValues, siteLabel, monthLabel);
  renderRecurringHighBanner();
  renderDriverTable();
}

// Plugin custom Chart.js: gambar angka total (jumlah semua kategori)
// di atas tiap bar bertumpuk, kayak referensi desainnya.
const totalLabelPlugin = {
  id: "totalLabel",
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    const meta0 = chart.getDatasetMeta(0);
    if (!meta0 || !meta0.data) return;
    ctx.save();
    ctx.font = "700 12px Inter, sans-serif";
    ctx.fillStyle = "#16213e";
    ctx.textAlign = "center";
    meta0.data.forEach((bar, i) => {
      let total = 0;
      chart.data.datasets.forEach((ds) => { total += ds.data[i] || 0; });
      if (!total) return;
      const topY = Math.min(...chart.data.datasets.map((_, dsIdx) => {
        const m = chart.getDatasetMeta(dsIdx).data[i];
        return m ? m.y : Infinity;
      }));
      ctx.fillText(numFmt(total), bar.x, topY - 8);
    });
    ctx.restore();
  },
};

function renderMppMonthlyChart() {
  const rows = mppRowsAllMonths();
  const entries = personMonthTotals(rows); // [{nik, month, total}]

  const byMonth = {}; // "YYYY-MM" -> {high,mid,low}
  entries.forEach((e) => {
    if (!byMonth[e.month]) byMonth[e.month] = { high: 0, mid: 0, low: 0 };
    byMonth[e.month][mppCategory(e.total)]++;
  });

  const sortedKeys = Object.keys(byMonth).sort();
  const monthLabels = sortedKeys.map((mk) => MONTH_NAMES_ID[parseInt(mk.split("-")[1], 10) - 1]);
  const highData = sortedKeys.map((mk) => byMonth[mk].high);
  const midData = sortedKeys.map((mk) => byMonth[mk].mid);
  const lowData = sortedKeys.map((mk) => byMonth[mk].low);

  document.getElementById("mpp-monthly-sub").textContent =
    `${HUBS.length} site \u00B7 Tahun ${currentYear} \u00B7 ${monthLabels.length ? monthLabels.join(", ") : "belum ada data"}`;

  const wrap = document.querySelector("#mpp-monthly-chart").closest(".chart-canvas-wrap");
  try {
    const ctx = document.getElementById("mpp-monthly-chart");
    if (mppMonthlyChart) mppMonthlyChart.destroy();
    mppMonthlyChart = new Chart(ctx, {
      type: "bar",
      data: {
        labels: monthLabels,
        datasets: [
          { label: "High >1.5Jt", data: highData, backgroundColor: "#ef4444", stack: "s" },
          { label: "Mid 500Rb-1.5Jt", data: midData, backgroundColor: "#f59e0b", stack: "s" },
          { label: "Low <500Rb", data: lowData, backgroundColor: "#22c55e", stack: "s" },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { top: 22 } },
        scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } },
        plugins: { legend: { position: "top", labels: { boxWidth: 10, font: { size: 11 } } } },
      },
      plugins: [totalLabelPlugin],
    });
  } catch (err) {
    console.error("Gagal render grafik bulanan:", err);
    if (wrap) wrap.innerHTML = `<div style="padding:20px;color:#dc2626;font-size:13px;">Gagal render grafik: ${err.message}</div>`;
  }
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

  const wrap = document.querySelector("#mpp-histogram-chart").closest(".chart-canvas-wrap");
  try {
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
  } catch (err) {
    console.error("Gagal render histogram:", err);
    if (wrap) wrap.innerHTML = `<div style="padding:20px;color:#dc2626;font-size:13px;">Gagal render grafik: ${err.message}</div>`;
  }
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

// ---------------- DAFTAR DRIVER MPP (tabel + filter kategori) ----------------

let currentDriverCategory = "all";
let currentYtdYear = "all"; // "all" | "2025" | "2026" | ...

// Total insentif per orang (by NIK) across SEMUA bulan & SEMUA site --
// dipakai buat kolom "Total YTD" (angka ini tidak berubah walau tabel
// difilter ke 1 site/bulan tertentu, karena memang menunjukkan total
// year-to-date orang itu). Dibatasi ke 1 TAHUN tertentu lewat dropdown
// "Tahun YTD" (default "Semua Tahun" -- gabung semua tahun yang ada).
function ytdTotalsByNik() {
  const totals = {};
  HUBS.forEach((hub) => {
    (RAW[hub.key] || []).forEach((r) => {
      if (currentYtdYear !== "all") {
        const d = parseTanggal(r["Tanggal"]);
        if (!d || String(d.getFullYear()) !== currentYtdYear) return;
      }
      const val = toNumber(r[MPP_FIELD]);
      const dNik = cleanNik(r["NIK1"]);
      if (dNik) totals[dNik] = (totals[dNik] || 0) + val;
      const kNik = cleanNik(r["nik2"]);
      if (kNik) totals[kNik] = (totals[kNik] || 0) + val;
    });
  });
  return totals;
}

// Isi dropdown "Tahun YTD" dari tahun-tahun yang beneran ada di data
// (dipanggil sekali setelah data.json dimuat).
function populateYtdYearOptions() {
  const years = new Set();
  HUBS.forEach((hub) => {
    (RAW[hub.key] || []).forEach((r) => {
      const d = parseTanggal(r["Tanggal"]);
      if (d) years.add(d.getFullYear());
    });
  });
  const sorted = Array.from(years).sort((a, b) => b - a); // terbaru dulu

  const sel = document.getElementById("ytd-year-select");
  if (!sel) return;
  const prevValue = sel.value || "all";
  sel.innerHTML = '<option value="all">Semua Tahun</option>';
  sorted.forEach((y) => {
    const opt = document.createElement("option");
    opt.value = String(y);
    opt.textContent = String(y);
    sel.appendChild(opt);
  });
  // Pertahankan pilihan sebelumnya kalau masih valid, default "all" kalau belum pernah dipilih.
  if (sorted.some((y) => String(y) === prevValue) || prevValue === "all") {
    sel.value = prevValue;
    currentYtdYear = prevValue;
  } else {
    sel.value = "all";
    currentYtdYear = "all";
  }
}

// Format TAT sumber ("H:MM" atau "H:MM:SS") jadi menit desimal.
function parseTatMinutes(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const parts = s.split(":").map((p) => parseInt(p, 10));
  if (parts.some((p) => isNaN(p))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 60 + parts[1] + parts[2] / 60;
  return null;
}

function formatMinutes(min) {
  if (min === null || min === undefined || isNaN(min)) return "-";
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `${h}j ${m}m`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// Bangun daftar baris tabel: 1 baris = 1 orang (NIK) di 1 bulan di 1 site,
// menghormati filter site+bulan yang aktif di topbar.
function buildDriverTableRows() {
  const keys = activeHubKeys();
  const groups = {}; // "nik|bulan|hubKey|role" -> akumulasi

  keys.forEach((hubKey) => {
    getFilteredRows(hubKey).forEach((r) => {
      const d = parseTanggal(r["Tanggal"]);
      if (!d) return;
      const mk = monthKey(d);
      const val = toNumber(r[MPP_FIELD]);
      const tatMin = parseTatMinutes(r["TAT"]);
      const dp = toNumber(r["DP_Insentif"]);

      const dNik = cleanNik(r["NIK1"]);
      if (dNik) {
        const gk = `${dNik}|${mk}|${hubKey}|driver`;
        if (!groups[gk]) {
          groups[gk] = { nik: dNik, name: (r["driver"] || "").toString().trim() || "-", role: "driver", hubKey, month: mk, insentif: 0, tatSum: 0, tatCount: 0, dp: 0 };
        }
        groups[gk].insentif += val;
        groups[gk].dp += dp;
        if (tatMin !== null) { groups[gk].tatSum += tatMin; groups[gk].tatCount++; }
      }

      const kNik = cleanNik(r["nik2"]);
      if (kNik) {
        const gk = `${kNik}|${mk}|${hubKey}|kenek`;
        if (!groups[gk]) {
          groups[gk] = { nik: kNik, name: (r["kenek1"] || "").toString().trim() || "-", role: "kenek", hubKey, month: mk, insentif: 0, tatSum: 0, tatCount: 0, dp: 0 };
        }
        groups[gk].insentif += val;
        groups[gk].dp += dp;
        if (tatMin !== null) { groups[gk].tatSum += tatMin; groups[gk].tatCount++; }
      }
    });
  });

  const ytd = ytdTotalsByNik();

  return Object.values(groups).map((g) => {
    const hub = HUBS.find((h) => h.key === g.hubKey);
    const m = parseInt(g.month.split("-")[1], 10);
    return {
      nik: g.nik,
      name: g.name,
      role: g.role,
      siteLabel: hub ? hub.label : g.hubKey,
      monthLabel: MONTH_NAMES_ID[m - 1],
      category: mppCategory(g.insentif),
      insentif: g.insentif,
      ytd: ytd[g.nik] || 0,
      tatAvg: g.tatCount ? g.tatSum / g.tatCount : null,
      tatTotal: g.tatSum,
      dp: g.dp,
    };
  });
}

const DRIVER_PAGE_SIZE = 20;
let currentDriverPage = 1;

function renderDriverTable() {
  let rows;
  try {
    rows = buildDriverTableRows();
  } catch (err) {
    console.error("Gagal membangun tabel driver:", err);
    document.getElementById("driver-table-body").innerHTML =
      `<tr><td colspan="11" class="driver-table-empty" style="color:#dc2626">Gagal memuat tabel: ${err.message}</td></tr>`;
    document.getElementById("driver-pagination-info").textContent = "";
    document.getElementById("driver-pagination-pages").innerHTML = "";
    return;
  }

  const filtered = currentDriverCategory === "all" ? rows : rows.filter((r) => r.category === currentDriverCategory);
  filtered.sort((a, b) => b.insentif - a.insentif);

  const tbody = document.getElementById("driver-table-body");
  const infoEl = document.getElementById("driver-pagination-info");
  const pagesEl = document.getElementById("driver-pagination-pages");

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="11" class="driver-table-empty">Tidak ada data untuk filter ini.</td></tr>`;
    infoEl.textContent = "";
    pagesEl.innerHTML = "";
    return;
  }

  const totalPages = Math.max(1, Math.ceil(filtered.length / DRIVER_PAGE_SIZE));
  if (currentDriverPage > totalPages) currentDriverPage = totalPages;
  if (currentDriverPage < 1) currentDriverPage = 1;

  const startIdx = (currentDriverPage - 1) * DRIVER_PAGE_SIZE;
  const shown = filtered.slice(startIdx, startIdx + DRIVER_PAGE_SIZE);
  const catLabel = { high: "High", mid: "Mid", low: "Low" };
  const catClass = { high: "driver-pill-cat-high", mid: "driver-pill-cat-mid", low: "driver-pill-cat-low" };

  tbody.innerHTML = shown.map((r, i) => `
    <tr>
      <td>${startIdx + i + 1}</td>
      <td class="driver-name">${escapeHtml(r.name)}</td>
      <td><span class="driver-pill driver-pill-role-${r.role}">${r.role === "driver" ? "Driver" : "Kenek"}</span></td>
      <td><span class="driver-pill driver-pill-site">Hub ${escapeHtml(r.siteLabel)}</span></td>
      <td>${r.monthLabel}</td>
      <td><span class="driver-pill ${catClass[r.category]}">${catLabel[r.category]}</span></td>
      <td>${rupiahFull(r.insentif)}</td>
      <td>${rupiahFull(r.ytd)}</td>
      <td>${formatMinutes(r.tatAvg)}</td>
      <td>${formatMinutes(r.tatTotal)}</td>
      <td>${numFmt(r.dp)} titik</td>
    </tr>
  `).join("");

  infoEl.textContent = `${numFmt(startIdx + 1)}\u2013${numFmt(Math.min(startIdx + DRIVER_PAGE_SIZE, filtered.length))} dari ${numFmt(filtered.length)} MPP`;
  renderDriverPaginationButtons(totalPages);
}

function renderDriverPaginationButtons(totalPages) {
  const pagesEl = document.getElementById("driver-pagination-pages");
  const goTo = (p) => {
    if (p < 1 || p > totalPages || p === currentDriverPage) return;
    currentDriverPage = p;
    renderDriverTable();
  };

  const btn = (label, page, opts = {}) => {
    const b = document.createElement("button");
    b.className = "page-btn" + (opts.active ? " active" : "");
    b.textContent = label;
    if (opts.disabled) b.disabled = true;
    else b.addEventListener("click", () => goTo(page));
    return b;
  };
  const ellipsis = () => {
    const b = document.createElement("button");
    b.className = "page-btn page-btn-ellipsis";
    b.textContent = "\u2026";
    b.disabled = true;
    return b;
  };

  pagesEl.innerHTML = "";
  pagesEl.appendChild(btn("\u2039", currentDriverPage - 1, { disabled: currentDriverPage === 1 }));

  // Nomor halaman: selalu tampilkan halaman pertama, terakhir, dan yang
  // berdekatan dengan halaman aktif; sisanya diringkas jadi "...".
  const pageNums = new Set([1, totalPages, currentDriverPage, currentDriverPage - 1, currentDriverPage + 1]);
  let prev = 0;
  Array.from(pageNums)
    .filter((p) => p >= 1 && p <= totalPages)
    .sort((a, b) => a - b)
    .forEach((p) => {
      if (prev && p - prev > 1) pagesEl.appendChild(ellipsis());
      pagesEl.appendChild(btn(String(p), p, { active: p === currentDriverPage }));
      prev = p;
    });

  pagesEl.appendChild(btn("\u203A", currentDriverPage + 1, { disabled: currentDriverPage === totalPages }));
}

// Daftar orang (NIK) yang minimal 2 BULAN BERBEDA masuk kategori High,
// dihitung lintas SEMUA bulan (bukan cuma bulan yg dipilih di topbar),
// tapi tetap menghormati filter site yang aktif.
function buildRecurringHighList() {
  const rows = mppRowsAllMonths();
  const entries = personMonthTotals(rows); // [{nik, month, total}]

  const nameMap = {};
  rows.forEach((r) => {
    const dNik = cleanNik(r["NIK1"]);
    if (dNik && !nameMap[dNik]) nameMap[dNik] = (r["driver"] || "").toString().trim();
    const kNik = cleanNik(r["nik2"]);
    if (kNik && !nameMap[kNik]) nameMap[kNik] = (r["kenek1"] || "").toString().trim();
  });

  const byNik = {}; // nik -> Set bulan yang kategorinya "high"
  entries.forEach((e) => {
    if (mppCategory(e.total) !== "high") return;
    if (!byNik[e.nik]) byNik[e.nik] = new Set();
    byNik[e.nik].add(e.month);
  });

  return Object.entries(byNik)
    .filter(([, months]) => months.size >= 2)
    .map(([nik, months]) => {
      const sorted = Array.from(months).sort();
      return {
        nik,
        name: nameMap[nik] || nik,
        months: sorted.map((mk) => MONTH_NAMES_ID[parseInt(mk.split("-")[1], 10) - 1]),
        count: months.size,
      };
    })
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function renderRecurringHighBanner() {
  const box = document.getElementById("mpp-recurring-high");
  let list;
  try {
    list = buildRecurringHighList();
  } catch (err) {
    console.error("Gagal membangun daftar High berulang:", err);
    box.style.display = "none";
    return;
  }

  if (!list.length) {
    box.style.display = "none";
    return;
  }

  box.style.display = "block";
  const items = list.map((d) => `${escapeHtml(d.name)} (${d.months.join(",")})`).join(" \u00B7 ");
  box.innerHTML = `\u2B50 <strong>Driver High berulang (MoM):</strong> ${items}`;
}

function wireDriverTabs() {
  document.querySelectorAll(".driver-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".driver-tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentDriverCategory = btn.dataset.cat;
      currentDriverPage = 1;
      renderDriverTable();
    });
  });
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
  wireDriverTabs();
  loadAllData();
});
