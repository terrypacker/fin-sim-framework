# 61 — Holding-allocation lever: optimize the Stock/Bond/Cash/Gold mix over time

**Status**: **COMPLETE — ALL PHASES 1–5 IMPLEMENTED** (2026-07-16) on
`wip/holding-allocation-lever`. **Amended 2026-07-29**: OQ4(a)'s US-retirement gold
guard is **REVERSED** (§12 OQ4a — a gold ETF is holdable in an IRA/401k/Roth and taxed
closely enough to bullion to be the same sleeve); four defects found in use are recorded
in §12.1 (one fixed, three open) with the questions they raise in §12.2 — **all four of
which are now resolved AND implemented** (Q1 accept-the-band — no code needed; Q2
`targetForRole` removed; Q3 total-mix validation incl. the MPC harvest path; Q4
residency-aware gold location). Q4's *specified* ordering was refuted by measurement and
the shipped lists differ from it — see §12.2 Q4 for the numbers and the corrected rule. Phase 1 = Lever A (searchable static mix); Phase 2 = Lever C
(taxable-aware rebalance + buy/establish-sleeve primitive + US-IRA gold guard + split drift
bands); Phase 3 = Lever B (time variation — STATIC/GLIDEPATH/REGIME_CONDITIONED); Phase 4 =
Lever D (jurisdiction-aware location — LOCATED default / PER_ACCOUNT); Phase 5 = MPC online
(`ALLOCATION_MIX` cockpit control). Originally **PROPOSED** (2026-07-13). Scope: add a new optimization
lever — a **portfolio asset-allocation control** — that lets the solver (and the
MPC cockpit) **buy and sell holdings to hit a target Stock/Bond/Cash/Gold ratio,
and vary that ratio over time in response to economic conditions**. It is the
natural sibling of the design 58 drawdown levers: design 58 decides *which account
to sell to fund spending*; design 61 decides *what asset mix to hold* and lets the
model rebalance into it — so we can test optimal responses to economic shocks and
taxes across the whole simulation.

This design leans heavily on machinery that **already exists** (the design 29
behavioral family + the holdings/CGT stack) rather than building from scratch.

**Build plan:** see the companion `design/61-holding-allocation-lever-implementation.md`
— per-phase files, signatures, wiring anchors, tests, and gotchas (implementation-ready
sketch for a future session).

---

## 1. Motivation

The plan's return, its drawdown of tax, and its resilience to shocks are all
downstream of one decision the model currently makes *statically*: the asset mix.
Two levers already shape wealth trajectories — the economic **regime/shock** layer
(design 21/28) moves per-class returns, and the **drawdown** lever (design 58)
chooses liquidation order — but the model can't yet *change what it holds* in
anticipation of, or reaction to, those conditions. Real households do: they glide
equity down with age, tilt to bonds/cash/gold entering a downturn, and weigh
"rebalance now and pay CGT" against "let it drift."

Making the allocation a **first-class, time-varying, optimizable lever** lets us ask
the questions that matter:

- Does shifting toward **gold/bonds** ahead of an `ECONOMIC_STRESS` regime beat a
  static 60/40, *net of the capital-gains tax the rebalance realizes*?
- What **glidepath** (equity→bond over the plan) maximizes terminal wealth or
  minimizes lifetime tax?
- How should the mix differ **by account tax-treatment** (bonds in tax-deferred,
  equity in Roth, gold in taxable)?

