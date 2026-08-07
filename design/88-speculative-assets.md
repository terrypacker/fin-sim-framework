# 88 — Speculative assets: model the what-if without banking it

**Status** (2026-08-07): **PHASES 1 AND 2 BUILT.** Decisions D1–D10 locked below.
Phase 3 (a probability haircut, argued against in §11) remains deliberately deferred.

Phase 2's headline is not the checkbox: it is that **the control-scope default flip
(§5.4) was measured, and the effect is large.** On the reference plan, with the
un-leverable component at 36% of terminal net worth and a \$5M real die-with target,
the shipped worth-scoped default advised spending **\$12,000/mo** and left \$2.69M of
reachable wealth; the liquid-scoped goal advised **\$4,773/mo** and landed on the
target to within \$13k. Same plan, same lever, same target — a \$7,227/mo difference in
the advice, from the choice of measure alone. The default is now liquid (§5.4, §9.2).

Phase 1 landed as specified, with two deviations worth naming up front:

- **The `company` branch in `_sumAfterTax` is added at PAR**, matching real property
  and collectibles, rather than net of an embedded CGT — pricing illiquid-asset
  cap-gains is design/40 Q5 and this change does not invent it. §9's control is
  therefore "flipping the flag moves after-tax worth by exactly the stake", which
  detects the same half-done-D5 failure without asserting a tax treatment that does
  not exist.
- **The flag is emitted only when TRUE** — in the serializers, in the state
  projections, and for the `netWorthInclSpeculative` metric. Unconditional defaults
  would have added a key to every saved scenario and every fixture, which is exactly
  what D2 forbids. The verified result: `golden-cross-border-reference.json` is
  untouched, byte for byte.

Enforcement of D4 went further than "the loader should reject it": the guard runs in
the `Asset` constructor AND in `AssetService#mergeChanges`, because the editor's
update path could otherwise create the contradictory pair after construction.

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
| recognition | `computeNetWorth`, and the reported figures that follow it |
| disclosure | the allocation cube, a second `…InclSpeculative` metric, the UI |

The whole design is: give the planner a way to move an asset from the first column
to the second, without moving it out of the simulation.

There is a *third* scope hiding behind the first, and conflating it with recognition
is the older and larger error: what an MPC/OPT controller is allowed to **steer**.
Recognition asks "is this mine?"; control asks "can I reach it?" — and the honest
answer to the second is narrower than to the first even for perfectly ordinary,
non-speculative assets. §5 separates them.

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
fixture must be unchanged by phase 1. This is now directly testable — see §9.

**D3 — the flag lives on `Asset`, not on `CompanyEquity`.**

`src/finance/assets/asset.js` is the base for `RealProperty`, `Collectible` and
`CompanyEquity`. All three can be speculative in the same sense: a pre-construction
property, an attributed-but-unauthenticated artwork, a private stake. Putting it on
the base costs nothing and avoids a second round of this design when the next kind
needs it.

Accounts are **out of scope for phase 1** — see §10 OQ2. An account is
drawdown-eligible machinery with a `balance`; excluding one from worth while the
drawdown engine spends from it would be incoherent, and resolving that is a bigger
question than this design needs to answer.

*Correction found while building:* the draft said accounts were "a different
hierarchy". They are not — `Account extends Asset`, so every account INHERITS the
field whether or not it means anything. Out-of-scope therefore had to be enforced
rather than assumed, and the enforcement is one line in `isSpeculative`, which
answers `false` for anything balance-shaped. Without it a flag set where it has no
effect would still be honoured by the cube, breaking a §6 invariant on a setting
whose entire intent is to do nothing. When OQ2 is answered, that line is what
changes.

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
the one view whose whole job is showing where the money is. See §6 for the invariant
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

This is the *mechanism*, and it is deliberately silent about which measure a
controller should be pointed at. That is a separate question, and D10 answers it.

**D9 — no probability haircut in phase 1.** See §11.

**D10 — control metrics are lever-scoped. Net liquidity is the control metric;
net worth is a reporting metric.**

