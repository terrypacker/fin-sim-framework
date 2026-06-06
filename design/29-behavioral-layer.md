# 29 — Behavioral Layer

**Status**: Planned — implementation plan added 2026-06-05; scope expanded from 3 → 8 strategies. Section bodies grounded against the live code (the §2 "Today" placeholder is now filled).
**Phase dependencies**: Phase A (`design/25-holding-level-state.md`) for the Holdings primitive (✅ landed 2026-06-03). Design 21 (`design/21-financial-shock-and-regime-framework.md`) for the regime substrate (✅ Phases 1+2 landed). Design 26 (`design/26-dynamic-spending-strategies.md`) for the `SPENDING_STRATEGY_REGISTRY` pattern *and* the shared `state.regimeActions` map this design reuses (✅ landed 2026-06-05).
**Related**: `design/24-financial-modeling-roadmap.md` §3.5, `design/21-…` (`state.activeRegimes`, regime tags, `state.effectiveGrowthRates`), `design/25-…` (`Holding`, `HOLDING_TRANSACT`, FIFO basis), `design/26-…` (parallel pluggable-strategy registry, `state.regimeActions`), `design/28-time-varying-appreciation-and-bond-duration.md` (the §12 step-by-step plan style this doc mirrors).
**Author note**: Scope expanded 2026-06-05 per the design discussion: `TaxLossHarvestHandler` is promoted from "future-future" to the **flagship** strategy of this design, and four new strategies are added (`StrategicAssetLocation`, `OpportunisticRebalance`, `DownturnRothConversion`, `CashBucketDrawdown`, `TaxGainHarvest`). The §10 open-question answers from the skeleton are preserved and reconciled to the real code symbols.

---

## 1. Purpose

Portfolio behavior today is mechanical — scheduled earnings, scheduled withdrawals, scheduled contributions, no investor reaction to crises or to the tax calendar. A defensible plan **reacts**: it harvests losses when markets fall, rebalances back to target instead of drifting, converts to Roth when balances are depressed, sources spending from cash rather than selling equities low, suspends contributions under stress, and locates assets in the accounts where they are taxed least. Some of those reactions destroy value (panic selling); some create it (tax-loss harvesting). This design adds a pluggable layer of handlers that read `state.activeRegimes`, the holdings substrate, and the tax calendar, and emit portfolio-restructuring actions — so a scenario can model either the disciplined investor or the panicking one, and measure the difference.

The load-bearing decision is to mirror design 26 exactly: a `BEHAVIORAL_STRATEGY_REGISTRY` of independent, composable strategies, each contributing its own handlers/reducers, selected by a toolset `EnumMulti` param. No new framework infrastructure.

---

## 2. Today

No reactive behavior exists. Grounding facts (verified against the code, 2026-06-05):

- **Earnings** grow holdings per period through `computeHoldingsGrowth()` (`src/finance/holdings/holdings-earnings.js`), called by the earnings handlers (`earnings-handlers.js`). This is the single per-holding rate-read seam.
- **Withdrawals** consume a fixed drawdown order; the taxable sell path is `StockWithdrawalApplyReducer` (`src/finance/account-rules/us/us-brokerage-classes.js:176`), which FIFO-consumes holdings (`consumeHoldingsFifo`, `holdings-fifo.js`) and chains `STOCK_WITHDRAWAL_TAX`. **Critical:** it computes `gain = Math.max(0, salePrice − realizedBasis)` (line 207) — it **floors losses at zero**. The existing sell machinery therefore *cannot realize a loss*, which is the entire point of tax-loss harvesting (§3.3). This is the load-bearing obstacle the skeleton missed.
- **Contributions** fire on schedule regardless of market state: `K401ContributionHandler.call({ data })` (`k401-classes.js:131`) returns `K401_CONTRIBUTION_APPLY` unconditionally; same shape for IRA / Roth / Super (`ira-classes.js`, `roth-classes.js`, `au-super-classes.js`).
- **Accounts have no `type` enum.** They are identified by **role / state key** — `ACCOUNT_ROLES` (`src/finance/state/account-roles.js`): `K401`, `IRA`, `ROTH`, `US_STOCK`, `AU_STOCK`, `SUPER`, `FIXED_INCOME`, `AU_FIXED_INCOME`, `US_SAVINGS`, `AU_SAVINGS`. The skeleton's `account.type === 'FOUR_OH_ONE_K' | 'ROTH' | 'BROKERAGE'` branch does not map to any real field; every handler below keys off role / state key instead.
- **`state.regimeActions` already exists** (design 26): a general map keyed by an action-type string, each entry `{ active, appliedMultiplier, firedForShocks }`, used by `RegimeAwareSpendingReducer` (`regime-aware-spending-reducer.js`) for once-per-regime idempotency. **This design reuses it** rather than inventing `state.behavioralFingerprints` (skeleton §6).
- **Regime objects** carry a stable `id` (`regime-${shockId}`), `shockId`, `currentFactor`, and `tags: string[]` (`economic-shock-handler.js:49-64`). `REGIME_TAG` (`regime-tag.js`) defines only `ECONOMIC_STRESS` today — new tags must be added there.
- **Holdings** (`holding.js`): `{ allocation, marketValue, costBasis, purchaseDate, rateKey, label, dividendYield }`. There is **no `unrealizedGainLoss` field** (it is derived, `marketValue − costBasis`) and **no `holdingsByAllocation` helper** (filter `account.holdings.filter(h => h.allocation === ALLOCATION.EQUITY)`). The skeleton invented both names.

---

## 3. Strategies

Eight composable strategies, in three families. Each registers its own handlers / reducers; ordering via `PRIORITY`. All read regime / holdings / tax state and **add** their effects against materialized state so two strategies touching the same surface compose rather than clobber.

