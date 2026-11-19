#!/usr/bin/env bash
#
# Re-fetch the sources behind the farm Monte Carlo's calibration (design 134 §13.8). What
# each file is FOR, and the figures taken from it, are in docs/us-farm-markets/SOURCES.md.
#
#   docs/us-farm-markets/fetch-sources.sh [YYYYMMDD]
#
# The NASS crops bulk file is ~1.1 GB gzipped; it is downloaded to a temporary directory,
# checked, filtered by nass-extract.py, and deleted. NASS names each release by date: pass
# the date shown at https://www.nass.usda.gov/datasets (default: today's).
#
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"
stamp="${1:-$(date +%Y%m%d)}"
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT

echo "USDA NASS Quick Stats, crops bulk file ($stamp)"
# HTTP/2 streams of this file end early; HTTP/1.1 with resume does not.
curl -sSL --http1.1 --retry 5 --retry-all-errors -C - --max-time 3000 -A "$UA" \
  -o "$tmp/qs.crops.txt.gz" \
  "https://www.nass.usda.gov/sites/default/files/datasets/qs.crops_${stamp}.txt.gz"
gzip -t "$tmp/qs.crops.txt.gz"
# The bulk file carries stray NUL bytes, which Python's csv refuses.
gunzip -c "$tmp/qs.crops.txt.gz" | tr -d '\000' | python3 -I "$here/nass-extract.py" "$tmp/extract.tsv"
gzip -9 -n -c "$tmp/extract.tsv" > "nass-qs-corn-soy-ne-us-${stamp}.tsv.gz"
echo "  nass-qs-corn-soy-ne-us-${stamp}.tsv.gz"

echo "farmdoc daily — Projected Prices and Volatility Factors for 2026 (cross-check)"
curl -sSL --fail --max-time 120 -A "$UA" -o farmdoc-daily-2026-03-03-projected-prices-volatility.pdf \
  "https://farmdocdaily.illinois.edu/wp-content/uploads/2026/03/fdd030326.pdf"
file farmdoc-daily-2026-03-03-projected-prices-volatility.pdf | grep -q PDF
pdftotext -layout farmdoc-daily-2026-03-03-projected-prices-volatility.pdf \
  farmdoc-daily-2026-03-03-projected-prices-volatility.txt
echo "  farmdoc-daily-2026-03-03-projected-prices-volatility.pdf"
