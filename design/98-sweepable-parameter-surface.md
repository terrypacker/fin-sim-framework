# 98 — The sweepable parameter surface (Monte Carlo + Optimizer)

**Status: REFINED (10 Sep 2026) — wiring track COMPLETE (W0, W1, W0b, W2, W3, W4, W5
BUILT); modelling track M1–M3 is designed and deferred.**

**W5 (built 10 Sep 2026; REMOVED by design 99 P4, same day).** Design 99 retired every
account-level rate W5 diagnosed, so no account can shadow an axis any more and the tags,
chip, provenance field and runner warning were deleted. The record below is historical.
`ROLE_PARAM_OVERRIDES` was exported from
`economic-regimes-toolset.js`. It lists:
- the six wrapper growth rates, with account field `growthRate`;
- `brokerageDividendRate`, via the US-stock account's `dividendRate` and the
  IRA/Roth/401(k) fallback field `dividendYield`;
- `auStockDividendRate`, via the AU-stock account's `dividendRate`.

`collectRoleGrowthRates` now reads the same `ROLE_GROWTH_PARAMS` table the growth rows
come from, so the precedence and its diagnosis cannot drift.
`buildVariables(params, { cfg, accounts })` tags each role row with `shadowedBy` (the
role's accounts whose own field is set, read from the generated param in the bag or else
the record) and `shadowedAll`. Surfaces:
- the MC panel shows a chip: "⚠ N pinned", or "⚠ no effect" in warning colour;
- `summary.provenance.shadowed` carries the tags;
- the runner warns once per run about any enabled `shadowedAll` axis.

MC only, as specified.

Tests: `mc-shadowed-axes.test.mjs` (W5-1…7) and `tests/viz/mc-shadow-chip.test.mjs`. The
config-dependent gate is **MC-LIVE-6**. With the US brokerage's `growthRate` pinned, the
`brokerageGrowthRate` row reports `shadowedAll`, and perturbing it moves zero end-state
fields. Unpinned, the same perturbation moves the end state, so the tag predicts the
deadness.

**W4 (built 10 Sep 2026).** `src/visualization/common/sweep-variable-table.js`
(`SweepVariableTable`) owns grouping, the live filter, collapse and the per-group
`enabled / total` count. `McConfigPanel` and `OptConfigPanel` each keep their own
`_buildVarRow`, and their `_buildVarTable` copies are gone. The three load-bearing
differences from the params panel all hold:
- Every row is built; collapse and filter toggle `hidden`. The CSS rule
  `.sweep-var-body [hidden] { display: none !important }` is needed because the rows
  set `display: flex`.
- A group holding an enabled row opens. That default is recomputed on every render
  until the user toggles the group, after which their choice survives rebuilds.
  Deciding it once per group name failed in testing: it froze the state from the
  constructor's placeholder list.
- The filter matches label, paramKey and group, and force-expands groups with a match.

Tests: `tests/viz/sweep-variable-table.test.mjs` covers:
- collapse keeps an enabled row in `getConfig()` (MC and Opt);
- a row enabled inside a collapsed group is carried, and the count follows;
- the filter force-expands, and matches all three fields;
- a user collapse survives `setVariables()`;
- groups holding an enabled row start open.

Styles are in `config-builder.css`, next to the params panel's group header.

**W3 (built 10 Sep 2026).** `harvestSweepVariables()` (with `sweepKindOf` /
`SWEEP_KINDS`) is in `param-schema-utils.js` and is engine-neutral. Each engine passes
its own W3.4 table as a `rowFor(kind, center, entry)` callback: `mcRowFor` in the MC
config, `optRowFor` in the Opt config. Harvested rows copy label, options and
`visibleWhen` from the schema entry, because generated entries are not in the static
index. They carry `harvested: true` and a `sweepKind`.

Wiring:
- `buildVariables(params, { cfg })` and `buildOptVariables(params, accounts, { cfg })`
  harvest from the static schema plus `ScenarioParamGenerator.generate(cfg)`. They do it
  after the contributors and before the accounts filter / `resolveSweepVariables`.
- The MC runner harvests once, in `_prepare`, against `rawTemplate`. Both presenters
  pass the active cfg.
- `buildStateMoveMcConfigs` is retired: `stateMoveYear` and `moveYear` arrive as
  harvested `year` rows, with `integer: true`.
- Contributor rows with no schema entry carry `synthetic: true`: MC shocks and
  mortality; Opt shocks, expense bands and the Roth schedule.
- SWEEP-10/11 now also run the built lists on the compiled reference config. SWEEP-18
  also rejects unknown explicit kinds.

On the loaded reference plan, MC harvests 14 rows:
- the five bracket/FICA/FEIE index spreads;
- `goldGrowthRate` and `auFixedIncomeInterestRate`;
- `fxVolatility` and `fxReversionSpeed`;
- `moveYear`;
- value and appreciation rate for both houses.

Opt harvests 16. Tests: `sweep-harvest.test.mjs` (W3-1…8). **MC-LIVE-4** checks every
harvested reference row moves the end state; all do, except the two FX knobs, which
FxService ignores while `fxProcessModel` is NONE (the default). They are excluded there,
and **MC-LIVE-5** is their control: under MEAN_REVERTING both knobs move the end state.

The harvest needs a **loaded** cfg: `serializeScenario` drops the `parameters` bag and
an unloaded cfg lacks the generated values, so either one harvests too few rows. The
active cfg in the app is loaded.

Follow-ups (resolved 10 Sep 2026, with the user):
- `primarySsClaimAge` is now `opt: false` until TODO #292: only 67 is modelled, so it
  was harvested as a lever that moves nothing.
- The FX knobs now carry `visibleWhen`: `fxVolatility` for any process other than NONE,
  `fxReversionSpeed` for MEAN_REVERTING only (the only step that reads k). They are
  hidden in the scenario editor too while no process runs. The library plan defaults
  to MEAN_REVERTING, so they show there. The goldens pin NONE, so MC-LIVE-4 now takes
  its rows from `buildGoldenCfg` (the cfg it actually runs) and needs no exclusion.
- `usPrimeRate` / `auPrimeRate` are now `opt: false`, and their curated Opt rows are
  gone (the user chose option A). Design 56 Decision 6 carries the amendment. Prime stays
  an enabled MC axis; `primeSpread` stays an Opt lever. `prime-mc-coherence` MCC-2/MCC-3
  now assert the reverse.

**W2 (built 10 Sep 2026).** The flag rules are in the `record-param-templates.js` header
and the `param-schema-utils.js` module JSDoc. **`mc` flips:** `residencyState` (in both
scenarios that declare it) and `shocks` are off; `moveYear` and `stateMoveYear` are on.
**`opt` flips off (47 entries, static and generated):**
- the F8 list: structured values, identities and bases, the two calendar-minutiae keys,
  and `goldGrowthRate` / `inflationRate` / `auInflationRate` / `fixedIncomeInterestRate` /
  `auCpiRate`;
- plus four groups the user approved on 10 Sep:
  - the dividend rates and `auFixedIncomeInterestRate` (market uncertainties);
  - the employer-set payroll terms (`k401EmployerMatchPct`, `k401NonElectivePct`,
    `superGuaranteePct`), static and `person.*`;
  - model facts and switches (`usFilingSingle`, `mortalityEnabled`, `survivor*Multiplier`,
    `lateLifeCare*`);
  - entries with no type the optimizer can sweep (`guardrailBaseCurrency` Text,
    `person.*.retirementDate` Date — the optimizer has no date variable).

The six wrapper growth rates keep `opt: true` (D3). `usPrimeRate` / `auPrimeRate` keep
`opt: true` for now: they are curated Opt rows and SWEEP-10 requires curated ⊆ flagged.
`buildFullParamSchema()` now keeps the first copy of a duplicate key, as the loader does.
The 21 duplicate pairs were diffed first. Five differed, and the AU_RETIREMENT copy (the
one that loses) was made to match the US copy. The only real identity difference was
`inflationRate`'s label, "AU Inflation Rate", which was wrong in a cross-border plan.
Only `group` may still differ.