| # | Strategy | Family | Trigger | Acts on | Account scope |
|---|---|---|---|---|---|
| 3.1 | `PanicSell` | Reactive composition | `PANIC_SELL_TRIGGER` regime entry | EQUITY → CASH | all |
| 3.2 | `ContributionSuspension` | Flow control | `ECONOMIC_STRESS` active | contribution handlers | all contributing |
| 3.3 | **`TaxLossHarvest`** ⭐ | Tax-aware harvesting | year-end + optional drawdown-regime entry | EQUITY/BOND losses | taxable only (`US_STOCK`, `AU_STOCK`) |
| 3.4 | `StrategicAssetLocation` | Structural | year-end + regime entry | allocation ↔ account placement | tax-advantaged + contribution routing |
| 3.5 | `OpportunisticRebalance` | Reactive composition | drift band breach or drawdown-regime entry | drifted allocations → target | all (free in tax-advantaged) |
| 3.6 | `DownturnRothConversion` | Tax-aware | drawdown-regime entry | tax-deferred → Roth | `K401`/`IRA` → `ROTH` |
| 3.7 | `CashBucketDrawdown` | Flow control | `PANIC_SELL_TRIGGER`/`ECONOMIC_STRESS` active | withdrawal source order | drawdown ordering |
| 3.8 | `TaxGainHarvest` | Tax-aware harvesting | year-end, low-income year | EQUITY gains in 0% LTCG band | taxable only |

`PanicSell` (3.1) and `OpportunisticRebalance` (3.5) are deliberately **opposite philosophies** on the same trigger; a scenario picks one (§10 Q8). `TaxLossHarvest` (3.3) and `TaxGainHarvest` (3.8) share one sell-and-rebuy seam (§3.3, the loss/​gain-aware `STOCK_HARVEST_APPLY`).

### 3.1 `PanicSellHandler`

Triggered by any regime tagged `PANIC_SELL_TRIGGER`. On **entry** into such a regime (idempotent via `state.regimeActions['panic_sell'].firedForShocks`), a `panicFraction` of each `EQUITY` holding rotates to `CASH`:

1. Find the first active regime whose `tags.includes('PANIC_SELL_TRIGGER')`; read its `panicSellSeverity` (regime property, falls back to a strategy default).
2. For each account with at least one `EQUITY` holding, for each such holding, move `severity × panicFraction × marketValue` from equity to a find-or-create `CASH` holding.
3. **Per-account-type branch (§10 Q2, reconciled to roles):**
   - **Tax-advantaged roles** (`K401`, `IRA`, `ROTH`, `SUPER`): emit a paired `HoldingTransactAction` (equity `−amount`, cash `+amount`) directly — no tax machinery (no realized gain inside a sheltered account).
   - **Taxable roles** (`US_STOCK`, `AU_STOCK`): route the equity sell through the standard `STOCK_WITHDRAWAL_APPLY` so FIFO basis applies and the realized gain reaches the YTD capital-gain accumulator; the cash leg lands in the savings pool the withdrawal already credits.

`panicFraction` default 0.30. Fires once per regime entry.

### 3.2 `ContributionSuspensionHandler`

Under any regime tagged `ECONOMIC_STRESS`, suspend new contributions for the regime's duration. A small reducer reads `state.activeRegimes` each period boundary and writes `state.contributionsSuspended: boolean`; each contribution handler (`K401ContributionHandler`, IRA, Roth, Super) short-circuits its `call()` when the flag is true.

**Forward-only resume; no catch-up (§10 Q3).** The mechanism is "suspended," not "deferred" — no `state.contributionsMissed`, no back-fill. The asymmetry (cut on entry, no catch-up on exit) is the behavioral observation worth modeling. Single boolean state field, no new action types beyond the toggle.

### 3.3 `TaxLossHarvestHandler` ⭐ *(flagship)*

The highest-value strategy in this design: it *creates* value rather than destroying or merely re-shaping it. At year-end (and, optionally, on entry into a drawdown regime so harvesting happens while losses are deepest rather than only in December), it sells taxable holdings trading **below basis**, realizes the loss against the YTD capital-gain accumulator, and immediately rebuys a substitute to stay invested.

**Scope:** taxable brokerage roles only (`US_STOCK`, `AU_STOCK`). Harvesting inside `K401`/`IRA`/`ROTH`/`SUPER` is a no-op (no taxable gain/loss), so the handler skips them entirely — this is *not* the per-account-type branch of `PanicSell`; it is a hard role filter.

