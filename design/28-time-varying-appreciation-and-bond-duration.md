# 28 — Time-Varying Appreciation & Bond Duration

**Status**: ✅ COMPLETE (2026-06-06) — all 15 steps landed; 2274 tests passing
**Phase dependencies**: Phase A (`design/25-holding-level-state.md`) must land first — this design reads and writes per-holding fields.
**Related**: `design/24-financial-modeling-roadmap.md` §3.4, `design/21-financial-shock-and-regime-framework.md` (`state.effectiveInterestRates`, `RegimeApplyReducer`, the rate-key substrate), `design/25-holding-level-state.md` (Holdings model this design extends).
**Author note**: Skeleton document. Section bodies are placeholders to be filled when Phase C opens. Captures roadmap §3.4 commitments and the design-21 dividend-cut follow-up.

---

## 1. Purpose

`RealProperty.appreciationRate` and `Collectible.appreciationRate` are scalars. Design 21 makes them regime-adjustable per rate key, but the **base** rate is constant. `FixedIncomeAccount` is a single growth rate with no duration. This design adds **time-varying** appreciation paths and **rate-sensitive** bond pricing — both reading the Holdings substrate from design 25.

---

## 2. Today

> *To populate when Phase C opens.*

Pointer: `RealProperty.appreciationRate` (`src/finance/assets/real-property.js`), `Collectible.appreciationRate` (`src/finance/assets/collectible.js`), `FixedIncomeInterestHandler` (`src/finance/handlers/earnings-handlers.js`).

---

## 3. Per-holding appreciation schedules

```js
// holding.appreciationSchedule  (new optional field on Holding from design 25)
[
  { date: '2026-01-01', rate: 0.06 },
  { date: '2030-01-01', rate: 0.04 },
  { date: '2035-01-01', rate: 0.03 },
]
```

A shared lookup (`appreciation-schedule-utils.js#resolveScheduledRate`) reads the active rate by selecting the most recent entry `<= currentDate`. An absent/empty schedule falls back to the asset's scalar rate, so this is backward compatible with every holding the bootstrap creates in design 25 and every existing `RealProperty` / `Collectible`.

Schedules attach to **both** surfaces, and both consume the *same* utility (§13 Q1 — `RealProperty` / `Collectible` are **not** promoted into Holdings; the shared lookup is the only unification):
- `Holding.appreciationSchedule` — account-level holdings, consumed inside `computeHoldingsGrowth`.
- `RealProperty.appreciationSchedule` / `Collectible.appreciationSchedule` — standalone assets, consumed by the per-period asset-appreciation path.

Used by:
- Collectibles whose appraisal trajectory is known.
- Real property whose forward rate is known to step rather than be regime-noise.
- Any account holding whose forward rate is known to step rather than be regime-noise.

---

## 4. Real-estate location codes

`RealProperty.market` (e.g. `US-SF-BAY`, `AU-NSW-SYD`) drives a market-specific rate key. Regional shocks (a Bay Area housing crash) move only properties with the matching market code, not every house globally tagged `REAL_ESTATE_US`.

Implementation: extend the design-21 rate-key resolution so a property contributes a rate key of the form `REAL_ESTATE_{market}` if `market` is set; the regime library's `levelEffects.realEstateRevaluation.rateKeys` accepts the same. Falls back to the country-level key when `market` is null.

---

## 5. Bond duration

```js
// holding.duration  (new optional field on BOND-allocation holdings)
holding.duration: number   // modified duration in years
```

When `state.effectiveInterestRates[holding.rateKey]` changes period-over-period, a small new `BondPriceAdjustReducer` marks every `BOND`-allocation holding to market:

```
Δprice = -duration × Δrate × holding.marketValue
```

The reducer **patches the holding's `marketValue` directly and re-syncs `account.balance`**, following the `RevalueAssetReducer` precedent — it does *not* emit a separate `HOLDING_REVALUE` action (a reducer reduces; the round-trip would add nothing). It triggers on `US_PERIOD_ADVANCE` / `AU_PERIOD_ADVANCE` at priority `PRE_PROCESS + 2` so it fires after the design-21 `RegimeApplyReducer` (`PRE_PROCESS + 1`) has written the new effective rate, but before the period's earnings handlers compute coupon income off the (now-adjusted) price. `Δrate` is computed against a self-maintained `state.priorMarkRates` snapshot (read prior, apply, write current), so the first period is a no-op.

