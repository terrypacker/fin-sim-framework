# 28 — Time-Varying Appreciation & Bond Duration

**Status**: Skeleton (Phase C per `design/24-financial-modeling-roadmap.md` §5)
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

Reducer or handler reads the active rate by selecting the most recent entry `<= currentDate`. Defaults to a single entry equal to today's scalar; backward compatible with every holding the bootstrap creates in design 25.

Used by:
- Collectibles whose appraisal trajectory is known.
- Real property promoted into the Holdings model (see §6).
- Any holding whose forward rate is known to step rather than be regime-noise.

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

When `state.effectiveInterestRates[holding.rateKey]` changes period-over-period, a small new `BondPriceAdjustReducer` marks the holding to market:

```
Δprice = -duration × Δrate × holding.marketValue
```

Emitted as a `HOLDING_REVALUE` (design 25 §6.1) targeting the specific holding with `priceDelta = Δprice`. Sequencing: runs at `POSITION_UPDATE + 1` so it fires after the design-21 `RegimeApplyReducer` has written the new effective rate but before the period's earnings handlers compute coupon income off the (now-adjusted) price.

`holding.duration` defaults to `0` for non-bond holdings (no-op) and to a configurable per-toolset default for `BOND` holdings. The default sits in the toolset that owns the account (typically `5.0` years — intermediate Treasury proxy).

---

## 6. Promoting `RealProperty` / `Collectible` into Holdings

Design 25 explicitly defers this (path B in §5.3 of that doc). The decision lands here once §3 (appreciation schedules) is the lever a property wants anyway. Two options to consider in Phase C:

- **Stay as-is.** `RealProperty.value` continues to live on the asset; appreciation schedule attaches to the asset, not a holding. Same shape as today, just richer.
- **Wrap in a Holding.** `RealProperty` becomes an account-like container with one holding whose `allocation: ALLOCATION.OTHER`, `rateKey: 'REAL_ESTATE_US-SF-BAY'`, `appreciationSchedule: [...]`. Unifies the mental model.

Default recommendation when Phase C opens: stay as-is unless the unified model unlocks something. The Holdings model was designed for **investment accounts** specifically; over-applying it to single-physical-asset records introduces ceremony without clear benefit.

---

## 7. Dividend-yield cuts under regimes — *spun out, do not implement here*

**Status (2026-06-04): SPUN OUT.** Per §13 Q2 resolution, this section is *not* part of design 28's implementation. It ships as a standalone one-PR follow-up against design 21, tracked as Phase C deliverable #6 in [`24-financial-modeling-roadmap.md`](24-financial-modeling-roadmap.md) §5.

**What the spun-out PR will do** (kept here as the canonical implementation note since there is no dedicated `21a` doc):

- Extend `EconomicRegime` with `dividendAdjustment: { [rateKey]: number }` (alongside the existing `returnAdjustment`, `interestRateAdjustment`, `inflationAdjustment`, `appreciationAdjustment`, `fxAdjustment` fields built in `EconomicShockHandler`).
- Add optional `holding.dividendYield` field; defaults to `DividendScheduledHandler`'s static per-account yield.
- Migrate `DividendScheduledHandler` (already reads per-holding values post-design-25, per §6.5 of design 25) to compute `holding.dividendYield × (1 + regime.dividendAdjustment[holding.rateKey] × regime.currentFactor)`.
- Carry `dividendAdjustment` through `Shock` schema and scenario serializer.
- Test coverage in a new `dividend-cuts-under-regime.test.mjs`.

**Why spun out:** the change is 21-shaped (one more adjustment field on regime + small handler migration). Bundling it into design 28 would inflate this design's scope and gate a small, immediately-shippable improvement behind a Phase C design. Unblocked today (design 25 Holdings is complete); can ship before design 28 begins.

---

## 8. Yield curve

Explicitly **future after this design**. Single short-term rate per bond holding ships in §5; per-maturity yields are a follow-up.

---

## 9. State / data model summary

> *To populate.*

New fields on `Holding`:

- `appreciationSchedule?: { date: Date | string, rate: number }[]`
- `duration?: number`
- `dividendYield?: number`

New field on `RealProperty`:

- `market?: string`

No new top-level state fields. `state.effectiveInterestRates[rateKey]` (owned by design 21) is the read; per-holding state writes via existing `HOLDING_REVALUE` / `HOLDING_TRANSACT` actions.

