# 88 — Speculative assets: model the what-if without banking it

**Status** (2026-08-07): **PROPOSED.** Decisions D1–D9 locked below. Phase 1 is a
small, mechanical change with a strong back-compat guarantee; phase 2 is reporting;
phase 3 (a probability haircut) is argued against for now and deliberately deferred.

**The one-line finding:** the model has no way to say *"simulate this, but do not
count it as mine."* Every asset a plan holds is recognised at full market value in
`computeNetWorth`, so the only ways to express "this stake is high-risk and may
never convert to cash" are to inflate every headline number with it, or to delete it
and lose the scenario. Neither is what the planner means.

> This is not primarily a bug report, though it does resolve one: `after-tax.js`
> already omits company equity, silently and by omission rather than by rule
> (`design/inconsistencies.md` §4.12). Fixing that omission in isolation would be
> the wrong move — it would force the \$-for-\$ recognition of exactly the assets
> that prompted the question. The flag is the fix; the metric bug is downstream of
> it.

---

## 1. The problem is a missing primitive, not a metric bug

Concretely: a plan holds several tranches of private company equity. Some have a
plausible liquidity event; others are lottery tickets that may be worth nothing, may
never find a buyer, or may be locked up indefinitely. The planner wants all of them
*in the model* — they want to see what happens if a tranche converts, and they want
the tax consequences modelled correctly when it does — but they do not want the
unconverted stake showing up in the number they use to decide whether they can
retire.

Measured on one live plan (2026-08-07): unsold company-equity tranches compounding
untouched for four decades came to **more than a third of terminal net worth**, with
a cost basis of zero and no tax ever assessed against them. Nothing about that is a
modelling error — the appreciation math is right, the tranches genuinely exist, and
`plannedSaleYear: null` genuinely means "no sale is planned". The error is that a
number the planner reads as *"what I will have"* silently included a large position
they would never describe that way.

There is an accounting distinction that names this exactly, and it is worth
borrowing even though it governs corporate reporting rather than household planning:
the split between **recognition** and **disclosure**. A contingent asset — one whose
existence or value depends on an uncertain future event — is deliberately *not*
recognised on the balance sheet, on the reasoning that recognising it would book
income that may never be realised. It is disclosed instead, in the notes, where a
reader can see it without it flowing into the totals. (Paraphrase of the IAS 37
treatment from memory; the standard is not on disk and the exact wording should be
checked before it is ever quoted rather than reasoned from.)

That maps cleanly onto what we need:

| accounting concept | here |
|---|---|
| recognition | `computeNetWorth`, and everything that follows it — objectives, guardrails, terminal targets |
| disclosure | the allocation cube, a second `…InclSpeculative` metric, the UI |

The whole design is: give the planner a way to move an asset from the first column
to the second, without moving it out of the simulation.

---

## 2. What "speculative" means precisely

**It suppresses the carrying value. It never suppresses the mechanics.**

This is the single most important line in the document, and everything in §4 follows
from it. A speculative asset:

- **still appreciates** on its schedule. Its `value` in state is real and correct.
- **still sells** when `plannedSaleYear` arrives, through the unchanged
  `COMPANY_SALE → COMPANY_SALE_TAX` path.
- **still pays tax** on that sale — US LTCG, AU CGT with the residency step-up
  (design 72 §3), all of it, and the tax lands in `cumulativeTaxesPaid`.
- **still deposits its proceeds** into `saleDestinationAccount`, where they become an
  ordinary account balance and are recognised in full from that instant.

So a speculative asset is worth **zero until it converts, and then worth exactly
what it converted into**. That is what makes it a usable what-if rather than a
gimmick: set a `plannedSaleYear` and the run shows you the upside path, complete with
its tax bill; leave it null and the tranche contributes nothing to any headline while
remaining visible in the model.

The alternative reading — "speculative means don't simulate it" — is strictly worse.
It is already available (delete the asset) and it throws away the question the
planner is asking.

---

## 3. Decisions

