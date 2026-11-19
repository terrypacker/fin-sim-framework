# US farm program sources — provenance

Added 19 Nov 2026 for design 134 (farm job costing). These are USDA program rules (FSA
commodity programs and FCIC crop insurance), not tax law. They decide what a government
payment or an insurance indemnity is for a given crop year, so a field's revenue can be
computed. The tax treatment of those receipts is in `docs/us-tax/` (`§451(f)`,
`Reg. §1.451-6`, Schedule F lines 4–6).

The rule is the same as for tax: nothing about these programs is modelled from memory.
Fetch the primary source here first, then cite it by path.

## Routes

| family | route |
|---|---|
| **7 U.S.C.** | govinfo link service: `https://www.govinfo.gov/link/uscode/7/<section>?link-type=html` redirects to the granule. Title 7 chapter 115 (the Agricultural Act of 2014), **not** chapter 113: guessing the path returns a 200 "Page Not Found" body of a fixed size, not a 404. |
| **7 CFR (live)** | eCFR renderer: `https://www.ecfr.gov/api/renderer/v1/content/enhanced/current/title-7?part=<part>`. The versioner API needs `--compressed`, and returned 503 ("queue full") under load on 19 Nov 2026. |
| **7 CFR (annual edition)** | govinfo: `https://www.govinfo.gov/content/pkg/CFR-<year>-title7-vol6/xml/CFR-<year>-title7-vol6-sec457-<N>.xml`. Volume 6 holds parts 400–699. The wrong volume returns a 200 HTML page, not a 404. Check the body for `<CFRGRANULE>`. |

## Files

| file | what it is | why it is here |
|---|---|---|
| `USCODE-2024-title7-chap115-subchapI-sec9011.txt` | **7 U.S.C. §9011** (Agricultural Act of 2014 §1111), *Definitions* | Reference price (19), effective reference price (8), base acres, payment yield. **Amended by P.L. 119-21 §10301**: reference prices replaced, and the effective-reference-price factor raised from 85 to 88 beginning with crop year 2025. This 2024 edition is pre-amendment. Read it with `docs/us-tax/PLAW-119-21-Reconciliation-Act-2025-07-04.txt`. |
| `…-sec9012.txt` | §9012, *Base acres* | Base acres per FSA farm, the unit a PLC or ARC payment is computed on. |
| `…-sec9013.txt` | §9013, *Payment yields* | The PLC payment yield per farm. |
| `…-sec9014.txt` | §9014, *Payment acres* | The share of base acres that is paid. |
| `…-sec9015.txt` | §9015, *Election* | Choosing PLC or ARC per farm. |
| `…-sec9016.txt` | §9016, *Price loss coverage* | The PLC payment rate and amount. **P.L. 119-21 §10304** extends it through crop year 2031. |
| `…-sec9017.txt` | §9017, *Agriculture risk coverage* | ARC-CO benchmark revenue and guarantee. **P.L. 119-21 §10305** sets the guarantee at 90% of benchmark revenue for crop years 2025–2031. |
| `CFR-7-1412-Agriculture-Risk-Coverage-And-Price-Loss-Coverage.txt` | **7 CFR part 1412**, live eCFR, fetched 19 Nov 2026 | FSA's implementing rules for both programs. Check its amendment notes against P.L. 119-21 before relying on any figure. |
| `CFR-7-457.8-Common-Crop-Insurance-Policy-Basic-Provisions-2026-01-01.txt` | **7 CFR §457.8**, annual edition as of 1 Jan 2026 | The Basic Provisions: revenue protection vs yield protection, **projected price** and **harvest price**, the harvest price exclusion, the guarantee and indemnity. |
| `CFR-7-457.113-Coarse-Grains-Crop-Provisions-2026-01-01.txt` | **7 CFR §457.113**, annual edition as of 1 Jan 2026 | The Coarse Grains Crop Provisions, which insure corn and soybeans. |

## Gaps

- **7 CFR parts 413–459 show as "[Reserved]" in the live eCFR** (structure dated
  17 Nov 2026), so part 457 is no longer in the current CFR. The two §457 files above are
  from the 1 Jan 2026 annual edition. Before phase 3 models crop insurance, find out why the
  part was removed (a Federal Register final rule, presumably), and where the policy text now
  lives (RMA's own policy publications).
- **The Commodity Exchange Price Provisions** (CEPP) define the exact projected-price and
  harvest-price discovery for corn and soybeans. CEPP is an RMA document, not part of the
  CFR. Not on disk.
- **County data**: ARC-CO benchmark yields, RMA T-yields and premium rates are published as
  data sets, not text. Not on disk, and needed only in phase 3.
