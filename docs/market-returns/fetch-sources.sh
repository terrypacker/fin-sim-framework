#!/usr/bin/env bash
#
# Re-fetch the sources behind the equity markets' default total returns and dividend
# yields (design 99 P5b). What each file is FOR, and the figures taken from it, are in
# docs/market-returns/SOURCES.md.
#
#   docs/market-returns/fetch-sources.sh
#
# J.P. Morgan's LTCMA has no scripted route (JavaScript-rendered downloads; the direct
# PDF URL 404s) — download it by hand, see SOURCES.md.
#
set -euo pipefail
cd "$(dirname "$0")/data"

UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15"

get() {   # get <local-file> <url>
  echo "  $1"
  curl -sSL --fail --max-time 120 -A "$UA" -o "$1" "$2"
}
pdf() {   # pdf <local-name-without-.pdf> <url> — fetch, check it IS a PDF, extract text
  get "$1.pdf" "$2"
  file "$1.pdf" | grep -q PDF || { echo "  !! $1.pdf is not a PDF"; exit 1; }
  pdftotext -layout "$1.pdf" "$1.txt"
}

echo "Vanguard (VCMM)"
pdf Vanguard-AU-Asset-allocation-report-latest \
  "https://fund-docs.vanguard.com/AU-Vanguard_Asset_allocation_report.pdf"
get Vanguard-US-VCMM-return-forecasts-latest.html \
  "https://corporate.vanguard.com/content/corporatesite/us/en/corp/vemo/vemo-return-forecasts.html"

echo "BlackRock (CMA workbook + definitions page)"
get BlackRock-CMA-latest.xlsx \
  "https://www.blackrock.com/blk-inst-c-assets/images/tools/blackrock-investment-institute/cma/blackrock-capital-market-assumptions.xlsx"
get BlackRock-CMA-page-latest.html \
  "https://www.blackrock.com/institutions/en-apac/insights/thought-leadership/capital-market-assumptions"

echo "MSCI index factsheets (dividend yields)"
M=https://www.msci.com/documents/10199/255599
pdf MSCI-USA-Index-USD-factsheet             "$M/msci-usa-index-gross.pdf"
pdf MSCI-World-ex-USA-Index-USD-factsheet    "$M/msci-world-ex-usa-index.pdf"
pdf MSCI-Australia-Index-AUD-factsheet       "$M/msci-australia-index.pdf"
pdf MSCI-World-ex-Australia-Index-AUD-factsheet \
  "https://www.msci.com/resources/factsheets/index_fact_sheet/msci-world-ex-australia-index-aud-gross.pdf"

echo "APRA (super's equity market mix, design 99 P5c)"
# APRA's file paths carry the upload month and quarter, so these URLs are the June 2026
# editions. For a newer one, take the link from apra.gov.au/quarterly-superannuation-
# industry-publication (Table 9a) and .../quarterly-superannuation-statistics.
A=https://www.apra.gov.au/system/files
get APRA-Quarterly-superannuation-industry-publication-latest.xlsx \
  "$A/2026-09/Quarterly%20Superannuation%20Industry%20Publication%20-%20June%202026.xlsx"
get APRA-Quarterly-MySuper-statistics-latest.xlsx \
  "$A/2026-08/Quarterly%20MySuper%20statistics%20from%20September%202020%20to%20June%202026_1.xlsx"
get APRA-Quarterly-superannuation-performance-statistics-latest.xlsx \
  "$A/2026-08/Quarterly%20superannuation%20performance%20statistics%20-%20December%202004%20to%20June%202026%20_0.xlsx"
get APRA-CPPP-MySuper-latest.xlsx "$A/2026-08/2026%20CPPP%20-%20MySuper.xlsx"
get APRA-Quarterly-superannuation-product-publication-performance-latest.xlsx \
  "$A/2026-09/Quarterly%20Superannuation%20Product%20Publication%20-%20Performance%20%20-%20June%202026.xlsx"

echo "Done. The *-latest files are NEW editions: compare them with the dated copies"
echo "SOURCES.md cites before changing any default, then rename them to their as-of date."
