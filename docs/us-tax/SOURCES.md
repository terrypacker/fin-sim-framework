# US tax sources — provenance

Unlike the ATO (see `docs/au-tax/SOURCES.md` — `ato.gov.au` and AustLII return 403 to every
automated fetch), the US primary sources have a scripted route. Both are recorded here so
the next person adding a section does not rediscover them.

| family | filename pattern | route |
|---|---|---|
| **Internal Revenue Code** | `USCODE-<edition>-title26-<subtitle>-<chapter>-<subchapter>-<part>[-<subpart>]-sec<N>.txt` | GPO's govinfo granule: `https://www.govinfo.gov/content/pkg/USCODE-2024-title26/html/<filename>.htm`. The path segments ARE the Code's own hierarchy, so a wrong subpart returns a 302 rather than a 404 — probe if unsure (e.g. §368 is `subchapC-partIII-subpartD`, not `subpartE`). |
| **Treasury regulations** | `CFR-26-<section>-<Title-Case-Name>.txt` | eCFR's renderer: `https://www.ecfr.gov/api/renderer/v1/content/enhanced/current/title-26?chapter=I&subchapter=A&part=1&section=<section>`. Follow redirects (`curl -L`). |
| **IRS publications, forms, rulings** | `IRS-*.txt` | Downloaded as PDF and converted with `pdftotext -layout`, or fetched from `irs.gov` where a text/HTML form exists. |
| **Treaties** | `Treaty-*.txt` | Treasury's published texts. |

Both scripted routes return HTML. Convert by stripping tags and decoding entities —
including the NAMED ones (`&mdash;`, `&ndash;`, `&apos;`, `&sect;`), which a numeric-only
decoder leaves as literal `&mdash;` in the middle of statutory text and which then get
quoted into code comments. Collapse `\n{2,}` to a single newline: `<br/>` followed by a
literal newline in the source produces a blank line between every paragraph otherwise.

**The rule these files exist to serve** is in `CLAUDE.md`'s spirit and stated in
design 94 §8.1: nothing about tax law is quoted from memory. Fetch the primary source into
this directory FIRST, then cite it by path from the code or design doc that relies on it.

## Added 16 Sep 2026 for design 107 (estimated tax)

Three sections outside Subtitle A, added together because the quarterly-payment question
cannot be answered from any one of them alone:

| file | section | why it is here |
|---|---|---|
| `USCODE-2024-title26-subtitleF-chap68-subchapA-partI-sec6654.txt` | **§6654** *Failure by individual to pay estimated income tax* | The safe harbours themselves — `(d)(1)(B)` 90%/100%, `(d)(1)(C)` the 110% uplift above \$150k prior-year AGI, `(c)(2)` the four due dates, `(e)(1)` the \$1,000 de minimis, `(f)` "tax" meaning tax **after** credits, `(g)` withholding deemed paid ratably. |
| `USCODE-2024-title26-subtitleF-chap67-subchapC-sec6621.txt` | **§6621** *Determination of rate of interest* | §6654(a)(1) prices the penalty at "the underpayment rate established under section 6621", which §6621(a)(2) sets at the federal short-term rate + 3 points. Without this the penalty has no number. |
| `USCODE-2024-title26-subtitleC-chap24-sec3405.txt` | **§3405** *Special rules for pensions, annuities, and certain other deferred income* | The withholding-at-source alternative to paying instalments: `(a)` periodic payments withheld as if wages, `(b)(1)` 10% on non-periodic distributions, `(c)(1)(B)` 20% mandatory on eligible rollover distributions. Combined with §6654(g) this is what makes a December distribution able to cure a whole year's underpayment. |

Note the govinfo path segments for §6654 are `subtitleF-chap68-subchapA-partI` — Subtitle F,
not A. The existing table row's warning applies: guessing the wrong segment returns a 302,
not a 404.

## Added 27 Sep 2026 for design 115 (asset-class restrictions — gold in super)

Can a US citizen's AU super hold gold, and what does US law make of the super fund that does?
Eight sections, 2024 edition, same govinfo route. PFIC is Subchapter P Part VI and its
subparts are **A** (§1291), **C** (§1296), **D** (§1297–1298) — guessing `subpartD` for §1291
returns a 302. §6048 is `subtitleF-chap61-subchapA-partIII-subpartB`, not `subpartA`.