**D1 — the field is `speculative: boolean`, authored on the asset.**

Rejected `excludeFromNetWorth`: it names one consequence, and §4 shows there are
several. A mechanism-named flag invites the next change to add a second, nearly
identical flag rather than extend this one. `speculative` states a property of the
*asset* and lets each consumer decide what that implies — the same way `isPrimaryResidence`
is a fact about a house from which several tax rules follow, rather than a field
called `qualifiesForSection121`.

Rejected `contingent`: closer to the accounting concept, but it is a term of art with
a specific recognition threshold attached, and we are not implementing that threshold.
Borrowing the reasoning is fine; borrowing the label would overclaim.

**D2 — absent ⇒ `false` ⇒ today's behaviour, bit for bit.**

Non-negotiable, and cheap: every existing scenario, every saved JSON, and the golden
fixture must be unchanged by phase 1. This is now directly testable — see §8.

**D3 — the flag lives on `Asset`, not on `CompanyEquity`.**

`src/finance/assets/asset.js` is the base for `RealProperty`, `Collectible` and
`CompanyEquity`. All three can be speculative in the same sense: a pre-construction
property, an attributed-but-unauthenticated artwork, a private stake. Putting it on
the base costs nothing and avoids a second round of this design when the next kind
needs it.

Accounts are a different hierarchy (`Account`, not `Asset`) and are **out of scope
for phase 1** — see §9 OQ2. An account is drawdown-eligible machinery with a
`balance`; excluding one from worth while the drawdown engine spends from it would be
incoherent, and resolving that is a bigger question than this design needs to answer.

**D4 — a speculative asset is not drawdown-eligible, and this is enforced, not assumed.**

Today company equity happens to be solvency-inert (`drawdownPriority: null` in
practice, and `computeGuardrailPortfolioValue` requires both a numeric `balance` and
a non-null `drawdownPriority`, neither of which a `kind: 'company'` entry has). That
is an accident of the current data, not a rule.

The rule: if you have told the model this asset may never convert, the model must not
quietly fund your grocery bill from it. `speculative: true` and a non-null
`drawdownPriority` is a contradiction, and the loader should reject it rather than
silently pick a winner.

Note this does **not** conflict with D2's scheduled sale. An explicit
`plannedSaleYear` is the planner stating an assumption; opportunistic liquidation by
the drawdown engine is the model making one up. The first is the point of the
feature; the second is what we are preventing.

**D5 — `computeNetWorth` excludes; `computeAfterTaxNetWorth` excludes by the same
rule, and gains a proper `company` branch for the non-speculative case.**

The accidental omission in `_sumAfterTax` gets fixed and made deliberate in the same
change. Without the fix, turning the flag *off* on a company stake would produce the
absurd pair "recognised at full value in net worth, valued at zero after tax."

**D6 — the allocation cube keeps the row and gains a `speculative` column.**

This is the disclosure half. Dropping the row would make the position invisible in
the one view whose whole job is showing where the money is. See §5 for the invariant
consequences, which are the sharpest technical constraint in this design.

**D7 — a second metric, `netWorthInclSpeculative`, is published alongside.**

Otherwise the flag destroys information: the planner would lose the ability to ask
"and what if they all pay off?" without editing the scenario. Two numbers, both
honest, neither privileged. The optimizer and MC keep targeting the recognised
figure (D8).

**D8 — every objective, target and guardrail follows `netWorth`, automatically.**

`_TERMINAL_MEASURES` in `optimization-objectives.js` resolves through
`finalNetWorthUsd` / `finalNetLiquidity` / the two after-tax keys; all four are
computed from the functions changed in D5, so they inherit the new scope with no
edit. `terminalWealthTarget` likewise. `computeGuardrailPortfolioValue` needs no
change (D4). This is a feature of the existing layering and should be stated so a
future reader does not go looking for four more call sites.

**D9 — no probability haircut in phase 1.** See §10.

---

## 4. The metric scope table

