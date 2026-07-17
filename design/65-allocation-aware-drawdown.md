# 65 — Allocation-aware drawdown: choose *which holding type* to sell for a debit

**Status**: **Phases 1–3 IMPLEMENTED** (2026-07-16, branch `wip/allocation-aware-drawdown`);
Phase 4 (MPC) remains PROPOSED. Scope: make the **within-account
liquidation** of a spending debit **allocation-aware** — choose *which asset class
(sleeve) and which lots* to sell, instead of the current blind FIFO-by-purchase-date.
This is the third leg of the "control the holdings over time" family: **design 58**
decides *which account* to draw, **design 61** decides *what mix to hold*, and **design
65** decides *what to sell out of the chosen account when cash is needed* — closing the
loop so a single sale can both fund spending **and** correct the mix (the design 61 §8
synergy), and so drawdowns realize less tax.

**Companion build plan:** §12 (files, anchors, hooks, tests). Implementation-ready
sketch for a future session.

---

## 1. Motivation

Today, when the plan needs cash it (a) picks an **account** by role priority (design 58)
and then (b) sells that account's holdings **FIFO by purchase date** — completely blind
to *what kind* of holding it is selling. Two problems follow:

1. **Drawdowns fight the allocation lever, doubling the tax.** With design 61 active, a
   mixed-sleeve brokerage holds e.g. EQUITY + BOND + CASH + GOLD. A spending debit
   FIFO-sells the oldest lots — usually appreciated **equity** — which distorts the mix;
   the next scheduled rebalance then sells **again** to restore it. That's **two
   capital-gains events** where one would do. Design 61 §8 already flagged this: *"the
   most tax-efficient rebalance is to fund spending from the over-weight sleeve — let the
   drawdown also correct the mix."*

2. **FIFO is tax-inefficient for realizing gains.** Oldest lots typically carry the
   **lowest basis** (highest unrealized gain), so FIFO realizes the *most* gain per
   dollar raised. A tax-aware selection (min-gain / loss-first, and sell the untaxed CASH
   sleeve before touching equity) realizes materially less CGT for the same cash.

Neither is reachable today because the liquidation primitive
(`consumeHoldingsFifo`) sorts purely by `purchaseDate` and knows nothing about
`allocation`, cost basis dispersion, or the target mix.

---

## 2. What exists today (the foundation)

**Account selection (design 58).** `AccountService.replenishSavings`
(`account-service.js` ~L506) discovers all drawdown sources, sorts them by per-role
`drawdownPriority` (with the design-58 Lever-B weight synthesis / cross-border scope),
and draws them in order / proportionally. A regime-gated **cash-bucket override**
(`drawdown_source_override`, design 29 §3.7, ~L544) reorders *accounts* so
fixed-income/savings **accounts** drain before equity **accounts** under stress — but
it is **account-level**, binary, and not per-sleeve.

**Per-account liquidation.** Two paths, both blind FIFO:
- **Engine path** — `_drawPenaltyFree` (~L991) computes `withdraw` for the chosen
  account and calls `consumeHoldingsFifo(account.holdings, withdraw, auCtx)` (~L1017),
  then emits `STOCK_WITHDRAWAL_TAX` / `COLLECTIBLE_SALE_TAX` from the realized basis.
- **Event path** — `StockWithdrawalApplyReducer` (`us-brokerage-classes.js` L232) and
  `AuStockWithdrawalApplyReducer` (`au-brokerage-classes.js` L176) mirror the same
  `consumeHoldingsFifo` + tax-chain logic for `STOCK_WITHDRAWAL_APPLY` /
  `AU_STOCK_WITHDRAWAL_APPLY`.

**The liquidation primitive.** `consumeHoldingsFifo(holdings, amount, indexation)`
(`holdings/holdings-fifo.js`) sorts `[...holdings]` by ascending `purchaseDate` (L83),
consumes `amount` of market value, and returns `realizedBasis`, the **collectible
(GOLD) split** (`collectibleProceeds`/`collectibleBasis`), per-country stepped-up bases
(design 36/57), the **AU CPI-indexed** basis and the **≥12-month CGT-discount-eligible**
gain slice (design 62 §4). It is the single shared consume path — called by
`account-service.js`, `us-brokerage-classes.js`, `au-brokerage-classes.js`,
`inheritance-classes.js`, `residency-cost-base-policy.js`, **and design 61's**
`rebalance-to-target-apply-reducer.js`. Generalize it once and every disposal path
benefits.

