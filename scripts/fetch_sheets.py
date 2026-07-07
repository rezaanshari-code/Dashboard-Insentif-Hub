#!/usr/bin/env python3
"""
fetch_sheets.py
================
1. Menarik semua tab "Hub ..." dari Google Sheets -> docs/data.json
2. Me-render docs/template.html -> docs/index.html (isi placeholder
   {{GENERATED_AT}} dan {{BUILD_ID}} untuk cache-busting asset)

Dijalankan otomatis oleh GitHub Actions (lihat
.github/workflows/update_data.yml), tapi juga bisa dijalankan manual
di komputer lokal dari root repo:

    python3 scripts/fetch_sheets.py

Cuma pakai library bawaan Python (urllib, csv, json) — tidak perlu
`pip install` apapun, biar GitHub Actions-nya ringan & cepat.

PENTING: kalau ada hub baru ditambahkan di docs/hub_coords.json
(dipakai frontend untuk peta), tambahkan juga entrinya di HUBS di
bawah ini supaya datanya ikut ditarik. "key" di kedua tempat itu
harus sama persis.
"""

import csv
import io
import json
import re
import sys
import urllib.request
import urllib.error
import urllib.parse
from datetime import datetime, timezone

SPREADSHEET_ID = "1prBJYIfN-QyRIZGZCWhN6jdtFwfigORjwdutu6MGByc"

# Harus sinkron dengan "key" di docs/hub_coords.json
HUBS = [
    {"key": "bogor",     "sheet": "Hub Bogor"},
    {"key": "tangerang", "sheet": "Hub Tangerang"},
    {"key": "utara",     "sheet": "Hub Utara"},
    {"key": "bandung",   "sheet": "Hub Bandung"},
    {"key": "yogya",     "sheet": "Hub Yogya"},
    {"key": "semarang",  "sheet": "Hub Semarang"},
    {"key": "lampung",   "sheet": "Hub Lampung"},
    {"key": "palembang", "sheet": "Hub Palembang"},
    {"key": "kediri",    "sheet": "Hub Kediri"},
]

DOCS_DIR = "docs"
DATA_PATH = f"{DOCS_DIR}/data.json"
TEMPLATE_PATH = f"{DOCS_DIR}/template.html"
INDEX_PATH = f"{DOCS_DIR}/index.html"


def build_csv_url(sheet_name: str) -> str:
    encoded = urllib.parse.quote(sheet_name)
    return (
        f"https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}"
        f"/gviz/tq?tqx=out:csv&sheet={encoded}"
    )


def fetch_sheet_rows(sheet_name: str) -> list[dict]:
    url = build_csv_url(sheet_name)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read().decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(raw))
    return list(reader)


def fetch_all_data() -> dict:
    result = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "hubs": {},
    }
    had_error = False
    for hub in HUBS:
        try:
            rows = fetch_sheet_rows(hub["sheet"])
            result["hubs"][hub["key"]] = rows
            print(f"[OK] {hub['sheet']}: {len(rows)} baris")
        except urllib.error.URLError as e:
            had_error = True
            print(f"[GAGAL] {hub['sheet']}: {e}", file=sys.stderr)
            result["hubs"][hub["key"]] = []

    with open(DATA_PATH, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    total_rows = sum(len(v) for v in result["hubs"].values())
    print(f"\n{DATA_PATH}: total {total_rows} baris ditulis")

    if had_error:
        # Tetap lanjut supaya data yg berhasil tetap ke-commit, tapi
        # error di atas akan kelihatan di log tab Actions.
        print("Sebagian sheet gagal ditarik — cek log di atas.", file=sys.stderr)

    return result


def render_index(generated_at_iso: str) -> None:
    with open(TEMPLATE_PATH, "r", encoding="utf-8") as f:
        html = f.read()

    build_id = re.sub(r"[^0-9]", "", generated_at_iso)  # mis. 20260707063000
    html = html.replace("{{GENERATED_AT}}", generated_at_iso)
    html = html.replace("{{BUILD_ID}}", build_id)

    with open(INDEX_PATH, "w", encoding="utf-8") as f:
        f.write(html)

    print(f"{INDEX_PATH}: di-render ulang dari {TEMPLATE_PATH}")


def main():
    result = fetch_all_data()
    render_index(result["generated_at"])


if __name__ == "__main__":
    main()
