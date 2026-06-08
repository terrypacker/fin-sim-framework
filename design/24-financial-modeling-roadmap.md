# 24 — Financial Modeling Roadmap

**Status**: Draft (umbrella)
**Resolves**: Design 21 §16 future-work items: asset allocation per account, bond duration, dividend-yield cuts, behavioral / panic selling, cost basis as holding-level state.
**Related**: `design/21-financial-shock-and-regime-framework.md` (regime composition this builds on), `design/23-fx-exchange.md` (effective-rate substrate), `design/15-config-as-source-of-truth.md` (config/state ownership boundary).
**Author note**: This is an **umbrella** doc. It names the cross-cutting architectural commitments, groups the eight open financial-modeling concepts into five themes, sequences them, and points at follow-on per-theme designs (25–29). Per-feature implementation detail lives in the follow-ons; the umbrella locks in the shared substrate so they share a common foundation.

---

## 1. Purpose

Designs 21 (regimes) and 23 (FX) gave the framework composable **rates**: returns, interest, inflation, FX, and appreciation can now respond to an active economic environment. Composing rates is necessary but not sufficient to model an actual retirement scenario under stress.

This roadmap captures the **next layer** of financial-modeling depth — the things that turn the simulation from "balances grow at composable rates" into a defensible retirement-planning tool:

- Portfolios that have **structure** (equity vs bond vs cash inside an account), not just a balance.
- Spending that **responds** to portfolio performance and regime state, not just a flat monthly number.
- Lifespans that **vary** across Monte Carlo draws so the user can see sequence-of-return risk against an actuarial backdrop.
- Asset values that **evolve** along richer paths than a single appreciation scalar.
- Behavior that **reacts** to crises (panicked selling, suspended contributions).

Each of these is its own design. The job of this umbrella is to:

1. Identify the shared substrate so the follow-on designs don't each invent their own version.
2. Sequence the work so the substrate ships before its consumers.
3. Make the architectural commitments visible: where `Holding`-level state lives, how lifecycle events plug in, where stochasticity sits.

---

## 2. Where We Are Today

| Concern | Today's model |
|---|---|
| Account portfolio structure | `Account.balance` is a scalar. One growth rate per account. Cost basis is transactional (computed at sale time off `costBasis` on `STOCK_WITHDRAWAL_APPLY`). |
| Asset appreciation | `RealProperty.appreciationRate`, `Collectible.appreciationRate` are scalars. Per-rate-key, regime-adjustable post design 21. |
| Spending | `state.monthlyExpenses` is a scalar, inflated annually per country (`InflationAdjustReducer`). No strategy layer. |
| Mortality | `Person.lifeExpectancy` is a fixed input. No `PERSON_DIED` event. No survivor logic. Late-life care is not modeled. |
| Bond mechanics | `FixedIncomeAccount` is one growth rate. No duration; no yield curve. |
| Dividends | `DividendScheduledHandler` uses a static yield. Design 21 explicitly skips dividend cuts under regimes. |
| Behavior | Mechanical. No panic selling, no contribution suspension under stress. |
| Stochasticity | Single runs deterministic. Monte Carlo perturbs flat scenario params. |

The composable-rates work in designs 21 and 23 is the **rate layer**. This roadmap covers everything *above* the rate layer that consumes rates and produces realistic balance-sheet behavior.

---

## 3. Five Themes

The eight open concepts collapse into five coherent themes. Each theme is its own follow-on design.

### 3.1 Holdings & Allocation — *Foundational*

**Concepts covered**: asset allocation per account (60/40 inside a 401k); cost basis as holding-level state; the prerequisite for dividend-yield cuts and behavioral selling.

**Today**: `Account.balance` is scalar; cost basis lives on individual stock-withdrawal actions; "what fraction of this 401k is equity?" cannot be answered.

**Future**:

```js
class Holding {
  id;              // UUID
  allocation;      // 'EQUITY' | 'BOND' | 'CASH' | 'OTHER' — drives regime rate-key selection
  marketValue;     // current value
  costBasis;       // basis for realized-gain math
  unrealizedGainLoss;  // derived: marketValue - costBasis
  purchaseDate;    // for FIFO/LIFO accounting and holding-period determination
  rateKey;         // optional override; defaults derive from (allocation, account.currency)
}

class Account {
  holdings;                                                  // Holding[]
  get balance() { return this.holdings.reduce((s, h) => s + h.marketValue, 0); }
}
```