Effective duration at the use-site is `holding.duration ?? RATE_KEY_META[holding.rateKey]?.defaultDuration ?? 0` (§13 Q3). The `?? 0` makes non-bond rate keys safely no-op. The default lives **per rate key** in the `RATE_KEY_META` registry (typically `5.0` years for `FIXED_INCOME_*` — intermediate Treasury proxy), *not* per toolset; a toolset may still set `holding.duration` explicitly when it has more specific information (e.g. a known-maturity corporate bond), but that is an exception, not the default mechanism.

---

## 6. Promoting `RealProperty` / `Collectible` into Holdings

Design 25 explicitly defers this (path B in §5.3 of that doc). **Decision (§13 Q1): stay as-is — do not promote.** `RealProperty.value` and `Collectible.value` continue to live on the asset; the appreciation schedule (§3) attaches directly to the asset, not to a wrapping holding. Same shape as today, just richer.

The Holdings model was designed for **investment accounts** specifically — many holdings per account, FIFO basis, allocation classes. `RealProperty` has fundamentally different lifecycle concerns (one asset, mortgage attached, sale costs, jurisdiction-specific cap-gains rules); forcing it into Holdings buys uniform schedule code at the cost of permanent ceremony. The uniformity that promotion would have bought is instead obtained by extracting a shared `appreciation-schedule-utils.js` (§3) that both `Holding` and standalone assets consume — same lookup code, no structural change to either.

`Collectible` is borderline but follows the same call for consistency; promote *only* `Collectible` later if a multi-item collectibles account becomes a real use case.

---

## 7. Dividend-yield cuts under regimes — *spun out, do not implement here*

**Status (2026-06-05): COMPLETE.** Spun out per §13 Q2 and shipped as a standalone follow-up against design 21 — *not* part of design 28's appreciation/duration work. Tracked as Phase C deliverable #6 in [`24-financial-modeling-roadmap.md`](24-financial-modeling-roadmap.md) §5. Landed in two parts:
1. Commit `5e53dcc` (2026-06-04) — regime substrate: `EconomicRegime.dividendAdjustment`, `RegimeApplyReducer` → `state.effectiveDividendAdjustments` (scaled by `currentFactor`), `DividendScheduledHandler` scaling, `SHOCK_LIBRARY` presets, and `dividend-cuts-under-regime.test.mjs`. This part deferred the per-holding `dividendYield` field (the handler scaled the account-level rate).
2. 2026-06-05 — the deferred per-holding piece: optional `Holding.dividendYield`, a shared `computeHoldingsDividends()` (`holdings-earnings.js`), and migration of **both** the US `DividendScheduledHandler` and the AU `IntlAuStockDividendHandler` to per-holding yield × per-rate-key adjustment (the AU path now also honors the regime cut, which it previously ignored).

**What the spun-out PR did** (kept here as the canonical implementation note since there is no dedicated `21a` doc):

- ✅ Extend `EconomicRegime` with `dividendAdjustment: { [rateKey]: number }` (alongside the existing `returnAdjustment`, `interestRateAdjustment`, `inflationAdjustment`, `appreciationAdjustment`, `fxAdjustment` fields built in `EconomicShockHandler`).
- ✅ Add optional `Holding.dividendYield` field; falls back to the dividend handler's account-level `dividendRate` when null.
- ✅ Migrate `DividendScheduledHandler` (US) **and** `IntlAuStockDividendHandler` (AU) to compute, per holding, `marketValue × (holding.dividendYield ?? dividendRate) × (1 + state.effectiveDividendAdjustments[holding.rateKey])` (the `× currentFactor` scaling already lives in `RegimeApplyReducer`), clamped ≥ 0 per holding. Shared seam: `computeHoldingsDividends()`, the dividend twin of `computeHoldingsGrowth()`.
- ✅ Carry `dividendAdjustment` through the shock path and serializer — shocks are plain data in `parameters.shocks`; `resolveShockEntry` / `applySeverity` preserve `regime.dividendAdjustment`, and `SHOCK_LIBRARY` presets seed it.
- ✅ Test coverage in `dividend-cuts-under-regime.test.mjs` (EVT-DIV-CUT-1…10, incl. per-holding yield, per-rate-key adjustment, AU reinvestment, and `Holding` round-trip).

