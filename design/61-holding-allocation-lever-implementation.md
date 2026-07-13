# 61 — Implementation Guide: Holding-allocation lever

Companion to `design/61-holding-allocation-lever.md` (the design). This is the build
plan: modules, signatures, wiring points (with current line anchors), tests, and
per-phase exit criteria. **Read the design first** — especially §4 (the four
sub-levers), §5 (portfolio-not-per-account), §6 (buy/sell primitive), and §12 (the
resolved OQs). Signatures are illustrative, not final.

Every phase is independently landable and leaves the app + golden green. The guiding
principle: **reuse the design-29 behavioral rebalance machinery and the design-58
Lever-B param/opt/MPC patterns** — very little is new mechanism.

---

## 0. Architecture at a glance — the reuse map

| Need | Reuse (exists today) | New in 61 |
|---|---|---|
| Select the lever à la carte | `behavioralStrategies` EnumMulti + `BEHAVIORAL_STRATEGY_REGISTRY` (`behavioral-strategy-registry.js`); auto-exposed by `economic-regimes-toolset.js` `paramSchema()` L386–421 / `reducers()` L509–511 | a `TARGET_ALLOCATION` registry entry |
| Continuous searchable weights | design-58 Lever-B pattern: `buildDrawdownWeightSchema()`, `::`-keyed params, `visibleWhen`, `drawdownWeightsFromStrategy()`, `presentDrawdownWeightRoles()` (`intl-retirement-scenario.js` L150–260) | `buildAllocWeightSchema()`, `allocWeightsFromPreset()`, `presentAllocations()` (mirror) |
| Within-account rebalance to a target | `OpportunisticRebalanceReducer` + `OpportunisticRebalanceApplyReducer` (`behavioral/`) — computes drift legs, moves value pro-rata, conserves total | Phase 1 feeds it a *synthesized continuous* target; Phase 2 makes the apply taxable-aware + establish-new-sleeve |
| Taxable disposal w/ CGT | `StockWithdrawalApplyReducer` `STOCK_WITHDRAWAL_APPLY` → FIFO `consumeHoldingsFifo` + `STOCK_WITHDRAWAL_TAX` + `COLLECTIBLE_SALE_TAX` (`us-brokerage-classes.js` L216–295) | route taxable rebalance sell legs through this |
| New-sleeve growth rate | `resolveRateKey(country, allocation, role)` / `resolveDefaultAllocation` (`holdings/default-allocations.js`) | call it when establishing a sleeve |
| Opt axes + build-time filter | `buildOptVariables(params, accounts)` + `presentDrawdownWeightRoles` filter (`intl-retirement-opt-config.js`) | add allocWeight axes + allocation filter |
| MPC online triad | `COCKPIT_CONTROLS` spec + `_seededSim` shim + `actuate` (`cockpit-controller.js`, `optimization-problem.js`); `scripts/verify-mpc-lever.mjs` | `ALLOCATION_MIX` control + shim + verifier case |

**Tax-treatment sets to define once** (reused by split-bands, gold guard, taxable
routing):
- `TAX_ADVANTAGED_ROLES = {K401, IRA, ROTH, SUPER}` (already inline in the registry).
- `TAXABLE_ROLES = {US_STOCK, AU_STOCK}` (brokerage; `_taxableStateKeys` already uses this).
- `US_TAX_ADVANTAGED_ROLES = {K401, IRA, ROTH}` — the **gold-guard** set (SUPER excluded;
  AU super *can* hold bullion, OQ4a).

---

## 1. Phase 1 — Lever A: searchable static mix (tax-advantaged only)

**Goal.** Make the target mix a set of continuous, solver-searchable axes that feed
the *existing* tax-advantaged rebalancer. No taxable rebalancing, no time variation,
no new tax wiring. Golden byte-identical when the strategy is unselected.

### 1.1 New constants + synthesis (`intl-retirement-scenario.js`, mirror L150–260)

