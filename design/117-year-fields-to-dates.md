# 117 — Year fields become Dates

**Status:** ACCEPTED, 2 Oct 2026. The decisions in §3 were taken with the author, and Q1–Q3
(§11) are answered as proposed (D8–D10). **Phases 1–6 BUILT** 2 Oct 2026 (§12–§17);
phase 7 not started.
Scope is groups A and B of the 2 Oct inventory (§2): fields where a year stands for one
moment, and loan-term boundaries. Annual windows and year-keyed schedules stay years (§2.3).
Design 116 (employment spells) phase 4 waits on §5, the optimizer's Date type.

## 1. The ask

Change the parameters and record fields that hold a calendar year, where the year really
stands for a date, into Dates: the AU move year, a property's sale year, and others like
them. Design 116 bounds employment on Dates, and a move, a sale or a rollover that can only
land on a fixed day of a year does not compose with a job that ends on a real date.

## 2. What the code does today (audited 2 Oct 2026)

### 2.1 Group A — a year standing in for a single moment

| Field | Where it lives | Date the code builds from the year | Sweep today |
|---|---|---|---|
| `moveYear` | US_AU_CROSS_BORDER param | **1 Jul**, hardcoded (`us-au-cross-border-toolset.js:278`) | mc + opt (INTEGER) |
| `stateMoveYear` | US_STATE_TAX param | 1 Jan (`us-state-tax-toolset.js` `_buildStateMoveEvent`) | mc + opt (INTEGER) |
| `plannedSaleYear` | real-property, collectible, company records | **15 Jan**, hardcoded in four toolsets (US/AU real property, collectibles, company sale) | mc + opt, per record (`prop.` / `coll.` / `equity.`), `sweepUnset` |
| `purchaseYear` | real-property | 15 Jan (both real-property toolsets) | none |
| `inheritanceYear` (+ hidden `inheritanceMonth`, `inheritanceDay`) | bequest | `Date.UTC(year, month ?? 0, day ?? 15)` (`bequest-service.js:162`) | none |
| `k401ToIraConversionYear` + `…Month` + `…Day` | US_RETIREMENT param | each part falls back to the owner's retirement date separately (`us-retirement-toolset.js` ~918) | opt (year only) |
| `companySaleYear`, `usHouseSaleYear`, `auHouseSaleYear`, `carSaleYear` | flat scenario params that alias onto a record's `plannedSaleYear` | 15 Jan, through the record | mc + opt via the aliases |
| `mainResidenceFromYear` | real-property template | not a year: a **fractional-year proxy** for the `mainResidenceFrom` Date, written back as a date (`record-param-templates.js:229`) | mc + opt (CONTINUOUS) |

Two of these are already Dates split into parts: the bequest's three fields, and the 401(k)
rollover's three params. The proxy shows that a swept Date has been needed before, and that
the workaround is a number the author has to decode (2031.5 = 1 Jul 2031).

### 2.2 Group B — loan-term boundaries

| Loan account field | Property-mortgage mirror | Meaning |
|---|---|---|
| `fixedRateUntilYear` | `mortgageFixedRateUntilYear` | the fixed window ends; the loan pays the revert rate |
| `interestOnlyUntilYear` | `mortgageInterestOnlyUntilYear` | IO ends; P&I over the remaining term |
| `maturityYear` | `mortgageMaturityYear` | the whole balance is discharged |

`loan-classes.js` compares each one with `loanYear(state, loan)`, the **calendar year of the
loan country's current tax period start**. So the boundaries fall on **1 Jan for a US loan
and 1 Jul for an AU loan**. This is design 113 Q6, recorded and left open. The help text
for all six fields says 1 January, which is wrong for AU. The month counts (`(maturity −
from) × 12`, `monthsUntilPeriodYear`) agree with the period boundary since design 113 Q5.
None of the six is sweepable.

### 2.3 Out of scope: they stay years

- **Annual windows.** `rothConversionStartYear` / `EndYear` and `earlyWithdrawalStartYear` /
  `EndYear` select whole tax years for an annual decision.
- **Year-keyed schedules.** The early-withdrawal schedule, the Roth income-fill schedule,
  the yield-curve path, the prime-rate schedule, the pool-shape schedule and
  `liquidityTargetSchedule` take effect at year-open by design (design 112).
- **Not calendar years.** `poolCashYears`, `poolBondYears`, `bondLadderSpacingYears`,
  `lumpYear` (a 0–9 index into the SECURE window), `primarySsClaimAge`, the spending age
  bands.
- **Internal stamps.** `postFixedFromYear` and `fixedExtraYear` in loan state count tax
  periods. They are not authored.

### 2.4 Date support that already exists

- **Fields.** `birthDate`, `retirementDate`, `acquisitionDate`, `mainResidenceFrom` / `Until`,
  a security's `maturityDate`, and `shocks[].startDate` are already Dates. On records and
  params they are ISO strings. In state, dates are epoch ms under a `…Ms` name
  (`residencySinceMs`, `conversionMs`, `currentPeriods.*.startMs`).
