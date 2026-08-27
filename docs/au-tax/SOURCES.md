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