```js
// The searchable allocation classes (CASH handling per design §OQ2 — include it).
export const ALLOC_WEIGHT_CLASSES = ['EQUITY', 'BOND', 'CASH', 'GOLD'];   // ALLOCATION values
export const ALLOC_WEIGHT_PREFIX  = 'allocWeight';
export const ALLOC_WEIGHT_SEP     = '::';                 // MUST be '::' — see gotcha G1
export const allocWeightKey = (cls) => `${ALLOC_WEIGHT_PREFIX}${ALLOC_WEIGHT_SEP}${cls}`;

// Named presets → warm-starts (each a point in weight space).
export const ALLOCATION_PRESETS = {
  SIXTY_FORTY:  { EQUITY: 0.60, BOND: 0.40, CASH: 0.00, GOLD: 0.00 },
  ALL_WEATHER:  { EQUITY: 0.30, BOND: 0.40, CASH: 0.15, GOLD: 0.15 },
  EQUITY_TILT:  { EQUITY: 0.80, BOND: 0.15, CASH: 0.05, GOLD: 0.00 },
};
export const DEFAULT_ALLOC_WEIGHTS = ALLOCATION_PRESETS.SIXTY_FORTY;   // reproduces today's 60/40 default
```

**Simplex encoding — use STICK-BREAKING (concrete resolution of design §4-A/OQ1).**
Search `K−1` params (all classes except the last as residual); synthesis is a
bijection to the simplex with **no scale-degenerate ray** and **no `Σ≤1` constraint to
project** (which the naive `share_K = 1−Σ` would need — CEM samples outside it):

```js
// order fixed by ALLOC_WEIGHT_CLASSES; the LAST class is the residual (no param).
// params carry allocWeight::EQUITY, ::BOND, ::CASH  (GOLD is residual here)
export function synthesizeTargetAllocation(parameters, presentClasses = null) {
  const classes = presentClasses
    ? ALLOC_WEIGHT_CLASSES.filter(c => presentClasses.has(c))
    : ALLOC_WEIGHT_CLASSES;
  const shares = {}; let remaining = 1;
  for (let i = 0; i < classes.length - 1; i++) {
    const w = clamp01(Number(parameters?.[allocWeightKey(classes[i])] ?? DEFAULT_ALLOC_WEIGHTS[classes[i]]));
    shares[classes[i]] = remaining * w;   // stick-breaking
    remaining -= shares[classes[i]];
  }
  shares[classes[classes.length - 1]] = remaining;   // residual
  return shares;   // sums to 1 by construction
}
```

- `buildAllocWeightSchema()` → per-class `Number` params (`min:0,max:1,step:0.05`,
  `mc:false, opt:true`, `group:'Allocation'`, `visibleWhen:{param:'behavioralStrategies',
  includes:'TARGET_ALLOCATION'}`), one per **non-residual** class. Spread into the
  behavioral registry `paramSchema()` (not `INTL_RETIREMENT_PARAM_SCHEMA` — see 1.2).
- `presentAllocations(accounts, holdings)` → the classes actually reachable (build-time
  filter, the design-58 analog); Phase 1 can pass all four.
- `allocWeightsFromPreset(name)` → stick-breaking weights reproducing a preset (the
  warm-start; twin of `drawdownWeightsFromStrategy`).

### 1.2 Register the strategy (`behavioral-strategy-registry.js`)

Add an entry — auto-exposed by `economic-regimes-toolset.js` (no toolset edit needed):