- **Param editor.** `scenario-tab-view.js:752` renders a `type: 'Date'` param as a date input.
- **Monte Carlo.** `sweepKindOf` returns `date` for `type: 'Date'` (`param-schema-utils.js:322`).
  `UniformDateDistribution` samples an ISO day (`distributions.js:123`). The MC panel has a
  date branch, and the harvest defaults a date row to ±2 years
  (`intl-retirement-mc-config.js:55`).
- **The optimizer has none.** `optRowFor` returns null for a `date` row
  (`intl-retirement-opt-config.js:79`), so a Date lever disappears from Opt and the lever
  grid. Both homeowner scenarios declare `primaryRetirementDate` with `opt: true`. (Corrected
  while building phase 1: that flag was never the gap. The Opt list harvests the
  IntlRetirementScenario schema and the generated per-record params, not a homeowner
  scenario's own schema, and the Person template has `retirementDate` at `opt: false`. So no
  date row reached Opt at all, and none was dead behind a missing type.)

## 3. Decisions (taken with the author, 2 Oct 2026)

| # | Question | Decision |
|---|---|---|
| D1 | Representation | An ISO day (`YYYY-MM-DD`) on records and params. In state, the same ISO day under the record's own field name — amended while building phase 2 (§13): a property's state entry already carries `acquisitionDate` and `mainResidenceFrom` that way, so an `…Ms` field beside them would give one entry two date conventions. |
| D2 | Keys | **Renamed**: `moveYear` → `moveDate`, `plannedSaleYear` → `plannedSaleDate`, and so on (§4). A key that says Year and holds a date misleads every reader, and `sweepKindOf` treats any key ending in `Year` as a year. Old keys are rewritten on load with the value converted (§6). |
| D3 | Results on load | **Unchanged.** Each year migrates to the exact date the code builds from it today (§6.1), so every run produces the same numbers. Goldens change only where a renamed key sits in state (§9). |
| D4 | Optimizer | A real `DATE` variable type (§5). It is encoded as an integer month count, so the solvers see an integer. A fractional-year proxy (the `mainResidenceFromYear` pattern) is rejected: it shows 2031.5 to the author, and design 116 needs real dates. |
| D5 | Dates pinned to a tax-year boundary | `moveDate` must fall on 1 Jul and `stateMoveDate` on 1 Jan **until part-year tax is modelled** (§7.1). A schema entry declares the pin (`dateAnchor`), and the loader, editor, MC and Opt all honour it. Converted now (D8). |
| D6 | Loan boundaries | An explicit date. A boundary takes effect from the first payment on or after it. Migration writes 1 Jan for a US loan and 1 Jul for an AU loan, so the behaviour is unchanged, and design 113 Q6 is closed because the author now states the day (§7.3). |
| D7 | The 401(k) rollover date | Moves onto the **person** as `k401ToIraConversionDate` (Q2). Today it is one scenario param shared by every 401(k) owner, while its fallback is per owner. |
| D8 | The moves (was Q1) | **Converted now**, anchored (phase 4). Phase 7 changes only validation and tax. |
| D9 | Where the rollover date lives (was Q2) | **A person field**, `person.<id>.k401ToIraConversionDate`, migrated per person (phase 3). |
| D10 | MC distribution for a date row (was Q3) | **Add NORMAL_DATE** (a mean date, a standard deviation in days). A saved NORMAL year row converts into it (phase 2). New date rows keep UNIFORM_DATE ±2 years as their default. |

## 4. The fields after this design

| Today | After | Type | Notes |
|---|---|---|---|
| `moveYear` | `moveDate` | Date | `dateAnchor: '07-01'` (D5) |
| `stateMoveYear` | `stateMoveDate` | Date | `dateAnchor: '01-01'` (D5) |
| `plannedSaleYear` (property, collectible, company) | `plannedSaleDate` | Date | Generated keys become `prop.<sk>.plannedSaleDate` and the matching `coll.` / `equity.` keys. `sweepUnset` is kept. |
| `purchaseYear` | `purchaseDate` | Date | |
| `inheritanceYear` + `inheritanceMonth` + `inheritanceDay` | `inheritanceDate` | Date | Three fields become one |
| `k401ToIraConversionYear` / `Month` / `Day` | `person.<id>.k401ToIraConversionDate` | Date | Q2. Empty means the person's separation date (`retirementDate`, or design 116's `lastWorkDate`). |
| `companySaleYear`, `usHouseSaleYear`, `auHouseSaleYear`, `carSaleYear` | retired | — | Rewritten to the record's generated `plannedSaleDate` key (§6.2) |
| `mainResidenceFromYear` | retired | — | `mainResidenceFrom` is swept directly once §5 lands (phase 6) |
| `fixedRateUntilYear` / `mortgageFixedRateUntilYear` | `fixedRateUntil` / `mortgageFixedRateUntil` | Date | |
| `interestOnlyUntilYear` / `mortgageInterestOnlyUntilYear` | `interestOnlyUntil` / `mortgageInterestOnlyUntil` | Date | |
| `maturityYear` / `mortgageMaturityYear` | `maturityDate` / `mortgageMaturityDate` | Date | A loan's `maturityDate` matches the security field of the same name |

