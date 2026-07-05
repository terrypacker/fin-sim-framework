# 45 — Early-Withdrawal "Decant" Lever (proactive pre-move US retirement drawdown, + multi-lever MPC)

**Status**: Proposed (preliminary draft 2026-06-28). Design discussion only — **not ready to implement; see §9 Open Questions.**
**Related**: `design/39-mpc-financial-controller.md` (the MPC controller + cockpit levers this extends), `design/40-after-tax-net-worth.md` (the metric that scores the payoff), `design/42-roth-lever-snapshot-rollout-fidelity.md` (per-epoch lever fidelity), `design/43-basis-accounting-integrity.md` (brokerage basis on the cash that lands), `design/44-cross-border-drawdown-actions.md` (the withdrawal-tax actions this reuses), `design/36` (AU CGT cost-base step-up). Code: `src/finance/mpc/cockpit-controller.js` (`COCKPIT_CONTROLS`), `src/finance/mpc/mpc-controller.js`, `src/finance/mpc/apply-forward.js`, `src/finance/services/account-service.js` (`replenishSavings` Phase 2, `reduceLedgerForWithdrawal`, `recordResidencyChange`), `src/finance/account-rules/us/us-early-withdrawal-rules.js`, `src/finance/account-rules/us/roth-conversion-classes.js` (the scheduled-lever pattern to mirror).

> **Goal.** Let the planner (and ultimately the MPC optimizer) deliberately withdraw from US tax-deferred / Roth accounts **early, at penalty, while US-resident in a controllable bracket**, to **decant** those dollars into taxable brokerage **before a move to Australia** — where AU does not honor the US tax-advantaged status. Today early withdrawal exists only as an involuntary last-resort inside `replenishSavings` Phase 2; it cannot be *scheduled*, *journaled as a plan*, or *optimized*. This note designs (A) a proactive per-class early-withdrawal lever, (B) a drawdown-ordering variant, and — the gating piece — (C) the **multi-lever MPC mechanics** needed to search them jointly with the existing Spending and Roth-conversion levers.
>
> **Scope: US accounts only.** AU super has no legal early-access pathway worth modeling and stays locked (design 44 / preservation age). Nothing here touches super.

---

## 1. The decant thesis (why pay a penalty on purpose)

An early withdrawal is a **guaranteed loss** (income tax now + 10% penalty), so it only wins when the loss buys something the objective values more. For pure income-bracket smoothing it **never** wins — a Roth *conversion* fills the same low brackets with **no penalty and the money stays tax-advantaged**, so conversion strictly dominates. The early-withdrawal lever is therefore **not a tax-smoothing lever**; it is a **liquidity / cross-border-timing lever**. Its payoff comes from exactly one situation in this codebase's world:

**Decant before the AU move.** AU does not recognize the tax-free/tax-deferred character of US Roth/IRA/401k. Leaving the money in the wrapper exposes it to AU taxation post-move. Moving it into **taxable brokerage while still US-resident** converts a future AU problem into a present, controllable US event.

## 2. The step-up amplification (the headline rationale — must be in scope)

Decanting into **brokerage** compounds with the AU residency cost-base step-up, and this is the real reason the lever can beat its own penalty:

1. Cash landing in brokerage establishes **fresh cost basis at market value** (the deposited cash carries basis = market value — design 43 / holdings `transaction`).
2. On the AU move, `AccountService.recordResidencyChange` performs a **CGT cost-base step-up** for BROKERAGE (design 36 §12.2 — non-TAP assets reset to market at residency change), so **AU forgives all pre-move appreciation**.

Net: **decant → land in brokerage → step-up at the move ⇒ pre-move gains are wiped for AU, and only post-move AU cap gains apply** — versus leaving it in a wrapper AU taxes unfavorably. The design-40 after-tax metric and the step-up logic already model both sides, so the objective *will* see the trade. Consequence for the lever: its value is **coupled to the timing of a scheduled move** — it should fire in the years approaching a residency change, not in a vacuum (see §12 test plan).

## 3. Current state vs. what's missing

| | Today | Needed |
|---|---|---|
| Early withdrawal exists? | Yes — `replenishSavings` Phase 2, ROTH/IRA/401k, 10% penalty (`us-early-withdrawal-rules.js`) | — |
| Triggered how? | **Involuntary**: only when penalty-free sources can't cover a deficit | **Proactive**: a scheduled, intentional amount |
| Destination of cash | Target **savings** (to cover the deficit) | **Brokerage (default)** or savings — *never another retirement account* |
| Journaled as a plan? | No — buried in a fallback | Yes — a scheduled action, visible & optimizable |
| Optimizer can choose it? | No | Yes — a cockpit lever in the joint search |

## 4. Decisions already settled (from design discussion)