You should not ask a controller to steer a quantity it has no lever for. `netWorth`
recognises value the MPC/OPT lever set cannot reach — an unsellable house, age-locked
super, and now speculative assets — so anchoring a control objective on it asks the
solver to hit a number it can only partially move. §5 works through the two ways that
goes wrong and states the rule in full.

The consequence for this design is a scoping one, and it matters for how phase 1 is
read: **`speculative` is a recognition fix, not a control fix.** The control side is
already correct today — `computeNetLiquidity` excludes every `Asset` kind because
none carries a `balance` (§4) — and phase 1's job there is only to write down that
this is intentional rather than incidental. If the flag were the control fix, the
right response to "MPC banked my lottery ticket" would be to flag more things, which
is backwards: an *unflagged* unsellable house is the same failure and no flag
addresses it.

---

## 4. The metric scope table

The heart of the change. "Excludes" always means *excludes the unconverted carrying
value*; proceeds after a sale are an ordinary account balance and are always counted.

| consumer | file | speculative asset | change needed |
|---|---|---|---|
| `computeNetWorth` | `derived-metrics/net-worth.js` | **excluded** | yes — skip when flag set |
| `netWorthInclSpeculative` | new, same file | included | yes — new function + `deriveNetWorth` writes both |
| `computeNetLiquidity` | `derived-metrics/net-liquidity.js` | already excluded | **none** — requires a numeric `balance`, which no `Asset` kind has. This is the **control** metric (§5); comment it as intentional |
| `computeAfterTaxNetWorth` | `derived-metrics/after-tax.js` | **excluded by rule** | yes — add the `company` branch (§4.12), then gate it on the flag |
| `computeAfterTaxNetLiquidity` | same | already excluded | none — `includeIlliquid: false`. The preferred control anchor (§5.3) |
| allocation cube | `allocation-reporting/allocation-cube.js` | **included, flagged** | yes — carry `speculative` onto the row |
| guardrail portfolio | `spending/guardrail-portfolio-value.js` | already excluded | **none** — needs `balance` + `drawdownPriority` (D4) |
| optimizer terminal measures | `optimization/optimization-objectives.js` | follows whichever scope the goal names | none in phase 1 — but the worth-scoped default is wrong for control (§5.4) |
| MC run metrics | `monte-carlo/intl-retirement-mc-runner.js` | follows `netWorth` | none, same reason |
| `cumulativeTaxesPaid` | tax settle path | **unaffected** | none — a realised sale is a realised sale (D2) |
| drawdown / `replenishSavings` | `services/account-service.js` | ineligible | validation only (D4) |

Two things worth noting about this table. First, **most of it is "none"** — the
layering already routes everything through two functions, which is why this design is
small. Second, the three "already excluded" rows are excluded *for incidental
reasons* (no `balance` field, `includeIlliquid: false`), and those reasons happen to
coincide with the intent today. They should each get a one-line comment saying so —
and for the two liquidity rows the comment is not merely defensive bookkeeping but a
statement of the rule in §5, because a future change that gives assets a
`balance`-like field would break the coincidence silently and would break it on the
*control* side, where it is hardest to notice.

---

## 5. Control vs reporting: net liquidity is the control metric

**Do not try to control something you have no lever for.** That is the whole rule,
and it is the reason net liquidity exists as a separate measure at all. Net liquidity
should mean *all the value the controller can actually reach to meet the goal* —
no more, and no less. Net worth is the right number to report and the wrong number to
steer, because it recognises value the lever set cannot touch.

### 5.1 The lever set, concretely

The MPC cockpit's controls (`mpc/cockpit-controller.js`) are `SPENDING`, `ROTH`,
`EARLY_WITHDRAWAL`, `DRAWDOWN_XBORDER`, `DRAWDOWN_WITHINTIER`, `DRAWDOWN_WEIGHTS`,
`DRAWDOWN_SLEEVE`, `ALLOCATION_MIX` and `BOND_LADDER`. Every one of them acts on the
spending rate or on drawdown-eligible account balances. **None of them can sell a
house, find a buyer for a private stake, or unlock super before preservation age.**
The optimizer's parameter set is the same story.