| file | section | why it is here |
|---|---|---|
| `USCODE-2024-title26-subtitleA-chap1-subchapB-partII-sec72.txt` | **§72** *Annuities; certain proceeds of endowment and life insurance contracts* | `(t)(1)` the 10% additional tax on the includible part of an early distribution from a qualified retirement plan; `(t)(2)(A)(i)` the age-59½ exception, `(t)(2)(A)(iv)` substantially equal periodic payments. Fetched 25 Nov 2026 for the TIPS-ladder study (account location). |
| `USCODE-2024-title26-subtitleA-chap1-subchapD-partI-subpartA-sec408.txt` | **§408** *Individual retirement accounts* | `(m)(1)` a collectible acquired by an IRA is a deemed distribution; `(m)(2)(C)` "any metal" is a collectible; **`(m)(3)(B)` excepts gold bullion of futures-contract fineness "in the physical possession of a trustee"**. Backs design 61 §12 OQ4a's reversal on stronger ground than the ETF argument alone. |
| `USCODE-2024-title26-subtitleA-chap1-subchapJ-partI-subpartE-sec671.txt` | **§671** *Trust income … attributable to grantors and others as substantial owners* | The grantor-trust rule: where subpart E treats a person as owner, the trust's items are that person's. |
| `USCODE-2024-title26-subtitleA-chap1-subchapJ-partI-subpartE-sec679.txt` | **§679** *Foreign trusts having one or more United States beneficiaries* | `(a)(1)` a US person who transfers property to a foreign trust with a US beneficiary is its owner for that portion, **"other than a trust described in section 6048(a)(3)(B)(ii)"**. |
| `USCODE-2024-title26-subtitleF-chap61-subchapA-partIII-subpartB-sec6048.txt` | **§6048** *Information with respect to certain foreign trusts* | `(a)(3)(B)(ii)` — the carve-out §679 borrows: trusts "described in section 402(b), 404(a)(4), or 404A". Whether super is one of those is the whole question. |
| `USCODE-2024-title26-subtitleA-chap1-subchapP-partVI-subpartA-sec1291.txt` | **§1291** *Interest on tax deferral* | The PFIC excess-distribution regime (ordinary rate + interest charge). |
| `USCODE-2024-title26-subtitleA-chap1-subchapP-partVI-subpartC-sec1296.txt` | **§1296** *Election of mark to market for marketable stock* | The usual escape from §1291. |
| `USCODE-2024-title26-subtitleA-chap1-subchapP-partVI-subpartD-sec1297.txt` | **§1297** *Passive foreign investment company* | `(a)` the 75% income / 50% asset tests; `(b)(1)` passive income = §954(c) FPHC income. |
| `USCODE-2024-title26-subtitleA-chap1-subchapP-partVI-subpartD-sec1298.txt` | **§1298** *Special rules* | `(a)(3)` stock owned by a trust is owned proportionately by its beneficiaries — how a PFIC inside a super fund reaches the member. |

**Not on disk yet:** §954(c) (whether commodity gains are FPHC income — needed before
claiming an AU gold ETF is a PFIC), Reg. §301.7701-3 (default classification of a foreign
unit trust), and Reg. §1.1291/§1.1297. Design 115 flags the PFIC question as open for that reason.

## Added 27 Sep 2026 for design 115 §9 Q2 (PFIC exposure of AU-domiciled funds)

| file | source | why it is here |
|---|---|---|
| `USCODE-2024-title26-subtitleA-chap1-subchapN-partIII-subpartF-sec954.txt` | **§954** *Foreign base company income* | `(c)(1)(C)` commodities gains are FPHC income, so passive under §1297(b)(1). Exceptions: hedging, active business, §988. |
| `USCODE-2024-…-subchapP-partVI-subpartB-sec1293.txt`, `-sec1294`, `-sec1295` | **§§1293–1295** QEF | `1293(a)(1)` ordinary earnings as ordinary income, net capital gain as LTCG; §1295 is the election. |
| `CFR-26-301.7701-2-Business-Entities-Definitions.txt` | **Reg. §301.7701-2** | `(b)(8)(i)` per-se corporations; lists "Australia, Public Limited Company". |
| `CFR-26-301.7701-3-Classification-Of-Certain-Business-Entities.txt` | **Reg. §301.7701-3** | `(b)(2)(i)(B)` a foreign eligible entity is an association (a corporation) if all members have limited liability. |
| `CFR-26-301.7701-4-Trusts.txt` | **Reg. §301.7701-4** | `(c)(1)` an investment trust with a power to vary the investment is NOT a trust; a single-class trust with none is. |
| `IRS-Form-8621-Instructions-2025.txt` | Form 8621 instructions (Rev. December 2025) | Annual PFIC reporting. |

