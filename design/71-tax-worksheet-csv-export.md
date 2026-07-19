# 71 — Tax worksheet CSV export (validate the tax framework by hand)

**Status: COMPLETE** — every phase IMPLEMENTED: 1–4 (US, §7), 5 (AU resident + non-resident, §8,
§12), 6 (cross-border relief worksheet, §13), 7–9 (in-app CSV button, one Tax Doc link per
settlement, US **state** returns, §11).

Try it: `npm run export:tax -- --reference --check > tax.csv`

The tax engine's output is currently only auditable through the **tax document popup** — one
country, one year, one modal at a time, with no way to check the arithmetic underneath a line.
This design adds a **flat CSV export of the tax worksheet**: one row per tax-form line item, plus
one row per **marginal bracket band**, for every settled tax year in a run. The CSV is the manual
validation instrument — you open it in a spreadsheet, pivot by year, and confirm that the bands sum
to the line and the lines sum to the liability.

**Builds on / relates to:**
- **`design/16` (journal reporting plugin)** — the existing `ReportDefinition` registry is an
  *aggregate* engine (group journal rows, sum a field). This worksheet is **not** one of those
  (§4.3); it is a projection of a single journal entry's payload. The two are complementary: the
  CSV carries each line's `drillReport` id, naming the aggregate report that explains it.
- **`design/52` (cross-border relief)** — the FEIE stacking rule and the per-§904-basket FTC are the
  hardest numbers in the engine to verify by hand; §3.2 exposes the FEIE stack as its own band set.
- **`design/69` (self-employment income)** — added SECA to `computeTax` but never to the 1040
  document, so the popup's lines do not foot to Gross Tax for a self-employed person (§2.2). Fixed
  as Phase 3 here.
- **`design/57` (AU CGT reform)** and **`design/34` (US state income tax)** — see §8 and §9.

---

## 1. Goals & Non-Goals

### Goals
- A **flat, pivot-friendly CSV** with one row per tax-form line item and one row per marginal
  bracket band, covering **every settled tax year** in a run (not one year at a time).
- **Tie-out by construction**: the CSV is generated from the same `TaxDocument` the popup renders,
  via the same `TaxDocumentRegistry`. If they disagree, that is a bug, not a modelling choice.
- **Bracket-level transparency**: for each bracketed tax, show `rate`, band bounds, the income
  falling in the band, and the tax from that band — so `SUMIF(parentLine, bracketTax)` reproduces
  the line total.
- **Headless first**: a script that runs a scenario JSON and writes the CSV, usable without the UI.
- **One column set for US and AU** (§8), so a spreadsheet built against the US export keeps working
  when AU rows arrive.

### Non-Goals
- Changing any tax computation. Phase 1 is a pure refactor + additive payload; the reference golden
  must not move.
- A new UI report surface. The CSV is an export, not a panel (§4.3). (A CSV *button* on the existing
  tax-document modal was added later — §11.1.)
- Round-tripping: the CSV is an output artifact, never an input.

---

## 2. Current state

### 2.1 The tax document is already a pure projection

`US_TAX_SETTLE_APPLY` journal entries carry `action.data.taxDetail` — the entire
`TaxComputationResult` returned by `UsTaxRatesBase.computeTax`
(`src/finance/tax/us/us-tax-rates-base.js:203`). `TaxDocumentRegistry.generate(entry, journal)`
(`src/finance/tax/tax-document-registry.js:60`) resolves the year-matched module and
`UsTaxDocument2026._generateForm1040` (`src/finance/tax/us/us-tax-document-2026.js:40`) turns it into
`{ sections: [{ heading, lineItems: [{ label, amount, drillReport }] }], summary }`.

**Consequence: the CSV needs no new computation.** Replaying the document module over each settle
entry and flattening the result yields a worksheet that agrees with the popup by construction. This
is the single most important property of the design — a validation instrument that recomputes its
own subject validates nothing.

### 2.2 Two defects the export would otherwise inherit

`computeTax` returns `selfEmploymentTax`, `selfEmploymentTaxDeduction` and
`additionalMedicareTax`, folds all three into `grossTax`/`netLiability`, and lists them in
`taxDetail.lineItems` (`us-tax-rates-base.js:236-269`). But `us-tax-document-2026.js` never added
them to its `sections`. So for a self-employed person:

1. The **Tax Computation** section omits SECA and the Additional Medicare surtax, yet the `Gross
   Tax` line includes both — **the visible lines do not sum to the stated total**.
2. The **Income** section omits the `½ Self-Employment Tax Deduction`, so `Adjusted Gross Income`
   appears not to follow from the two lines above it.

Both are display-only (no computed value is wrong), but a worksheet whose columns do not foot is
worse than no worksheet. Fixed in Phase 3.

### 2.3 The bracket breakdown does not exist

`_applyBrackets(income, brackets)` accumulates a scalar and discards the per-band detail
(`us-tax-rates-base.js:403`). It is **copy-pasted three times** — identical bodies in
`us-tax-rates-base.js:403`, `au/au-tax-rates-base.js:329`, and
`state/base-state-tax-rates-module.js:124` — as is its sibling `_marginalBracketRate`. This is the
only real engine change the design needs, and the triplication makes extraction the natural move.

---

## 3. Phase 1 — a shared, detail-returning bracket helper

New `src/finance/tax/bracket-schedule.js`, consumed by all three rate bases:

```js
/**
 * Apply marginal brackets, returning both the total and the per-band detail.
 * brackets: [[lowerThreshold, rate], ...] ascending. `upper` is null on the top band.
 *
 * @returns {{ tax: number, bands: Array<{ lower, upper, rate, income, tax }> }}
 */
export function applyBracketsDetailed(income, brackets)

/** Scalar-only wrapper — the existing behavior, byte-identical. */
export function applyBrackets(income, brackets)

/** Unchanged, lifted from the three copies. */
export function marginalBracketRate(income, brackets)

/**
 * Band-wise difference of two schedules, for stacked/differential taxes:
 * bands(a) − bands(b), matched by band index. Used for LTCG stacking (§3.1) and
 * the FEIE stacking rule (§3.2). Both operands come from the same bracket table,
 * so index alignment is exact.
 */
export function subtractBands(aBands, bBands)
```

