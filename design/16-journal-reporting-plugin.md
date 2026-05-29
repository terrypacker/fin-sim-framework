# 16 — Journal Reporting Plugin

> **Status:** Draft / discussion. Sections marked **OPEN** still need decisions before
> implementation can start. The targeted problem (drill-down from US/AU tax modal)
> is intentionally framed as Phase 1 of a larger Journal Reporting capability so
> the small fix and the long-term shape stay consistent.

---

## 1. Problem Statement

The US and AU tax-return modals (`TaxDocumentModal`) currently render summary
line items — *Gross Ordinary Income*, *Long-Term Capital Gains*, *Capital Gains
(before discount)*, etc. — as static numbers. A user inspecting a return cannot
answer the most natural follow-up question: **"what made up that number?"**

Specifically:

1. **Ordinary income** — show every journal entry whose reducer incremented
   `usOrdinaryIncomeYTD` / `auOrdinaryIncomeYTD` during the tax period
   (e.g. WAGES_INCOME_TAX, IRA_WITHDRAWAL_EARNINGS_TAX, STOCK_DIVIDEND_TAX,
   FIXED_INCOME_EARNINGS_TAX, BONUS_TAX, SE_INCOME_US_TAX, ROTH_CONVERSION_TAX,
   IRA_RMD_TAX, IRA_ROLLOVER_WITHDRAWAL_TAX, K401_WITHDRAWAL_TAX, K401_RMD_TAX, …).
2. **Capital gains** — for the US, this is already partially solved when sales
   exist (Schedule D + Form 8949 are emitted by `_extractUsSaleRecords`). For
   AU, sale records are mined only when the CGT schedule threshold is hit.
   In **both** cases the user should be able to click the CG line item and see
   the constituent sales, **even when no supplementary form is rendered**.

The targeted fix is "a clickable number that opens another view." The larger
question is *what that view is*. We have an opportunity to use this drill-down
as the first consumer of a generic **Journal Reporting** capability: a workbench
plugin that mines `Journal.journal` for arbitrary roll-ups (income by source,
withdrawals by account, taxes by year, cash flow by month, etc.), reusing the
existing `QueryApi` machinery.

---

## 2. Design Decisions (locked in discussion)

| Decision | Choice |
|---|---|
| Drill-down UX | **Open Journal Report plugin pre-filtered.** Clicking a line item closes (or backgrounds) the tax modal and surfaces the Journal Report workbench panel scoped to that line. Users can re-filter, switch reports, and pivot without losing the entry point context. |
| Doc scope | **Full vision in one document, phased.** The targeted tax-modal drill-down ships as Phase 1 *over* the generic plumbing, so the small fix and the long-term plugin stay aligned. |
| Query power exposed to user | **Saved "reports" + faceted filters only.** The QueryApi DSL is an internal engine. Users pick from a small library of named reports (Ordinary Income by Source, Capital Gains by Asset, Cash Flow by Account, …) and refine via dropdowns and date pickers. |

---

## 3. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│  TaxDocumentModal (existing)                                             │
│    line item click  ─────────────►  WorkbenchRuntime.publish(            │
│                                       'JOURNAL_REPORT_OPEN', {           │
│                                         reportId, params })              │
└──────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  journal-report Plugin (new — WorkbenchComponent)                        │
│    ReportPicker · FacetPanel · ResultsGrid · RollupBar · ExportCsv      │
│                                       │                                  │
│                                       ▼                                  │
│  JournalReportRunner                                                     │
│    pick ReportDefinition → compile facets → QueryApi.search()           │
│    → apply group-by / aggregates → render rows + totals                  │
└──────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  JournalQueryApi (extends QueryApi)                                      │
│    wraps JournalDataSource(journal)                                      │
│    adds: between(date,…), groupBy(field), sum(field), count(),          │
│          ytd(country), period(currentPeriods[cc])                       │
└──────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  JournalDataSource                                                       │
│    getAll() → projected views of Journal.journal entries                 │
│    projects action.data, stateDiff, executionId, event into a flat row   │
└──────────────────────────────────────────────────────────────────────────┘
                                       ▲
                                       │
                            sim.journal (Journal)