eCFR route for part 301: same renderer as part 1, with `subchapter=F&part=301`.
Form 8621: `https://www.irs.gov/pub/irs-pdf/i8621.pdf` → `pdftotext -layout`.

## Added 10 Nov 2026 — FTC on an Australian exit tax (CGT event I1) and sourcing of a citizen's gain

| file | section | why it is here |
|---|---|---|
| `USCODE-2024-title26-subtitleA-chap1-subchapN-partI-sec865.txt` | **§865** source of income from sales of personal property | (a) seller-residence rule; (g)(1)(A)(i)(I) a citizen with a foreign tax home is a "nonresident"; (g)(2) only if foreign tax of ≥10% of the gain is actually paid; (h) treaty resourcing is for stock of a FOREIGN corporation only. |
| `USCODE-2024-title26-subtitleA-chap1-subchapN-partIII-subpartA-sec905.txt` | **§905** applicable rules (timing of the credit) | Fetched alongside §904; companion to the carryover rule in §904(c). |
| `CFR-26-1.861-20-Allocation-And-Apportionment-Of-Foreign-Income-Taxes.txt` | **Reg. §1.861-20** | (b)(2) "corresponding U.S. item"; (d)(2)(ii)(C) a foreign-law (deemed) disposition with no U.S. recognition is assigned as if sold for U.S. purposes in the year the foreign tax is paid; Example 2. |
| `CFR-26-1.904-6-Allocation-Of-Foreign-Taxes-To-Categories.txt` | **Reg. §1.904-6** | Category assignment layered on §1.861-20; (b)(1) base differences. |
| `CFR-26-1.901-2-Income-War-Profits-Excess-Profits-Tax.txt` | **Reg. §1.901-2** | (a)(1)(iii) treaty coordination; (b)(2)(i)(C) pre-realization timing-difference events are creditable only if no "second tax" later. |

All five by the scripted routes above (govinfo granule; eCFR renderer with `curl -L`), converted by stripping tags + `html.unescape` (named entities included) and collapsing blank lines.
| `Treaty-Australia-Convention-TE-1982-08-06.txt` | **Treasury Technical Explanation of the 1982 Convention** ("an official guide to the Convention") | Art 22(4) + Art 27(1)(c): for a US citizen resident in Australia the US re-sources "enough U.S.-source income as Australian-source income" to credit the Australian tax, floored at the US tax the treaty allows on a source basis. Fetched from `https://www.irs.gov/pub/irs-trty/austtech.pdf` (10 pp, text layer), `pdftotext -layout`. The treas.gov archive copy at UNT returned an HTML shell, not the PDF. |

## Added 11 Nov 2026 — tax year 2027 rates (`us-tax-rates-2027.js`)