**A dormant hook.** The disposal reducers already carry
`costBasisStrategy = 'FIFO' | 'LIFO' | 'SPECIFIC'` (`us-brokerage-classes.js` L227) —
declared per the original design §6.4 but **never implemented** (the primitive is always
FIFO). Lever B (§4-B) is its first real consumer.

**Design 61 target.** `RebalanceToTargetReducer` holds the current portfolio target
(`targetAllocation`) and, in LOCATED mode, computes a **per-account target composition**
each period (`allocation-location.js#planLocatedTargets`). The "over-weight sleeve" for
Lever C is exactly `actual − target` per class — but the target is **reducer-resident
today** and not visible at drawdown time (see OQ1).

---

## 3. The gap

| Want | Reachable today? | Blocked by |
|---|---|---|
| Sell the **cheap-to-tax sleeve first** (CASH → BOND → EQUITY → GOLD) for a debit | ❌ | `consumeHoldingsFifo` ignores `allocation` |
| Sell the **over-weight sleeve** so the debit *also* rebalances (one CGT event, not two) | ❌ | no coupling between drawdown and the design-61 target; target not visible at draw time |
| **Tax-aware lot selection** (min-gain / HIFO / loss-first) within a sleeve | ❌ | primitive is FIFO-only; `costBasisStrategy` hook unimplemented |
| Make the sleeve order **optimizable / MPC-tunable** | ❌ | no lever surface; nothing consumes an allocation order for drawdown |
| Generalize the **cash-bucket** stress rule from accounts to **sleeves** | partial | today's override is account-level only (design 29 §3.7) |

---

## 4. The lever, decomposed (mirrors design 58 / 61)

Split "allocation-aware drawdown" into three orthogonal, composable sub-levers. Each is
a static scenario knob **and** a one-shot opt axis **and** (later) an MPC-online control.

### Lever A — Sleeve selection order (which allocation to sell first)

A per-run **class order** the liquidation walks before falling through to lots, e.g.:

```text
drawdownSleeveOrder: ['CASH', 'BOND', 'EQUITY', 'GOLD']   # tax-cost ascending (default proposal)
```

- **`TAX_COST` (proposed default)** — CASH (no gain) → BOND (ordinary-ish, small gains)
  → EQUITY (LTCG) → GOLD (US 28% collectible). Raises cash from the least-taxed sleeve
  first.
- **`PRESERVE_GROWTH`** — sell CASH/BOND first, hold equity/gold longest (the retirement
  "spend the safe stuff, let the risky stuff compound" heuristic; overlaps A but framed
  by risk not tax).
- **`FIFO` (back-compat default on first ship)** — ignore allocation, today's behavior.
- **`WEIGHTED`** — an optimizable weight per class (ascending sort = sell order), the
  design-58 Lever-B analog, so the solver/MPC can *search* the order.

Same-class lots are then ordered by Lever B.

### Lever B — Lot selection within a sleeve (tax-aware cost basis)

Which **lots** of the chosen sleeve to consume — finally implementing the dormant
`costBasisStrategy`:

- **`FIFO`** (today) — oldest first. Maximizes the AU ≥12-month discount eligibility
  (design 62) but realizes the highest gains.
- **`HIFO` / `MIN_GAIN`** — highest-cost-basis first ⇒ least realized gain per dollar.
  The tax-minimizing choice, but may sell recently-bought lots and forfeit the AU
  12-month discount — see OQ3.
- **`LOSS_FIRST`** — realize lots at a loss first (coordinates with TLH, design 29 §3.3),
  banking losses against the year's gains.
- **`SPECIFIC`** — a bracket-aware pick that nets the debit's realized gain against the
  0%/low LTCG bracket room (the design-61 §OQ3 "own bracket-aware realization" idea,
  reused here).

### Lever C — Rebalance coupling (the flagship — one sale funds *and* rebalances)

When design 61 is active, bias the sleeve order (Lever A) toward the **over-weight**
class so the debit *doubles as* a rebalance, avoiding a second CGT event:

```text
effectiveSleeveScore(class) = w_tax · taxCostRank(class) + w_mix · (actualFrac − targetFrac)
```

Selling the over-weight sleeve first draws the account *toward* its design-61 target, so
the next scheduled rebalance has less (or nothing) to do. This is the design 61 §8
unification made real: **drawdown becomes allocation-aware, so one liquidation both
funds spending and corrects the mix.** Requires the current target at draw time (OQ1).

---