**Why spun out:** the change is 21-shaped (one more adjustment field on regime + small handler migration). Bundling it into design 28 would inflate this design's scope and gate a small, immediately-shippable improvement behind a Phase C design. Unblocked today (design 25 Holdings is complete); can ship before design 28 begins.

---

## 8. Yield curve

Explicitly **future after this design**. Single short-term rate per bond holding ships in §5; per-maturity yields are a follow-up.

---

## 9. State / data model summary

New fields on `Holding`:

- `appreciationSchedule?: { date: Date | string, rate: number }[]`
- `duration?: number`
- `Holding.dividendYield` is **not** added by this design — it moves to the spun-out dividend-cut PR (§7).

New fields on `RealProperty` / `Collectible`:

- `appreciationSchedule?: { date: Date | string, rate: number }[]` (also on `Collectible`)
- `market?: string` (`RealProperty` only — drives the `REAL_ESTATE_{market}` rate key, §4)

Rate-key registry extension (design 21):

- `RATE_KEY_META[rateKey]?.defaultDuration?: number` — a **sibling metadata map** to `RATE_KEYS` (whose values are bare strings, so the metadata cannot hang off the key value itself). Seeded for `FIXED_INCOME_US` / `FIXED_INCOME_AU`.

New top-level state field:

- `state.priorMarkRates` — snapshot of `effectiveInterestRates` at the last bond mark, maintained by `BondPriceAdjustReducer` to compute period-over-period `Δrate` (§5).

`state.effectiveInterestRates[rateKey]` (owned by design 21) is the read. Bond mark-to-market patches `holding.marketValue` directly inside `BondPriceAdjustReducer` (re-syncing `account.balance`); standalone-asset appreciation writes `state[stateKey].value`. No new `HOLDING_*` action type is introduced.

---

## 10. Interaction with existing designs

| Design | Interaction |
|---|---|
| **25 Holdings** | Adds optional fields on `Holding` (`appreciationSchedule`, `duration`). Bond duration also reads `RATE_KEY_META[holding.rateKey]?.defaultDuration` (see §13 Q3). No structural change to the Holdings model itself. |
| **21 Regimes** | Bond duration consumes `state.effectiveInterestRates` (existing). Real-estate location codes extend the rate-key namespace. Dividend cuts are **not part of this design** — see §7 (spun out as standalone follow-up to 21). |
| **23 FX** | Untouched. |
| **15 Config** | All new fields cascade through `cfg.accounts[*].holdings[*]` and `cfg.realProperties[*]`. |

---

## 11. Out of scope

- Yield curves (per-maturity rate structures).
- Convexity (only modified duration is modeled; second-order rate sensitivity ignored).
- Credit spreads on individual bonds.
- Foreign-currency holdings inside one account (still out of scope per roadmap §7).

---

## 12. Testing sketch

- `appreciation-schedule.test.mjs` — schedule lookup picks the right entry per date; edge cases at boundaries.
- `bond-duration.test.mjs` — rate change → price change matches `-D × Δr × P` within rounding.
- Duration-fallback case — a bond holding with no explicit `duration` uses `RATE_KEY_META[rateKey].defaultDuration`; a holding under a key with no `defaultDuration` is a no-op (`Δprice = 0`).
- `real-estate-location-codes.test.mjs` — regional shock moves only matching properties.

(`dividend-cuts-under-regime.test.mjs` is **not** part of this design — it ships with the spun-out dividend-cut PR, §7.)

---

## 13. Open questions

> *Capture during Phase C kickoff. Initial seed:*