| file | source | why it is here |
|---|---|---|
| `IRS-Rev-Proc-2023-34-Inflation-Adjustments-2024.txt` | **Rev. Proc. 2023-34** (2024 inflation adjustments) | §3.27 §199A threshold amounts and phase-in ranges for 2024 (design 134 step 4e). `https://www.irs.gov/pub/irs-drop/rp-23-34.pdf` → `pdftotext -layout`, fetched 19 Nov 2026. |
| `IRS-Rev-Proc-2024-40-Inflation-Adjustments-2025.txt` | **Rev. Proc. 2024-40** (2025 inflation adjustments) | §3.32 the §461(l) excess business loss threshold for 2025: \$313,000 (\$626,000 joint) (design 134 step 4g). `https://www.irs.gov/pub/irs-drop/rp-24-40.pdf` → `pdftotext -layout`, fetched 19 Nov 2026. |
| `IRS-Rev-Proc-2025-32-Inflation-Adjustments-2026.txt` | **Rev. Proc. 2025-32** (2026 inflation adjustments, the first under P.L. 119-21) | §3.26 §199A threshold amounts and phase-in ranges for 2026; §3.31 the §461(l) excess business loss threshold (\$256,000 / \$512,000 joint). The 2026 module's brackets already cited it without the file on disk. `https://www.irs.gov/pub/irs-drop/rp-25-32.pdf` → `pdftotext -layout`, fetched 19 Nov 2026. |
| `IRS-Rev-Proc-2026-35-Inflation-Adjustments-2027.txt` | **Rev. Proc. 2026-35** (IR-2026-133, 5 Nov 2026) | §3.01 Tables 1–5 ordinary brackets; §3.03 maximum zero / 15% rate amounts; §3.15 standard deduction; §3.41 §911 FEIE cap. `https://www.irs.gov/pub/irs-drop/rp-26-35.pdf` → `pdftotext -layout`. |
| `SSA-FR-2026-21796-COLA-Determinations-2027.txt` | SSA, *Cost-of-Living Increase and Other Determinations for 2027*, 91 FR (26 Oct 2026), doc 2026-21796 | The 2027 OASDI contribution and benefit base (\$192,300). ssa.gov returns 403 to scripted fetches (the fact sheet PDF and the COLA page both); the Federal Register copy is the same determination and is scriptable: `https://www.federalregister.gov/api/v1/documents/2026-21796.json` → `raw_text_url`, tags stripped + `html.unescape`. |

## Bracket indexation spreads — calibration (11 Nov 2026)

