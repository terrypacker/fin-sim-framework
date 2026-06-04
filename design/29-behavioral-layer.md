# 29 — Behavioral Layer

**Status**: Skeleton (Phase D per `design/24-financial-modeling-roadmap.md` §5)
**Phase dependencies**: Phase A (`design/25-holding-level-state.md`) for the Holdings primitive. Design 21 (`design/21-financial-shock-and-regime-framework.md`) for the regime substrate. Both must be stable before this design ships.
**Related**: `design/24-financial-modeling-roadmap.md` §3.5, `design/21-financial-shock-and-regime-framework.md` (`state.activeRegimes`, regime tags), `design/25-holding-level-state.md` (`Holding`, `HOLDING_TRANSACT`, `holdingsByAllocation`), `design/26-dynamic-spending-strategies.md` (parallel pluggable-strategy pattern).
**Author note**: Skeleton document. Section bodies are placeholders to be filled when Phase D opens. Captures roadmap §3.5 commitments. The strategy-registry pattern mirrors design 26 deliberately.

---

## 1. Purpose

Portfolio behavior today is mechanical — scheduled earnings, scheduled withdrawals, no investor reaction to crises. A defensible plan reacts: panic selling under crashes, suspended contributions under stress, tax-loss harvesting at year end. This design adds handlers that read `state.activeRegimes` and emit portfolio-restructuring actions.

---

## 2. Today

> *To populate when Phase D opens.*

Pointer: No reactive behavior exists. Earnings handlers compute growth × balance; withdrawal handlers consume drawdown priorities; contribution handlers fire on schedule regardless of market state.

---

## 3. Handlers

### 3.1 `PanicSellHandler`

Triggered by `state.activeRegimes` containing any regime tagged `panicSellTrigger`. On entry into such a regime, a probabilistic fraction of `EQUITY` holdings rotates to `CASH`. Mechanism:

1. Read `state.activeRegimes`; find the first regime with `tags.includes('panicSellTrigger')` and a `panicSellSeverity` field.
2. For each account whose holdings include at least one `EQUITY` allocation:
3. For each `EQUITY` holding, emit a `HOLDING_TRANSACT` reducing `marketValue` by `severity × marketValue × panicFraction` and a paired `HOLDING_TRANSACT` increasing a `CASH` holding (find-or-create) by the same amount.
4. Realize basis on the equity sold per design 25's FIFO machinery (the sale routes through the standard stock-withdrawal action for tax accounting).

`panicFraction` is a behavioral parameter (default 0.30). `panicSellSeverity` is a regime property.

Fires exactly once per regime entry (idempotency via `state.behavioralFingerprints`, see §6).

### 3.2 `ContributionSuspensionHandler`

Under any regime tagged `economicStress`, suspend new contributions (401(k), IRA, Super) for the regime's duration. Mechanism: a pre-process reducer reads `state.activeRegimes` each period boundary and writes `state.contributionsSuspended: boolean`. Each contribution handler short-circuits when the flag is true.

Single new state field, no new action types.

### 3.3 `TaxLossHarvestHandler` *(future-future)*