## 5. The shared primitive — generalize `consumeHoldingsFifo`

The whole lever reduces to **one change with wide reach**: replace the primitive's fixed
`sort by purchaseDate` with a **pluggable comparator / selection policy**, keeping FIFO
as the default so every existing caller (and the golden) is byte-identical until a policy
is opted in.

```js
// holdings-fifo.js — today
const sorted = [...holdings].sort((a, b) => _purchaseTs(a) - _purchaseTs(b));

// proposed: consumeHoldings(holdings, amount, { indexation, selection })
//   selection = { sleeveOrder, lotStrategy, targetComposition, taxRates }  (all optional)
//   → order by (sleeve rank per Lever A/C) then (lot rank per Lever B), else purchaseDate.
```

Keep `consumeHoldingsFifo` as a thin wrapper (`selection` omitted ⇒ FIFO) so no caller
must change to preserve current behavior. All the returned tallies (realized basis,
collectible split, per-country / indexed / discount-eligible slices) are unchanged — they
are computed from *whichever* lots are consumed, so the tax chain downstream is
untouched. **This is the key leverage: one primitive, every disposal path (engine
drawdown, event withdrawals, design-61 rebalance, inheritance) inherits the capability.**

---

## 6. Interaction with designs 58, 61, 29

- **Design 58 (account order) composes cleanly.** 58 picks *which account*; 65 picks
  *which sleeve/lots within it*. Orthogonal — 65 slots **inside** each `_drawPenaltyFree`
  / disposal-reducer call with no change to account ordering.
- **Design 61 (allocation) — Lever C is the payoff.** 65 reads 61's target to sell the
  over-weight sleeve, cutting the double-CGT. Conversely, once 65 lands, 61's scheduled
  rebalance fires **less often** (drawdowns keep the mix in-band), so the two together
  realize less lifetime tax than either alone. The unification design 61 §8 anticipated.
- **Design 29 cash-bucket override generalizes into Lever A.** Today's
  `drawdown_source_override` reorders *accounts* (fixed-income/savings first) under
  stress; 65's sleeve order is the *within-account* generalization. A regime-conditioned
  sleeve order (sell CASH/BOND first under `ECONOMIC_STRESS`) subsumes it; deprecating the
  account-level override is a later cleanup, not a prerequisite.
- **PanicSell (design 29 §3.1) coexists.** PanicSell rotates EQUITY→CASH on crash entry
  (a *hold* change); 65 governs *debit* liquidation. Independent; both selectable.
- **AU 12-month discount (design 62) is a real constraint on Lever B.** HIFO/min-gain can
  select <12-month lots and forfeit the 50% discount — the primitive already tallies the
  discount-eligible slice, so the selection can be made **discount-aware** (prefer
  ≥12-month lots among low-gain candidates). See OQ3.

---

## 7. Optimizer / MC / MPC wiring (mirror design 58 §7 / 61 §7)

- **Static + one-shot opt.** `drawdownSleeveOrder` (ENUM: `FIFO` / `TAX_COST` /
  `PRESERVE_GROWTH` / `WEIGHTED`) + `drawdownLotStrategy` (ENUM: `FIFO` / `HIFO` /
  `LOSS_FIRST` / `SPECIFIC`) as opt axes (`enabled:false`, gated when meaningful). Under
  `WEIGHTED`, per-class `sleeveWeight::<CLASS>` CONTINUOUS axes (the design-58 Lever-B /
  design-61 Lever-A `::`-keyed pattern — **use `::`, not `.`**, per
  `optimizer-param-key-dot-collision`).
- **MPC online.** An `DRAWDOWN_SLEEVE` cockpit control (the design-58/61 triad shape):
  `buildVariables` → the `sleeveWeight::*` axes; `describe` → the resulting sell order;
  `actuate` → re-wire the selection policy. **Likely no `_seededSim` shim** (same win as
  design 61 Phase 5): the policy is reducer/service-resident config, not clobbered state —
  confirm with `verify-mpc-lever.mjs`.
- **Harvest.** The committed sleeve order / weights are flat scenario params ⇒
  deterministic re-run, like design 61 Phase 5.

---

## 8. Testing plan

- **Back-compat golden:** default `drawdownSleeveOrder=FIFO` + `drawdownLotStrategy=FIFO`
  ⇒ `cross-border-relief-scenario.test.mjs` **must not move** (the primitive wrapper is
  identity when `selection` is omitted).