Every band is emitted, **including zero-income bands**. A band with `income: 0` is evidence the
taxpayer did not reach that bracket, which is exactly what a validator wants to confirm; and a
constant row count per year keeps the CSV rectangular for pivoting.

### 3.1 US ordinary and LTCG schedules

The LTCG tax is a **differential** — §1(h) stacks gains on top of taxable ordinary income, so the
tax is `brackets(ordinary + cg) − brackets(ordinary)` (`us-tax-rates-base.js:146`). The band-wise
difference makes visible *which* LTCG band the gain landed in given the ordinary income underneath
it — the part that is hardest to check by hand and the most common source of "why is my capital
gains tax not 15% of the gain?" confusion.

### 3.2 FEIE stacking

`ordinaryTax = brackets(taxableOrdinary) − brackets(excludedStacked)` (`us-tax-rates-base.js:137`).
The reported `ordinary` band set is the **difference** (what was actually paid, band by band), and
the subtracted stack is reported separately as `feieStacked` so the IRS Foreign Earned Income Tax
Worksheet can be replicated line for line. Both sets are emitted only in the country/year rows where
`feieExcluded > 0`.

### 3.3 The additive payload

`computeTax` gains one field; nothing existing changes shape:

```js
brackets: {
  table:        'MFJ' | 'Single',        // which bracket table was applied
  ordinary:     [ …bands ],              // net of the FEIE stack
  feieStacked:  [ …bands ] | null,       // the subtracted stack, when FEIE elected
  ltcg:         [ …bands ],              // differential bands
  collectibles: { rate: 0.28, income, tax },
  niit:         { rate, threshold, netInvestmentIncome, magi, base, tax },
  seca:         { … } | null,            // design 69 components, when SE income exists
}
```

**Cost**: ~15 small objects per country per settled year, inside `action.data.taxDetail`, which is
already the largest payload in the journal. Negligible against the journal as a whole. The values
are derived from numbers the engine already computes, so the **reference golden must not move** —
that is the Phase 1 acceptance test.

---

## 4. Phase 2 — the flattener

New `src/finance/tax/tax-worksheet-export.js` — pure, no DOM, no workbench:

```js
/**
 * Walk the journal's <cc>_TAX_SETTLE_APPLY entries, generate each year's
 * TaxDocument(s) via JournalReportingService, and flatten to worksheet rows.
 *
 * @param {object[]} journal
 * @param {{ cc?: 'US'|'AU', years?: number[]|null, includeSchedules?: boolean }} opts
 * @returns {WorksheetRow[]}
 */
export function buildTaxWorksheetRows(journal, opts)

/** RFC 4180 CSV. Column order is the contract in §5. */
export function toCsv(rows)
```

Because it goes through `JournalReportingService.generate(entry, journal)`, Schedule D comes along
for free as an additional `form` value, gated behind `includeSchedules`. Table-shaped forms are a
different matter — see §5.4.

### 4.0 Where the bands attach — the country-agnostic seam

The flattener must place each bracket schedule under the line it explains, but a `TaxDocument`'s
line items carry only `{ label, amount, drillReport }` — matching band sets to lines by label string
would put a fragile, US-specific mapping table inside the generic flattener.

Instead the **country document module** — which already knows that `taxDetail.brackets.ordinary`
belongs to its "Tax on Ordinary Income" line — attaches two optional fields to the line item:

```js
{ label, amount, drillReport,
  bands,   // Array<{ lower, upper, rate, income, tax }> — a marginal schedule
  flat }   // { rate, income, tax, … } — a flat-rate tax stated on the line itself
```

The flattener reads only those two generic fields. `TaxDocumentModal` renders `label`/`amount`/
`drillReport`/`sub` and ignores unknown properties, so this is invisible to the UI. This is what
makes §8's promise real: **the AU worksheet needs no flattener change**, only the same two fields
attached in the AU document module.

### 4.0.1 Collapsing the settle fan-out

One settle **action** is journaled once per **reducer** that processes it. The US settle produces
*two* entries — `US Tax Settle Apply` and `Accumulate Taxes Paid` — sharing one `action.instanceId`
and carrying the same `taxDetail`. Rendering both duplicates every line of every year, so the
flattener dedupes on `instanceId`, the same fan-out collapse the aggregate reports perform via
`dedupeBy` (`CapitalGainsByDisposalDef`).

**The first entry of a pair must win**, and not merely for tie-breaking:
`TaxDocumentRegistry._extractPeriod` derives each line's drill-down period by scanning *backwards*
for the previous `TAX_SETTLE_APPLY`. From the second entry of a pair, that scan finds its own twin,
yielding a degenerate period bounded by the same settle instead of by the prior tax year — so the
second entry's `drillReport` params are wrong.

### 4.1 Line numbering

`line` is a **positional index within the document**, assigned 1..N as sections and their
`lineItems` are walked in order. It is *not* the real IRS/ATO line number — the document modules
carry labels, not statutory line numbers, and inventing a mapping would be a second source of truth
that drifts. `line` exists to give `BRACKET` rows a stable `parentLine` to point at and to preserve
document order after a spreadsheet sort. Conditional lines (FEIE, NIIT) shift the numbering between
years; `label` is the stable cross-year key, and §5.2 keeps all lines present to limit the shifting.

### 4.2 Rounding and precision

`buildTaxWorksheetRows` returns **raw floats**; all rounding is display-only and applied by `toCsv`,
so a programmatic consumer keeps full precision. The engine does not round to whole dollars (real
1040s do), and forcing whole dollars would manufacture disagreement between the CSV and the popup.

| Kind | Columns | Format |
|---|---|---|
| Money | `amount` (on `LINE`), `bracketIncome`, `bracketTax`, `bracketLower`, `bracketUpper` | 2 dp |
| Rate  | `bracketRate`, `amount` (on `RATE`) | 5 dp |