New tests: **SWEEP-18** fails any flagged entry that is neither a type the harvest can
build a row for nor offered by a curated row. It was checked as a working detector:
restoring `guardrailBaseCurrency` to `opt: true` fails it, naming the key. **SWEEP-19**
checks the schema has one entry per key, first copy wins.

**W0b (built 10 Sep 2026).** `perturbParams` rounds the sample of any row carrying
`integer: true` before `set()`. The three year rows emitted today (`stateMoveYear`,
`usHouseSaleYear`, `auHouseSaleYear`) carry it, still `enabled: false`, so no default run
moves. `tests/unit/mc-integer-year-rows.test.mjs` checks the effect, not just the flag.
Against the unfixed code, 2,000 State Move Year draws around 2031 landed on an average
effective year of **2030.488**; they now land within 0.1 of 2031. A sampled 2031.9 moves
residency on 1 Jan 2032. The flag survives a panel override, because
`getConfig()` and `buildVariables` spread the contributor row underneath.

**W1 (built 10 Sep 2026).** The four market growth params are declared in
`ECONOMIC_REGIMES.paramSchema()` (group `Market Rates`, `mc`/`opt` false). One frozen
`MARKET_GROWTH_PARAMS` table feeds both the schema and `collectBaseGrowthRates`, in the
original key order, so defaults cannot drift and `baseGrowthRates` stays byte-identical.
`tests/unit/market-growth-params.test.mjs` checks the chain from param to seeded map to
holding rate on the real seeded map. An `EQUITY_AU` lot in the US brokerage moves 6% → 9%
with `auEquityGrowthRate`, while `EQUITY_US` / `EQUITY_INTL_EX_US` lots keep the
brokerage's 5% — the §W1 precedence, pinned. A saved scenario gains the four entries at
their defaults on its next load; no number moves.

**W0 (built 10 Sep 2026).** `mc-param-paths` now treats an own flat key, and any generated
key that cannot be walked, as one flat token; the namespace list moved to the
dependency-free `scenarios/params/generated-param-keys.js` (re-exported by the generator).
`tests/unit/generated-key-param-paths.test.mjs` is the working detector: against the
unfixed `set()` both Opt candidate pairs (`acct.usSavingsAccount.minimumBalance` 0 vs 400k;
`raAsset.inheritedIraAccount.fillCeiling` 40k vs 400k with the bequest armed) returned
byte-identical results; both now differ. MPC audit: no live-actuatable cockpit control
writes a generated key, and every other MPC writer (`mpc-controller`, `cockpit-controller`
commit, `replay`, `harvest-resolve`, `harvest-feasibility`, `apply-forward`) goes through
the same `set()`, so W0 covers them — §7 Q2 closed.

Started as an audit of one question — *are the growth-rate mechanisms duplicated, and is
the MC UI sweeping the right one?* — and the answer generalised. Growth rates are the
motivating case, but the wiring defect underneath them is not about rates at all: **which
params can be swept is declared in the schema, enforced only one way by a test, and
ignored by both sweep engines, each of which keeps its own hand-maintained list.** MC and
Opt have the same defect, the same shape of list, and near-identical panels, so they are
one piece of work.

The refinement pass re-verified every claim against the code and found three things the
first draft missed: dotted generated keys are **dead on the Opt candidate path today**
(F7), the `mc:`/`opt:` flags are **not trustworthy enough to harvest from** (F8), and the
AU stock account's default **total** return is 3 points above every other equity account
(F9).

Related: design 55 §8/§13 (per-account rates, generated params), design 56 §7 (gold),
design 58 (the `::` key convention), design 74 (stochastic return paths), design 75 §4
(property paths), design 84 G2 (derived income), design 90 §7 (the market axis, §7.4
open), design 94 §6 (per-security overlay), `design/inconsistencies.md` §4.10 (dead MC
axes).

**Vocabulary.** `param-schema-utils.js` already has the right word for this: a sweep
variable list is an **overlay** on the param schema. The schema owns *identity* (label,
options, `visibleWhen`) and should own *sweepability*; the overlay supplies *sweep
metadata* (distribution or range, enabled, group). `resolveSweepVariables` already merges
the two, in one direction only. W3 is "let the schema contribute rows too".

---

## 0. Decisions locked (10 Sep 2026)

| # | Question | Decision |
|---|---|---|
| D1 | Are the wrapper spreads deliberate? (was open Q3) | US: **consistent** — every US equity account is 7% total return (§F9). AU stock: **stale** — fix the default in this design (M1). |
| D2 | How does the Opt side harvest, given the flags are over-tagged? | **Audit the flags first (W2), then harvest both engines from them (W3).** |
| D3 | Wrapper growth rates after the anchor axis lands (was open Q1) | **`mc: false`, `opt: true`.** Not an MC axis; still appears *disabled* in Opt through the harvest. |
| D4 | Does the harvest need a third flag? (was open Q2) | **No.** "Listed but not enabled by default" is exactly what a harvested row is. When type inference picks the wrong spread, the flag carries a *kind* string instead of `true` (§W3.4). |
| D5 | Next-session scope | **Wiring track only (W0–W5).** No re-gold, no MC result changes. |

---

## 1. The question

The MC panel's enabled-by-default rate axes are the per-wrapper account growth rates
(Roth / IRA / 401(k) / brokerage / AU stock / super). Separately the codebase has
`RATE_KEYS` — a market axis, a gold key, property sleeves, per-account overrides, a
per-security overlay — none of which appear in that panel.

**Answer: they are not duplicates, they are a precedence ladder, and MC sweeps the one
term inside it that a user editing an account in the UI silently overrides.** Separately,
the axes it does sweep are sampled in a way that cancels most of the uncertainty they
exist to represent.

---

## 2. The ladder — who actually sets a holding's growth rate

`computeHoldingsGrowth` (`src/finance/holdings/holdings-earnings.js:110`), per holding,
resolves a base rate (`:195-199`), highest authority first:

| # | Source | Where it comes from | Reachable from |
|---|---|---|---|
| 1 | `rateOverride` | the handler's one-off `data.rate` | action payload only |
| 2 | `couponRate` | per-holding fixed coupon, **interest path only** | holdings editor |
| 3 | `<holding.rateKey>::<stateKey>` | `seedPerAccountRates` | *seeded, see below* |
| 4 | `<holding.rateKey>` (bare market key) | `collectBaseGrowthRates` | **nothing — F2** |
| 5 | account `fbRate`: `<memberKey>::<stateKey>` → `<memberKey>` → handler `fallbackRate` | seeded / `collectBaseGrowthRates` / `acct.growthRate ?? p.<role>GrowthRate` | account editor / MC |

Then, on top of whichever rate won:

- `state.securityReturnOverlay[securityId]` is **added** (design 94 §6.3, `:213-216`);
- the design 74 sleeve deviation and `RegimeApplyReducer`'s adjustments are already folded
  into `effectiveGrowthRates` by the time it is read;
- `appreciationSchedule` is applied **last** (`:217-219`) and, where it has an entry,
  replaces the rate entirely — including a `rateOverride`.

`seedPerAccountRates` (`economic-regimes-toolset.js:213`) is the choke point that decides
rows 3 and 5 for every account of a known role, in one line (`:240`):

```js
perVal = ownRate ?? roleGrowthRates[acct?.role] ?? baseMap[memberKey];
```

`ownRate` is `account.growthRate`, defaulting to `null` (`assets/account.js:138`).
`roleGrowthRates` is `collectRoleGrowthRates(p)` — the six params MC sweeps. The result is
written to `<memberKey>::<stateKey>` and, by design 90 §7.3, to
`<international market>::<stateKey>` as well (`:258-261`).