- **Lever A:** a `TAX_COST` order sells the CASH sleeve before EQUITY for a debit from a
  mixed-sleeve brokerage; assert the realized `STOCK_WITHDRAWAL_TAX` gain is lower than
  under FIFO for the same cash raised.
- **Lever B:** `HIFO` realizes a smaller gain than `FIFO` on a multi-lot sleeve;
  `LOSS_FIRST` realizes a loss when one exists; discount-awareness keeps a ≥12-month lot
  when the gain delta is marginal (AU).
- **Lever C (flagship):** with design 61 active and an over-weight EQUITY sleeve, a debit
  sells EQUITY toward the target so the **next** scheduled rebalance emits **no**
  `REBALANCE_TO_TARGET_APPLY` (or a smaller one) — i.e. one CGT event, not two. Assert
  lifetime `STOCK_WITHDRAWAL_TAX` total is lower than FIFO-drawdown + separate-rebalance.
- **Primitive invariants:** value conserved (Σ consumed = amount), collectible/indexed/
  discount tallies correct under every selection policy (they must match a hand-computed
  per-lot expectation regardless of order).
- **Both paths agree:** the engine path (`_drawPenaltyFree`) and the event path
  (`STOCK_WITHDRAWAL_APPLY`) produce identical realized tax for the same account + policy
  (they share the primitive).
- **E2e (the real test — per the design-61 lesson):** a full 30-year run with
  `TAX_COST` + `HIFO` + Lever-C coupling realizes measurably less lifetime CGT and ends
  with higher net worth than the FIFO baseline; no value destruction; golden unchanged.
- **Serializer round-trip** for every new param.

---

## 9. Phased rollout (proposed)

1. **Phase 1 — the primitive seam.** Generalize `consumeHoldingsFifo` →
   `consumeHoldings(holdings, amount, { selection })`; keep the FIFO wrapper. Pure
   refactor, golden byte-identical (no caller passes `selection` yet). Ships the
   mechanism with zero behavior change.
2. **Phase 2 — Lever A (sleeve order) + Lever B (lot strategy).** Wire
   `drawdownSleeveOrder` / `drawdownLotStrategy` params through `_drawPenaltyFree` and the
   disposal reducers into `selection`. Static + opt axes. **Unlocks the tax-efficiency
   study** independent of design 61.
3. **Phase 3 — Lever C (rebalance coupling).** Resolve the design-61 per-account target at
   draw time (OQ1) and bias the sleeve order to the over-weight class. The flagship
   double-CGT elimination.
4. **Phase 4 — MPC online.** `DRAWDOWN_SLEEVE` cockpit control; verifier case.

Phases 1–2 have **no dependency on design 61** (they help any mixed-sleeve or multi-lot
account, including the pre-61 fixed-income/brokerage split). Phase 3 is where 65 and 61
unify.

### Implementation notes (Phases 1–2, 2026-07-16)

- **Phase 1 (seam):** `consumeHoldings(holdings, amount, { indexation, selection })` in
  `holdings-fifo.js`; `consumeHoldingsFifo` is now a thin FIFO wrapper. The pluggable
  comparator lives in the new `holdings/holdings-selection.js`
  (`buildHoldingsComparator`, `SLEEVE_ORDER`, `LOT_STRATEGY`, `resolveDrawdownSelection`).
  `selection == null` ⇒ purchaseDate-ascending, byte-identical to the old path, so every
  existing caller and the golden are unaffected.
- **Phase 2 (Levers A/B):** params `drawdownSleeveOrder` (FIFO/TAX_COST/PRESERVE_GROWTH/
  WEIGHTED), `drawdownLotStrategy` (FIFO/HIFO/LOSS_FIRST/SPECIFIC), and `sleeveWeight::<CLASS>`
  in `intl-retirement-scenario.js`, projected onto `state` by `us-retirement-toolset.js`
  (alongside `withinTierDraw`/`crossBorderDrawdown`). Both disposal paths resolve the same
  `state` fields via `resolveDrawdownSelection`: the engine path (`_drawPenaltyFree`, threaded
  through `replenishSavings`) and the event path (`Us/AuStockWithdrawalApplyReducer`). Opt
  axes added to `intl-retirement-opt-config.js`.
- **OQ3 decision:** the primitive stays **tax-agnostic** (it tallies; the caller taxes). Lever B
  ranks lots by basis-ratio/gain (`HIFO`/`MIN_GAIN`/`LOSS_FIRST`), which is jurisdiction-free.
  `SPECIFIC` is an alias of `MIN_GAIN` today; a genuinely bracket-/after-tax-aware `SPECIFIC`
  (and AU-discount-aware Lever B) is deferred to a later phase since it needs caller-side rate
  context — the tests below hold regardless.