```js
TARGET_ALLOCATION: {
  handlers: () => [],
  reducers: (context) => {
    const p = context.parameters;
    const advantaged = (context.accounts ?? [])
      .filter(a => TAX_ADVANTAGED_ROLES.has(a.role))
      .map(a => ({ stateKey: a.stateKey, role: a.role }));
    const target = (p.allocationStrategy === 'OPTIMIZED')
      ? synthesizeTargetAllocation(p)                 // continuous, searchable
      : (p.rebalanceTargetAllocation ?? DEFAULT_ALLOC_WEIGHTS);
    return [
      new OpportunisticRebalanceReducer({ taxAdvantaged: advantaged, targetAllocation: target,
        rebalanceDriftBand: p.rebalanceDriftBandSheltered ?? 0.05 }),
      new OpportunisticRebalanceApplyReducer(),        // Phase-1 reuse (free)
    ];
  },
  paramSchema: () => [
    { key: 'allocationStrategy', label: 'Allocation Strategy', type: 'Enum', group: 'Allocation',
      options: ['STATIC', 'OPTIMIZED'], mc:false, opt:false, defaultValue: 'STATIC',
      visibleWhen: { param:'behavioralStrategies', includes:'TARGET_ALLOCATION' } },
    ...buildAllocWeightSchema(),
  ],
},
```

> **Coexistence (OQ5):** this is a *new* entry beside `OPPORTUNISTIC_REBALANCE`. To
> study 61 alone, select `TARGET_ALLOCATION` and leave the legacy reactive strategies
> unselected. Byte-identical default: strategy unselected ⇒ no reducer ⇒ golden intact.

### 1.3 Opt axes (`intl-retirement-opt-config.js`)

- Spread `buildAllocWeightSchema().map(...)` into `DEFAULT_OPTIMIZATION_CONFIGS` as
  `CONTINUOUS`, `enabled:false` (mirror the drawdownWeight block ~L214).
- Extend the **build-time filter** already in `buildOptVariables(params, accounts)`:
  drop `allocWeight::<cls>` axes whose class is not in `presentAllocations(accounts)`
  (same shape as the `presentDrawdownWeightRoles` filter added for design 58).

### 1.4 Tests (`tests/unit/`)

- `evt-target-allocation.test.mjs` (new): `synthesizeTargetAllocation` sums to 1 for
  arbitrary weights (no degenerate ray); a preset's weights reproduce its mix; a
  shifted weight changes the mix; `OPTIMIZED` drives the reducer's target.
- Extend `param-sweep-schema.test.mjs`: `allocWeight::*` axes present under
  `TARGET_ALLOCATION` + `OPTIMIZED`, hidden otherwise; the account/allocation filter
  prunes absent classes (SWEEP-style, like SWEEP-13).
- Golden `cross-border-relief-scenario.test.mjs`: **must not move** (strategy unselected).

**Exit:** the optimizer sweeps a continuous mix on tax-advantaged accounts; a shifted
weight measurably changes holdings; golden unchanged.

---

## 2. Phase 2 — Lever C: taxable-aware rebalance + buy primitive

**Goal.** Extend rebalancing to taxable accounts with correct CGT, add the buy /
establish-new-sleeve primitive, the US-IRA gold guard, and split drift bands. **This
unlocks the tax study.**

- **New action `REBALANCE_TO_TARGET_APPLY`** (or generalize the existing apply):
  computes portfolio legs, then routes each:
  - *tax-advantaged sell/buy* → existing free proportional path.
  - *taxable sell* → the CGT path: reuse `consumeHoldingsFifo` + emit
    `STOCK_WITHDRAWAL_TAX` (+ `COLLECTIBLE_SALE_TAX` for GOLD; carry `isGold:true`,
    `auGain`/`auIndexedGain` — see `us-brokerage-classes.js` L257–295 for the exact
    payload). Deploy **after-tax** proceeds into the buy legs.
- **Establish-new-sleeve** (fix `OpportunisticRebalanceApplyReducer` L47–48 `continue`
  on empty allocation): when a positive-delta class has no holding, create one —
  `allocation`, `marketValue=amount`, `costBasis=amount`, `purchaseDate=asOf`,
  `rateKey=resolveRateKey(country, allocation, role)`, BOND defaults (`duration` from
  `RATE_KEY_META`, `treasury=false`, `couponRate=null`). **Respect JOURNAL_STRICT**
  purity (gotcha G2): copy-on-write holdings, never mutate in place.
