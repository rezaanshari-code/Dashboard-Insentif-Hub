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
  if (PERIOD_RANGES[currentMonth]) {
    const [startM, endM] = PERIOD_RANGES[currentMonth];
    const fromD = new Date(Number(currentYear), startM - 1, 1);
    const toD = new Date(Number(currentYear), endM, 0); // hari terakhir bulan endM
    return rows.filter((r) => {
      const d = parseTanggal(r["Tanggal"]);
      return d && d >= fromD && d <= toD;
    });
  }
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
// Definisi rentang bulan (1-12, inklusif) untuk tiap kode periode.
const PERIOD_RANGES = {
  q1: [1, 3], q2: [4, 6], q3: [7, 9], q4: [10, 12],
  h1: [1, 6], h2: [7, 12],
};

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

  // Opsi kuartal/semester -- selalu ditampilkan (nggak tergantung ada
  // datanya atau nggak, karena ini cuma rentang kalender biasa).
  const periodGroup = document.createElement("optgroup");
  periodGroup.label = "Kuartal & Semester";
  Object.entries(PERIOD_RANGES).forEach(([code, [startM, endM]]) => {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = `${code.toUpperCase()} (${monthNames[startM-1]}\u2013${monthNames[endM-1]} ${currentYear})`;
    periodGroup.appendChild(opt);
  });
  sel.appendChild(periodGroup);

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
  if (isInsightViewActive()) renderInsightView();
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
  if (isInsightViewActive()) renderInsightView();
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

const VIEW_TITLES = { overview: "Overview", mpp: "Distribusi MPP dan Jalur", insight: "Insight" };

function switchView(view, btnEl) {
  document.querySelectorAll(".nav-item[data-view]").forEach((b) => b.classList.remove("active"));
  if (btnEl) btnEl.classList.add("active");

  ["overview", "mpp", "insight"].forEach((v) => {
    document.getElementById("view-" + v).style.display = v === view ? "" : "none";
  });
  document.getElementById("page-title").textContent = VIEW_TITLES[view] || "Overview";

  if (view === "mpp") renderMppView();
  if (view === "insight") renderInsightView();
}

