# AU tax sources — provenance for the root-level files

`docs/au-tax/ITAA-1936`, `ITAA-1997` and `SGAA-1992` are Federal Register of Legislation
compilations and carry their own compilation number and date in the text. `ato-forms/` has
its own `SOURCES.md`, and it explains the routes ATO material has to take: **`ato.gov.au`
returns 403 to every automated fetch**, so anything from the ATO arrives by hand.

This file covers the loose files at this level.

| File | Source | Route |
|---|---|---|
| `ATO-TR-2008-1-Wash-Sale-Part-IVA.txt` | **TR 2008/1** *Income tax: application of Part IVA of the Income Tax Assessment Act 1936 to 'wash sale' arrangements* — the Commissioner's public ruling, 47 pages including the examples and Appendix 1's explanation. The authority behind design 94 §8.1d. | Downloaded by hand from the ATO Legal database as PDF, converted with `pdftotext -layout`. Text layer, verbatim; the ruling is two-column in places, so a `cut`-style column extract can interleave — read whole paragraphs. |
| `ATO-TA-2008-7-Wash-Sale-Part-IVA.txt` | **TA 2008/7** — the Taxpayer Alert. Kept alongside the ruling because it is the shorter statement of the same position and its worked example is TR 2008/1's Example 2. | Same route. |

Both arrived by hand because **`ato.gov.au` and AustLII return 403 to every automated
fetch** — there is no scripted path to ATO rulings, and there is no point rediscovering
that. Ask for the PDF.

## `TAA-1953/` — and the scripted route to the Federal Register (found 16 Sep 2026)

`TAA-1953/C2026C00393VOL02.txt` is the **Taxation Administration Act 1953**, Compilation
No. 226 (compilation date 27 August 2026), **volumes 1 and 2 of 4**:

* `C2026C00393VOL01.txt` — Parts I to V, sections 1 to 18, then Schedule 1 Chapter 2
  Parts 2-1 to 2-5 (sections 6-1 to 21-5). Carries **Part IIA, the general interest
  charge** — `s 8AAD` is the GIC rate (base rate + 7 points, the base being the RBA's
  90-day Bank Accepted Bill yield on the lag table in `8AAD(2)`).
* `C2026C00393VOL02.txt` — Schedule 1, Chapter 2, Part 2-10 to Chapter 4, Part 4-25,
  sections 45-1 to 298-110. Carries **Division 45 (PAYG instalments)** in full.

Both are relied on by design 107. Volumes 3 and 4 are not on disk; add them the same way
if a section outside those ranges is ever needed.

**`www.legislation.gov.au` is an Angular SPA and every human-looking URL returns the same
62 KB shell with a 200** — including the `/downloads` tab, which is why this looked blocked.
It is not. There is a working scripted route, in two steps:

1. **Find the current compilation** through the OData API, which is open and needs no key:

   ```sh
   # entity sets: Titles, Versions, Documents, …   (see /v1/$metadata)
   curl -s "https://api.prod.legislation.gov.au/v1/Versions?\$filter=titleId%20eq%20'C1953A00001'%20and%20isCurrent%20eq%20true"
   # → registerId C2026C00393, compilationNumber 226, start 2026-08-27
   curl -s "https://api.prod.legislation.gov.au/v1/Documents?\$filter=registerId%20eq%20'C2026C00393'"
   # → one row per (format, volumeNumber): Pdf vols 1-4, Word vols 1-4, one Epub
   ```

   `titleId` is the *principal Act's* id (`C1953A00001` = Act No. 1 of 1953), **not** the
   compilation id. ITAA 1997 is `C2004A00138`, ITAA 1936 is `C1936A00027`.

2. **Download the volume** from the public site, at a path the SPA builds client-side and
   which is therefore documented nowhere:

   ```
   https://www.legislation.gov.au/<titleId>/<start>/<retrospectiveStart>/text/<rect>/<format>/<volume>
   ```

   `start` and `retrospectiveStart` are the version dates as `YYYY-MM-DD` (both, even when
   identical); `text` is the literal word for a `type: "Primary"` document; `<rect>` is
   `original` unless `rectificationVersionNumber > 0`, in which case it is that number;
   `<format>` is lower-case (`pdf`); `<volume>` is omitted for single-volume titles. So:

   ```sh
   curl -sL -o TAA-vol2.pdf \
     "https://www.legislation.gov.au/C1953A00001/2026-08-27/2026-08-27/text/original/pdf/2"
   pdftotext -layout TAA-vol2.pdf TAA-1953/C2026C00393VOL02.txt
   ```

   A wrong path does **not** 404 — it returns the SPA shell as `text/html`. Always check
   `content_type` is `application/pdf` before converting, or you will `pdftotext` an HTML
   page and get an empty file.

**This does not contradict the ATO note above.** Two different sites: `ato.gov.au` (rulings,
guidance, rates) still 403s every automated fetch and still arrives by hand. The Federal
Register of Legislation (Acts and Regulations) is scriptable by the route above.

## `ato-rates/` additions, 16 Sep 2026 (design 107)

| File | Source | Route |
|---|---|---|
| `ato-gdp-adjustment-2026-27.txt` | **ATO Software Developers**, *GDP adjustment for 2026–27 GST and PAYG instalments*, version 2027, published 11/06/2026 | `softwaredevelopers.ato.gov.au` **hangs** on automated fetch — no response at all, not even the 403 the main domain gives. The page is almost entirely metadata plus one "Description" field, so it was **transcribed from the live page by hand** rather than saved as a PDF. Corroborated by the row below, which is an independent ATO page carrying the same 5% figure. |
| `ato-payg-instalment-calculation-2026.{pdf,txt}` | **ATO QC 68098**, *How we calculate your PAYG instalment amount or rate*, page last updated 20 May 2025 | Saved to PDF by hand. **The print-to-PDF has no text layer** — `pdftotext` returns only the five running headers — so the `.txt` is OCR: `pdftoppm -r 200 -png` then `tesseract --psm 6`. The PDF is kept beside it and is the thing to read before transcribing a figure into a test. |

Two lessons worth carrying, both found here:

1. **A hand-saved ATO page may have no text layer.** Always check that `pdftotext` returned
   body text and not just headers before treating the conversion as done — a 2.5 MB five-page
   PDF that extracts to 30 lines of URLs is an image scan. `tesseract` is installed and
   handles these cleanly at 200 dpi.
2. **Prefer a corroborating second ATO page over a single transcription.** Where a figure has
   to be typed in by hand rather than converted, find a second ATO publication that states it
   and cite both — see [`published-base-guard`]: a rate that reaches a test must come from the
   authority, and one hand-typed number is exactly the failure mode that guard exists for.