- Promote `RealProperty` / `Collectible` to Holdings (§6) — yes / no / partial? **Answer: No (stay as-is).** Both keep their current Asset shape; this design adds appreciation-schedule support directly on the asset rather than wrapping in a single-holding container. Extract a shared `appreciation-schedule-utils.js` so Holdings and standalone Assets use the same schedule-lookup code (and the same rate-key resolution). Reason: Holdings was designed for *portfolio holdings inside investment accounts* — many holdings per account, FIFO basis, allocation classes. RealProperty has fundamentally different lifecycle concerns (one asset, mortgage attached, sale costs, jurisdiction-specific cap-gains rules). Forcing it into Holdings buys uniform schedule code at the cost of permanent ceremony. Collectible is borderline but follows the same call for consistency; promote *only Collectible* later if a multi-item collectibles account becomes a real use case.
- Bundle the dividend-cut extension (§7) with this design, or ship as a one-PR follow-up to design 21? **Answer: One-PR follow-up to design 21 — spun out of this design entirely.** See §7 for the canonical implementation note (kept there since there is no dedicated `21a` doc) and [`24-financial-modeling-roadmap.md`](24-financial-modeling-roadmap.md) §5 Phase C item 6 for the tracked deliverable. Reason: the change is 21-shaped (one more `*Adjustment` field on `EconomicRegime`) and is immediately shippable today since design 25 (Holdings) is complete; bundling here would gate it behind a Phase C design for no architectural reason. **Tracking note: do not let this fall on the floor — it's a small, useful, unblocked improvement that's easy to forget because it doesn't live in its own design doc.**
- Where does `holding.duration` default live: per-toolset, per-rate-key, or hard-coded? **Answer: Per-rate-key.** Extend the design-21 rate-key registry with a sibling `RATE_KEY_META` map carrying an optional `defaultDuration: number` field (units: years) — `RATE_KEYS` values are bare strings, so the metadata cannot hang off the value itself (see §15 reconciliation). Holdings without an explicit `duration` look up `RATE_KEY_META[holding.rateKey]?.defaultDuration ?? 0` — the `0` default makes non-bond rate keys safely no-op for the bond price adjustment. Toolsets can still override per-holding when they have more specific information (e.g. a specific corporate bond with known maturity). Reason: duration is a property of the bond category, which is what the rate key already represents — single source of truth, no toolset drift, correct grain.
- Does the bond price adjustment also adjust `costBasis`? (Probably not — basis is purchase basis, mark-to-market only moves `marketValue`.) **Answer:** no

---

## 14. Doc-body follow-ups (from §13 answers) — APPLIED 2026-06-05

These follow-ups have been **folded into the section bodies above** (and reconciled with the §15 implementation plan, which corrected `RATE_KEYS[*].defaultDuration` → `RATE_KEY_META[*]?.defaultDuration` since `RATE_KEYS` values are bare strings). Kept here as a changelog.

- ✅ **§3 appreciation schedules:** schedules attach to `Holding` *and* to standalone `RealProperty` / `Collectible` (Q1: no promotion); both consume the shared `appreciation-schedule-utils.js`.
- ✅ **§5 bond duration:** `holding.duration` falls back to `RATE_KEY_META[holding.rateKey]?.defaultDuration ?? 0` (Q3); the "per-toolset default" line is gone — per-toolset overrides are now an exception. Also reconciled the mechanism: `BondPriceAdjustReducer` patches `marketValue` directly (no `HOLDING_REVALUE` emission), at `PRE_PROCESS + 2`.
- ✅ **§6 promoting RealProperty / Collectible:** rewritten as "decision: stay as-is," referencing the shared-utility extraction.
- ✅ **§7 dividend cuts:** marked spun out; not implemented here.
- ✅ **§9 state/data model:** `RATE_KEY_META[*]?.defaultDuration?: number` added to the registry-extension list; `Holding.dividendYield` noted as *not* added by this design (moved to the spun-out PR); `state.priorMarkRates` top-level field added.
- ✅ **§10 interaction table:** dividend-cut line moved to the spun-out PR; rate-key registry note present.
- ✅ **§12 testing:** `dividend-cuts-under-regime.test.mjs` dropped from this design's list; duration-fallback case added.

