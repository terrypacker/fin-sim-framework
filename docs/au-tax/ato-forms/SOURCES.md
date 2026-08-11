# ATO forms and worksheets — provenance

Source material for the AU capital-gains reporting work (design 76 / 90). Text only:
the PDFs are not kept, only what was extracted from them.

`ato.gov.au` returns 403 to every automated fetch, so these arrived by three different
routes — and the route determines how much you can trust the text.

## Extracted text layer (verbatim, trustworthy)

Converted with `pdftotext -layout`. The words are the ATO's; only the column
alignment is approximate.

| File | Source |
|---|---|
| `capital-gain-or-loss-worksheet-2026-NAT4151.txt` | **NAT 4151 (06.2026)** *Capital gain or capital loss worksheet* — the per-CGT-event form. Cost-base element grid → cost base unindexed / reduced cost base / cost base indexed, then FOUR parallel calculations: capital gain by indexation method, by discount method, by 'other' method, and **capital loss = reduced cost base − capital proceeds**. Downloaded by hand (`ato.gov.au` blocks scripted fetches). |
| `cgt-summary-worksheet-2025-form.txt` | *CGT summary worksheet for tax returns 2025* — the footing form, parts 1–9 / tables 1–9. FY2024-25 edition, see the note below on why it stands in for 2026. Pulled from `caat-p-001.sitecorecontenthub.cloud`, which serves the same content GUIDs as the blocked `ato.gov.au/api/public/content/...` paths. |
| `completing-capital-gains-section-of-return.txt` | *Guide to capital gains tax 2006*, Parts B and C. **Structurally superseded** — the summary worksheet was since reorganised from Parts A–I into tables 1–9 — but kept because it is the only full prose walkthrough of the worksheet we have. Do not infer the current layout from it. |

## OCR (approximate — do not quote as verbatim)

Browser print-to-PDF captures of ATO pages that render as images, so `pdftotext`
recovered only the page furniture. Re-rendered at 200dpi and run through
`tesseract 5.5.3 --psm 6`. Page boundaries are marked `===== p-NN =====`.

Expect OCR damage: letter labels are the thing most at risk (`c` for `C`, `I`/`l`,
`0`/`O`), and the ATO's bullet glyphs come through as `e` or `¢`. Verify any label
letter against a second occurrence before wiring it into code.

| File | Source |
|---|---|
| `item-18-capital-gains-2026.txt` | *18 Capital gains 2026*, individual supplementary return instructions. The authority for the current label set (G, H, A, V, M) and the individual's steps 1–11. |
| `capital-gain-or-loss-worksheet-2026-landing-page.txt` | Landing page only — guidance on choosing between methods and on splitting share parcels. The form itself is the NAT 4151 file above. |
| `cgt-summary-worksheet-2026-landing-page.txt` | Landing page only. Note its download link points at NAT 4151, the *per-event* worksheet — an ATO linking error, not the summary worksheet. |

## Why the summary worksheet is the 2025 edition

The FY2025-26 edition is only served from a blocked path. The 2024 and 2025 editions
were diffed against each other: every cell label, table and part is identical, and the
only changes are wording ("three" → "3", "do not" → "don't"). The 2026 landing page
independently states "All entities should complete **tables 1 to 8** of this worksheet",
matching. So the structure is safe to build against; only the year strings differ.

## Statute

The Act is the authority for the ordering, not these forms. See
`../ITAA-1997/C2026C00324VOL03.txt` — s102-5 (the net-capital-gain method statement:
current-year losses, then prior-year net capital losses, then the discount at Step 5),
s102-10(2) (a net capital loss cannot be deducted from assessable income) and s102-15.

Reproduced under the ATO's copyright notice, which permits copying, adaptation and
redistribution provided it does not suggest ATO or Commonwealth endorsement.