```

The diagram has four new pieces. None of them touch the simulation engine; all
of them sit on top of the already-recorded `Journal.journal`.

---

## 4. JournalDataSource

`Journal.journal` is an `Array<JournalEntry>`. Entries are rich (nested
`action.data`, `stateDiff[]`, `event`, `reducer`), which doesn't play well with
`QueryApi`'s "flat field lookup" predicate model. The data source's job is to
project each entry into a flat row that `QueryApi` can predicate-match against.

**Location:** `src/finance/journal-data-source.js`
**Interface:** `getAll(): JournalRow[]`

```js
// One row per journal entry. Extra rows can be projected per-stateDiff for
// "show me everything that changed usOrdinaryIncomeYTD" queries (see §5.2).
const row = {
  seq,
  date,          // Date — UTC
  ts,            // number — date.getTime(), for fast range predicates
  eventType,     // event.type
  actionType,    // action.type
  reducerName,   // reducer.name
  executionId,   // hierarchical exec id
  cc,            // action.data.cc | null
  amount,        // action.data.amount | null
  proceeds,      // action.data.proceeds | null
  costBasis,     // action.data.costBasis | null
  gain,          // action.data.gain | null
  isLongTerm,    // action.data.isLongTerm | null
  isAuResident,  // action.data.isAuResident | null
  description,   // action.data.description | null
  personKey,     // action.data.personKey | null
  // ─── derived from stateDiff[] ───
  changedFields, // string[] — list of state paths this entry mutated
  // ─── back-references ───
  nodeId,        // action.nodeId — for navigation back into the graph
  entry,         // the original JournalEntry, for "View Detail" / NodeEditModal
};
```

**Why a projection, not the raw entry:** keeps `QueryApi` predicates simple
(`field=value`, `gt(amount, 0)`, `contains(description, IRA)`) and avoids
spilling deep-object knowledge into the query layer. `entry` is carried along
as an opaque payload so the UI can drill further (open the journal entry's
action-detail panel, jump to the config node, etc.).

**Index hooks:** `QueryApi` already indexes `id` and `name`. We override the
parent's `_buildIndexes` to also index by `actionType` and `cc`, since those
are the most common faceted-filter fields. (Mirrors `GraphQueryApi`'s
`_kindIndex` / `_layerIndex` pattern.)

---

## 5. JournalQueryApi

`src/finance/journal-query-api.js`, extends `QueryApi`. Adds **domain-aware
helpers** so report definitions don't have to hand-build DSL strings.

### 5.1 Range and period helpers

Tax returns think in *periods*, not date ranges. `state.currentPeriods[cc]`
already gives us the active period; the journal contains the bounding
`TAX_SETTLE_APPLY` entries. The query API gains:

```js
between(fromTs, toTs)        // adds `gt(ts,fromTs) & lt(ts,toTs)` to the AST
auFy(year)                   // July-anchored fiscal year for AU
usCalYear(year)              // calendar year for US
periodOf(entry)              // bounded by prior/next TAX_SETTLE_APPLY for same cc
```

`periodOf(taxSettleEntry)` is what the drill-down uses: given the journal entry
the tax modal was opened from, derive `[priorSettleTs, thisSettleTs]` and pass
that to `between()`. This mirrors what `_extractUsSaleRecords` already does in
`tax-document-registry.js` — we generalize that pattern into a reusable helper.

### 5.2 Roll-up extensions

`QueryApi.search()` returns `{ items, total }`. The plugin needs grouped
aggregates ("ordinary income by source: WAGES_INCOME_TAX 120k, IRA_RMD_TAX
40k, …"). Add a sibling method **on the `QueryApi` base class** (not on
`JournalQueryApi`) — it's general-purpose and nothing else uses it yet, so
landing it on the base is no riskier than landing it on the subclass and
saves a refactor when `GraphQueryApi` or other consumers want rollups too:

```js
await api.aggregate({
  query,                          // string DSL or pre-built AST
  groupBy: ['actionType'],        // 1+ fields
  aggregates: {                   // name → { fn, field }
    total: { fn: 'sum', field: 'amount' },
    count: { fn: 'count' },
  },
  sort: [{ field: 'total', dir: 'desc' }],
});
// → { groups: [{ key:{actionType:'WAGES_INCOME_TAX'}, total:120_000, count:12, items:[…] }, … ], grandTotal:160_000 }
```

`aggregate()` reuses the existing `_parse → _buildPredicate → filter` pipeline,
then bucketizes the survivors and folds each bucket. `items` per group is
kept so the UI can render expandable rows without a second query.

Supported `fn`: `sum`, `count`, `min`, `max`, `avg`. `field` is required for
everything except `count`.

### 5.3 What we deliberately are NOT adding

- **No new DSL syntax.** All extensions are method-level helpers that build
  ASTs from the existing operators. The QueryApi remains the same single
  source of truth for predicates.
- **No projection/select.** The data source already projects to a flat shape;
  the UI picks which columns to render.
- **No persistence.** Saved reports (§7) are in-code definitions, not stored
  user queries. We may add saved user queries later; not in scope.

---

## 6. JournalReportingService (extended)

`JournalReportingService` already dispatches `journalEntry → reporter` keyed by
`action.type`. We extend it in two backwards-compatible ways:

### 6.1 New return shape — `DrillableTaxDocument`

Tax document modules currently return `{ title, sections:[{ heading, lineItems:
[{ label, amount }] }], summary, … }`. We extend `lineItem` with an optional
`drillReport` descriptor:

```js
const lineItem = {
  label: 'Gross Ordinary Income',
  amount: 184500,
  drillReport: {
    reportId: 'ordinary-income-by-source',
    params: {
      cc: 'US',
      period: { fromSettleEntryId: 'prev-settle-id', toSettleEntryId: 'this-settle-id' },
      personKey: null,
    },
  },
};
```

`drillReport` is the contract the modal needs to fire the workbench event.
When absent, the number renders as before (no click affordance). This keeps
the change additive and lets tax modules opt into drill-down per line item.

The `JOURNAL_REPORT_OPEN` payload schema accepts **either** a named-report
descriptor **or** a raw AST descriptor, so future drill-down sources (graph
nodes, dashboard cards, "open in journal" links from anywhere) can drive
the plugin without inventing a named report first:

```js
// Named-report form — what Phase 1 ships:
const namedFormPayload = {
  reportId: 'ordinary-income-by-source',
  params:   { cc: 'US', period: { fromSettleEntryId: 'x', toSettleEntryId: 'y' } },
};

