# 75 — House costs and the property return path: appreciation that co-moves with markets, plus the running cost of owning

**Status**: **PHASES 1–4 (code) IMPLEMENTED** (2026-07-21). Phase 4 A/B/C — MC scalers,
seed-threading and house-path diagnostics — are built and green. Phase 4 **D** (the
company-equity decision re-run / §6.6) is **DEFERRED** and tracked in
`scenarios/company-equity-decision.md` (run instructions in its appendix); the runner
`scenarios/mc-arm-house.mjs` + reporter `scenarios/mc-report-house.mjs` are ready to drive it.

**Phase 4 surface (§6.4 A/B/C — MC integration & house-path diagnostics)**: the per-property
return/repair inputs live in `cfg.realProperties` (not `cfg.parameters`), so they can't be swept
as MC variables directly (dotted record paramKeys are dropped on the Opt/MC path — memory
`optimizer-param-key-dot-collision`). Three **global scalar params** in ECONOMIC_REGIMES are the
MC seam, all default `1.0` ⇒ inert, all `mc:true` opt-in: `propertyReturnIdioScale`
(multiplies every property sleeve's idiosyncratic vol in `PropertyReturnTickHandler` — the honest
housing-VOL axis, since `equityReturnVol` only reaches the house through β≈0.03 and housing is
~99% idiosyncratic), `repairSeverityScale` (multiplies the repair median) and `repairFreqScale`
(multiplies the Bernoulli prob / Poisson λ) in `RealPropertyRepairTickHandler`. The frequency
scaler rescales the *compared* probability only — never adds/removes a uniform — so RNG-cursor
discipline (design 74 §4) is preserved and a base-disabled property still draws nothing. Wired
through both handler constructors + serializers + both toolsets; registered as opt-in MC
variables (`Return Paths` group) in `intl-retirement-mc-config.js`. **Seed threading (§6.4 A) was
already done** by design 74 Phase 2 (`buildSim({ seed })`), so each MC iteration already gets its
own house appreciation path + repair sequence. **House-path diagnostics (§6.4 C)**: new
`computeHouseValueUsd` (gross FX-converted property value); `extractYearlyTimeSeries` captures a
`houseValueUsd` series and `evaluate` captures `lifetimeRepairSpend` (`state.houseRepairSpendingTotal`);
`computePathShape` adds `houseCagr` / `houseMaxDrawdown` measured over the **pre-sale window only**
(truncated at the first zero, so the sale-to-zero is not read as a market drawdown); `summary.pathShape`
adds `medianHouseCagr` / `medianHouseMaxDrawdown` + repair-spend `median`/`p10`/`p90`. New
`percentile()` helper. Tests: `tests/unit/house-cost-mc.test.mjs` (17). **3930 unit / 906 viz
green; golden byte-identical.** §6.6 decision re-run (§6.4 D) driven by `scenarios/mc-arm-house.mjs`.

Direct successor to design 74 §7 ("Relationship to the house-price design"), which named this
design the natural extension once the equity return path landed. Depends on
`wip/stochastic-return-modeling` (design 74 Phases 1–4, all complete). All §8 open questions
resolved (owner).

**Phase 3 surface (Part B Component 2 — stochastic repairs)**: new `RealPropertyRepairTickHandler`
(`src/finance/handlers/`) — a seeded, snapshot-safe annual `sim.rng` consumer that draws a compound
repair process per property (BERNOULLI default / POISSON / CONTINUOUS × lognormal severity),
sums the FX-converted cost, and debits it residence-aware via the same REPLENISH_SAVINGS →
EXPENSE_DEBIT path. New `HouseRepairApplyReducer` (`src/finance/reducers/`) accumulates
`houseRepairSpending*` and, when `capitalizeRepairs > 0`, lifts a per-property
`capitalizedImprovements` accumulator (§8 Q6); the US + AU house-sale handlers add that accumulator
to the sale cost basis (0 by default ⇒ inert), so capitalized repairs cut the sale-year CGT. New
`HOUSE_REPAIR_APPLY` action + `house_repair_expenses` metric; new per-property fields `repairModel`
/ `repairProb` / `repairLambda` / `repairMedian` / `repairSigma` / `repairValuePct` /
`capitalizeRepairs` on the `RealProperty` class, both toolsets, and the serializer, plus the
`capitalizedImprovements` state accumulator. Wired in `us-retirement-toolset`; the annual
`HOUSE_REPAIR` tick is scheduled only when a property has a repair model, `order(2)` so it draws
**after** the equity/property-return ticks and never perturbs their sequences. Added `.order()` to
`EventSeriesBuilder`. **RNG-cursor discipline** (design 74 §4): properties iterated in stable
sorted order; NONE / zero-frequency / zero-median draw nothing; sold (`value 0`) skipped. Tests:
`tests/unit/house-repair.test.mjs` (18, incl. calibration `mean ≈ prob·median·e^{σ²/2}` and the
capitalize→CGT chain). **3913 unit / 906 viz green; golden byte-identical.**

**Phase 2 surface (Part B Component 1 — regular running cost)**: new `HouseRunningCostHandler`
(`src/finance/handlers/`), a residence-aware monthly essential debit that sums each property's
inflated base cost (`annualRunningCost × inflationAccumulator[cc] × (1+runningCostGrowth)^yrs +
runningCostValuePct × value`), converts from the property's currency into the residence account
currency, and joins the existing REPLENISH_SAVINGS → EXPENSE_DEBIT → cross-border escalation path
(no new action or reducer). New per-property fields `annualRunningCost` / `runningCostValuePct` /
`runningCostGrowth` on the `RealProperty` class, both real-property toolsets' `_propertyToStatePlain`,
and the serializer (both directions). **Placement decision**: wired in `us-retirement-toolset`
alongside `MonthlyExpensesHandler` (the established home for `EXPENSE_DEBIT` household handlers),
iterating *all* properties (both countries) — not per-country in the real-property toolsets, which
would duplicate the residence/role/escalation plumbing. A dedicated `HOUSE_RUNNING_COST` monthly
event is scheduled only when some property carries a positive cost, so it needs no cross-toolset
coordination and default scenarios stay byte-identical. No master flag (deterministic, like a
spending band). Stops at sale (guards on `value > 0`). **Limitation**: assumes `US_RETIREMENT` is
present (true for every cross-border target scenario); an AU-only scenario would not get the
handler until the same `context.schedulesById` coordination MONTHLY_EXPENSES uses is added.
Tests: `tests/unit/house-running-cost.test.mjs` (11). **3895 unit / 906 viz green; golden
byte-identical.**