So the model is coherent, not duplicated: **wrapper rates are per-account overrides of a
market rate**, exactly as design 90 §7.2 says. Everything below is exposure and sampling.

**The seeded map is also the lever.** `RegimeApplyReducer` rebuilds
`effectiveGrowthRates` from `baseGrowthRates` on every apply
(`regime-apply-reducer.js:68`), and `EquityReturnReducer` adds its deviation onto both the
bare sleeve and every `<sleeve>::*` key (`equity-return-reducer.js:65-77`). Anything
written into `baseGrowthRates` after seeding therefore reaches every equity holding through
regimes and paths alike. M2 uses that.

---

## 3. Findings

### F1 — the `mc:` / `opt:` flags are a one-way test gate, not wiring

Every schema entry carries `mc:` and `opt:`, including generated per-record ones
(`record-param-templates.js:77` marks `growthRate` `mc: true`). **No runtime code reads
either flag.** The only readers are two tests:

- `param-sweep-schema.test.mjs:298` **SWEEP-10** and `:309` **SWEEP-11** assert that every
  *curated* overlay entry is flagged (overlay ⊆ flagged), resolving legacy aliases and
  building the eligibility index from a *compiled* config (static schema +
  `ScenarioParamGenerator.generate(cfg)`). `KNOWN_ORPHANS` is empty.

The converse — flagged ⇒ offered — is enforced by nothing. Both real lists are
hand-maintained arrays: `DEFAULT_MC_VARIABLE_CONFIGS` plus four contributors, and
`DEFAULT_OPTIMIZATION_CONFIGS` plus four. So `mc: true` reads as wiring and is only
eligibility, and it has already misled a comment: `intl-retirement-opt-config.js:314-317`
says the inherited-RA knobs are "opt-able via the generated schema rather than hand-listed
here", while `buildInheritedRaOptConfigs` (`:534`) hand-lists them 220 lines further down
(and per F7 they do nothing anyway).

### F2 — the market axis has no params at all

`collectBaseGrowthRates` (`economic-regimes-toolset.js:90`) reads four keys:

```js
[RATE_KEYS.EQUITY_US]:         p.usEquityGrowthRate       ?? 0.07,
[RATE_KEYS.EQUITY_AU]:         p.auEquityGrowthRate       ?? 0.06,
[RATE_KEYS.EQUITY_INTL_EX_US]: p.intlExUsEquityGrowthRate ?? 0.07,
[RATE_KEYS.EQUITY_INTL_EX_AU]: p.intlExAuEquityGrowthRate ?? 0.07,
```

None of the four is declared in any `paramSchema()`: not editable, not sweepable, not
settable from a scenario's params bag through the normal path. The market axis runs at
four hardcoded constants.

It is mostly invisible because every account of a known role is seeded at rows 3/5, so it
never falls through to the bare key. The exposure is the **Rate Key picker**
(`rate-key-options.js`), which lets a user select a series whose level nobody can set.
Choosing `EQUITY_AU` on a lot in a US brokerage today changes its beta, its shock target
and its reporting bucket, and — because the US account is seeded only for `EQUITY_US` and
`EQUITY_INTL_EX_US` — gives it the hardcoded 6%. Design 90 §7.4 names this as open; this
is the parameter half of it.

### F3 — six equity axes, sampled independently, cancel each other out

`perturbParams` (`monte-carlo/parallel/mc-worker-core.js:69-82`, moved there by the
worker refactor) samples every enabled axis from its own distribution:

```js
set(perturbed, cfg.paramKey, createDistribution(cfg).sample(rng));
```

Six of the enabled-by-default axes are equity growth rates (`rothGrowthRate`,
`iraGrowthRate`, `k401GrowthRate`, `brokerageGrowthRate`, `auStockGrowthRate`,
`superGrowthRate`), each `NORMAL` with `stdDev: 0.03`, drawn independently.

These are six wrappers holding, in substance, one asset class. Independent draws make
*portfolio* drift uncertainty `0.03 × sqrt(Σwᵢ²)` — at equal weights `0.03/√6 ≈ 0.012`.
**The run reports six 3% axes and delivers about 1.2% of portfolio-level equity
uncertainty, and gets narrower the more wrappers the equity is split across.** Which
wrapper an index fund sits in has no bearing on how uncertain the fund's return is.

Two more enabled axes have the same shape in miniature: `brokerageDividendRate` and
`auStockDividendRate` are **additive** total return on two accounts (§F9), each drawn on
its own.

### F4 — two mechanisms, two different questions, only one on

Not duplicates; they compose:

- **Anchor uncertainty** — "what is the long-run mean return?" — the MC growth axes. One
  draw per iteration, flat for the whole run.
- **Sequence risk** — "in what order do the years arrive?" — the design 74 path
  (`equityReturnStochastic`), with a shared market factor, per-sleeve betas, idio vol.

Today `equityReturnStochastic` defaults to **false** and `equityReturnVol` sits in the MC
list as `enabled: false`. The default run measures only anchor uncertainty, in the shape
F3 describes; the mechanism with the correct correlation structure is the one that is off.

Composition hazard: with both on, the anchor axes' 3% is currently doing duty as a proxy
for *total* return uncertainty, so turning the path on without re-basing double-counts
(M3).

### F5 — a per-account Growth Rate silently voids the swept axis

`perVal = ownRate ?? roleGrowthRates[role] ?? …`. The account editor exposes Growth Rate
(`acct.<stateKey>.growthRate`), and the generated param is `mc: true` — which reads as "MC
handles this", but per F1 no consumer exists and no contributor emits it.

So a user sets a Growth Rate on their brokerage; that account is now pinned. MC keeps
listing `brokerageGrowthRate` as enabled, keeps sampling it, and the sampled value reaches
nothing. The distribution narrows and the report still names the axis as a source of
uncertainty — the §4.10 failure exactly. The dividend axes have the same hole:
`acct.dividendRate ?? p.brokerageDividendRate` (`us-retirement-toolset.js:1244`).

`tests/unit/mc-axis-liveness.test.mjs` cannot catch it: it runs the reference plan, where
every `account.growthRate` is `null`. The gate is correct; the config that breaks the axis
is one the gate never sees. **A liveness gate for a config-dependent lever has to run
against the loaded config, not a reference one** (W5).

### F6 — the schema/overlay gap, measured

Measured against `IntlRetirementScenario.buildFullParamSchema()` and a compiled reference
config (the SWEEP-10/11 method), 10 Sep 2026.

**Static schema:** 203 entries, 36 `mc: true`, 125 `opt: true`. The `mc: true` entries
the MC panel does not offer:

| Key | Why it matters | Harvestable as-is? |
|---|---|---|
| `goldGrowthRate` | the whole gold sleeve's drift; MC-immune | yes |
| `auFixedIncomeInterestRate` | US side has `fixedIncomeInterestRate`; AU does not | yes |
| `auCpiRate` | AU CGT indexation and bracket indexation | default is `undefined` (tracks AU inflation) — skipped until set |
| `fxVolatility`, `fxReversionSpeed` | the FX process (design 92) | yes |
| `usFederalBracketIndexSpread`, `usStateBracketIndexSpread`, `auBracketIndexSpread`, `usFeieCapIndexSpread`, `usFicaWageBaseIndexSpread` | fiscal-drag axes | yes |
| `ageBandDeclineRate` | `visibleWhen`-gated, default `null` | only when set |
| `residencyState` | string enum; no categorical distribution exists | **no — flag is wrong (W2)** |
| `shocks` | an array; per-shock rows come from `buildShockMcConfigs` | **no — flag is wrong (W2)** |

**Generated per-record params** on the reference plan: 77 entries, 39 `mc: true`, 31
`opt: true`. By field:

