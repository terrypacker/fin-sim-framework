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