---

## 15. Step-by-step Implementation Plan (added 2026-06-05)

### Status legend
- [ ] not started  ✅ complete

### Sequencing rationale

Mirrors the design-26 / design-27 approach: land the lowest-risk additive piece first, validate end-to-end, then layer the substrate-touching machinery. This plan bakes in every §13 answer and §14 doc-body follow-up — treat those as decided. Where the skeleton invented names that don't match the live code, the steps reconcile to the real symbol (called out inline, the same way design 27 §12 reconciled `HOLDING_SET_BASIS_APPLY` → `HOLDING_SET_BASIS`).

**Build order:** Increment 1 (appreciation schedules + shared util) → Increment 2 (real-estate location codes) → Increment 3 (bond duration + rate-key duration metadata). The three are largely independent; the order minimizes churn (Increment 1 is pure additive fields + a lookup util; Increment 2 extends the existing rate-key→stateKey substrate; Increment 3 is the only one that adds a new reducer to the period-advance chain).

**Grounding facts established before writing this plan (the "Today" §2 was a placeholder):**
- `RealProperty.appreciationRate` (`src/finance/assets/real-property.js:57`) and `Collectible.appreciationRate` (`src/finance/assets/collectible.js:53`) are scalars. The `applyAppreciation()` service methods (`real-property-service.js:133`, `collectible-service.js:115`) **are never called during a simulation run** — grep-confirmed. Standalone assets do **not** appreciate period-over-period today; their value only moves on `REVALUE_ASSET_APPLY` (shocks) and the sale price is baked in at boot value (`us-real-property-toolset.js:25-27`). **This is the gap §3 must close** — see Increment 1 Step 4.
- Account *holdings* DO grow per period, through `computeHoldingsGrowth()` (`src/finance/holdings/holdings-earnings.js`), which the earnings handlers call. That function is the single per-holding rate-read seam (`earnings-handlers.js`, every `call()`).
- `RegimeApplyReducer` (`src/finance/economic-regimes/regime-apply-reducer.js:40`) runs at `PRE_PROCESS + 1 (11)` on `US_PERIOD_ADVANCE` / `AU_PERIOD_ADVANCE`, rebuilding `state.effective*Rates` from `state.base*Rates` each period. It already supports `effectiveAppreciationRates` *and* `effectiveDividendAdjustments` + per-regime `dividendAdjustment` scaling (lines 67-78) — the §7 spun-out dividend-cut substrate is **already partly wired in state**, but consuming it is still out of this design (see "Out of this plan").
- `RATE_KEYS` (`src/finance/economic-regimes/rate-keys.js:21`) is a frozen map of bare *strings* — it has no per-key metadata slot. The §13 Q3 `defaultDuration` field therefore needs a **sibling metadata map** (`RATE_KEY_META`), not a property on the string values.
- `HOLDING_REVALUE` already exists: `HoldingRevalueAction` (`holding-actions.js:148`, supports `priceDelta`) + `HoldingRevalueReducer` (`holding-reducers.js:93`, `POSITION_UPDATE (30)`, `marketValue += priceDelta`, re-syncs balance). `RevalueAssetReducer` (`revalue-asset-reducer.js`, also `POSITION_UPDATE`) is the precedent for a reducer that patches holdings directly on a period/shock action and re-syncs balance.
- `ALLOCATION.BOND` exists (`allocation.js:21`); `FIXED_INCOME*` roles map to `BOND` (`default-allocations.js:27-28`) and to `FIXED_INCOME_US/AU` rate keys (`rate-keys.js:52-53`). Bond holdings are already identifiable.
- `buildRateKeyToStateKeys()` (`economic-regimes-toolset.js:26`) maps **account** roles → rate key → `stateKey[]`. Real properties / collectibles are *not* in it today — Increment 2 must add them so a `REAL_ESTATE_{market}` key resolves to property state keys.

---