---

## 10. Interaction with existing designs

| Design | Interaction |
|---|---|
| **25 Holdings** | Adds optional fields on `Holding` (`appreciationSchedule`, `duration`). Bond duration also reads `RATE_KEYS[holding.rateKey].defaultDuration` (see §13 Q3). No structural change to the Holdings model itself. |
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
- `real-estate-location-codes.test.mjs` — regional shock moves only matching properties.
- `dividend-cuts-under-regime.test.mjs` — regime `dividendAdjustment` scales the per-holding yield correctly.

---

## 13. Open questions

> *Capture during Phase C kickoff. Initial seed:*

- Promote `RealProperty` / `Collectible` to Holdings (§6) — yes / no / partial? **Answer: No (stay as-is).** Both keep their current Asset shape; this design adds appreciation-schedule support directly on the asset rather than wrapping in a single-holding container. Extract a shared `appreciation-schedule-utils.js` so Holdings and standalone Assets use the same schedule-lookup code (and the same rate-key resolution). Reason: Holdings was designed for *portfolio holdings inside investment accounts* — many holdings per account, FIFO basis, allocation classes. RealProperty has fundamentally different lifecycle concerns (one asset, mortgage attached, sale costs, jurisdiction-specific cap-gains rules). Forcing it into Holdings buys uniform schedule code at the cost of permanent ceremony. Collectible is borderline but follows the same call for consistency; promote *only Collectible* later if a multi-item collectibles account becomes a real use case.
- Bundle the dividend-cut extension (§7) with this design, or ship as a one-PR follow-up to design 21? **Answer: One-PR follow-up to design 21 — spun out of this design entirely.** See §7 for the canonical implementation note (kept there since there is no dedicated `21a` doc) and [`24-financial-modeling-roadmap.md`](24-financial-modeling-roadmap.md) §5 Phase C item 6 for the tracked deliverable. Reason: the change is 21-shaped (one more `*Adjustment` field on `EconomicRegime`) and is immediately shippable today since design 25 (Holdings) is complete; bundling here would gate it behind a Phase C design for no architectural reason. **Tracking note: do not let this fall on the floor — it's a small, useful, unblocked improvement that's easy to forget because it doesn't live in its own design doc.**
- Where does `holding.duration` default live: per-toolset, per-rate-key, or hard-coded? **Answer: Per-rate-key.** Extend the design-21 rate-key registry with an optional `defaultDuration: number` field (units: years). Holdings without an explicit `duration` look up `RATE_KEYS[holding.rateKey].defaultDuration ?? 0` — the `0` default makes non-bond rate keys safely no-op for the bond price adjustment. Toolsets can still override per-holding when they have more specific information (e.g. a specific corporate bond with known maturity). Reason: duration is a property of the bond category, which is what the rate key already represents — single source of truth, no toolset drift, correct grain.
- Does the bond price adjustment also adjust `costBasis`? (Probably not — basis is purchase basis, mark-to-market only moves `marketValue`.) **Answer:** no

---

## 14. Doc-body follow-ups (from §13 answers)

Sections to update before implementation begins:

- **§3 appreciation schedules:** clarify that schedules attach to `Holding` *and* to standalone `RealProperty` / `Collectible` (Q1: no promotion). Both consume the shared `appreciation-schedule-utils.js`.
- **§5 bond duration:** specify that `holding.duration` falls back to `RATE_KEYS[holding.rateKey].defaultDuration ?? 0` (Q3). Remove the "per-toolset default" line; per-toolset overrides are now an exception, not the default mechanism.
- **§6 promoting RealProperty / Collectible:** rewrite as "decision: stay as-is" rather than "two options to consider." Reference the shared utility extraction.
- **§7 dividend cuts:** already updated — marked spun out; do not implement here.
- **§9 state/data model:** add `RATE_KEYS[*].defaultDuration?: number` to the registry-extension list. Note that `Holding.dividendYield` is *not* added by this design (moved to the spun-out PR).
- **§10 interaction table:** already updated — dividend-cut line moved to the spun-out PR; rate-key registry note added.
- **§12 testing:** drop `dividend-cuts-under-regime.test.mjs` from this design's test list (it lives with the spun-out PR). Add a test confirming the `RATE_KEYS.defaultDuration` lookup fallback works for holdings with no explicit duration.