- **Gold guard (OQ4a):** never establish/locate a GOLD sleeve in a
  `US_TAX_ADVANTAGED_ROLES` account. AU super stays eligible.
- **Split drift bands (OQ3):** `rebalanceDriftBandTaxable` (default **wide**, 0.10) vs
  `rebalanceDriftBandSheltered` (default **tight**, 0.02) — the reducer picks per
  account by role. Both opt/MPC knobs. *(Prototype `scripts/prototype-rebalance-cadence.mjs`
  is the design evidence; the in-sim test asserts the ordering, not the magnitudes.)*

**Tests:** taxable rebalance realizes the jurisdiction-correct tax (US LTCG + AU
indexed; GOLD US 28% vs AU indexed-ordinary via `isGold`); tax-advantaged stays free;
establish a GOLD sleeve from zero; a gold buy never lands in a US IRA; wide-vs-tight
band drift ordering. **Exit:** an end-to-end taxable rebalance with correct CGT and
value conserved net of tax.

---

## 3. Phase 3 — Lever B: time variation

`allocationSchedule` enum: `STATIC` (Phase 1) / `GLIDEPATH` / `REGIME_CONDITIONED`.
- **GLIDEPATH:** a small `{age, weights}` anchor table (model on the spending
  `EXPLICIT_BANDS` generated params); `synthesizeTargetAllocation` interpolates by the
  as-of age.
- **REGIME_CONDITIONED:** one weight-set per regime tag; the reducer reads
  `state.activeRegimes` (as `OpportunisticRebalanceReducer` L51 already does) and picks
  the matching set. This subsumes `PanicSell` (EQUITY→CASH) as a special case.

**Exit:** a stress regime shifts the mix and reverts; a glidepath interpolates by age.

---

## 4. Phase 4 — Lever D: jurisdiction-aware location

Extend `assetLocationPolicy` (already an `STRATEGIC_ASSET_LOCATION` param) to:
- include GOLD, with **residency-branched** homes (US: shelter to dodge 28% *except*
  the IRA bullion ban ⇒ effectively AU/none; AU: taxable fine, super best);
- honor the **US-IRA gold guard**;
- **lazy post-move relocation (OQ4b):** re-*target* the new optimum and let the normal
  rebalance cadence walk holdings there over following periods — do **not** force a
  taxable event on the move date (avoid straddling the residency cost-base step-up,
  design 57).

Wire the portfolio target (Lever A) → per-account placement (Lever D) so the whole
book hits one mix while each class sits in its tax-favored account.

**Exit:** with a US→AU move, gold migrates to its post-move home lazily; the overall
mix is preserved; no move-date CGT spike.

---

## 5. Phase 5 — MPC online (the flagship)

The design-58 §11 triad, verbatim shape:
1. **`COCKPIT_CONTROLS.ALLOCATION_MIX`** (`cockpit-controller.js`): `buildVariables`
   returns the `allocWeight::*` axes (pruned by `presentAllocations` from live state,
   the design-58 `_presentRolesFromState` analog); `describe` renders the mix;
   `appliesTo` gates on `allocationStrategy==='OPTIMIZED'`.