At year end, sells `EQUITY` holdings with `unrealizedGainLoss < 0` up to a configurable cap, then reinvests in a substitute holding. Requires cost-basis-as-state (design 25 — done) and a substitute-holding selection rule (this design's open question).

Lower priority than the other two handlers; explicitly future-future in the roadmap. Ships in a follow-up to this design rather than as part of the initial PR.

---

## 4. Substrate

Mirrors design 26's `SPENDING_STRATEGY_REGISTRY` pattern:

```js
// src/finance/behavioral/behavioral-strategy-registry.js
const BEHAVIORAL_STRATEGY_REGISTRY = {
  PANIC_SELL:              { handlers, reducers, paramSchema, … },
  CONTRIBUTION_SUSPENSION: { handlers, reducers, paramSchema, … },
  TAX_LOSS_HARVEST:        { handlers, reducers, paramSchema, … },   // future-future
};
```

Toolset selects strategies via `parameters.behavioralStrategies: string[]` (an EnumMulti). Each strategy contributes handlers / reducers; they compose.

### 4.1 Regime tags

`EconomicRegime` grows an optional `tags: string[]` field. Stock tags: `'panicSellTrigger'`, `'economicStress'`, `'inflationShock'`. The behavioral layer reads `regime.tags`; the regime layer doesn't care about them. Tags are set by the shock library — `MARKET_CRASH_2008_LITE` includes `panicSellTrigger` + `economicStress`.

This is one new optional field on the design-21 data model; tracked in this doc rather than as a design-21 amendment because it's only consumed by behavioral handlers.

---

## 5. Event / Handler / Action / Reducer architecture

> *Tables to populate when Phase D opens.*

Sketch:

| Action | Fields | Reducer | Priority |
|---|---|---|---|
| `BEHAVIORAL_PANIC_SELL_APPLY` | `accountStateKey`, `equityHoldingId`, `cashHoldingId`, `amount` | `BehavioralPanicSellApplyReducer` | `POSITION_UPDATE (30)` |
| `CONTRIBUTION_SUSPENSION_TOGGLE` | `suspended: boolean`, `reason` | `ContributionSuspensionToggleReducer` | `PRE_PROCESS (10)` |
| `TAX_LOSS_HARVEST_APPLY` *(future-future)* | `accountStateKey`, `lots: […]`, `substituteHoldingId` | `TaxLossHarvestApplyReducer` | `COST_BASIS (40)` |

All compose with design 25's `HOLDING_TRANSACT` and `HOLDING_SET_BASIS` for the actual value/basis movement; the behavioral actions are the *decision* layer that orchestrates them.

---

## 6. State additions

> *To populate.*

Sketch:

- `state.behavioralFingerprints: { [strategy]: Set<regimeId> }` — idempotency tracker so `PanicSellHandler` fires once per regime entry, not once per period tick inside the regime.
- `state.contributionsSuspended: boolean`.

No top-level data-model surgery.

---

## 7. Interaction with existing designs

| Design | Interaction |
|---|---|
| **25 Holdings** | Heavy: panic-sell moves equity → cash via `HOLDING_TRANSACT` pairs; tax-loss-harvest reads `holdingsByAllocation` + `unrealizedGainLoss`. |
| **21 Regimes** | Heavy: every handler reads `state.activeRegimes`. Adds optional `regime.tags`. |
| **26 Spending** | Independent but parallel architecture (strategy registry). |
| **27 Mortality** | Independent. (A `PanicSellHandler` would fire at a regime, not at `PERSON_DIED`.) |
| **23 FX** | None. |

---

## 8. Out of scope

- **Behavioral calibration of defaults** — `panicFraction = 0.30` is a configurable knob; empirical calibration is its own (research, not engineering) project.
- **Time-varying behavior** — investor calmness doesn't decay across the regime; mechanically, the handler just fires on entry. Modeling fatigue is future work.
- **Cross-account rebalancing.** Each account makes its own decision based on its own holdings; portfolio-wide rebalancing is a separate design.
- **Reactive contribution increases** under bull markets — only suspension under stress. The asymmetry is intentional (modeling stress responses is the whole point).
- **Tax-loss harvesting at the year-end cap.** Ship the substrate; the policy (cap = $3000? lot-selection = SPECIFIC?) is a follow-up once the handler is wired.

---

## 9. Testing sketch

- `tests/unit/behavioral-panic-sell.test.mjs` — entering a `panicSellTrigger` regime drops equity, adds cash, preserves the §4.4 holdings invariant from design 25.
- `tests/unit/behavioral-contribution-suspension.test.mjs` — contributions short-circuit during `economicStress`; resume after.
- `tests/unit/behavioral-panic-sell-idempotency.test.mjs` — `PanicSellHandler` fires once per regime entry, not per tick.
- Extend `intl-retirement-mc-runner.test.mjs` with a regime-triggered behavioral sweep.

---

## 10. Open questions

> *Capture during Phase D kickoff. Initial seed:*

- For tax-loss harvesting, what's the substitute-holding selection rule? (Same allocation, different `label`? Same `rateKey`? User-specified pair?) **Answer: User-specified pair with same-`rateKey` fallback.** Add optional `holding.taxLossPartner: holdingId` field. Selection algorithm: (1) if `taxLossPartner` is set, use it; (2) otherwise, find any other holding in the same account with matching `rateKey` and use the first match; (3) if no match available, skip the harvest and log a warning (do not fall back to same-allocation — too coarse, US equity ≠ international equity even though both carry `ALLOCATION.EQUITY`). Reason: matches real investor practice (most TLH'ers have pre-designated partner ETFs) and is honest when no substitute exists. Since §3.3 is explicitly "future-future," this rule can be deferred — but pinning it now informs the design-25 Holdings schema (the `taxLossPartner` field).
- Does `PanicSellHandler` realize the gain (route through the standard stock-withdrawal handler with the FIFO basis) or treat it as a non-tax internal rebalance? **Answer: Per account type.** Handler reads `account.type` and branches: tax-deferred (`FOUR_OH_ONE_K`, `ROTH`, `TRADITIONAL_IRA`, `SUPER`) → emit `HOLDING_TRANSACT` pairs directly without invoking tax machinery; taxable (`BROKERAGE`) → route through the standard sell mechanism so FIFO basis applies and the realized gain/loss reaches the YTD tax accumulators. Tiny implementation cost (one branch), big correctness win. Anything else is wrong for one or the other account class.
- Should `ContributionSuspensionHandler` resume contributions in a "catch-up" mode (back-fill the missed quarters) or just resume forward? **Answer: Forward-only.** The mechanism is "suspended," not "deferred" — no back-fill, no state tracking of missed contributions. Reason: real behavioral data favors forward-only (investors who got out of the habit don't typically lump-sum back in), and the asymmetry (cut on entry, no catch-up on exit) is itself the behavioral observation worth modeling. Users who want catch-up behavior can add a one-off contribution event manually. Saves state, saves complexity.
- Does behavioral layer interact with design 26's `Guardrail`? (A user might cut spending *and* panic-sell — both can fire.) **Answer: Independent — no coordination.** Each strategy operates on its own dimension (spending vs. portfolio composition) and they're both valid responses to stress. Different cadences too: `PanicSellHandler` fires once on regime entry (idempotent via `state.behavioralFingerprints`); `Guardrail` fires annually at retirement-anniversary. Users enabling both have implicitly chosen compounded modeling. Document the compounded-response intent in §7's interaction table so it's not surprising — but no logic gating one off the other.

---

## 11. Doc-body follow-ups (from §10 answers)

Sections to update before implementation begins:

- **§3.1 PanicSellHandler:** add the per-account-type branch (Q2). Spell out that taxable accounts route the sell through standard FIFO-basis withdrawal; tax-deferred accounts emit `HOLDING_TRANSACT` pairs without tax routing.
- **§3.2 ContributionSuspensionHandler:** add explicit "forward-only resume; no catch-up" note (Q3). No `state.contributionsMissed` field — keep the state surface to just the boolean toggle.
- **§3.3 TaxLossHarvestHandler:** specify the substitute-selection algorithm (Q1: explicit pair → same-rateKey fallback → skip+warn). Note that this adds optional `holding.taxLossPartner: holdingId` to the design-25 Holdings schema (which may also want to be picked up early if it influences serialization shape).
- **§4 substrate:** confirm `BEHAVIORAL_STRATEGY_REGISTRY` strategies are mutually independent — no cross-strategy registry coordination.
- **§5 action table:** PanicSellHandler emits *either* `BEHAVIORAL_PANIC_SELL_APPLY` (tax-deferred path) *or* the standard sell action chain (taxable path). Reflect this in the action table — possibly as two action variants or a `taxable: boolean` field on the action.
- **§7 interaction table:** add an explicit row for **26 Spending** noting that Behavioral and Spending strategies fire independently — users enabling both will see compounded stress responses, which is intentional (Q4).
- **§8 out of scope:** add "Catch-up contribution back-fill after suspension ends (forward-only by design)" and "Behavioral / Spending coordination (independent by design)."
- **§9 testing sketch:** add per-account-type tests for `PanicSellHandler` (one taxable, one tax-deferred; assert different downstream effects). Add a test asserting `ContributionSuspensionHandler` does not back-fill on regime exit.