The codebase already knows this. `net-liquidity.js` documents `isDrawdownAccessible`
as *"the single source of truth for 'is this account in the lever-reachable
(drawdownable) pool right now'"*, and `optimization-objectives.js` carries the advice
inline above the Die-With-Target family: *"Prefer the LIQUID terminal when the lever
set can't liquidate illiquid assets (house equity, age-locked super), so the 'die with
\$X' target is actually reachable by the controls."* What is missing is not the
implementation but the **rule** — it currently lives as a comment and a preference,
so nothing stops a worth-scoped target from being selected, and (see §5.4) the default
is exactly that.

### 5.2 Two distinct failure modes when a control target is worth-scoped

**The kink goes out of reach — "die with target" quietly becomes "die with zero
liquidity."** The Die-With-Target terminal term is `λ·|terminal − target|`, and its
whole design is the *two-sided* penalty that produces an interior optimum
(spend-early ⇄ leave-less), as `makeDieWithTarget` says in so many words. Write
terminal worth as `U + L(policy)`, where `U` is the un-leverable component and `L` is
the reachable pool. If `U` alone exceeds the (real, deflated) target, then
`terminal − target > 0` for **every admissible policy** — the absolute value's kink is
unreachable — and the penalty collapses to the linear `λ·(U + L − target)`. The
optimizer's best response is then to push `L` toward **zero**, not toward the target:
a strictly one-sided pressure to drain the reachable pool, bounded only by the
solvency penalty. The planner asked to die with \$X and got a policy aiming to die
with nothing they can spend, while the run still reports a plausible-looking terminal
figure of `U + ε`.

This is not hypothetical on the plan that prompted this design, where unsold tranches
are more than a third of terminal net worth (§1): against a modest die-with target,
that component clears the target on its own.

**Substitution — the lottery ticket gets banked as a policy, not just a headline.**
Below that threshold (`U < target`, so the kink is still reachable and the objective
still behaves), the un-leverable value nonetheless *counts toward* the target, so every
dollar of it licenses a dollar less of reachable wealth at the horizon. The controller
spends the liquid pool down against an asset that may never convert. §1's complaint is
that net worth reads as "what I will have"; this is the same error committed by the
solver rather than by the reader, and it is worse, because it comes back as a spending
recommendation.

Both are amplified under MPC relative to a one-shot optimize: MPC re-solves at every
step and re-banks the same un-leverable value each time, so the bias is applied
repeatedly rather than once.

Both are also *observable*, which matters because neither announces itself. The
diagnostic for the first is a solved plan whose terminal **liquidity** is near zero
while its terminal **worth** comfortably clears the target; the diagnostic for the
second is that the gap between the two moves one-for-one with the un-leverable
balance when you re-run with the stake removed. Worth measuring on the live plan
before phase 2 decides the default (§5.4, OQ5) — the decision is better made with the
magnitude in hand than from the argument alone.

### 5.3 What belongs in the control metric

The pool the controller can reach at the moment of measurement — which is what
`computeNetLiquidity` already computes — **plus nothing else**. In particular:

- **A planned conversion needs no special handling.** An asset with a
  `plannedSaleYear` deposits its proceeds into `saleDestinationAccount`, where they
  become an ordinary balance and enter the liquid pool from that instant. So a house
  the plan sells in 2032 is un-leverable until 2032 and leverable after, which is
  exactly right, and it falls out of the existing mechanics.
- **`plannedSaleYear: null` means never in the pool.** A speculative stake with no
  planned sale contributes zero to the control metric for the whole horizon, without
  the `speculative` flag being involved at all.
- This is D4's distinction restated on the metric side: *an explicit `plannedSaleYear`
  is the planner stating an assumption; opportunistic liquidation by the engine is the
  model making one up.* The control metric recognises the first and not the second.

Three honest caveats:

1. **Net liquidity is a *now*-scoped measure** — the age gate means super is excluded
   before preservation age. For a terminal anchor past that age the gate is moot; for
   running/windowed measures it is not, and that is the intended behaviour rather than
   a wart (you cannot spend it yet).