### Increment 1 — Per-holding & per-asset appreciation schedules

The shared schedule-lookup utility plus the new optional fields, wired into the one rate-read seam for holdings and into a new per-period appreciation path for standalone assets (§3, §13 Q1, §14 §3 follow-up). Pure-additive: no schedule ⇒ today's behavior, bit-for-bit.

**Step 1 — Shared `appreciation-schedule-utils.js`** ✅
- Create `src/finance/holdings/appreciation-schedule-utils.js` exporting `resolveScheduledRate(schedule, date, fallbackRate)`:
  - `schedule` is `{ date: Date|string, rate: number }[]`; select the entry with the latest `date <= currentDate`; if none (or `schedule` empty/null) return `fallbackRate`.
  - Normalize string dates to `Date` once; entries need not be pre-sorted (sort defensively or single-pass max). Mirror the date-coercion style already used in `regime-apply-reducer.js:53-54`.
- This is the single source of truth §13 Q1 calls for — both account holdings (Step 4a) and standalone assets (Step 4b) consume it.

**Step 2 — `appreciationSchedule` field on `Holding`** ✅
- `src/finance/holdings/holding.js`: add optional `appreciationSchedule = null` to the constructor, `toJSON` (serialize entry dates via `.toISOString()` like `purchaseDate`), and `fromJSON` (coerce back to `Date`). Default `null` keeps every bootstrap holding from design 25 unchanged.

**Step 3 — `appreciationSchedule` on `RealProperty` / `Collectible` + round-trip** ✅
- Add `appreciationSchedule = null` to `RealProperty` (`real-property.js`) and `Collectible` (`collectible.js`) constructors (assets stay as-is per §13 Q1 — *not* promoted to Holdings).
- `scenario-serializer.js`: thread `appreciationSchedule` through `_serializeRealProperty` / `_makeRealProperty` (~lines 578-617) and the `_serializeCollectible` / `_makeCollectible` pair (~lines 619-650), defaulting `null`.
- Toolset state-plain projection: add `appreciationSchedule` to `_propertyToStatePlain` (`us-real-property-toolset.js:114`, plus the AU twin and `us-collectibles-toolset.js`) so it reaches `state[stateKey]`.

**Step 4 — Consume the schedule at the rate-read points** ✅
- **4a (account holdings):** in `computeHoldingsGrowth()` (`holdings-earnings.js`), before falling back to `ratesMap[h.rateKey] ?? fbRate`, consult `resolveScheduledRate(h.appreciationSchedule, currentDate, <existing resolved rate>)`. Thread `currentDate` into the function (callers already have `date` available in `call({ state })` via the event; pass it through). When a holding has no schedule the resolved rate is untouched — existing single-holding tests stay green.
- **4b (standalone assets — closes the §2 gap):** there is no per-period appreciation event for `RealProperty` / `Collectible` today. Add a minimal per-period appreciation path: a `OneOffEvent`/`EventSeries`-driven `ASSET_APPRECIATION` (annual) scheduled by the real-property & collectibles toolsets for any asset with a non-zero `appreciationRate` *or* an `appreciationSchedule`, handled by a small `AssetAppreciationHandler` that emits a value-update action consumed by a reducer that grows `state[stateKey].value` by `resolveScheduledRate(asset.appreciationSchedule, date, asset.appreciationRate)`. **Decision point to confirm at Phase C kickoff:** whether asset runtime-appreciation is in-scope for this design or deferred (the skeleton assumed schedules attach to "any holding whose forward rate is known to step" but never specified that standalone assets lack a runtime growth path). If deferred, scope Increment 1 to 4a only and have the schedule feed *sale-price* computation instead (`us-real-property-classes.js` house-sale handler) — but that is a weaker realization of §3. Recommended: do 4b, it is the lever §13 Q1 says the asset "wants anyway."

**Step 5 — `state-schema-registry.js` patterns** ✅
- Register `*.holdings.*.appreciationSchedule` (and the asset-level `*.appreciationSchedule`) so the journal / state panel / CSV export render it. Follow the existing holdings-pattern block (`state-schema-registry.js:119-124`).