`DEFAULT_BRACKET_INDEX_SPREADS` in `src/finance/tax/inflation-adjusted-tax-rates.js` was all-zero
(every series tracked the scenario's CPI). It is now measured:

| file | source |
|---|---|
| `BLS-CPI-U-and-C-CPI-U-monthly-1990-2026.csv` | BLS public API v1 (`POST https://api.bls.gov/publicAPI/v1/timeseries/data/`, ≤10 years per request), series `CUUR0000SA0` (CPI-U) and `SUUR0000SA0` (C-CPI-U, from 2000). October 2025 is unpublished (`-`). |
| `SSA-FR-2026-21796-COLA-Determinations-2027.txt` | the 1992 and 2025 national average wage indexes (\$22,935.42, \$72,800.33). |

- **Brackets, LTCG breakpoints, standard deduction, FEIE → −0.0025.** §1(f)(3) and (f)(4)
  (`USCODE-2024-…-sec1.txt`) index to C-CPI-U averaged over the 12 months ending 31 August.
  Over the index years 2002–2025 (Sep–Aug averages, each against the prior year's), C-CPI-U grew
  2.257%/yr against CPI-U's 2.515%: a gap of **−0.258 pp/yr** (−0.301 pp over the last ten),
  negative in 23 of 24 years. The model's inflation stands for CPI-U (`FRED-CPIAUCSL` in
  `docs/economic-shocks/data/`).
- **FICA wage base → +0.010.** §230 of the Social Security Act sets the base from the 1994 base
  times AWI(Y−2)/AWI(1992) (the notice's own computation). AWI 1992→2025 grew 3.562%/yr against
  CPI-U's 2.549% (calendar-year averages, 2025 on 11 months): **+1.01 pp/yr**.
- Not modelled: the round-down to a multiple of \$50 (§1(f)(7)) — about \$25 per threshold.

Check against the first year it could be checked: the 2027 tables (Rev. Proc. 2026-35) rose
3.22–3.25% from 2026; the 2027 FICA base rose 4.23% on an AWI step of 4.23%.

## Added 19 Nov 2026 for design 134 (farm job costing)

A farm operator files a normal Form 1040 with a **Schedule F**. These are the sections that
turn a crop year's job-cost ledger into that schedule and its knock-on effects. They use the
same govinfo and eCFR routes as above. **The Code sections are the 2024 edition, which
predates P.L. 119-21 (4 Jul 2025).** The Act is on disk in full. The farm-relevant amending
sections are listed in the last column, so read each Code file together with its amendment.

| file | section | why it is here |
|---|---|---|
| `USCODE-2024-…-subchapB-partVI-sec172.txt` | **§172** *Net operating loss deduction* | `(b)(1)(B)` a **farming loss** carries back 2 years. |
| `USCODE-2024-…-subchapB-partVI-sec175.txt` | **§175** *Soil and water conservation expenditures* | Expensing instead of capitalizing (Schedule F line 12). |
| `USCODE-2024-…-subchapB-partVI-sec179.txt` | **§179** *Election to expense certain depreciable business assets* | Machinery. **P.L. 119-21 §70306** raises the limits in `(b)(1)` and `(b)(2)` (\$2,500,000 / \$4,000,000). |
| `USCODE-2024-…-subchapB-partVI-sec180.txt` | **§180** *Expenditures by farmers for fertilizer, etc.* | Fertilizer and lime are deductible in the year paid (Schedule F line 17). |
| `USCODE-2024-…-subchapB-partVI-sec199A.txt` | **§199A** *Qualified business income* | The QBI deduction on farm net income. `(g)` covers patrons of agricultural cooperatives (grain sold to a co-op). **P.L. 119-21 §70105** extends and amends it. |
| `USCODE-2024-…-subchapE-partII-subpartB-sec451.txt` | **§451** *General rule for taxable year of inclusion* | `(f)` a cash-method farmer may **defer crop insurance and disaster proceeds to the following year**. |
| `USCODE-2024-…-subchapE-partII-subpartC-sec461.txt` | **§461** *General rule for taxable year of deduction* | `(l)` the **excess business loss** limit for noncorporate taxpayers. **P.L. 119-21 §70601** makes it permanent. |
| `USCODE-2024-…-subchapE-partII-subpartC-sec464.txt` | **§464** *Limitations on deductions for certain farming expenses* | `(d)` the **prepaid farm supplies** rule: prepaying more than 50% of the other deductible farming expenses defers the excess, with exceptions. This bounds the December input prepay. |
| `USCODE-2024-…-subchapQ-partI-sec1301.txt` | **§1301** *Averaging of farm income* | Schedule J: elected farm income is taxed at the 3 prior years' rates, one-third each. |
| `USCODE-2024-title26-subtitleA-chap2-sec1401.txt`, `…-sec1402.txt` | **§1401–1402** *Self-employment tax* | SECA on Schedule F net (design 69 models it already). §1402(a)(1) covers crop-share rentals and material participation. |
| `CFR-26-1.61-4-Gross-Income-Of-Farmers.txt` | Reg. §1.61-4 | What is farm gross income under the cash and accrual methods. |
| `CFR-26-1.162-12-Expenses-Of-Farmers.txt` | Reg. §1.162-12 | What is deductible, the crop method, and when seed is expensed. |
| `CFR-26-1.451-6-Election-To-Include-Crop-Insurance-Proceeds-Following-Year.txt` | Reg. §1.451-6 | The §451(f) deferral election, and its "normal business practice" test. |
| `IRS-Pub-225-Farmers-Tax-Guide-2025.txt` | Pub. 225 (2025) | The IRS's farm guide. Covers all of the above in one place. |
| `IRS-Schedule-F-Form-2025.txt`, `IRS-Schedule-F-Instructions-2025.txt` | Schedule F (2025) | **The expense categories the cash report must produce**: lines 10–32. |
| `IRS-Schedule-SE-Instructions-2026.txt` | Schedule SE (2026) | The farm optional method. |
| `IRS-Schedule-J-Instructions-2025.txt` | Schedule J (2025) | Income averaging worksheet. |
| `IRS-Pub-946-How-To-Depreciate-Property-2025.txt` | Pub. 946 (2025) | MACRS classes for farm machinery and buildings. |
| `IRS-Form-8995-Instructions-2025.txt` | Form 8995 (2025) | The QBI computation, as filed. |
| `PLAW-119-21-Reconciliation-Act-2025-07-04.txt` | **P.L. 119-21** (enacted 4 Jul 2025) | Farm-relevant sections: **§10301** (reference prices, effective reference price 88%), **§10304** (PLC through 2031), **§10305** (ARC through 2031, 90% guarantee), **§10501** (beginning farmers), **§10502** (crop insurance coverage levels), **§70105** (§199A), **§70301** (§168(k) full expensing made permanent), **§70306** (§179 limits), **§70437** (gain on sale of qualified farmland), **§70601** (§461(l) permanent). |
