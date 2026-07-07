// ============================================================
// KONFIGURASI DASHBOARD INSENTIF
// ============================================================
// Ubah SPREADSHEET_ID kalau lu pindah ke spreadsheet lain.
// Ubah/tambah entri di HUBS kalau ada hub/site baru.
// ============================================================

const SPREADSHEET_ID = "1prBJYIfN-QyRIZGZCWhN6jdtFwfigORjwdutu6MGByc";

// Setiap hub = 1 tab/sheet di spreadsheet. "sheet" harus PERSIS sama
// dengan nama tab di Google Sheets (termasuk kapitalisasi & spasi).
const HUBS = [
  { key: "bogor",     sheet: "Hub Bogor",     label: "Bogor",     color: "#16a34a", lat: -6.595, lng: 106.816 },
  { key: "tangerang", sheet: "Hub Tangerang", label: "Tangerang", color: "#0d9488", lat: -6.178, lng: 106.630 },
  { key: "utara",     sheet: "Hub Utara",     label: "Utara",     color: "#0f766e", lat: -6.121, lng: 106.774 },
  { key: "bandung",   sheet: "Hub Bandung",   label: "Bandung",   color: "#14b8a6", lat: -6.917, lng: 107.619 },
  { key: "yogya",     sheet: "Hub Yogya",     label: "Yogya",     color: "#9333ea", lat: -7.797, lng: 110.370 },
  { key: "semarang",  sheet: "Hub Semarang",  label: "Semarang",  color: "#e11d48", lat: -6.966, lng: 110.418 },
  { key: "lampung",   sheet: "Hub Lampung",   label: "Lampung",   color: "#f97316", lat: -5.429, lng: 105.262 },
  { key: "palembang", sheet: "Hub Palembang", label: "Palembang", color: "#7c3aed", lat: -2.990, lng: 104.756 },
  { key: "kediri",    sheet: "Hub Kediri",    label: "Kediri",    color: "#991b1b", lat: -7.848, lng: 112.017 },
];

// Bangun URL CSV live dari Google Sheets untuk 1 tab tertentu.
// Ini memakai endpoint "gviz" bawaan Google — jalan otomatis selama
// sheet-nya sudah di-share "Anyone with the link can view" (sudah lu
// aktifkan), tanpa perlu langkah "Publish to web" terpisah.
function buildCsvUrl(sheetName) {
  const encoded = encodeURIComponent(sheetName);
  return `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encoded}`;
}