**Step 6 — Tests** ✅
- `tests/unit/appreciation-schedule.test.mjs` — `resolveScheduledRate` picks the right entry per date; boundary dates (`date === entry.date`), pre-first-entry (returns fallback), empty/null schedule, unsorted input.
- Extend a holdings-earnings test: a multi-entry schedule on one holding steps its growth rate at the scheduled boundary while a no-schedule holding is unchanged.
- If 4b lands: a scenario test asserting a property's `value` follows its scheduled rate across a boundary year.

---

### Increment 2 — Real-estate location codes

`RealProperty.market` drives a market-specific rate key so a regional housing shock moves only matching properties (§4, §14 §-none — §4 is already in final form). Falls back to the country-level key when `market` is null.

**Step 7 — `market` field + round-trip** ✅
- Add `market = null` to `RealProperty` (`real-property.js`), thread through `scenario-serializer.js` (`_serializeRealProperty` / `_makeRealProperty`) and `_propertyToStatePlain` (`us-real-property-toolset.js:114`, AU twin).

**Step 8 — Market-aware rate-key resolution** ✅
- Extend the design-21 rate-key namespace so a property contributes `REAL_ESTATE_{market}` (e.g. `REAL_ESTATE_US-SF-BAY`) when `market` is set, else the country key (`RATE_KEYS.REAL_ESTATE_US` / `REAL_ESTATE_AU`). Add a helper `resolvePropertyRateKey(property)` (co-locate with `rate-keys.js` or `default-allocations.js#resolveRateKey`).
- Teach `buildRateKeyToStateKeys()` (`economic-regimes-toolset.js:26`) to also walk `context.realProperties` (and collectibles), bucketing each property's `stateKey` under `resolvePropertyRateKey(property)`. Today the function only walks `accounts` — properties never enter the shock-target map, so regional revaluation has nothing to target. This is the load-bearing change.

**Step 9 — Shock library accepts market keys** ✅
- `levelEffects.realEstateRevaluation.rateKeys` already flows through `EconomicShockHandler` (`economic-shock-handler.js:80-88`) unchanged — once Step 8 populates `rateKeyToStateKeys[REAL_ESTATE_US-SF-BAY]`, a shock listing that key revalues only those properties. Add a market-scoped preset to `shock-library.js` as a worked example and to anchor the test.

**Step 10 — Tests** ✅
- `tests/unit/real-estate-location-codes.test.mjs` — a shock targeting `REAL_ESTATE_US-SF-BAY` revalues only properties with that `market`; a `market: null` property resolves to the country key and is hit by a country-level real-estate shock but not the regional one.

---

### Increment 3 — Bond duration + rate-key duration metadata

Rate-sensitive bond pricing on `BOND`-allocation holdings (§5, §13 Q3/Q4, §14 §5 follow-up). The only increment that adds to the period-advance reducer chain.

**Step 11 — `RATE_KEY_META` with `defaultDuration`** ✅
- `rate-keys.js`: add a sibling frozen map `RATE_KEY_META` keyed by rate key, with optional `{ defaultDuration: number }` (years). Seed `FIXED_INCOME_US` and `FIXED_INCOME_AU` to `5.0` (intermediate-Treasury proxy, §5); all other keys omit it ⇒ `?? 0` ⇒ no-op. **Reconcile the doc:** §10 / §13 Q3 / §14 wrote `RATE_KEYS[holding.rateKey].defaultDuration`; the real shape is `RATE_KEY_META[holding.rateKey]?.defaultDuration` because `RATE_KEYS` values are bare strings — update §9 and §13 Q3 to cite `RATE_KEY_META`.

**Step 12 — `duration` field on `Holding`** ✅
- `holding.js`: add optional `duration = null` (constructor + `toJSON` + `fromJSON`). Effective duration at use-site is `holding.duration ?? RATE_KEY_META[holding.rateKey]?.defaultDuration ?? 0` (§13 Q3). No change to the bootstrap split — bond holdings simply inherit the rate-key default.