- **Golden unmoved — correctly.** The default IntlRetirement scenario is accumulation-heavy:
  it never liquidates a mixed-sleeve brokerage for a deficit before simEnd, so the lever is
  **legitimately inert there** and `cross-border-relief-scenario.test.mjs` does not move. To
  guard against a silently-inert lever (the design-61 `id:null` lesson), engagement is proven
  by `evt-allocation-aware-drawdown.test.mjs`: forced-drawdown fixtures exercise **both** the
  engine (`replenishSavings`/`_drawPenaltyFree`) and event (`STOCK_WITHDRAWAL_APPLY`) paths and
  assert the sleeve/lot choice (and realized gain) actually changes under TAX_COST/HIFO.
  Primitive-level policies are covered by `holdings-selection.test.mjs`.

**Phase 3 (Lever C — rebalance coupling), OQ1 resolved via option (a):**
- `RebalanceToTargetReducer` now **stamps `account.targetComposition`** (the per-account target
  fraction map it already computes) into state **every period** — even when nothing drifts —
  via copy-on-write, so the drawdown sees a fresh target between rebalances. Confirmed firing in
  a full run (the taxable brokerage stamps `{EQUITY:1.0}` under LOCATED). The stamp is inert
  unless coupling is on, and the reducer is absent by default (`behavioralStrategies=[]`), so the
  golden is untouched.
- New param `drawdownRebalanceWeight` (w_mix, default 0 = off), projected to `state`, opt axis
  added, gated on `behavioralStrategies includes TARGET_ALLOCATION`. `resolveDrawdownSelection`
  carries it; `withRebalanceCoupling(selection, account)` (in `holdings-selection.js`) builds a
  per-account `sleeveScore = taxRankNorm(class) − w_mix·(actualFrac − targetFrac)` — **note the
  sign is `−`, not the doc §4-C `+`**: ascending sort sells first, so the over-weight sleeve must
  score *lower*. Applied at all three consume sites; returns the selection unchanged when coupling
  is off / no target / empty account ⇒ **design-61-off accounts fall back to Lever A** transparently.
- **Lever-C benefit is scenario-shaped.** Under LOCATED, a taxable account concentrates to one
  sleeve, so there's no mix to correct there (w=0≡w=1); the payoff needs genuinely mixed-sleeve
  taxable accounts that get drawn — staged directly in the integration tests (stamp fires, a
  coupled draw sells the over-weight EQUITY toward target, w=0 falls back to blind FIFO).

**3572 unit + 870 viz green.** Remaining: Phase 4 MPC (`DRAWDOWN_SLEEVE` cockpit + the two/three
new state fields in `FORWARD_DRAWDOWN_STATE_FIELDS`).

---

## 10. Open questions

1. **How does the drawdown see the design-61 target at liquidation time?** The target is
   `RebalanceToTargetReducer.targetAllocation` (reducer-resident) / the transient
   `planLocatedTargets` output. Options: (a) design 61 **stamps** the current per-account
   target composition into `state` each period (a new `account.targetComposition` or a
   `state.allocationTarget` field) so the engine `_drawPenaltyFree` and the disposal
   reducers can read it; (b) pass it through the `replenishSavings` opts bag. (a) is
   cleaner and reusable (the cockpit/holdings UI could show target vs actual too), but
   touches design 61's reducer. **Leaning (a).** Resolve before Phase 3.
2. **Objective when mix-correction (C) and tax-minimization (A/B) conflict.** The
   over-weight sleeve may be high-gain equity (selling it corrects the mix but realizes a
   large gain), while the cheap sleeve (CASH) is on-target. The `w_tax`/`w_mix` blend (§4-C)
   is the knob; its default and whether it's optimizable is a decision. Proposal: default
   `w_mix` modest, expose as an opt axis.
3. **Lever B vs the AU 12-month discount.** HIFO/min-gain can select <12-month lots and
   lose the design-62 50% discount, sometimes making the *after-tax* result worse than
   FIFO. The primitive already computes the discount-eligible slice, so the selection can
   score **after-tax** cost (gain × effective rate, discount included) rather than raw
   gain. Make Lever B after-tax-aware, not gain-naive.