| Field | `mc` rows | Status today |
|---|---|---|
| `acct.*.balanceTarget` (hidden) | 14 | reached through the 13 legacy balance aliases |
| `acct.*.growthRate` | 12 | **not offered**; value is `null` unless the account is pinned |
| `acct.*.dividendRate` | 4 | **not offered** |
| `person.*.monthlyWage` | 2 | reached through `primaryMonthlyWage` / `spouseMonthlyWage` aliases |
| `prop.*.value`, `prop.*.appreciationRate` | 2 + 2 | **not offered** |
| `prop.*.plannedSaleYear`, `coll.*.plannedSaleYear` | 2 + 1 | houses via aliases; the collectible **not offered** |

Two consequences worth naming separately:

- **Property appreciation is not sweepable per property.** `buildRealPropertyMcConfigs`
  emits sale *years* only. The only housing-return axis is `propertyReturnIdioScale`,
  `enabled: false` and inert unless `propertyReturnStochastic` is on. On a plan where a
  house sale funds retirement, the house's appreciation rate is a fixed input.
- **Nothing at the security or holding level is sweepable**, so the design 94
  per-security overlay and per-holding `rateKey` are single-run-only levers. (Out of scope
  here; the harvest makes it addable later without a new mechanism.)

The Opt list has the same structure; its gap is larger and mostly noise (F8).

### F7 — dotted generated keys are dropped by `set()`: four Opt axes are dead today

`mc-param-paths.js` `get()` (`:76`) and `set()` (`:92`) split a path on `.` and `[`, and
`set()` never creates an intermediate node. A generated key is a **flat** token in
`cfg.parameters` — `acct.usSavingsAccount.minimumBalance` is one key, not three levels.
Probe:

```js
const o = { 'acct.usSavingsAccount.minimumBalance': 1 };
get(o, 'acct.usSavingsAccount.minimumBalance');    // → undefined
set(o, 'acct.usSavingsAccount.minimumBalance', 5); // → no-op; o unchanged
```

The Opt candidate path is `OptimizationProblem._applyCandidate`
(`optimization-problem.js:317`) → `set()`. So every Opt row keyed on a generated key is
listed, toggleable, costs CEM budget when enabled, and never reaches the sim:

- `acct.usSavingsAccount.minimumBalance`, `acct.auSavingsAccount.minimumBalance`
  (`DEFAULT_OPTIMIZATION_CONFIGS`);
- `raAsset.<stateKey>.fillCeiling`, `raAsset.<stateKey>.lumpYear`
  (`buildInheritedRaOptConfigs`). EVT-63 asserts the rows *exist*, not that they move
  anything.

MC has no casualty today only because its overlay deliberately uses flat legacy aliases to
dodge exactly this (`intl-retirement-mc-config.js:201-208`). Its `buildVariables` still
calls `get()` for the center, so any dotted row would center on the template default and
report `centerSource: default`.

**The loader side is already correct.** `applyParamBagToConfig` writes the flat bag, and
`ScenarioLoader`'s third cascade pass (`scenario-loader.js:~637`) decodes flat generated
keys from `cfg.parameters` straight onto their records. Only `get`/`set` are wrong, which
means the first draft's "generated per-record keys come along for free" was false until W0
lands. (Mechanism previously recorded for design 58's `drawdownWeight::<role>`; that fix
chose `::` keys. Generated keys are fixed-format, so the fix here goes in `get`/`set`.)

### F8 — the flags were never read, so nothing kept them honest

A harvest turns every flag into a visible row, so the flags have to be right first.
Today, among `opt: true` entries with no overlay row (≈65 after de-duplication):

- **Structured values:** `expenseEvents`, `spendingAgeBands`, `spendingExpenseBands`,
  `shocks`, `allocationGlidepath`, `allocationRegimeTargets`,
  `rebalanceTargetAllocation` — arrays/objects; none has a range. (Their scalar
  sub-fields already get rows from dynamic contributors where that makes sense.)
- **Identities and bases, not decisions:** `stockBasisUS`, `stockBasisIntl`,
  `stockSplitRatio`, and the generated `acct.*.contributionBasis` (8 rows).
- **Calendar minutiae:** `k401ToIraConversionMonth`, `k401ToIraConversionDay`.
- **Plan-input rates:** the six wrapper growth rates, `goldGrowthRate`, `inflationRate`,
  `auInflationRate`, `fixedIncomeInterestRate`, `auCpiRate` — uncertainties, not choices
  (D3 keeps the wrapper rates `opt: true` deliberately; the rest are judged in W2).

And among `mc: true`: `residencyState` (string) and `shocks` (array), per F6.

Separately, **21 static keys appear twice in `buildFullParamSchema()`** (`inflationRate`,
`monthlyExpenses`, the `spending*`/`guardrail*`/`survivor*`/`lateLifeCare*` family — the
US and AU retirement toolsets both contribute them). `ScenarioLoader._mergeParamSchema`
keeps the **first** (`:979`); `indexParamSchema` keeps the **last**. Harmless while
identity is the only thing read from the index and the copies match; not harmless once the
harvest emits rows from it.

### F9 — AU stock's default total return is 10%, every other equity account's is 7%

Dividends are two different things depending on the account:

- **Brokerage and AU stock** pay dividends through their own handlers
  (`DividendScheduledHandler`, `IntlAuStockDividendHandler`) **on top of** growth — additive.
- **Roth / IRA / 401(k)** carry `dividendYield`, which `computeHoldingsGrowth` carves out
  **of** the same return as `derivedAmount` (design 84 G2, `holdings-earnings.js:222-233`)
  — the total is unchanged.

So the library defaults (`INTL_RETIREMENT_DEFAULTS`, `intl-retirement-scenario.js:546-602`)
give:

| Account | Growth | Dividend | Total |
|---|---|---|---|
| Roth / IRA / 401(k) | 7% | (carve-out) | **7%** |
| US brokerage | 5% | 2% additive | **7%** |
| Super | 7% | — | **7%** |
| AU stock | 6% | 4% additive | **10%** |

The US spread that looked like "Roth 7% vs brokerage 5%" is a price-vs-total-return split,
not a difference in what the accounts hold — which is exactly the assumption M2 needs. The
AU stock row is the outlier: 6% was carried over verbatim from the retired
`EQUITY_AU_STOCK` member key while the separate 4% franked-yield handler sits beside it.
D1: stale; fixed in M1.

### F10 — sampled years are truncated, not rounded (found 10 Sep 2026)

MC samples year-valued axes from a continuous distribution (`NORMAL`, sd 1.5) and
`perturbParams` writes the raw float. Consumers turn a year into a date with
`Date.UTC(year, …)`, which **truncates**: `Date.UTC(2031.9, 6, 1)` and
`Date.UTC(2031.4, 6, 1)` are both 1 Jul 2031 (verified). A symmetric draw around 2031
therefore lands on years whose mean is about 2030.5 — the axis runs half a year early.

- **Live today on `stateMoveYear`** (`buildStateMoveMcConfigs`; consumed at
  `us-state-tax-toolset.js:159`). Its comment says "the runner rounds to integer";
  nothing does.
- **Not the house sale years**: `applyRealPropertySaleYearParams` rounds
  `usHouseSaleYear` / `auHouseSaleYear` (`intl-retirement-scenario.js:1812-1814`) — the
  only rounding anywhere on the MC path.
- **Would hit `moveYear`** (`us-au-cross-border-toolset.js:271`) the moment it becomes an
  MC row, and every harvested `prop.*` / `coll.*.plannedSaleYear` in W3.
- Opt is unaffected: `decode` rounds `INTEGER` variables.

Two flag errors sit beside it: `stateMoveYear` is `mc: false` yet has a contributor row
(SWEEP-11 only checks the static overlay, so it never saw it), and `moveYear` is
`mc: false`, which is why it is not an MC axis at all.

---

## 4. The wiring track (next session) — no numeric effect

Each step is its own commit. None changes a golden number; W1 may add four entries to a
fixture that captures the param list, and that diff must be exactly those four keys.