`LOAN_RATE_TERM_FIELDS` (`loan-classes.js`) keeps the field and its mortgage mirror in one
list, so the rename happens in one place for the rate terms.

## 5. The optimizer's Date type

### 5.1 The variable

```
{ paramKey, type: OPT_PARAM_TYPES.DATE, min: 'YYYY-MM-DD', max: 'YYYY-MM-DD',
  step: <months, or years when anchored>, anchor?: 'MM-DD' }
```

- **Encoding.** `encode` maps a date to the month count `year × 12 + month`. `decode` rounds,
  clamps to `[min, max]` and writes `YYYY-MM-DD`. The day is the `anchor`'s day when there is
  one, otherwise `min`'s day. With an anchor, the month is fixed as well: the variable steps
  in years, and decoding snaps to the anchor date of each year.
- **Why months.** Loans pay monthly and sale or purchase events run once, so a month is the
  smallest step that can change a result in most cases. The one exception is §121's
  730-day use test, and a month step reaches either side of it, which the current
  half-year step on `mainResidenceFromYear` cannot.
- **Solvers.** Each check of `v.type === OPT_PARAM_TYPES.INTEGER` that decides integer
  behaviour becomes `isIntegral(v)` (INTEGER or DATE). The audited sites are:
  `optimization-problem.js` (`encode`, `decode`, `randomCandidate`), `opt-values.js`
  `valuesForConfig`, `simulated-annealing-solver.js:87`, `random-solver.js:22`,
  `pattern-search-solver.js:26` and `:92`. The build starts from a fresh grep for
  `OPT_PARAM_TYPES` that includes `qp-polish.js`, `cem-solver.js` and the MPC cockpit, since
  `randomCandidate` and `valuesForConfig` produce candidate *values*, not vectors, and must
  return ISO days for a DATE.
- **Harvest.** `optRowFor` gains a `date` case: ±2 years around the center, a step of 1
  month, or 1 year with an anchor. An unset `sweepUnset` row searches the plan window, as
  the year case does now.

### 5.2 The panel

`opt-config-panel.js` gains a DATE branch: min and max as date inputs, and a step in months.
For an anchored variable the inputs are years, labelled with the anchor day.

### 5.3 Monte Carlo

Most of this exists already (§2.4). Two changes:

- **Distribution shape.** A year row today is NORMAL with a 1.5-year standard deviation,
  rounded to the year. The existing date default is UNIFORM_DATE ±2 years. Switching shape
  would change the distribution of any saved MC run that sweeps a sale year, so D10 adds
  NORMAL_DATE for the conversion of saved rows (phase 2).
- **Anchors.** An anchored row samples a year and snaps to the anchor date, so a draw never
  produces a move date the loader rejects.

### 5.4 Liveness

Every converted lever gets a test that loads a scenario through `ScenarioLoader`, sets the
generated key to a date, and asserts the **effect**: the sale event moves, the loan reverts
in a different month. A flat-bag test does not prove a lever live. Earlier levers were dead
behind toolset forwarding, legacy aliases and the loader order, and only a loaded config
found them. Phase 1 has no converted field yet, so its liveness test drives a DATE variable
on the generated `person.primary.retirementDate` key through a real rollout (§12).

## 6. Migration

### 6.1 The conversion table (keeps results unchanged)

| Old value | New value |
|---|---|
| `moveYear: Y` | `moveDate: Y-07-01` |
| `stateMoveYear: Y` | `stateMoveDate: Y-01-01` |
| `plannedSaleYear: Y`, `purchaseYear: Y` | `Y-01-15` |
| `inheritanceYear: Y`, month `m` (0-based, default 0), day `d` (default 15) | `Y-(m+1)-d` |
| 401(k) year / month / day, any subset set | Per person: each missing part is filled from **that person's** retirement date, exactly as `us-retirement-toolset.js` resolves it today, and the result is written to the person (Q2) |
| `fixedRateUntilYear`, `interestOnlyUntilYear`, `maturityYear: Y` on a US loan | `Y-01-01` |
| the same on an **AU** loan | `Y-07-01` (the boundary the engine enforces today, §2.2) |
| `null` / unset | `null` |