2. **`afterTaxLiquid` is the more honest control anchor still**, since it prices the
   embedded liquidation tax into the number the controller is steering. It already
   exists (`_TERMINAL_MEASURES`, design/40 §4) and costs nothing to prefer.
3. **The rule has a real cost:** a liquidity-scoped target excludes primary-residence
   equity, which is genuine wealth a household may eventually consume by downsizing.
   The answer is to *model the downsizer as a planned sale* (design 83 G7 /
   property-purchase work already supports this), not to launder it into the metric.
   A lever the plan states is a lever; a lever the metric assumes is a fiction.

### 5.4 The consequence for MPC/OPT defaults

`cockpit-controller.js:1078` defaults the MPC objective to `DIE_WITH_TARGET` — the
**worth**-scoped variant — and `resolveTerminalKey` falls back to `scope: 'worth'`.
The liquid variants exist and are recommended in a comment, but the out-of-box
configuration is the one §5.2 argues against.

**DONE in phase 2** — the default is now the liquid scope, in all three places that
resolve it: `DIE_WITH_TARGET_AXES.scope` (whose FIRST entry is what an untouched UI
select shows, and therefore is the default for every goal the cockpit and OPT panels
build), `resolveTerminalKey`'s parameter default and its no-match fallback, and
`CockpitController`'s constructor default. Every worth-scoped variant is kept — this
is a change of default, not a removal, because "what does this look like on a
net-worth basis?" is a legitimate *reporting* question (OQ6).

### 5.4a What the measurement showed (2026-08-07)

Two arms, identical but for the goal's terminal scope, on the reference plan
(2026→2060, EXPLICIT_BANDS spending, CEM budget 60, seed 1). All figures REAL
base-year USD:

| | reachable by the lever | floor at max spend |
|---|---|---|
| terminal net worth | partly | **\$5.08M** |
| terminal net liquidity | yes | **\$2.69M** |
| difference = `U`, the un-leverable component | — | **\$2.38M** |

| real target | worth scope advises | liquid scope advises | Δ |
|---|---|---|---|
| \$0 | \$12,000/mo | \$12,000/mo | — |
| \$2.0M | \$12,000/mo | \$12,000/mo | — |
| \$3.5M | \$12,000/mo | **\$9,977/mo** → lands liquidity at \$3.50M | \$2,023/mo |
| \$5.0M | \$12,000/mo | **\$4,773/mo** → lands liquidity at \$4.99M | \$7,227/mo |

Three things in that table are worth stating explicitly.

**The failure is not about speculative assets at all.** The reference plan has no
flagged asset. `U` is two houses and a collectible — perfectly ordinary illiquid
wealth. This is why D10 insists the flag is a recognition fix: the control problem was
already there, and no amount of flagging would have found it.

**The two scopes agree below both floors.** At targets of \$0 and \$2.0M neither scope
can reach the target, both corner at max spend, and the flip changes nothing. The
advice diverges in exactly one band — targets a liquid anchor can serve and a worth
anchor cannot — **and that band is precisely `U` wide.** The un-leverable component is
not merely a bias term; it is the measure of how many plans the old default could not
express.

**The shipped default made the band unavoidable.** `terminalWealthTarget` defaults to
**0**, i.e. "die with zero" — and \$0 is below the worth floor of \$5.08M on this plan
by construction. So out of the box, the anchor was one-sided for every admissible
policy. Not an edge case: the default configuration.

Also note what does *not* need changing: `computeGuardrailPortfolioValue` requires a
numeric `balance` and a non-null `drawdownPriority` — most of the lever-reachability
test, in another spelling. (It omits the age gate that `isDrawdownAccessible` applies,
so it is lever-scoped but not identical to `computeNetLiquidity`; whether that gap is
deliberate is out of scope here.) The guardrail is already lever-scoped and has been
all along — further evidence that the rule is the codebase's actual convention, and
that it is the objectives layer that drifted from it.

---

## 6. The allocation cube: one invariant becomes two

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

## 7. Where the field will get dropped

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
   raises questions (§10 OQ3) phase 1 does not need to answer.

---

## 8. Phases

**Phase 1 — recognition (the whole behavioural change).**
- `speculative` on `Asset`; threaded through the three serializers and the three
  state projections (§7).