### W0 — generated keys are flat tokens in `mc-param-paths` (F7)

In `get()` and `set()`: **a path for which `isGeneratedParamKey(path)` is true is a single
flat key** — read and written as `obj[path]`, never parsed.

- Deterministic, not heuristic: `GENERATED_KEY_PREFIXES` (`scenario-param-generator.js:42`)
  is the closed set `acct.` `person.` `prop.` `coll.` `equity.` `bequest.` `raAsset.`, and
  no nested param path starts with one (`people.<key>.lifeExpectancy` is `people.`, not
  `person.`). The test must pin that last claim by walking the nested paths the dynamic
  contributors emit.
- Import `isGeneratedParamKey` from `scenarios/params/scenario-param-generator.js`;
  `intl-retirement-mc-config.js` already depends on `scenarios/`, so this adds no new
  layer crossing.
- **Also audit** the MPC `control.actuate` path for the `raAsset.*` controls
  (`controllable: true`) — it does not go through `_applyCandidate`, so W0 may or may not
  cover it.

Tests (new `tests/unit/mc-param-paths-generated-keys.test.mjs`):

1. `get`/`set` round-trip a flat `acct.x.minimumBalance`, including when the key is
   absent from the object (set must create it — a candidate key need not pre-exist).
2. Nested paths are unchanged: `people.primary.lifeExpectancy`, `shocks[0].severity`,
   `spendingExpenseBands[1].monthlyAmount`, `drawdownWeight::roth-ira`.
3. **Working-detector liveness** on the Opt compile path: two candidates differing only
   in `acct.usSavingsAccount.minimumBalance` produce different end states through
   `OptimizationProblem` — and the same pair differed by *nothing* before the fix (run it
   once against the unfixed code and note that in the commit). Same for
   `raAsset.<sk>.fillCeiling` on the EVT-63 inherited-RA fixture.
4. MC: a dotted row's center resolves to `centerSource: scenario`.

### W1 — declare the four market growth params (F2)

In `ECONOMIC_REGIMES.paramSchema()`, beside `collectBaseGrowthRates`:

| Key | Default | Label |
|---|---|---|
| `usEquityGrowthRate` | 0.07 | US Equity Market Growth Rate |
| `auEquityGrowthRate` | 0.06 | AU Equity Market Growth Rate |
| `intlExUsEquityGrowthRate` | 0.07 | International ex-US Equity Growth Rate |
| `intlExAuEquityGrowthRate` | 0.07 | International ex-AU Equity Growth Rate |

- `mc: false, opt: false`. These are plan inputs, and sweeping them would reach almost
  nothing (every account of a known role overrides them at the seed); the systematic MC
  axis is M2's `equityAnchorShift`.
- Group: a new `Market Rates` group, so the Rate Key picker's series have a visible home.
- Description must say what they govern **honestly**: holdings whose `rateKey` names a
  market *outside* their account's own seeded pair, and accounts with no role member key.
  Accounts of a known role use their own/role rate for both their domestic and
  international market.
- Toolset-contributed, so `buildDefaultConfig`'s passthrough forwards them with no
  enumerated-block change (see `_toolsetParamKeys`).
- Test: an `EQUITY_AU` lot in a US brokerage moves when `auEquityGrowthRate` changes; an
  `EQUITY_US` lot in the same account does not.

### W0b — round year-valued MC samples (F10)

A prerequisite for any new year axis (`moveYear`, the harvested sale years), and a fix
for the one already live (`stateMoveYear`).

- **The row declares it.** A sweep row carrying `integer: true` has its sample rounded in
  `perturbParams` (`mc-worker-core.js`) before `set()`, so `r.params` records the value
  the sim actually ran and replay applies the same integer. Set it on
  `buildStateMoveMcConfigs` and `buildRealPropertyMcConfigs` rows now; W3's harvest sets
  it on every `year`-kind row (W3.4). An explicit flag, not a key-name guess at sampling
  time — the inference lives in one place (the harvest), and the sampler stays dumb.
- Fix the `buildStateMoveMcConfigs` comment that claims the runner rounds.
- `applyRealPropertySaleYearParams` keeps its own `Math.round` — harmless, and the
  headless/library path still relies on it.
- Numbers: no default run moves (every year row ships `enabled: false`). An MC run with
  State Move Year enabled shifts its moves about half a year later — toward the center
  it claimed to be sampling.

Tests: an `integer: true` row samples integers; 2,000 draws around 2031 average within
±0.1 of 2031 (the unfixed code averages about 2030.5 — run it once against the unfixed
code, as W0 did); the state-move row carries `integer: true`; a sampled 2031.9 moves state
residency on 1 Jan 2032, not 2031.

### W2 — audit the flags (F8)

The rules the flags mean from now on (write them into the `record-param-templates.js`
header and the `paramSchema()` JSDoc so they stay true):

- **`mc: true`** — a *scalar* (Number, Integer, Money, Date) whose value is **uncertain at
  plan time**: a rate, level, volatility, timing or amount the household does not control.
- **`opt: true`** — a *scalar or enum* (including Boolean) the household **chooses**.
- **Neither** — arrays/objects (their scalar parts get dynamic-contributor rows),
  identities and bases, calendar minutiae, and anything whose change is a data correction
  rather than a what-if.

Deliverables:

1. Flip the offenders listed in F8 (and anything else the rules catch) — expect ~40 `opt`
   flips off, and 2 `mc` flips off (`residencyState`, `shocks`). Do **not** flip the six
   wrapper growth rates' `mc` yet: they are still curated MC rows until M2, and SWEEP-11
   requires curated ⊆ flagged.
2. Flip 2 `mc` **on** (F10), both after W0b:
   - `moveYear` — the cross-border move year becomes an MC axis (requested 10 Sep 2026).
     It is uncertain at plan time exactly like the sale years already are. Opt keeps it.
   - `stateMoveYear` — already an MC row (`buildStateMoveMcConfigs`); its `mc: false` was
     simply wrong.
3. De-duplicate `buildFullParamSchema()` **first-wins**, matching the loader. Before
   changing it, diff each of the 21 duplicate pairs; if any pair differs in `label`,
   `visibleWhen`, `options` or flags, reconcile the pair at source in the same commit and
   say which copy won.
4. New test **SWEEP-18**: every flagged entry (static + generated on the compiled
   reference config) has a harvestable type for its engine. This is the gate that keeps
   the flags honest once W3 makes them visible.

### W3 — the shared harvest (§9.1 of the first draft, revised)

Add `harvestSweepVariables()` to `param-schema-utils.js`, beside `resolveSweepVariables`,
called by `IntlRetirementMcConfig.buildVariables` and `buildOptVariables` **after** their
contributors and **before** `resolveSweepVariables`.

**W3.1 — the schema it reads.** Static schema (de-duplicated, W2) **plus the generated
schema for the loaded config**: `ScenarioParamGenerator.generate(cfg)`. Typed `cfg.params`
entries are not enough — `_mergeParamSchema`'s `_toEntry` does not copy `mc`/`opt`
(`scenario-loader.js:1005-1033`). Both call sites need the cfg:

- MC: `buildVariables(params, { cfg, accounts })`. The runner's `_prepare` has
  `rawTemplate`; the presenter's `_resolveVariables` has the active cfg. Harvesting happens
  once, on the main thread, in `_prepare`; workers receive resolved `variables` and need no
  change.
- Opt: `buildOptVariables(params, accounts, { cfg })`; the presenter already passes
  `accounts`.
- A `cfg` of `null` (library callers) harvests the static schema only.

**W3.2 — which rows it emits.** A schema entry flagged for the engine becomes a row when
all of these hold:

1. it is not `hidden` (the balance levers stay on their curated alias rows);
2. it is not already **covered** — covered = the overlay's keys **plus the alias targets
   of those keys** (`INTL_RETIREMENT_PARAM_ALIASES`). Without alias awareness,
   `person.primary.monthlyWage` and `prop.usHouseProperty.plannedSaleYear` would appear
   twice;