The loan's country is the account's (or the property's) country, so the loader knows which
row applies.

### 6.2 Where old keys are rewritten

A rename needs a converting rewrite at every place a key can arrive. The design-98 and
design-25a experience is that a missed path leaves the lever silently inert, so each path
gets its own test:

1. **Scenario records and params** on load: a new `ScenarioLoader` step, next to the
   existing legacy-param retirement (`scenario-loader.js` ~1167), converts the value as well
   as the key.
2. **Param aliases.** `getParamAliases()` maps `usHouseSaleYear` / `auHouseSaleYear` to the
   generated key today. Aliases rename only, so a converting entry is needed: year → `Y-01-15`.
   `applyRealPropertySaleYearParams` and the `companySaleYear` node link are retired with
   their keys.
3. **Saved MC and Opt configs.** A row whose `paramKey` names an old key is rewritten to the
   new key, its distribution or range is converted (a NORMAL year becomes a date row; an
   INTEGER year range becomes a DATE range with a 12-month step), and the change is
   reported. The pattern is design 25a's `shockSeverity` rewrite.
4. **Lever grid and MPC recorded runs.** The audit found no group A or B field among the
   cockpit levers. The build re-checks `lever-schedule.js` and the grid's saved state.
5. **Built-in scenarios** (`intl-retirement`, both homeowner scenarios) are edited at the
   source, not migrated.

The loader **errors** on a date it cannot read, and on an anchored field that is off its
anchor (D5). It does not warn: an inert date is a silently wrong answer, and loader
warnings do not print from the CLI tools.

## 7. Semantics of a real date, per field

### 7.1 The two moves (D5)

- **AU move.** `ChangeResidencyHandler` documents why the move is pinned to 1 Jul: the AU
  settle on 30 Jun taxes only the resident part of the year, and that only works when the
  move falls on the year boundary. A move on any other day needs a part-year resident's
  pro-rated tax-free threshold in the AU tax module. The law for that is **not on disk**: it
  is in the Income Tax Rates Act, not ITAA 1936 or 1997. It must be fetched into `docs/au-tax/`
  before it is modelled. The US side needs nothing, since a citizen is taxed on the full
  calendar year either way.
- **State move.** Design 34 §9.1 pins it to 1 Jan, because a move inside the year needs
  part-year apportionment (split each `state*YTD` and run the state tax twice). That is still
  deferred.
- **So, in this design** the two fields are Dates with an anchor. The editor offers the
  year; the anchor day is shown, not typed. Removing an anchor later is a validation change
  plus the tax work above, and nothing else in this design changes.

### 7.2 Sales, purchases, inheritance, rollover

The event fires on the date, which gives the author the day that drives the AU financial
year, the CGT discount's 12-month holding test and the main-residence day counts
(`mainResidenceFrom` / `Until` are already dates). Two details stay as they are, so
migrated runs do not change:

- **The purchase price** grows by whole years from the start year
  (`resolvePurchasePrice`). It reads the purchase date's year. Fractional growth would
  change every future purchase, so it is not part of this design.
- **The SECURE window index** (`year − inheritanceYear`, `inheritance-classes.js:254`) reads
  the inheritance date's year.

The rollover keeps its legal clamp: a date before separation moves to separation.

### 7.3 Loan boundaries (D6)

- **The test.** Each `year >= …Year` test becomes "this payment's date is on or after the
  boundary". For a boundary on the first of a month this is the same as today's test
  against the period year, for both countries. A mid-month boundary takes effect from the
  first payment on or after it.
- **Month counts.** Term arithmetic (`(maturity − from) × 12`, `monthsUntilPeriodYear`)
  becomes the month difference between the two dates. For the migrated dates this gives the
  same counts as today.
- **Break cost** prices the months to the fixed window's end date (`fixedWindowEndYear`
  becomes `fixedWindowEnd`).
- **Design 113 Q6.** It was open because changing an AU boundary to 1 Jan would change every
  AU loan with a term. Once the author types a date the question goes away. Migration keeps
  1 Jul, and the help text stops saying 1 January.
- **Tests.** Each existing FRL test keeps its expected numbers. New tests cover a mid-month
  boundary and an AU loan given a 1 Jan boundary.

## 8. Authoring surface

| Editor | Fields |
|---|---|
| `real-property-editor.js` | sale, purchase, mortgage fixed-until, IO-until, maturity |
| `collectible-editor.js` | sale |
| `company-equity-editor.js` | sale |
| `bequest-editor.js` | inheritance date; an inherited asset's sale date (~193) |
| `account-editor.js`, `accounts-controller.js` (the nullable field lists) | loan IO-until, maturity |
| `loan-rate-terms-form.js` | fixed-until |
| scenario param rows (`scenario-tab-view.js`) | `moveDate`, `stateMoveDate`: Date rendering exists; the anchored year form is new |
| People panel | `k401ToIraConversionDate` (Q2) |

- Each is a date input, with empty meaning "never" or "unset", as the blank year does now.
  There are no free-text dates.
- **Help.** These `kind: node` topics change, and each needs `npm run help:restamp` after its
  form changes: `account`, `real-property`, `company`, and `collectible`, `bequest` and
  `person` if their topics cover these fields. These concept topics name the old keys and
  are rewritten: `cost-basis-and-equity`, `cross-border-residency`, `us-tax`,
  `roth-conversions`. The schema `description`s change too (the loan ones lose "1 January"),
  then `npm run help:build`.

## 9. State and goldens

- **Projections.** The toolsets project `plannedSaleYear`, `purchaseYear` and the loan terms
  into state, and `state-schema-registry.js` types `*.plannedSaleYear` and `*.maturityYear` as
  `year()`. These become date fields typed `date()`, holding the record's ISO day (D1).