Two consequences worth stating, because both differ from the §6 mock-up:

- **Rates are uniformly 5 dp** (`0.10000`, not `0.10`). One rule for the column beats matching a
  handwritten example that was internally inconsistent (`0.10` beside `0.038`).
- **Bracket edges are money, not bare integers.** Once inflation-indexing is applied they are not
  round numbers — the 2032 MFJ 12% band starts at `28478.147272216655` — so they are formatted like
  every other dollar column rather than dumped raw.

The `amount` column is polymorphic (money on `LINE`, a ratio on `RATE`), so the formatter consults
`rowType`, not just the column name.

### 4.3 Why not a `ReportDefinition`

The `ReportDefinitionRegistry` (`src/finance/journal-reporting/report-definition-registry.js`) is an
aggregate engine: `buildQuery` produces a filter AST, the query API groups matching journal rows by a
field and folds aggregates over them. A tax worksheet has **no group-by, no aggregation, and its
rows are not journal rows** — it is a fixed, ordered projection of one entry's payload. Implementing
it as a `ReportDefinition` would mean bypassing `buildQuery`/`aggregate` entirely and inheriting an
interface it does not satisfy.

The existing drill-down definitions (`ordinary-income-by-source`, `capital-gains-by-disposal`,
`pretax-adjustments-by-source`) are the correct use of that engine, and are what the **follow-up
per-line drill-down reports** will extend. The worksheet CSV keeps each line's `drillReport` id in a
column, so it names the aggregate report that explains it — the two surfaces stay connected without
being forced into one abstraction.

---

## 5. The CSV format

### 5.1 Columns

| # | Column | Applies to | Notes |
|---|---|---|---|
| 1 | `taxYear` | all | US calendar year; AU **financial-year start** (§8.1) |
| 2 | `country` | all | `US` / `AU` |
| 3 | `form` | all | `Form 1040`, `Schedule D`, `Form 8949`, `AU ITR`, `CGT Schedule` |
| 4 | `section` | all | document section heading (`Income`, `Tax Computation`, `Credits`, `Summary`) |
| 5 | `line` | all | positional index within the document (§4.1) |
| 6 | `label` | all | the line item's label — the stable cross-year key |
| 7 | `rowType` | all | `LINE` \| `SUBLINE` \| `BRACKET` \| `RATE` (§5.2) |
| 8 | `amount` | `LINE`, `RATE` | signed, native currency, 2dp; empty on `BRACKET` |
| 9 | `bracketRate` | `BRACKET`, flat-rate `LINE` | e.g. `0.22000` (5 dp, §4.2); also set on NIIT/collectibles lines |
| 10 | `bracketLower` | `BRACKET` | band lower threshold; money-formatted (inflation-indexed edges are not round) |
| 11 | `bracketUpper` | `BRACKET` | band upper threshold; **empty on the top band** |
| 12 | `bracketIncome` | `BRACKET`, flat-rate `LINE` | income falling in the band |
| 13 | `bracketTax` | `BRACKET`, flat-rate `LINE` | tax from the band |
| 14 | `parentLine` | `BRACKET` | the `line` this band belongs to |
| 15 | `drillReport` | `LINE` | journal report id explaining this line, when one exists |
| 16 | `personKey` | all | empty for household-level filings; set for AU per-person (§8.2) |
| 17 | `currency` | all | `USD` / `AUD` — the document's **native** currency (§5.3) |

Columns 1–15 are the format confirmed against `scenarios/example-tax-report.csv`. Columns 16–17 are
**appended**, never inserted: a spreadsheet built against the 15-column US export keeps working, and
adding them now (rather than when AU lands) avoids invalidating saved pivots later.

### 5.2 Row conventions

- **Long format, one file.** `rowType` + `parentLine` let a pivot table nest bands under their line;
  `SUMIF(parentLine = 8, bracketTax)` must equal line 8's `amount`. That check *is* the validation.
- **Multi-year by default.** Every settled year in one file, so `taxYear` is the pivot's row field.
  Single-year is a `--year` filter, not a different format.
- **Empty cells, not zeros**, for inapplicable columns — so spreadsheet `AVERAGE`/`COUNT` are not
  polluted by structural blanks.
- **Zero-valued `LINE` rows are kept**, unlike the popup, which hides NIIT/FEIE when zero. A stable
  column *and row* set matters more than compactness when diffing years side by side.
- **Flat-rate lines carry their own band inline** (NIIT, collectibles) rather than emitting a
  one-band `BRACKET` row — there is no schedule to break out, and `rate × income = tax` on one row.
- **`SUBLINE` rows are components of the line above them**, not additional lines — the SECA
  Social-Security/Medicare split, and (when AU lands) the ordinary-vs-CGT split of "Tax on Income".
  They are to a compound tax what bracket bands are to a bracketed one: the breakdown that makes the
  total checkable. Giving them their own `rowType` rather than a `LINE` keeps them out of every
  footing sum automatically, since those filter `rowType = 'LINE'`.
- **`RATE` rows** carry a ratio in `amount` (effective/marginal rate), so a consumer summing the
  `amount` column must filter `rowType = 'LINE'`. This is deliberate: rates belong with the
  worksheet, but must not be mistaken for money.

### 5.3 Currency

Amounts are in the document's **native** currency — USD for the 1040, AUD for the AU ITR — never
converted to a display currency. The display-currency conversion in `TaxDocumentModal._fmtAmt`
(design 10 Phase 4) is a presentation concern; a validation export must show the numbers the
engine actually computed, in the units the statute is written in. The `currency` column states which.
Cross-border relief lines (FTC, FITO) are already normalized into the filing country's currency by
the engine, so they need no special handling here.

### 5.4 Table-shaped forms are excluded

`TaxDocumentRegistry` produces two document shapes. **Sections-shaped** documents (Form 1040,
Schedule D, the AU ITR) are worksheets of labelled amounts and flatten cleanly. **Table-shaped**
documents (Form 8949, the AU CGT Schedule) are *disposal registers*: `{ columns, rows, totals }`
over Description / Date Acquired / Date Sold / Proceeds / Cost Basis / Gain.