function isInsightViewActive() {
  const el = document.getElementById("view-insight");
  return el && el.style.display !== "none";
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
  const ytdYears = Array.from(getActiveYtdYears()).sort().join("+");
  document.getElementById("mpp-filter-aktif").textContent =
    `Filter aktif: ${siteLabel} \u00B7 ${monthLabel} (Total YTD: tahun ${ytdYears})`;

  renderMppMonthlyChart();
  renderMppHistogram(filteredValues);
  renderMppDriverStats(filteredValues, siteLabel, monthLabel);
  renderRecurringHighBanner();
  renderDriverTable();
  renderJalurTable();
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

// Tahun (atau kumpulan tahun) yang lagi "aktif" berdasarkan filter topbar
// yang sedang dipakai -- dipakai buat batasin "Total YTD" biar otomatis
// ngikutin periode yang difilter, tanpa perlu dropdown tahun terpisah lagi.
//   - "all"        -> tahun currentYear aja
//   - "YYYY-MM"     -> tahun dari bulan itu
//   - "custom:a:b"  -> SEMUA tahun yang tercakup dalam range a..b
//                      (kalau range-nya nyebrang tahun, mis. Des 2025-Jan
//                      2026, YTD gabung KEDUA tahun itu)
function getActiveYtdYears() {
  if (PERIOD_RANGES[currentMonth]) return new Set([String(currentYear)]);
  if (String(currentMonth).startsWith("custom:")) {
    const [, from, to] = currentMonth.split(":");
    const fromD = parseISODateLocal(from);
    const toD = parseISODateLocal(to);
    if (!fromD || !toD) return new Set([String(currentYear)]);
    const years = new Set();
    for (let y = fromD.getFullYear(); y <= toD.getFullYear(); y++) years.add(String(y));
    return years;
  }
  if (currentMonth === "all") return new Set([String(currentYear)]);
  return new Set([String(currentMonth).split("-")[0]]); // "YYYY-MM" -> "YYYY"
}

// Total insentif per orang (by NIK), dibatasi ke tahun (atau kumpulan
// tahun) yang lagi aktif di filter topbar -- dipakai buat kolom "Total
// YTD". Beda dari kolom "Insentif MPP" yang cuma 1 bulan spesifik, YTD ini
// gabung semua bulan DALAM tahun yang sama, tapi tetap ikut site yang aktif.
function ytdTotalsByNik() {
  const activeYears = getActiveYtdYears();
  const totals = {};
  HUBS.forEach((hub) => {
    (RAW[hub.key] || []).forEach((r) => {
      const d = parseTanggal(r["Tanggal"]);
      if (!d || !activeYears.has(String(d.getFullYear()))) return;
      const val = toNumber(r[MPP_FIELD]);
      const dNik = cleanNik(r["NIK1"]);
      if (dNik) totals[dNik] = (totals[dNik] || 0) + val;
      const kNik = cleanNik(r["nik2"]);
      if (kNik) totals[kNik] = (totals[kNik] || 0) + val;
    });
  });
  return totals;
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
  const groups = {}; // "nik|bulan|hubKey" -> akumulasi (role TIDAK ikut jadi key)

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
        const gk = `${dNik}|${mk}|${hubKey}`;
        if (!groups[gk]) {
          groups[gk] = {
            nik: dNik, hubKey, month: mk, insentif: 0, tatSum: 0, tatCount: 0, dp: 0,
            roleCount: { driver: 0, kenek: 0 }, nameByRole: { driver: "", kenek: "" },
          };
        }
        const g = groups[gk];
        g.insentif += val;
        g.dp += dp;
        g.roleCount.driver++;
        if (!g.nameByRole.driver) g.nameByRole.driver = (r["driver"] || "").toString().trim();
        if (tatMin !== null) { g.tatSum += tatMin; g.tatCount++; }
      }

      const kNik = cleanNik(r["nik2"]);
      if (kNik) {
        const gk = `${kNik}|${mk}|${hubKey}`;
        if (!groups[gk]) {
          groups[gk] = {
            nik: kNik, hubKey, month: mk, insentif: 0, tatSum: 0, tatCount: 0, dp: 0,
            roleCount: { driver: 0, kenek: 0 }, nameByRole: { driver: "", kenek: "" },
          };
        }
        const g = groups[gk];
        g.insentif += val;
        g.dp += dp;
        g.roleCount.kenek++;
        if (!g.nameByRole.kenek) g.nameByRole.kenek = (r["kenek1"] || "").toString().trim();
        if (tatMin !== null) { g.tatSum += tatMin; g.tatCount++; }
      }
    });
  });

  const ytd = ytdTotalsByNik();

  return Object.values(groups).map((g) => {
    const hub = HUBS.find((h) => h.key === g.hubKey);
    const m = parseInt(g.month.split("-")[1], 10);
    // Role final = peran yang paling sering muncul buat orang ini di bulan
    // itu (kalau dia pernah jadi driver DI SATU trip dan kenek di trip
    // lain, bulan yang sama, insentifnya digabung jadi 1 baris -- role
    // yang ditampilkan cuma yang paling dominan).
    const role = g.roleCount.kenek > g.roleCount.driver ? "kenek" : "driver";
    const name = g.nameByRole[role] || g.nameByRole.driver || g.nameByRole.kenek || "-";
    return {
      nik: g.nik,
      name: name || "-",
      role,
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
// tapi tetap menghormati filter site yang aktif. Iterasi per-hub (bukan
// pakai mppRowsAllMonths() yang sudah di-flatten) supaya bisa nangkep
// nama hub/site-nya juga buat ditampilkan di tabel.
function buildRecurringHighList() {
  const keys = activeHubKeys();
  const totals = {};   // "nik|bulan" -> akumulasi Insentif per MPP
  const nameMap = {};  // nik -> nama
  const siteMap = {};  // nik -> label hub (pertama kali ketemu)

  keys.forEach((hubKey) => {
    const hub = HUBS.find((h) => h.key === hubKey);
    (RAW[hubKey] || []).forEach((r) => {
      const d = parseTanggal(r["Tanggal"]);
      if (!d || String(d.getFullYear()) !== String(currentYear)) return;
      const mk = monthKey(d);
      const val = toNumber(r[MPP_FIELD]);

      const dNik = cleanNik(r["NIK1"]);
      if (dNik) {
        const key = dNik + "|" + mk;
        totals[key] = (totals[key] || 0) + val;
        if (!nameMap[dNik]) nameMap[dNik] = (r["driver"] || "").toString().trim();
        if (!siteMap[dNik]) siteMap[dNik] = hub ? hub.label : hubKey;
      }
      const kNik = cleanNik(r["nik2"]);
      if (kNik) {
        const key = kNik + "|" + mk;
        totals[key] = (totals[key] || 0) + val;
        if (!nameMap[kNik]) nameMap[kNik] = (r["kenek1"] || "").toString().trim();
        if (!siteMap[kNik]) siteMap[kNik] = hub ? hub.label : hubKey;
      }
    });
  });

  const byNik = {}; // nik -> Set bulan yang kategorinya "high"
  Object.entries(totals).forEach(([key, total]) => {
    if (mppCategory(total) !== "high") return;
    const sep = key.lastIndexOf("|");
    const nik = key.slice(0, sep), mk = key.slice(sep + 1);
    if (!byNik[nik]) byNik[nik] = new Set();
    byNik[nik].add(mk);
  });

  return Object.entries(byNik)
    .filter(([, months]) => months.size >= 2)
    .map(([nik, months]) => {
      const sorted = Array.from(months).sort();
      return {
        nik,
        name: nameMap[nik] || nik,
        site: siteMap[nik] || "-",
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
  const rowsHtml = list.map((d, i) => `
    <tr>
      <td>${i + 1}</td>
      <td class="recurring-name">${escapeHtml(d.name)}</td>
      <td>Hub ${escapeHtml(d.site)}</td>
      <td class="recurring-count">${d.count}x</td>
      <td>${d.months.join(", ")}</td>
    </tr>
  `).join("");

  box.innerHTML = `
    <div class="recurring-high-title">\u2B50 Driver High Berulang (MoM)</div>
    <div class="recurring-high-table-wrap">
      <table class="recurring-high-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Nama</th>
            <th>Site Hub</th>
            <th>Total Berulang</th>
            <th>Bulan Berulang</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;
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

// ---------------- INSIGHT (Tabel Perbandingan periode) ----------------

let insightCustomRange = null; // {from, to} kalau user pakai Filter Range Tanggal khusus tabel ini

// Tentukan periode aktif + 2 pembanding (periode-sebelumnya & YoY),
// berdasarkan filter topbar (atau override Filter Range Tanggal khusus
// Insight). Return { active:{from,to,label}, prev:{...}, yoy:{...}, momLabel }.
// Geser tanggal d sejumlah deltaMonths bulan kalender (bisa negatif),
// tanggal-di-bulan dipertahankan (clamp kalau bulan tujuan lebih pendek,
// mis. 31 Jan -1bulan -> 28/29 Feb, bukan error/NaN).
function shiftMonths(d, deltaMonths) {
  const idx = d.getMonth() + deltaMonths;
  const year = d.getFullYear() + Math.floor(idx / 12);
  const month = ((idx % 12) + 12) % 12;
  const daysInTarget = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(d.getDate(), daysInTarget));
}

function shiftYears(d, deltaYears) {
  return new Date(d.getFullYear() + deltaYears, d.getMonth(), d.getDate());
}

function fmtRangeLabel(a, b) {
  return `${formatShortDate2(a)}\u2013${formatShortDate2(b)}`;
}

function getInsightPeriods() {
  // ---- Sumber periode aktif: prioritas custom range khusus Insight,
  // baru custom range dari topbar (Terapkan), baru periode kalender biasa.
  let activeRange = null;
  if (insightCustomRange) {
    activeRange = {
      from: parseISODateLocal(insightCustomRange.from),
      to: parseISODateLocal(insightCustomRange.to),
    };
  } else if (String(currentMonth).startsWith("custom:")) {
    const [, from, to] = currentMonth.split(":");
    activeRange = { from: parseISODateLocal(from), to: parseISODateLocal(to) };
  }

  if (activeRange && activeRange.from && activeRange.to) {
    const { from, to } = activeRange;
    // Pembanding "sebelumnya": TANGGAL YANG SAMA, mundur 1 BULAN KALENDER
    // penuh (bukan geser N hari) -- 1-11 Jul -> 1-11 Jun.
    const prevFrom = shiftMonths(from, -1);
    const prevTo = shiftMonths(to, -1);
    // YoY: tanggal & bulan yang sama, mundur 1 tahun.
    const yoyFrom = shiftYears(from, -1);
    const yoyTo = shiftYears(to, -1);
    return {
      active: { from, to, label: fmtRangeLabel(from, to) },
      prev:   { from: prevFrom, to: prevTo, label: fmtRangeLabel(prevFrom, prevTo) },
      yoy:    { from: yoyFrom, to: yoyTo, label: fmtRangeLabel(yoyFrom, yoyTo) },
      momLabel: "MoM",
    };
  }

  const year = Number(currentYear);

  // Helper bikin periode dari rentang bulan [startM,endM] di tahun tertentu.
  const monthRange = (y, startM, endM, label) => ({
    from: new Date(y, startM - 1, 1),
    to: new Date(y, endM, 0),
    label,
  });
  const mn = MONTH_NAMES_ID;

  // --- Periode kuartal / semester ---
  if (PERIOD_RANGES[currentMonth]) {
    const code = currentMonth.toUpperCase();
    const [sM, eM] = PERIOD_RANGES[currentMonth];
    const isHalf = currentMonth.startsWith("h");
    const active = monthRange(year, sM, eM, `${code} ${year}`);

    // pembanding sebelumnya: mundur 1 kuartal/semester (bisa lewat tahun)
    let prev, momLabel;
    if (isHalf) {
      momLabel = "HoH";
      if (currentMonth === "h1") prev = monthRange(year - 1, 7, 12, `H2 ${year - 1}`);
      else prev = monthRange(year, 1, 6, `H1 ${year}`);
    } else {
      momLabel = "QoQ";
      const qNum = { q1: 1, q2: 2, q3: 3, q4: 4 }[currentMonth];
      if (qNum === 1) prev = monthRange(year - 1, 10, 12, `Q4 ${year - 1}`);
      else prev = monthRange(year, (qNum - 2) * 3 + 1, (qNum - 1) * 3, `Q${qNum - 1} ${year}`);
    }
    const yoy = monthRange(year - 1, sM, eM, `${code} ${year - 1}`);
    return applyMaxDataCap({ active, prev, yoy, momLabel }, isHalf ? 6 : 3);
  }

  // --- Semua Bulan (setahun penuh) ---
  if (currentMonth === "all") {
    const active = monthRange(year, 1, 12, `Tahun ${year}`);
    const prev = monthRange(year - 1, 1, 12, `Tahun ${year - 1}`);
    const yoy = monthRange(year - 1, 1, 12, `Tahun ${year - 1}`); // objek terpisah dari prev (biar aman di-capping)
    return applyMaxDataCap({ active, prev, yoy, momLabel: "YoY" }, 12);
  }

  // --- Bulan spesifik "YYYY-MM" ---
  const [yStr, mStr] = String(currentMonth).split("-");
  const y = Number(yStr), m = Number(mStr);
  const active = monthRange(y, m, m, `${mn[m - 1]} ${y}`);
  const prevM = m === 1 ? 12 : m - 1;
  const prevY = m === 1 ? y - 1 : y;
  const prev = monthRange(prevY, prevM, prevM, `${mn[prevM - 1]} ${prevY}`);
  const yoy = monthRange(y - 1, m, m, `${mn[m - 1]} ${y - 1}`);
  return applyMaxDataCap({ active, prev, yoy, momLabel: "MoM" }, 1);
}

function formatShortDate2(d) {
  return `${d.getDate()} ${MONTH_NAMES_ID[d.getMonth()]} ${d.getFullYear()}`;
}

// Tanggal terakhir yang BENERAN ada datanya untuk site yang lagi aktif
// (dipakai buat "capping" periode yang belum penuh -- mis. bulan Juli
// baru keisi sampai tgl 11/19, dst).
function getMaxDataDate() {
  const keys = activeHubKeys();
  let max = null;
  keys.forEach((hubKey) => {
    (RAW[hubKey] || []).forEach((r) => {
      const d = parseTanggal(r["Tanggal"]);
      if (d && (!max || d > max)) max = d;
    });
  });
  return max;
}

// Kalau periode aktif ternyata "belum penuh" (data cuma sampai tanggal
// tertentu di dalamnya -- biasanya ini terjadi pas periode aktif = bulan
// berjalan yang paling baru), potong batas akhirnya ke tanggal terakhir
// yang beneran ada datanya, DAN geser prev/yoy pakai tanggal yang SAMA
// (bukan akhir bulan penuh) -- biar perbandingannya apple-to-apple.
// periodMonths = berapa bulan mundur buat "prev" (1=bulanan, 3=kuartal,
// 6=semester, 12=tahunan).
function applyMaxDataCap(periods, periodMonths) {
  const maxD = getMaxDataDate();
  if (!maxD) return periods;
  const { active, prev, yoy } = periods;
  if (maxD >= active.from && maxD < active.to) {
    const cappedTo = maxD;
    const cappedNote = ` (s.d. ${formatShortDate2(cappedTo)})`;
    active.to = cappedTo;
    active.label = active.label + cappedNote;

    const prevTo = shiftMonths(cappedTo, -periodMonths);
    prev.to = prevTo;
    prev.label = fmtRangeLabel(prev.from, prevTo);

    const yoyTo = shiftYears(cappedTo, -1);
    yoy.to = yoyTo;
    yoy.label = fmtRangeLabel(yoy.from, yoyTo);
  }
  return periods;
}

// Agregat metrik dasar untuk 1 periode (rentang tanggal), ikut filter site.
function insightAggregate(fromD, toD) {
  const keys = activeHubKeys();
  let doTotal = 0, dp = 0, cbm = 0, trip = 0, ujp = 0, insentif = 0;
  keys.forEach((hubKey) => {
    (RAW[hubKey] || []).forEach((r) => {
      const d = parseTanggal(r["Tanggal"]);
      if (!d || d < fromD || d > toD) return;
      trip += 1;
      doTotal += toNumber(r["Jumlah_do"]);
      dp += toNumber(r["jumlah_titik"]);
      cbm += toNumber(r["CBM"]);
      ujp += toNumber(r["UJP"]);
      insentif += toNumber(r["Insentif Ref"]);
    });
  });
  const safeDiv = (a, b) => (b ? a / b : 0);
  return {
    do: doTotal, dp, cbm, trip, ujp, insentif,
    do_trip: safeDiv(doTotal, trip),
    dp_trip: safeDiv(dp, trip),
    do_dp: safeDiv(doTotal, dp),
    cbm_dp: safeDiv(cbm, dp),
    ujp_trip: safeDiv(ujp, trip),
    ujp_do: safeDiv(ujp, doTotal),
    ujp_dp: safeDiv(ujp, dp),
  };
}

// Definisi 13 baris: [label, key, tipe format, isCost, ikon, grup]
// grup: "volume" | "prod" | "cost" -- nentuin teks badge di panel efisiensi.
const INSIGHT_ROWS = [
  ["Total Delivery Order (DO)", "do", "int", false, "\uD83D\uDCE6", "volume"],
  ["Total Drop Point (DP)", "dp", "int", false, "\uD83D\uDCCD", "volume"],
  ["Total CBM", "cbm", "cbm", false, "\uD83D\uDCE6", "volume"],
  ["Total Trip", "trip", "int", false, "\uD83D\uDE9A", "volume"],
  ["Produktivitas DO/Trip", "do_trip", "dec2", false, "\uD83D\uDCC8", "prod"],
  ["Produktivitas DP/Trip", "dp_trip", "dec2", false, "\uD83D\uDCCA", "prod"],
  ["Produktivitas DO/DP", "do_dp", "dec2", false, "\uD83D\uDCE6", "prod"],
  ["Produktivitas CBM/DP", "cbm_dp", "dec2", false, "\uD83D\uDCD0", "prod"],
  ["Biaya UJP/Trip", "ujp_trip", "rupiah", true, "\uD83D\uDCB0", "cost"],
  ["Biaya UJP/DO", "ujp_do", "rupiah", true, "\u2696\uFE0F", "cost"],
  ["Biaya UJP/DP", "ujp_dp", "rupiah", true, "\uD83C\uDFAF", "cost"],
  ["Total Biaya UJP", "ujp", "rupiahBig", true, "\uD83D\uDD22", "cost"],
  ["Biaya Insentif MPP", "insentif", "rupiahBig", true, "\uD83D\uDCB5", "cost"],
];

function fmtInsightValue(val, type) {
  switch (type) {
    case "int": return numFmt(val);
    case "dec2": return new Intl.NumberFormat("id-ID", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(val || 0);
    case "cbm": return new Intl.NumberFormat("id-ID", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(val || 0) + " m\u00B3";
    case "rupiah": return "Rp " + numFmt(val);
    case "rupiahBig": return "Rp " + formatCompact(val);
    default: return String(val);
  }
}

function fmtGap(gap, type) {
  const sign = gap > 0 ? "+" : gap < 0 ? "\u2212" : "";
  const absVal = Math.abs(gap);
  let body;
  switch (type) {
    case "int": body = numFmt(absVal); break;
    case "dec2": body = new Intl.NumberFormat("id-ID", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(absVal); break;
    case "cbm": body = new Intl.NumberFormat("id-ID", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(absVal) + " m\u00B3"; break;
    case "rupiah": body = "Rp " + numFmt(absVal); break;
    case "rupiahBig": body = "Rp " + formatCompact(absVal); break;
    default: body = String(absVal);
  }
  return sign + body;
}

function fmtGrowth(active, base) {
  if (!base) return "\u2013"; // pembagi 0 -> tak terhingga, tampilkan strip
  const pct = ((active - base) / base) * 100;
  const sign = pct > 0 ? "+" : pct < 0 ? "\u2212" : "";
  return sign + Math.abs(pct).toFixed(1) + "%";
}

// Warna: metrik biasa naik=hijau; metrik biaya (isCost) naik=merah.
function trendClass(delta, isCost) {
  if (delta === 0) return "";
  const good = isCost ? delta < 0 : delta > 0;
  return good ? "insight-up" : "insight-down";
}

function renderInsightView() {
  const periods = getInsightPeriods();
  const active = insightAggregate(periods.active.from, periods.active.to);
  const prev = insightAggregate(periods.prev.from, periods.prev.to);
  const yoy = insightAggregate(periods.yoy.from, periods.yoy.to);

  document.getElementById("insight-table-title").textContent =
    `Tabel Perbandingan \u2014 ${periods.active.label}`;
  document.getElementById("insight-range-caption").textContent =
    `${periods.active.label} vs ${periods.prev.label} (${periods.momLabel}) & ${periods.yoy.label} (YoY)`;

  // Header
  document.getElementById("insight-table-head").innerHTML = `
    <th>No</th>
    <th>Deskripsi</th>
    <th>${periods.prev.label}</th>
    <th class="insight-col-active">${periods.active.label}</th>
    <th>Gap ${periods.momLabel}</th>
    <th>Growth ${periods.momLabel}</th>
    <th>${periods.yoy.label}</th>
    <th>Gap YoY</th>
    <th>Growth YoY</th>
  `;

  // Body
  const body = document.getElementById("insight-table-body");
  body.innerHTML = INSIGHT_ROWS.map((row, i) => {
    const [label, key, type, isCost] = row;
    const aVal = active[key], pVal = prev[key], yVal = yoy[key];
    const gapMom = aVal - pVal;
    const gapYoy = aVal - yVal;
    return `
      <tr>
        <td>${i + 1}</td>
        <td>${label}</td>
        <td>${fmtInsightValue(pVal, type)}</td>
        <td class="insight-col-active">${fmtInsightValue(aVal, type)}</td>
        <td class="${trendClass(gapMom, isCost)}">${fmtGap(gapMom, type)}</td>
        <td class="${trendClass(gapMom, isCost)}">${fmtGrowth(aVal, pVal)}</td>
        <td>${fmtInsightValue(yVal, type)}</td>
        <td class="${trendClass(gapYoy, isCost)}">${fmtGap(gapYoy, type)}</td>
        <td class="${trendClass(gapYoy, isCost)}">${fmtGrowth(aVal, yVal)}</td>
      </tr>
    `;
  }).join("");

  renderEfficiencyPanel("mom", active, prev, periods.momLabel, periods.prev.label, periods.active.label);
  renderEfficiencyPanel("yoy", active, yoy, "YoY", periods.yoy.label, periods.active.label);
}

// Badge (teks + warna) per grup metrik untuk panel efisiensi.
// - volume: naik="NAIK" hijau, turun="TURUN" merah
// - prod:   naik="MEMBAIK" hijau, turun="MENURUN" merah
// - cost:   naik="NAIK" MERAH (jelek), turun="TURUN" hijau (bagus)  [opsi A]
function insightBadge(delta, grup) {
  if (delta === 0) return { text: "TETAP", cls: "" };
  const up = delta > 0;
  if (grup === "cost") {
    return up ? { text: "NAIK", cls: "insight-badge-bad" } : { text: "TURUN", cls: "insight-badge-good" };
  }
  if (grup === "prod") {
    return up ? { text: "MEMBAIK", cls: "insight-badge-good" } : { text: "MENURUN", cls: "insight-badge-bad" };
  }
  // volume
  return up ? { text: "NAIK", cls: "insight-badge-good" } : { text: "TURUN", cls: "insight-badge-bad" };
}

function renderEfficiencyPanel(which, active, base, label, baseLabel, activeLabel) {
  document.getElementById(`insight-eff-${which}-sub`).textContent =
    `${baseLabel} vs ${activeLabel} (${label})`;
  if (which === "mom") {
    document.getElementById("insight-eff-mom-title").textContent = `Perbandingan Efisiensi ${label}`;
  }

  const list = document.getElementById(`insight-eff-${which}-list`);
  list.innerHTML = INSIGHT_ROWS.map((row) => {
    const [name, key, , isCost, icon, grup] = row;
    const delta = active[key] - base[key];
    const badge = insightBadge(delta, grup);
    // Warna angka growth: ikut penilaian bagus/jelek (bukan arah mentah).
    const good = badge.cls === "insight-badge-good";
    const growthCls = delta === 0 ? "" : (good ? "insight-up" : "insight-down");
    const arrow = delta > 0 ? "\u25B2" : delta < 0 ? "\u25BC" : "";
    return `
      <div class="insight-eff-item">
        <div class="insight-eff-icon">${icon}</div>
        <div class="insight-eff-name">${name}</div>
        <div class="insight-eff-growth ${growthCls}">
          <span class="insight-eff-arrow">${arrow}</span>
          <span>${fmtGrowth(active[key], base[key])}</span>
        </div>
        <span class="insight-badge ${badge.cls}">${badge.text}</span>
      </div>
    `;
  }).join("");

  renderConclusion(which, active, base, label);
}

// Kotak kesimpulan otomatis berbasis aturan sederhana (bukan AI).
function renderConclusion(which, active, base, label) {
  const box = document.getElementById(`insight-eff-${which}-conclusion`);
  const g = (key) => (base[key] ? ((active[key] - base[key]) / base[key]) * 100 : 0);

  const doG = g("do"), dpG = g("dp"), dpTripG = g("dp_trip"), ujpG = g("ujp"), insG = g("insentif");
  const costUp = ujpG > 0 || insG > 0;

  const lines = [];
  // Demand
  const demandUp = doG > 0 && dpG > 0;
  lines.push({
    cls: demandUp ? "up" : "down",
    html: `\uD83D\uDCE6 Demand: DO ${fmtPct(doG)} &amp; DP ${fmtPct(dpG)} (${demandUp ? "\u2191 demand naik" : "demand turun"})`,
  });
  // Kepadatan armada
  lines.push({
    cls: dpTripG >= 0 ? "up" : "down",
    html: `\uD83D\uDCCA DP/Trip ${fmtPct(dpTripG)} \u2014 ${dpTripG >= 0 ? "armada makin padat" : "kepadatan armada turun"}`,
  });
  // Biaya
  lines.push({
    cls: costUp ? "down" : "up",
    html: `\uD83D\uDCB0 Biaya UJP ${fmtPct(ujpG)} &amp; Insentif ${fmtPct(insG)} \u2014 ${costUp ? "cost meningkat" : "cost terkendali"}`,
  });

  const warn = costUp;
  box.className = "insight-conclusion " + (warn ? "warn" : "ok");
  box.innerHTML =
    `<div class="insight-conclusion-title">${warn ? "\u26A0\uFE0F KESIMPULAN: Perlu Evaluasi" : "\u2705 KESIMPULAN: Sehat"}</div>` +
    lines.map((l) => `<span class="insight-conclusion-line ${l.cls}">${l.html}</span>`).join("");
}

function fmtPct(pct) {
  const sign = pct > 0 ? "+" : pct < 0 ? "\u2212" : "";
  return sign + Math.abs(pct).toFixed(1) + "%";
}

function wireInsightControls() {
  const apply = () => {
    const from = document.getElementById("insight-date-from").value;
    const to = document.getElementById("insight-date-to").value;
    if (from && to) {
      insightCustomRange = { from, to };
      if (isInsightViewActive()) renderInsightView();
    }
  };
  document.getElementById("insight-date-from").addEventListener("change", apply);
  document.getElementById("insight-date-to").addEventListener("change", apply);
  document.getElementById("insight-range-reset").addEventListener("click", () => {
    insightCustomRange = null;
    document.getElementById("insight-date-from").value = "";
    document.getElementById("insight-date-to").value = "";
    if (isInsightViewActive()) renderInsightView();
  });
}

// ---------------- RANKING JALUR ----------------

let jalurMetric = "insentif";
let jalurSortDir = "desc"; // "asc" | "desc" -- cuma kolom Total yang sortable

// Tentukan kolom bulan yang ditampilkan, mengikuti filter Tahun+Bulan/Q/H
// yang sama persis dengan topbar (bukan filter terpisah).
function getJalurColumns() {
  if (PERIOD_RANGES[currentMonth]) {
    const [sM, eM] = PERIOD_RANGES[currentMonth];
    const cols = [];
    for (let m = sM; m <= eM; m++) {
      cols.push({ key: `${currentYear}-${String(m).padStart(2, "0")}`, label: MONTH_NAMES_ID[m - 1], type: "month" });
    }
    return cols;
  }
  if (currentMonth === "all") {
    const monthSet = new Set();
    activeHubKeys().forEach((k) => (RAW[k] || []).forEach((r) => {
      const d = parseTanggal(r["Tanggal"]);
      if (d && String(d.getFullYear()) === String(currentYear)) monthSet.add(monthKey(d));
    }));
    return Array.from(monthSet).sort().map((mk) => ({
      key: mk, label: MONTH_NAMES_ID[parseInt(mk.split("-")[1], 10) - 1], type: "month",
    }));
  }
  if (String(currentMonth).startsWith("custom:")) {
    const [, from, to] = currentMonth.split(":");
    return [{ key: "custom", label: fmtRangeLabel(parseISODateLocal(from), parseISODateLocal(to)), type: "custom", from, to }];
  }
  // Bulan spesifik "YYYY-MM"
  const m = parseInt(String(currentMonth).split("-")[1], 10);
  return [{ key: currentMonth, label: `${MONTH_NAMES_ID[m - 1]} ${currentYear}`, type: "month" }];
}

// Kumpulkan semua baris data, dikelompokkan per (Jalur/Area, Site/Hub, Bulan).
function buildJalurGroups() {
  const keys = activeHubKeys();
  const groups = {}; // "area|hubKey" -> { area, hubKey, byMonth: {"YYYY-MM": rows[]} }
  keys.forEach((hubKey) => {
    (RAW[hubKey] || []).forEach((r) => {
      const d = parseTanggal(r["Tanggal"]);
      if (!d) return;
      const mk = monthKey(d);
      const area = (r["Area"] || "").toString().trim() || "(Tanpa Jalur)";
      const gk = area + "|" + hubKey;
      if (!groups[gk]) groups[gk] = { area, hubKey, byMonth: {} };
      if (!groups[gk].byMonth[mk]) groups[gk].byMonth[mk] = [];
      groups[gk].byMonth[mk].push(r);
    });
  });
  return groups;
}

function jalurMetricValue(rows, metric) {
  if (!rows || !rows.length) return 0;
  let doTotal = 0, dp = 0, ujp = 0, ins = 0;
  rows.forEach((r) => {
    doTotal += toNumber(r["Jumlah_do"]);
    dp += toNumber(r["jumlah_titik"]);
    ujp += toNumber(r["UJP"]);
    ins += toNumber(r["Insentif Ref"]);
  });
  const trip = rows.length;
  switch (metric) {
    case "insentif": return ins;
    case "ujp": return ujp;
    case "trip": return trip;
    case "do": return doTotal;
    case "dp": return dp;
    case "do_trip": return trip ? doTotal / trip : 0;
    case "dp_trip": return trip ? dp / trip : 0;
    default: return 0;
  }
}

// Nilai metrik untuk 1 kolom "custom" (rentang tanggal), difilter per hub+area.
function jalurCustomRangeValue(hubKey, area, fromStr, toStr, metric) {
  const fromD = parseISODateLocal(fromStr), toD = parseISODateLocal(toStr);
  const rows = (RAW[hubKey] || []).filter((r) => {
    if (((r["Area"] || "").toString().trim() || "(Tanpa Jalur)") !== area) return false;
    const d = parseTanggal(r["Tanggal"]);
    return d && d >= fromD && d <= toD;
  });
  return jalurMetricValue(rows, metric);
}

function getPrevMonthKey(mk) {
  const [y, m] = mk.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

function fmtJalurValue(val, metric) {
  if (!val) return null; // 0/undefined -> ditampilkan "--"
  if (metric === "insentif" || metric === "ujp") return "Rp " + numFmt(val);
  if (metric === "do_trip" || metric === "dp_trip") {
    return new Intl.NumberFormat("id-ID", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(val);
  }
  return numFmt(val);
}

function renderJalurTable() {
  const columns = getJalurColumns();
  const groups = buildJalurGroups();
  const metric = jalurMetric;

  // Hitung value + growth per grup per kolom, plus Total.
  const rows = Object.values(groups).map((g) => {
    const hub = HUBS.find((h) => h.key === g.hubKey);
    const cellValues = columns.map((col) => {
      let val;
      if (col.type === "custom") {
        val = jalurCustomRangeValue(g.hubKey, g.area, col.from, col.to, metric);
      } else {
        val = jalurMetricValue(g.byMonth[col.key], metric);
        const prevMk = getPrevMonthKey(col.key);
        const prevRows = (RAW[g.hubKey] || []).filter((r) => {
          if (((r["Area"] || "").toString().trim() || "(Tanpa Jalur)") !== g.area) return false;
          const d = parseTanggal(r["Tanggal"]);
          return d && monthKey(d) === prevMk;
        });
        const prevVal = jalurMetricValue(prevRows, metric);
        const growth = prevVal > 0 ? ((val - prevVal) / prevVal) * 100 : null;
        return { val, growth };
      }
      return { val, growth: null };
    });
    const total = cellValues.reduce((a, c) => a + (c.val || 0), 0);
    return { area: g.area, siteLabel: hub ? hub.label : g.hubKey, cellValues, total };
  });

  // Urutan medali (Top 3) SELALU berdasarkan Total tertinggi, terlepas
  // dari arah sort yang lagi aktif di tabel.
  const rankOrder = [...rows].sort((a, b) => b.total - a.total);
  const medalByArea = {};
  rankOrder.slice(0, 3).forEach((r, i) => { medalByArea[r.area + "|" + r.siteLabel] = ["\uD83E\uDD47", "\uD83E\uDD48", "\uD83E\uDD49"][i]; });

  rows.sort((a, b) => (jalurSortDir === "desc" ? b.total - a.total : a.total - b.total));

  // Caption
  const siteLabel = currentSite === "all" ? "Semua Site" : "Hub " + (HUBS.find((h) => h.key === currentSite)?.label || "");
  const metricLabel = document.getElementById("jalur-metric-select").selectedOptions[0]?.textContent || "";
  const monthRangeLabel = columns.length > 1
    ? `${columns[0].label}\u2013${columns[columns.length - 1].label}`
    : (columns[0]?.label || "-");
  document.getElementById("jalur-caption").textContent =
    `${rows.length} jalur \u00B7 ${metricLabel} \u00B7 ${HUBS.length} site \u00B7 ${monthRangeLabel}`;

  // Header
  const arrow = jalurSortDir === "desc" ? "\u2193" : "\u2191";
  const head = document.getElementById("jalur-table-head");
  head.innerHTML = `
    <th>#</th>
    <th>Jalur</th>
    <th>Site Hub</th>
    ${columns.map((c) => `<th>${c.label}</th>`).join("")}
    <th class="jalur-sortable" id="jalur-total-header">Total <span class="jalur-sort-arrow">${arrow}</span></th>
  `;
  document.getElementById("jalur-total-header").addEventListener("click", () => {
    jalurSortDir = jalurSortDir === "desc" ? "asc" : "desc";
    renderJalurTable();
  });

  // Body
  const body = document.getElementById("jalur-table-body");
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="${3 + columns.length + 1}" class="driver-table-empty">Tidak ada data.</td></tr>`;
    return;
  }
  body.innerHTML = rows.map((r, i) => {
    const medal = medalByArea[r.area + "|" + r.siteLabel];
    const rankCell = medal ? `<span class="jalur-rank-medal">${medal}</span>` : (i + 1);
    const cellsHtml = r.cellValues.map((c) => {
      const formatted = fmtJalurValue(c.val, metric);
      if (formatted === null) return `<td class="jalur-empty-cell">\u2014</td>`;
      let growthHtml = "";
      if (c.growth !== null && isFinite(c.growth)) {
        const cls = c.growth >= 0 ? "up" : "down";
        const sign = c.growth >= 0 ? "\u2191" : "\u2193";
        growthHtml = `<span class="jalur-growth ${cls}">${sign}${Math.abs(c.growth).toFixed(0)}%</span>`;
      }
      return `<td>${formatted}${growthHtml}</td>`;
    }).join("");
    return `
      <tr>
        <td>${rankCell}</td>
        <td class="jalur-name">${escapeHtml(r.area)}</td>
        <td><span class="jalur-site-pill">Hub ${escapeHtml(r.siteLabel)}</span></td>
        ${cellsHtml}
        <td class="jalur-total">${fmtJalurValue(r.total, metric) ?? "\u2014"}</td>
      </tr>
    `;
  }).join("");
}

function wireJalurControls() {
  document.getElementById("jalur-metric-select").addEventListener("change", (e) => {
    jalurMetric = e.target.value;
    renderJalurTable();
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
  wireInsightControls();
  wireJalurControls();
  loadAllData();
});