- `computeNetWorth` skips flagged entries; `computeNetWorthInclSpeculative` added;
  `deriveNetWorth` writes both onto `state.metrics`.
- `_sumAfterTax` gains the missing `company` branch and the flag gate (D5).
- Cube rows carry `speculative`; the totality test splits into the two invariants
  of §6.
- Loader validation for D4 (flag set + non-null `drawdownPriority` ⇒ reject).
- Comments on the three "excluded incidentally" call sites (§4) — the two liquidity
  ones citing the control rule (§5), not just the mechanism.

Note what phase 1 deliberately does **not** touch: no objective, default or terminal
scope moves. Phase 1 must be byte-identical with the flag unset (D2, §9.1), and a
default flip cannot be.

**Phase 2 — disclosure, and the control-scope default. BUILT (2026-08-07).**
- ✅ Asset-editor checkbox on all three kinds, with a caption that says what it does
  (it is a recognition switch, not a risk rating) — `index.html` templates plus the
  company-equity / collectible / real-property editors.
- ✅ Cockpit, OPT results and scenario-compare surface the disclosure figure, each
  **only when it differs** from the recognised one. `finalNetWorthInclSpeculative` is
  now built by the optimizer, MC and compare runners.
- ✅ Mix denominator follows RECOGNITION (§6): `buildAllocationSeries` gained
  `excludeSpeculative` (default true), and the excluded amount is disclosed as a
  provenance note — a line, not a slice.
- ✅ `configuration-list.js` badge, alongside `Primary`.
- ✅ **Default terminal scope flipped to liquid** (§5.4, §5.4a) after measuring it.
- ✅ `metrics.netWorthInclSpeculative` registered with the schema registry so it
  formats as money the moment it appears.
- ✅ OQ4 (bequests) answered and closed — see §10.

Two things phase 2 found that the plan did not anticipate:

**The sampler's tie-out had to be split, not just the test.** `allocation-sampler.js`
recorded one `delta = cubeTotal − netWorth`, which on any flagged plan would have lit
the panel's loudest warning — *"Does not tie out. Do not quote any share here."* — on a
plan that is behaving exactly as designed. A false alarm on that banner is worse than
no banner. It now carries both invariants (§6) and `ties` requires both, so the panel
can still say "ties to net worth" while disclosing what it left out.

**D4 is unreachable from the editors, which is why it stays a throw.** None of the
three asset editors exposes `drawdownPriority`, so a user cannot create the
contradictory pair through the UI; the guard fires only on imported or programmatic
records. That is the right place for it — but it means there is no user-facing
validation message, and if a `drawdownPriority` field is ever added to those editors,
one has to be added with it.

**Phase 3 — probability haircut. Deferred; see §11.**

**Phase 1 as built** (2026-08-07) — the files that changed, for the next reader:
`assets/asset.js` (field + `assertSpeculativeConsistency` + `isSpeculative`),
`services/asset-service.js` (the update-path guard), `scenario-serializer.js` (three
serializers + three makers), the four state projections (`us-company-sale`,
`us-collectibles`, `us-real-property`, `au-real-property` toolsets),
`derived-metrics/net-worth.js`, `derived-metrics/after-tax.js`,
`allocation-reporting/allocation-cube.js`, plus scope comments on
`derived-metrics/net-liquidity.js` and `spending/guardrail-portfolio-value.js`.
Two new goldens (`speculative-stake`, `speculative-conversion`) and
`tests/unit/speculative-assets.test.mjs`.

**Phase 2 as built** (2026-08-07): `index.html` (three editor templates),
`assets/{company-equity,collectible,real-property}-editor.js`,
`configuration/configuration-list.js`, `services/bequest-service.js` (OQ4),
`services/state-schema-registry.js`, `optimization/optimization-problem.js`,
`monte-carlo/intl-retirement-mc-runner.js`, `scenario-compare/scenario-compare-runner.js`
and its presenter, `optimization/opt-results-panel.js`,
`workbench/plugins/finance/mpc-cockpit-plugin.js`,
`allocation-reporting/{allocation-grouping,allocation-sampler}.js`,
`workbench/plugins/finance/allocation-plugin.js`, plus the flip in
`optimization/optimization-objectives.js` and `mpc/cockpit-controller.js`.
New: `tests/unit/control-scope.test.mjs`.