None of these are reachable today because the target mix is a fixed JSON blob, is
never re-decided over time, and rebalancing is restricted to tax-advantaged
accounts (so it can't even *see* the tax trade-off).

---

## 2. What exists today (the foundation to build on)

This is the important part: **the buy/sell-holdings primitive and a target-mix
rebalancer already exist.** Design 61 is mostly *promoting* them to an optimizable,
time-varying, taxable-aware lever — not inventing the mechanism.

**Holding model.** `Holding` (`holdings/holding.js`) is per-**allocation**
(`ALLOCATION` = `EQUITY | BOND | CASH | GOLD | OTHER`, `holdings/allocation.js`)
with `marketValue`, `costBasis`, `costBaseByCountry`, `rateKey`, `duration`,
`couponRate`, `treasury`. Invariant `account.balance === Σ holdings.marketValue`
(`holding-reducers.js#_syncBalance`). An account already holds a *mix* of
allocation sleeves.

**Within-account rebalancer (design 29 §3.5).** `OpportunisticRebalanceReducer`
(`behavioral/opportunistic-rebalance-reducer.js`) computes each account's actual
allocation fractions, compares to a `targetAllocation` (default `{EQUITY:0.6,
BOND:0.4}`), and on drift past `rebalanceDriftBand` **or** on `ECONOMIC_STRESS` /
`PANIC_SELL_TRIGGER` regime entry emits `OPPORTUNISTIC_REBALANCE_APPLY` with
per-allocation `{allocation, delta}` legs. `OpportunisticRebalanceApplyReducer`
executes them: moves value between allocations pro-rata across holdings, conserving
total, adjusting `costBasis`, re-syncing `balance`.

**Cross-account tax-aware placement (design 29 §3.4).**
`StrategicAssetLocationReducer` swaps mislocated holdings between tax-advantaged
accounts per an `assetLocationPolicy` (`{BOND:[ira,k401], EQUITY:[roth]}`) →
`ASSET_LOCATION_REBALANCE_APPLY`.

**Taxable disposal with CGT.** `StockWithdrawalApplyReducer`
(`account-rules/us/us-brokerage-classes.js`, `STOCK_WITHDRAWAL_APPLY`) credits the
cash pool, **FIFO-consumes holdings** (`holdings-fifo.js#consumeHoldingsFifo`), and
chains `STOCK_WITHDRAWAL_TAX` (US/AU capital gain, AU CGT-reform indexation) plus
`COLLECTIBLE_SALE_TAX` for GOLD lots (US 28% collectibles rate, design 56/57). This
is the **correct taxable-sell path** a taxable rebalance must reuse.

**New-sleeve growth.** `resolveRateKey(country, allocation, role)`
(`holdings/default-allocations.js`) returns the right `state.effectiveGrowthRates`
key for any allocation — `GOLD → RATE_KEYS.GOLD`, `CASH → SAVINGS_{country}`,
etc. — so a freshly established sleeve grows correctly.

**Parameterization.** The rebalancer's knobs are behavioral params
(`behavioral-strategy-registry.js`): `rebalanceTargetAllocation` (**type
`Object`**), `rebalanceDriftBand`, `assetLocationPolicy`, `panicFraction`. Selected
via `behavioralStrategies: string[]` (EnumMulti).

---

## 3. The gaps

| Want | Reachable today? | Blocked by |
|---|---|---|
| Optimizer **searches** the target mix | ❌ | `rebalanceTargetAllocation` is an `Object` param — `opt:true` is declared but the solver only handles `CONTINUOUS/INTEGER/ENUM` axes, so an Object is never swept |
| **Time-varying** mix (glidepath / per-regime) | ❌ | one static target for the whole run; the trigger is reactive (drift/regime entry), not a controllable schedule |
| Rebalance **taxable** accounts (to study the tax trade-off) | ❌ | `OPPORTUNISTIC_REBALANCE_APPLY` is tax-advantaged-only and realizes **no CGT** (it just rewrites `costBasis`) — "taxable rebalancing deferred" per the design 29 §3.5 comment |
| **Establish a new** allocation sleeve (e.g. buy GOLD where none is held) | ❌ | the apply reducer `continue`s when `matching.length === 0` — it can only scale existing sleeves |
| **Buy** side with correct basis/rate/tax | partial | the free apply fabricates basis; there's no symmetric taxable buy that stamps `purchaseDate`/`rateKey`/`costBasis` and (for BOND) `duration`/`treasury` |
| Re-decide the mix **each MPC epoch** from realized state | ❌ | no cockpit control / projection shim / actuate for allocation (the design 58 §11 triad) |

---

## 4. The lever, decomposed (mirrors design 58's orthogonal sub-levers)

Like design 58 split "drawdown" into Where/Order/Within-tier, split "allocation"
into four orthogonal, composable dimensions. Each is a static scenario param **and**
a one-shot opt axis **and** (later) an MPC-online control.

### Lever A — Target mix as a continuous, solver-searchable simplex

Replace the `Object` target with per-allocation continuous weights the solver can
tune directly, exactly like design 58 Lever B's `drawdownWeight::<role>`:

```text
paramKey: 'allocWeight::EQUITY' | 'allocWeight::BOND' | 'allocWeight::CASH' | 'allocWeight::GOLD'
type:     CONTINUOUS   min: 0  max: 1
```

- **Simplex constraint — encode intrinsically, don't just normalize.** The applied
  target is a distribution summing to 1. A naive `w_i / Σ w_j` over a full `[0,1]^K`
  box is **scale-invariant** (`w` and `2w` give the same mix) → a flat,
  non-identifiable ray in the objective, the *same* pathology as the design-58
  phantom drawdown dims (a direction the solver can't resolve and the surrogate's
  trust region can't shrink). Fix: search the simplex **intrinsically** —
  `K−1` free weights with the last allocation as the residual `1 − Σ` (or fix a
  reference sleeve to 1). The design-46 surrogate additionally carries the simplex as
  a native `Σw=1` + `w≥0` constraint in its QP. **The algorithm detail lives in
  `design/46` §6 (new "simplex/allocation levers" pivot seam); this lever is its
  first consumer.** See OQ1.
- **`::` separator, not `.`** — same reason as design 58 Lever B
  ([[optimizer-param-key-dot-collision]]): the MC/Opt/MPC `set()` silently drops
  dotted keys whose parent object doesn't pre-exist, leaving the axis inert.
- **Warm-starts.** Named presets (`SIXTY_FORTY`, `ALL_WEATHER`, `EQUITY_TILT`, …)
  are single points in weight space, seeding the solver — the Lever-B pattern.
- Small (3–4 dims), smooth → CEM / pattern-search handle it directly.

### Lever B — Time variation (the "over time / in response to conditions" ask)

*How* the target changes across the run — three modes, chosen by an enum
`allocationSchedule`:

1. **`STATIC`** — one target for the whole plan (default; reproduces today's fixed
   mix ⇒ back-compat).
2. **`GLIDEPATH`** — target interpolated over age/time between a few solver-tuned
   anchor points (e.g. equity 80%→40% from 50→75). Modeled like the spending
   `EXPLICIT_BANDS` (a small table of `{age, weights}` the optimizer tunes).
3. **`REGIME_CONDITIONED`** — a distinct target **per regime tag**
   (`NORMAL` / `ECONOMIC_STRESS` / `HIGH_INFLATION` / …), read from
   `state.activeRegimes`. This is the flagship "**shift to gold/bonds in a
   downturn**" capability — the mix is a *function of realized economic
   conditions*, which is precisely the user's request. It generalizes today's
   reactive `PanicSell` (EQUITY→CASH on stress) into a full per-regime mix the
   solver optimizes.

Modes compose (a glidepath *of* per-regime targets is possible later; ship them
independently first).

### Lever C — Taxable-aware rebalancing (make the tax trade-off real)

Extend rebalancing beyond tax-advantaged accounts, routing each leg through the
tax-appropriate path:

- **Tax-advantaged legs** → the existing free `OPPORTUNISTIC_REBALANCE_APPLY`
  (no CGT).
- **Taxable sell legs** → the **CGT-realizing** disposal path
  (`STOCK_WITHDRAWAL_APPLY`-style FIFO consume → `STOCK_WITHDRAWAL_TAX` +
  `COLLECTIBLE_SALE_TAX` for GOLD, AU indexation). This is what lets the optimizer
  weigh *"rebalance now, pay the gain"* vs *"let it drift"* — the whole point of a
  tax study.
- A **tax-aware trigger** knob so taxable accounts aren't churned every period:
  e.g. a wider `rebalanceDriftBand` for taxable, "only rebalance taxable at
  year-end," or harvest-coordinated (compose with `TAX_LOSS_HARVEST` /
  `TAX_GAIN_HARVEST`, which already exist).

### Lever D — Location (which account holds the mix)

The Lever-A target is a **whole-portfolio** ratio; it must be *located* across
accounts. Reuse/extend `StrategicAssetLocationReducer`: bonds → tax-deferred
(IRA/401k where interest is sheltered), equity → Roth/taxable. **Gold location is
residency-dependent, not a fixed "gold → taxable" rule** (OQ4): a US resident pays
the **28% collectibles rate** on gold in a taxable account (punitive vs LTCG →
prefer sheltering it in a tax-advantaged account), whereas an AU resident's bullion
sleeve is an **ordinary, CPI-indexed AU CGT asset** (`isGold:true` routes it through
the indexed-ordinary path, *not* the US collectible rate — `us-brokerage-classes.js`
~L266, design 57 §6.4/§7.2), so in AU a taxable-account gold sleeve is no worse than
equity and super shelters it entirely. So the location policy must be
**jurisdiction-aware** and compose with residency/move-year:
- ~~**US retirement accounts cannot hold the GOLD sleeve**~~ — **REVERSED 2026-07-29,
  see §12 OQ4(a). The guard was wrong and is removed: a US IRA/401k/Roth may hold the
  GOLD sleeve.** The original text is kept below for the record.
  > *(superseded)* US retirement accounts cannot hold the GOLD sleeve (IRA/401k/Roth
  > bullion ban): an eligibility guard excludes US tax-advantaged roles as gold targets
  > — for both the location policy and the establish-new-sleeve buy (§6), so a gold buy
  > never lands in a US IRA. AU **super** *is* gold-eligible (permitted SMSF asset), so
  > the guard is US-tax-advantaged-only.

  With the guard gone, gold location is decided **purely by the tax arithmetic** the
  rest of this section already describes, which is the more interesting answer: a US
  resident's 28% collectibles rate makes sheltering gold in a tax-advantaged account
  *attractive*, and that option previously did not exist for the solver to find. AU
  super remains gold-eligible as before, so the location policy no longer carries any
  role-based gold exclusion at all.
- **Post-move relocation is lazy, not move-pinned:** the optimal gold home flips at a
  US→AU move (US: shelter to dodge 28%; AU: taxable fine, super best), but the policy
  just re-*targets* the new optimum and lets the normal rebalance cadence (OQ3) walk
  holdings there over the following periods — avoiding a forced taxable event on the
  move date that could realize CGT badly or straddle the residency cost-base step-up
  (design 57).

Location stays a tax-aware role-level policy — see §5 for why this is the right unit
and lets us avoid per-account ordering.

---

## 5. Per-account vs per-role vs per-portfolio (answering the OQ directly)

> *"We may need a per account order rather than a per account-role order but this is
> debatable if we optimize holdings across roles rather than accounts."*

**Recommendation: optimize the mix at the _portfolio_ level (one target across all
accounts), and let a _role-level, tax-aware location policy_ decide placement.** You
then do **not** need a per-account order.

Three candidate granularities:

| Granularity | Search dim | Pros | Cons |
|---|---|---|---|
| **Per-portfolio target + role location** *(recommended)* | 3–4 weights (+ location policy) | Small, smooth, **stable across account edits**; matches how people think ("I want 60/30/10"); tax placement is the natural role-level decision | Can't express "different mix in account X vs Y" beyond what location implies |
| **Per-role target** | 3–4 × #roles | Finer control per sleeve | Larger; most roles map to one allocation today (§ default-allocations), so mostly redundant with location |
| **Per-account target** | 3–4 × #accounts | Fully general | Search grows/changes with **every account edit** — the exact instability design 58 OQ2 rejected for drawdown |

This mirrors design 58's resolved OQ2 (search at the **role** level, not per-account,
for stability + small search space; keep per-account only as a manual escape hatch).
The buy/sell primitive still operates **per account** (holdings live in accounts) —
but the *decision variable* is portfolio-level, and Lever D maps it onto accounts.
A per-account manual override (pin a specific account's mix) can be a later
power-user add, the allocation twin of drawdown's `CUSTOM`.

**Corollary:** design 61 does **not** require the "per-account drawdown order"
successor mentioned in the design 58 notes. If per-account allocation is ever wanted,
that successor becomes relevant — but it is explicitly out of scope here.

---

## 6. Buy & sell holdings primitive ("a way for the solver to buy and sell")

A single rebalance step computes **portfolio-level legs** (Σ target − Σ actual per
allocation, after Lever D locates them onto accounts), then routes each leg:

- **Sell (taxable):** `consumeHoldingsFifo` + `STOCK_WITHDRAWAL_TAX` /
  `COLLECTIBLE_SALE_TAX` (reuse `STOCK_WITHDRAWAL_APPLY` wiring). **Sell
  (tax-advantaged):** free proportional reduce (today's apply path).
- **Buy:** a symmetric primitive that either (a) **adds** to an existing holding of
  the target allocation (today's positive-delta branch), or (b) **establishes a new
  sleeve** when none exists — the gap to fix in `OpportunisticRebalanceApplyReducer`
  (`matching.length===0` currently `continue`s). A new sleeve stamps
  `allocation`, `marketValue = amount`, `costBasis = amount`, `purchaseDate = now`,
  `rateKey = resolveRateKey(country, allocation, role)`, and BOND defaults
  (`duration`, `treasury=false`, floating `couponRate=null`). This is what makes
  **"buy GOLD where I hold none"** work.
- **Value conservation net of tax/fees:** proceeds from sell legs fund buy legs;
  the CGT owed on taxable sells is a real cash outflow (settles via the existing
  tax-settle path), so the buy side deploys *after-tax* proceeds. Cross-currency
  legs (US↔AU) convert through the existing FX (`fxOf`/`feeOf`) — compose with
  design 58 Lever A's cross-border machinery.

Proposed action: `REBALANCE_TO_TARGET_APPLY` (portfolio legs) that fans out to the
per-account tax-appropriate applies above, so there's one place the target→trades
translation lives.

---

## 7. Optimizer / MC / MPC wiring (mirrors design 58 §7 & §11)

**Static + one-shot opt.**
- Lever A: 3–4 `allocWeight::<ALLOCATION>` CONTINUOUS axes (`enabled:false`), gated
  `visibleWhen: allocationStrategy = OPTIMIZED` (a new sentinel mode, the
  `WEIGHTED`-drawdown analog). Warm-start from named presets.
- Lever B: `allocationSchedule` ENUM axis; GLIDEPATH anchors as
  band-style generated params; REGIME_CONDITIONED as one weight-set per regime tag.
- Lever C/D: `rebalanceDriftBand` (taxable vs sheltered), `assetLocationPolicy`
  already exist — surface as axes.

**MPC online (flagship — the "adjust over time in response to conditions" as a live
control).** Same triad as design 58 §11.2:
1. **`COCKPIT_CONTROLS` spec** `ALLOCATION_MIX`: `buildVariables` returns the
   `allocWeight::*` axes (pruned to allocations actually reachable — the design 61
   analog of the design 58 build-time role filter); `describe` renders the resulting
   mix; `appliesTo` gates on the OPTIMIZED mode.
2. **`_seededSim` projection shim:** after snapshot injection, re-apply the committed
   target (re-stamp `state.rebalanceTargetAllocation` / re-run the locate→trade so
   the forward rollout honors it) — the allocation twin of the design 58
   `FORWARD_DRAWDOWN_STATE_FIELDS` / per-account `drawdownPriority` re-stamp.
3. **Live `actuate`:** write the target forward-effective on the running sim and
   persist the param, so Advise/Apply/live agree.

**Hold-band hysteresis (ε) — even more important here.** Rebalancing **realizes
CGT**, so epoch-to-epoch flip-flop is directly costly. Reuse design 58 §11.4's
switching-cost idea: only re-trade when the projected gain clears ε, and compare
*applied mix distance* (e.g. L1 over the simplex) not raw weights, so sub-threshold
drift is free. A no-trade band around the target (today's `rebalanceDriftBand`) is
the static analog.

**Harvesting MPC learnings into a re-runnable scenario (OQ7).** Primary use is
**online (MPC first)**, but the discovered policy must be **bakeable back into a
saved scenario** — exactly as the SPENDING lever's per-epoch band amounts persist
into the `spendingExpenseBands` param and re-run deterministically. The mechanism is
already there: `mpc-controller.js` accumulates each epoch's committed choice into
`committedParams` (`mergeCandidate`), and each cockpit control's `actuate` persists
the committed value to a scenario param.

> **Correction (2026-07-25, from the design 39 §13 grounding pass).** The premise
> above is wrong about SPENDING, and the mechanism is *not* already there.
> `SPENDING.actuate` writes the epoch's amount onto the **band active at that
> epoch**, so ~20 epochs leave **last-epoch-wins on one band**, not a per-epoch
> schedule. Only the schedule-shaped levers (`rothConversionSchedule`,
> `earlyWithdrawalSchedule`) accumulate correctly, and that is an accident of their
> param shape. Every scalar lever — including `allocWeight::*` — collapses to its
> final value silently. The explicit harvest is specified in
> **design 39 §13** (see §13.1's table).

For allocation:
- **GLIDEPATH** is the cleanest harvest target — the committed per-epoch mix becomes
  a table of `{age, mix}` anchors (the allocation twin of spending bands), which
  re-runs deterministically with no controller in the loop.
- **REGIME_CONDITIONED** persists as a per-regime target *map*; it also re-runs
  deterministically, because regimes are a deterministic function of the scenario's
  shock configuration — so the saved map reproduces the same conditional behavior.
- **Fidelity caveat (same as spending bands):** a discretized schedule/anchor set is
  an *approximation* of the continuous receding-horizon policy — "as best as
  possible," not bit-exact. The re-run is a faithful, inspectable, shareable
  scenario; the MPC remains the source of the policy.

---

## 8. Interaction with drawdown (58) and shocks (21/28/29)

- **Order of operations per period:** contributions → **rebalance-to-target** →
  drawdown-to-fund-spending. Both touch holdings; define precedence explicitly so
  the year-end `_syncBalance` snap and the multi-holding transaction path
  ([[multi-holding-transaction-desync]]) stay consistent.
- **Synergy worth flagging:** the most tax-efficient rebalance is to **fund spending
  from the over-weight sleeve** — i.e. let the design 58 drawdown *also* correct the
  mix (sell what you're overweight first). A future unification could make drawdown
  allocation-aware so a single sale both funds spending and rebalances, avoiding a
  second CGT event. Out of scope here, but the levers are designed not to preclude it.
- **Cash is a first-class allocation choice, not just a residual (OQ2).** Holding
  CASH through a crash is a *deliberate, beneficial* strategy the optimizer must be
  able to choose — so CASH stays a target sleeve the lever can dial up, **not** the
  leftover after EQUITY/BOND/GOLD. It reconciles with the design-58 cash band by
  layering: the drawdown lever's `minimumBalance` is a **hard liquidity floor**
  (spending must always be fundable); the allocation lever's CASH target is a
  **desired holding on top**, so effective cash = `max(allocationTargetCash,
  drawdownFloor)`. When the target cash exceeds the floor the lever *buys* cash (sells
  EQUITY/BOND into the cash sleeve, realizing CGT on taxable legs — the tax cost of
  "going to cash" is then real and optimized against the crash protection it buys).
- **Regime coupling — coexist, and design 61 is independently selectable (OQ5).**
  Lever B `REGIME_CONDITIONED` **generalizes** the reactive `PanicSell` /
  `OpportunisticRebalance` regime triggers, but they **coexist**: they're independent
  entries in `behavioralStrategies` (EnumMulti). **To study the design-61 lever in
  isolation, simply select it and leave `PANIC_SELL` / `OPPORTUNISTIC_REBALANCE`
  unselected** — nothing else fires. (This implies design 61 registers as its own
  selectable strategy/mode, so it composes à la carte like the rest of the design-29
  family.) Deprecating the overlap with the legacy reactive strategies is a later
  cleanup, not a prerequisite.
- **Cross-border composition with design 58 Lever A (OQ6 — a *single* scope drives
  both).** The allocation target's *scope* reuses `crossBorderDrawdown`
  (`AUTO`/`LOCAL_FIRST`/`GLOBAL`): a **GLOBAL** target treats the whole US+AU portfolio
  as one mix, locating each class in its tax-favored country (FX-converted);
  **LOCAL_FIRST** keeps a per-country mix. The OQ6 prototype shows GLOBAL's edge is a
  cross-border tax-location arbitrage that **only survives if drawdown is GLOBAL too** —
  a GLOBAL-allocation / LOCAL_FIRST-drawdown mix has the drawdown re-sell the located
  assets and undo it. So **one shared scope drives both levers** (allocation mirrors
  `crossBorderDrawdown`), not two independent switches. See §12 OQ6.

---

## 9. Registration checklist (mirror design 58 §7)

**Lever A (Phase 1):**
1. `intl-retirement-scenario.js` — `allocationStrategy` enum (`STATIC` default +
   `OPTIMIZED`) + `buildAllocWeightSchema()` (per-allocation CONTINUOUS params,
   `::`-keyed, gated on OPTIMIZED), a `presentAllocations(accounts/holdings)`
   build-time filter (design 58 filter analog), and `allocWeightsFromPreset()`
   warm-starts. Defaults reproduce today's mix ⇒ byte-identical golden.
2. `behavioral-strategy-registry.js` — `OPPORTUNISTIC_REBALANCE` reads the synthesized
   continuous target (normalize-by-sum) instead of the `Object` param when
   `allocationStrategy=OPTIMIZED`; keep the `Object` path as the manual escape hatch.
3. `intl-retirement-opt-config.js` — CONTINUOUS axes via `buildAllocWeightSchema`,
   `enabled:false`, account-filtered like `buildOptVariables(params, accounts)`.
4. Serializer round-trip test for the new params (live field via `initialState`).

**Lever C (Phase 2):** taxable-aware apply (`REBALANCE_TO_TARGET_APPLY` → CGT path
for taxable legs) + establish-new-sleeve fix in the apply reducer + buy primitive +
the **US-tax-advantaged gold eligibility guard** (OQ4a, so a gold buy never lands in a
US IRA) + **separate `rebalanceDriftBand` for taxable (wide) vs sheltered (tight)**
per the OQ3 prototype.

**Lever B (Phase 3):** `allocationSchedule` (STATIC/GLIDEPATH/REGIME_CONDITIONED);
glidepath anchor params; per-regime weight sets; resolver reads `state.activeRegimes`.

**Lever D (Phase 4):** jurisdiction-aware `assetLocationPolicy` (gold home by
residency; US-IRA gold guard; lazy post-move relocation, OQ4b), wire the portfolio
target → per-account location.

**MPC (Phase 5):** `ALLOCATION_MIX` cockpit control + `_seededSim` shim + actuate +
hysteresis ε; headless `scripts/verify-mpc-lever.mjs allocationMix`.

---

## 10. Testing plan

- **Back-compat golden:** `allocationStrategy=STATIC` at the current default mix ⇒
  `cross-border-relief-scenario.test.mjs` **must not move**.
- **Lever A:** a synthesized weight vector reproduces a named preset's mix to the
  dollar; a shifted weight changes the held mix; the `K−1`/residual encoding keeps
  the applied mix on the simplex (Σ=1) with no scale-degenerate direction; the
  build-time allocation filter prunes unreachable allocations (design 58 pattern).
- **Lever C (the tax study):** a taxable rebalance realizes the correct
  `STOCK_WITHDRAWAL_TAX` (US LTCG + AU indexed) and, for GOLD, the
  **jurisdiction-correct** `COLLECTIBLE_SALE_TAX` — US 28% collectibles vs AU
  ordinary CPI-indexed (`isGold:true`); a tax-advantaged rebalance stays free;
  after-tax proceeds fund the buy legs (value conserved net of tax).
- **Buy primitive:** establish a GOLD sleeve from zero (correct `rateKey`,
  `purchaseDate`, `costBasis`); BOND sleeve gets `duration`/`treasury` defaults.
- **Lever B:** `REGIME_CONDITIONED` shifts the mix on `ECONOMIC_STRESS` entry and
  reverts on exit; `GLIDEPATH` interpolates between anchors by age.
- **MPC:** the committed target **bites under a snapshot-seeded rollout** where it's
  inert without the shim (GAP→PASS, `verify-mpc-lever.mjs`); hysteresis suppresses
  sub-ε churn.
- **Cadence (OQ3):** a taxable account under a tight band realizes materially more
  CGT than under a wide band for marginal tracking gain; a sheltered account is
  cadence-insensitive on wealth. (Design-informing evidence already produced by
  `scripts/prototype-rebalance-cadence.mjs`; the in-sim test asserts the *ordering*,
  not the toy magnitudes.)
- ~~**Gold guard (OQ4a):**~~ **INVERTED 2026-07-29 (§12 OQ4a).** The old assertion —
  *a gold buy is never located into a US IRA/401k/Roth* — is now the wrong behaviour.
  Replace with: a gold buy **may** land in a US IRA/401k/Roth, and the located optimum
  **prefers** it while US-resident (the 28% collectibles rate makes sheltering gold the
  tax-efficient placement). AU super remains gold-eligible, unchanged.
- **Dust (§12.1 D1):** liquidating a sleeve leaves no remnant; the sweep conserves gross
  value and, in isolation, cost basis; a cent-valued lot carrying real basis is left alone.
- **Total mixes (§12.2 Q3):** an authored mix missing a class, or summing to ≠ 1, is
  rejected at compile with the offending anchor/tag named; a narrowed stick-breaking search
  still emits all four classes, so a harvested glidepath is always valid.
- **Gold location (§12.2 Q4):** gold's preferred home follows residency (US ⇒ deferred
  first, AU ⇒ super first, Roth last in both); an explicit `allocationLocationPolicy`
  override still wins per class; every account composition still sums to its own total.
- **Serializer round-trip** for every new param.

---

## 11. Phased rollout (proposed)

1. **Phase 1 — Lever A (searchable static mix). ✅ DONE (2026-07-16).** Continuous
   `allocWeight::*` axes replace the `Object` target for the optimizer; reuse the
   existing tax-advantaged apply. Smallest useful increment; golden unchanged. *(No
   taxable rebalancing yet — so no tax study, but the mechanism and search space
   land.)* Shipped: stick-breaking `synthesizeTargetAllocation` + `allocWeightsFromMix`/
   `allocWeightsFromPreset`/`buildAllocWeightSchema`/`presentAllocations` in
   `intl-retirement-scenario.js`; a `TARGET_ALLOCATION` `behavioral-strategy-registry.js`
   entry (auto-exposed by `economic-regimes-toolset.js`, coexists with
   `OPPORTUNISTIC_REBALANCE` per OQ5) that feeds the synthesized target to the existing
   `OpportunisticRebalanceReducer` under `allocationStrategy=OPTIMIZED`; `allocWeight::*`
   opt axes + build-time class filter in `intl-retirement-opt-config.js`; tests
   `evt-target-allocation.test.mjs` (ALLOC-1..10) + `param-sweep-schema.test.mjs`
   SWEEP-15..17. Golden `cross-border-relief` byte-identical (strategy unselected by
   default). **Known Phase-1 limitation (fixed by Phase 2 §6):** a target class with no
   existing sleeve can't be established — the reused apply `continue`s on the empty leg,
   so that leg's value is not deployed (observed as a small value leak when targeting
   CASH/GOLD where none is held). Targets that map onto existing sleeves rebalance
   exactly and conserve value.
2. **Phase 2 — Lever C (taxable-aware) + buy primitive. ✅ DONE (2026-07-16).** Route
   taxable legs through the CGT path; fix establish-new-sleeve; add the US-IRA gold guard
   (OQ4a) and the split taxable-wide / sheltered-tight drift bands (OQ3). **Unlocks the
   tax study.** Shipped as a NEW dedicated reducer pair (leaving the legacy
   `OpportunisticRebalance*` untouched): `RebalanceToTargetReducer` (both tiers; picks the
   band by tier; renormalizes a US-tax-advantaged account's target to drop GOLD, §OQ4a)
   + `RebalanceToTargetApplyReducer` (taxable sells → jurisdiction-correct
   `STOCK_WITHDRAWAL_TAX` / `AU_STOCK_WITHDRAWAL_TAX` / `COLLECTIBLE_SALE_TAX`, mirroring
   the brokerage disposal field math via `consumeHoldingsFifo`; sheltered sells free;
   buys add-to or **establish** a sleeve). The `TARGET_ALLOCATION` registry entry swaps to
   these; new params `rebalanceDriftBandTaxable` (0.10) / `rebalanceDriftBandSheltered`
   (0.02), both opt axes. Value model matches `StockHarvestApplyReducer`: sell realizes
   CGT into the YTD accumulator (settles at year-end), buy redeploys **gross** proceeds
   within the account, legs sum to zero ⇒ gross value conserved. Tests: taxable
   `evt-target-allocation-taxable.test.mjs` (RC-1..7 + RC-3b), postconditions
   (I3/I7), coverage manifest. Golden byte-identical (unselected).
   - **Critical fix found by end-to-end verification (not caught by unit tests):** an
     established sleeve MUST carry a **unique, non-null id**. `HoldingTransactReducer`
     matches per-holding growth/dividend/coupon/cash-interest by `h.id === holdingId`, so
     `id:null` siblings collide — a sleeve's earnings land on the wrong holding and the
     account is corrupted (a full-sim run destroyed ~96% of wealth before the fix).
     `_newSleeve` now stamps a deterministic `reb-<alloc>-<purchaseMs>` id (disambiguated
     against current holdings). Regression: RC-3b.
   - **~~Known limitation — BOND sleeves earn nothing in every account except `US_STOCK`.~~
     ✅ FIXED (2026-07-16).** `computeHoldingsGrowth` skips BOND on the equity path (a bond's
     return is its coupon, not appreciation), and the `INTL_BOND_COUPON` stream (design 59)
     was instantiated in exactly one place — `us-retirement-toolset.js` scoped to `US_STOCK`
     accounts. So a BOND sleeve established in `AU_STOCK`, `IRA`, `K401`, `ROTH`, or `SUPER`
     earned **zero return** — the optimizer saw bonds as zero-return everywhere but a US
     brokerage and under-weighted them there. **Fix (mirrors design 60's `CashSleeveInterestHandler`):**
     a new **`BondSleeveCouponHandler` + `BondSleeveCouponApplyReducer`** pair on a shared
     annual `BOND_SLEEVE_COUPON` event (scheduled whenever any equity-served account exists).
     It reinvests each BOND sleeve's coupon (`marketValue × (couponRate ?? per-account
     fixed-income fallback)` — design-61 sleeves carry `couponRate=null`) and taxes it by a
     `taxMode`: **`deferred`** for `IRA`/`K401`/`ROTH`/`SUPER` (grows the wrapper, taxed on
     withdrawal) and **`au`** for `AU_STOCK` (AU ordinary income via `AU_SAVINGS_EARNINGS_TAX`).
     `US_STOCK` is deliberately EXCLUDED — its bonds keep the existing `INTL_BOND_COUPON`
     stream, so there is no double-count (the two mechanisms are layered, not unified, exactly
     as design 60 layered cash-sleeve interest atop the savings handlers). A `us` taxMode
     (chaining `BOND_COUPON_TAX` for the Treasury-exempt federal+state+FITO split) exists for
     completeness but is unwired today. Dedicated `FIXED_INCOME`/`AU_FIXED_INCOME` accounts are
     unaffected (they earn via `FixedIncomeInterestHandler`); CASH sleeves are design 60; GOLD
     grows. Tests: `evt-bond-sleeve-coupon.test.mjs` (BOND-SLV-1..7, incl. IRA + super
     end-to-end growth).
3. **Phase 3 — Lever B (time variation). ✅ DONE (2026-07-16).** GLIDEPATH + the
   flagship REGIME_CONDITIONED ("respond to conditions"). Shipped: an `allocationSchedule`
   enum (STATIC/GLIDEPATH/REGIME_CONDITIONED, default STATIC ⇒ back-compat) resolved
   **at reduce-time** in `RebalanceToTargetReducer.resolveScheduledTarget` — GLIDEPATH
   linearly interpolates `{age, weights}` anchors by the primary's age (`interpolateGlidepath`
   + `ageAsOf`), REGIME_CONDITIONED picks the per-tag mix from `state.activeRegimes`
   (`resolveRegimeTarget`, priority ECONOMIC_STRESS > PANIC_SELL_TRIGGER, NORMAL fallback),
   then the per-account gold-guard renorm + rebalance runs on the resolved target.
   Params `allocationGlidepath` / `allocationRegimeTargets` are `Object` type (like
   `rebalanceTargetAllocation`), both fall back to the static mix when unconfigured.
   Tests: `evt-target-allocation-schedule.test.mjs` (SCHED-1..8). **Verified end-to-end**
   in full 30y sims: GLIDEPATH glides k401 equity 92%→72% as the primary ages 50→58;
   REGIME_CONDITIONED shifts a taxable account to the exact stress mix (20/20/30/30 —
   buying CASH+GOLD sleeves) on `ECONOMIC_STRESS` entry and reverts on exit; no value
   destruction, golden unchanged. Solver-searchability of anchors (vs today's Object
   params) is deferred to Phase 5 (MPC harvest, §7).
4. **Phase 4 — Lever D (location). ✅ DONE (2026-07-16).** Portfolio target → tax-aware
   placement. Shipped a pure **location planner** (`allocation-location.js`
   `planLocatedTargets`) that maps the whole-portfolio target onto per-account
   compositions: bonds → tax-deferred (IRA/401k), equity → Roth/taxable, gold → AU super
   (the only gold-eligible shelter), CASH the filler. Key property: it fills every account
   to **exactly its own total**, so locating needs **no inter-account transfer** — each
   account just rebalances to its assigned composition, preserving the Phase-2 per-account
   value-conservation + CGT correctness while the AGGREGATE (over the lever's accounts) hits
   the target. Gold is capped at the gold-eligible capacity and the excess weight
   redistributed (so a gold target > shelter capacity is honored as far as legal and never
   lands in a US IRA — §OQ4a). A new `allocationLocation` param (**LOCATED default** /
   PER_ACCOUNT escape hatch) + optional `allocationLocationPolicy`; the reducer recomputes
   the plan every period from the current residency, so a US→AU move re-targets **lazily**
   and the drift cadence walks holdings — no move-date forced trade (§OQ4b). Tests
   `evt-target-allocation-location.test.mjs` (LOC-1..8). **Verified end-to-end** on the
   default scenario: IRA→100% bonds, Roth/taxable→100% equity, k401→bond-heavy, **gold
   sheltered in super, never in a US IRA/401k/Roth**; lever-account aggregate = 50/30/10/10
   exactly; LOCATED slightly *beats* PER_ACCOUNT on terminal wealth (tax efficiency); no
   value destruction; golden unchanged.
   - **Note on the residency branch:** the default gold policy is **super-first for both
     residencies** because super is the optimal gold home either way (it shelters bullion
     entirely for AU 60+, and is the only gold-eligible shelter for a US resident). So the
     "optimal home flips at a move" the design imagined is really "AU-taxable becomes
     *acceptable*," not "you must relocate" — gold correctly stays in super across a move,
     giving zero move-date churn for free. The recompute-per-period mechanism supports a
     residency-varying policy if one is ever configured; the US-28%-vs-AU-indexed tax
     difference itself is realized in the CGT path (design 57), not the placement.
5. **Phase 5 — MPC online. ✅ DONE (2026-07-16).** Per-epoch target — the "build the
   optimum mix online over time" goal. Shipped an `ALLOCATION_MIX` entry in
   `COCKPIT_CONTROLS` (`cockpit-controller.js`, auto-surfaced in the cockpit lever
   dropdown): `appliesTo` gates on `allocationStrategy=OPTIMIZED` + `TARGET_ALLOCATION`
   selected; `buildVariables` returns the `allocWeight::*` CONTINUOUS axes (K−1,
   present-class pruned); `describe` renders the synthesized target mix as percentages;
   `actuate` persists the committed weights to scenario params AND re-wires the live
   `RebalanceToTargetReducer.targetAllocation` (via `reducerService.updateReducer`) so
   Advise/Apply/live agree. Runs on plain CEM (no design 46 dependency, per §11.1).
   - **The `_seededSim` shim the plan called for is NOT needed — a design win.** The plan
     assumed a *state-resident* target (like drawdown's per-account `drawdownPriority`,
     which snapshot injection clobbers → needs a re-stamp). But this lever's target is
     held in the **freshly-compiled reducer** (synthesized from the candidate's
     `allocWeight::*` at compile), which snapshot injection does NOT overwrite — so the
     committed mix already bites under the MPC snapshot rollout with zero shim. Proven by
     `scripts/verify-mpc-lever.mjs allocationMix`: **VERDICT PASS** (compile-path AND
     snapshot-path both bite; equity-heavy vs bond-heavy diverge under both). Tests:
     `cockpit-controller.test.mjs` (ALLOCATION_MIX block), `mpc-cockpit-plugin.test.mjs`
     (dropdown), the verifier case.
   - **Harvest (OQ7):** for OPTIMIZED static weights the harvest is trivial — the committed
     `allocWeight::*` *are* flat scenario params (`mergeCandidate` → `committedParams`),
     so a re-run is deterministic with no controller. GLIDEPATH→{age,mix}-anchor /
     REGIME→per-regime-map harvest (baking a schedule back) is future work.
     **→ Now specified in `design/39-mpc-financial-controller.md` §13** (harvest a
     completed MPC run back into the loaded scenario), as one cross-lever mechanism
     rather than an allocation-specific one: §13.6.4 is the GLIDEPATH anchor bake
     (step-faithful pairs, ε-collapse on L1 mix distance, prepended start anchor so
     the clamp doesn't rewrite the realized past, `allocationSchedule=GLIDEPATH` as
     an enabling param); REGIME_CONDITIONED stays deferred there too, pending
     regime-tagged decision records. Implementation lands as design 39 §11 Step 12.
   - **Hysteresis ε (§7):** NOT implemented — no switching-cost/hold-band infrastructure
     exists for any cockpit lever today (the drift band is the implemented static analog).
     Deferred as cross-cutting MPC infra, not lever-specific.

### 11.1 Sequencing & dependencies

**Design 46 does NOT block this design.** Design 46 (MPC performance / structured
online surrogate) is a *rollout-count* optimization that is agnostic to which levers
exist; design 61 *adds* levers (dimensions). The dependency runs the other way — 61 is
a **motivator/stress-test** for 46 (more decision dimensions = the pressure 46 exists to
relieve), not a dependent of it. Concretely:

- **Correctness is never gated by 46.** The simplex scale-degeneracy is solved at the
  *lever* level (the K−1/residual encoding, §4-A / OQ1), so plain **CEM** searches the
  allocation axes cleanly with no surrogate. The native-`Σw=1` QP path in `design/46`
  §6 is an optional refinement *if* the surrogate later drives this lever, not a
  precondition.
- **Phases 1–4 have zero dependency on 46** — they ride the existing CEM /
  pattern-search exactly as the design-58 drawdown levers did.
- **Precedent:** design 58 Lever B already ships an **8-dim continuous online MPC
  lever** (`DRAWDOWN_WEIGHTS`) on plain CEM while design 46 remains uncoded — so a
  multi-dim continuous online control does not need the surrogate to be correct.
- **The only real coupling is Phase-5 *performance* (soft, not correctness).** Adding
  3–4 continuous allocation dims (and their interaction with drawdown weights)
  compounds the per-epoch solve cost 46 targets. That is already partly absorbed by
  wins shipped *independently* of the surrogate — **parallelism** (design 46 §0.5,
  ~3.1×, default-on) and **horizon-windowing** (design 41). Phase 5 leans on those; the
  full surrogate only becomes attractive if *many* levers run online simultaneously.

**Recommendation:** keep them decoupled. Build 61 P1–4 freely; reach for 46 at the
multi-lever online regime, gated by a *measured* solve-time target (46's own §0 open
question), not by 61. **Soft-gate P5 on 46 only** in the specific case where allocation
+ drawdown-weights + Roth/withdrawal levers are all driven online together from the
start (the combined vector may then be too slow on CEM) — and even then it gates only
Phase 5, never P1–4. Two cross-references to carry, not a block: (a) the
`leverGeometry`/simplex seam 46 must honor if 61-P5 runs on the surrogate; (b) 61 as a
dimension-growth entry in 46's cost model.

---

## 12. Open questions (owner review 2026-07-13)

1. ✅ **RESOLVED — encode the simplex intrinsically; algorithm goes in design 46.**
   Not normalize-by-sum over a full box — that is scale-invariant and leaves a flat,
   non-identifiable ray (the design-58 phantom-dim pathology). Search `K−1` free
   weights with a residual/reference sleeve for CEM + the fitted surface; carry
   `Σw=1` + `w≥0` natively in the surrogate QP. **Added as a new "simplex/allocation
   levers" pivot seam in `design/46` §6** (the surrogate-solver algorithm doc, where
   the owner noted the algorithm discussion belongs); this lever is its first
   consumer. See §4-A.

2. ✅ **RESOLVED — CASH is a first-class target, not a residual.** Holding cash
   through a crash is a beneficial, optimizable choice, so the lever can dial CASH up
   deliberately. It layers over the design-58 liquidity floor: effective cash =
   `max(allocationTargetCash, drawdownFloor)`; going to cash above the floor *buys*
   cash (CGT-realizing on taxable legs, so the cost is optimized against the crash
   protection). See §8.

3. ✅ **RESOLVED via prototype — rebalance trigger/frequency.** What is
   *actually possible* given the architecture, and the trade-offs:

   | Trigger | How it'd wire | Pros | Cons / cost |
   |---|---|---|---|
   | **Calendar** (annual / period) | fires on `US_PERIOD_ADVANCE` (today's reducers already do) | simple, predictable, matches real "annual rebalance"; deterministic ⇒ re-runnable | can rebalance into a still-drifting market; a fixed date is arbitrary |
   | **Drift-band** (today's `rebalanceDriftBand`) | compare actual vs target each period, act only past the band | no-trade zone limits tax churn; self-adjusts to volatility | band choice is a hidden lever; in taxable accounts even a triggered trade realizes CGT |
   | **MPC-epoch** (online) | the controller re-decides each epoch, gated by the ε hold-band (§7) | *responds to realized conditions* — the whole point; ε makes the switching cost explicit | only "live" during an MPC run; must be **harvested** (OQ7) to persist |
   | **Regime-edge** (today's PanicSell path) | fire on `ECONOMIC_STRESS` / `PANIC_SELL_TRIGGER` entry | reacts exactly when conditions change | binary; no notion of "how far" to move without a target |

   **What's actually possible now:** the period-advance + drift-band + regime-edge
   triggers *already exist* in `OpportunisticRebalanceReducer` — Phase 1 can reuse
   them verbatim. The MPC-epoch trigger is the new capability (Phase 5) and is where
   "respond to conditions over time" genuinely lives.

   ✅ **RESOLVED via prototype** (`scripts/prototype-rebalance-cadence.mjs`, a
   standalone CRN Monte-Carlo isolating tracking-error vs realized-CGT across
   cadences; grounded on the sim's 15%/20% LTCG). On a \$1M→~\$6M / 40y book:

   | cadence (taxable) | trades | track err | **incremental tax to hold the mix** |
   |---|---|---|---|
   | DRIFT_WIDE (±8pp) | ~9 | 3.0% | **\$125k (cheapest)** |
   | ANNUAL | 40 | 2.4% | \$185k (+\$60k) |
   | DRIFT_TIGHT (±2pp) | ~88 | 1.2% | \$298k (+\$173k) |

   *(tax cost isolated as `sheltered.afterTax − taxable.afterTax` per policy under
   common random numbers, minus the unavoidable buy-&-hold latent; ordering held
   across no-crash, 20% LTCG, and a 15y horizon.)* **Decisions:**
   - **Taxable → wide drift-band, NOT annual.** A wide band beats a fixed annual
     schedule *and* a tight band: annual churns ~40 trades even when barely drifted;
     tight buys 1.8pp of tracking for **\$173k** of extra tax — a bad trade. So taxable
     rebalancing is drift-gated with a **wide** band (the band itself an opt/MPC knob);
     annual-only is *not* adopted.
   - **Sheltered → tight/continuous.** Cadence is ~free, so tight banding buys the
     best risk control (1.2% tracking) at ~no cost.
   - **Online (MPC) → ε-gated per-epoch** (§7 hysteresis), which is the drift-band's
     dynamic twin: only re-trade when the projected gain clears the tax it realizes.
   ⇒ the lever carries **separate bands for taxable vs sheltered**, defaulting wide/tight
   respectively.

   **Sub-question — coordinate with TLH/TGH? Resolved: no; the rebalance lever is
   bracket-aware on its own.** TLH and TGH are **bracket-conditional opposites, not a
   combinable pair**: TGH fires only in low-income years (`projectedIncome < ceiling`,
   `tax-gain-harvest-handler.js`), TLH in high-gain/high-income years, so usually only
   one is even eligible per year. Worse, firing both is self-defeating — TGH's room is
   `ceiling − income − usCapitalGainsYTD`, so TLH-realized losses *inflate* TGH's room,
   making the model harvest losses then refill the 0% bracket with gains the same year
   (a near-wash on basis, pure churn) and **wasting** losses that are worth more saved
   for high-rate years. So the taxable rebalance does **not** depend on separately
   selected TLH/TGH; it carries its **own** bracket-aware realization (realize its
   unavoidable gains up to the 0% ceiling; net its loss-sales against its own gains).
   Unifying the standalone TLH/TGH behaviors into one bracket-conditional strategy is a
   design-29 cleanup, out of scope here.

4. ✅ **RESOLVED — jurisdiction-aware gold location; model the IRA bullion ban;
   re-optimize post-move (lazily).** Gold's tax home is residency-dependent (§4-D):
   **US** taxable gold = 28% collectibles (punitive); **AU** bullion = ordinary
   CPI-indexed CGT (no worse than equity; **super shelters it**). Decisions:
   - ~~**(a) Model the US retirement-account bullion restriction.**~~ **↯ REVERSED
     2026-07-29 — the guard was modelling the wrong instrument. Remove it.**
     > *(superseded)* **(a) Model the US retirement-account bullion restriction.** US
     > IRA/401k/Roth **cannot hold the GOLD sleeve** — the location policy and the
     > establish-new-sleeve buy primitive (§6) must **exclude US tax-advantaged roles as
     > gold targets** (mirror it as an eligibility guard, the allocation twin of the
     > drawdown-eligible role set). AU **super** *can* hold gold (bullion is a permitted
     > SMSF asset), so the guard is US-tax-advantaged-only, not all-tax-advantaged.

     **Why it was wrong.** The restriction that exists in §408(m) is on holding
     *physical bullion and collectibles directly* in an IRA. It does **not** stop a US
     retirement account from holding a **gold ETF** (GLD, IAU and the like), which is
     the ordinary way a retirement portfolio takes a gold position and is freely
     available in every IRA/401k/Roth. This model's `GOLD` sleeve is an abstract
     *exposure*, not a claim about physical custody — and a gold ETF is taxed closely
     enough to bullion (the US collectibles rate applies to gains on these
     grantor-trust ETFs) that one sleeve models both. Guarding the sleeve therefore
     removed a position the owner can genuinely hold, on the strength of a rule about
     a form of ownership the model never represented.

     **Consequences of the reversal:**
     - `roleCanHoldGold` becomes vacuously true; `targetForRole` no longer strips GOLD
       for any role, so a portfolio target is applied unmodified everywhere.
     - The establish-new-sleeve backstop in the apply reducer (§6) is no longer needed.
     - **This is the interesting half — but removing the guard does NOT deliver it on
       its own** (measured 2026-07-29, after the code change landed). The 28%
       collectibles rate makes *sheltering* gold in a US tax-advantaged account the
       tax-efficient location for a US resident — the placement the guard forbade. But
       `DEFAULT_LOCATION_POLICY[GOLD]` is `[SUPER, AU_STOCK, US_STOCK]`: the US
       retirement roles are **absent from the preference list entirely**, so removing the
       guard only promoted them from *excluded* to *unpreferred*. Gold now reaches them
       only via the spillover pass once every preferred home is full. Re-running the
       reference plan after the reversal, gold placement was **unchanged** (2040: \$402k
       AU super, \$455k US brokerage, \$0 in any US retirement account). Making it
       preferred is a separate deliberate change — see §12.2 Q4.
     - Tests asserting *"a gold buy never lands in a US IRA"* (§10) inverted: the new
       assertion is that it **may**, and that the located optimum prefers it while US-
       resident. `targetForRole`'s renormalization path loses its only caller and
       should be checked for whether it still earns its keep.
     - Any saved scenario whose gold was previously excluded from a US retirement
       account will re-locate on the next rebalance under the normal cadence (lazily,
       per (b)) — no migration needed, but results **will** move for gold-holding plans.
   - **(b) Gold location re-optimizes *after* a move, not pinned to the move date.**
     The "right" gold home flips at a US→AU move (US: shelter to dodge 28%; AU: taxable
     is fine, super best), but the relocation is **lazy** — it rides the normal
     rebalance cadence (drift-band / MPC-epoch, OQ3) in the periods *following* the
     move rather than forcing a taxable event exactly on the move date (which could
     realize CGT at a bad moment / straddle the residency cost-base step-up, design 57).
     So post-move the location policy simply *targets* the new optimum and the
     cadence walks holdings there when it's tax-sensible.
   Full policy spec deferred to Lever D (Phase 4); the eligibility guard lands with the
   buy primitive (Phase 2) so a gold buy never lands in a US IRA.

5. ✅ **RESOLVED — coexist; design 61 is independently selectable.** It registers as
   its own `behavioralStrategies` entry, so to study it alone you select it and leave
   `PANIC_SELL` / `OPPORTUNISTIC_REBALANCE` unselected. Deprecating the legacy overlap
   is a later cleanup. See §8.

6. ✅ **RESOLVED via prototype — one shared cross-border scope drives both levers.**
   The allocation scope reuses design-58 Lever A `crossBorderDrawdown`: **GLOBAL** ⇒
   one portfolio mix across US+AU, each class **located in the tax-favored country**;
   **LOCAL_FIRST** ⇒ per-country mixes. `scripts/prototype-crossborder-allocation-scope.mjs`
   (deterministic; illustrative US gold 28% vs AU ~15% CGT) shows the mechanism and
   settles the param-structure question:
   - **GLOBAL's value = cross-border asset-location arbitrage** — hold the *same*
     overall mix but place each class where its gains are taxed least (gold → AU to
     dodge the US 28%, equity backfills the US side). The edge = `Δtax · grown gains
     relocated − f · principal moved`; it **compounds with horizon** (tax saving grows
     on grown gains, FX cost is one-time) and **scales with the tax spread** and the
     asymmetry of the *large* sleeves (equity via AU franking / 50% CGT discount).
   - **It's a real but second-order edge** (~0.5–1.2% of terminal wealth in the runs;
     GLOBAL beats LOCAL for any realistic FX friction — break-even well past 2%). With
     symmetric tax it's exactly zero, so **LOCAL/AUTO is a safe default** and GLOBAL is
     worth enabling specifically when a known cross-jurisdiction asymmetry exists.
   - **The param-structure answer: don't split the scope.** GLOBAL allocation only pays
     off when paired with **GLOBAL drawdown** — an inconsistent pairing (GLOBAL
     allocation + LOCAL_FIRST drawdown) has the drawdown re-sell the located assets and
     **actively undoes** the arbitrage (and eats FX both ways). So a *single*
     cross-border scope should drive both levers (or allocation defaults to mirror
     `crossBorderDrawdown` with an inconsistency warning) — **not** two independently
     settable params. See §8.

7. ✅ **RESOLVED — MPC-first, then harvest to a re-runnable scenario.** Initially
   OPT/MPC only (likely just MPC); learnings bake back into scenario params exactly
   like the SPENDING lever's bands (§7 Harvesting): GLIDEPATH → `{age, mix}` anchors,
   REGIME_CONDITIONED → a per-regime map, both re-runnable deterministically ("as best
   as possible," discretization-limited). A per-account manual override (the
   allocation `CUSTOM`) stays a later power-user add if fine-grained control is
   requested.

---

## 12.1 Defects found in use (2026-07-29)

Surfaced while building the allocation-over-time report (design 82), which charts the
realized mix and so makes sleeve hygiene visible for the first time.

**D1 — ✅ FIXED: liquidated sleeves left an immortal \$0.01 remnant.** Selling a sleeve
to a target weight that rounds sub-cent left a residual that no later rebalance could
ever remove, because three thresholds disagreed:

| where | threshold |
|---|---|
| `_reduceProRata` pruned a holding below | `0.001` |
| the leg builder emits a leg above (`rebalance-to-target-reducer.js`) | `0.01` |
| the apply reducer skips | `delta >= -0.01`, `take <= 0.01` |

Anything in `[0.001, 0.01]` was too large to prune and too small to act on. Measured: a
\$0.01 GOLD sleeve survived **25 consecutive rebalances** against `{EQUITY: 1.0}`. Gross
value stayed conserved throughout, so nothing was lost — but the account kept a phantom
sleeve of a class the policy forbade, which then appears as a permanent band in the
allocation report and a permanent row in the holdings panel.

Fixed by `_sweepDust` in the apply reducer, folding a remnant's market value **and**
cost basis into the largest survivor (carrying only the value would mint a phantom cent
of unrealized gain for a later year to tax). It sweeps only when **both** are ≤ `0.01`:
a lot worth a cent against real basis is a total unrealized *loss*, not dust, and
folding that basis onto another lot would mis-state a later disposal.

> ⚠ **Do not assert account-level basis conservation across a rebalance.** A taxable
> FIFO sell re-bases the lots it consumes and a buy establishes fresh basis at cost, so
> the account total legitimately moves. Basis-neutrality is a property of the *sweep*;
> test it against `_sweepDust` directly.

**D2 — OPEN: the drift band is structurally blind to a zero-target class.**
`needsRebalance` iterates `Object.entries(target)` only, so a class that is **held but
absent from the target** is never drift-checked. "I hold an asset class my policy says
0%" therefore cannot trigger a rebalance *at any size* — it only ever gets corrected as
a side-effect of some *other* class breaching its band. This is the root cause D1 was a
symptom of, and it is why the sweep alone is not a complete answer.

The fix is small in code and large in blast radius: making a zero-target holding
trigger a rebalance changes **when** rebalances fire in every scenario, hence when CGT
is realized, hence results. It also needs a threshold above the dust floor or a pure
remnant would cause perpetual re-rebalancing. Deliberately **not** taken as a drive-by;
see §12.2 Q1.

**D3 — OPEN: pre-existing dust is never cleaned.** `_sweepDust` runs inside an apply,
so it prevents dust being *created* but cannot clean a saved state that already carries
some. Only reachable if D2 is fixed, or by sweeping somewhere that always runs (the
holdings reducers / `_syncBalance`), which is a much more golden-sensitive location.

**D4 — ✅ CLOSED 2026-07-29 by Q3's totality enforcement (authoring, not engine): a baked
SCHEDULE freezes its asset classes.** A partial anchor is now rejected at compile with the
anchor named, so a class added after a bake produces a loud error instead of a silent
liquidation; and the harvest totalizes its own output so it cannot emit one. Original
statement follows.

**D4 — OPEN (authoring, not engine): a baked SCHEDULE freezes its asset classes.** The
MPC glidepath harvest derives its class list per epoch from what the accounts held *at
harvest time* (`cockpit-controller.js` ~L919, via `presentAllocations`). That is correct
and faithful — but it means **any class added to the plan after a bake is silently
targeted at 0% and liquidated on the next rebalance**, with no warning, because a
missing key and a deliberate zero are indistinguishable downstream. Observed exactly
this: gold added to a plan whose 39-anchor glidepath predated it was sold off in year
one. Candidate mitigations: warn when a held class is absent from every anchor; or have
`interpolateGlidepath` treat an absent class as "unconstrained" rather than zero (a
semantic change needing its own decision).

**D5 — OPEN: harvested glidepath CORNERS liquidate a whole asset class and buy it back.**
Filed here 2026-08-05, having been found by design 82's report and referred here by its
§10 without ever landing. Re-measured, and it is **far wider than design 82 described** —
that doc charted it as a one-year gold round trip on a single anchor; it is a recurring
pattern, and it takes other classes with it.

The signature in the realized mix is unmistakable: a class sits at a steady share for
years, drops to **exactly 0.0%** for one to three years, then returns to a normal share.
On the reference plan this happens to **gold and bonds together** in one year, to
**equity** for three consecutive years in late retirement, to bonds again immediately
after, and to gold permanently thereafter — driven entirely by the glidepath, with no
market event involved.

The cause is visible in the glidepath's own anchors: **step-faithful anchor pairs**
(`age: N` and `age: N.99` carrying identical weights) that sit at a **corner of the
simplex** — one class at 1.0 and the rest at 0, or one class at 0 with the rest sharing
the remainder — inside an otherwise smooth ladder. That `.99` pairing is the
representation the MPC glidepath harvest emits to hold a value flat across a step
(design 39 §13), so these are **harvest output, not authored policy**. Nobody chose to
leave the equity market for three years at 76.

Four reasons it is not cosmetic:

- Each corner **realizes CGT on an entire asset class** and buys it straight back — pure
  friction, and design 82's chart renders it as though it were a decision.
- One of them lands on **`moveYear`**, so the disposal straddles the residency cost-base
  step-up (design 57 straddle territory). Which side of the move it falls on decides the
  tax, and nothing is choosing that deliberately.
- **It corrupts a Monte Carlo readout.** Because the glidepath is keyed on AGE, a corner
  fires in *every* path. Design 82 §8.2's `P(EQUITY share = 0 at any year)` readout —
  designed to mean "the plan ran out of equity" — comes back **100% on the reference
  plan**, and the finding it reports is this artefact, not a drawdown. A threshold that
  reads 100% for a structural reason is worse than no threshold.
- It is **exactly D4's failure mode arriving from the other direction**. D4 is "a class
  absent from an anchor is silently zeroed"; this is "a class *explicitly* zeroed by a
  harvest artefact". Q3's totality enforcement closes D4 and is **blind to this**,
  because a corner anchor is perfectly well-formed and sums to 1.

So the mitigation belongs with the harvest's representation, not the rebalancer: a
harvested anchor pair that moves a class from a material share to **exactly zero and back
within a step or two** is far more likely a step artefact than an intent, and is worth
rejecting or flagging at bake time. Owner call — see design 39 §13.13's representation
ladder, which is where this lands. The cost has **not** been sized; the counterfactual is
cheap (re-run with the corners smoothed and diff terminal after-tax net worth) and is the
obvious next step.

**D5 — ✅ MEASURED + PARTLY CLOSED 2026-08-07. The round-trip corners are innocent; the
cost is in the TERMINAL anchor, which D5 never named.** The counterfactual above was run
(`scripts/lab/glidepath-corners.mjs`, deterministic and over 12 stochastic seeds). It
does not support the diagnosis, and it found a larger defect next door.

**1. The round trips are not friction.** Smoothing each one — holding the pre-corner mix
across the zero run — **loses** money on the reference plan: the three-year equity exit
costs **−2.0M** median after-tax net worth (winning on 1 of 12 seeds), the bond/cash exit
and the one-year gold/bond corner **−0.9M** and **−0.7M** (3 of 12). The corners are, if
anything, locally good; the MPC chose them and perturbing them in either direction is
worse.

> ⚠ **The control is the whole finding.** Every arm here is an allocation edit, and
> allocation edits move terminal wealth by millions on their own. Matched edits to
> perfectly ordinary, non-corner rungs of the same ladder land at **−8.8M** and
> **−0.1M** — a band that entirely contains every round-trip result. Without a control
> arm, any corner delta reads as a corner cost when it is really the ordinary
> sensitivity of a 40-year allocation path. The original "pure friction" claim was
> reasoning from the shape of the anchors, not from a measurement.

**2. The terminal anchor is the real defect, and it is the leading-anchor rule missing its
mirror.** `interpolateGlidepath` **clamps above its last anchor** — `age >= last.age`
returns the last anchor's weights (`rebalance-to-target-reducer.js:196`). The harvest's
rule (4) exists precisely because the same clamp applies *below* the first anchor, and
its comment says it plainly: without a leading anchor a re-run "would apply the first MPC
epoch's mix to the entire realized past — silently rewriting years the run never decided."
**There is no trailing counterpart.** So the mix the controller committed for **one**
epoch — against a horizon that ended right there, where de-risking scores as free —
becomes policy for every remaining year of the scenario.

On the reference plan the last epoch committed all-bond. The measured consequence: tax
runs flat at a fraction of a million per year, then **spikes across two years to roughly
forty times that** as the entire equity book is liquidated into a single tax year, and
nominal net worth *falls* while it is paid — immediately before the terminal settle
(design 68) would have priced those same gains anyway. Holding the prior mix instead is
**+2.2M median after-tax, winning 11 of 12 seeds** — the only edit tested that beats
baseline robustly, and in the opposite direction from every control.

**3. What shipped, and what did not.** A bake-time **warning only** (`_zeroedClassWarnings`
in `cockpit-controller.js`, 5 tests in `mpc-harvest.test.mjs`): the terminal case is
reported as a defect naming the classes, the shares and the clamp; round trips are
reported as *information* explicitly labelled "has NOT measured as pure friction", so a
reader sees the shape without being told it is a bug. Neither rewrites the bake — a
corner is a well-formed total mix and the controller really did choose it, so only the
reader knows whether it was intent or a flat objective.

**Still open — the semantic call (owner).** The warning documents the trailing clamp; it
does not fix it. Two candidates, both deliberately not taken as a drive-by:
- **Stop extrapolating** — ages above the last anchor fall back to the static
  `targetAllocation` rather than clamping. Fixes the root cause, but changes behaviour for
  every existing glidepath and every saved scenario (golden-sensitive).
- **Refuse to bake a terminal corner** — carry the prior epoch's mix into the final anchor
  on the grounds that the last epoch is horizon-distorted. Confined to the MPC bake path,
  but silently overrides a committed decision.

**Corrections to the original filing, for the record.** The `moveYear` straddle bullet and
the Monte Carlo bullet still stand — a corner does fire in every path because the
glidepath is keyed on AGE, so design 82 §8.2's `P(EQUITY share = 0)` readout is still
structurally 100% and still needs to exclude scheduled zeroes. But it now reads 100%
because of a *harmless* shape plus one expensive terminal one, not because of a recurring
tax leak. The claim that each corner "realizes CGT on an entire asset class and buys it
straight back — pure friction" is **withdrawn** for the round trips and **upheld, and
worse than described, for the terminal anchor**, where nothing buys it back at all.

## 12.2 Open questions arising (2026-07-29)

1. **Should a zero-target holding trigger a rebalance (D2)?** ⇢ **Reframed 2026-07-29 by
   the owner's totality proposal (Q3), and mostly dissolved by it.** If a target mix is
   required to be **total** — every class present with an explicit weight, summing to 1 —
   then `Object.entries(target)` covers every class and the D2 *blindness* is gone. The
   owner's further point is that a class cannot be zeroed in isolation (something else
   must rise to keep Σ = 1), so the transition always breaches some band and triggers.
   Both are right.

   **What survives (measured, not argued).** Totality removes the blindness but the
   **band still gates**. With a fully-specified target `{EQUITY .6, BOND .4, CASH 0,
   GOLD 0}` and gold at **5%** of a taxable account, `|0.05 − 0| = 0.05` is inside the
   0.10 band and **no rebalance ever fires** — verified over repeated periods. So:
   - the *transition* self-corrects (owner is right);
   - a position that **arrives** at a zero-target class without a target change does
     not. Real sources: in-kind inheritance (design 63), a rollover, or simply the other
     classes being drawn down around it. The reference plan shows exactly this shape —
     gold grew to \$1.85M and was removed by *drawdown*, never by rebalancing.

   So the residual question is much smaller than D2 was: **should a zero target carry a
   zero (or tighter) band?** Options: (a) exact — `tgt === 0 && actual > dust` triggers;
   (b) a small absolute floor (say 0.5% of the account) well above the dust threshold;
   (c) accept it — `0 ± band` means "approximately none" and the allocation report
   surfaces the residue. Note (a) fights §OQ3's finding that wide bands beat tight ones
   by ~\$173k of avoided CGT, so forcing a sale of a 5% sleeve purely because its target
   is 0 may be precisely the bad trade that prototype warned about. **Leaning (b) or (c).**

   ✅ **RESOLVED 2026-07-29 — (c), accept it; the band is already the configurable knob
   (owner).** Confirmed: the two params the owner named are exactly the mechanism.
   `rebalanceDriftBandTaxable` (default **0.10**, wide) and `rebalanceDriftBandSheltered`
   (default **0.02**, tight) are the `band` in `needsRebalance`, both `opt: true` so the
   optimizer/MC can search them, and both already per-tier. Someone who wants a
   zero-target sleeve cleaned up more aggressively tightens the band; the §OQ3 tax
   trade-off is then theirs to make explicitly. **No code change.**

   One property to be aware of rather than fix: the band is **symmetric and absolute**,
   so it cannot be tightened for zero-target classes *alone* — tightening it to catch a 5%
   gold residue also tightens EQUITY and BOND, increasing churn and realized CGT across
   the board. If independent control is ever wanted, that is option (b) (a separate
   zero-target floor), and it can be added without disturbing this decision.
2. ✅ **RESOLVED 2026-07-29 — remove `targetForRole` (owner).** Done: the function is
   deleted, `roleCanHoldGold` is now total (retained as a named seam), the apply
   reducer's establish-sleeve backstop is gone, and the `PER_ACCOUNT` branch uses the
   scheduled target directly. Tests inverted (RC-5, LOC-4, LOC-5); suite green at 4185.

3. **Enforce that a target mix is TOTAL (owner's proposal) — recommended, with two
   caveats.** Absent-means-zero is what silently liquidated gold (D4). Requiring every
   class explicitly, summing to 1, and **failing loudly at load/compile** rather than
   normalizing, matches this codebase's ethos (cf. `Holding`'s constructor rejecting an
   unknown allocation) and would have caught D4 at authoring time. Caveats:
   - **It relocates D4 rather than deleting it.** A pre-existing 3-key bake becomes
     *invalid* the moment GOLD exists in the plan. That is better (explicit, early,
     loud) but somebody must still author the missing weight; backfilling with 0 is the
     silent liquidation wearing a hat.
   - **`_normalize` currently hides authoring errors.** Verified on the owner's own
     hand-authored anchors: `{EQUITY .75, BOND .25, CASH 0, GOLD .25}` sums to **1.25**
     and is silently rescaled to `{EQUITY .6, BOND .2, CASH 0, GOLD .2}` — 75% equity
     authored, 60% run. Totality enforcement should therefore also reject Σ ≠ 1 (within
     epsilon) instead of rescaling, or the constraint buys much less than it looks.
   - Enforcement must sit at **every** target producer: glidepath anchors, regime maps,
     stick-breaking from `allocWeight::*`, and the LOCATED per-account composition.

   ✅ **RESOLVED + IMPLEMENTED 2026-07-29 — enforce totality; breaking existing configs is
   acceptable (owner: only one in use, will be fixed by hand). The MPC tooling must not be
   able to emit an invalid glidepath — that is part of the deliverable, not a follow-up.**

   **Shipped:** `totalizeMix` / `isTotalMix` / `assertTotalMix` in `holdings/allocation.js`;
   `assertAuthoredMixes` in the rebalance reducer, called from the behavioral registry at
   compile; `synthesizeTargetAllocation` and `_fractionsOf` now totalize their derived
   output. 17 tests in `allocation-mix-totality.test.mjs` plus ALLOC-7b/c/d. It caught the
   live scenario immediately and by name:

   ```text
   allocationGlidepath[0] (age 47): weights must sum to 1, got 1.250000.
   They are NOT rescaled for you …  Got: {"EQUITY":0.75,"BOND":0.25,"CASH":0,"GOLD":0.25}
   ```

   **Spec.**
   1. **Validate, do not normalize.** A target mix is valid iff it carries an explicit
      weight for **every** `ALLOCATION` value and `|Σw − 1| ≤ ε`. Reject otherwise, at
      load/compile, naming the offending anchor and the actual sum. `_normalize`'s
      silent rescale is removed from the authoring path (it may stay as an internal
      guard *after* validation, where it is a no-op).
   2. **The MPC harvest must emit total mixes.** This is the load-bearing part.
      `cockpit-controller.js` builds anchors from
      `synthesizeTargetAllocation(candidate, present)`, where `present` is the classes
      the accounts actually held at that epoch — so harvested anchors are **partial by
      construction** and would every one of them be invalid under (1). The fix keeps the
      search dimensionality but totalises the *output*: continue to search only over
      present classes (searching a class the plan does not hold is a wasted dimension),
      then **backfill every absent `ALLOCATION` with an explicit `0`** before writing the
      anchor. A harvested plan is then always re-runnable and always valid.
      ⚠ Note the semantic this locks in: a harvested `0` genuinely means "the epoch
      decided none", which is correct *for that harvest* — it is the D4 hazard only when
      a class is added to the plan **later**, which (1) now catches loudly at load.
   3. **Same treatment for the other producers:** `allocationRegimeTargets` maps and the
      `allocWeight::*` stick-breaking (which already covers all four classes when
      `presentAllocations` is not narrowing it — narrow it and backfill zeros, as in (2)).
   4. **Migration:** no shim. The one live scenario is fixed by hand; the validator's
      error message is the migration guide.

4. **Should the location policy PREFER a US tax-advantaged account for gold?** New,
   arising from the OQ4(a) reversal. `DEFAULT_LOCATION_POLICY[GOLD]` omits IRA/401k/Roth,
   so post-reversal gold placement is measurably unchanged (§12 OQ4a). For a US resident
   the 28% collectibles rate argues for sheltering gold *ahead of* the taxable brokerage;
   for an AU resident super stays best and taxable is fine. `planLocatedTargets` already
   threads `residency` for this and does not use it. Doing it moves gold placement and
   therefore results, so it wants a deliberate decision — but leaving it undone means the
   reversal is inert in LOCATED mode, which is the default.

   ✅ **RESOLVED 2026-07-29 — yes, and the owner's assumption is correct: no funds ever
   move between accounts.** The word "migrate" in the earlier draft was badly chosen and
   is withdrawn. Verified empirically (two-account LOCATED run, gold preferred into the
   IRA):

   ```text
   BEFORE  iraAccount     balance=500,000  EQUITY=500,000
           usStockAccount balance=500,000  EQUITY=400,000 GOLD=100,000
   AFTER   iraAccount     balance=500,000  EQUITY=400,000 GOLD=100,000
           usStockAccount balance=500,000  EQUITY=500,000
   ```

   **Both balances are unchanged.** Asset location is achieved by **simultaneous
   independent internal swaps**, never a transfer: the IRA sells \$100k of its own equity
   and buys \$100k of its own gold; the brokerage does the reverse. The book-level mix is
   identical (90/10) but gold now sits in the shelter. This is structural, not incidental
   — `RebalanceToTargetApplyReducer` is handed **one `stateKey` per action** and patches
   only that account, and `planLocatedTargets` constrains each account's composition to
   sum to **its own** total (asserted by LOC-1). Neither can move value across an account
   boundary even in principle. Cross-account movement remains exclusively the business of
   rollovers, contributions and `INTL_TRANSFER`.

   So the change is a **preference-list edit only**: `GOLD_PREFERENCE_BY_RESIDENCY` +
   `resolveLocationPolicy(residency, override)`, wired through the `residency` argument
   `planLocatedTargets` already threaded and ignored. A caller's `allocationLocationPolicy`
   override still wins per class (LOC-3c).

   ⚠ **IMPLEMENTED 2026-07-29 — but the ORDERING SPECIFIED ABOVE IS WRONG, and the
   measurement is what says so.** The prescription "shelter gold ahead of taxable because a
   taxable gold sale pays 28%" optimises the wrong quantity. Asset location depends on
   **growth × tax treatment**, not the rate alone: a shelter is a finite resource and should
   hold the asset that benefits most. Gold grows at 5% against equity's 10% in the reference
   plan, so sheltering gold *evicts* a 10% asset and buys a rate saving on a 5% one. Over 44
   years the displaced compounding dominates. Measured, terminal net worth, all else equal:

   | gold preference order | terminal NW | vs best |
   |---|---|---|
   | `IRA, K401, US_STOCK, AU_STOCK, SUPER, ROTH` | **\$30.45m** | best |
   | `US_STOCK, AU_STOCK, SUPER, IRA, K401, ROTH` | \$28.42m | −\$2.03m |
   | `SUPER, AU_STOCK, US_STOCK` (pre-Q4) | \$28.21m | −\$2.24m |
   | `IRA, K401, ROTH, SUPER, …` (**as specified above**) | \$25.20m | −\$5.25m |

   The two rules that fall out, and that the shipped lists follow:
   1. **Tax-DEFERRED first (IRA/401k).** Deferred growth converts to *ordinary income* on
      withdrawal — the worst treatment for a high-growth asset — so a deferred account is
      exactly where a low-growth, badly-taxed sleeve belongs. This is the same logic that
      already heads BOND's list with IRA/K401; gold is bonds-like here, so its policy now
      mirrors bonds'.
   2. **Roth LAST, always.** The Roth is the most valuable shelter (tax-free forever) and
      must hold the highest-growth asset. Ranking it third is most of that −\$5.25m.

   Shipped: US `[IRA, K401, US_STOCK, AU_STOCK, SUPER, ROTH]`, AU `[SUPER, IRA, K401,
   AU_STOCK, US_STOCK, ROTH]`. Net effect on the reference plan vs pre-Q4: **+\$1.93m
   terminal (+6.9%)**, and the residency flip is visible in the cube — 2027 (US resident)
   gold sits in the Traditional IRAs and Roths; by 2035 (post-2031 move) it has been walked
   to AU super, lazily via the drift band rather than forced on the move date (§OQ4b).

   **Still soft:** the AU arm is far less measured than the US arm — the reference plan
   starts US and moves in 2031, so US years dominate the terminal figure. Re-measure with an
   AU-resident-from-start plan before treating the AU ordering as settled.

   Caveat that stands: a *taxable* account selling gold to hand the exposure to a shelter
   realizes 28% **now** to save later, so it only pays over a long enough remaining horizon.
   The drift band (Q1) is doing real work throttling that.
---

## 13. Relationship to design 58

Design 58 and 61 are the two halves of "control the holdings over time":

| Aspect | Design 58 (drawdown) | Design 61 (allocation) |
|---|---|---|
| **Question** | Which account to *sell* to fund spending | What mix to *hold*, and rebalance into |
| **Decision unit** | role-level order (weights, sorted) | portfolio-level mix (weights, normalized) + role-level location |
| **Primitive** | sell (FIFO consume) in priority order | buy **and** sell to a target simplex |
| **Search encoding** | `drawdownWeight::<role>` continuous | `allocWeight::<ALLOCATION>` continuous |
| **Online** | re-decide order per epoch (§11) | re-decide mix per epoch (§7), with CGT-aware hysteresis |

They **compose**: a future allocation-aware drawdown (§8 synergy) would let one sale
both fund spending and correct the mix — the natural unification once both lands.