**Unlocks**:

- Per-account allocation (a 401k can be 60% `EQUITY_US` + 30% `FIXED_INCOME_US` + 10% `CASH`; an equity shock only hits the equity slice).
- Cost basis as a first-class state field (tax-loss harvesting becomes tractable).
- Dividend-yield cuts (dividend yield is a property of equity holdings; a regime adjustment scales the per-holding rate).
- Behavioral selling (panic-sell some fraction of the equity holdings into cash).

**Migration**: each existing account is initialized with a **single holding** matching its current scalar balance and a per-account-type default allocation (`EQUITY_US` for retirement equity accounts, `FIXED_INCOME_US` for the fixed-income account, etc.). Mutators that previously wrote `account.balance` migrate to `account.transact(amount, { allocation })` or similar; the helper hides the holding lookup for call sites where the slice is unambiguous.

**Owner**: **design 25 — Holding-Level State** ([`design/25-holding-level-state.md`](25-holding-level-state.md)).

---

### 3.2 Dynamic Spending Strategies

**Concepts covered**: guardrail spending; inflation-adjusted spending (extends today's `InflationAdjustReducer`); discretionary cuts during downturns; healthcare shock events.

**Today**: `state.monthlyExpenses` is a scalar; `InflationAdjustReducer` inflates it annually. No conditional logic, no regime awareness, no event-driven medical expenses.

**Future**: a pluggable **spending strategy** layer. The strategy lives behind the same handler/reducer pattern as everything else; the toolset selects which strategy ships:

| Strategy | Behavior |
|---|---|
| `FixedInflationAdjusted` (current) | Scalar `monthlyExpenses`, inflated annually. Default. |
| `Guardrail` (Guyton-Klinger) | Reads portfolio value vs. a target band each year; if portfolio down > X%, cut spending by Y%; if up > Z%, raise by W%. |
| `RegimeAware` | Reads `state.activeRegimes`; under any regime tagged `economicStress`, multiplies the discretionary slice of spending by a configurable cut factor. Discretionary vs essential split is configured per-scenario. |
| `HealthcareEventDriven` | Adds one-off `HEALTHCARE_EXPENSE` `OneOffEvent`s (deterministic or MC-drawn) on top of any base strategy. |

Strategies compose: a scenario can run `FixedInflationAdjusted` + `Guardrail` + `RegimeAware` + `HealthcareEventDriven` simultaneously. Each registers its own handler/reducer; the order they run in is set by `PRIORITY`.

**Acts on cash flow, not portfolio structure** — design 26 doesn't read `Holding` directly. Per the §5 sequencing, it still ships after design 25 so the substrate is stable.

**Owner**: **design 26 — Dynamic Spending Strategies** ([`design/26-dynamic-spending-strategies.md`](26-dynamic-spending-strategies.md), skeleton).

---

### 3.3 Mortality & Survivor Mechanics

**Concepts covered**: Monte Carlo lifespan; survivor probability; late-life care event.

**Today**: `Person.lifeExpectancy` is a fixed input; the simulation runs until `simEnd` regardless of person ages; no household-composition change on death.

**Future**:

- **`PERSON_DIED` `OneOffEvent`** — scheduled at `Person.birthDate + Person.lifeExpectancy` (years) at scenario boot.
- **`MortalityHandler`** — emits a chain of `PERSON_DIED_APPLY` + secondary actions:
  - Removes the person from `state.people`.
  - If a spouse survives: switches household monthly expenses to a survivor multiplier (e.g. 70% of joint expenses); transitions SS to survivor benefit (`monthlySocialSecurity = max(self, deceased)`); retitles solo-owned retirement accounts per estate rules (out of scope details — see §7).
  - If no spouse survives: emits `SCENARIO_COMPLETE` and terminates.
- **Late-life care window** — a per-person `lateLifeCareMonths` parameter (default 0). During the last N months before death, monthly expenses are multiplied by `lateLifeCareFactor`. Configured per-person at scenario boot.
- **Monte Carlo lifespan** — `IntlRetirementMcConfig` supports drawing `Person.lifeExpectancy` from an actuarial distribution (CDC 2024 life tables or similar; per-person, per-sex). Single runs use the fixed `Person.lifeExpectancy` (matches the shock-framework stance from design 21: deterministic single runs, stochastic MC).

**Does not read portfolio structure** — design 27 doesn't touch `Holding`. Per the §5 sequencing, it still ships after design 25. Depends on the small formalization of lifecycle events (§4.2).

**Owner**: **design 27 — Mortality & Survivor Mechanics** ([`design/27-mortality-and-survivor-mechanics.md`](27-mortality-and-survivor-mechanics.md), skeleton).

---

### 3.4 Time-Varying Appreciation & Bond Duration

**Concepts covered**: asset appreciation over time for real property and collectibles (richer than a single scalar); bond duration / yield-curve impact on fixed-income holdings.

**Today**: `RealProperty.appreciationRate` and `Collectible.appreciationRate` are scalars. Design 21 lets regimes adjust them per rate key, but the *base* rate is constant per asset. `FixedIncomeAccount` has a single growth rate with no duration concept.

**Future**:

- **Per-holding appreciation curves** — `Holding.appreciationSchedule: { date, rate }[]` for assets with known forward projections (e.g. a collectible whose appraisal trajectory is known). Defaults to a single entry = today's scalar.
- **Real-estate location codes** — `RealProperty.market` (e.g. `US-SF-BAY`, `AU-NSW-SYD`) drives a market-specific rate key so regional shocks (a Bay Area housing crash) don't move every property.
- **Bond duration** — `Holding.duration` (modified duration, in years) on `BOND`-allocation holdings. When `state.effectiveInterestRates[rateKey]` changes, `RegimeApplyReducer` (or a small new `BondPriceAdjustReducer`) marks the holding to market by `Δprice = -duration × Δrate × marketValue`.
- **Yield curve** — explicitly **future after this design**. We start with a single short-term rate per bond holding; per-maturity yields are a follow-up.

**Depends on Holdings**: per-holding appreciation and per-holding duration both want the `Holding` primitive from design 25.

**Owner**: **design 28 — Time-Varying Appreciation & Bond Duration** ([`design/28-time-varying-appreciation-and-bond-duration.md`](28-time-varying-appreciation-and-bond-duration.md), skeleton).

---

### 3.5 Behavioral Layer

**Concepts covered**: panic selling; reduced contributions under stress; (future) tax-loss harvesting strategies.

**Today**: portfolio behavior is mechanical — scheduled earnings, scheduled withdrawals, no investor reaction to crises.

**Future**: handlers that read `state.activeRegimes` and emit portfolio-restructuring actions:

- **`PanicSellHandler`** — under a regime tagged `panicSellTrigger`, a probabilistic fraction of `EQUITY` holdings rotates to `CASH`. Severity is a regime property; fraction sold is a behavioral parameter.
- **`ContributionSuspensionHandler`** — under economic-stress regimes, suspend 401k / IRA / Super contributions for the regime duration.
- **`TaxLossHarvestHandler`** *(future-future)* — at year end, sells `EQUITY` holdings with `unrealizedGainLoss < 0` up to a configurable cap, then reinvests in a substitute holding. Requires the cost-basis-as-state piece from design 25.

**Depends on both Holdings (design 25) and Regimes (design 21)**.

**Owner**: **design 29 — Behavioral Layer** ([`design/29-behavioral-layer.md`](29-behavioral-layer.md), skeleton).

---

## 4. Cross-Cutting Architectural Commitments

These are the shared substrate pieces that multiple themes depend on. They are the reason this is an umbrella doc rather than five independent designs.

### 4.1 `Holding` as the canonical sub-balance

`Account.balance` becomes a derived getter; `Account.holdings: Holding[]` is the source of truth. Design 25 owns the refactor. Every theme except dynamic spending and mortality reads or writes holdings.

The migration preserves backward compatibility: every existing account starts with a single `Holding` whose `allocation` matches the account's canonical default. Mutators that don't care about allocation (a savings-account interest credit) use a helper that targets the account's default holding; mutators that do care (a regime-driven panic sell) target the specific allocation slice.

### 4.2 Lifecycle events

The framework already has `CHANGE_RESIDENCY` as a per-person lifecycle event. This roadmap adds:

- `PERSON_DIED` (§3.3)
- `HEALTHCARE_EXPENSE` (§3.2; one-off, can be MC-scheduled)
- `RETIREMENT_DATE_REACHED` is already implicit; this roadmap recommends making it an explicit lifecycle event so spending strategies can hook it.

No new framework infrastructure is required — these all follow the `OneOffEvent` → handler → action → reducer pattern. The commitment is **vocabulary**: lifecycle events get the `LIFECYCLE_*` prefix or a dedicated `kind` so the workbench can show them as a separate track.

### 4.3 Strategy-style pluggables

Both dynamic spending (§3.2) and behavioral handlers (§3.5) want the same pattern: a strategy is selected via scenario param, and the toolset wires the corresponding handler. The pattern is:

```js
// Toolset paramSchema:
{ key: 'spendingStrategy', type: 'Enum', options: ['FIXED', 'GUARDRAIL', 'REGIME_AWARE', ...] }

// Toolset handlers(context):
const strat = context.parameters.spendingStrategy;
const Cls   = SPENDING_STRATEGY_REGISTRY[strat];
return [new Cls({ ...strategyParams })];
```

This is not new infrastructure — it's a usage convention. But naming it now makes the follow-on designs interoperable.

### 4.4 Stochasticity seam

Both shocks (design 21) and mortality (§3.3) follow the same rule: **deterministic in single runs; stochastic via MC config**. The substrate piece this depends on is `IntlRetirementMcConfig`'s ability to draw **nested / per-person parameters** (per-person lifespan; per-shock severity). Design 21 §15 already flagged this for shock-MC; this roadmap recommends solving it once as **shared substrate** before either consumer ships.

**Recommendation**: extend `IntlRetirementMcConfig` to support path-walking parameter keys (`shocks[0].severity`, `people.primary.lifeExpectancy`) as a small contained refactor. Solves both shock-MC and mortality-MC at the same time.

**Owner**: **design 25a — MC-config nested param paths** ([`design/25a-mc-nested-param-paths.md`](25a-mc-nested-param-paths.md)).

---

## 5. Sequencing

Single-threaded build order. **Holdings (design 25) ships first**; everything else sequences behind it. Spending and mortality are *technically* independent of Holdings (they don't read or write `Holding`), but committing to a strict order avoids two parallel refactor streams competing for the same `Account` / state surface and keeps every follow-on design able to assume Holdings exists.

### Phase A — Substrate

1. **Design 25 — Holding-Level State** ([`design/25-holding-level-state.md`](25-holding-level-state.md)). The single largest refactor in the roadmap. Foundational for §3.4, §3.5, and the design-21 dividend-cut extension. Must land before anything else here.
2. **Design 25a — MC-config nested param paths** ([`design/25a-mc-nested-param-paths.md`](25a-mc-nested-param-paths.md), §4.4). Small, contained. Shared substrate for both shock-MC (design 21 Phase 2) and mortality-MC (design 27). Can land in parallel with design 25 since they touch different files.

### Phase B — User-facing features (parallel within the phase)

3. **Design 26 — Dynamic Spending Strategies.**
4. **Design 27 — Mortality & Survivor Mechanics.**

These don't read Holdings directly, but they ship after Phase A so the substrate is stable and every state change in the simulation already accounts for the new `Account.holdings` shape. Within Phase B, 26 and 27 can interleave.

### Phase C — Holdings consumers

5. **Design 28 — Time-Varying Appreciation & Bond Duration.** Requires Holdings.
6. **Dividend-yield cuts under regimes** *(tracked Phase C deliverable, separate from design 28)* — small extension to design 21: add `dividendAdjustment: { [rateKey]: number }` to `EconomicRegime`, add optional `dividendYield` to `Holding`, migrate `DividendScheduledHandler` to consume per-holding yield × regime adjustment. **Decision (2026-06-04):** ship as a standalone one-PR follow-up against design 21, *not* folded into design 28 — the change is 21-shaped (adjustment field on regime) and would otherwise inflate 28's scope. Can land any time after design 25 (Holdings) is stable; technically unblocked today. Track to completion as its own line item even though there's no dedicated `21a` doc — see design 28 §7 for the implementation note and design 28 §13 Q2 for the resolution.

### Phase D — Behavior

7. **Design 29 — Behavioral Layer.** Requires Holdings + Regimes.

```
Phase A:  25 Holdings ──┬── 25a MC paths
                        │
Phase B:                ├── 26 Spending
                        ├── 27 Mortality
                        │
Phase C:                ├── 28 Appreciation/Duration
                        ├── (dividend cuts: small follow-up to 21)
                        │
Phase D:                └── 29 Behavioral  (also reads Regimes/21)
```

---

## 6. Interaction with Existing Designs

| Existing design | Interaction |
|---|---|
| **21 — Regimes** | This roadmap consumes the regime framework but does not modify it, except for the small dividend-cut extension (Phase C). `EconomicRegime.dividendAdjustment` is added when design 28 (or a small follow-up) lands. The behavioral layer (§3.5) reads `state.activeRegimes` to decide when to panic-sell or suspend contributions. |
| **23 — FX** | No interaction. FX sits underneath the rate layer; financial-modeling features above don't touch it. |
| **20 — Decouple Residency from Citizenship** | Mortality (§3.3) interacts with residency: when a spouse dies, the surviving spouse's residency is unchanged; the household's primary-residence determination falls back to the survivor. The `state.people` mutation pattern from design 20 is reused. |
| **15 — Config as Source of Truth** | All new state fields (Holdings, spending-strategy state, mortality timestamps) follow the config/state boundary from design 15 — config seeds, state mutates. |
| **17 — Scenario as Graph Node** | Branching scenarios (design 17's substrate) work naturally with the additions here: a branch off a pre-shock save can explore different spending strategies / mortality timings without disrupting the parent. |

---

## 7. Explicit Out-of-Scope for This Roadmap

Things named here so future authors know they're tracked but not in this roadmap's sequence:

- **Yield curves** — per-maturity rate structures. Depends on bond duration shipping first (design 28).
- **Foreign-currency-denominated holdings inside a single account** — today an account has one currency; mixed-currency holdings within an account are not modeled.
- **Joint retirement accounts** — single-owner today; spouse twins exist. Full joint ownership is a separate effort tied to estate planning.
- **Insurance products** — life, annuity, long-term-care policies. Not modeled.
- **Estate / inheritance mechanics** — what happens to the *deceased's* accounts after `PERSON_DIED`. Design 27 will need a minimum viable answer ("transfer to surviving spouse" or "terminate scenario") but the full estate-rule machinery (RMDs for inherited IRAs, step-up basis, beneficiary rules) is a future design.
- **Tax-loss harvesting strategies** — unlocked by Holdings cost-basis-as-state but its own design (mentioned as future-future in §3.5).
- **Healthcare regime modeling** — modeling Medicare/Medicaid/Australian PBS coverage as state-aware rules. The healthcare-shock-events piece in §3.2 is one-off expense events, not a coverage model.
- **Behavioral parameter calibration** — the behavioral layer ships with configurable knobs but no claim of empirically-calibrated defaults. Calibration is its own (research, not engineering) project.

---

## 8. Summary

The framework today composes rates well; this roadmap takes it from there to portfolio structure, dynamic spending, mortality awareness, richer asset evolution, and behavioral reaction. The eight open concepts collapse to five themes; five themes become five follow-on designs (25 through 29).

The single most consequential commitment is **Holdings as the canonical sub-balance** (design 25). It is the foundational refactor that unlocks asset allocation, cost basis, dividend cuts, bond duration, behavioral selling, and tax-loss harvesting. The other four themes (spending, mortality, appreciation, behavior) each ship one design and sequence behind Holdings (§5) — two of them (spending and mortality) don't read Holdings directly, but a single-threaded build order avoids competing refactors on the same surface.

The roadmap also commits to two shared-substrate refinements: **lifecycle-event vocabulary** (`PERSON_DIED`, `HEALTHCARE_EXPENSE`, etc.) and **MC-config nested param paths** (so per-person and per-shock parameters can be swept). Both are small; both are reused across multiple follow-on designs.

When all five follow-on designs ship, the framework moves from "balances grow at composable rates" to "structured portfolios that respond to defined spending strategies, mortality timelines, and behavioral rules under composable economic regimes." That's a defensible retirement-planning tool — which is what the framework is for.
