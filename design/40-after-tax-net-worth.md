# 40 — After-Tax Re-pricing (pricing the embedded deferred-tax liability)

**Status**: Phases 1 & 3 implemented + browser-verified (2026-06-28); decisions locked (§7 D1, D2). Phase 2 (AU super concessional, §408A recapture, primary-residence exclusion) deferred.
**Related**: `design/39-mpc-financial-controller.md` (§12 the Roth flagship — this is the objective that makes the lever visible), `design/38-optimization-solver-framework.md` (§5 objective registry + `_readResult`), `src/finance/derived-metrics/net-worth.js` / `net-liquidity.js` (the sibling metrics this extends), `src/finance/tax/` (the rate source).

> **One-line problem.** `computeNetWorth` and `computeNetLiquidity` treat $1 of a pre-tax Traditional IRA / 401(k) as equal to $1 of a Roth. It isn't — withdrawing the pre-tax dollar triggers ordinary-income tax. Because the headline wealth objectives (`MAX_NET_WORTH`, the `DIE_WITH_TARGET` family) are blind to that embedded liability, **a Roth conversion looks like a pure loss (the tax paid) or pure noise**, and the MPC Roth lever has no gradient to climb. This design adds **after-tax** re-pricing as a *modifier orthogonal to the worth/liquidity scope*, plus the objectives that consume it, so the conversion lever's intertemporal value becomes a quantity the optimizer can actually see — without abandoning **net liquidity** as the lever-reachable anchor.

