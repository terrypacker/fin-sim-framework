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

## 7. Dividend-yield cuts under regimes (small follow-up to design 21)

Per roadmap §3.4: extend `EconomicRegime` with `dividendAdjustment: { [rateKey]: number }`. Migrate `DividendScheduledHandler` (already reads per-holding values post-design-25, per §6.5 of design 25) to consume `holding.dividendYield × (1 + regime.dividendAdjustment[holding.rateKey] × regime.currentFactor)`.

`holding.dividendYield` is a new optional field added here; defaults to the handler's static yield. Could ship as part of this design or as a separate one-PR follow-up to design 21 — the work is small enough that bundling it here is reasonable.

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
| **25 Holdings** | Adds optional fields on `Holding`. No structural change. |
| **21 Regimes** | Bond duration consumes `state.effectiveInterestRates` (existing). Dividend cuts extend `EconomicRegime` with one new adjustment field. Real-estate location codes extend the rate-key namespace. |
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

- Promote `RealProperty` / `Collectible` to Holdings (§6) — yes / no / partial?
- Bundle the dividend-cut extension (§7) with this design, or ship as a one-PR follow-up to design 21?
- Where does `holding.duration` default live: per-toolset, per-rate-key, or hard-coded?
- Does the bond price adjustment also adjust `costBasis`? (Probably not — basis is purchase basis, mark-to-market only moves `marketValue`.)