---

## 9. Verification, and the working-detector control

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
     stake's converted value. Without this control, a dropped projection (§7 trap 2)
     passes the exclusion assertion.
   - `netWorthInclSpeculative − netWorth === ` the stake's value in base currency.
   - both cube invariants from §6 hold.
   - `afterTaxNetWorth` excludes it, and — the control that catches D5 being
     half-done — flipping the flag moves `afterTaxNetWorth` by **exactly** the
     stake's value. (The draft asked for "strictly between zero and market value",
     i.e. an embedded CGT. Company equity is added at PAR like its siblings, so that
     phrasing would have asserted a tax treatment design/40 Q5 has not built. The
     par version detects the same failure: before D5 the delta was zero.)
   - the pre-tax and after-tax scopes agree about WHICH assets exist — the same
     inclusion delta on both sides, which is the §4.12 comment's own standard.

3. **A conversion golden.** Same stake with a `plannedSaleYear` inside the run.
   Assert `netWorth` is flat across the sale boundary except for the proceeds and
   the tax — i.e. recognition switches on exactly when the asset becomes cash, and
   the CGT is assessed normally. **Control:** `cumulativeTaxesPaid` must *increase*
   at that boundary; a speculative asset that sells tax-free would mean D2 was
   implemented as "skip the mechanics".

4. **Round-trip.** Serialize → deserialize, flag intact on all three kinds, and an
   UNflagged asset emitting no key at all (§7 trap 1).

5. **Coverage gate.** No new action types, so `golden-coverage-manifest.js` should
   not move. If it does, something scheduled an event it should not have.

6. **The control metric does not move** (§5). On the dedicated golden of (2),
   `netLiquidity` and `afterTaxNetLiquidity` must be **identical** with the flag on
   and off — the control scope never recognised the stake, so flagging it can change
   nothing there. **Control:** the same assertion run against `netWorth` must *fail*
   to be identical. Without that pairing, the test passes just as happily if the
   liquidity metrics are broken, zero, or not computed at all — the exact failure the
   offset-yield work walked into.

7. **The control-scope flip is pinned by MECHANISM, not by value** (§5.4a).
   `tests/unit/control-scope.test.mjs` sweeps a synthetic policy set in which
   `terminal worth = U + L(policy)` and asserts that a target below `U` corners the
   worth-scoped goal at maximum spend while the liquid-scoped goal on the same sweep
   lands on its target from the interior. **Control:** a third case asserts the two
   scopes AGREE when the target is below both floors — without it, the first two would
   pass for a sweep that simply favours one end.

### 9.1 Outcome (2026-08-07)

All of the above are implemented in `tests/unit/speculative-assets.test.mjs` (18
cases) and the two goldens; the full suite is green (4,661 unit + 1,017 viz).

Two results worth recording rather than merely claiming:

- **(1) holds exactly.** `golden-cross-border-reference.json` is untouched by phase 1
  — not "within tolerance", unmodified. The reference plan holds a company stake and
  publishes no after-tax metric, so even the D5 branch leaves it alone.
- **The controls were checked by MUTATION, not by assertion.** An absence test that
  has never been seen to fail is not evidence. Deleting the `speculative` projection
  from the company-equity toolset (§7 trap 2, the design-76 Gap A failure shape) turns
  8 of the 18 cases red, including the §5 control, which reports that the two arms
  have become indistinguishable rather than silently passing. Separately, dropping the
  flag from the CUBE only fails the recognition invariant and leaves the disclosure
  invariant green — the exact localisation §6 predicts, confirmed rather than
  reasoned.
- **(5) holds:** `golden-coverage-manifest.js` did not move, even though the
  conversion golden fires the whole `COMPANY_SALE` path.

### 9.2 Phase 2 outcome (2026-08-07)