> **Two orthogonal axes (the load-bearing decision).** "After-tax" is **not** a third anchor. The terminal measure has two independent choices: the **scope** (Net Worth = everything, vs Net Liquidity = the lever-reachable pool, excluding illiquid house equity / age-locked super / `drawdownPriority=null`) and the **tax basis** (Nominal = balances at par, today's behavior, vs After-tax = discounted by the embedded liability). They compose to a **2×2**: `{Worth, Liquidity} × {Nominal, After-tax}`. Net liquidity stays first-class because the controller **cannot actuate illiquid assets today** — a "die with $X" target on net *worth* chases wealth the levers can't reach (a trap we hit before), so the liquid scope is the honest target. After-tax pricing is the orthogonal correction *within* whichever scope. The recommended default for the Roth lever is **after-tax Net Liquidity** when targeting, **after-tax Net Worth / `MIN_LIFETIME_TAXES`** when maximizing (§2.0, §7 Q2). *Forward note:* if the controller ever gains the ability to **liquidate illiquid assets** (sell the house — a future lever), the worth↔liquidity gap narrows and net worth becomes reachable; the 2×2 already anticipates that day.

---

## 1. Motivation — why the Roth lever is invisible today

Grounded against the live `wip/mpc-financial-controller` branch (2026-06-28), reproduced in the cockpit:

- The cockpit Roth lever, on **Die With Target → Consumption → Net Liquidity**, recommends the **maximum** income-fill target every epoch, and every MPC Save Point reports an **identical** terminal (`$3,990,703`). The objective is **flat** with respect to the lever.
- Three independent reasons, all real:
  1. **Terminal net *liquidity* floors at $0** in every plan (spending drains the liquid pool by death; Roth and IRA are both liquid), so `λ·|0 − target|` is constant.
  2. **Consumption** is set by the spending bands, which the Roth lever never touches — constant.
  3. **Nominal net *worth*** is conversion-neutral except for the tax paid: a conversion moves IRA→Roth at par and `computeNetWorth` sums balances at par, so converting only *subtracts the tax* — `MAX_NET_WORTH` and `DIE_WITH_TARGET` (worth terminal) would therefore say **convert nothing**, the opposite degeneracy.

The honest fix is not a different solver or a different running term — it is to **value a pre-tax dollar at its after-tax worth**. Then a conversion in a low-bracket year converts a heavily-discounted pre-tax dollar into a full-value Roth dollar, *raising* after-tax net worth even as nominal net worth falls by the tax paid; and over-converting (pay 32% now to dodge a future 12% withdrawal) *lowers* it. The "always max" / "always zero" degeneracies both collapse into a genuine interior optimum.

**Relationship to `MIN_LIFETIME_TAXES`.** They are complementary, not redundant. Lifetime taxes is a **flow** (Σ taxes paid along the path); an after-tax terminal is a **stock** (terminal wealth net of embedded liability). For a bequest / "die with target" goal the *stock* is the correct anchor — it captures tax-free Roth growth and avoided future RMD tax, which a pure flow misses, and it composes with the existing `DIE_WITH_TARGET` family as a drop-in tax-basis modifier on either scope.

**Why not net worth alone (the reachability trap).** Net *worth* over-counts assets the controller cannot actuate — house equity, age-locked super, anything with `drawdownPriority=null`. A "die with target" objective anchored on net worth therefore asks the optimizer to hit a number it can only partially move, so the target binds on phantom wealth and the levers chase it badly (we hit exactly this before). Net **liquidity** — the lever-reachable pool (`computeNetLiquidity`, `net-liquidity.js:65`) — is the honest target scope. After-tax pricing is a **separate** correction: even within the liquid pool a pre-tax IRA dollar is worth less than a Roth dollar, and *that* par-value error is what blinds the Roth lever. So we want both fixes, kept independent — hence the 2×2.

**Robust to where the pre-tax money sits (the user's real structure).** The valuation keys off **tax class, not account identity**. So a scheduled 401(k)→IRA rollover — pre-tax dollars migrating between buckets over the horizon — changes *nothing* about the metric: the pile is discounted identically in either bucket, and only a Roth conversion removes the discount. This is precisely why the lever can be demonstrated on the **real** scenario (small IRA now, future rollover) without seeding a fake balance: the embedded liability lives across the whole pre-tax pile and across the whole horizon, which the full-life MPC rollout already traverses.

---

## 2. The valuation model

After-tax re-pricing values each balance-bearing state entry net of an estimated **liquidation tax** on its remaining untaxed gain, then sums in base currency exactly as the existing metrics do (same FX path, same real-property/collectible handling).

### 2.0 The four terminal measures (scope × tax-basis)

The same per-entry after-tax value feeds **both** scopes — the only difference is which entries each scope includes (worth = all; liquid = `drawdownPriority != null` and age-accessible, per `computeNetLiquidity`). So one re-pricing function, parameterized by scope, yields the 2×2:

| | **Nominal** (at par) | **After-tax** (discounted) |
|---|---|---|
| **Worth** (all assets) | `finalNetWorthUsd` *(exists)* | `finalAfterTaxNetWorth` *(new)* |
| **Liquidity** (lever-reachable) | `finalNetLiquidity` *(exists)* | `finalAfterTaxNetLiquidity` *(new, the default)* |

- **After-tax Net Liquidity** is the flagship: lever-reachable **and** honest about the embedded tax. It is the right "die with $X spendable for my heirs" anchor.
- **After-tax Net Worth** stays available for a true bequest view (and for *maximize* objectives, which don't have the targeting-trap — §7 Q2).
- Both nominal measures remain unchanged and backward-compatible.

Implementation: a single `computeAfterTaxValue(account, state, date, rateProvider)` per-entry helper, summed under a `scope` predicate shared with `computeNetWorth` / `computeNetLiquidity` (§4). No duplication between the two after-tax measures.

> **Caveat the Roth lever forces (be honest).** For the *Roth* lever with fixed spending, the *terminal liquidity* anchor (nominal **or** after-tax) is weak: the liquid pool is drained/targeted to roughly the same place by death regardless of conversion, so the conversion signal mostly lands in **after-tax Net Worth** (the tax-advantaged Roth + discounted pre-tax remainder) and in **`MIN_LIFETIME_TAXES`** (the flow). After-tax liquidity earns its keep for the **spending** lever and the **joint** spending+conversion solve (where the lever actually moves terminal liquidity). So the recommended Roth-lever default is *maximize* after-tax Net Worth or minimize lifetime taxes; die-with-target stays on the liquid scope for the reachability reason. The 2×2 lets the user pick the right pairing per lever (§7 Q2).

### 2.1 Tax-class taxonomy

Every account maps to a **tax class** that fixes its discount formula. The mapping is by `role` (`src/finance/state/account-roles.js`) with a residency-aware override for super:

| Tax class | Roles | After-tax value |
|---|---|---|
| `PRE_TAX` (ordinary on withdrawal) | `ira`, `k401` | `balance · (1 − r_ord)` |
| `ROTH` (qualified, tax-free) | `roth-ira` | `balance` (less any in-flight §408A 5-year recapture, §2.4) |
| `TAXABLE_BASIS` (gains taxed on sale) | `us-stock`, `fixed-income`, `au-stock`, `au-fixed-income` | `balance − r_cg · unrealizedGain` |
| `CASH` (already taxed) | `us-savings`, `au-savings` | `balance` |
| `SUPER` (jurisdiction-specific) | `super` | residency-dependent (§2.3) |
| `ILLIQUID` (real property / collectible) | `kind:'real-property'`/`'collectible'` | equity less cap-gains-on-sale net of primary-residence exclusion (§2.4) |

`r_ord` = the assumed marginal ordinary rate applied to a pre-tax withdrawal; `r_cg` = the long-term capital-gains rate; both **sourced per §3** and **per residency per §2.3**.

### 2.2 Why the unrealized-gain split matters for `TAXABLE_BASIS`

A brokerage dollar is part return-of-basis (already taxed) and part unrealized gain (taxed on sale). Discounting the **whole balance** would double-count. The metric needs the cost basis: `unrealizedGain = balance − costBasis`. The investment accounts already carry per-lot holdings with cost basis (the §4.4 holdings invariant); the metric sums lot gains, or — if a closed-form basis is unavailable on a given entry — falls back to a configurable `assumedGainFraction` (default e.g. 0.5) so the metric degrades gracefully rather than throwing. **Decision Q3.**

### 2.3 Cross-border residency (the lever's whole point)

This is a US→AU scenario; the after-tax value of a pre-tax dollar **depends on the residency at the valuation date**:

- **US-resident**: pre-tax (IRA/401k) → US ordinary rate; Roth → tax-free; brokerage → US LTCG.
- **AU-resident**: under the treaty the US still taxes IRA/401k *distributions* as ordinary income, AU taxes traditional-**super** withdrawals on its own (concessional) schedule, and Roth *earnings* distributions become AU-taxable. So `SUPER` and the pre-tax classes pick different rates once `getResidency(state, personKey)` (`src/finance/residency-utils.js:25`) returns `AU`.

The optimal-conversion intuition — *convert while US-resident, in low-income pre-RMD years, before the move* — falls directly out of the metric once it is residency-aware: a pre-tax dollar carries a different discount on either side of the move, so converting on the cheap side raises after-tax worth. The metric reads residency from state at the valuation `date`; **it does not re-derive the move** (that's the plant's job).

### 2.4 Edge terms (specified, phaseable)

- **§408A 5-year recapture** on recently-converted Roth lots — the conversion classes already track dated conversion lots (`roth-conversion-classes.js`); the metric can subtract the recapture on still-seasoning lots. *Phase 2 — start by treating Roth as fully tax-free.*
- **Primary-residence cap-gains exclusion** on real property — reuse the real-property module's sale handling. *Phase 2 — start with equity at par (matches today's `computeNetWorth`).*

---

## 3. Rate sourcing — the one real decision

`r_ord` / `r_cg` must come from somewhere. Three options, increasing fidelity and cost:

| Option | `r_ord` is… | Pros | Cons |
|---|---|---|---|
| **A. Configured effective rate** (params `afterTaxOrdinaryRate`, `afterTaxCapGainsRate`, per cc) | a single assumed bequest/heir rate | trivial, transparent, advisor-legible, zero coupling | ignores bracket-stacking; user must guess |
| **B. Marginal-rate-at-valuation** | the bracket the final year's income lands in, read from the live rate table (`_brackets_mfj`, `_ltcg_mfj` in `us-tax-rates-2025.js`) | reflects the realized situation; no new param | marginal ≠ effective for a full liquidation; jumps at bracket edges |
| **C. Liquidation waterfall** | the *effective* rate from stacking the entire pre-tax balance through the per-year tax module (`TaxEngine.get(cc, year)`), on top of that year's other ordinary income | most honest; same engine the sim already trusts | most compute; needs a pure "tax on hypothetical income" entry point the modules don't cleanly expose yet |

**Option C is the destination — A is a bootstrap, not a competitor.** Option C (run the actual pre-tax balance through the same per-year tax engine the sim already trusts, stacked on that year's other ordinary income) is the only one that *is* the real-world calculation; A and B are approximations that exist so the metric can ship and be tested before C's engine seam is built. The architecture is therefore designed **C-first**: the `rateProvider` contract is shaped to what C needs, and A/B are degenerate implementations of that same contract — not a different code path C has to retrofit later.

**The `rateProvider` contract (C-shaped from day one):**

```
rateProvider = {
  // Effective rate to liquidate `amount` of pre-tax balance for `account`,
  // given the rest of that year's realized ordinary income — i.e. the engine
  // stacks `amount` on top of `baseOrdinaryIncome` through the cc/year module.
  ordinaryLiquidationRate(account, amount, state, date),   // C: waterfall · B: marginal-at-edge · A: const
  capGainsLiquidationRate(account, unrealizedGain, state, date),
}
```

- **A** ignores `amount`/`state` and returns the configured constant.
- **B** reads the bracket the final-year income lands in from the live rate table (`_brackets_mfj`, `_ltcg_mfj`).
- **C** delegates to a new **`BaseTaxModule.taxOnHypotheticalOrdinaryIncome(incremental, baseIncome, cc, year)`** (`TaxEngine.get(cc, year)`), returning `tax/incremental` as the effective rate. That helper is the substantive work of C and is independently useful (any "what-if marginal" consumer wants it). Because the contract already passes `amount`+`state`, **landing C is swapping the provider, not reworking the metric.**

**Decided (D1, §7): build the C-shaped `rateProvider` contract now; ship A as the default implementation to unblock Phase 1; C is the committed target (Phase 3), not an optional polish.** B is optional and may be skipped entirely if C lands — it exists only as a cheaper stepping stone.

> Note: B/C make the metric **path/seed-stable but bracket-reactive** — desirable for MPC (the lever *should* respond to realized income). They couple the terminal metric to the tax engine, which is acceptable since `cumulativeTaxesPaid` already does. The full-liquidation stacking C does is exactly the cross-border, bracket-aware calculation that makes the conversion timing decision real.

---

## 4. Code surface

Small, mirrors the two existing derived metrics. The after-tax re-pricing is **one** per-entry function; the two scopes reuse it under the existing include-predicates.

1. **`src/finance/derived-metrics/after-tax.js`** — new sibling of `net-worth.js` / `net-liquidity.js`:
   - `computeAfterTaxValue(account, state, date, rateProvider)` — the per-entry after-tax value, dispatching `taxClassForRole(role)` → the per-class formula. The shared core.
   - `computeAfterTaxNetWorth(state, date, opts)` — sum `computeAfterTaxValue` over **all** balance-bearing entries (the `computeNetWorth` scope, incl. real property / collectibles).
   - `computeAfterTaxNetLiquidity(state, date, opts)` — sum `computeAfterTaxValue` over the **lever-reachable** entries only, reusing `net-liquidity.js`'s `drawdownPriority != null` + `isAccessible(...)` predicate (export/share it so the scope rule lives in exactly one place — do **not** re-implement the age-gate).
   - `deriveAfterTaxNetWorth` / `deriveAfterTaxNetLiquidity` — `state.metrics.*` writers (registry passes `date` 2nd, like `deriveNetLiquidity`).
   - `TAX_CLASS`, `taxClassForRole(role, { residency })`, `defaultRateProvider`.
2. **`optimization-problem.js` `_readResult`** (`:333`) — add `finalAfterTaxNetWorth` **and** `finalAfterTaxNetLiquidity` alongside `finalNetWorthUsd` / `finalNetLiquidity`. Surface `afterTaxOrdinaryRate` / `afterTaxCapGainsRate` / `assumedGainFraction` reads like the other `terminalWealth*` params.
3. **`optimization-objectives.js`** — the `DIE_WITH_TARGET` family is generated by `makeDieWithTarget` over `running × terminal`, so the cleanest move is to make `terminal` a **(scope, basis)** pair rather than a flat key:
   - Extend `_TERMINAL_MEASURES` to the 2×2: `worth`/`liquid` (existing) + `afterTaxWorth` (`finalAfterTaxNetWorth`) + `afterTaxLiquid` (`finalAfterTaxNetLiquidity`). The family generates all variants for free with backward-compatible keys (existing `worth`/`liquid` keys unchanged).
   - Add standalone `MAX_AFTER_TAX_NET_WORTH` and `MAX_AFTER_TAX_NET_LIQUIDITY` (siblings of `MAX_NET_WORTH` / `MAX_NET_LIQUIDITY`) — the *maximize* form for the Roth lever (no targeting-trap).
4. **`state-schema-registry.js`** — register `afterTaxNetWorth` / `afterTaxNetLiquidity` (+ `metrics.*`) as `currency('USD')` (sibling of the `cumulativeTaxesPaid` registration at `:153`).
5. **UI** — the cockpit + OPT panel already group the family via `groupedObjectiveOptions()` and render the terminal axis from `DIE_WITH_TARGET_AXES.terminal`. Render the terminal anchor as **two** sub-selects — **Scope** (Net Worth / Net Liquidity) and **Tax basis** (Nominal / After-tax) — resolving to the concrete `terminal` key (mirrors how the existing running/terminal selects resolve). Add the new `MAX_AFTER_TAX_*` goals to the cockpit's curated list.
6. **Params** (toolset `paramSchema`) — `afterTaxOrdinaryRate` (default e.g. 0.22), `afterTaxCapGainsRate` (default 0.15), `assumedGainFraction` (default 0.5), `afterTaxOrdinaryRateAu` / super treatment. Real base-year, residency-keyed.

No new reducers, events, or simulation primitives. The metrics are pure reads of final state; the objectives are pure functions of `result`.

---

## 5. Why this fixes the reported scenario

- **The lever gains a gradient.** With an after-tax terminal anchor (worth when maximizing; liquidity when targeting — §2.0/§7 Q2), converting a pre-tax dollar at rate `r_now < r_future_withdrawal` *raises* after-tax value (Roth dollar at par vs the discounted IRA dollar), and converting at `r_now > r_future` *lowers* it. The flat `$3,990,703`-everywhere landscape becomes concave with an interior optimum — the income-fill target the lever was meant to find.
- **No fake IRA needed.** Because the metric prices the **whole pre-tax pile** (401k + IRA) across the **whole horizon**, the value is present even when today's IRA is $0: the scheduled 401(k)→IRA rollover and future contributions carry the discount, and the receding-horizon loop reaches those years as "now" advances. The lever is demonstrable on the real scenario.
- **Cross-border timing emerges, not imposed.** Residency-aware rates make pre-move US-resident years the cheap conversion window automatically (§2.3).
- **Orthogonal to the window/schedule disconnect** (design 39 Step 10) — that's a separate actuation-consistency bug; this design is purely about the *objective* seeing value. They can be fixed independently.

### 5.1 Terminal-stock × spend-down interaction (found in Phase-1 browser verification)

**The fix works only while the pre-tax pile survives to the scoring terminal.** A terminal *stock* re-prices the balances that exist at the terminal; if a plan **spends the entire pre-tax pile down by the scoring date**, there is no embedded liability left to price and **after-tax terminal worth ≡ nominal terminal worth** — flat for the Roth lever again. Verified both ways (2026-06-28):

- *Solvent / moderate-spend, full life (to 2072):* a $300k conversion **raises** after-tax NW by **≈ $1.19M** (pre-tax survives; the gradient is real and large).
- *The reported live scenario (`u:2`):* ~$19.7k/mo spend drains the pre-tax pile and the plan is **insolvent from ~2037** (OUT_OF_FUNDS), so terminal after-tax NW **equals** nominal NW and every non-degenerate goal correctly returns *"no conversion at 2026"* (high current wage ⇒ converting stacks into high brackets — defensible, and crucially **not** the old "always max").

**Consequence for the lever↔objective pairing (revises D2):** over a full-life **spend-down** horizon the Roth lever's value is a **flow** — it surfaces in **`MIN_LIFETIME_TAXES`** (convert in low-bracket years to cut lifetime tax), *not* in a terminal stock. After-tax terminal **worth** is the right anchor for a **bequest** plan (pre-tax deliberately survives) or a **windowed** MPC horizon (the receding window's terminal is before death, so pre-tax survives within it). So: default the Roth lever to **`MIN_LIFETIME_TAXES`** for spend-down plans; offer after-tax worth for bequest/windowed framings. *(This also argues for a **windowed** Roth-lever horizon — design 39 §10 Q1 — so the terminal-stock objectives bite; tracked as a follow-up.)*

The after-tax metric is still correct and necessary — it removes the **par-value error** that made nominal worth say "convert nothing" — but it is **not, by itself, sufficient** to make the Roth lever non-degenerate on a full-life spend-down plan. The honest Phase-1 outcome: the *flat-objective* degeneracy (DIE_WITH_TARGET_LIQUID → "always max") is fixed and all objectives now give differentiated, defensible answers; making the lever recommend a *positive interior* conversion additionally needs either the lifetime-tax flow objective or a windowed horizon.

---

## 6. Testing sketch

- `after-tax.test.mjs` — class taxonomy (pre-tax discounted, Roth at par, cash at par, brokerage discounts only the gain); FX normalization; residency switches the super/pre-tax rate; `assumedGainFraction` fallback when basis is absent; the `rateProvider` contract (A default returns the const; an injected stub proves the seam; the contract passes `amount`+`state` so C is a drop-in).
- `objectives.test.mjs` (+) — the 2×2 (scope × basis) family generates all four terminal variants with correct `variant.terminal`; `MAX_AFTER_TAX_NET_WORTH` rewards a converted plan over an unconverted one of equal nominal worth; the **after-tax liquidity** measure reuses the exact `net-liquidity` include-predicate (an account excluded from net liquidity is excluded from after-tax liquidity); grouping/axis helpers include the new scope/basis sub-axes.
- **End-to-end (the real test of the fix) — implemented, gate revised.** *Original plan:* sweep the income-fill target and assert `finalAfterTaxNetWorth` is **concave** with an interior max. *What a real IntlRetirement rollout actually shows (`tests/unit/after-tax.test.mjs`):* over a long horizon at the scenario's growth rate, after-tax worth rises **monotonically** with conversion — tax-free Roth compounding dominates, so the after-tax-optimal conversion is aggressive (a *defensible* answer, not the old degeneracy). So a fragile "interior peak" assertion is the wrong gate. The **deterministic gate that actually proves the fix** is the *mechanism*: (1) conversion **lowers nominal net worth** (the old `MAX_NET_WORTH` "convert nothing" degeneracy) but **raises after-tax net worth** (a gradient toward conversion); (2) the **embedded-liability rate controls the sign** — with `afterTaxOrdinaryRate=0` (pre-tax priced at par) conversion is *not* rewarded (Δ<0); with 0.22 it is (Δ>0); and the reward grows monotonically with the assumed liability (Δ₄₀ > Δ₂₂ > Δ₀). That sign-control is the un-fakeable proof the metric prices the deferred-tax liability, and it directly refutes the flat-objective bug. *(Whether the optimum is interior or at the boundary is parameter-dependent — short horizon / low growth / high assumed withdrawal rate move it inward; that's a property of the scenario, not a correctness condition.)*

---

## 7. Decisions & open questions

### Locked decisions

- **D1 — Rate source (was Q1). DECIDED.** Build the **C-shaped `rateProvider` contract** in Phase 1 (passes `account`, `amount`, `state`, `date`). Ship **Option A** (configured effective rate) as its default implementation to unblock Phase 1 and the tests. **Option C (liquidation waterfall) is committed as Phase 3** — it is the only real-world-faithful calculation (§3), and it drops into the same seam with no metric/objective changes. **Option B is a skippable stepping stone** (use it only if C slips). A and B are degenerate implementations of the C contract, never a separate path.
- **D2 — Default goal / scope per lever (was Q2). REVISED after Phase-1 browser verification (§5.1).** Scope is lever-dependent, and so is *flow-vs-stock*:
  - The **Roth** lever defaults to **`MIN_LIFETIME_TAXES`** — over a full-life **spend-down** plan the conversion's value is a *flow* (the pre-tax pile is gone by death, so terminal stocks are flat for it; §5.1). After-tax terminal **worth** (`MAX_AFTER_TAX_NET_WORTH` / the `*_AFTERTAX` die-with-target variants) is offered for **bequest** plans (pre-tax survives) or a **windowed** horizon. *(Originally D2 defaulted to `MAX_AFTER_TAX_NET_WORTH`; browser verification showed that is flat on a full-life spend-down — see §5.1.)*
  - **Die-with-target** stays on the after-tax **liquid** scope — the controller can't actuate illiquid assets, so a worth target binds on unreachable wealth (§2.0/§1).
  - All four terminal measures (scope × basis) + `MIN_LIFETIME_TAXES` remain user-selectable; only the *defaults* are fixed here.
  - *Follow-up:* a **windowed** prediction horizon (**now specified in `design/41-windowed-prediction-horizon.md`**) so terminal-stock objectives bite within the window — `MAX_AFTER_TAX_NET_WORTH` on a window is the alternative to `MIN_LIFETIME_TAXES` for surfacing Roth value; and the cockpit's curated-goal ordering should lead with `MIN_LIFETIME_TAXES` for the Roth lever.

### Open questions

- **Q3 — Brokerage basis.** Use real per-lot holdings basis when present; `assumedGainFraction` fallback otherwise. *Recommended: holdings-first, fraction-fallback.*
- **Q4 — Super treatment.** AU super liquidation tax is concessional and age/preservation-dependent. *Recommended: Phase 1 treats super as `PRE_TAX` at an `afterTaxOrdinaryRateAu`; Phase 2 models the concessional schedule.*
- **Q5 — Edge terms** (§408A recapture, primary-residence exclusion). *Recommended: deferred to Phase 2; Phase 1 treats Roth tax-free and real-property equity at par (≡ today's `computeNetWorth`).*
- **Q6 — House liquidation (future lever).** Today net worth over-counts the house because no control can sell it. A future "sell-the-house" / liquidate-illiquid lever would make worth reachable and collapse the worth↔liquidity gap. *Out of scope here, but the 2×2 and the `drawdownPriority`-keyed scope predicate are built to absorb it without rework.*

---

## 8. Phasing

- **Phase 1 (the fix). [x] IMPLEMENTED.** The shared `computeAfterTaxValue` core + the **2×2** measures (after-tax Worth **and** after-tax Liquidity, the latter reusing `net-liquidity`'s exported `isDrawdownAccessible` predicate) + the tax-class taxonomy (`after-tax.js`); the **C-shaped `rateProvider` contract** with **Option A** as its default; holdings/`assumedGainFraction` basis; `finalAfterTaxNetWorth` / `finalAfterTaxNetLiquidity` in `_readResult`; the four `*_AFTERTAX*` Die-With-Target variants (2×2×2 family) + `MAX_AFTER_TAX_NET_WORTH` / `MAX_AFTER_TAX_NET_LIQUIDITY`; the `scope`/`basis` sub-axes + `resolveTerminalKey`/`terminalAxesFor`; schema registration; `afterTaxOrdinaryRate`/`afterTaxOrdinaryRateAu`/`afterTaxCapGainsRate`/`assumedGainFraction` scenario params; cockpit + OPT-panel two-sub-select UI (Scope · Tax basis) with the Roth-lever default `MAX_AFTER_TAX_NET_WORTH`; and the end-to-end gate (§6, revised). Tests: `after-tax.test.mjs` (+17), `objectives.test.mjs` (+), viz updated. Full suite green (2932 unit, 796 viz). **Browser-verified** (2026-06-28): the new Scope·Tax-basis sub-selects + after-tax goals render and resolve; nominal `MAX_NET_WORTH` recommends *"no conversion"* (the par-value "convert nothing" degeneracy) while the flat `DIE_WITH_TARGET_LIQUID` "always max" degeneracy is gone. **The verification surfaced the §5.1 terminal-stock × spend-down interaction** (after-tax terminal worth is itself flat when the pre-tax pile is spent down by death — true on the reported insolvent `u:2` scenario), which **revised D2** (Roth lever → `MIN_LIFETIME_TAXES`) and is the load-bearing finding of this phase.
- **Phase 2 (fidelity).** Residency-aware rates (Option B as a stepping stone, or skip straight to C), AU super concessional schedule, §408A recapture, primary-residence exclusion.
- **Phase 3 (the real-world calculation). [x] IMPLEMENTED.** `liquidationRateProvider` (`after-tax.js`) — the Option C waterfall. **Revision to the original plan:** rather than a *new* `BaseTaxModule.taxOnHypotheticalOrdinaryIncome(...)`, it reuses the engine that already exists — **`TaxSettleService.computeUsTax(state)`**, the same inflation-adjusted, year-resolved (`state.currentPeriods`/`inflationAccumulator`) computation the sim settles with. The effective rate is the **delta**: `(computeUsTax({…state, usOrdinaryIncomeYTD: ytd+amount}).ordinaryTax − computeUsTax(state).ordinaryTax) / amount`, i.e. the liquidation stacked on the realized income at the valuation date; cap-gains likewise via `capitalGainsTax`. Selected by a new `afterTaxRateMethod` scenario param (`configured` = Option A default · `liquidation` = Option C); drops into the Phase-1 `rateProvider` seam with **no metric/objective change** (D1). **Scope:** US pre-tax (IRA/401k → US ordinary, taxed regardless of residency, §2.3) and US brokerage (LTCG); **AU/super fall back to Option-A** configured rates (AU super is concessionally taxed, not ordinary income — its engine path stays Phase 2, Q4). Any error/non-finite result also falls back, so the metric never throws. *Approximation (documented):* per-account marginal stack on realized income, not a joint multi-account liquidation. Tests: `after-tax.test.mjs` (+6: engine effective rate in bracket-fill range, progressive, LTCG, AU fallback, graceful, end-to-end method-switch). Full suite green (2959 unit, 798 viz). **Browser-verified** (2026-06-28): on the live scenario at an 8-yr window, Option C and Option A both peak at the same conversion (~$100k) but Option C values the terminal pre-tax pile at the real bracket-stacked rate (after-tax liq $1.879M vs the flat-22% $1.850M) — the more accurate pricing.
  - *Remaining follow-ups (tracked):* AU-side engine path (super concessional / AU CGT discount) — Q4/Phase 2; joint-liquidation ordering; and a `BaseTaxModule.taxOnHypotheticalOrdinaryIncome` extraction if another consumer needs it (not needed yet — `TaxSettleService` covers it).