The heart of the change. "Excludes" always means *excludes the unconverted carrying
value*; proceeds after a sale are an ordinary account balance and are always counted.

| consumer | file | speculative asset | change needed |
|---|---|---|---|
| `computeNetWorth` | `derived-metrics/net-worth.js` | **excluded** | yes — skip when flag set |
| `netWorthInclSpeculative` | new, same file | included | yes — new function + `deriveNetWorth` writes both |
| `computeNetLiquidity` | `derived-metrics/net-liquidity.js` | already excluded | **none** — requires a numeric `balance`, which no `Asset` kind has |
| `computeAfterTaxNetWorth` | `derived-metrics/after-tax.js` | **excluded by rule** | yes — add the `company` branch (§4.12), then gate it on the flag |
| `computeAfterTaxNetLiquidity` | same | already excluded | none — `includeIlliquid: false` |
| allocation cube | `allocation-reporting/allocation-cube.js` | **included, flagged** | yes — carry `speculative` onto the row |
| guardrail portfolio | `spending/guardrail-portfolio-value.js` | already excluded | **none** — needs `balance` + `drawdownPriority` (D4) |
| optimizer terminal measures | `optimization/optimization-objectives.js` | follows `netWorth` | none — resolves through the functions above |
| MC run metrics | `monte-carlo/intl-retirement-mc-runner.js` | follows `netWorth` | none, same reason |
| `cumulativeTaxesPaid` | tax settle path | **unaffected** | none — a realised sale is a realised sale (D2) |
| drawdown / `replenishSavings` | `services/account-service.js` | ineligible | validation only (D4) |

Two things worth noting about this table. First, **most of it is "none"** — the
layering already routes everything through two functions, which is why this design is
small. Second, the three "already excluded" rows are excluded *for incidental
reasons* (no `balance` field, `includeIlliquid: false`), and those reasons happen to
coincide with the intent today. They should each get a one-line comment saying so,
because a future change that gives assets a `balance`-like field would break the
coincidence silently.

---

## 5. The allocation cube: one invariant becomes two

The cube's contract (design 82 §3, asserted by the *"the cube total equals
computeNetWorth"* case in `tests/unit/allocation-cube.test.mjs`, and restated in
`allocation-plugin.js` because a denominator missing an asset misstates every slice,
not just the missing one) is:

```
Σ rows.marketValue === computeNetWorth(state, baseCurrency)
```

D6 and D5 put those two sides on different sides of the flag, so the invariant as
written *must* break. That is not a reason to weaken it — it is a reason to split it,
and the split is more informative than the original:

```
Σ rows.marketValue                        === netWorthInclSpeculative   (disclosure)
Σ rows.marketValue where !speculative     === netWorth                  (recognition)
```

Both are exactly checkable, and together they pin strictly more than the single
invariant did: they assert not just that the cube and the metrics agree on the total,
but that they agree on *which rows are recognised*. A future change that drops the
flag in one of the two projections fails one of these and not the other, which
localises the bug immediately.

Consequence for the mix views: the conventional gross-asset denominator already
filters `ASSET_CLASS.LIABILITY` out. It will now need to decide about
`PRIVATE_EQUITY` rows that are speculative. **Recommendation:** the mix denominator
follows recognition (exclude them), because a percentage-of-portfolio figure that
includes a position you have declared may-be-worthless is not a useful allocation
statement. Surface them as a separate disclosed line, not as a slice.

---

## 6. Where the field will get dropped

The field has to survive four hops, and this codebase has lost a field at three of
them before. Each of these is a real prior incident, listed so the implementation
does not rediscover them:

1. **Constructor → serializer.** `_serializeCompanyEquity` has an explicit field
   list. Design 72 §3 records `costBaseByCountry` needing a note in that list
   specifically because a scenario saved after the AU move otherwise reloaded with
   the basis lost. Same shape here: a scenario saved with the flag set would reload
   recognising the asset. Three serializers to touch (company equity, real property,
   collectible), all with explicit lists.