3. its value **resolves to a non-null scalar in the base bag**. No synthesized centers —
   a harvested row whose value is absent or `null` is not emitted. This matters twice:
   `perturbParams` writes a disabled row's reference value when the key is absent from
   the base (`mc-worker-core.js:76-78`), so a synthesized center would be *written into the
   run*; and a `null` `acct.*.growthRate` means "inherit the role rate", which has no
   center of its own. Precedent: `buildRealPropertyMcConfigs` already skips null sale
   years.

Point 3 has a useful consequence for F5: an account's `growthRate` row appears exactly
when the account is pinned — which is exactly when the role axis stops reaching it. The
live lever surfaces the moment the shadowed one dies.

**W3.3 — rows are always `enabled: false`**, grouped under their **schema** `group`
(e.g. `US · Roth IRA`). Curated rows keep their overlay group.

**W3.4 — default spreads (MC) and ranges (Opt).** Inferred per row, overridable by a kind
string in the flag (`mc: 'rate'`, `opt: 'year'` — D4):

| Kind | Inferred when | MC default | Opt default |
|---|---|---|---|
| `year` | Integer, or key ends in `Year` | `NORMAL`, sd 1.5 | center ± 5, step 1 |
| `rate` | Number with \|center\| ≤ 1 | `NORMAL`, sd = the larger of 0.005 and 20% of \|center\| | center ± 0.02, step 0.005, clamped ≥ 0 when center ≥ 0 |
| `amount` | Money, or Number with \|center\| > 1 | `NORMAL`, sd 10% of \|center\| | center × [0.5, 1.5], ~10 steps |
| `enum` | Enum / Boolean | — (no categorical distribution) | all options / `[false, true]` |
| `date` | Date | `UNIFORM_DATE` ± 2 years | — |

The `rate` rule wrongly covers a scale centered at 1.0 and a volatility centered at 0.11,
for example; those entries declare their kind explicitly. SWEEP-18 checks that an explicit
kind is one of the table's.

**W3.5 — orphans stay a test-time gate.** The first draft asked for a build-time error on
overlay rows with no schema entry. On inspection that is SWEEP-10/11's job and they already
do it, with alias resolution, against a compiled config. The runtime orphans are the
dynamic contributors' rows (`shocks[i].*`, `people.<k>.lifeExpectancy`,
`spendingExpenseBands[i].*`, `rothConversionSchedule[i].*`), which are legitimately
schema-less. So: mark contributor rows `synthetic: true`, and extend SWEEP-10/11 to run the
**contributors** on the reference config too — any non-synthetic row without a schema entry
fails. (The `console.warn` at `intl-retirement-mc-config.js:540` is about unresolvable
array paths, not orphans; it stays.)

**W3.6 — expected size.** After W2 on the reference plan: MC gains roughly 10–15 rows
(the F6 static list minus the two bad flags and the unset ones, plus property value /
appreciation and the collectible sale year; per-account growth rates only where pinned).
Opt gains roughly 30–40. Both panels need W4 before this is pleasant; W3 may land first
because every new row is disabled.

**W3.7 — what it replaces: the hardcoded year contributors.** Requested 10 Sep 2026
("Property sale year missing from MC? Tie the param schema more directly to the UI") —
which is W3 in one sentence.

- `buildRealPropertyMcConfigs` emits exactly two rows, `usHouseSaleYear` and
  `auHouseSaleYear`, whose aliases point at the **reference plan's** stateKeys
  (`usHouseProperty`, `auHouseProperty`). A property with any other stateKey gets no
  sale-year row; the collectible's `coll.*.plannedSaleYear` never had one. The harvest
  emits one `prop.<sk>.plannedSaleYear` / `coll.<sk>.plannedSaleYear` row per record with
  a set year (`mc: true` already; skip-null keeps "only when set"). The two legacy rows stay
  for saved configs, and alias-aware coverage (W3.2 point 2) keeps them from doubling.
- `moveYear` (flipped on in W2) arrives the same way, as a `year`-kind row centred on the
  plan's year.
- With `stateMoveYear` flipped on in W2, `buildStateMoveMcConfigs` duplicates what the
  harvest now emits; retire it in the same commit.
- Every `year`-kind row carries `integer: true` (W0b). Without it, each of these new axes
  would run half a year early (F10).
- Extending SWEEP-10/11 to the contributors (W3.5) is the check that would have caught
  `stateMoveYear`'s wrong flag.

**Tests:** `intl-retirement-mc-config.test.mjs` / `param-sweep-schema.test.mjs` —

- a flagged scalar with no overlay row appears disabled, centered on the scenario value,
  `centerSource: scenario`;
- a flagged key whose value is `null` does not appear; pin an account's `growthRate` and
  its `acct.<sk>.growthRate` row appears;
- an alias-covered generated key does not appear twice;
- `hidden` entries never appear;
- the runner's `provenance` counts harvested rows under `scenario`, never `default`;
- **liveness of the harvest**: enabling each harvested MC row on the reference config
  moves the end state (extend `mc-axis-liveness` to iterate `buildVariables()` output
  rather than `DEFAULT_MC_VARIABLE_CONFIGS`, with the existing exclusion for
  stochastic-process knobs).

### W4 — a shared sweep-variable panel: filter + collapsible groups

`McConfigPanel` and `OptConfigPanel` already share the shape (`setVariables` →
`_buildVarTable` groups by a `Map` and emits a header per group, `_snapshotState`
preserves edits). Factor the table into a shared base — e.g.
`src/visualization/common/sweep-variable-table.js` — that owns grouping, filtering and
collapse; each panel keeps its own `_buildVarRow`. The model is the params panel's
(`scenario-tab-view.js:75-82`, `_renderParamsList` `:310-336`): live substring filter,
per-group collapse, `_expandedGroups`, an active filter force-expanding matches.

Three differences from that precedent, each load-bearing:

1. **Build every row; toggle `hidden` on collapse/filter.** `getConfig()` reads state from
   `_rowMap` and falls back to the row's *original* config when a row was never built
   (`mc-config-panel.js:209-210`). If a collapsed group didn't build its rows, a user who
   enabled an axis and then collapsed its group would silently run without it.
2. **A group containing an enabled row starts expanded**, and every group header shows
   `enabled / total`. Collapsed-by-default is right for 60 rows and wrong for the 15 that
   will actually be sampled.
3. Filter matches `label`, `paramKey` and `group`.

Tests in `tests/viz/`: collapse + `getConfig()` round-trip keeps an enabled row enabled;
filter force-expands; enabled-row groups start open.

### W5 — shadowing made visible (F5)

`buildVariables(params, { cfg, accounts })` tags each role-level row that a per-account
field can override:

- `shadowedBy: [stateKey…]` — accounts of that role with a non-null override field;
- `shadowedAll: true` — when that is **every** account of the role (the axis is dead).

The mapping comes from **one exported table** in `economic-regimes-toolset.js`, beside
`collectRoleGrowthRates`, so the precedence and its diagnosis cannot drift apart:

| Role param | Roles | Account field |
|---|---|---|
| `rothGrowthRate` … `superGrowthRate` (the six) | per `collectRoleGrowthRates` | `growthRate` |
| `brokerageDividendRate` | `US_STOCK` | `dividendRate` |
| `auStockDividendRate` | `AU_STOCK` | `dividendRate` |

(`brokerageDividendRate` is also the IRA/Roth/401(k) carve-out yield fallback,
`acct.dividendYield ?? p.brokerageDividendRate`; add those rows with field `dividendYield`.)

Surfaces: the MC panel renders a warning chip beside the row (same slot as the
`centerSource` tag); `summary.provenance` carries `shadowedBy`; the runner `console.warn`s
an enabled `shadowedAll` axis once per run. MC only — the Opt list offers no role rates by
default.