Those columns have no home in §5.1. Representing them would mean overloading `bracketIncome` and
`bracketTax` with "proceeds" and "cost basis" — reusing columns for unrelated meanings in the same
file, which would break every formula written against the format. So table-shaped documents are
**skipped**, even under `includeSchedules`; only Schedule D comes through.

A disposal register is a genuinely different report with its own natural columns, and it is the
obvious next export after this one (it would be the drill-down behind the "Long-Term Capital Gains"
line). It is deferred rather than mangled.

---

## 6. Example (US)

Reference artifact: **`scenarios/example-tax-report.csv`** (columns 1–15 as saved; `personKey` and
`currency` per §5.1 append to each row as empty/`USD`).

Scenario: MFJ, 2025 bracket table. Ordinary income $300,000; $23,000 pre-tax 401(k); $40,000 LTCG;
$8,000 interest and dividends; no foreign activity.

| line | label | rowType | amount | rate | lower | upper | bracketIncome | bracketTax |
|---:|---|---|---:|---:|---:|---:|---:|---:|
| 1 | Gross Ordinary Income | LINE | 300,000.00 | | | | | |
| 2 | Adjustments (Pre-tax Contributions) | LINE | (23,000.00) | | | | | |
| 3 | Adjusted Gross Income | LINE | 277,000.00 | | | | | |
| 4 | Standard Deduction | LINE | (30,000.00) | | | | | |
| 5 | Taxable Ordinary Income | LINE | 247,000.00 | | | | | |
| 6 | Long-Term Capital Gains (Sch. D) | LINE | 40,000.00 | | | | | |
| 7 | Collectible Gains | LINE | 0.00 | | | | | |
| 8 | Tax on Ordinary Income | LINE | **44,974.00** | | | | | |
| 8 | ↳ band | BRACKET | | 0.10 | 0 | 23,850 | 23,850.00 | 2,385.00 |
| 8 | ↳ band | BRACKET | | 0.12 | 23,850 | 96,950 | 73,100.00 | 8,772.00 |
| 8 | ↳ band | BRACKET | | 0.22 | 96,950 | 206,700 | 109,750.00 | 24,145.00 |
| 8 | ↳ band | BRACKET | | 0.24 | 206,700 | 394,600 | 40,300.00 | 9,672.00 |
| 8 | ↳ band | BRACKET | | 0.32 | 394,600 | 501,050 | 0.00 | 0.00 |
| 9 | Long-Term Capital Gains Tax | LINE | **6,000.00** | | | | | |
| 9 | ↳ band | BRACKET | | 0.00 | 0 | 96,700 | 0.00 | 0.00 |
| 9 | ↳ band | BRACKET | | 0.15 | 96,700 | 600,050 | 40,000.00 | 6,000.00 |
| 9 | ↳ band | BRACKET | | 0.20 | 600,050 | | 0.00 | 0.00 |
| 10 | Collectibles Tax (28%) | LINE | 0.00 | | | | | |
| 11 | Early Withdrawal Penalties | LINE | 0.00 | | | | | |
| 12 | Net Investment Income Tax (Form 8960) | LINE | 1,824.00 | 0.038 | | | 48,000.00 | 1,824.00 |
| 13 | Gross Tax | LINE | **52,798.00** | | | | | |
| 14 | Foreign Tax Credit | LINE | 0.00 | | | | | |
| 15 | Net Tax Liability | LINE | **52,798.00** | | | | | |
| 16 | Effective Rate | RATE | 0.15529 | | | | | |
| 17 | Marginal Rate | RATE | 0.24000 | | | | | |

The three checks this makes possible, all one spreadsheet formula each:

1. `Σ bracketTax where parentLine = 8` = 44,974.00 = line 8.
2. `Σ bracketIncome where parentLine = 8` = 247,000.00 = line 5.
3. Lines 8 + 9 + 10 + 11 + 12 = 52,798.00 = line 13, and line 13 − line 14 = line 15.

Note how check 2 falls out of the LTCG differential too: `Σ bracketIncome where parentLine = 9` =
40,000.00 = line 6, confirming the whole gain landed in the 15% band given $247,000 of ordinary
income beneath it.

---

## 7. Phases (US)

| # | Phase | Deliverable | Acceptance |
|---|---|---|---|
| 1 | **DONE** — Shared bracket helper | `bracket-schedule.js`; US/AU/state rate bases consume it; `taxDetail.brackets` added (§3.3) | Golden unmoved **to the last digit** (`1127908.6841529403` / `11584190.25`); `bracket-schedule.test.mjs` BS-1…BS-12 |
| 2 | **DONE** — Flattener | `tax-worksheet-export.js` — `buildTaxWorksheetRows` + `toCsv` (§4); `bands`/`flat` attached in the 1040 module (§4.0) | `tax-worksheet-export.test.mjs` TWE-1…TWE-15, incl. tie-out against a real 7-year run and CSV-vs-popup line-for-line |
| 3 | **DONE** — 1040 document fixes | SECA (+ SS/Medicare `sub` rows), Additional Medicare, ½ SE deduction added to `us-tax-document-2026.js` (§2.2); FEIE line switched to the new `feieApplied` (§7.1) | `us-1040-document-footing.test.mjs` F1040-1…F1040-6 — footing asserted directly, so the document cannot silently drift from the engine again |
| 4 | **DONE** — Headless script | `scripts/export-tax-csv.mjs`, `npm run export:tax`; `--reference` runs the built-in scenario with zero setup; `--check` runs `verifyWorksheetRows` | Reference run exports 422 rows over 15 tax years, 30 bracket schedules, all §6 checks passing |

### 7.2 The §6 checks are executable, not just documented

The three footing checks are implemented as `verifyWorksheetRows(rows)` in the export module (not in
the script), so they are unit-testable and reusable by a future UI "check" button. `--check` runs
them and exits non-zero on any violation.