2. **Config record → runtime state.** `_companyEquityToStatePlain` and its three
   siblings (`_accountToStatePlain`, `_propertyToStatePlain`,
   `_collectibleToStatePlain`) are hand-written projections. Design 76 Gap A is
   exactly this failure: `ownershipType` was dropped by `_accountToStatePlain`, so
   `ownershipFractions` could never take its `sole` branch and every per-person
   attribution silently fell through to an even split. The metrics read *state*, not
   the config record, so a drop here makes the flag completely inert while the UI
   shows it set.

3. **Falsy-guard erosion.** `speculative ?? false` is correct; `speculative || false`
   is fine; but any `if (!entry.speculative)` written against a *missing* projection
   reads as "not speculative" and passes. The failure mode is silent recognition,
   which is the status quo — so it will not look broken. Prefer an explicit
   `=== true` at the decision points.

4. **Param↔field linking (design 32).** If the flag is exposed as a scenario param
   rather than only as an asset-editor checkbox, it must be linked, or the
   param-vs-domain edit duality and the Rebuild revert trap both apply.
   **Recommendation:** phase 1 exposes it as an **editor checkbox only**, no param.
   It is a structural fact about the asset, not a lever anyone wants to sweep — and
   the moment it becomes a param it also becomes an MC/opt axis candidate, which
   raises questions (§9 OQ3) phase 1 does not need to answer.

---

## 7. Phases

**Phase 1 — recognition (the whole behavioural change).**
- `speculative` on `Asset`; threaded through the three serializers and the three
  state projections (§6).
- `computeNetWorth` skips flagged entries; `computeNetWorthInclSpeculative` added;
  `deriveNetWorth` writes both onto `state.metrics`.
- `_sumAfterTax` gains the missing `company` branch and the flag gate (D5).
- Cube rows carry `speculative`; the totality test splits into the two invariants
  of §5.
- Loader validation for D4 (flag set + non-null `drawdownPriority` ⇒ reject).
- Comments on the three "excluded incidentally" call sites (§4).

**Phase 2 — disclosure.**
- Asset-editor checkbox with a caption that says what it does, because "speculative"
  alone will be read as a risk rating rather than an exclusion.
- Cockpit / MC / compare panels show both figures where they show one today.
- Allocation mix denominator decision from §5.
- `configuration-list.js` badge, alongside the existing `Primary` badge for houses.

**Phase 3 — probability haircut. Deferred; see §10.**

---

## 8. Verification, and the working-detector control

The absence tests here are the dangerous kind: "this asset does not appear in net
worth" passes trivially if the asset was never loaded, if the projection dropped it,
or if the whole toolset failed to compile. Every check below is therefore paired with
a control that fails if the machinery is dead — the lesson from the offset-yield
work, where an absence test looked green because nothing was running at all.

1. **Back-compat, exact.** With no asset flagged, the golden fixture
   `tests/fixtures/golden-cross-border-reference.json` must be **byte-identical**.
   This is the strongest available guarantee and it is now cheap: the harness pins
   the whole end state, not two scalars, and the sim is bit-reproducible across
   processes. If phase 1 moves anything at all with the flag unset, it is wrong.

2. **A dedicated golden**, added to `GOLDEN_SPECS`, holding one speculative company
   stake with `plannedSaleYear: null`. Assert, on the same run:
   - `netWorth` excludes the stake — **control:** the same scenario with
     `speculative: false` recognises it, and the two figures differ by exactly the
     stake's converted value. Without this control, a dropped projection (§6 trap 2)
     passes the exclusion assertion.
   - `netWorthInclSpeculative − netWorth === ` the stake's value in base currency.
   - both cube invariants from §5 hold.
   - `afterTaxNetWorth` excludes it, and — the control that catches D5 being
     half-done — a *non*-speculative company stake is present in `afterTaxNetWorth`
     at a value strictly between zero and its market value.