- **Goldens.** They pin whole-state JSON, so the renamed keys change the fixtures even
  though no number changes. Each phase regolds with `REGOLD=1`. The diff is then checked
  mechanically: map each old key and year to its new key and ms under §6.1, and assert that
  nothing else differs. Reading the diff by eye is not enough for this many fixtures.
- **Serializer.** `scenario-serializer.js` round-trips every renamed field. A round-trip test
  per record type confirms the old fields are not written back.

## 10. Phasing

1. **Optimizer Date type.** `DATE` + `isIntegral`, the encode, decode and sampling paths, the
   panel branch, `optRowFor`'s `date` case, the `dateAnchor` mechanism in MC and Opt.
   NORMAL_DATE (D10). Liveness test for `primaryRetirementDate`. No field changes yet, so
   goldens are untouched.
   **This unblocks design 116 phase 4.**
2. **Sales and purchases.** `plannedSaleDate` on all three record types plus `purchaseDate`,
   the loader step, converting aliases, saved-config rewrite, the four retired flat params.
   This phase proves the migration path end to end on the most-used field.
3. **Inheritance and rollover.** `inheritanceDate` (three fields become one) and the
   per-person `k401ToIraConversionDate`.
4. **Moves.** `moveDate` and `stateMoveDate`, anchored.
5. **Loan terms.** Account and mortgage fields, the date tests in `loan-classes.js`, design
   113 Q6 closed, the FRL tests carried over.
6. **Retire `mainResidenceFromYear`.** Sweep `mainResidenceFrom` directly, and add a saved
   config rewrite for the proxy key.
7. **Later.** Remove the move anchors: part-year AU residency (law fetched first, §7.1) and
   the part-year state apportionment of design 34 §9.1.

## 11. Questions (all answered 2 Oct 2026)

- **Q1 — answered: D8.** The moves are converted now, anchored.
- **Q2 — answered: D9.** The rollover date is a person field.
- **Q3 — answered: D10.** NORMAL_DATE is added; UNIFORM_DATE stays the default for new rows.

The reasoning as proposed:

- **Q1 — the moves now or later.** Converting `moveDate` and `stateMoveDate` with an anchor
  (phase 4) gives every "when" in a plan one type, and lets a design 116 job end on the same
  date the move happens. It gives the author no new freedom until phase 7. The alternative
  is to leave both as years until part-year tax exists. **Proposal: convert now**, because
  phase 7 then changes only validation and tax, not the data model a second time.
- **Q2 — where the 401(k) rollover date lives.** Today it is one scenario param read for
  every 401(k) owner, and a part left blank falls back to *each owner's* retirement date. So
  a saved year-only setting means different dates for two people, and no single Date can
  hold it. **Proposal: a person field** (`person.<id>.k401ToIraConversionDate`). Migration
  resolves it per person and the result is unchanged. With design 116, separation becomes
  that person's `lastWorkDate`. The cost is that a plan with two owners gets two Opt levers
  where it had one.
- **Q3 — MC distribution for a date row.** Accept UNIFORM_DATE ±2 years, which already
  exists and is what design 25a uses for shocks, and which changes the shape of saved sale-year
  sweeps. Or add a NORMAL_DATE (mean date, standard deviation in days) that keeps the shape
  they have now. **Proposal: add NORMAL_DATE** and convert a saved NORMAL year row into it,
  so a saved MC config keeps its meaning, and keep UNIFORM_DATE as the default for new rows.

## 12. As built — phase 1 (2 Oct 2026)

- **`opt-date.js`** (`src/finance/optimization/`, a leaf). The codec: `dateOrdinal`,
  `ordinalToIso`, `dateSolverView`, `paramCandidate`. A solver view is idempotent, so a
  rollout worker handed the main thread's views rebuilds the same problem.
- **Where the conversion happens.** `OptimizationProblem` turns DATE variables into views in
  its constructor, and turns ordinals back into ISO days in `_applyCandidate`, the one place a
  candidate meets the params. `encode` accepts either an ISO day or an ordinal, so a warm
  start or a committed MPC candidate given as a date works unchanged. `EvalLedger.result()` and
  `GridSearchSolver` report candidates as ISO days, and `best` stays one of the returned
  entries (the cockpit compares them by identity).
- **Solvers.** `isIntegralVariable` (INTEGER or DATE) replaces the INTEGER checks in
  `decode`, `randomCandidate`, `valuesForConfig`, and the pattern-search, annealing and
  random solvers. CEM and QP polish needed no change: CEM reads numeric bounds from the
  views, and QP polish refines CONTINUOUS coordinates only.
- **Harvest.** `optRowFor` and `mcRowFor` have `date` cases, and both are exported for tests.
  `harvestSweepVariables` accepts an unset `sweepUnset` date. `sweepKindOf` checks
  `type: 'Date'` before the `/Year$/` name rule.
- **Monte Carlo.** `NormalDateDistribution` (`normalDate`; `mean` a date, `stdDev` in days).
  Both date distributions take an `anchor` and snap each draw to the nearest anchor date.
  `variablesMissingCenter` checks date centers. A grid DATE axis builds ISO values, and
  `nearestIndex` finds the plan cell by time and never matches a year against a date.