4. **Wash-sale / re-buy.** `LOSS_FIRST` realizes losses; if design 61's rebalance then
   re-buys the same class within 30 days, a real wash-sale rule would disallow the loss.
   The sim does **not** model wash sales today — note as a known simplification, not a
   blocker (consistent with the existing TLH treatment).
5. **New design vs. fold into 58/61.** This spans both; a standalone design (65) keeps the
   unification legible. The *code* mostly lands in the shared primitive +
   `account-service` + the disposal reducers, with a thin read of design 61's target — so
   it doesn't bloat either existing design.

---

## 11. Relationship to designs 58 & 61

| Aspect | Design 58 (drawdown) | Design 61 (allocation) | **Design 65 (this)** |
|---|---|---|---|
| **Question** | Which *account* to sell | What *mix* to hold | Which *sleeve/lots* to sell for a debit |
| **Decision unit** | role-level account order | portfolio mix + role location | per-account sleeve order + lot strategy |
| **Primitive** | account selection (`replenishSavings`) | buy+sell to a target (`REBALANCE_TO_TARGET_APPLY`) | `consumeHoldings` selection policy |
| **Tax lever** | which wrapper's gains | when to realize (rebalance CGT) | **how much gain per dollar raised** |

The three compose into one story: **58 picks the account, 65 picks what to sell out of it
(cheaply, and correcting the mix), and 61 maintains the target mix** — with 65's Lever C
letting a single sale serve both 61's rebalance and the spending need, so the household
realizes the least lifetime tax for its spending path.

---

## 12. Build plan / implementation sketch (for the future session)

**Phase 1 — primitive seam** (`src/finance/holdings/holdings-fifo.js`):
- Add `consumeHoldings(holdings, amount, { indexation = null, selection = null })`. When
  `selection` is null, sort by `purchaseDate` (identical to today). Otherwise build a
  comparator: primary key = sleeve rank (`selection.sleeveOrder` / weighted / target-
  coupled score), secondary = lot rank (`selection.lotStrategy`: FIFO=purchaseDate,
  HIFO=descending `costBasis/marketValue`, LOSS_FIRST=ascending gain, SPECIFIC=bracket
  scorer), tie-break `purchaseDate`. Keep all existing tallies.
- Re-export `consumeHoldingsFifo = (h, amt, idx) => consumeHoldings(h, amt, { indexation: idx })`.
- Tests: the 7 existing FIFO tallies are unchanged; new selection policies consume the
  expected lots and produce the expected realized basis / collectible / discount slices.

**Phase 2 — wire the levers:**
- Params (static schema, US_RETIREMENT / a new drawdown toolset owner, mirror design 58):
  `drawdownSleeveOrder` (Enum), `drawdownLotStrategy` (Enum), `sleeveWeight::<CLASS>`
  (`::`-keyed CONTINUOUS, gated on `WEIGHTED`). Defaults `FIFO`/`FIFO` ⇒ golden intact.
- Thread a `selection` object into: `account-service.js#_drawPenaltyFree` (~L1017, replace
  the `consumeHoldingsFifo` call) via the `replenishSavings` opts bag; and
  `StockWithdrawalApplyReducer` / `AuStockWithdrawalApplyReducer` (read the params/config
  they're constructed with — the `costBasisStrategy` field is the existing hook to widen).
- Opt config: add the two enums + `sleeveWeight::*` axes to `intl-retirement-opt-config.js`.

**Phase 3 — Lever C coupling:**
- Resolve OQ1: have design 61 stamp `account.targetComposition` (or a `state.allocationTarget`)
  each period so `_drawPenaltyFree` and the reducers can compute `actualFrac − targetFrac`.
  Build the blended sleeve score; fall back to Lever-A order when design 61 is off.

**Phase 4 — MPC:**
- `DRAWDOWN_SLEEVE` entry in `COCKPIT_CONTROLS` (`cockpit-controller.js`), mirror
  `ALLOCATION_MIX`; `verify-mpc-lever.mjs drawdownSleeve` case; likely no `_seededSim` shim.

**Cross-cutting gotchas:** `::` not `.` in weight keys (`optimizer-param-key-dot-collision`);
JOURNAL_STRICT copy-on-write in the primitive (build a new holdings array, never mutate
lots in place); re-sync `balance = Σ marketValue` at every caller's tail (unchanged);
after-tax scoring for Lever B so the AU discount isn't lost (OQ3); **e2e-verify a full
run, not just unit tests** (the design-61 `id:null` lesson — the primitive touches every
disposal path).
