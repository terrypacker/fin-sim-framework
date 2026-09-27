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