**Test — the config-dependent liveness gate F5 asked for:** on the reference config with
the US brokerage's `growthRate` pinned, (a) the `brokerageGrowthRate` row reports
`shadowedAll: true`, **and** (b) perturbing it moves zero end-state fields — while the
unpinned control moves some. The tag must predict the deadness, not just coexist with it.

---

## 5. The modelling track (deferred) — re-bases results

Each step is its own commit with a re-gold, and each needs its before/after written up.
Per standing practice, ship the code and the comparison tooling; do not block the commit
on a long MC re-run.

### M1 — fix the AU stock default to a 7% total return (F9, D1)

`auStockGrowthRate` default **0.06 → 0.03**, keeping the 4% franked yield (the realistic
component; a 4% ASX yield is the reason the handler exists). Every place the default
lives:

- `INTL_RETIREMENT_DEFAULTS.auStockGrowthRate` (`intl-retirement-scenario.js:601`);
- the `auStockGrowthRate` schema `defaultValue` (`au-retirement-toolset.js:260`);
- the `collectRoleGrowthRates` fallback `?? 0.06` (`economic-regimes-toolset.js:133`);
- `au-single-homeowner-scenario.js:123`;
- the MC overlay mean follows `D.auStockGrowthRate` automatically.

A saved scenario that carries its own `auStockGrowthRate` keeps it; this corrects the
library default, not anyone's plan. Independent of M2; can land any time.

Expected effect: the AU stock account's terminal value falls; the reference plan's
terminal net worth falls by roughly that account's share × 3 points compounded. Re-gold
and record the delta.

**BUILT 10 Sep 2026.** Two corrections to the site list above, found while building:
the schema `defaultValue` was **0.07**, not 0.06, so the editable default and the
library default already disagreed; and the `collectRoleGrowthRates` fallback is now the
`ROLE_GROWTH_PARAMS` table (`economic-regimes-toolset.js:155`). All four sites are 0.03,
and the schema description now says the rate is price only, with the dividend paid on top.

Terminal net worth, before → after (12 of the 27 goldens moved; all falls):

| Golden | Before | After | Change |
|---|---|---|---|
| `cross-border-reference` | 12,034,152 | 11,841,449 | −1.60% |
| `cross-border-disposals` | 7,097,258 | 7,062,779 | −0.49% |
| `au-single-homeowner` | 7,741,875 | 4,249,136 | **−45.1%** |
| `au-super-streams` | 1,508,166 | 1,472,302 | −2.38% |
| the other eight (`payroll-limits`, bonds/TIPS, speculative, wash-sale, concentration) | | | −0.13% to −0.37% |

`au-single-homeowner` is the one to read. Both its AU brokerage accounts (`auStockAccount`
and the 2036 inheritance) carry the AU_STOCK role, so both were compounding at a 10% total.
Its super balance is unchanged until about 2050, then diverges:

| Year | Inherited brokerage, 6% / 3% | Super, 6% / 3% |
|---|---|---|
| 2046 | 398k / 293k | 1,696k / 1,696k |
| 2054 | 867k / 509k | 1,751k / 1,595k |
| 2062 | 1,892k / 882k | 1,735k / 858k |
| 2066 | 2,794k / 1,161k | 1,876k / 204k |

At 10% the inherited brokerage covered retirement spending out of its own return, so super
was never drawn down. At 7% it cannot, and the cascade draws super nearly to zero by the
horizon. That is the finding, not a defect: the old fixture was a plan living on the
stale assumption. The effect is large because the account is inherited mid-plan and held
for 30 years (1.03³⁰ ≈ 2.4×).

Other consumers moved:

- The design 52 lock-in (`cross-border-relief-scenario.test.mjs`) was re-based, with the
  history recorded in its comment. Lifetime tax 799,954 → 793,691; net worth −1.63%.
- `drawdown-security-order.test.mjs` needs spending that partly consumes the US brokerage
  sleeve. Less AU stock drains it sooner, so `monthlyExpenses` went 13,000 → 12,800. The band
  is narrow: the draw must exceed the whole ~53k ex-US lot, yet the control must leave the
  employer lot under 50k. 12,700 falls short on the first; 13,000 empties the employer lot.

Not changed, and left open: the **bare** market default `auEquityGrowthRate` (W1's
`MARKET_GROWTH_PARAMS`) is also 0.06, beside `usEquityGrowthRate` 0.07. It only reaches
AU-equity holdings that no AU_STOCK role account seeds over. Whether a bare market rate is
a price rate or a total rate is exactly the question M2's anchor has to settle for all four
market keys, so it is decided there (§7 Q5).

### M2 — one equity anchor axis, not six (§9.3 of the first draft, refined)

**Retire the six wrapper growth rates as MC axes. Add one.**

They stay fully editable params, and stay Opt-listable (D3) — *a param can be something
the user sets without being something the engine sweeps.* The wrapper rates state how each
account is invested: a **plan input**, not an uncertainty. After F9 it is also clear they
*agree* (7% total everywhere, post-M1), so a common shift is applied to a coherent base,
not to noise.

1. Add `equityAnchorShift` to `ECONOMIC_REGIMES.paramSchema()`: default `0`, `mc: true`,
   `opt: false`, group `Market Rates`.
2. Apply it in the toolset's `state()`, **after** `seedPerAccountRates`: add the shift to
   every key of `baseGrowthRates` that is an `EQUITY_SLEEVES` market or starts with
   `<equity sleeve>::`.

   ```js
   if (shift) for (const k of Object.keys(baseGrowthRates))
     if (isEquitySleeveKey(k)) baseGrowthRates[k] += shift;   // bare OR `<sleeve>::<sk>`
   ```

   This is better than the first draft's edit to the choke-point line, for three reasons:
   it also reaches the **bare** market keys (row 4, the F2 case); it survives an authored
   `account.growthRate`, so **F5 cannot happen to this axis**; and gold, property and
   interest keys are excluded by construction. Because it sits in `baseGrowthRates`, it
   flows through regimes and the design 74 path unchanged (§2).
   Not reached: `appreciationSchedule` holdings (row "last" — an authored schedule is a
   deliberate override) and a handler `rateOverride`. Say so in the param description.
3. MC overlay: `equityAnchorShift`, `NORMAL`, mean `0`, `stdDev: 0.03` (the interim value,
   so M2 changes the *shape* of the uncertainty and not its stated size; M3 revisits the
   size). Centers honestly: `centerSource: schema`/`scenario`, never `default`.
4. Remove the six rows from `DEFAULT_MC_VARIABLE_CONFIGS` and flip their flags to
   `mc: false` (they stay `opt: true`). A panel config that still carries
   `rothGrowthRate: { enabled: true }` just disappears: `applyOverride` stores it, no
   contributor emits it, and W3 won't harvest an `mc: false` key.
5. Set the two dividend axes (`brokerageDividendRate`, `auStockDividendRate`) to
   `enabled: false`. They are additive total return on two accounts, drawn independently —
   F3 in miniature. They stay listed for anyone studying yield composition.

What this buys: 6 sampling dimensions (8 counting dividends) → 1; the correlation
structure becomes correct (one systematic draw, wrappers keeping their authored rates as
offsets); the measured dispersion stops depending on how many wrappers the household
happens to have.

What it costs: you can no longer sweep one wrapper alone in MC. That is the intended loss.
Genuine per-market dispersion is design 90 §7.3/§7.4's job.

Consumers to update in the same commit: `mc-axis-liveness`, `mc-sampling-not-inert`,
`intl-retirement-mc-config`, `intl-retirement-mc-runner`, `evt-shock-mc` tests;
`scripts/lib/mc.mjs:186` (reports `r.params.brokerageGrowthRate` as the run's `growth`
column — switch to `equityAnchorShift`); audit `scripts/lab/sequence-risk/scenario.mjs`,
`scripts/lib/variant.mjs`, `scripts/lib/scenario-source.mjs`,
`scripts/probes/shock-path-engine.mjs`.