- **Panels.** The Opt row has date bounds and a step in months, or in years with the anchor
  shown. The MC row has a mean-date input for NORMAL_DATE. The MC grid has a date-axis editor.
  Help topics `opt-config` and `mc-config` each gained one paragraph.
- **Tests.** `tests/unit/opt-date.test.mjs` (26) covers the codec, the problem, all five
  solvers on an analytic target date, harvest, distributions, and liveness. The liveness test
  is a real rollout where retiring 18 months later raises net worth. With the conversion
  bypassed, the same two ordinals score identically, so the test fails if the conversion
  breaks. `tests/viz/date-sweep-panels.test.mjs` (7) covers the panels. No golden changed:
  no field is converted yet.

## 13. As built — phase 2 (2 Oct 2026)

- **`year-date-migration.js`** (`src/scenarios/`, a leaf). It converts a sale or purchase
  year to `Y-01-15`, which is the date the toolsets built from it. It covers the records,
  a bequest's inline assets, the typed `cfg.params` list, the flat `cfg.parameters` bag,
  asset entries in a saved `initialState`, and saved MC and Opt rows. A retired flat key in
  the bag goes to the record its typed entry's node names, not to the default record.
- **Where it runs.** Every conversion is idempotent. It runs in `ScenarioLoader.load` (first),
  `applyParamBagToConfig` and `resolveRecordCenters`, because both read a cfg before the
  loader does. It also runs in `BaseScenario.applyParams`, the MC runner and
  `OptimizationProblem` (on their templates and base params), `buildDefaultConfig` (a legacy
  override), the record deserializers (per field), `fromVariableConfigs` (a saved MC row), and
  the scripts' `loadBaseConfig` and `sweep-scenario`.
- **Two names for one sale.** An old MC run recorded both `usHouseSaleYear` and
  `prop.<sk>.plannedSaleYear`: one moved by the lever, one at the plan value. On replay, the
  value that differs from the plan wins. This is the same rule as `reconcileAliasPairs`, so
  an old grid run does not replay as the plan's sale in every cell.
- **The guard.** An asset built with `plannedSaleYear` or `purchaseYear` throws
  (`rejectRetiredYearFields`), so any path that skipped the migration fails loudly. It
  cannot quietly skip a sale.
- **Retired.** `companySaleYear` (static schema param), the `usHouseSaleYear` /
  `auHouseSaleYear` aliases, and `applyRealPropertySaleYearParams`. The company template
  now has `plannedSaleDate` with `mc: false, opt: false`, like the static key it replaces.
  `INTL_RETIREMENT_DEFAULTS` names the sales by their generated keys.
- **Unchanged on purpose.** The purchase price still grows in whole years from the start
  year to the purchase date's year (§7.2). The sale and purchase events fire at UTC
  midnight of the day (`saleDateToUtc`), which for a migrated year is exactly the old
  `Date.UTC(Y, 0, 15)`.
- **Goldens.** 15 fixtures were regolded. A scripted check mapped every
  `plannedSaleYear`/`purchaseYear: Y` in the old fixture to its date field and `Y-01-15`,
  then compared whole states. It found 81 renamed fields and no other difference. The
  golden specs were then moved to the new keys and matched without another regold.
- **Editors.** The real-property, collectible, company-equity and bequest editors author a
  date (`index.html` inputs `type="date"`). The node help topics `real-property`, `company`
  and `collectible`, and the concept `cost-basis-and-equity`, were rewritten and restamped.
- **Tests.** `year-date-migration.test.mjs` (17) and `real-property-sale-date-param.test.mjs`
  (8, replacing the sale-year file) are new. The second includes a sale dated 1 Jul that
  fires on 1 Jul and not in January. The lever-liveness gate (`lever-reaches-loaded-sim`
  LRS-2) used to skip any non-numeric plan value; it now drives date levers too.
  `tests/viz/editors/sale-date-fields.test.mjs` (5) covers the three other editors. Around
  40 test files now author dates. The ones that keep a year are the legacy-input tests,
  on purpose.
- **Smoke run.** A pre-117 export (sale years and a saved `companySaleYear`) went through
  `sweep-scenario --param companySaleYear` (each year moved the result) and
  `variant-grid` with a `saleYear` lever (selling in 2030 vs never moved net liquidity by
  about 1.35M). The run also found that `variant-grid` had been broken since the design
  108 parseFlags migration: its `WORKER` constant was dropped. It is restored.

## 14. As built — phase 3 (2 Oct 2026)

- **Inheritance.** A bequest's `inheritanceYear` and its hidden `inheritanceMonth` (0-based)
  and `inheritanceDay` became one `inheritanceDate`. A saved custom month and day survive:
  year 2030, month 5, day 3 becomes `2030-06-03`. A generated `bequest.<sk>.inheritanceYear`
  param converts with that bequest's own month and day. The SECURE 10-year window still
  counts calendar years: its stream rows carry `inheritanceYear` as the date's year (§7.2).
  `Bequest` throws on any of the three retired fields.