**Step 13 — `BondPriceAdjustReducer`** ✅
- Create `src/finance/economic-regimes/bond-price-adjust-reducer.js`. **Reconcile the doc:** §5 describes both "emit a `HOLDING_REVALUE`" *and* "a `BondPriceAdjustReducer` marks the holding to market" — these conflict (handlers emit, reducers reduce). Implement as a **reducer that patches bond holdings directly and re-syncs balance**, matching the `RevalueAssetReducer` precedent (`revalue-asset-reducer.js`) — simpler than a handler→`HOLDING_REVALUE`→reducer round-trip and the same end state. Update §5 to say "directly patched by `BondPriceAdjustReducer`," not "emitted as `HOLDING_REVALUE`."
  - `reducedActionTypes = ['US_PERIOD_ADVANCE', 'AU_PERIOD_ADVANCE']` (same triggers as `RegimeApplyReducer`).
  - Priority `PRE_PROCESS + 2 (12)` — strictly after `RegimeApplyReducer` (`11`) so it reads the freshly-written `state.effectiveInterestRates`, and before any cash-flow / the separately-scheduled coupon-interest event fires later in the period (§5 sequencing intent). Confirm no collision with `InflationAdjustReducer` (also `12` per design 21 §2 note) — if they must be ordered, use `13`.
  - Compute Δrate per rate key as `effectiveInterestRates[rk] - priorMarkRates[rk]`, where `priorMarkRates` is a snapshot this reducer maintains itself in `state` (read prior, apply, then write current) — no change to `RegimeApplyReducer`. First period: prior == current ⇒ Δ = 0 ⇒ no-op.
  - For each account holding with `allocation === ALLOCATION.BOND`: `Δprice = -effDuration × Δrate × holding.marketValue`; `marketValue = max(0, marketValue + Δprice)`; re-sync `account.balance` (reuse `_syncBalance` from `holding-reducers.js`). `costBasis` is untouched (§13 Q4: no).
- Add `state.priorMarkRates = {}` (or fold into a `state.bondMark` object) in `intl-retirement-state.js` (alongside the `effective*Rates` block at lines 83-90).

**Step 14 — Wire into the ECONOMIC_REGIMES toolset** ✅
- Register `BondPriceAdjustReducer` in `economic-regimes-toolset.js` `types.reducers` (line 166) and `reducers()` (line 239-246), next to `RegimeApplyReducer`. Bond duration is meaningless without the regime layer (it consumes `effectiveInterestRates`), so gating it on ECONOMIC_REGIMES is correct.
- `state-schema-registry.js`: register `*.holdings.*.duration` and the `priorMarkRates.*` snapshot.

**Step 15 — Tests** ✅
- `tests/unit/bond-duration.test.mjs` — a rate rise of `+Δr` on `FIXED_INCOME_US` drops a `duration: D` bond holding by `≈ -D × Δr × P` within rounding; a rate fall raises it; a non-bond holding under the same key is untouched; `costBasis` unchanged.
- Duration-fallback test: a bond holding with no explicit `duration` uses `RATE_KEY_META[rateKey].defaultDuration`; a holding under a key with no `defaultDuration` is a no-op (Δprice = 0).

---

### Out of this plan (tracked elsewhere)

- **Dividend-yield cuts under regimes (§7)** — spun out as a one-PR follow-up to design 21 (§7, §13 Q2, roadmap §5 item 6). *Not* implemented here. Note the substrate is already partly live (`RegimeApplyReducer` builds `effectiveDividendAdjustments` and scales per-regime `dividendAdjustment`, `regime-apply-reducer.js:68,78`); the spun-out PR adds the `Holding.dividendYield` field and the `DividendScheduledHandler` migration. Do not let it fall on the floor.
- **Yield curve / per-maturity rates (§8, §11)** — explicitly future after this design. Single short-term rate per bond holding only.
- **Promoting `RealProperty` / `Collectible` to Holdings (§6, §13 Q1)** — decided "no, stay as-is"; the shared `appreciation-schedule-utils.js` (Step 1) is the only unification.
- **Convexity, credit spreads, mixed-currency holdings (§11)** — out of scope.