**The loss-realization seam (the load-bearing decision).** `STOCK_WITHDRAWAL_APPLY` floors `gain` at 0 (§2), so it cannot carry a loss. Rather than disturb normal-withdrawal semantics, add a dedicated **`STOCK_HARVEST_APPLY`** action + `StockHarvestApplyReducer` that:
1. FIFO-consumes the target holding for `sellAmount` (reuse `consumeHoldingsFifo`), computing the **signed** `realizedGainLoss = proceeds − realizedBasis` (no `Math.max(0, …)` floor).
2. Chains the existing `STOCK_WITHDRAWAL_TAX` with the *signed* gain so a negative value reaches the tax module's YTD capital-gain accumulator. **Tax-module change:** the capital-gain accumulator must accept a signed delta (net losses within the year; an annual `$3 000` deduction cap + multi-year carryforward is policy and explicitly a follow-up, §10 Q6).
3. Immediately emits a `HoldingTransactAction` buying the **substitute** holding for the same dollar amount (basis = today's price, `purchaseDate = today`) so the account stays invested.

**Substitute selection (§10 Q1, preserved).** New optional `Holding.taxLossPartner: holdingId`. Algorithm: (1) if `taxLossPartner` is set, use it; (2) else find any other holding in the same account with a matching `rateKey` and use the first; (3) else **skip the harvest and log a warning** — do *not* fall back to same-allocation (US equity ≠ international equity even though both carry `ALLOCATION.EQUITY`). The partner mechanic also stands in for **wash-sale avoidance** — the rebuy is a different security by construction. Modeling the precise 30-day window is out of scope (§8).

**Cap.** `taxLossHarvestCap` (default `3000`, the US deduction cap) bounds the dollar loss realized per year; configurable. Fires once per year (and at most once per drawdown-regime entry, idempotent via `state.regimeActions['tax_loss_harvest']`).

### 3.4 `StrategicAssetLocationHandler`

Asset *location* (which account holds which allocation) is distinct from asset *allocation* (the household-wide equity/bond mix). Tax-inefficient assets (bonds, high-yield) belong in tax-deferred accounts; tax-efficient assets (broad equity index) belong in taxable. Getting location right is worth tens of basis points/year with **zero** change to the household allocation.

**Mechanism — never force a taxable sale.** Relocating an asset *out* of a taxable account would realize a gain, defeating the purpose. So this handler honors a location policy `assetLocationPolicy: { [allocation]: preferredAccountRole[] }` through two free levers only:
1. **Contribution routing:** direct each allocation's new contributions to its preferred account role (e.g. new bond money → `IRA`, new equity money → `US_STOCK`).
2. **Tax-advantaged-only swaps:** rebalance allocations *between tax-advantaged accounts* (free) — e.g. swap equity in the IRA for bonds in the 401(k) via mirrored `HOLDING_TRANSACT` pairs — to concentrate tax-inefficient assets in sheltered space.

**Regime tie-in.** When a regime shifts relative yields (a rate/`inflationShock` regime that lifts bond yields raises the tax cost of holding bonds in taxable), re-running location is worth more — so the handler fires annually *and* on regime entry. MVP scopes to the two free levers; cross-account taxable relocation is permanently out of scope (§10 Q7).

### 3.5 `OpportunisticRebalanceHandler`

The rational counterpart to `PanicSell`. After a drawdown — either drift beyond a band or entry into a drawdown regime — rebalance back to the target allocation. In a crash equity falls below target, so this **buys** depressed equity (selling bonds/cash): disciplined "buy the dip," the opposite of panic selling on the same signal.

**Mechanism.** Compute each account's current allocation fractions, compare to `targetAllocation`; if any drifts past `rebalanceDriftBand` (default 0.05), emit `HOLDING_TRANSACT` pairs to move value from over-weight to under-weight allocations. Within tax-advantaged accounts this is free; in taxable accounts a rebalancing **sell** realizes gains, so MVP rebalances within tax-advantaged accounts and routes taxable rebalancing through contributions/cash where possible. `PanicSell` and `OpportunisticRebalance` are mutually exclusive by intent — enabling both is contradictory and the toolset should pick one (§10 Q8).

### 3.6 `DownturnRothConversionHandler`

Regime-timed tax arbitrage: convert tax-deferred → Roth **while balances are depressed**, so more shares move per tax dollar and the subsequent recovery happens tax-free. The behavioral content is the *timing to the regime*, not the conversion mechanics — which already exist.

**Mechanism.** On entry into a drawdown regime (idempotent via `state.regimeActions['downturn_roth_conversion']`), emit the existing conversion chain (`K401_TO_IRA_CONVERSION` / the Roth rollover actions in `k401-classes.js`, `roth-conversion-classes.js`, `roth-rollover-classes.js`) for a configurable `downturnConversionAmount`. The conversion is taxable income in-year (the existing chain already handles that). MVP converts a fixed amount; "fill to the top of a target bracket" is a follow-up that depends on a projected-income read from the tax module (§10 Q9).

### 3.7 `CashBucketDrawdownHandler`

Sequence-of-returns protection. While a `PANIC_SELL_TRIGGER`/`ECONOMIC_STRESS` regime is active, fund spending from cash → fixed income → equities-last, so equities are not sold at depressed prices. This is the constructive flow-control twin of `PanicSell`'s destructive rotation.

**Mechanism.** A reducer sets `state.regimeActions['drawdown_source_override'] = { active, … }` while the regime is active (reverting on exit, the `RegimeAwareSpendingReducer` apply/revert pattern). The savings-replenishment / withdrawal-source logic (the `REPLENISH_SAVINGS` escalation path `MonthlyExpensesHandler` prepends) reads the override and reorders its source list to prefer cash/fixed income before equities. No new value-movement actions — it only re-orders existing withdrawal sources.

### 3.8 `TaxGainHarvestHandler`

The inverse of `TaxLossHarvest`: in a **low-income year** (projected taxable income below the top of the 0% long-term-capital-gains bracket), realize *gains* up to that ceiling and immediately rebuy — resetting cost basis upward at **zero** tax cost, which shrinks future taxable gains. Mostly tax-bracket-driven rather than regime-driven, but it shares TLH's substrate.

**Mechanism.** Reuses `STOCK_HARVEST_APPLY` (§3.3) with a positive realized gain. Two asymmetries vs. TLH: (a) there is **no wash-sale rule on gains**, so the rebuy can be the *same* security (no `taxLossPartner` needed); (b) it is gated on `projectedTaxableIncome < taxGainHarvestBracketCeiling` (from the tax module) rather than on a price-below-basis test. Realized gain flows through `STOCK_WITHDRAWAL_TAX` as normal — which nets to $0 tax inside the 0% band.

---

## 4. Substrate

Mirrors design 26's `SPENDING_STRATEGY_REGISTRY`:

```js
// src/finance/behavioral/behavioral-strategy-registry.js
export const BEHAVIORAL_STRATEGY_REGISTRY = {
  PANIC_SELL:               { handlers, reducers, paramSchema },
  CONTRIBUTION_SUSPENSION:  { handlers, reducers, paramSchema },
  TAX_LOSS_HARVEST:         { handlers, reducers, paramSchema },   // ⭐ flagship
  STRATEGIC_ASSET_LOCATION: { handlers, reducers, paramSchema },
  OPPORTUNISTIC_REBALANCE:  { handlers, reducers, paramSchema },
  DOWNTURN_ROTH_CONVERSION: { handlers, reducers, paramSchema },
  CASH_BUCKET_DRAWDOWN:     { handlers, reducers, paramSchema },
  TAX_GAIN_HARVEST:         { handlers, reducers, paramSchema },
};
```

Toolset selects via `parameters.behavioralStrategies: string[]` (an `EnumMulti`). Each strategy contributes handlers / reducers; **they are mutually independent — no cross-strategy registry coordination** (§11). The toolset `flatMap`s the selected strategies, exactly like design 26's `handlers()`/`reducers()`.

### 4.1 Regime tags

`REGIME_TAG` (`regime-tag.js`) grows new members. Today only `ECONOMIC_STRESS` exists; add `PANIC_SELL_TRIGGER` (and, if needed by a future strategy, `INFLATION_SHOCK`). Tags are set on the shock by the shock library; the behavioral layer reads `regime.tags`, the regime layer doesn't care. A crash preset like `MARKET_CRASH_2008_LITE` carries both `PANIC_SELL_TRIGGER` and `ECONOMIC_STRESS`.

### 4.2 Idempotency via `state.regimeActions`

Every once-per-regime strategy (`PanicSell`, `DownturnRothConversion`, the regime-entry trigger of `TaxLossHarvest`, the active/revert toggles of `CashBucketDrawdown` and `ContributionSuspension`) registers its own key under the existing `state.regimeActions` map and tracks `firedForShocks: string[]` (or `{ active, appliedMultiplier }` for reversible toggles). **No `state.behavioralFingerprints`** — the skeleton's invented field is replaced by the design-26 map.

---

## 5. Event / Handler / Action / Reducer architecture

| Action | Fields | Reducer | Priority | Notes |
|---|---|---|---|---|
| `BEHAVIORAL_PANIC_SELL_APPLY` | `stateKey`, `equityHoldingId`, `cashHoldingId`, `amount` | `BehavioralPanicSellApplyReducer` | `POSITION_UPDATE (30)` | tax-advantaged path only; taxable path emits `STOCK_WITHDRAWAL_APPLY` instead (§3.1) |
| `CONTRIBUTION_SUSPENSION_TOGGLE` | `suspended: boolean`, `reason` | `ContributionSuspensionToggleReducer` | `PRE_PROCESS (10)` | writes `state.contributionsSuspended` |
| `STOCK_HARVEST_APPLY` | `stateKey`, `sellAmount`, `substituteHoldingId`, `purpose: 'LOSS'\|'GAIN'` | `StockHarvestApplyReducer` | `CASH_FLOW (20)` | **signed** realized gain/loss; chains `STOCK_WITHDRAWAL_TAX` + the substitute `HOLDING_TRANSACT`; serves both §3.3 and §3.8 |
| `ASSET_LOCATION_REBALANCE_APPLY` | `moves: [{ fromStateKey, toStateKey, allocation, amount }]` | `AssetLocationRebalanceApplyReducer` | `POSITION_UPDATE (30)` | tax-advantaged-only swaps; mirrored `HOLDING_TRANSACT` pairs (§3.4) |
| `OPPORTUNISTIC_REBALANCE_APPLY` | `stateKey`, `legs: [{ allocation, delta }]` | `OpportunisticRebalanceApplyReducer` | `POSITION_UPDATE (30)` | within-account `HOLDING_TRANSACT` pairs toward target (§3.5) |
| *(reuse)* `K401_TO_IRA_CONVERSION` + Roth rollover chain | existing | existing | existing | `DownturnRothConversion` emits the existing conversion actions — no new action (§3.6) |
| `DRAWDOWN_SOURCE_OVERRIDE_TOGGLE` | `active: boolean`, `order: role[]` | `DrawdownSourceOverrideToggleReducer` | `PRE_PROCESS (10)` | writes `state.regimeActions['drawdown_source_override']` (§3.7) |

All value movement composes with design 25's `HOLDING_TRANSACT` / `consumeHoldingsFifo`; the behavioral actions are the **decision** layer orchestrating them. `STOCK_HARVEST_APPLY` is the only one that adds a new *tax* path (signed capital gain/loss).

---

## 6. State additions

- `state.regimeActions[*]` — reused (design 26). New keys: `'panic_sell'`, `'downturn_roth_conversion'`, `'tax_loss_harvest'` (regime-entry trigger only), `'drawdown_source_override'`, `'asset_location'`, `'opportunistic_rebalance'`. Each strategy lazily initializes its key. **Replaces** the skeleton's `state.behavioralFingerprints`.
- `state.contributionsSuspended: boolean` — single flag read by every contribution handler (§3.2). Initialized `false`.
- `Holding.taxLossPartner?: holdingId` — optional new Holding field for §3.3 substitute selection (round-trips through `holding.js` `toJSON`/`fromJSON`, defaulting `null`). The only data-model addition.

No top-level surgery beyond the boolean. Year-end-driven strategies (`TaxLossHarvest`, `TaxGainHarvest`, `StrategicAssetLocation`) need no fingerprint — they are scheduled annual events, naturally once-per-year.

---

## 7. Interaction with existing designs

| Design | Interaction |
|---|---|
| **25 Holdings** | Heavy. `PanicSell`/`OpportunisticRebalance` move value via `HOLDING_TRANSACT` pairs; `TaxLossHarvest`/`TaxGainHarvest` FIFO-consume holdings and rebuy substitutes; `StrategicAssetLocation` swaps allocations across accounts. Adds optional `Holding.taxLossPartner`. |
| **21 Regimes** | Heavy. Every reactive strategy reads `state.activeRegimes`; adds `REGIME_TAG.PANIC_SELL_TRIGGER`. Reuses `state.regimeActions`. |
| **26 Spending** | Independent but parallel (same registry pattern) **and shares `state.regimeActions`**. Behavioral and Spending strategies fire independently: a user enabling both `Guardrail` (cut discretionary) and `PanicSell` (rotate to cash) gets a **compounded** stress response, by design (§10 Q4). Different cadences (PanicSell once on entry; Guardrail annually). No gating. |
| **Tax modules** | `TaxLossHarvest`/`TaxGainHarvest` require the capital-gain YTD accumulator to accept a **signed** delta (`us-tax-module-2026.js`, `au-tax-module-2026.js`); `DownturnRothConversion` reuses the existing conversion tax path; `TaxGainHarvest` reads the projected-income / 0% LTCG ceiling from the tax module. |
| **27 Mortality** | Independent. Reactive strategies fire at regimes, not at `PERSON_DIED`. |
| **23 FX** | None. |

---

## 8. Out of scope

- **Behavioral calibration of defaults** — `panicFraction = 0.30`, `taxLossHarvestCap = 3000`, etc. are configurable knobs; empirical calibration is a research project.
- **Wash-sale window mechanics** — modeled only via the `taxLossPartner` substitute (a different security); the precise 30-day disallowance is not simulated (§3.3).
- **Capital-loss deduction cap + multi-year carryforward** — MVP nets signed gains/losses within the year; the `$3 000`/yr cap and carryforward ledger are a tax-module follow-up (§10 Q6).
- **Cross-account *taxable* asset relocation** — `StrategicAssetLocation` never forces a taxable sale to relocate (§3.4, §10 Q7); contribution-routing + tax-advantaged swaps only.
- **Bracket-fill conversions / gain-harvest optimization** — `DownturnRothConversion` and `TaxGainHarvest` use fixed amounts / a single ceiling at MVP; optimizing the conversion size or harvest amount to a bracket edge is a follow-up (§10 Q9).
- **Time-varying behavior** — investor calmness doesn't decay across a regime; handlers fire on entry. Modeling fatigue is future work.
- **Catch-up contribution back-fill after suspension ends** — forward-only by design (§3.2, §10 Q3).
- **Behavioral / Spending coordination** — independent by design (§7, §10 Q4).
- **Enabling contradictory pairs** (`PanicSell` + `OpportunisticRebalance`) — not gated; the toolset/UI should steer the user to pick one (§10 Q8).

---

## 9. Testing sketch

- `tests/unit/behavioral-tax-loss-harvest.test.mjs` — a holding below basis in a taxable account realizes the **signed** loss (asserts the YTD capital-gain accumulator goes *negative*, proving the §2 floor is bypassed), rebuys the `taxLossPartner`, respects the cap, and is a no-op in a tax-advantaged account.
- `tests/unit/behavioral-tax-loss-harvest-substitute.test.mjs` — explicit-partner → same-`rateKey` fallback → skip+warn when no substitute exists.
- `tests/unit/behavioral-tax-gain-harvest.test.mjs` — gains realized up to the 0% LTCG ceiling, rebuy of the *same* security, no-op above the ceiling.
- `tests/unit/behavioral-panic-sell.test.mjs` — `PANIC_SELL_TRIGGER` entry drops equity, adds cash, preserves the design-25 §4.4 holdings invariant; per-role branch (taxable routes `STOCK_WITHDRAWAL_APPLY` and realizes gain; tax-advantaged emits raw `HOLDING_TRANSACT`).
- `tests/unit/behavioral-panic-sell-idempotency.test.mjs` — fires once per regime entry, not per tick (via `state.regimeActions`).
- `tests/unit/behavioral-opportunistic-rebalance.test.mjs` — a drawdown pushes equity below target → rebalance buys equity back to target within the drift band.
- `tests/unit/behavioral-downturn-roth-conversion.test.mjs` — drawdown-regime entry fires the conversion chain once; conversion amount taxable in-year.
- `tests/unit/behavioral-cash-bucket-drawdown.test.mjs` — while the regime is active, spending is sourced from cash/fixed income before equities; reverts on exit.
- `tests/unit/behavioral-strategic-asset-location.test.mjs` — new bond contributions route to tax-deferred; a tax-advantaged-only swap concentrates bonds in sheltered space; **no taxable sale** is emitted.
- `tests/unit/behavioral-contribution-suspension.test.mjs` — contributions short-circuit during `ECONOMIC_STRESS`; resume forward-only (no back-fill) after.
- Extend `intl-retirement-mc-runner.test.mjs` with a regime-triggered behavioral sweep.

---

## 10. Open questions

> Skeleton answers preserved and reconciled to real code; new questions Q5–Q9 added for the expanded scope.

- **Q1 — TLH substitute-holding selection rule?** **Answer: user-specified pair with same-`rateKey` fallback.** Add optional `Holding.taxLossPartner: holdingId`. (1) explicit partner → (2) same-`rateKey` in the same account → (3) skip + warn. No same-allocation fallback (US equity ≠ international equity). Matches real TLH practice and is honest when no substitute exists. (§3.3)
- **Q2 — Does `PanicSell` realize the gain or treat it as a non-tax internal rebalance?** **Answer: per account role** (reconciled — there is no `account.type`). Tax-advantaged roles (`K401`/`IRA`/`ROTH`/`SUPER`) emit raw `HOLDING_TRANSACT` pairs; taxable roles (`US_STOCK`/`AU_STOCK`) route through `STOCK_WITHDRAWAL_APPLY` so FIFO basis and YTD tax apply. One branch, big correctness win. (§3.1)
- **Q3 — Does `ContributionSuspension` catch up after the regime ends?** **Answer: forward-only.** No back-fill, no `state.contributionsMissed`. The cut-on-entry / no-catch-up asymmetry is itself the behavioral observation. (§3.2)
- **Q4 — Does the behavioral layer coordinate with design 26's `Guardrail`?** **Answer: independent — no coordination.** Different dimensions (composition vs. spending), different cadences. Users enabling both choose a compounded stress response. Documented in §7. (§7)
- **Q5 — How does TLH realize a loss given `STOCK_WITHDRAWAL_APPLY` floors `gain` at 0?** **Answer: dedicated `STOCK_HARVEST_APPLY` action + reducer** carrying a *signed* gain/loss, rather than lifting the floor on the normal sell (which would change withdrawal semantics everywhere and risk unintended loss realization on ordinary drawdowns). The harvest action makes loss realization explicit and auditable, and is shared by `TaxGainHarvest`. (§3.3)
- **Q6 — Does TLH model the `$3 000` deduction cap and carryforward?** **Answer: not at MVP.** The reducer nets signed gains/losses within the year; the annual cap + multi-year carryforward ledger is a tax-module follow-up. The harvest *cap* (`taxLossHarvestCap`, default 3000) bounds realized loss per year as a coarse proxy. (§8)
- **Q7 — Does `StrategicAssetLocation` ever force a taxable sale to relocate?** **Answer: no, never.** Only two free levers: contribution routing + swaps between tax-advantaged accounts. Forcing a taxable sale would realize gains and defeat the strategy's purpose. Cross-account taxable relocation is permanently out of scope. (§3.4)
- **Q8 — `PanicSell` vs `OpportunisticRebalance` — gate one off when both selected?** **Answer: not gated, but contradictory.** They are opposite responses to the same signal; enabling both is incoherent. The toolset/UI should steer the user to pick one; the engine doesn't forbid it (consistent with the design-26 "users choose compounded modeling" stance). (§3.5)
- **Q9 — `DownturnRothConversion` / `TaxGainHarvest` amount — fixed or bracket-fill?** **Answer: fixed at MVP.** Bracket-fill (convert/harvest up to the top of a target bracket) needs a projected-taxable-income read from the tax module and is a follow-up. (§3.6, §3.8)

---

## 11. Doc-body follow-ups (folded in 2026-06-05)

These were skeleton follow-ups; all are now reflected in the section bodies above. Kept as a changelog.

- ✅ **§3.1 PanicSell:** per-account-**role** branch (Q2), reconciled from the nonexistent `account.type`.
- ✅ **§3.2 ContributionSuspension:** forward-only resume; single `state.contributionsSuspended` boolean (Q3).
- ✅ **§3.3 TaxLossHarvest:** promoted to flagship; substitute-selection algorithm (Q1); the loss-realization seam `STOCK_HARVEST_APPLY` (Q5); `Holding.taxLossPartner` added to the design-25 schema.
- ✅ **§3.4–3.8:** four new strategies + TaxGainHarvest fully specified.
- ✅ **§4 substrate:** strategies mutually independent; `REGIME_TAG.PANIC_SELL_TRIGGER` added to the real enum; idempotency via `state.regimeActions` (not `behavioralFingerprints`).
- ✅ **§5 action table:** PanicSell taxable path = `STOCK_WITHDRAWAL_APPLY`, tax-advantaged path = `BEHAVIORAL_PANIC_SELL_APPLY`; new `STOCK_HARVEST_APPLY`, `ASSET_LOCATION_REBALANCE_APPLY`, `OPPORTUNISTIC_REBALANCE_APPLY`, `DRAWDOWN_SOURCE_OVERRIDE_TOGGLE`.
- ✅ **§7 interaction table:** explicit 26-Spending compounded-response row; Tax-modules row for the signed-gain change.
- ✅ **§8 out of scope:** wash-sale window, loss cap/carryforward, taxable relocation, bracket-fill, catch-up back-fill, contradictory pairs.
- ✅ **§9 testing:** per-role PanicSell tests; signed-loss assertion for TLH; tests for the five new strategies.

---

## 12. Step-by-step Implementation Plan (added 2026-06-05)

### Status legend
- [ ] not started  ✅ complete

### Sequencing rationale

Mirrors the design-26 / 27 / 28 approach: land the lowest-risk additive scaffolding first, then the **flagship** (`TaxLossHarvest`) per the explicit prioritization, then the strategies that share its seam, then the regime-reactive and structural handlers grouped by the machinery they share. Every step bakes in the §10 answers and the §2 code-grounding — treat those as decided. Where the skeleton invented a symbol the steps reconcile to the real one inline (as design 28 §15 reconciled `RATE_KEYS[*].defaultDuration` → `RATE_KEY_META`).

**Build order:** Increment 1 (substrate + registry + tags) → Increment 2 (**TaxLossHarvest** ⭐ + the `STOCK_HARVEST_APPLY` seam, plus TaxGainHarvest which reuses it) → Increment 3 (DownturnRothConversion) → Increment 4 (StrategicAssetLocation) → Increment 5 (OpportunisticRebalance + PanicSell — opposite philosophies, shared `HOLDING_TRANSACT` rebalance machinery) → Increment 6 (CashBucketDrawdown + ContributionSuspension — flow-control toggles via `state.regimeActions`). Increments 2–6 are independent of each other and may be reordered; all depend on Increment 1. The flagship lands first (after substrate) by request.

**Grounding facts established before writing this plan** (the §2 placeholder is now filled — see §2 for the full list). The load-bearing one: `StockWithdrawalApplyReducer` floors `gain` at `Math.max(0, …)` (`us-brokerage-classes.js:207`), so loss realization needs the new `STOCK_HARVEST_APPLY` seam (Increment 2 Step 5).

---

### Increment 1 — Behavioral substrate, registry, regime tags

Pure scaffolding; no behavior change until a strategy is selected. Mirrors design 26 §12 decision 3 (registry + toolset `flatMap`).

**Step 1 — `REGIME_TAG.PANIC_SELL_TRIGGER`** ✅
- `src/finance/economic-regimes/regime-tag.js`: add `PANIC_SELL_TRIGGER: 'PANIC_SELL_TRIGGER'` (and `INFLATION_SHOCK` only if a strategy consumes it — defer until then). Reuse the existing `ECONOMIC_STRESS` for §3.2/§3.7.

**Step 2 — `BEHAVIORAL_STRATEGY_REGISTRY` skeleton** ✅
- Create `src/finance/behavioral/behavioral-strategy-registry.js` with the eight keys from §4, each `{ handlers: () => [], reducers: () => [], paramSchema: () => [] }` initially. Fill entries as their increments land. Mirror `spending-strategy-registry.js` exactly (same method shapes).

**Step 3 — Toolset wiring (`behavioralStrategies` EnumMulti)** ✅
- In the toolset(s) that own behavioral strategies (the `ECONOMIC_REGIMES` toolset is the natural home since these consume the regime layer — `src/scenarios/toolsets/economic-regimes-toolset.js`): add a `behavioralStrategies` param (`EnumMulti`, options = the eight registry keys, default `[]`) to `paramSchema()`; in `handlers()`/`reducers()`, `flatMap` the selected strategies through the registry (copy the design-26 pattern: `strats.flatMap(s => BEHAVIORAL_STRATEGY_REGISTRY[s].handlers(context))`).
- `INTL_RETIREMENT_DEFAULTS` (`src/scenarios/intl-retirement-scenario.js`): add `behavioralStrategies: []`.

**Step 4 — State init** ✅
- `src/finance/state/intl-retirement-state.js`: confirm `this.regimeActions = {}` exists (it does, from design 26); add `this.contributionsSuspended = false;`. No `behavioralFingerprints`.

**Step 5 — `state-schema-registry.js`** ✅
- Register `contributionsSuspended`, the new `regimeActions.*` behavioral keys, and (ahead of Increment 2) `*.holdings.*.taxLossPartner`, so the journal / state panel / CSV render them.

**Step 6 — Tests** ✅
- `tests/unit/behavioral-registry.test.mjs` — selecting `[]` registers nothing (bit-for-bit unchanged run); selecting a key wires exactly that strategy's handlers/reducers.

---

### Increment 2 — TaxLossHarvest ⭐ (+ the `STOCK_HARVEST_APPLY` seam, + TaxGainHarvest)

The flagship. Adds the signed loss/gain-aware sell seam the existing code lacks, then both harvest handlers that ride it.

**Step 7 — `Holding.taxLossPartner` field + round-trip** ✅
- `src/finance/holdings/holding.js`: add optional `taxLossPartner = null` to constructor, `toJSON`, `fromJSON` (default `null` keeps every bootstrap holding unchanged). Thread through any holdings serialization in `scenario-serializer.js` if holdings are serialized there.

**Step 8 — Signed capital gain/loss in the tax accumulator** ✅
- No code change needed: `STOCK_WITHDRAWAL_TAX` in both tax modules already accumulates `gain` with plain addition (no clamping). The clamping was only in `StockWithdrawalApplyReducer`. The new `STOCK_HARVEST_APPLY` seam passes the signed value directly.

**Step 9 — `STOCK_HARVEST_APPLY` action + `StockHarvestApplyReducer`** ✅
- `src/finance/behavioral/stock-harvest-apply-reducer.js`: targets a specific `sourceHoldingId` (not FIFO across all holdings), computes signed realizedGainLoss, rebuys `substituteHoldingId` (same-holding special case for TaxGainHarvest), chains `STOCK_WITHDRAWAL_TAX`. Cash pool unchanged (sell + rebuy cancel).

**Step 10 — Substitute-selection util** ✅
- `src/finance/behavioral/substitute-holding.js#resolveSubstitute(holdings, soldHolding)`: (1) `soldHolding.taxLossPartner` if set; (2) first other holding with matching `rateKey`; (3) `null` (caller skips + warns).

**Step 11 — `TaxLossHarvestHandler`** ✅
- `src/finance/behavioral/tax-loss-harvest-handler.js` (`HandlerEntry`). Triggered by annual `TAX_LOSS_HARVEST` event (ECONOMIC_REGIMES toolset `schedules()`). Iterates taxable accounts (US_STOCK, AU_STOCK state keys), finds holdings below basis, emits STOCK_HARVEST_APPLY up to `taxLossHarvestCap`.

**Step 12 — `TaxGainHarvestHandler`** ✅
- `src/finance/behavioral/tax-gain-harvest-handler.js`. Annual `TAX_GAIN_HARVEST` event, gated on `usOrdinaryIncomeYTD + usCapitalGainsYTD < taxGainHarvestBracketCeiling`. Rebuys same holding (sourceHoldingId === substituteHoldingId; no wash-sale rule on gains).

**Step 13 — Registry entries + params** ✅
- `TAX_LOSS_HARVEST` / `TAX_GAIN_HARVEST` entries filled in `BEHAVIORAL_STRATEGY_REGISTRY`; schedules added to `economic-regimes-toolset.js` `schedules()`; params exposed: `taxLossHarvestCap`, `taxLossHarvestOnRegimeEntry`, `taxGainHarvestBracketCeiling`.

**Step 14 — Tests** ✅
- `tests/unit/behavioral-tax-loss-harvest.test.mjs`: 19 tests covering StockHarvestApplyReducer (signed loss, rebuy, balance invariant, partial sell, same-holding gain rebuy), TaxLossHarvestHandler (cap, no-substitute skip, tax-advantaged skip), resolveSubstitute (3 cases), TaxGainHarvestHandler (ceiling gate, same-security rebuy, loss-skip).

---

### Increment 3 — DownturnRothConversion

Regime-timed conversion reusing the existing conversion chain. No new value-movement action.

**Step 15 — `DownturnRothConversionReducer`** ✅
- `src/finance/behavioral/downturn-roth-conversion-reducer.js`. Fires on `US_PERIOD_ADVANCE`/`AU_PERIOD_ADVANCE` (same pattern as `RegimeAwareSpendingReducer`), checks `activeRegimes` for PANIC_SELL_TRIGGER or ECONOMIC_STRESS, emits `ROTH_CONVERSION_APPLY` once per shock (`firedForShocks` idempotency), caps at IRA balance.

**Step 16 — Registry entry + param + test** ✅
- `DOWNTURN_ROTH_CONVERSION` registry entry; `downturnConversionAmount` param (default 20000). `behavioral-downturn-roth-conversion.test.mjs` — 9 tests: fires on entry, idempotent, ECONOMIC_STRESS tag, zero-IRA no-op, balance cap, new-shock re-fire, firedForShocks update.

---

### Increment 4 — StrategicAssetLocation

Two free levers only — contribution routing + tax-advantaged swaps. Never a taxable sale (§10 Q7).

**Step 17 — `StrategicAssetLocationReducer` + `AssetLocationRebalanceApplyReducer`** ✅
- `src/finance/behavioral/strategic-asset-location-reducer.js`: Annual, fires on period advance. Lever 2 only (tax-advantaged swaps). Identifies mislocated holdings per `assetLocationPolicy`, emits `ASSET_LOCATION_REBALANCE_APPLY { fromStateKey, fromHoldingId, toStateKey, toHoldingId, swapAmount }`. Never touches taxable accounts. Default policy: BOND → IRA/K401, EQUITY → ROTH.
- `src/finance/behavioral/asset-location-rebalance-apply-reducer.js`: POSITION_UPDATE priority, moves value between two holdings in separate tax-advantaged accounts. Lever 1 (contribution routing) deferred.

**Step 18 — Registry entry + test** ✅
- `STRATEGIC_ASSET_LOCATION` registry entry with `assetLocationPolicy` param. `behavioral-strategic-asset-location.test.mjs` — 6 tests: swap moves value correctly, balance invariant, no-op when policy satisfied, taxable account never in swap.

---

### Increment 5 — OpportunisticRebalance + PanicSell

Opposite philosophies on the same drawdown signal; both move value via `HOLDING_TRANSACT` pairs, so they share rebalance plumbing.

**Step 19 — `OpportunisticRebalanceHandler` + reducer** [ ]
- `src/finance/behavioral/opportunistic-rebalance-handler.js`. On drift-band breach or drawdown-regime entry, compute per-account allocation fractions vs. `targetAllocation`; if drift > `rebalanceDriftBand` (default 0.05), emit `OPPORTUNISTIC_REBALANCE_APPLY { stateKey, legs }`. `OpportunisticRebalanceApplyReducer` (`POSITION_UPDATE (30)`) applies within-account `HOLDING_TRANSACT` pairs toward target (free in tax-advantaged; MVP keeps taxable rebalancing to cash/contribution routing).

**Step 20 — `PanicSellHandler` + `BehavioralPanicSellApplyReducer`** [ ]
- `src/finance/behavioral/panic-sell-handler.js`. On `PANIC_SELL_TRIGGER` entry (idempotent via `state.regimeActions['panic_sell']`), for each `EQUITY` holding move `severity × panicFraction × marketValue` to `CASH`. **Per-role branch:** tax-advantaged → `BEHAVIORAL_PANIC_SELL_APPLY` (reducer at `POSITION_UPDATE (30)`, raw `HOLDING_TRANSACT` pair); taxable → `STOCK_WITHDRAWAL_APPLY` (realizes gain). `panicFraction` param default 0.30.

**Step 21 — Registry entries + tests** [ ]
- `OPPORTUNISTIC_REBALANCE` / `PANIC_SELL` registry entries with params. `behavioral-opportunistic-rebalance.test.mjs` (buy-the-dip to target within band), `behavioral-panic-sell.test.mjs` (per-role branch; §4.4 invariant), `behavioral-panic-sell-idempotency.test.mjs` (once per entry). Document the contradiction (§10 Q8) — no test asserts gating because none exists by design.

---

### Increment 6 — CashBucketDrawdown + ContributionSuspension

Two flow-control toggles; neither moves value directly. Both flip a `state` flag read by existing handlers.

**Step 22 — `ContributionSuspension`** [ ]
- `ContributionSuspensionToggleReducer` (`PRE_PROCESS (10)`, on `US/AU_PERIOD_ADVANCE`): set `state.contributionsSuspended = state.activeRegimes.some(r => r.tags?.includes(ECONOMIC_STRESS))`. Short-circuit each contribution handler (`K401ContributionHandler`, IRA, Roth, Super — `call({ data, state })`) with `if (state.contributionsSuspended) return [];`. Forward-only (§10 Q3) — no missed-contribution tracking.

**Step 23 — `CashBucketDrawdown`** [ ]
- `DrawdownSourceOverrideToggleReducer` (`PRE_PROCESS (10)`): while a `PANIC_SELL_TRIGGER`/`ECONOMIC_STRESS` regime is active, set `state.regimeActions['drawdown_source_override'] = { active: true, order: [cash, fixed-income, …, equity-last] }`; revert on exit (apply/revert pattern of `RegimeAwareSpendingReducer`). Teach the `REPLENISH_SAVINGS` escalation source-walk (the path `MonthlyExpensesHandler` prepends) to honor the override order when `active`.

**Step 24 — Registry entries + tests** [ ]
- `CONTRIBUTION_SUSPENSION` / `CASH_BUCKET_DRAWDOWN` registry entries. `behavioral-contribution-suspension.test.mjs` (suspend during stress; forward-only resume), `behavioral-cash-bucket-drawdown.test.mjs` (source order favors cash/bonds while active; reverts on exit).

---

### Out of this plan (tracked elsewhere)

- **Capital-loss deduction cap + multi-year carryforward** — tax-module follow-up (§8, §10 Q6). MVP nets signed within-year only.
- **Wash-sale 30-day window** — modeled only via the substitute security (§3.3, §8).
- **Cross-account taxable relocation for StrategicAssetLocation** — permanently out of scope (§3.4, §10 Q7).
- **Bracket-fill sizing for DownturnRothConversion / TaxGainHarvest** — fixed amounts at MVP; bracket-edge optimization needs a tax-module projected-income read (§10 Q9).
- **Behavioral calibration of default knobs** — research, not engineering (§8).