// Raw-AST form — reserved for later, plugin already handles it:
const astFormPayload = {
  queryAst:   { op: 'and', conditions: [ /* QueryApi AST */ ] },
  groupBy:    ['actionType'],
  aggregates: { total: { fn: 'sum', field: 'amount' } },
  title:      'Custom drill',
};
```

The plugin picks the branch by which field is present. Tax-modal line items
always use the named-report form so the user lands on a labelled, picker-able
report; the AST form is the escape hatch.

### 6.2 ReportDefinitionRegistry (new sibling)

`JournalReportingService` keeps its current single responsibility (action-type
→ TaxDocument). The new generic surface lives in a sibling registry:

**`src/finance/journal-reporting/report-definition-registry.js`**

```js
class ReportDefinition {
  id;                       // 'ordinary-income-by-source'
  title;                    // 'Ordinary Income by Source'
  description;
  facets;                   // [{ name:'cc', label:'Country', kind:'select', options:['US','AU']}, …]
  defaultGroupBy;           // ['actionType']
  defaultAggregates;        // { total: { fn:'sum', field:'amount' } }
  /** Build the QueryApi AST for the given facet values + bound params. */
  buildQuery(params, helpers) { /* uses JournalQueryApi helpers */ }
  /** Optional: post-process aggregate groups (rename keys, attach colors). */
  decorate(groups) { return groups; }
}
```

Phase 1 ships **4 definitions**:

| id | Title | Default group-by | Predicate sketch |
|---|---|---|---|
| `ordinary-income-by-source` | Ordinary Income by Source | `actionType` | `cc=US & changedFields contains 'usOrdinaryIncomeYTD'` (between settles) |
| `pretax-adjustments-by-source` | Pre-tax Contributions by Source | `actionType` | `cc=US & changedFields contains 'usNegativeIncomeYTD'` (between settles) |
| `capital-gains-by-disposal` | Capital Gains by Disposal | `actionType` then `description` | `cc=US & actionType in ('STOCK_WITHDRAWAL_TAX','AU_STOCK_WITHDRAWAL_TAX','AU_HOUSE_SALE_TAX') & gt(proceeds,0)` |
| `cash-flow-by-account` | Cash Flow by Account | `stateKey` (from `stateDiff`) | All entries with a `*Account.balance` field in `changedFields`, grouped by account stateKey |

The first three are what the tax-modal drill-down opens. The fourth proves
the plugin works as a standalone reporting view (validates we didn't
accidentally overfit to tax docs).

**OPEN — should `ReportDefinition` live in `src/finance/` or under
`src/visualization/workbench/plugins/finance/`?** Leaning toward `src/finance/`
since definitions are headless (they only describe queries and aggregations).
The plugin only handles rendering.

---

## 7. journal-report Workbench Plugin

**Location:** `src/visualization/workbench/plugins/finance/journal-report-plugin.js`

A new `WorkbenchComponent` registered in `FINANCE_PLUGINS`. Layout (cf. the
existing `timeline` and `state-panel` plugins):

```
┌─ Report ────────────────────────────┐
│ ▾ Ordinary Income by Source         │  ← ReportPicker (select)
├─────────────────────────────────────┤
│ Country: [US ▾]  Period: [FY 2026 ▾]│  ← FacetPanel (built from
│ Person:  [All ▾]  Min: [  $0 ]      │      definition.facets)
├─────────────────────────────────────┤
│ Source              Count    Total  │  ← ResultsGrid (group rows)
│ ▸ WAGES_INCOME_TAX     12  $120,000 │     expand → child JournalRows
│ ▸ IRA_RMD_TAX           1   $40,000 │
│ ▸ STOCK_DIVIDEND_TAX    8    $4,500 │
│ …                                   │
├─────────────────────────────────────┤
│                  GRAND TOTAL $164,500│  ← RollupBar (footer)
│                       [⬇ CSV]       │
└─────────────────────────────────────┘
```

Child rows (the `items` carried per group) render with the existing
`StateSchemaRegistry`-aware formatting, and have:

- a **"Open detail"** link → reuses `state-panel`'s `showNodeDetail(entry)`
  (same hook the timeline already uses, see `base-app.js:389`).
- a **"View node"** link → opens the config node in `NodeEditModal` if
  `row.nodeId` is non-null (mirrors `tl-cfg-link` behavior).

### 7.1 Plugin lifecycle and bus wiring

Subscribes (via `WorkbenchRuntime`):

| Event | Behavior |
|---|---|
| `SCENARIO_READY` | Rebind to the new `sim.journal`; clear current results. |
| `JOURNAL_REPORT_OPEN` (new) | Activate report by id, seed facet values from `payload.params`, run query, focus the plugin pane. |
| `BREAKPOINT_HIT` / scrubber rewind | Re-run the active query against the current journal length so results reflect the rewound state. |

Publishes nothing new — drill-down navigation reuses existing event channels
(`state-panel` detail, `NodeEditModal` open).

### 7.2 Default layout placement

Add to the **Default**, **Analysis**, and **Review** workspace templates.
Bottom dock, **its own tab group** — not shared with `timeline`. The two are
intentionally used side-by-side (timeline = "what happened in seq order",
journal report = "what aggregates to this number"), so they need to be
visible simultaneously, not alternated. Tab group default `pane: 'bottom'`
and pinned to a sibling slot of timeline rather than the same tab group.

---

## 8. Drill-down wiring (tax modal → plugin)

### 8.1 TaxDocumentModal changes

Today: `_renderSection` emits one `<div class="tax-doc-line">` per line item.

Change: when `li.drillReport` is present, render the label/amount inside a
`<button class="tax-doc-line-drill">`. Add a single delegated click listener
on the dialog that:

1. Reads `dataset.reportId` and `dataset.params` (JSON string).
2. Dispatches `runtime.publish('JOURNAL_REPORT_OPEN', { reportId, params })`.
3. Closes the modal (current `_overlay.remove()` path).

The modal's only new responsibility is firing the event; it does not import
the plugin. The runtime decouples them.

**Where does the modal get the runtime?** Today `TaxDocumentModal` is
constructed in `BaseApp` (`base-app.js:112`) with no constructor args. Add a
constructor parameter `runtime` (optional — when absent, drill buttons render
disabled, preserving library-mode compatibility).

### 8.2 Tax document module changes

Each `*-tax-document-*.js` builds line items today as `{ label, amount }`.
For Phase 1 we add `drillReport` to these line items:

- US Form 1040 Income section: `Gross Ordinary Income`, `Adjustments
  (Pre-tax Contributions)`, and `Long-Term Capital Gains (Sch. D)`.
- AU ITR Income section: `Ordinary Income`, `Capital Gains (before
  discount)`, and (non-resident path) `Non-Resident Withholding Income`.

The `drillReport.params.period` is built from the journal entry that triggered
generation. Since `TaxDocumentRegistry.generate(entry, journal)` already
receives the journal, we can compute `prevSettleEntryId` / `thisSettleEntryId`
there and pass them down. Module signature stays the same; we add an optional
`period` object alongside `saleRecords`.

### 8.3 Why the plugin and not a nested modal

Two reasons drove the "open the plugin" choice:

1. **No throw-away UI.** A nested-modal-only drill-down would build a second
   table view that does almost exactly what the plugin needs, in code that
   isn't reachable any other way.
2. **Mining beyond tax.** The user explicitly wants to "explore the state
   over time based on what is in the Journal." Forcing every drill-down
   through the plugin keeps that exploration surface in one place.

---

## 9. Phased implementation plan

Each phase is independently shippable.

### Phase 1 — Targeted drill-down (smallest viable cut)

Goal: clicking Ordinary Income / Capital Gains in the tax modal opens a
working Journal Report panel pre-filtered.

1. `JournalDataSource` (row projection only — no per-stateDiff fan-out).
2. `JournalQueryApi` with `between()` + `periodOf()` only.
3. `JournalReportingService` (or sibling registry) registers 2 reports:
   `ordinary-income-by-source`, `capital-gains-by-disposal`.
4. `JournalQueryApi.aggregate({ groupBy, aggregates })` — `sum` + `count`.
5. `journal-report` plugin with `ReportPicker` + minimal `FacetPanel` (cc,
   period) + `ResultsGrid` + expandable child rows.
6. Add `runtime` to `TaxDocumentModal`; render drill buttons on the two line
   items per modal; publish `JOURNAL_REPORT_OPEN`.
7. Wire the plugin into `FINANCE_PLUGINS` and into the **Default**,
   **Analysis**, **Review** workspace templates.
8. Tests:
   - `journal-data-source.test.mjs` — projection from a known journal.
   - `journal-query-api.test.mjs` — `between`, `periodOf`, `aggregate` paths.
   - `evt-ordinary-income-drill.test.mjs` — runs IntlRetirement for one tax
     year, asserts the drill query returns the same total as the tax
     modal's Gross Ordinary Income line item (regression guard for
     §6.1's contract).

### Phase 2 — Cash-flow report + state-diff projection

Goal: prove the plugin is useful outside the tax drill-down.

1. Extend `JournalDataSource` to optionally emit one row per `stateDiff` entry
   (off by default; opt-in via constructor flag for state-centric reports).
2. Register `cash-flow-by-account` definition; uses the per-diff projection
   to group by account stateKey.
3. Add `min` / `max` / `avg` aggregates.
4. Add CSV export reusing the existing timeline-CSV flattening pattern
   (see `project_timeline_csv` memory).

### Phase 3 — More definitions + faceted UX polish

1. Add definitions: *Withdrawals by Account*, *Tax Paid by Year*, *Roth
   Conversions by Year*, *Real Property Cash Flow*.
2. `FacetPanel` improvements: account-stateKey multiselect powered by
   `StateRegistry`, person multiselect from `personService`.
   **Status (Phase 3B — done May 2026):** plugin gained a `multiselect` facet
   kind plus an `optionsSource: 'account' | 'person'` resolver. The plugin
   reads `accountService.getAll()` / `personService.getAll()` lazily via
   `ServiceRegistry.getInstance()` (with a `setServices()` test override).
   Account multiselect filters perDiff stateKey via `or(contains(stateKey, '<sk>.'))`;
   person multiselect filters by `in(personKey, [...])`. Updated defs:
   cash-flow-by-account, withdrawals-by-account, real-property-cash-flow
   (account); ordinary-income-by-source, capital-gains-by-disposal,
   tax-paid-by-year (person). Empty / null arrays treated as "no filter".
3. **Period facet UI (Phase 3c — done May 2026)** — render the existing
   `kind: 'period'` facet as a user-facing select. Subtasks:
   1. `JournalQueryApi.listSettledPeriods(cc)` — scan the journal for
      `TAX_SETTLE_APPLY` entries matching `cc`, pair each with its predecessor
      (or `null` → simulation start), and return
      `[{ fromEntryId, toEntryId, toEntryDate, label }, …]` in reverse
      chronological order. Labels: `CY <year>` for US (calendar year of
      `toEntryDate`); `FY <year-1>–<year>` for AU (July-anchored fiscal year of
      `toEntryDate`).
   2. `JournalQueryApi.currentInProgressPeriod(cc)` — when the user has rewound
      mid-year and no trailing settle exists, return
      `{ fromEntryId: lastSettleId|null, toEntryId: null, label: 'Current (in progress)' }`.
      The existing `periodOf({fromEntryId, toEntryId: null})` path already
      treats a null upper bound as "include everything after `fromSeq`", so no
      query-API change is required — just the enumerator.
   3. Extend `_renderFacets()` to render `kind: 'period'` as a `<select>` with
      options built from steps (1)+(2), plus a synthetic **Whole simulation**
      option that resolves to `{ fromEntryId: null, toEntryId: null }`.
   4. Reactive refresh: when `cc` changes, rebuild the period option list (the
      settle entries are cc-scoped). Preserve the user's selection only if the
      same `toEntryId` exists for the new cc; otherwise fall back to the
      default (most-recent settled period for the new cc).
   5. On `JOURNAL_REPORT_OPEN`: select the period option matching incoming
      `params.period.toEntryId`. If the incoming period doesn't match any
      enumerated option (e.g. report opened with a custom period), inject a
      transient option labelled by the entry's date and select it.
   6. Default selection when no drill-down seeded: the **most recent settled
      period** for the active cc, matching §10.3.
   7. Tests:
      - `journal-query-api.test.mjs` — `listSettledPeriods` returns correct
        pairs for a journal with N AU + M US settles; labels formatted per
        rules above.
      - `journal-report-plugin.test.mjs` — picking a different period from the
        select re-runs the query with the new `{fromEntryId, toEntryId}`;
        switching cc rebuilds the option list; `JOURNAL_REPORT_OPEN` selects
        the correct option.

### Phase 4 (deferred) — Saved user queries

Lets users save a facet configuration as a custom report under a name. Out
of scope for this design; called out so the registry interface in §6.2 keeps
room for it (`ReportDefinitionRegistry` is the obvious home for user-defined
entries).

---

## 10. Things I want to flag before coding starts

Pulling out the points that most affect implementation cost or shape, so we
can resolve them explicitly rather than discovering them mid-build.

### 10.1 How do we map a line item to "the right" predicate?

`Gross Ordinary Income` is the easy case (sum of entries whose stateDiff
includes `usOrdinaryIncomeYTD`). But the tax modules compute several derived
numbers (`adjustedGrossIncome`, `taxableIncome`, `grossTax`, `effectiveRate`)
that are *not* a simple sum of journal entries — they involve standard
deductions, brackets, credits. Drill-down on those should probably **not**
exist (no journal source). Concretely:

- **Drillable now:** `Gross Ordinary Income`, `Adjustments (Pre-tax
  Contributions)`, `Long-Term Capital Gains (Sch. D)`, AU `Ordinary Income`,
  AU `Capital Gains (before discount)`, AU `Non-Resident Withholding Income`.
  The Adjustments line is displayed with a flipped sign (subtracted from
  gross), but the underlying journal entries (`IRA_CONTRIBUTION_TAX`,
  `K401_CONTRIBUTION_TAX`, …) carry positive `amount` values. The plugin
  shows them as positive amounts under a clear heading
  ("Pre-tax Contributions — reduces taxable income") so the sign flip
  doesn't confuse the user.
- **Not drillable in Phase 1 (per decision):** `Collectibles Tax (28%)` and
  `Early Withdrawal Penalties` — they are computed (rate × YTD). The
  underlying YTD *is* journal-mineable, so a later phase can wire them in;
  out of scope for now.
- **Never drillable (no journal source):** `Adjusted Gross Income`, `Taxable
  Ordinary Income`, `Standard Deduction`, `Tax on Ordinary Income`,
  `Medicare Levy`, `Gross Tax`, `Effective Rate`, `Marginal Rate`, `CGT 50%
  Discount`, `Foreign Tax Credit`.

Plan: only add `drillReport` to the first list. The button affordance is
literally absent on the others, so the user discovers what is and isn't
drillable visually.

### 10.2a Per-person AU drill-down — wired via dedicated report (Phase 3c, May 2026)

`AuTaxByPersonYearDef` (`au-tax-by-person-year`) reads `TAX_SETTLE_APPLY.data.personTaxDetails[]` through a new `perPerson` `JournalDataSource` mode that emits one row per person × per settle entry. Groups by `[year, personName]`, sums `personTaxAmount` (= `taxDetail.netLiability`). The `personKeys` facet on this report is meaningful and narrows to the selected people.

Note: `TaxPaidByYearDef` no longer advertises a person facet — `TAX_PAYMENT_DEBIT` is structurally household-only (carries only `{ amount, cc }`). For per-person AU breakdowns, use `au-tax-by-person-year`.

### 10.2 Per-person AU drill-down — Phase 1 falls back to household totals

`personTaxDetails` is an array; the modal renders one tab per person.
Faithful per-person drill-down would require *every* AU income action type to
populate `action.data.personKey` so the query can scope to one person's
sources. Wages already does (per the `project_au_per_person_tax` memory) but
the rest is not audited.

**Phase 1 decision:** do not audit. Drill-down from a per-person AU tab
opens the report with `cc: 'AU'` and **no** `personKey` facet set — i.e. it
shows the household total breakdown. The plugin's facet panel exposes a
person dropdown so the user can narrow it manually if they want; values
that didn't populate `personKey` are bucketed under "Unattributed" rather
than dropped. A later phase can audit and tighten the attribution.

### 10.3 Period facet across tax-year boundaries

Each year's `TAX_SETTLE_APPLY` resolves to a different tax module (US 2025 →
US 2026, AU FY 2025-26 → FY 2026-27). The Period facet:

- Defaults to **the most recent settled period** for the selected country.
- Dropdown lists **all settled years** the journal has produced for that
  country, in reverse chronological order, plus a "Whole simulation" option
  that sums across all periods.
- Drill-down from the tax modal pre-selects the period bounded by the
  modal's own `TAX_SETTLE_APPLY` entry (via the `periodOf()` helper in
  §5.1). Users can switch periods after the drill without re-entering.

**Status — Phase 3c (May 2026):** the `period` facet now renders as a
`<select>` populated from `JournalQueryApi.listSettledPeriods(cc)` plus the
optional `currentInProgressPeriod(cc)` and a synthetic *Whole simulation*
option. cc changes rebuild the option list (preserving the selection only when
the same `toEntryId` enumerates for the new cc, otherwise resetting to the
most-recent settled period for that cc). `JOURNAL_REPORT_OPEN` selects the
matching option, or injects a transient `Custom (<date>)` option when the
drill-seeded period doesn't enumerate.

### 10.4 Period boundaries when the user has rewound

If the user has scrubbed back to mid-year, the trailing `TAX_SETTLE_APPLY`
doesn't exist yet. `periodOf()` needs a "current period in progress" fallback:
use `[prevSettleTs ?? simStart, now]`. Acceptable behavior; just call it out
in the helper docs.

### 10.5 Where `JournalReportingService` ends and the new registry begins

Two registries (`JournalReportingService` keyed by `action.type`,
`ReportDefinitionRegistry` keyed by `reportId`) is more honest than
overloading the existing service. Keep them separate. Phase 1 will instantiate
both side-by-side in `BaseApp` (next to `_reportingService` and
`_taxDocModal`).

### 10.6 `Journal.enabled` is opt-in

Today `Journal` defaults to `enabled: false`. `BaseApp` flips it on for the
workbench. The plugin must hard-fail gracefully when the journal is empty
(show a "Run a simulation to populate reports" placeholder). Tests should
cover the `enabled:false` path.

### 10.6 Plugin lives in the finance package

`FINANCE_PLUGINS` is the right home. The plugin reads tax-aware report
definitions and `StateSchemaRegistry`-aware formatting, neither of which
the generic workbench owns. Keeps the simulation-framework dependency-free
of reporting concerns.

---

## 11. Decisions log

1. **`drillReport` shape vs. raw AST** — keep `drillReport: { reportId,
   params }` for Phase 1, but design the `JOURNAL_REPORT_OPEN` bus payload
   to accept *either* `{ reportId, params }` *or* `{ queryAst, groupBy,
   aggregates, title }`. Future consumers (graph nodes, dashboard cards,
   "open in journal" links) can drive the plugin with a raw AST without us
   inventing a named report first. Spec'd in §6.1.
2. **Pane sharing with timeline** — do not share. Separate tab group in the
   bottom dock. Timeline and journal report will be used side-by-side. §7.2.
3. **Per-person AU drill-down** — Phase 1 falls back to whole-household
   totals; person facet is exposed for manual narrowing; entries missing
   `personKey` bucket under "Unattributed." Audit deferred. §10.2.
4. **Drill-down on `Collectibles Tax` and `Early Withdrawal Penalties`** —
   not in Phase 1; revisit later. §10.1.
5. **`aggregate()` home** — lands on the `QueryApi` base class, not on
   `JournalQueryApi`. Nothing else uses it yet, so landing it on the base is
   no riskier than the subclass and saves a refactor when `GraphQueryApi`
   or other consumers want rollups. §5.2.
6. **Period facet UX across tax-year boundaries** — default to the most
   recent settled period, with a dropdown of all settled years for the
   selected country (reverse chronological) plus a "Whole simulation"
   option. Drill-down pre-selects the period bounded by the modal's own
   settle entry. §10.3.
7. **`Adjustments (Pre-tax Contributions)` drillable** — yes. Phase 1 ships
   a `pretax-adjustments-by-source` report; the line item carries
   `drillReport` even though its sign is flipped in the form. The plugin
   shows the underlying entries as positive amounts under a labelled
   heading. §6.2, §10.1.

---

## 12. References

- `src/simulation-framework/journal.js` — `Journal` and `JournalEntry`.
- `src/query/query-api.js` — predicate engine to be reused.
- `src/finance/journal-reporting-service.js` — existing action-type dispatcher.
- `src/finance/tax/tax-document-registry.js` — model for journal mining
  (`_extractUsSaleRecords`, `_extractAuSaleRecords`).
- `src/visualization/timeline/tax-document-modal.js` — line-item renderer to
  extend with drill buttons.
- `src/apps/base-app.js:386–409` — current timeline → modal wiring; the
  new plugin slots in alongside.
- `src/visualization/workbench/plugins/finance/finance-plugin-package.js` —
  registry to add `journal-report` to.
- Related design: `design/2-unified-event-schema.md` (long-term event model
  this plugin would also benefit from but doesn't depend on).