3. **A conversion golden.** Same stake with a `plannedSaleYear` inside the run.
   Assert `netWorth` is flat across the sale boundary except for the proceeds and
   the tax — i.e. recognition switches on exactly when the asset becomes cash, and
   the CGT is assessed normally. **Control:** `cumulativeTaxesPaid` must *increase*
   at that boundary; a speculative asset that sells tax-free would mean D2 was
   implemented as "skip the mechanics".

4. **Round-trip.** Serialize → deserialize → re-run, flag intact and behaviour
   identical (§6 trap 1). The existing `scenario-roundtrip.test.mjs` is the home
   for this.

5. **Coverage gate.** No new action types, so `golden-coverage-manifest.js` should
   not move. If it does, something scheduled an event it should not have.

---

## 9. Open questions

**OQ1 — should the flag suppress the asset from `cumulativeConsumption` planning
inputs?** It does not today because nothing routes assets there, but the
spending-plan ceiling work reads terminal wealth. Believed to be covered by D8
(everything follows `netWorth`); worth confirming against the MPC cockpit's goal
resolution before phase 2 rather than assuming.

**OQ2 — accounts.** A speculative *account* (an illiquid crypto position, a
restricted stock plan modelled as a balance) is a coherent request, and D3 defers it
purely because drawdown eligibility makes it a harder question. The likely answer is
that a speculative account must have `drawdownPriority: null`, i.e. the same rule as
D4, at which point most of the machinery already works. Not scoped here.

**OQ3 — should `speculative` be sweepable?** Turning it into an MC/opt axis would
let the optimizer answer "how much does the plan depend on this tranche paying off?",
which is a genuinely good question. But it is a *binary* axis over a structural
field, which neither the CEM solver nor the MC sampler handles naturally, and §10's
haircut is a better-shaped answer to the same question. Explicitly out of scope; do
not add it by accident when phase 2 touches the editor.

**OQ4 — bequests.** `bequest-service.js` synthesises zero-valued marker entries for
inherited assets. An inherited stake that may never materialise is the same problem
with an extra layer. Untouched by phase 1; check the marker path does not need the
field before phase 2.

---

## 10. Why not a probability haircut — yet

The obvious generalisation is `realizationProbability: 0.2`, recognising 20% of the
value, with `speculative: true` as the degenerate case at zero. It is tempting and it
is wrong to build first, for three reasons.

**It invents precision the planner does not have.** The honest input is "this might
be worth nothing"; converting that to 0.2 requires a number nobody knows, and the
resulting figure — a fifth of a stake, recognised in a headline — is neither the
conservative case nor the optimistic one. It is a number with no interpretation.

**The model already has a better tool for this.** Uncertainty about magnitude is what
Monte Carlo is for. If the question is "how much does the plan depend on this
tranche", the well-posed version is a two-arm study — flag on versus flag off — or an
MC axis over the stake's *value*, both of which the framework supports today and
neither of which needs a new field.

**A point estimate hides the shape.** Recognising 20% produces one plan that is
comfortable and wrong in both directions: it never shows the outcome where the stake
is worthless (which is the one the planner is worried about) and never shows the
outcome where it pays in full.

The binary flag is not a simplification of the haircut — it is the correct primitive.
If a haircut is added later it should sit *on top* of the flag (`speculative: true`
plus an optional disclosed expected value), never replace it, so that the recognised
figure stays a number the planner can defend without a probability argument attached.

---

## Appendix — the bug this supersedes

`design/inconsistencies.md` §4.12 records that `computeAfterTaxNetWorth` omits
`kind === 'company'` while `computeNetWorth` includes it, and that the comment at
`after-tax.js:479` asserts the two must not "hold different opinions about what a
dollar is." On the plan that prompted this design the two disagreed by the entire
carrying value of the unsold tranches.

Phase 1 D5 closes it. The entry should be marked resolved *by this design* rather
than fixed independently — patching `_sumAfterTax` alone would force full recognition
of precisely the assets §1 argues should not be recognised, i.e. it would make the
headline number worse while making the code more consistent.
