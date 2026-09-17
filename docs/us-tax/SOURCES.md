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