**Phase 1 surface (Part A — property return path)**: `PropertyReturnTickHandler` +
`PropertyReturnStepReducer` (`src/finance/economic-regimes/`), the `PROPERTY_RETURN_TICK` series
and `propertyReturn*` params in ECONOMIC_REGIMES, `PROPERTY_SLEEVES` / `DEFAULT_RE_BETA` /
`DEFAULT_RE_IDIO` in `rate-keys.js`, `reKey` on the real-property appreciation projections, and the
`AssetAppreciationHandler` fold (§4.2 A2). Registered in `index.js` + `scenario-serializer.js` +
the reducer-coverage manifest. Tests: `tests/unit/property-return-paths.test.mjs` (21). **3884
unit / 906 viz green (JOURNAL_STRICT on); golden byte-identical.** Two implementation refinements
vs. the prose below: (a) the deviation is stored in a **dedicated `state.propertyReturnDev` /
`propertyReturnDriftComp` map** (parallel to the equity trio), not overloaded onto
`equityReturnDev` as §4.2 A2 first sketched — cleaner and keeps `EquityReturnReducer` from ever
touching it; (b) a **separate** `PropertyReturnTickHandler` (not an extension of the equity
handler) scheduled with `order: 1` so it fires after the equity tick and reuses
`state.equityReturnMarketDev` — this keeps the two master flags independent and handles the
standalone (equity-off) case in one code path. Limitation: the stochastic path only rides
properties that already appreciate (the `appreciableProps` filter — `appreciationRate ≠ 0` or a
schedule); a zero-appreciation property gets no tick. Acceptable for the target scenarios.

**Decisions locked** (§8): inflation path deferred to a future **design 76** (Q1); the property
path may run standalone, drawing its own `zMarket` when the equity flag is off (Q2); repairs use
a **BERNOULLI × LOGNORMAL** default with Poisson/Continuous available (Q3); repair frequency is
**independent** of the market (Q4); owner-occupied running cost stays **separate** from rental
`rentalExpenseRatio` but shares the debit mechanics (Q5); large repairs can **capitalize** into
`costBasis` via a `capitalizeRepairs` fraction (Q6). ⚠️ **Key research correction (Q7, §4.1):**
the house↔equity **contemporaneous** correlation is ≈ 0.04 — near zero — so the joint crash that
"breaks a plan" is a *tail/systemic* event, not an average one. **Owner decision: lean on
`shocks[]` for the joint crash** (a combined equity + real-estate shock), matching how the owner
reasons about this risk. The original β = 0.4 default was far too high; new per-country defaults
are **near-zero betas at the historical average + ~99% idiosyncratic vol** (US β 0.03 / idio 0.09;
AU β 0.05 / idio 0.10). This refines — does not overturn — design 74 §7's premise: even at β = 0
the idiosyncratic term gives the house *sale price* real variance, the sequence risk on the
binding asset.

**One-line problem statement**: today a house has exactly two economic behaviours — it
appreciates at a single constant `appreciationRate` per year, and it costs whatever its
mortgage payment is. Neither is true. A real house (a) rises and falls *with* the market that
also drives the portfolio (the co-movement design 74 §1.3 called the binding risk), and (b)
costs money to *own* every year — some of it steady and inflating (rates, insurance, power,
water), some of it lumpy and random (a roof, a hot-water system, a failed AC compressor). This
design adds both: a **stochastic property return path** correlated to the equity market factor,
and a **two-component house running-cost model** (a deterministic inflating base + a stochastic
repair process).

---

## 1. Motivation

### 1.1 The house is the binding risk and it is still modelled as a metronome

The tranche B/C decision analysis (`scenarios/company-equity-decision.md`) found the **US house
sale is the binding risk — worth ~3× tranche B** (design 74 §1.3, §6.5). Yet the house today:

- **Appreciates at a constant rate.** `AssetAppreciationHandler` grows `state[key].value` by
  `resolveScheduledRate(appreciationSchedule, date, appreciationRate)` every year — a smooth
  ramp with no variance and, critically, **no correlation to anything**. The whole reason the
  house sale is dangerous is that a forced or planned sale can land in a soft housing market
  that co-occurs with a weak equity market — and the model cannot express that conjunction at
  all. Design 74 built the shared market factor precisely so this design could correlate
  against it.

- **Costs nothing to hold.** The only recurring house outflow the engine models is the
  **mortgage** (`US_LOAN_PAYMENT` / `AU_LOAN_PAYMENT`, design 54). Once the mortgage is paid
  off, the house is *free* in the model. In reality a paid-off house still costs 1–3% of its
  value per year to run, and every few years it demands a five-figure repair. For a decades-long
  retirement projection this is not a rounding error — it is a permanent, inflating, partly
  random drag on liquidity that the plan never sees.

### 1.2 Both omissions bias the answer in the same optimistic direction

Design 74 established that the deterministic model reports a **floor** on failure rates. This
design closes two more optimistic gaps that both live on the house:

1. **Zero appreciation variance ⇒ no downside-timing risk on the single largest asset.** The
   house is often the biggest line on the balance sheet; giving it zero volatility is the same
   diversification lie design 74 §4 rejected for equities, applied to the one asset whose *sale*
   is the plan's pivot.
2. **Zero holding cost ⇒ overstated liquidity for the entire post-payoff period.** A retiree
   who "owns the house free and clear" still writes cheques for rates, insurance, utilities and
   repairs every year, and those cheques *grow with inflation*. Omitting them flatters every
   net-liquidity and guardrail calculation in the back half of the plan.

### 1.3 The two-piece cost structure is the honest one

The owner's framing is exactly right and worth preserving as the model's shape:

> "The running costs [have] 2 pieces, the regular costs that increase with inflation and a
> stochastic modelable one that incurs random costs."