- **The 401(k) rollover (D9).** The three scenario params became each person's
  `k401ToIraConversionDate`, a Person field. It is serialized, generated as
  `person.<id>.k401ToIraConversionDate` (Opt-swept, as the year was), and edited on the
  person form. Migration fills each blank part from that person's own retirement date, which
  is what the toolset did. So a saved year-only or month-only setting names a different day
  per person and still does. All parts blank leaves the field blank, meaning "at
  separation". The legal clamp to the separation date is unchanged.
  `applyParamBagToConfig` passes the cfg's people, so an old bag carrying the params also
  converts per person.
- **Goldens.** No fixture carries these fields, so all 15 matched without a regold.
- **Built-in scenarios.** `inheritanceDate` defaults. A legacy `inheritanceYear` override
  still works, and in the homeowner scenarios an explicit `inheritanceYear: null` still
  means no inheritance, rather than losing to the default date.
- **Tests.** `year-date-migration.test.mjs` gained 8. They cover the per-person resolution
  with two retirement days, idempotency, a person's own date never being overwritten, and a
  liveness test: the generated rollover lever on a loaded plan moves the 401(k) balance. The
  401(k) event tests now author the person's date, and keep two legacy-param tests that run
  through the migration. A smoke run on a legacy export with year 2041 and month 3 set fired
  the two owners' rollovers on 1 Mar and 20 Mar 2041, their own retirement days.
- **Help.** `bequest`, `person` and the concept `roth-conversions` were updated and restamped.

## 15. As built — phase 4 (2 Oct 2026)

- **The moves are anchored dates.** `moveYear` became `moveDate`, always a 1 Jul, and
  `stateMoveYear` became `stateMoveDate`, always a 1 Jan. Both are `type: 'Date'` with a
  `dateAnchor`, and a legacy year converts to that year's anchor day. One table,
  `DATE_ANCHORS` in `year-date-migration.js`, is the source of the anchor days. The schema
  entries, the migration (`dateFromYearFor`, `toDateFor`), the curated Opt rows, the
  harvested MC rows, the Scenario panel editor and the scripts all read it.
- **Rejection (D5).** Both toolsets pass the date through `assertOnAnchor` before scheduling
  the move. A date on any other day throws, and the error names the rule and phase 7, so an
  off-boundary move cannot run with the wrong tax. A bare year is read as its anchor day.
- **Sweeps.** The curated Opt rows are DATE rows that step whole years on the anchor (2026
  to 2035, as before). The harvested MC row is UNIFORM_DATE ±2 years with the anchor on the
  row, so every draw snaps to the day. A saved NORMAL year row becomes an anchored
  NORMAL_DATE, and a saved INTEGER Opt range becomes an anchored DATE range stepping years.
- **Editor.** `dateAnchor` is carried onto the typed param entries, and re-synced as
  schema-owned. The Scenario panel renders an anchored Date param as a year input with
  "on 1 Jul" beside it, so it cannot produce a day the toolset would reject. Blank means no
  move.
- **Goldens.** No fixture carries the moves, so all 15 matched without a regold. The
  move's CHANGE_RESIDENCY event fires at the same instant as before.
- **Scripts.** `variant.mjs` keeps its `moveYear` lever and writes the 1 Jul date.
  `sweep-scenario --param moveYear` (or `moveDate`) sweeps years onto 1 Jul. The probes read
  the move's year from `moveDate`.
- **Tests.** The cross-border tests author `moveDate` and add a rejection test. The
  `mc-grid-runner` reference lever is now `moveDate`, and the `mc-axis-liveness` gate gained
  a `date` nudge; before that it had no case for date rows. `mc-integer-year-rows` keeps the
  integer mechanism on a synthetic row and pins the moves as anchored date rows; W0b-4 now
  checks that a sampled draw snaps to 1 Jan 2032 and moves residency that day. Also added:
  migration tests and a Scenario panel test for the year-only editor. A smoke run on a
  pre-117 export swept `--param moveYear` across 2029 to 2033 (all on 1 Jul) and ran a
  `variant-grid` `moveYear` axis; both moved the result.

## 16. As built — phase 5 (2 Oct 2026)

- **The month clock.** `loan-classes.js` compares and counts in month indexes
  (`year × 12 + month0`). `boundaryMonth(date)` gives a term date's month. Payments fire at
  month-end, so a boundary anywhere in a month takes effect with that month's payment.
  `loanClock(state, loan, date)` is the payment's month, or the tax-period start without
  a date. Every `year >= …Year` test became `clock >= boundaryMonth`, and every
  `(a − b) × 12` became a difference of months. `fixedWindowEndYear` became
  `fixedWindowEndMonth`, `loanYear` became `loanClock`, and `monthsUntilPeriodYear` became
  `monthsUntil`.