Suite green at 4,667 unit + 1,017 viz. No fixture moved: the goldens do not run MPC,
so the default flip is invisible to them — which is worth stating, because it means
**the goldens are not evidence about the flip** and the §5.4a arms are.

The measurement took three attempts, and the two failures are the more useful record:

1. The first harness read params from `buildDefaultConfig`'s `parameters` bag, which
   holds 37 keys and no `spendingExpenseBands` — so the SPENDING lever's path write
   landed on nothing. Both arms returned identical advice.
2. The second armed the band table but not `spendingStrategy: EXPLICIT_BANDS`, which
   is what `SPENDING.appliesTo` actually gates on. Both arms returned identical advice
   again — for a different reason.

Twice, "the two scopes make no difference" was a broken harness, and both times it
looked exactly like a finding. Only the third attempt, which asserts the lever moves
the terminal measures BEFORE comparing the arms, produced the table in §5.4a. Any
future re-measurement should keep that lever check as the first thing it prints.

---

## 10. Open questions

**OQ1 — should the flag suppress the asset from `cumulativeConsumption` planning
inputs? CONFIRMED INERT (phase 2), but the sharper question is now answered too.**
Nothing routes assets into the consumption accumulators, so the flag has nothing to
suppress there, and D8's inheritance covers the terminal side. The version of this
question that mattered was the D10 one — whether a spending ceiling should be read off
a *worth*-scoped anchor at all — and the §5.4a measurement settles it: on the
reference plan a worth-anchored goal recommends \$12,000/mo where a liquid-anchored one
recommends \$4,773/mo. A published ceiling is a control output. It follows the control
scope.

**OQ2 — accounts.** A speculative *account* (an illiquid crypto position, a
restricted stock plan modelled as a balance) is a coherent request, and D3 defers it
purely because drawdown eligibility makes it a harder question. The likely answer is
that a speculative account must have `drawdownPriority: null`, i.e. the same rule as
D4, at which point most of the machinery already works. Not scoped here.

**OQ3 — should `speculative` be sweepable?** Turning it into an MC/opt axis would
let the optimizer answer "how much does the plan depend on this tranche paying off?",
which is a genuinely good question. But it is a *binary* axis over a structural
field, which neither the CEM solver nor the MC sampler handles naturally, and §11's
haircut is a better-shaped answer to the same question. Explicitly out of scope; do
not add it by accident when phase 2 touches the editor.

**OQ4 — bequests. ANSWERED (phase 2): it did need the field.** `bequest-service.js`
synthesises the zero-valued seed for an inherited asset in two hand-written
projections (`_seedFromRecord`, `_seedPlain`), neither of which carried `speculative`
— the §7 trap-2 shape again, and it would have made the flag inert for exactly the
assets most likely to deserve it. Both now carry it, when true.

**OQ5 — what breaks when the default terminal scope flips to liquid? ANSWERED
(phase 2); the flip is shipped.** (a) The gap between the two measures on the
reference plan is `U` = \$2.38M real, 36% of terminal worth — see §5.4a for the full
table. A target authored against worth is indeed the larger number, so re-reading it
as a liquidity target does tighten the plan; the flip is therefore a **behaviour
change to be announced, not a silent improvement.** (b) Nothing is silently
re-pointed: every caller that names an objective explicitly (the lab scripts, the
MPC/OPT tests) keeps what it names, and exactly ONE assertion in the suite pinned the
old default — `objectives.test.mjs`, now updated with the reason attached so it is not
flipped back by tidying. (c) **No migration.** A stored `terminalWealthTarget` is a
number the planner chose; silently rescaling it by `U` would be the model inventing an
intent. A release note plus the two visible scope selects (which now read "Net
Liquidity" and "Net Worth (reporting scope)") is the honest treatment.

**OQ6 — is there a control-scope analogue of `netWorthInclSpeculative`? ANSWERED
(phase 2): yes, and it needed no new metric.** The worth-scoped measures ARE the
disclosure view of the control question, so the scope axis now labels them as such —
"Net Liquidity" versus "Net Worth (reporting scope)" — rather than presenting two
peers and letting the reader guess which one the solver is steering. No fifth measure
was added.

---

## 11. Why not a probability haircut — yet

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