- **Regular** — council rates, insurance, utilities, body corporate/strata, routine servicing.
  Predictable, recurring, and rises with **inflation** (and partly with the house's value). This
  is deterministic given the inflation path.
- **Stochastic** — a leaking roof, a dead water heater, a failed AC compressor, storm damage.
  **Lumpy and occasional**: most years cost near zero, then one year costs $18k. A smooth
  "average maintenance %" understates the *liquidity* danger because the danger is the timing of
  the lump, not its long-run average — the same sequence-risk logic design 74 applied to
  returns, now applied to outflows.

---

## 2. What exists today

As with design 74, most of the machinery already exists; this design is largely new consumers
of established seams.

| Need | Existing primitive | Source |
|---|---|---|
| A shared, seeded market factor to correlate against | `state.equityReturnMarketDev` (walked by `EquityReturnTickHandler`, stored by `EquityReturnStepReducer`) | 74 |
| Per-sleeve loading on that factor via beta | `DEFAULT_EQUITY_BETA` / `equityReturnBeta`; the `dev = β·marketDev + idio` fold | 74 §4 |
| Volatility-drag compensation (σ²/2) | `equityReturnDriftComp` GEOMETRIC \| NONE | 74 §5.3 |
| Seeded, snapshot-safe in-loop RNG | `sim.rng` (cursor captured/restored in every snapshot); `gaussianFrom(rng)` | 47 |
| Annual property revaluation | `AssetAppreciationHandler` + `AssetAppreciateReducer` (reads `appreciationRate` / `appreciationSchedule`) | 28 |
| A per-country price-level index for inflating costs | `state.inflationAccumulator[cc]` (base-year amount × index = nominal) | — |
| A recurring cost that debits the residence-appropriate savings pool | `MonthlyExpensesHandler` → `REPLENISH_SAVINGS` + `EXPENSE_DEBIT` (+ FX via `convertExpenseToAccount`) | — |
| A one-off essential outflow with the same replenish/debit/track shape | `HealthcareEventHandler` → `HEALTHCARE_EXPENSE` | — |
| Per-property state to hang cost fields on | `_propertyToStatePlain` in `us-/au-real-property-toolset.js` | 54 |

**The gaps are narrow and specific:**

1. `AssetAppreciationHandler` reads `appreciationRate` as a constant. It has **no stochastic
   term** and does not look at the market factor. (Equities got their path in design 74;
   property never did — the mirror-image of design 74 §2's "bonds got one in 67; equities never
   did".)
2. There is **no house running-cost stream at all** beyond the mortgage. Rates, insurance,
   utilities and repairs simply do not exist as outflows.

### 2.1 Why not reuse `shocks[]` or a `monthlyExpenses` band for the costs

- A **shock** is one discrete, authored, dated event with a known size. Repairs are a
  *distribution* of lumps across the horizon, not a single scheduled hit — the same argument
  design 74 §2.1 made for return paths over `shocks[]`.
- A **`monthlyExpenses` band** could carry the *regular* piece, but (a) it does not attach to a
  specific property, so it can't scale with the house's value, follow the house's currency, or
  disappear when the house is sold; and (b) it is deterministic, so it can't carry the
  stochastic repair piece at all. The regular piece is *close* to an expense band and the design
  will reuse the band's inflation/debit mechanics — but keyed to the property, not the household.

---

## 3. Goals / non-goals

**Goals**

1. A house's annual appreciation is a **path**, not a constant: a per-year deviation with its
   own beta on the **same** `zMarket` that drives equities — so a soft housing market co-occurs
   with a weak equity market by construction (design 74 §7).
2. A **two-component running-cost model** per property: a deterministic base that inflates (and
   optionally scales with value), plus a stochastic repair process (frequency × severity).
3. **Default-off and bit-for-bit inert** when off — the design 67/74 discipline. A scenario
   with no property-return flag and zero running-cost inputs is byte-identical to today.
4. **Reproducible**: identical seed ⇒ identical appreciation path *and* identical repair
   sequence, including MPC/optimizer forward rollouts (design 74 §8 Q6).
5. **Correlated correctly**: the property systematic shock is the market factor, not an
   independent draw — reusing design 74's single-draw discipline (§4) so we do not diversify
   away the co-movement that is the entire point.

**Non-goals**

- A calibrated regional housing-market model (Case-Shiller regimes, local supply). One beta on
  the market factor plus optional idiosyncratic property vol is the rank-1 approximation, exactly
  as design 74 §4 chose Option B over a full covariance matrix.
- Correlating repair frequency with the market (a recession does not make your roof leak). Repair
  events are their own independent process. (Deferred; see §8 Q4.)
- A **stochastic inflation path** (design 74 §8 Q4). The regular cost piece rides the existing
  deterministic `inflationAccumulator`; making inflation itself stochastic is a separate lever
  discussed in §8 Q1 and left out of the core here.
- Rental properties' operating expenses — those already flow through `rentalExpenseRatio`
  (design 48). This design targets the **owner-occupied holding cost** the rental ratio does not
  model. (§8 Q5 revisits unifying them.)

---

## 4. Part A — the property return path

### 4.1 Representation: property is another sleeve on the market factor

Design 74 §4 chose **Option B** — one market factor, per-sleeve beta, optional idiosyncratic
term — precisely so that new asset classes could load on the same factor without re-deriving a
stochastic layer. Real estate is the first such extension, and §7 of that design pre-committed to
it:

> "give `RealProperty.appreciationRate` the same treatment with its own beta on the same
> `zMarket` — a small increment on top of Phase 1, versus a from-scratch stochastic layer if the
> house is done first."

Concretely, add two real-estate keys to the sleeve vocabulary and let them ride the **already-drawn**
market deviation:

```js
// Reuse the market factor EquityReturnTickHandler already walked this tick — do NOT draw a
// second zMarket, or property would decorrelate from equities (the whole point of §1.1).
const marketDev = state.equityReturnMarketDev;            // shared systematic shock
dev[REAL_ESTATE_US] = betaRe_US * marketDev + (idioRe_US ?? 0)*√dt*gaussianFrom(sim.rng);
dev[REAL_ESTATE_AU] = betaRe_AU * marketDev + (idioRe_AU ?? 0)*√dt*gaussianFrom(sim.rng);
```

Housing is **less** volatile than equities *and* — the empirical surprise below — only weakly
correlated with them, so the systematic betas load **far** below 1 and most of a house's variance
is idiosyncratic.

> **⚠️ Research finding (2026-07-21, §8 Q7): the co-movement is a TAIL event, not an average
> one.** Design 74 §1.3/§7 motivated this work with "a bad equity market and a soft housing
> market co-occur." That is true *in systemic credit crises* (2008: both fell, housing-led) but
> **false on average**: the contemporaneous correlation between US national home-price
> appreciation and equity returns is ≈ **0.04** — essentially zero — and in **4 of the 5** major
> US market crashes since 1987 home prices rose or held flat (dot-com −49% S&P / +7% homes; COVID
> −34% / homes up). Australia shows a *lead–lag / capital-switching* relationship rather than a
> clean contemporaneous one, though AU housing is more credit- and macro-sensitive (national
> −6.4% in the GFC year). **Implication:** a single linear Gaussian beta captures *average*
> co-movement, of which there is almost none — so a high beta (my original 0.4) would
> **overstate** the everyday correlation. **Owner decision (§8 Q7): the joint crash is authored
> as a `shocks[]` stress, not a standing beta** — it is a discrete fat-tail/systemic event (a
> combined equity + real-estate shock at one date, or the MC shock severity/timing variables),
> which is also how the owner reasons about this risk. The linear property beta is therefore set
> to the **near-zero historical average** — just enough not to pretend perfect independence, and
> to be the seam a future regime/fat-tail model plugs into.

Derivation of the defaults. For a house with total appreciation σ_H and correlation ρ with the
market factor, the systematic loading is `β·σ_market = ρ·σ_H` (with `σ_market = equityReturnVol =
0.18`) and the idiosyncratic sd is `σ_idio = σ_H·√(1−ρ²)`. Grounding σ_H in a **single property**
(more volatile than a smoothed national index — Case-Shiller national ≈ 6–7%/yr; a single home
disperses wider) and ρ in the near-zero-but-tail-positive evidence above:

| Key | σ_H (single home) | ρ (to market) | ⇒ default β | ⇒ default idio σ |
|---|---|---|---|---|
| `REAL_ESTATE_US` | ≈ 9% | ≈ 0.06 | **0.03** | **0.09** |
| `REAL_ESTATE_AU` | ≈ 10% | ≈ 0.09 | **0.05** | **0.10** |

**Decision (owner, §8 Q7): lean on `shocks[]` for the joint crash**, so ρ is set at the near-zero
historical average and the betas are correspondingly near zero. AU loads a touch higher: capital-
city housing is more volatile and more credit/macro-sensitive (the GFC both-fell episode), so a
marginally larger share of its variance is systematic — but both betas are deliberately **near
zero**, leaving ~99% of each house's modelled variance idiosyncratic and the equity–housing
co-crash carried entirely by `shocks[]` (a combined equity + real-estate shock at one date, or the
MC shock severity/timing variables). Both betas and idio vols are overridable per rate key exactly
like `equityReturnBeta` / `equityReturnIdioVol` (`propertyReturnBeta` / `propertyReturnIdioVol`) —
a user who wants a standing correlation can raise the beta, but the default does not assume one.

> **σ note.** US default: total σ = √((0.03·0.18)² + 0.09²) ≈ **9.0%**; AU: √((0.05·0.18)² +
> 0.10²) ≈ **10.0%** — both the right order of magnitude for a single house, ~99% idiosyncratic.
> The idiosyncratic term alone gives the house *sale price* real variance at the sale date, which
> is the sequence/timing risk on the binding asset — so the
> design's core value survives the weak correlation.

**Sources**: [Case-Shiller national index (FRED CSUSHPINSA)](https://fred.stlouisfed.org/series/CSUSHPINSA);
[housing↔equity correlation ≈ 0.04, crash behaviour](https://www.ownluxuryhomes.com/markets/national/stock-market-real-estate/do-home-prices-fall-stock-market-crash);
[AU house prices −6.4% in the GFC year](https://www.domain.com.au/news/what-house-prices-were-doing-during-the-global-financial-crisis-and-how-its-different-now-938567/);
[AU housing↔equity lead–lag / capital-switching](https://emerald.com/insight/content/doi/10.1108/IJHMA-05-2016-0037/full/html).

### 4.2 The wiring decision: two candidate seams

Property appreciation does **not** flow through `effectiveGrowthRates` — it flows through
`AssetAppreciationHandler`, which reads `appreciationRate` directly. So `EquityReturnReducer`'s
fold (which rewrites `effectiveGrowthRates`) does not reach it. Two ways to close that:

| Option | Mechanism | Verdict |
|---|---|---|
| **A1. Route property through `effectiveGrowthRates`** | Give `REAL_ESTATE_*` real entries in `effectiveGrowthRates`, have `AssetAppreciationHandler` read the effective rate, and let the existing `EquityReturnReducer` fold reach it for free. | Cleanest *long-term* unification (one rate pipeline), but a real refactor of the appreciation handler and its schedule/`resolveScheduledRate` path, and it disturbs the deterministic golden for every property scenario. Bigger blast radius. |
| **A2. Deviation map the handler reads** | `EquityReturnTickHandler` also emits `REAL_ESTATE_*` entries into `state.equityReturnDev` (+ `driftComp`); `AssetAppreciationHandler` adds `equityReturnDev[REAL_ESTATE_<cc>] + driftComp[...]` to its resolved per-property rate before computing the delta. | **Recommended.** Smallest change; reuses the *single market draw* for automatic correlation; touches one handler's rate resolution; inert when the map is absent/zero. Mirrors how design 74 kept the stochastic term additive on top of the anchor. |

**Decision: A2**, with A1 noted as the eventual unification if a second consumer ever needs
property in `effectiveGrowthRates`. Under A2 the property delta becomes:

```js
const baseRate = resolveScheduledRate(asset.appreciationSchedule, date, asset.appreciationRate ?? 0);
const dev      = (state.equityReturnDev?.[reKey] ?? 0) + (state.equityReturnDriftComp?.[reKey] ?? 0);
const delta    = +(value * (baseRate + dev)).toFixed(2);   // dev is 0 when the flag is off ⇒ inert
```

`reKey` is `REAL_ESTATE_US` / `REAL_ESTATE_AU` selected by `asset.country`.

### 4.3 Drift compensation applies here too

A mean-0 shock on a multiplicatively-applied appreciation rate lowers the realized geometric
appreciation by ≈ σ²/2, identically to equities (design 74 §1.2/§5.3). The property sleeves
therefore participate in the **same** `equityReturnDriftComp` param: under **GEOMETRIC** (the
default) each real-estate sleeve gets `+((β·σ)² + σ_idio²)/2` added back so a "house appreciates
3.5%" input reads as a CAGR; under **NONE** the drag is left in. No new param — property inherits
the equity decision, which is the honest default because "3.5%" is a CAGR claim just as "10%" is.

### 4.4 Flag & inertness

A dedicated master flag keeps Part A independent of the equity flag but honest about the
dependency:

- `propertyReturnStochastic` (default `false`). When off, no `REAL_ESTATE_*` entries are emitted
  and `AssetAppreciationHandler` sees `dev = 0` ⇒ **byte-identical golden**.
- When **on but `equityReturnStochastic` is off**, there is no `equityReturnMarketDev` to read.
  Decision (§8 Q2): in that case the property handler must draw its **own** `zMarket` for the
  systematic term — otherwise a stochastic house silently has zero systematic variance. This
  makes Part A usable standalone, at the cost that the correlation benefit only materializes when
  both flags are on (which the UI should nudge). The RNG-cursor rules of design 74 §4 ⚠️ apply:
  draw order must be stable and the idio draw skipped entirely when its vol is 0.

---

## 5. Part B — the house running-cost model

Each property gains a running-cost sub-model with two independent components. Both debit the
residence-appropriate savings pool using the **exact** replenish → debit → track shape of
`MonthlyExpensesHandler` / `HealthcareEventHandler`, and both convert the property-currency cost
into the debit account's currency via `convertExpenseToAccount` (so an AUD house's costs leave
the AUD magnitude after the move).

### 5.1 Component 1 — regular running cost (deterministic, inflating)

New per-property fields (default 0 ⇒ inert):

| Field | Meaning |
|---|---|
| `annualRunningCost` | Base-year fixed holding cost: rates + insurance + utilities + servicing, in the property's currency. |
| `runningCostValuePct` | *Optional* value-proportional add-on (e.g. `0.005` = 0.5%/yr of current value) for costs that scale with the house, not with CPI. Default 0. |
| `runningCostGrowth` | *Optional* real growth on top of inflation (default 0 ⇒ tracks inflation exactly). |

The **nominal** annual regular cost in year *t* is:

```
regular_t = annualRunningCost × inflationAccumulator[cc] × (1 + runningCostGrowth)^yearsElapsed
          + runningCostValuePct × currentValue
```

The first term is the owner's "increases with inflation" piece, computed exactly like an
`EXPLICIT_BANDS` band (`monthlyAmount × inflationAccumulator[cc]`, design's `explicit-bands`
reducer). The second term rides the (already stochastic, once Part A is on) property value, so a
pricier house costs proportionally more to run — a subtle, correct coupling.

**Cadence.** Billed monthly (÷12) alongside other expenses to keep liquidity smooth and match
`MonthlyExpensesHandler`; annual billing is an option but complicates the replenish logic for no
decision-level gain.

**No RNG.** This component is fully deterministic given the inflation path, so it is *always*
active whenever `annualRunningCost > 0` — it needs no master flag, exactly like a `monthlyExpenses`
band. Turning it on for an existing scenario **does** move that scenario's result (liquidity
falls), which is correct and must be called out in the field help — it is a modelling *addition*,
not a regression, but unlike Part A it is not gated behind a "stochastic" flag because there is
nothing stochastic about it.

### 5.2 Component 2 — stochastic repairs (lumpy, seeded)

This is the "leaking roof / dead water heater" piece: most years ≈ $0, occasional large hits.
Modelled as a **compound process** — a frequency draw for *whether/how many* repairs occur, and a
severity draw for *how big* each is. A `RealPropertyRepairTickHandler` fires annually and is the
**4th in-loop `sim.rng` consumer** (after FX/47, yield curve/67, equity return/74).

**Model choice** (§8 Q3 for the owner):

| Model | Draw | Fits |
|---|---|---|
| **BERNOULLI × LOGNORMAL** *(recommended default)* | Each year, with prob `repairProb` a "big repair" occurs; its size ~ Lognormal(median `repairMedian`, σ `repairSigma`). | The owner's mental model exactly: rare, discrete, heavy-tailed lumps. |
| **POISSON × LOGNORMAL** | Number of repairs ~ Poisson(λ); each ~ Lognormal. | More faithful when several independent systems can each fail in one year. |
| **CONTINUOUS %** | `repairPct × value × (1 + Lognormal noise)` every year. | Simplest, but *smooths away the lump* — understates the liquidity-timing danger that is the whole point (§1.3). Offered but not recommended as the sole model. |

Per-property fields (default 0/absent ⇒ no draw, inert):

| Field | Default | Meaning |
|---|---|---|
| `repairModel` | `NONE` | `NONE` \| `BERNOULLI` \| `POISSON` \| `CONTINUOUS`. `NONE` ⇒ no RNG drawn. |
| `repairProb` / `repairLambda` | 0 | Annual event probability (Bernoulli) or rate (Poisson). |
| `repairMedian` | 0 | Median severity per event, property currency. |
| `repairSigma` | 0.6 | Lognormal shape (heaviness of the tail). |
| `repairValuePct` | 0 | *Alternative* severity anchor: median = `repairValuePct × value` (e.g. 0.02 ⇒ a "typical" big repair ≈ 2% of the house). Lets severity scale with the house instead of a fixed dollar figure. |
| `capitalizeRepairs` | 0 | Fraction of each repair treated as a capital **improvement** rather than maintenance — added to the property's `costBasis` (design decision §8 Q6 = yes). 0 ⇒ pure maintenance (no basis bump); e.g. 0.3 ⇒ 30% of a roof replacement lifts basis and reduces the eventual CGT. |

**RNG-cursor discipline (design 74 §4 ⚠️, load-bearing).** Repairs must be drawn in a stable,
sorted property order, and a property with `repairModel: NONE` (or zero frequency) must draw **no**
uniforms — not draw-and-discard — or enabling repairs on one house would shift every subsequent
house's sequence and break reproducibility/inertness. This is the same footgun design 74 called
out for idiosyncratic sleeve draws; the fix is the same.

**Emission.** Like `HealthcareEventHandler`: prepend `REPLENISH_SAVINGS` if the debit would break
the savings floor, emit `EXPENSE_DEBIT` for the (FX-converted) repair, and emit a
`HOUSE_REPAIR_APPLY` tracking action so the cost is visible in the journal and a
`house_repair_expenses` metric series (essential for seeing the lumps in MC output).

**Capitalization (§8 Q6 = yes).** Repairs default to pure maintenance (`capitalizeRepairs = 0`,
no basis change), which is the common repairs-vs-improvements tax reality. When
`capitalizeRepairs > 0`, `HouseRepairApplyReducer` also lifts the property's `costBasis` by
`capitalizeRepairs × repairAmount` (in the property's currency, before FX), so a fraction of each
large repair is treated as a capital improvement and reduces the eventual capital gain at sale.
This composes with the cross-border cost-base machinery (design 62 `costBaseByCountry`): the bump
applies to the *current-jurisdiction* basis the sale reducer reads. The cash debit is unchanged —
capitalization is a basis/CGT effect only, not a cash-flow one.

### 5.3 Ordering, priority, and the sale interaction

- Both components stop when the property is **sold** (the state entry's `plannedSaleYear` has
  passed / the sale reducer has run) — a paid-for-then-sold house costs nothing after sale. The
  handlers guard on the property still existing and not being flagged sold.
- The repair tick and the regular-cost debit are essential outflows and participate in the same
  `REPLENISH_SAVINGS` → cross-border escalation path as other expenses (memory:
  `tax-path-crossborder-escalation`, `replenish-savings-bypasses-actions`), so a repair that
  can't be met from the local pool escalates to an `INTL_TRANSFER` before an `OUT_OF_FUNDS`,
  rather than spuriously failing the scenario.

---

## 6. Phases

### 6.1 Phase 1 — property return path (Part A), flag-gated, golden-neutral

- Add `REAL_ESTATE_US` / `REAL_ESTATE_AU` to a **property sleeve** list + `DEFAULT_RE_BETA` /
  `DEFAULT_RE_IDIO` in `rate-keys.js` (siblings to `EQUITY_SLEEVES` / `DEFAULT_EQUITY_BETA`).
- Extend `EquityReturnTickHandler` (or a thin `PropertyReturnTickHandler` sharing the market
  draw) to emit `REAL_ESTATE_*` entries into `equityReturnDev` + `equityReturnDriftComp`.
- Teach `AssetAppreciationHandler` to add the property deviation to its resolved rate (§4.2 A2).
- Params: `propertyReturnStochastic`, `propertyReturnBeta` `{}`, `propertyReturnIdioVol` `{}`.
- **Exit criteria** (design 74 §6 discipline): flag off ⇒ golden byte-identical; RNG cursor
  unadvanced; flag on ⇒ reproducible across identical runs and snapshot/restore (JOURNAL_STRICT
  green); with `equityReturnStochastic` also on, the house and equities load on the *same*
  `marketDev` (assert correlation, not independence — the §4 anti-diversification regression).

### 6.2 Phase 2 — regular running cost (Part B Component 1) ✅ IMPLEMENTED

- Per-property `annualRunningCost` / `runningCostValuePct` / `runningCostGrowth` on the
  `RealProperty` class, both real-property toolsets' `_propertyToStatePlain`, and the serializer.
- New `HouseRunningCostHandler` (monthly) reusing the `MonthlyExpensesHandler`
  replenish/debit/FX shape and `inflationAccumulator[cc]` for the CPI factor; wired in
  `us-retirement-toolset` over all properties (see status header for the placement rationale).
  Emits only existing actions (REPLENISH_SAVINGS / EXPENSE_DEBIT / RECORD_METRIC
  `house_running_cost` / RECORD_BALANCE) — no new action or reducer.
- **Exit criteria** ✅: `annualRunningCost = 0` ⇒ byte-identical (no event, no debit). A positive
  value debits the residence-appropriate pool, inflates correctly year over year, converts
  currency after the move, and stops at sale (`value > 0` guard). `tests/unit/house-running-cost.test.mjs`.

### 6.3 Phase 3 — stochastic repairs (Part B Component 2) ✅ IMPLEMENTED

- `RealPropertyRepairTickHandler` (annual `sim.rng` consumer) + `HouseRepairApplyReducer` +
  `HOUSE_REPAIR_APPLY` action + `house_repair_expenses` metric.
- Params/fields per §5.2 on the `RealProperty` class + both toolsets + serializer; **only
  scheduled when at least one property has `repairModel ≠ NONE`**, so default scenarios draw no
  randomness.
- `capitalizeRepairs` (§5.2, §8 Q6): repairs accrue a per-property `capitalizedImprovements`
  accumulator (lifted by `HouseRepairApplyReducer`), which the US + AU sale handlers add to the
  sale cost basis — inert (0) by default, so it does not disturb the frozen sale-basis or the
  design-62 residency-reset logic. (Refinement vs. the §5.2 sketch: a dedicated accumulator, not a
  direct `costBasis` write, because the sale basis is baked into the event at compile time.)
- **Exit criteria** ✅: `repairModel: NONE` everywhere ⇒ no tick scheduled, RNG cursor unadvanced,
  golden byte-identical; enabled ⇒ reproducible + snapshot-safe; a NONE property does not shift
  another's draw sequence; calibration (long-horizon mean ≈ `repairProb × median × e^{σ²/2}`);
  `capitalizeRepairs > 0` cuts the sale-year CGT (higher ending NW at a fixed seed).
  `tests/unit/house-repair.test.mjs`.

### 6.4 Phase 4 — MC integration & the decision re-run  ✅ A/B/C IMPLEMENTED; D DEFERRED

Parts A (seed threading — already done), B (MC scalers) and C (house-path diagnostics) are built
and green (`tests/unit/house-cost-mc.test.mjs`, 17 tests; **3930 unit / 906 viz**, golden
byte-identical). Part D (the decision re-run) is **deferred** — the tooling is ready
(`scenarios/mc-arm-house.mjs` runner + `scenarios/mc-report-house.mjs` reporter) and the run
instructions live in the appendix of `scenarios/company-equity-decision.md`, where §6.6 will be
written when the run happens. The original starting notes below are retained; **what shipped vs.
the sketch** is called out inline.

**A. Seed threading — already done.** Design 74 Phase 2 fixed `BaseScenario.buildSim({ seed })`
and the runner passes the iteration index (`intl-retirement-mc-runner.js:195`
`scenario.buildSim({ seed })`). Both the property-return tick (P1) and the repair tick (P3) draw
from `sim.rng`, so **each MC iteration already gets its own property path + repair sequence for
free** — no runner change needed to make them vary. Verify with a quick "flag on, all scalar MC
vars off ⇒ iterations differ" check (the design-74 §5.2 regression, applied here).

**B. Exposing the new knobs as MC variables — the wrinkle.** MC variables are `{ paramKey, … }`
where `paramKey` MUST be a key the runner writes to `cfg.parameters[paramKey]`
(`intl-retirement-mc-config.js:38`, `DEFAULT_MC_VARIABLE_CONFIGS`). The repair knobs
(`repairProb`, `repairMedian`, …) are **per-property record fields in `cfg.realProperties[i]`, NOT
`cfg.parameters`**, so they cannot be swept directly (and dotted paramKeys into records are dropped
on the Opt/MC path — memory `optimizer-param-key-dot-collision`). Two clean routes:
  - `equityReturnVol` (already `mc:true`, design 74) is the honest driver for *both* equity and
    housing systematic vol, since property loads on the same market factor. Sweeping it moves the
    house too — arguably all you need for the correlated-risk question.
  - For repair severity/frequency, add **global scaler params** to ECONOMIC_REGIMES (or a small
    house-cost param group) that the handlers multiply in — e.g. `repairSeverityScale` (default
    1.0, `mc:true`) read by `RealPropertyRepairTickHandler` as a multiplier on `median`, and
    optionally `repairFreqScale` on `repairProb`/`repairLambda`. These live in `cfg.parameters`, so
    they *are* MC-able. Thread them through the handler constructor from the toolset like the other
    params. (Same pattern for a `propertyReturnVol`/`propertyReturnIdioScale` scaler if you want
    housing vol swept independently of `equityReturnVol`.)

> **✅ SHIPPED (B).** All three scalers were added to ECONOMIC_REGIMES: `repairSeverityScale`,
> `repairFreqScale` and — the important one — `propertyReturnIdioScale`. `equityReturnVol` alone
> is **not** enough for the housing question: at the calibrated β≈0.03 the market factor barely
> moves the house (~99% of a home's variance is idiosyncratic), so sweeping `equityReturnVol`
> leaves house-sale-price risk almost unchanged. `propertyReturnIdioScale` multiplies the
> idiosyncratic vol and is therefore the honest MC axis for the sequence/timing risk on the house.
> `repairFreqScale` rescales only the *compared* probability/λ (never the draw structure), so the
> cursor discipline holds. All default 1.0, `mc:true`, opt-in (`enabled:false`) — inert on single
> runs and on the default golden.

**C. House path diagnostics.** Extend `computePathShape()` (`intl-retirement-mc-runner.js:62`,
folded into `summary.pathShape` at :285). Add: realized house CAGR (from the property `value`
series), worst house drawdown at/around the actual sale year, and the lifetime repair-spend
distribution (sum the `house_repair_expenses` metric or `state.houseRepairSpendingTotal`). The
repair total is already in state — surface it in the per-run result and take a median/percentiles
across runs.

> **✅ SHIPPED (C).** `computeHouseValueUsd(state)` sums the gross FX-converted property value;
> `extractYearlyTimeSeries` carries a `houseValueUsd` series and `evaluate` captures
> `lifetimeRepairSpend` from `state.houseRepairSpendingTotal`. `computePathShape` adds
> `houseCagr` / `houseMaxDrawdown` **over the pre-sale window only** — truncated at the first zero
> that follows a positive value, so a house *sold* (value → 0) is not mis-read as a 100% market
> drawdown. `summary.pathShape` gains `medianHouseCagr`, `medianHouseMaxDrawdown`, and
> `median`/`p10`/`p90` repair spend (new `percentile()` helper). **Gotcha found wiring D:** the
> series sums **all** properties, so in an arm where the US house sells early the CAGR/drawdown are
> the *held* (AU) house; and repairs only accrue while `value > 0`, so a house sold in year 1
> shows ~$0 lifetime repair — correct, but it means the holding-cost signal lives in the
> **never-sell** arms, which is exactly where the decision's failure risk concentrates.

**D. Re-run the company-equity decision** (`scenarios/company-equity-decision.md`) with Part A + B
on and write a **§6.6** there. Turn on `equityReturnStochastic` + `propertyReturnStochastic`, give
the US house a running cost + a `BERNOULLI` repair model, and re-measure. Design 74 §6.5 found
failure rates *fell* once sequence risk was measured honestly; the open empirical question is
whether **holding costs + house-sale-timing risk** move the tranche ranking or the house-sale
window conclusion (memory `house-sale-timing-window`, `scenario-total-outflow-excludes-mortgage`).
Headless runners: `scripts/run-scenario.mjs` / the MC runner; det runs ~18s (memory
`house-sale-timing-window`). This is the payoff design 74 §7 promised: *re-measure the binding risk
with an instrument that no longer understates it.*

**E. Open items to carry (not blockers) — CARRIED FORWARD, still open:** optimizer/MPC still
default `seed = 1` (design 74 §8 Q6) — if the decision uses the optimizer, candidate rollouts
share one path and need common random numbers; the property/repair ticks are reducer/`sim.rng`-
resident so they *should* reproduce without a `_seededSim` shim, but add an explicit CRN regression
before trusting optimizer results. The house running cost + repairs assume `US_RETIREMENT` is
present (see §6.2/6.3) — true for the decision scenario. The three new MC scalers
(`propertyReturnIdioScale` / `repairSeverityScale` / `repairFreqScale`) are `mc:true` but **not
yet `opt:true`** — they are sweep axes, not optimizer levers, which is the right default (you don't
*optimize* how volatile your house is). The new per-property cost/repair fields are wired through
state + serializer + both toolsets but **still NOT in the property-editor UI**
(`src/visualization/assets/real-property-editor.js`) — deliberately deferred (the decision work
drives costs/repairs via `mc-arm-house.mjs`/`mutateCfg`, not the UI). This is the one remaining
Phase-4 follow-up: a real end-user who wants to configure a house's running cost / repair model
from the app needs those ten fields surfaced in the editor.

---

## 7. Testing plan

Mirrors design 74 §6, extended for costs.

1. **Inertness** — Part A flag off + zero cost fields: golden byte-identical; no
   `REAL_ESTATE_*` dev emitted; no running-cost debit; no repair tick scheduled; RNG cursor
   unadvanced (assert directly).
2. **Determinism** — same seed ⇒ identical appreciation path *and* identical repair sequence.
3. **Snapshot safety** — snapshot mid-run, restore, continue ⇒ identical (JOURNAL_STRICT on).
   Covers both the property dev walk and the repair draws.
4. **Correlation** — with both flags on, `REAL_ESTATE_*` and equity sleeves load on the same
   `marketDev` ⇒ positive correlation at the configured betas; **not** independent (the §4
   diversification-lie regression, applied to property).
5. **Drift** — under GEOMETRIC, realized house geometric appreciation ≈ anchor; under NONE,
   ≈ anchor − σ²/2.
6. **Regular cost inflation** — a house held N years shows regular cost = base × price-level(N)
   (+ value% term); currency converts after the move; cost ceases at sale.
7. **Repair calibration & cursor** — long-horizon mean repair spend ≈ `freq × E[severity]`;
   enabling repairs on one property does not perturb another's draws; `repairModel: NONE` draws
   zero uniforms.
7a. **Repair capitalization** — with `capitalizeRepairs = f`, `costBasis` rises by `f ×` each
   repair; the sale-year gain (and CGT) falls by the capitalized total; `f = 0` leaves basis
   untouched (byte-identical to the non-capitalizing path).
8. **Sale interaction** — no running cost or repair is charged after `plannedSaleYear`; a repair
   the local pool can't cover escalates via `INTL_TRANSFER` rather than spuriously failing.
9. **No double-count** — a scenario with a configured `shocks[]` market crash **and** the
   property path on applies each effect once (regression against folding at two sites, cf. design
   74 §6 test 8).

---

## 8. Open questions — RESOLVED (owner, 2026-07-21)

All seven answered. Summary of decisions: inflation path → **defer to design 76** (Q1);
property draws its own `zMarket` when the equity flag is off → **standalone allowed** (Q2);
repairs → **BERNOULLI default**, Poisson/Continuous available (Q3); repair frequency
**independent** of the market (Q4); owner-occupied cost stays **separate** from rental
`rentalExpenseRatio` but **shares debit mechanics** (Q5); large repairs **can** capitalize into
basis via `capitalizeRepairs` (Q6); default betas/vols set from **research** — low betas, mostly
idiosyncratic, per-country (Q7, §4.1).


1. **Stochastic inflation path (design 74 §8 Q4).** The regular running cost rides the
   *deterministic* `inflationAccumulator`. A stochastic inflation path would make those costs
   (and every other inflating quantity — spending bands, wages, tax brackets) stochastic and
   correlated with real returns — arguably the most honest framing of retirement risk. It is
   also a much larger, cross-cutting change touching many reducers. **Recommendation: keep it
   out of design 75's core** (house-scoped) and give inflation its own design (76) as a *4th
   sleeve-like path* on the same `sim.rng`, correlated to `marketDev` with its own beta. Agree to
   defer? Answer: Agree
2. **Property path standalone vs. requiring the equity flag (§4.4).** When
   `propertyReturnStochastic` is on but `equityReturnStochastic` is off, should property draw its
   own `zMarket` (usable standalone, no correlation) — recommended — or should the flag be a
   no-op with a UI warning that it requires the equity path? The former is more useful; the
   latter avoids a "stochastic but uncorrelated" foot-gun. Answer: I accept the recommended approach
3. **Repair process default — BERNOULLI × LOGNORMAL?** (§5.2.) Bernoulli matches the owner's
   "one big thing breaks some years" mental model and keeps the parameter count low; Poisson is
   more faithful when multiple systems can fail in a year. Recommendation: **BERNOULLI** default,
   POISSON and CONTINUOUS available. Answer: BERNOULLI default, thers available
4. **Should repair frequency correlate with the market?** A recession does not cause a roof to
   leak, so the recommendation is **independent** repair draws. But *deferred* repairs (owners
   skip maintenance in bad times, then pay more later) are a real behaviour — worth a future
   behavioural lever, not core here. Confirm independence for now? Answer: independent
5. **Unify with rental operating expenses (design 48)?** Rentals already model operating cost via
   `rentalExpenseRatio`. Should owner-occupied running cost and rental expense ratio converge on
   one per-property cost model, or stay separate (rentals are tax-deductible against rental
   income; owner-occupied costs are not)? The tax treatment differs, which argues for keeping
   them separate but sharing the debit mechanics. Preference? Answer: Separate but can share debit mechanics
6. **Do large repairs add to cost basis?** §5.2 treats repairs as non-capitalized maintenance
   (no basis bump), which is the common tax reality for repairs vs. improvements. Should the
   model offer a `capitalizeRepairs` flag so a fraction of large repairs lifts `costBasis` (and
   reduces the eventual CGT)? Small effect; offered as an option. Answer: yes
7. **Default betas / vols (§4.1).** ✅ **RESOLVED via research + owner call (§4.1).** The original
   β = 0.4 was empirically too high: the contemporaneous housing↔equity correlation is ≈ 0.04
   (US), so the plan-breaking joint crash is a *tail* event, not an average one. **Owner decision:
   lean on `shocks[]` for the joint crash** (a combined equity + real-estate shock) — the standing
   linear beta is set to the near-zero historical average, not to a tail-inflated value. New
   **per-country** defaults: US `β = 0.03, idio σ = 0.09` (total ≈ 9.0%); AU `β = 0.05, idio σ =
   0.10` (total ≈ 10.0%, AU marginally higher — more credit/macro-sensitive). ~99% of house
   variance is idiosyncratic; the systemic joint crash lives in `shocks[]` (or a future fat-tail
   lever the low beta seams into). Sources in §4.1.

---

## 9. Relationship to other designs

- **74 (stochastic return paths)** — the **direct parent**. This design is §7 of 74 made real:
  it reuses the shared `equityReturnMarketDev` market factor (so property co-moves with
  equities), the per-sleeve beta/idio structure (§4), the `equityReturnDriftComp` volatility-drag
  decision (§4.3), and the RNG-cursor discipline (§4 ⚠️). Follow 74's phase discipline closely.
- **67 (bond yield curve)** — the structural template 74 itself followed: flag-gated tick
  handler, pure apply-reducer, deviation folded additively onto a rate, inert by default.
- **54 (loans & liabilities)** — the mortgage is already a separate `Loan`; this design adds the
  *non-mortgage* cost of ownership the loan does not capture (memory:
  `property-mortgage-lives-on-loan`, `scenario-total-outflow-excludes-mortgage`).
- **48 (rental income)** — models rental *operating* cost via `rentalExpenseRatio`; §8 Q5 asks
  whether owner-occupied running cost should unify with it.
- **28 (asset appreciation)** — owns `AssetAppreciationHandler`, the seam Part A extends.
- **The company-equity decision** (`scenarios/company-equity-decision.md`) — the consumer.
  Design 74 §6.5 re-ran it for sequence risk; §6.4 here re-runs it once the *binding* risk (the
  house) is finally modelled with variance **and** holding cost. This is the re-measurement 74 §7
  said the house work exists to enable.