- **The fields.** `fixedRateUntilYear`, `interestOnlyUntilYear` and `maturityYear` became
  `fixedRateUntil`, `interestOnlyUntil` and `maturityDate`. The property mirrors
  (`mortgage…`) did the same, through `LOAN_RATE_TERM_FIELDS`. The `postFixedFromYear`
  stamp became `postFixedFromMonth`, the month of the first payment after expiry, which
  for a migrated term is the period start. `fixedExtraYear` still counts the cap's tax
  year (`capYear`).
- **Migration (D6).** A term year converts by its LOAN's country: `Y-01-01` for US and
  `Y-07-01` for AU. Those are the days the period-year engine ended terms on (design 113
  Q6). A saved `postFixedFromYear` becomes `Y × 12 + (AU ? 6 : 0)`. Accounts, property
  mirrors and saved loan state entries are all converted. `deserializePersonsAccounts` now
  runs the migration too, so a caller that deserializes without the loader cannot drop a
  term. Assets throw on the six retired fields.
- **Dates reach every path.** The payment handler passes its date. The offset allocation
  (`effectivePrincipal` → `offsetBalanceForLoan`) and the rental interest deduction
  (`computeRentalMonth`) now take the event date as well, so a mid-period boundary flips
  offset eligibility and the deductible rate in the same month as the payment.
  `pool-metrics` reads the period clock.
- **Goldens.** 3 fixtures were regolded: 6 loan fields, all `maturityYear 2046` and
  `interestOnlyUntilYear null`. The check mapped each by its loan's country: the US loan to
  `2046-01-01`, the two AU loans to `2046-07-01`. Nothing else differed. Separately, each
  homeowner golden rebuilt from a cfg converted back to the old year form runs to an
  identical end state, so an AU term that migrated to the wrong day would fail.
- **Behaviour the year could not express (tests).** FRL-16: a US IO period ending on
  20 May steps up with the May payment and re-amortises over 240 months. FRL-17: an AU
  fixed period can end on 1 Jan, and a migrated AU year still ends on 1 Jul. FRL-15's
  stateless case has no hidden calendar convention any more; the date says when the term
  ends. FRL-7's "window over" case now uses a sale date inside the over-window year,
  because the sale's own date decides.
- **The legacy unanchored IO path** (a saved loan with no `postIoPrincipal`, which the
  compiler always defaults now) counts its remaining months from the payment's month, not
  the period start. TERM-8 still passes, and no golden reaches that path.
- **UI and help.** The account and property editors, the loan rate-terms form and the
  accounts controller author dates; a date field is kept out of the numeric
  normalization. `variant.mjs` keeps `interestOnlyUntilYear` / `maturityYear` as year
  shorthand levers, converted by the loan's country, and accepts the date names. The
  `account` and `real-property` node topics no longer say "1 January". Design 113 Q6 is
  closed: the author states the day.

## 17. As built — phase 6 (2 Oct 2026)

- **The lever is the date.** The real-property template's `mainResidenceFromYear` (a
  `Number` with `fractionalYear: true`) became `mainResidenceFrom`, `type: 'Date'`, still
  `mc` and `opt`, still filed in Cross Border beside `moveDate`. The generated key is
  `prop.<sk>.mainResidenceFrom`, seeded straight from the record's date.
- **Retired.** `FRACTIONAL_YEAR_DATE_FIELDS`, `dateToFractionalYear`, `recordFieldValue`
  and `recordFieldPatch` (`record-field-rounding.js`), and the `fractionalYear` branches
  of `optRowFor` and `mcRowFor`. `mainResidenceFrom` joined `DATE_RECORD_FIELDS`, so both
  cascades write it as `YYYY-MM-DD`, like the sale and purchase dates.
  `fractionalYearToIsoDate` moved into `year-date-migration.js`, where only the migration
  uses it.
- **Sweeps.** The harvested rows are the ordinary date rows: MC UNIFORM_DATE ±2 years,
  Opt and grid DATE ±2 years in 1-month steps. The half-year step could not reach either
  side of §121's 730-day cliff to the month; the month step can.
- **Migration.** `prop.<sk>.mainResidenceFromYear` renames to `prop.<sk>.mainResidenceFrom`
  in the bag, the typed list (key, node field, `type: 'Date'`, the `fractionalYear` flag
  dropped) and saved sweep rows. The value converts as the fraction it was — 2031.5 is
  `2031-07-01`, not a sale's 15 Jan. A saved NORMAL row becomes NORMAL_DATE (σ 1 year →
  365 days); a saved CONTINUOUS Opt row becomes DATE with its 0.5-year step as 6 months.
  The record field was always a date, so no record or state changes.
- **Editor.** The property editor keeps the lever in step with the history dropdown, now
  with the date itself.
- **Help.** The field's prose moved from the `real-property` node topic into the template
  `description`, which tier 1 emits.
- **Goldens.** No fixture sets a move-in date, so all matched without a regold.
- **Tests.** `main-residence-from-lever.test.mjs` was rewritten for the Date lever (4),
  including liveness on a loaded plan for both the new key and an old run's recorded
  fractional key. `year-date-migration.test.mjs` gained 3.