2. **`_seededSim` shim** (`optimization-problem.js`, alongside
   `FORWARD_DRAWDOWN_STATE_FIELDS`): after snapshot injection, re-apply the committed
   target (re-stamp `state`'s resolved target / re-run locate→trade) so the forward
   rollout honors it.
3. **`actuate`**: write the target forward-effective on the running sim + persist the
   params, so advise/apply/live can't drift.
- **Hysteresis ε** (§7): only re-trade when projected gain clears the CGT it realizes;
  compare **applied-mix L1 distance**, not raw weights.
- **Harvest (OQ7):** the committed per-epoch mix accumulates via `mergeCandidate` into
  `committedParams`; bake GLIDEPATH anchors / a per-regime map back into scenario
  params for a deterministic re-run (the SPENDING-bands pattern).
- **Verifier:** add an `allocationMix` case to `scripts/verify-mpc-lever.mjs`
  (compile-path vs snapshot-path GAP→PASS).

**Sequencing note (design §11.1):** Phase 5 does **not** require design 46. It runs on
CEM like design-58 Lever B (`DRAWDOWN_WEIGHTS`, an 8-dim online CEM lever shipped
without the surrogate). Design 46 is a *performance* accelerator to reach for only if
many levers run online together and the solve gets slow.

---

## 6. Cross-cutting gotchas

- **G1 — `::` not `.` in weight keys.** `set()` on the MC/Opt/MPC path silently drops
  dotted keys whose parent object doesn't pre-exist, leaving the axis **inert** through
  the solver and MPC. This bit design 58 Lever B; use `::` everywhere. (See the
  `optimizer-param-key-dot-collision` memo.)
- **G2 — journal purity (JOURNAL_STRICT).** Reducers must copy-on-write holdings/
  accounts; the establish-new-sleeve + rebalance applies mutate `holdings` arrays —
  clone them, or STRICT mode throws at the culprit (the `journal-diff-live-alias` fix).
  Run `JOURNAL_STRICT=on` in tests.
- **G3 — holdings/balance invariant.** Every apply must re-sync `balance = Σ
  holdings.marketValue` (the existing applies do at their tail). Multi-holding accounts
  desync if `transaction()` is used directly (the "account bounce" bug) — go through the
  holdings applies, not `transaction()`.
- **G4 — build-time allocation filter.** Mirror the design-58 phantom-dim fix: prune
  `allocWeight::<cls>` for classes no account can hold, at all three sites (synthesis,
  `buildOptVariables`, cockpit `buildVariables`). Otherwise the solver wastes dims and
  the displayed mix lists phantom sleeves.
- **G5 — CASH ↔ drawdown floor (OQ2).** Effective cash target = `max(targetCash,
  drawdownFloor)`; the rebalance must not draw cash below the design-58
  `minimumBalance` liquidity floor.
- **G6 — shared cross-border scope (OQ6).** Allocation scope mirrors
  `crossBorderDrawdown`; a GLOBAL-alloc / LOCAL-drawdown mix undoes the location
  arbitrage. Enforce one scope (or warn on inconsistency), don't add an independent
  switch.
- **G7 — no dependence on TLH/TGH (OQ3 sub-Q).** The taxable rebalance carries its own
  bracket-aware realization; do **not** require `TAX_LOSS_HARVEST`/`TAX_GAIN_HARVEST`
  to be selected — they're bracket-conditional opposites that fight (TGH room =
  `ceiling − income − usCapitalGainsYTD`).

---

## 7. Test & verify inventory

| Artifact | Phase | Asserts |
|---|---|---|
| `tests/unit/evt-target-allocation.test.mjs` (new) | 1 | synthesis sums to 1 / preset reproduction / reducer target |
| `tests/unit/param-sweep-schema.test.mjs` (extend) | 1 | allocWeight axes visible/hidden + account filter |
| `tests/unit/cross-border-relief-scenario.test.mjs` | 1 | golden byte-identical (unselected) |
| taxable-rebalance CGT test (new/extend brokerage tests) | 2 | US/AU/gold jurisdiction-correct tax; gold-guard; value net of tax |
| regime/glidepath test | 3 | mix shifts on regime; interpolates by age |
| location test | 4 | jurisdiction homes; lazy post-move; mix preserved |
| `tests/unit/mpc-drawdown-xborder.test.mjs` (analog) | 5 | committed mix bites under snapshot (GAP→PASS) |
| `scripts/verify-mpc-lever.mjs allocationMix` | 5 | compile vs snapshot path parity |
| `scripts/prototype-rebalance-cadence.mjs` | — | (design evidence, OQ3) |
| `scripts/prototype-crossborder-allocation-scope.mjs` | — | (design evidence, OQ6) |

Run gate each phase: `npm run test:unit && npm run test:viz` (both green), golden
unchanged, and the phase's `verify`/prototype where applicable.