They deliberately run over the **exported rows**, not over the engine: that validates the artifact
the user actually reads, catching flattening bugs (a mis-parented band, a dropped line) as well as
engine ones. TWE-17/18 corrupt a band, a total, and a whole line in turn and assert each check
fires — a verifier that only ever passes would be worthless.

### 7.1 The FEIE line disagrees between the two line sets

Found while building Phase 2. There are two parallel line lists for a US return, and they state the
exclusion differently:

- `taxDetail.lineItems` (`us-tax-rates-base.js`) reports **`-excludedStacked`** — the exclusion
  actually applied, capped at taxable ordinary income.
- `us-tax-document-2026.js` reports **`-feieExcluded`** — the uncapped qualifying amount.

They diverge whenever the exclusion exceeds taxable ordinary income, and there the document's figure
overstates the relief actually taken, so the Income section stops footing to Taxable Ordinary Income.
The document should report `-excludedStacked` (with the uncapped figure available as the FEIE
worksheet's own line in the Phase 6 relief block, §8.5). Folded into Phase 3 since it is the same
class of defect as §2.2 in the same file.

A CSV button on the tax-document modal (exporting the displayed year through the same flattener) is
a natural follow-on but is **not** required by the manual-validation workflow, which is headless.

---

## 8. AU worksheet (Phases 5–6, built after the US path lands)

The AU return is a different shape, not a different mechanism: `AuTaxDocument2026._generateItr`
(`src/finance/tax/au/au-tax-document-2026.js:52`) already produces the same
`{ sections, lineItems, summary }` structure, so **Phase 2's flattener needs no changes** — only the
country-specific concerns below.

### 8.1 Financial year, not calendar year

`taxYear` for AU is the **FY start** (2025 = FY2025-26, beginning July 2025) — the convention the
document module already uses. A `RATE`-adjacent concern: a US 2025 row and an AU 2025 row cover
overlapping but different windows, so a cross-country pivot on `taxYear` alone is misleading. The
export therefore **defaults to a single `--cc`**, and a combined file is opt-in
(`--cc US,AU`) with `country` as a mandatory pivot dimension.

### 8.2 Per-person filing

AU files per person: `TaxDocumentRegistry.generate` returns an **array** of documents from
`personTaxDetails` (`tax-document-registry.js:66`), one per person, each already stamped with
`personKey`/`personName`. Column 16 (`personKey`) carries it; the US path leaves it empty. A pivot
over AU rows must group by `personKey` **and** `taxYear` — a household total is the sum across
people, and summing without the person dimension silently double-counts nothing but hides which
spouse drove a bracket crossing.

### 8.3 Resident vs non-resident are different documents

`_generateItr` branches on `taxDetail.isResident` into two different section/line sets — non-resident
has no CGT discount, no Medicare levy, and adds NR withholding lines. Because `label` is the stable
cross-year key (§4.1), a person who changes residency mid-run produces a **different row set** in
different years. This is correct and must not be papered over. **No column is added** for it —
`section` + `label` already distinguish the two, since `Tax on Income (Non-Resident Brackets)` is a
distinct label from `Tax on Income`. Analysts pivoting across a move year will see rows appear and
disappear, which is the truth of the situation.

### 8.4 AU bracket bands

AU has **no separate CGT rate schedule**: the relieved gain is stacked on ordinary income and taxed
at the resulting marginal brackets, and `_assessResidentPreFito` already splits `baseTax` into
`ordinaryIncomeTax` + `capitalGainsTax` by the same incremental method the US uses for LTCG
(`au-tax-rates-base.js:121-139`). So Phase 5 maps onto §3 directly:

- `brackets.ordinary` — bands of `applyBracketsDetailed(auOrdinaryIncomeYTD, brackets)`.
- `brackets.capitalGains` — `subtractBands(bands(assessable), bands(ordinaryOnly))`, mirroring §3.1.
- Resident and non-resident use different tables; `brackets.table` records which
  (`Resident` / `Non-Resident`), exactly as US records `MFJ`/`Single`.

Flat-rate and non-bracketed lines carry their rate inline per §5.2: **Medicare levy** (rate ×
`discountedIncome`, with the shading-in threshold noted), **super tax**, and **NR withholding tax
(15%)**.

### 8.5 AU-specific lines needing worksheet treatment

| Line | Source | Worksheet handling |
|---|---|---|
| CGT 50% discount | `taxDetail.cgtDiscount` | `LINE`, negative, between gross and net capital gains |
| Div 115C 30% minimum-tax top-up (FY2027+) | `minTaxTopUp`, `au-tax-rates-base.js:123` | own `LINE`; **without it the listed lines do not foot to Gross Tax** — the FY2027 analogue of the §2.2 US defect, already handled by `AuTaxDocument2027` |
| Cost-base indexation (FY2027+) | design 57 | replaces the discount line; `label` differs by year, which §4.1 anticipates |
| Franking credits | `frankingOffset` | `LINE`, negative, Credits section; capped at `baseTax` — worth a `bracketIncome`-style companion showing the uncapped credit |
| FITO | `taxDetail.fito`, `fitoDeMinimis` | `LINE`, negative; the de-minimis flag rides in the `label`, as the document already does |

The FITO limit ("step 1 − step 2", `_assessResidentPreFito` evaluated twice) and the US FTC's
per-basket limitation are the two numbers this whole export exists to make checkable. Phase 6 adds
a **relief worksheet block** — a `section` of `LINE` rows exposing each basket's `numerator`,
`frac`, `limit`, `avail`, `credit` and `carryforwardRemaining` (all already returned by
`_computeFtc`, `us-tax-rates-base.js:319`) and the FITO equivalent. These are worksheet
intermediates, not return lines, so they land in a `section` named `Worksheet — Foreign Relief`,
after `Summary`, and are excluded from the line-footing checks in §6.

### 8.6 AU phases

| # | Phase | Deliverable |
|---|---|---|
| 5 | **DONE** — AU bracket bands + ITR rows | AU rate base emits `brackets` (§8.4); documents attach `bands`/`flat`; `--cc AU` produces resident **and** non-resident worksheets with `personKey` populated. Reference run: 15 FYs × 2 people, 32 schedules, all §6 checks passing. Tests TWE-25…TWE-29 |
| 6 | **DONE** — Cross-border relief worksheet | `Worksheet — Foreign Relief` section for both countries (§8.5, built in §13): §904 baskets with their denominators, FITO limit + forfeited excess, FEIE stack. Tests TWE-30…TWE-35 |

---

## 9. US state income tax — promoted into scope (§11.3)

Originally deferred. `STATE_TAX_SETTLE_APPLY` has its own reporter
(`StateTaxDocumentReporter`) on the same `JournalReportingService`, and
`base-state-tax-rates-module.js` was the third copy of `_applyBrackets` that Phase 1 collapsed — so
the state path was one small step from working. It is delivered in **Phase 9** below.

---

## 10. Risks

- **Payload growth in the journal.** Mitigated by the per-year, per-country cardinality (§3.3); if it
  ever matters, `brackets` is derivable from `taxDetail` + the rate table and could be recomputed in
  the flattener instead of stored. Storing it is preferred because it captures the bands **as the
  engine actually applied them**, which is the point of a validation artifact.
- **Golden movement in Phase 1.** The refactor touches three rate modules. Extraction must be
  behavior-preserving; the golden is the gate, and any movement means the three copies had silently
  diverged — itself a finding worth stopping for.
- **`line` renumbering between years** when conditional lines appear (§4.1). Mitigated by keeping
  zero-valued lines (§5.2) and by `label` being the stable key.

---

## 11. Scope extension — in-app export, link de-duplication, state returns

Three additions after the US headless path landed and went into real use. All three are
**IMPLEMENTED**.

| # | Phase | Deliverable |
|---|---|---|
| 7 | **DONE** — CSV button in the tax-document modal | `worksheetRowsFromDocuments()`; a CSV control in the modal footer, per document/tab (§11.1) |
| 8 | **DONE** — One Tax Doc link per settlement | shared `tax-settle-entries.js`; timeline controller stamps the flag, view consumes it (§11.2) |
| 9 | **DONE** — State worksheet CSV | state bracket bands; state document split into footing sections; `--cc STATE` (§11.3) |

### 11.1 CSV button in the tax-document modal (Phase 7)

The headless script answers "export the whole run"; the modal button answers "export the return I
am looking at". Both go through the same flattener — `worksheetRowsFromDocuments(docs)` is the
document-level entry point beside the journal-level `buildTaxWorksheetRows` — so the two exports
cannot diverge in format.

The button sits in the modal's (previously empty) footer and is rendered **per document**, so each
tab of a per-person AU filing exports its own return, with the person's name in the filename. Two
deliberate details:

- **The button is omitted when the document flattens to zero rows.** Table-shaped forms (Form 8949,
  the AU CGT Schedule) have no worksheet representation (§5.4); a button that downloads an empty
  file is worse than no button.
- **The click listener is not gated on `WorkbenchRuntime`.** The pre-existing `_wireDrillClicks`
  returned early without a runtime, because drill-down publishes on the runtime bus. CSV export
  needs no runtime, so folding it into that listener unchanged would have silently disabled the
  button wherever the modal is opened standalone. The listener is now shared and only the drill
  branch checks for a runtime.

### 11.2 One "Tax Doc ↗" link per settlement (Phase 8)

The timeline rendered a Tax Doc link on **both** journal entries of every settlement — the
country's settle-apply reducer and `Accumulate Taxes Paid` — because the predicate tested only the
action type and payload, which both entries share. This is the same action×reducer fan-out §4.0.1
already handles in the export.

The rule now lives in one place, `src/finance/tax/tax-settle-entries.js`, used by the export **and**
the timeline, so the two can no longer disagree about what "one settlement" means. The controller
stamps a `taxDoc` flag once per render; the view consumes it. That also deletes the duplicated
predicate the view carried in two render paths.

**A second, quieter bug surfaced while fixing this.** `causalGroups` collapses an action's entries
into one tree node via `byId.set(instanceId, …)` — last write wins, so in **tree mode** the node
held the *second* entry. That is exactly the entry whose drill-down periods are degenerate
(§4.0.1), so tree mode showed a single, plausible-looking Tax Doc link whose drill-throughs were
broken. `causalGroups` now keeps the first entry.

### 11.3 State worksheet CSV (Phase 9)

Three changes, mirroring the federal path:

1. **Bands.** `BaseStateTaxRatesModule` now returns `brackets: { table, ordinary, capitalGains }`.
   `capitalGains` is populated only in `'alternative'` mode (Hawaii's flat preferential rate); under
   `'ordinary'` mode the gains are already inside the ordinary bands and reporting them again would
   double-count. A no-income-tax state (SD) returns an **empty band list rather than a missing
   field**, so consumers can read `brackets.ordinary` unconditionally.

2. **Sections that foot.** The state document put every line — income *and* tax — in one
   `"<ST> Resident Return"` section. That is not a presentational quibble: a section mixing income
   and tax lines cannot be checked, because summing it means nothing. It is now split into `Income`
   and `Tax Computation` exactly like Form 1040, and the module's `Net State Tax Liability` line
   becomes a `Gross Tax` line (no state credits are modeled, so they are equal, and `Gross Tax` is
   the label the §6 footing check keys on; net liability remains the Summary headline, as on the
   federal forms). The reporter **falls back to the original flat section** if the rate module's
   labels ever stop matching what it expects — losing a line from a tax document is far worse than
   showing an unsplit one.

3. **Export.** `--cc STATE` resolves to `STATE_TAX_SETTLE_APPLY` through the shared
   `settleActionTypeFor`. No new column is needed: the state rides in `form`
   (`NE State Income Tax`), and `country`/`currency` stay `US`/`USD`.

Verified end-to-end on Nebraska (CG folded into ordinary) and Hawaii (7.25% alternative CG stated
inline as a flat-rate line), both passing the §6 footing checks.

---

## 12. Phase 5 notes — what the AU return needed beyond §8

§8 predicted the AU worksheet would need no flattener change, and it did not: the `bands`/`flat`
seam (§4.0) carried it. Four things were not anticipated.

### 12.1 The band set has to move when the sub-rows appear

The resident "Tax on Income" line splits into `Tax on Ordinary Income` + `Tax on Capital Gains`
sub-rows **only when there is an assessable gain**. Attaching the ordinary schedule to the sub-row
alone would leave the ordinary AU year — wages, no disposals, the overwhelming majority — exporting
with **no bracket detail at all**.

So `_taxOnIncomeLine()` carries `bands` when there are no sub-rows (where
`assessableIncome === ordinaryIncome`, so the ordinary schedule explains the line exactly) and omits
them when the sub-rows carry the split instead — otherwise the same schedule would be counted twice.

### 12.2 Bands can hang off a `SUBLINE`

Following from §12.1, the AU capital-gains differential is attached to a `SUBLINE`. The verifier
originally reconciled schedules only against `LINE` rows, so those bands would have been silently
unchecked — and the CG differential is the least obvious number on the return, the one most worth
checking. `verifyWorksheetRows` now reconciles bands under `LINE` **and** `SUBLINE` parents.

### 12.3 The Medicare levy is flat-rate but not a single rate

Inside the low-income phase-in band the levy is `phaseInRate × (income − lowerThreshold)`; above it,
`statutoryRate × income`. A `flatRateBand(0.02, income)` would be wrong for exactly the low-income
years where a reader is most likely to question the figure. `_medicareLevyDetail()` reports the rate
and base **actually applied** — so `rate × income = tax` holds on the exported row — and tags the
row with its `regime` (`exempt` / `phase-in` / `full`) plus the threshold parameters.

### 12.4 The non-resident section had no total to foot against

The non-resident Tax Computation section listed its three taxes and simply stopped — no `Gross Tax`
line — so there was nothing for the §6 check to reconcile against, and a reader had to add the
column by hand. It now states `Gross Tax` (the figure the summary already reported), making the
non-resident return checkable by the same rule as every other return. This is the third instance of
the §2.2 defect class, after the US SECA lines and the FY2027 min-tax top-up.

### 12.5 Known: the AU ordinary/CG split does not foot in a capital-LOSS year

`ordinaryIncomeTax` is `brackets(ordinaryIncome)` and `capitalGainsTax` is
`max(0, baseTax − ordinaryOnlyTax)`. The clamp is right for the Div 115C top-up that consumes it,
but it means the two sub-rows sum to `ordinaryOnlyTax`, not to `baseTax`, whenever a net capital
**loss** pulls assessable income below ordinary income — the code comment asserting
"brackets are monotonic, so ordinaryOnlyTax ≤ baseTax" holds only for non-negative gains.

Pre-existing and not introduced here. The exported CG bands are clamped to zero in that case so they
always sum to the `capitalGainsTax` actually reported, and because sub-rows are `SUBLINE` they are
excluded from the Gross Tax footing — so **the CSV stays self-consistent**. The underlying display
split remains slightly wrong in loss years; fixing it means separating the clamped `taxOnGain` used
by the top-up from an unclamped component used for display, which changes a reported figure and so
belongs in its own change with its own golden review.

---

## 13. Phase 6 — the foreign-relief worksheet

The FEIE exclusion, the per-§904-basket FTC and the AU FITO are the three hardest numbers on a
cross-border return to check by hand, because the return states only their **results**. The Credits
section shows a credit but not the limitation that capped it; the Income section shows an exclusion
but not the cap that trimmed it. Every intermediate already exists inside `_computeFtc` /
`_computeFeie` / the FITO branch — the worksheet simply stops discarding them.

### 13.1 A new row type, because these are not lines of the return

Worksheet rows are `WORKSHEET` (money) and `RATE` (ratios), never `LINE`. They are supporting
arithmetic and must never be summed into the return — the same reasoning that produced `SUBLINE`
(§5.2). Because every footing check filters `rowType = 'LINE'`, the block is inert to all of them
by construction; TWE-31 pins that.

The flattener now honors an explicit `rowType` on a line item
(`li.rowType ?? (li.sub ? 'SUBLINE' : 'LINE')`), so a document module can classify its own rows
without the flattener learning anything jurisdiction-specific.

### 13.2 US — §904 with its denominators

`_computeFtc` returned `frac` and `limit` but neither of their inputs, so a reader could see the
numbers and not check them. It now also returns **`totalTaxable`** (the fraction's denominator) and
**`limitationBase`** (the Chapter-1 gross tax the limit scales) — the only engine change Phase 6
needed. The worksheet then makes both formulas reproducible:

```
frac   = basketForeignIncome / totalTaxable
limit  = limitationBase × frac
credit = min(currentYearForeignTax + carryforwardPool, limit)
```

with the draw-down split (`current-year used` / `carryover used`) and the resulting
`carryforward remaining` beside them. The FEIE rows state the qualifying exclusion and the
stacking-capped amount actually excluded — the §7.1 distinction, now visible rather than implied.

### 13.3 AU — FITO, including what is lost

The ATO "step 1 − step 2" limit is derived by re-assessing the entire return with the US-source
income disregarded, so it **cannot be reconstructed from anything else the return shows**. The
worksheet states it, along with the de-minimis shortcut when that applies — named explicitly, rather
than leaving a reader to infer it from a mysteriously absent limit.

It also states `FITO — excess forfeited (no carryforward)`. Unlike the US FTC, AU grants no
carryforward and any excess is simply lost (design 52 §4.5). That forfeiture is a real, sometimes
large cost that appears **nowhere** on the return; `paid = allowed + forfeited` holds exactly.

### 13.4 What the worksheet immediately exposed

On the reference scenario's 2033 US return:

| Worksheet row | Value |
|---|---:|
| §904 limitation base (Chapter-1 gross tax) | 163,139.31 |
| §904 total taxable income (denominator) | 996,417.50 |
| Passive — foreign income in basket | 3,185.72 |
| Passive — limitation fraction | 0.00320 |
| Passive — §904 limit | 521.58 |
| Passive — current-year foreign tax | **393,769.97** |
| Passive — credit taken | **521.58** |
| Passive — carryforward remaining | 420,604.68 |

$393,770 of AU tax was paid, $522 was creditable, and $420,605 went to carryforward — because the
passive basket's *numerator* is $3,186 while the denominator includes the whole $996k of taxable
income. The limitation arithmetic is internally consistent; what the worksheet raises is whether the
**AU-source capital gain that generated that tax is reaching a basket numerator at all**
(`foreignGeneralIncomeYTD` / `foreignPassiveIncomeYTD`), given the denominator plainly includes the
gain. That is a classification question about the design-52 income buckets, not a defect in the
credit calculation, and it is exactly the kind of thing this export exists to surface. Left open
deliberately — it changes lifetime tax and belongs in its own change.

---

## 14. The §904 finding, run down — AU tax on US-source income was creditable

§13.4 flagged that the 2033 return credited $522 against $393,770 of "foreign tax". Investigating it
turned up a real over-relief defect. **The §904 numerator was correct; the pool funding was not.**

### 14.1 The company gain is US-source, so the numerator was right

`COMPANY_SALE_TAX` (`us-tax-module-2026.js`) adds the gain to `usCapitalGainsYTD`, to
`auCapitalGainsYTD` when AU-resident, and to `usSourceCapGainsUsdYTD` / `usSourceCapGainsAudYTD` —
but deliberately **not** to `foreignGeneralIncomeYTD` / `foreignPassiveIncomeYTD`. That is correct:
US company equity produces a **US-source** gain, and §904 exists precisely to stop foreign tax on
US-source income from being credited. The contrast with `AU_STOCK_WITHDRAWAL_TAX` and
`AU_HOUSE_SALE_TAX`, which *do* feed the passive numerator, is the source rule working as intended.

### 14.2 The leak was on the funding side

`AuTaxSettleApplyReducer._extraStatePatches` staged the whole post-FITO AU liability (less super
tax) as current-year creditable foreign tax, on this stated assumption:

> "Because FITO has already reduced the AU liability by the US tax on US-source income, the residual
> is predominantly the AU tax on AU-source income."

That holds only while FITO **fully** relieves — i.e. while the US tax on US-source income is at
least the AU tax on it. On a large capital gain it is not: AU taxes at ~45% while the US charges
15–20% LTCG. The FY2033 settle makes it stark:

| | AUD |
|---|---:|
| AU tax for the year (`action.tax`) | 616,253 |
| `fitoLimit` — AU tax attributable to US-source income (both filers) | **644,328** |
| FITO actually relieved | 36,000 |
| Super tax | 5,910 |
| Staged as creditable US foreign tax (old) | **610,343** → 393,770 USD |

Essentially the *entire* AU liability was tax on the US-source gain, and essentially all of it was
staged as creditable. §904 correctly refused to credit it that year ($522 taken) — but the unused
$420,605 banked as a 10-year carryforward vintage. From 2040, with `currentTax` at zero because AU
income had ceased, the pool funded credits of $655–1,503 **every year, entirely from carryover**.
The over-relief was deferred, not prevented — the exact failure mode design 52 was written to kill.

### 14.3 The fix

`fitoLimit` *is* the AU tax attributable to US-source income: the ATO "step 1 − step 2" calculation
is by construction the marginal AU tax on the US-source slice. FITO already relieved `fito` of it,
so `fitoLimit − fito` is what survives inside the AU net liability and must not be treated as
creditable:

```js
auCreditable = max(0, tax − superTax − Σ_person max(0, fitoLimit − fito))
```

No new state, no new computation — the quantity was already on every AU return, just unused. Effect
on the reference run:

| | before | after |
|---|---:|---:|
| 2033 current-year foreign tax staged | 393,770 | **1,300** |
| §904 passive pool peak | 535,690 | **3,420** |
| Carryover-funded credits, 2040–2049 | ~9,354 | ~3,139 (pool drained by 2044) |
| Lifetime tax | 1,127,909 | **1,134,089** (+0.55%) |
| Ending net worth | 11,584,190 | **11,577,657** (−0.06%) |

Upward tax is the correct direction for removing over-relief. The move is small because the
limitation already blocked the bulk in-year; what leaked was the decade of carryforward drawdown
after AU income stopped. Golden re-pinned; guarded by `ftc-us-source-not-creditable.test.mjs`
(FTC-US-1…FTC-US-9), including an end-to-end assertion that the pool stays bounded.

**Known gap:** under the A$1,000 FITO de-minimis shortcut the ATO limit is deliberately not
computed, so `fitoLimit` is null and nothing is excluded. The US tax on US-source income is ≤A$1,000
in those years, so the exposure is negligible — but it is an approximation, not an exact rule.

### 14.4 Retracted: the "`taxYear` freezes at 2041" finding

An earlier revision of this section reported that `taxDetail.taxYear` freezes at 2041 from the 2042
settle onward, and speculated about consequences for the §904 vintage key and the 10-year expiry.
**That was wrong, and is retracted.**

`IntlRetirementScenario`'s default `simEnd` is **2041-01-01**. The probe that produced the finding
called `buildAndCompile({})` and then `stepTo(2050)` — driving the sim nine years beyond its own
horizon, where recurring events are no longer scheduled. Period advance stops while tax settles keep
firing, so `currentPeriods` (and the `taxYear` derived from it) stays pinned at the last scheduled
period. Re-run with an explicit `simEnd` of 2050, `taxYear` advances correctly through 2049 and the
vintage expiry works as designed — the 2033 vintage duly expires in 2044.

There is no period-engine defect here. The real lesson is a **testing** one, recorded because it
nearly produced a bogus bug report: *stepping a sim past its `simEnd` yields incoherent state, and
nothing warns you*. Any probe or test that runs beyond the default horizon must pass `simEnd`
explicitly — `ftc-us-source-not-creditable.test.mjs` FTC-US-9 now does.