1. **Destination:** Savings or **Brokerage, default Brokerage; never another retirement account.**
2. **Per-class control, Roth earnings in scope.** Two classes:
   - `TAX_DEFERRED` (IRA + 401k) → ordinary income + 10% penalty.
   - `ROTH` → **contributions first (penalty-free)**, then **earnings (penalty)** — one per-class amount applied in that order (matches `reduceLedgerForWithdrawal`'s Roth ordering).
3. **Build both (A) and (B)** — first deliberate multi-lever MPC step.
4. **Conversion + withdrawal co-occur** (e.g. convert IRA→Roth *and* pull seasoned Roth contributions/earnings out in the same year, pre-move). The levers must **compose on shared balances**, not be mutually exclusive.

---

## 5. (A) The proactive per-class lever — spec (mirror `COCKPIT_CONTROLS.ROTH`)

A new `COCKPIT_CONTROLS.EARLY_WITHDRAWAL` (or two specs, `EARLY_TAX_DEFERRED` + `EARLY_ROTH`), built like the Roth-conversion control:

- **Control variable / units:** next-actionable-year early-withdrawal **target dollars per class**, real base-year USD (parallel to the Roth ceiling). Receding-horizon: re-decided each epoch as "now" advances.
- **`defaultRange`:** `{ min: 0, max: <class drawable balance>, step }`; `0 = OFF` for the year. Cap to what the class can actually give (drawable balance, age/penalty aware).
- **`appliesTo`:** active only when the owner is **below** the age gate (59.5/60) — above it withdrawals are penalty-free and normal drawdown handles them — **and** has a positive class balance. (Optionally also gate on "a residency change is scheduled within N years," per §2.)
- **`prepareBaseParams`:** append a `{ year, taxDeferredAmount, rothAmount, destination }` entry to an `earlyWithdrawalSchedule` param for the next actionable year (mirrors the Roth schedule append; `set()` never creates nodes).
- **`buildVariables`:** one INTEGER variable per active class for the next actionable year, capped to class drawable balance.
- **`describe`:** "Withdraw \$X early from tax-deferred (≈\$P penalty) → brokerage."
- **`liveActuatable` / `actuate`:** forward-effective re-wire of the schedule param + live reducer (same pattern as the Roth control's three-step actuate: re-wire reducer, re-pin live state if it hits the current year, persist to scenario param).

## 6. The actuation mechanism — a scheduled early-withdrawal action (new)

The lever needs a **planned** withdrawal path distinct from the Phase-2 fallback — mirror the Roth-conversion scheduled machinery (`roth-conversion-classes.js`):

- **Param:** `earlyWithdrawalSchedule: [{ year, taxDeferredAmount, rothAmount, destinationKey }]`.
- **Handler:** an annual `EarlyWithdrawalPolicyHandler` that, on the scheduled date, emits a `SCHEDULED_EARLY_WITHDRAWAL` action per class.
- **Reducer:** `ScheduledEarlyWithdrawalApplyReducer` that, per class:
  - draws the amount (capped to drawable balance), updating the ledger via `reduceLedgerForWithdrawal` (design 43);
  - applies the 10% penalty and emits the existing tax actions (`IRA_/K401_/ROTH_WITHDRAWAL_*` + penalty — design 44 Gap B already defined these shapes);
  - routes **net** cash to `destinationKey` (brokerage default), where it lands at cost basis = market (design 43);
  - emits a journal-visible record so the plan is auditable.
- **Reuse, don't fork:** the per-type draw/penalty/tax-action logic already lives in `replenishSavings` Phase 2 and `_drawPenaltyFree`. Factor the per-class "withdraw + penalize + tax-action + ledger" core into a shared helper both the fallback and the scheduled reducer call, so they can't diverge.

## 7. (B) The drawdown-ordering permission variant

Separate from the scheduled amount: a **strategy switch** that lets the *involuntary* Phase-2 fallback tap early withdrawal **earlier in the drawdown order** (e.g. before selling taxable brokerage and realizing gains) rather than strictly last. This captures the "pay the penalty instead of realizing cap gains / draining the buffer" liquidity decision without a scheduled amount. Model as a drawdown-strategy option, not an optimizable scalar.

**A↔B precedence:** treat (A)'s scheduled amount as a planned **floor** (the deliberate decant) and (B) as governing the *order* the fallback uses once a real deficit appears — so the two never double-draw. Define the precedence explicitly before coding.

---

## 8. (C) Multi-lever MPC mechanics — ⚠️ THE GATING PIECE

**This is the most important and least-specified part of the work. (A) and (B) are inert without it, and it is a genuine framework change, not a lever.** Today the cockpit is effectively **single-lever**: the UI selects one `COCKPIT_CONTROLS` spec and the controller searches that spec's variables. "A + B composing with the existing Spending and Roth-conversion levers" requires the MPC layer to:

1. **Activate a *set* of levers**, not one — a selection model in the cockpit/controller for "these N controls are live this run."
2. **Union their decision variables** into a single decision vector (each spec's `buildVariables` contributes; `prepareBaseParams` from all active specs must compose without clobbering each other's schedule params).
3. **Search the joint space.** Per-control **grid search blows up combinatorially** across 3–4 levers (Spending × Roth ceiling × tax-deferred × Roth-early). This very likely **forces the move off per-control grids onto the smarter optimizer** (design 38/39 solver framework) — a real scope item.
4. **Commit all active levers per epoch** in `apply-forward` (the COMMIT/ADVANCE step), and preserve each across epochs (design 42 fidelity — each lever's prior committed years must survive the receding-horizon roll).
5. **Score interactions in one objective.** Shared balances mean the levers are coupled (a dollar of IRA can be converted *or* withdrawn, not both): the objective must evaluate them **jointly**, not as independent 1-D sweeps.

Until §8 has a concrete design, (A)/(B) can be built and exercised **manually via scenario params** (scheduled amounts set by hand) but **not driven by MPC**. Recommend specifying §8 as its own design (or a dedicated section with sign-off) before any optimizer work.

---

## 9. Open questions — resolve before implementation

1. **Multi-lever search strategy (§8).** Grid vs. the optimization-solver framework? What's the decision-vector size budget and the per-epoch solve-time target? *(Blocks all MPC-driven use.)*
2. **Intra-year ordering on shared balances.** When a year has *both* a Roth conversion (IRA→Roth) and early withdrawals (IRA→brokerage, Roth→brokerage), what is the deterministic sequence? Likely **conversions, then withdrawals** — but it must be pinned against the same-date event-ordering hazard (design 34 §13: comparator is date-only, non-deterministic). Does the contribution-from-a-just-completed-conversion become withdrawable the same year?
3. **A↔B precedence (§7).** Exact rule so the planned floor and the involuntary fallback never double-draw.
4. **Class granularity.** `TAX_DEFERRED` as one combined IRA+401k class (drawn in a defined order) vs. separate levers? (Leaning combined.)
5. **Lever units & cap semantics.** Raw withdrawal dollars per class (proposed) vs. an income-fill target like the Roth lever — and how the cap interacts with the Roth-conversion lever consuming the **same** IRA balance and the **same** bracket headroom in the same year.
6. **Move-timing gating.** Should `appliesTo` *require* a scheduled residency change within N years (§2), or stay always-available and let the objective decide? (Affects whether the optimizer ever pulls it absent a move.)
7. **Penalty/cost realism.** Confirm 10% + ordinary income is the model (any state penalty? any exception modeling — SEPP/72(t), first-home, etc.? — probably out of scope, but state it).

## 10. Phased plan (once §9 is resolved)

- **Phase 1 — scheduled decant action (no MPC).** `earlyWithdrawalSchedule` param + `EarlyWithdrawalPolicyHandler` + `ScheduledEarlyWithdrawalApplyReducer`, reusing the factored per-class withdraw/penalty/tax-action core (§6). Cash → brokerage. Manually parameterized. Tests: penalty + tax actions emitted, ledger ties, cash lands at market basis, step-up forgives pre-move gain.
- **Phase 2 — (B) drawdown-ordering option.** Strategy switch + A↔B precedence.
- **Phase 3 — single-lever cockpit control (A).** `COCKPIT_CONTROLS.EARLY_*` spec(s), `actuate`/`prepareBaseParams`, usable as *one* selected lever.
- **Phase 4 — multi-lever MPC (§8).** Lever-set activation, joint decision vector, joint objective, per-epoch commit. The big one.

## 11. Risks / downstream

- **Combinatorial blow-up (§8)** is the main risk; it likely pulls the solver rework forward.
- **Double-draw** between scheduled (A) and fallback Phase 2 / (B) if precedence isn't pinned.
- **Conversion/withdrawal coupling** on the same IRA balance and bracket headroom — the optimizer can produce nonsensical combos if the joint objective or the intra-year ordering is wrong.
- **Same-date ordering** (design 34 §13) for conversion-then-withdrawal in one year.
- **Objective must already price** the penalty *and* the step-up payoff (it does, via design 40 + design 36) — verify with a test that the lever is only pulled when the benefit clears the penalty and a move is in sight.

## 12. Test plan (sketch)

- **Penalty-clears-benefit:** optimizer pulls the lever only when decant value (incl. step-up) > penalty; leaves it at 0 otherwise.
- **Pulls-near-move:** with a scheduled AU move, early withdrawals concentrate in the pre-move low-bracket years; with no move, the lever stays ~off.
- **Conversion + withdrawal same year:** IRA convert + Roth contribution/earnings withdrawal compose with correct ordering, ledger integrity (design 43 invariants), and correct tax/penalty actions.
- **Cash lands at market basis** in brokerage and receives the AU step-up at the move (pre-move gain forgiven).
- **Multi-lever joint search** beats (or ties) each lever alone on the objective (no regression from composition).