Before/after: terminal-NW dispersion on the reference plan. Expected direction **wider**,
by roughly the √6 the current independence throws away on the equity component.

**M2 BUILT 11 Sep 2026** — after design 99, so the shape above changed in three places:
- **Where:** `collectBaseGrowthRates` adds the shift to each of the four market totals.
  After design 99 P2 there are no `<sleeve>::<stateKey>` equity keys and no per-account
  seeding to run after, so the market total IS every equity holding's rate; still upstream
  of regimes and the design 74 path, and still not gold, bonds, cash or an authored
  `appreciationSchedule`.
- **What it replaces:** not the six wrapper axes (design 99 P2 already retired them with
  their params) but the interim that followed — US and AU totals drawn INDEPENDENTLY, F3
  with two dimensions instead of six. All four totals and yields stay listed, off.
- **Steps 4–5** were done by design 99 P2 (wrapper rows and the two dividend axes are gone).

`equityAnchorShift`: schema default 0 (`mc: true`, `opt: false`, group `Market Rates`); MC
row NORMAL, mean 0, sd 0.03; centers from the schema. `scripts/lib/mc.mjs` reports `growth`
as the US total as run (plan total + anchor) and the raw `anchor`. The listed script
consumers only SET market totals as plan inputs — unchanged. Tests:
`equity-anchor-shift.test.mjs` (every market shifts by the anchor, gold does not, 0 is
byte-identical, MC samples one equity axis); `mc-axis-liveness` MC-LIVE-2 proves the
anchor moves the end state. No golden moves (default 0).

**Measured 11 Sep 2026** (synthetic default plan, n = 2000, each arm run from its own
commit): M2 widened terminal-NW dispersion **×1.25** in sd(log NW) at the same stated sd.
Direction as predicted. The √6 figure no longer applied: after design 99 only two markets
were drawn independently, so √2 was the ceiling, and unequal market weights put the result
below it. Median unchanged.

### M3 — decide what the anchor's sd means

Once M2 lands and the design 74 path becomes a realistic default, the anchor's `stdDev`
is no longer "return uncertainty" — it is *estimation* uncertainty about the mean, and
should be smaller. Pick one interpretation, write it into the param description, and
re-base; decide in the same step whether `equityReturnStochastic` becomes the default.
Otherwise MC double-counts for as long as both mechanisms are on (F4).

**M3 BUILT 11 Sep 2026.** Two decisions (user):

1. **The stochastic path is on in Monte Carlo only.** `perturbParams` (mc-worker-core.js,
   shared by the serial and parallel paths) sets `equityReturnStochastic: true` in every
   iteration's params unless `mcSequenceRisk` is false. It is written into the params, so
   `r.params` records it and a replay draws the same path. Single runs, the editor and every
   golden stay deterministic — one plan, one answer.
   `mcSequenceRisk` is a new Boolean (default true, group Economic Shocks, `mc`/`opt` false)
   rather than a reading of `equityReturnStochastic: false`, because the loader materializes
   every schema default into the typed params list: a plan that never touched the path and
   one that switched it off are indistinguishable by the time MC sees them.
2. **The anchor's sd is estimation uncertainty about the long-run mean: 0.015** (was 0.03,
   the total-uncertainty proxy). The path now carries year-to-year risk, so 0.03 would count
   part of it twice. 0.015 sits between the CMA providers' disagreement (sd ≈ 1.4 points
   across the four markets, from the P5b figures in `docs/market-returns/SOURCES.md`) and the
   sampling error of a 100-year historical mean (18% / √100 ≈ 1.8 points).

No golden moves. Every MC result re-bases: wider in the path's direction (sequence risk and
market dispersion now present), narrower in the anchor's.

**Measured 11 Sep 2026** (same setup as M2's): M3 widened sd(log NW) a further **×1.42**
despite halving the anchor sd, so the path adds more spread than it takes from the anchor.
M2 + M3 together: ×1.78. Median unchanged. Most of the widening is in the upper tail
(geometric paths are right-skewed), but the lower tail and the real-liquidity trough
worsen too, and the trough arrives earlier: sequence risk showing up as intended. The
failure rate was 0% in every arm because the synthetic default is over-funded, so it
cannot say how failure rates moved. That needs the same three arms on a plan that can
fail.

---

## 6. Sequencing

| # | Step | Scope | Depends on | Re-golds? |
|---|---|---|---|---|
| W0 | Generated keys are flat tokens in `get`/`set` (F7) | MC + Opt | — | No |
| W1 | Declare the four market growth params (F2) | shared | — | No (param-list fixtures gain exactly 4 keys) |
| W0b | Round year-valued MC samples: `integer: true` rows (F10) | MC | — | No — every year row ships disabled |
| W2 | Flag audit + first-wins schema de-dup + SWEEP-18 (F8); `moveYear` / `stateMoveYear` on (F10) | MC + Opt | W0b (for the two `mc` on-flips) | No |
| W3 | Shared harvest (F1, F6); retires the hardcoded year contributors (W3.7) | MC + Opt | W0, W0b, W2 | No — new rows land disabled |
| W4 | Shared panel: filter + collapsible groups | MC + Opt | — (best after W3) | No |
| W5 | `shadowedBy` / `shadowedAll` + config-dependent liveness gate (F5) | MC | W3's `{ cfg, accounts }` plumbing | No |
| M1 | AU stock default → 7% total (F9) — **BUILT** | shared | — | **Yes** (12 goldens) |
| M2 | `equityAnchorShift`; retire the six wrapper MC axes (F3) — **BUILT 11 Sep 2026** (record under M2) | MC | M1, **design 99 P2** (wrapper rates gone; shift the four market totals) | **Yes**, re-bases every MC result (no golden moves) |
| M3 | Re-base the anchor sd against the path model (F4) — **BUILT 11 Sep 2026** (path on in MC only; anchor sd 0.015) | MC | M2 | **Yes**, every MC result (no golden moves) |

W0 is a live bug fix and worth landing even if nothing else in this design ships. W0–W5
have no numeric effect. M2 overlaps design 90 §7.4 — read that section before starting it.

## 7. Open questions

1. **Null-centered per-account rows.** W3 skips an `acct.*.growthRate` whose value is
   `null`. The alternative — center it on the account's *effective* inherited rate, so
   every account gets a row — needs a ladder resolver outside the sim and turns "enable"
   into "pin". Revisit only if someone asks for per-account MC rows on unpinned accounts;
   M2 makes that request much less likely.
   **Settled by design 99 P2 (10 Sep 2026):** accounts no longer carry a growth rate, so
   there are no per-account growth rows left to center; W3-3 was deleted with the field.
2. **MPC actuation of generated keys.** W0 audits it; if `control.actuate` has its own
   path writer, it may need the same flat-token rule.
3. **Security/holding-level sweeps** (F6, design 94). Out of scope; the harvest is the
   mechanism they would use.
4. **The MC "Median Failure" date** (reported 10 Sep 2026) is out of scope here — a
   results defect, not a sweep-surface one. Logged as `design/inconsistencies.md` §4.13
   with what has been ruled out and the remaining candidates.
5. **Are the bare market defaults price or total?** (found in M1) `auEquityGrowthRate` is
   0.06 and the US/intl market keys are 0.07. No wrapper reads them while every account has
   a role, but M2 shifts them together, and a holding that falls through to its market key
   gets no dividend handler of its own. Decide before M2 whether the four are total returns
   (then AU should be 0.07) and say so in their descriptions.
   **Answered 10 Sep 2026 → design 99.** They are totals, each market gets a yield, and the
   wrapper rates retire, so accounts derive their growth from their holdings. M2 is
   re-based onto the four market totals and waits for design 99 P2.
