# Insentif Dashboard Pengiriman

Dashboard statis (HTML/CSS/JS, tanpa backend) yang menampilkan data
insentif per hub. Data ditarik **langsung/live** dari Google Sheets
setiap kali halaman dibuka atau tombol **Refresh** ditekan — jadi kalau
spreadsheet diupdate, dashboard otomatis ikut update tanpa perlu
rebuild atau upload ulang file apapun.

## 1. Cara kerja auto-update dari spreadsheet

Dashboard memakai endpoint bawaan Google Sheets:

```
https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/gviz/tq?tqx=out:csv&sheet=<NAMA_TAB>
```

Endpoint ini otomatis bisa diakses selama spreadsheet-nya sudah
di-share **"Anyone with the link can view"** (sudah aktif di
spreadsheet lu sekarang) — **tidak perlu** langkah "Publish to web"
terpisah.

**Test manual dulu sebelum deploy:** buka link berikut di browser:

```
https://docs.google.com/spreadsheets/d/1prBJYIfN-QyRIZGZCWhN6jdtFwfigORjwdutu6MGByc/gviz/tq?tqx=out:csv&sheet=Hub%20Bogor
```

- Kalau keluar teks CSV mentah → aman, dashboard akan berfungsi.
- Kalau keluar halaman login/error → cek ulang setting share di
  spreadsheet (`Share` → `Anyone with the link` → `Viewer`).

Kalau suatu saat lu ingin datanya benar-benar privat (tidak bisa
diakses siapapun yang punya link), ganti mekanisme ini dengan Google
Apps Script Web App yang mengembalikan JSON dan bisa dibatasi
aksesnya — kabari saja kalau butuh versi ini.

## 2. Struktur file

```
insentif-dashboard/
├── index.html    # struktur halaman
├── style.css     # tampilan (sidebar navy, kartu KPI, panel peta)
├── config.js     # <-- EDIT DI SINI kalau ada hub baru / ganti spreadsheet
├── app.js        # logika: fetch data, hitung KPI, render peta
└── README.md
```

## 3. Menambah hub / site baru

Cukup edit `config.js`, tambahkan satu baris di array `HUBS`:

```js
{ key: "cikupa", sheet: "Hub Cikupa", label: "Cikupa", color: "#0ea5e9", lat: -6.276, lng: 106.548 },
```

- `sheet` harus **persis sama** dengan nama tab di Google Sheets.
- `lat`/`lng` untuk posisi titik di peta (cari di Google Maps, klik
  kanan lokasi → koordinat akan muncul).

Tidak perlu ubah `app.js` sama sekali — semua hub di `config.js`
otomatis ikut dihitung dan ditampilkan.

## 4. Push ke GitHub (repo belum ada)

Jalankan di terminal, di dalam folder `insentif-dashboard`:

```bash
git init
git add .
git commit -m "Initial dashboard"
git branch -M main
git remote add origin https://github.com/<USERNAME>/<NAMA_REPO>.git
git push -u origin main
```

Ganti `<USERNAME>` dan `<NAMA_REPO>` sesuai punya lu. Kalau repo di
GitHub belum dibuat sama sekali, buat dulu repo kosong (tanpa
README/gitignore) lewat github.com → **New repository**, baru jalankan
perintah di atas.

## 5. Aktifkan GitHub Pages (biar jadi link web publik)

1. Di GitHub, buka repo → **Settings** → **Pages**
2. Di **Source**, pilih branch `main`, folder `/ (root)`
3. Klik **Save**
4. Setelah ±1 menit, dashboard bisa diakses di:
   `https://<USERNAME>.github.io/<NAMA_REPO>/`

Setelah ini aktif, **lu tidak perlu upload ulang HTML lagi**. Setiap
buka link itu, dashboard otomatis fetch data terbaru dari spreadsheet.
Kalau ke depan lu mau ubah tampilan/kode, tinggal edit file lokal lalu:

```bash
git add .
git commit -m "update tampilan"
git push
```

GitHub Pages otomatis re-deploy dalam ~1 menit.

## 6. Keterbatasan versi ini

- Filter tanggal custom (`Terapkan`) memfilter berdasarkan rentang
  tanggal antar dua input date.
- Menu **Distribusi MPP** dan **Insight** di sidebar baru placeholder
  navigasi (belum ada halaman terpisah) — kabari kalau mau gue
  lengkapi juga.
- Site "NDC" (Jababeka, Cikupa, Sidoarjo) belum dimasukkan karena
  belum ada sheet-nya di spreadsheet — tinggal tambah sesuai poin 3
  begitu datanya ada.
