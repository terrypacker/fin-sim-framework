# 84 — Roth IRA under s99B: decant before the move, or hold and pay Australia?

**Status** (2026-07-31, `main`): **PROPOSED**

| gap | what | status |
|---|---|---|
| **G1** | the after-tax metric prices a Roth dollar at par regardless of residency | **IMPLEMENTED** (2026-07-31) |
| **G2** | `earningsBasis` is mark-to-market appreciation, not "amounts derived by the trust estate" | **PROPOSED** |
| **G3** | Roth-attributable AU tax is not observable — it lands in the undifferentiated ordinary-income bucket | **IMPLEMENTED** (2026-07-31) |
| **G7** | an age-eligible Roth drawn by the ordinary drawdown path emitted no withdrawal-tax action, so s99B was never assessed | **IMPLEMENTED** (2026-07-31) |
| **G9** | converted principal drawn on the generic path is invisible to the basis ledger, so its s99B-assessable slice escapes too | **IMPLEMENTED** (2026-08-04) — and the bias ran the *other* way |
| **G11** | a conversion lot's s99B corpus stamp treats pre-tax IRA principal as corpus, contradicting the US charge on the same dollars | **OPEN — larger than G9, and points the other way** |
| **G10** | the spouse's AU return does not foot in 9 years — credits appear on the return but are not reflected in the net | **OPEN — pre-existing, not design 84's** |
| **G8** | a market shock revalues the balance without adjusting the basis ledger, stranding phantom `earningsBasis` | **OPEN** |
| **G4** | no first-class lever for the Roth leg of the decant schedule | **IMPLEMENTED** (2026-07-31) |
| **G6** | the decant's landing account is resolved by role, first match wins — and an owner with no `us-stock` account is skipped in silence | **IMPLEMENTED** (2026-07-31) |
| **G5** | `moveYear` is a confounded axis in any scenario with an inflation differential and a dated shock | **PROPOSED — method** |

### Where this stands (read first)

**The question is not settled, and the early answer was wrong.** P4, run in the scenario as
authored, said "empty the wrapper early, +4.1%". P5 paired that against three controlled
worlds and the **sign reverses** once the authored scenario's dated crash is removed or
moved: in an uninterrupted market, holding usually wins. The reason is not a tax effect at
all — it is the tax-free compounding the decant gives up, which is worth more than the
s99B charge avoided when returns are good. **The decision is a bet on the return path**,
so a single deterministic run of any kind cannot answer it. P6 (stochastic paths, paired
rescue/reverse counts) is mandatory, not a robustness garnish.

**The one strategy that survived every world tested**: defer the move past the *later* of
the two owners' 59½ gates and empty the wrapper penalty-free just before moving, so the
earnings never become s99B income. Robust in sign, not in magnitude (+0.30% in the
weakest world), and it trades against everything else a deferred move affects.

**Reproduce**: `variant-grid --spec` the two specs in the gitignored `scripts/specs/`,
then `scripts/lab/paired-delta.mjs --pair decant`. Never read the level table for the
move-year grid — see §7b.

**The open gaps still bias the numbers**, and not all the same way: G2 and G8 overstate
the cost of holding (flattering the decant); **G11** understates it (flattering the hold),
and it is the big one now — bigger than G9 was. None is large enough to explain the sign
reversal, which is a return-path effect, but the margins should not be quoted to two
significant figures until G11 is settled.

**G9 is closed, and closing it moved the answer the opposite way from the prediction.**
This document said G9 understated the cost of holding. On the plan it does the reverse:
the leak was letting converted principal escape the ledger *and* the ordering was drawing
assessable earnings when §408A(d)(4)(B) says converted principal comes out first. Fixing
both took the hold arm's lifetime s99B charge **down** 6%, from A\$341,394 to A\$320,908.
The prediction was wrong because it assumed the escaping money was assessable; most
converted principal is corpus. What it exposed instead is G11, which is where the real
understatement lives.

---

Scope: the **Roth IRA only**, for a US citizen who becomes an Australian resident. Not
Roth *conversions* — the "should we keep converting into a wrapper Australia doesn't
recognise" question is a separate study and is deliberately excluded here (§8 Q2). Not
the FTC machinery (design 83), not FITO (design 52), not super (design 77).

This doc exists because the engine already models both sides of the trade correctly and
has done since design 45 — but the metric we would naturally score the trade with is
wrong in the one direction that matters, so a study run today would produce a confident
number pointing the wrong way.

---

## 1. The question

A US citizen holding a Roth IRA moves to Australia. Two ways to get the money out:

- **Hold.** Leave it in the wrapper and draw it down as an Australian resident. The US
  charges nothing on a qualified distribution. Australia charges ordinary income tax on
  the earnings, with **no foreign tax credit**, because there is no US tax to credit.
- **Decant.** Empty the Roth *before* the residency change, accept the IRC §72(t) 10%
  additional tax on the earnings, and land the proceeds in a taxable brokerage account
  where the s855-45 residency step-up will forgive every dollar of pre-move gain.

The naive framing — "10% penalty now versus Australian marginal rates later" — understates
the case for decanting, because it compares the penalty against tax on *today's* earnings.
The real quantity on the other side is tax on **every dollar of growth the wrapper will
ever produce**, compounding across the whole remaining horizon, at ordinary rates, with no
relief. The penalty is a one-off charge on a stock; the s99B exposure is a claim on a flow.

There is a third way out that the naive framing hides entirely: the §72(t) charge
disappears at 59½. If the move can be deferred past the **latest** 59½ gate among the Roth
owners, every wrapper can be emptied at **zero** US cost and zero Australian cost, because
the distribution happens while still US-resident. Whether that is worth the deferral is an
empirical question about everything else in the plan, which is why `moveYear` has to be an
axis of the study rather than a constant.

---

## 2. The documents

Primary authority, checked into `docs/`:

| file | what it is | why it matters |
|---|---|---|
| `docs/au-tax/ITAA-1936/C2026C00333VOL02.txt` | ITAA 1936 **s99B**, s99C | the operative charge on trust distributions |
| `docs/au-tax/ITAA-1997/C2026C00324VOL09.txt` | ITAA 1997 **s855-45** | the residency cost-base step-up and deemed acquisition |
| `docs/au-tax/ITAA-1997/…` Div 115 | the 50% CGT discount | the 12-month clock the deemed acquisition restarts |
| `docs/us-tax/…` | IRC §408A(d)(1), §72(t) | qualified distributions; the 10% additional tax |

Both ITAA compilations are current (compilation date 01/07/2026). Note the standing
constraint from prior work: **ato.gov.au and AustLII return 403 to programmatic fetch**,
so anything not already on disk has to be obtained as a PDF and run through
`pdftotext -layout`, or flagged unverified. Do not transcribe a rate or threshold from our
own output — reproduce it from the authority.

---

## 3. What the engine already gets right

This section exists so the study does not re-litigate settled ground.

**The s99B charge.** `us-tax-module-2026.js` `_rothReducerFns()` books distributed Roth
earnings as `auOrdinaryIncomeYTD` when the owner is an AU resident, and — deliberately —
feeds **no** US-source removal set, because the US levies no income tax on those earnings
and there is therefore nothing for the FITO limit to relieve. Contributions withdrawn are
booked with no tax action at all. That is the corpus/income split of s99B(2)(a) and it is
correct.

**The decant mechanism.** `design/45` (Implemented, Phases 1–4) built the scheduled
early-withdrawal lever for exactly this manoeuvre; read the header of
`early-withdrawal-classes.js`. It draws Roth **contributions first, then earnings**,
applies the penalty to the earnings slice only (`AccountService.earlyWithdrawalTaxActions`),
and lands the net cash in the destination brokerage at cost basis = market value, which is
the per-lot state the residency step-up keys off. The lever is reachable three ways: the
`earlyWithdrawalSchedule` param, the `EARLY_WITHDRAWAL` cockpit control, and the joint MPC
decision vector.

**The step-up.** `residency-cost-base-policy.js` encodes s855-45 as a per-country flag, and
the FIFO consumption path applies it per lot.

**The 12-month clock.** s855-45(3) deems the asset *acquired* at the residency date, which
restarts the Div 115 holding period. `holdings-fifo.js` measures discount eligibility from
the country's deemed-acquisition date and excludes lots sold within 12 months of the move.
This is a real cost of decanting that the engine already charges: a decanted asset sold
soon after the move gets **no** 50% discount. It is not a gap; it is a term in the answer.

**Conversion provenance.** `roth-conversion-classes.js` stamps each conversion lot with the
IRA-earnings portion as `taxableAmount`, denying it the s99B corpus exemption on the way
out. The model will not let a conversion launder pre-tax money into Australian-exempt
corpus. (Out of scope here, but it means the exclusion in §8 Q2 is an exclusion of a
*question*, not of a modelled effect.)

---

## 4. The statutory mechanism, and where the asymmetry comes from

s99B(1) charges a beneficiary who "was a resident at any time during the year of income" on
any amount of trust property paid to or applied for their benefit, subject to the s99B(2)
reductions. s99B(2)(a) reduces the charge by so much of the amount as represents

> corpus of the trust estate (**except to the extent to which it is attributable to amounts
> derived by the trust estate that, if they had been derived by a taxpayer being a resident,
> would have been included in the assessable income of that taxpayer**)

Two consequences follow directly from that parenthesis, and both matter.

**First: there is no residency-date shelter.** The carve-out is not time-limited. Trust
income that was derived and then capitalised into corpus stays caught, whenever it was
derived. A natural hope — that earnings accumulated *before* arriving in Australia have
become corpus by the time you get there — does not survive the text. The engine's
conservative treatment (all distributed earnings assessable, regardless of when they
accrued) is therefore not merely conservative; it is what the section says. **This closes
what would otherwise have been the study's largest open sensitivity.**

**Second: the charge is on *derived* amounts, not on appreciation.** This cuts the other
way, and the engine currently ignores it — see G2.

The asymmetry that drives the whole result is between two provisions:

| | held in the Roth | held in a taxable account |
|---|---|---|
| pre-move growth | assessable on distribution under s99B(2)(a) | **forgiven** — cost base reset to market by s855-45(2) |
| post-move growth | ordinary income, no discount | capital gain, 50% discount after 12 months |
| foreign tax relief | **none** (no US tax to credit) | n/a |

The wrapper that is tax-privileged in the US is the *only* asset class in the plan that
receives no residency step-up and no discount. That is the entire thesis, and it is a
statutory artefact rather than a modelling artefact.

---

## 5. The gaps

### G1 — the after-tax metric prices a Roth dollar at par regardless of residency

**IMPLEMENTED 2026-07-31** — see "What landed" at the end of this section.

`derived-metrics/after-tax.js` classified `roth-ira` as
`TAX_CLASS.ROTH`, commented *"qualified, tax-free"*, and discounts it by nothing.
`taxClassForRole(role, { residency })` accepts a residency argument that the file states is
**unused in Phase 1**, wired only so a residency-aware classification could land later
without a signature change.

For an Australian resident a Roth dollar is not tax-free. Its earnings portion carries a
full ordinary-rate liability with no credit — arguably the *worst*-taxed dollar in the
household, worse than a 401(k) dollar, which at least gets FTC relief.

So `computeAfterTaxNetWorth` systematically **overvalues the hold arm** — precisely the arm
under test. Scoring the study on it unmodified would bias the result toward "leave it in",
by an amount that grows with the horizon.

This is Phase 2 of the seam design 40 already anticipated. The fix:

- make `taxClassForRole` residency-aware, or (better, since the class taxonomy is about the
  *asset* and residency is about the *holder*) leave the class alone and make the rate
  provider answer a non-zero ordinary rate for `TAX_CLASS.ROTH` when the owner is AU-resident;
- discount only the **earnings** portion, not the balance — the corpus genuinely does come
  out free, and discounting the whole balance would over-correct and bias the study the
  other way;
- extend `liquidationRateProvider` (Option C) to route the Roth earnings slice through
  `computeAuTax` via the existing `engineDelta` helper, so the rate is the true marginal
  rate at that year's brackets rather than a configured constant.

That last point matters more than it looks: the Option-A fallback rate for AU ordinary
income is a **study input**, and if it is set below the household's real marginal position
it under-prices the embedded liability everywhere in the plan, not just in the Roth. Check
it before running anything, and state the value used in the run notes.

This is a correctness fix to a shared metric that four other things read. It ships as its
own change with its own tests, not folded into the study scaffolding.

**What landed.**

- **Classification stayed put; pricing moved.** `taxClassForRole`'s `residency` argument is
  still unused, and that is now a settled decision rather than a pending phase: a tax
  *class* describes the asset, residency describes the *holder*, and the same Roth is two
  different things to two owners. Baking residency into a global role→class map cannot
  express a household where one spouse has moved and the other has not. The residency test
  therefore lives in `computeAfterTaxValue`'s ROTH branch, reading `account.ownerId`
  (primary as fallback — the convention `RothWithdrawalEarningsHandler` already uses).
- **Current residency, not planned residency.** The metric is a "liquidate today"
  valuation, so a Roth held by a US resident is still par even when a move is scheduled.
  That is not an approximation: a Roth emptied while US-resident genuinely is tax-free, and
  pricing a pre-move Roth as if the move had happened would erase the very gap the decant
  exists to exploit.
- **Only the assessable slice is discounted**, the same shape as `SUPER`: corpus at par,
  earnings at the AU rate. Plus the IRA-earnings portion of any converted principal, which
  s99B(2)(a) denies the corpus exemption and which `roth-conversion-classes.js` already
  stamps per lot as `taxableAmount` — so the metric charges exactly what EVT-43 charges.
  Clamped to the balance so a stale ledger cannot manufacture negative corpus.
- **A new `rothLiquidationRate` on the provider contract**, rather than reusing
  `ordinaryLiquidationRate`. That mattered: the existing entry picks US-vs-AU by the
  *account's* domicile, and a Roth wrapper is US-domiciled, so it would have answered the
  US rate for an Australian charge. Option A answers the configured AU rate; Option C routes
  the slice through `computeAuTax` for the true marginal rate. Providers predating the
  entry fall back to `ordinaryLiquidationRate`, so the contract stayed back-compatible.
- **FX**: Option C converts the USD slice with `toAUD` before stacking it on
  `auOrdinaryIncomeYTD`. Without that the slice lands in too low a bracket and the rate
  comes back understated; the returned ratio is currency-neutral, so callers apply it to
  the USD amount unchanged.
- **Unknown owner, or no `state.people`, ⇒ par** — the conservative no-op that never
  over-discounts, matching the module's existing fallback discipline.

**Two pre-existing tests reversed, and the reversal was the point.** Design 40's
conversion-gradient test and design 41's windowed-horizon test both assert that converting
raises after-tax net worth. Both broke, because the synthetic reference scenario moves
US→AU in 2031 and both score a terminal *after* that move. Under the corrected metric,
converting into a wrapper Australia does not recognise stops being free money. Both tests
were pinned to a US-domestic framing (`moveYear` past the horizon), which is the framing
their claims were established in and keeps each testing its own subject; the cross-border
reversal is now asserted deliberately, in its own test, in `after-tax.test.mjs`. See Q2.

### G2 — `earningsBasis` is appreciation, not "amounts derived by the trust estate"

Design 53 §8 made `earningsBasis` a **derived** quantity, maintained under the invariant
`contributionBasis + earningsBasis == balance`. It is therefore mark-to-market
appreciation: everything the account is worth beyond what was put in.

s99B(2)(a) charges corpus only to the extent attributable to *amounts derived by the trust
estate*. Unrealised capital appreciation has not been derived by anyone. What the trust
actually derives is dividends, interest, and **realised** gains from sales inside the
wrapper.

The engine therefore over-assesses a buy-and-hold Roth and is insensitive to a lever that
should be powerful. Consider: rebalancing inside a sheltered account realises gains, and
realised gains are derived income. The `rebalanceDriftBandSheltered` param — which exists to
control tax-free churn, and which is *currently understood as tax-irrelevant because the
wrapper is sheltered* — silently manufactures s99B assessable income for an Australian
resident. A tighter band means more derived income means a larger eventual charge. Under the
present model that effect is invisible.

Two honest positions:

1. **Model it.** Track derived income inside the Roth separately from appreciation:
   dividends and interest as they accrue, realised gains as rebalancing and drawdown
   consume lots. The holdings layer already carries per-lot cost basis, so the realised-gain
   half is mostly plumbing on the existing FIFO path. Assess only that pool under s99B; the
   residue is genuine corpus.
2. **Don't, and say so.** Keep the conservative treatment, note that it is an upper bound
   on the hold arm's cost, and record that the gap biases the study *toward* decanting.

The honest thing for this study is (2) with the bias stated, then (1) as follow-up work —
because (1) is a fidelity project of its own and would delay the decision this study exists
to inform. But the bias direction must be in the write-up: **the study, as it will be run,
overstates the case for decanting.** If decanting still loses, that conclusion is robust. If
it wins narrowly, the margin is inside the modelling error and the answer is "not proven".

### G3 — Roth-attributable AU tax is not observable

`bookAuResident` folds Roth earnings into `auOrdinaryIncomeYTD` alongside every other
ordinary receipt. There is no line item, and the AU return has no Roth row. Consequently a
single run cannot say what the Roth cost; only a *difference between arms* can.

That is adequate for the decision and useless for the explanation. A study that reports
"decanting wins by X" without being able to say which years and which brackets it won in is
not a document anyone can act on or check.

The fix is a reporter, not an engine change — see §6.2. The raw material already exists:
`TaxSettleService.computeAuTax(state)` is callable standalone, and `liquidationRateProvider`'s
`engineDelta` already demonstrates the technique of computing a liability with and without a
slice of income to recover that slice's true **marginal** rate.

### G7 — the hold arm is free, because the charge is never emitted

**Blocks the study.** Found by the G3 reporter on its first real run, which is the
clearest possible argument for having built it.

`AccountService._drawPenaltyFree` handles a ledger-bearing retirement account drawn
while **age-eligible**. It emits the withdrawal-tax action each type owes, passing
`residency` so the tax module can decide the cross-border consequence — for IRA, 401(k)
and super. For a Roth it emits nothing, on the strength of a comment:

```js
// ROTH (qualified, age-eligible) is tax-free → no action.
```

True in the US, and the reason the omission survived. False for an Australian resident,
for whom the wrapper is a foreign trust and the earnings are s99B ordinary income.

The consequence is not marginal. Past 59½ the Roth becomes penalty-free-eligible, so the
**ordinary drawdown path** — the involuntary `replenishSavings` route that funds spending
and tax bills — drains it through exactly this branch. Measured on the base plan's hold
arm: hundreds of thousands of dollars leave the wrapper across eight AU-resident years
and the run emits **zero** `ROTH_WITHDRAWAL_EARNINGS_TAX` actions over its entire
horizon. Australia assesses nothing.

So the hold arm currently costs nothing, and a study run today would conclude that
holding a Roth through a move to Australia is free — the exact opposite of the truth,
stated with total confidence. Every other gap in this document biases the answer by some
amount; this one inverts it.

**The fix** is one case, mirroring its siblings:

```js
switch (account.type) {
  // …IRA, 401k and super cases, each passing `residency`…
  case ACCOUNT_TYPE.ROTH:
    if (fromEarnings > 0) pendingTaxActions.push({
      type: 'ROTH_WITHDRAWAL_EARNINGS_TAX', amount: fromEarnings,
      penaltyAmount: 0, residency, stateKey: account.stateKey ?? key,
    });
    break;
}
```

`penaltyAmount: 0` because this branch is by definition the age-eligible one. Behaviour
for a US resident is unchanged: the reducer books the AU income only when
`residency === 'AU'`, so a US-resident qualified distribution still costs nothing.
`stateKey` carries the design 76 per-person attribution the AU return needs.

Note this is a **tax-charge** change on a shared path, so it will move any golden that
holds a Roth into age-eligibility while AU-resident. That is the change being correct,
not a regression — but the goldens need re-reading rather than blind re-baselining.

**What landed (2026-07-31).** The case above, plus the comment block explaining *why* a
service must not decide for itself that a distribution is untaxed — every sibling case
passes `residency` and leaves the cross-border consequence to the tax module, and the
Roth case was the one exception.

Exactly **one** test in the suite broke, and it was the test that encoded the bug:
`EW-3: Roth earnings at or above age 59.5 — no penalty` asserted
`pendingTaxActions === []`, conflating "no penalty" with "no action at all". Its real
claim — no §72(t) — still holds, so it now asserts the action's *shape* (one earnings
action, `penaltyAmount: 0`, `residency` carried) and a companion `EW-3b` pins the
AU-resident case that would have caught this. No golden moved: the reference scenarios
never reach age-eligibility holding a Roth while AU-resident, which is also why this
survived so long.

**Measured effect on the base plan's hold arm** — the quantity the whole study turns on:

| | before | after |
|---|---|---|
| Roth earnings assessed in AU | A\$0 | **A\$1,575,239** |
| AU tax attributable to the Roth | A\$0 | **A\$341,394** |
| effective rate on the slice | — | 21.7% |

**The reporter's leak check stays**, and it is what found G9 below: it cross-checks each
AU-resident year's balance fall against the withdrawals booked and prints an explicit
"the hold arm is the one it flatters" warning when they disagree. It went from firing on
eight years to firing on one.

### G9 — converted principal escapes the same way

G7's remaining half, and the reason the leak check still fires on one year.

`reduceLedgerForWithdrawal` — the ledger split the generic drawdown path relies on —
knows only `contributionBasis` and `earningsBasis`. It caps the draw at their sum and
ignores `rolloverContribBasis` entirely. On a Roth holding converted principal the
balance therefore exceeds the ledger, and the excess leaves the wrapper represented
nowhere: no basis reduction, no `ROTH_ROLLOVER_WITHDRAWAL_*` action, no assessment.

Most converted principal *is* s99B corpus and legitimately comes out free, so the
escaping amount is not the whole rollover — it is the portion attributable to the source
IRA's earnings, which `roth-conversion-classes.js` already stamps per lot as
`taxableAmount` for exactly this purpose, and which the EVT-43 reducers already know how
to assess. The actions and the data exist; only this path fails to emit them.

Fixing it properly means consuming the `rolloverConversions` lots in order and emitting
per-lot actions, matching EVT-43's semantics (including its §408A(d)(3)(F) five-year
clock) — more than the one-case change G7 needed, which is why it is filed separately.

Note also that `reduceLedgerForWithdrawal`'s doc comment claims it preserves
`contributionBasis + earningsBasis == balance`. That invariant does not hold for an
account with rollovers — design 53 §8 defines `earningsBasis` as
`balance − contributionBasis − rollovers` — so the comment is describing a
rollover-free account without saying so.

**What landed (2026-08-04).**

- **`computeConversionRecapture` moved to its own framework-free module**
  (`roth-conversion-lots.js`) and `AccountService` now shares it with the EVT-43
  reducer. The two paths cannot drift on the FIFO order, the five-year window, or
  the pro-rata `taxableAmount` because there is only one of each.
- **`reduceLedgerForWithdrawal` knows all four layers** and draws them in the
  statutory §408A(d)(4)(B) order: regular contributions → converted principal (FIFO
  by lot) → earnings. The ordering turned out to matter more than the leak (below).
  The two earnings pools are drawn `earningsBasis` first; the choice is arbitrary
  and documented as such, because both are s99B income and both carry §72(t), so no
  tax consequence turns on it.
- **Both drawdown paths emit the EVT-43/44 twins**, on EVT-43's own emit test —
  only when there is a recapture penalty or an AU-assessable share, so a US-resident
  distribution of seasoned corpus still puts nothing in the journal.
- **The mirror-image defect in the involuntary under-age branch, found while fixing
  this.** `replenishSavings` phase 2 declared the whole post-contribution residue to
  be "earnings", which on a wrapper holding conversions charged §72(t) and full s99B
  against money that is mostly corpus, and decremented only `earningsBasis` so the
  rollover buckets were stranded. Same fix, opposite sign.
- **The gross-up became a fixed point.** Once part of an early draw is unpenalised,
  `netNeeded / (1 − penaltyRate)` over-draws. The penalty is monotone in the gross
  with slope ≤ the rate, so iterating converges in a few passes; where the whole
  draw *is* penalised the fixed point is exactly the old division, which is why no
  golden moved.
- **The reporter's leak check counted only earnings actions**, so once the drawdown
  could finally reach converted principal it flagged every corpus distribution as an
  escape. It now counts the rollover corpus falling, and the table carries a
  `convtd $` column — because "how much of this wrapper is conversions" is the
  question that decides whether a year's withdrawal is assessable at all.

Full suite green (4304 unit + 975 viz); no golden moved, because the reference
scenarios never draw a rollover-bearing Roth.

**Measured on the plan's hold arm, and the direction is not the one predicted above:**

| | before | after |
|---|---|---|
| leak check | fires on 2040: −\$175,158 balance, \$92,107 booked, **\$83,050 unexplained** | **silent** |
| Roth earnings assessed in AU | A\$1,575,239 | A\$1,510,561 |
| AU tax attributable to the Roth | A\$341,394 | **A\$320,908** |
| effective rate on the slice | 21.7% | 21.2% |

Holding got **cheaper**, by A\$20,486 over the lifetime. The paragraph above predicted
the opposite, and the reason it was wrong is worth keeping: it assumed the escaping
money was assessable. It is not. Most converted principal is corpus, so the leak was
letting *corpus* escape a ledger that was then drawing *earnings* in its place — two
errors that partly cancelled in cash and did not cancel at all in tax. The ordering fix
is what moved the number; the leak fix is what made the ledger tie.

Which raises the question the fix could not answer on its own: is this plan's converted
principal really corpus? See G11.

### G11 — a conversion lot's corpus stamp contradicts the US charge on the same dollars

Found by G9, and **larger than G9**. Not fixed — it is a modelling decision, not a bug
with one obvious repair, and it moves the study's headline.

`RothConversionApplyReducer` stamps each lot's s99B-assessable share as

```js
const fromContrib   = Math.min(amount, ira?.contributionBasis ?? 0);
const taxableAmount = Math.min(amount - fromContrib, ira?.earningsBasis ?? 0);
```

i.e. it treats the source IRA's **contribution basis as after-tax money** and therefore
as s99B corpus. Meanwhile the very same reducer chains `ROTH_CONVERSION_TAX` for the
**whole** `amount`, and the US module books all of it as ordinary income.

Both cannot be right. In this engine a Traditional IRA is entirely pre-tax:
`IRA_CONTRIBUTION_TAX` books every contribution to `usNegativeIncomeYTD`, a deduction,
and a 401(k) rolled in carries its pre-tax `contributionBasis` across unchanged. There
is no non-deductible §408(o) / Form 8606 basis in the model. So `contributionBasis` on a
Traditional IRA is deferred wage income that has never been taxed anywhere — and money
that "would have been included in the assessable income of a resident who derived it" is
exactly what s99B(2)(a) refuses the corpus exemption to. The US stamp is right and the
s99B stamp is wrong.

**It is not hypothetical on this plan.** Traced through the engine:

```
2027-01-01  K401_TO_IRA_CONVERSION  the whole 401(k) rolls into the IRA,
                                    carrying $165,704 of PRE-TAX contribution basis
2028-12-01  ROTH_CONVERSION_APPLY   $164,440 converted — drawn from that basis,
                                    so the lot is stamped taxableAmount: 0
2028-12-01  ROTH_CONVERSION_TAX     $164,440 — the whole amount, US ordinary income
```

So the plan carries \$164,440 of converted principal that Australia currently cannot
touch, on the strength of a stamp that the same event contradicts. And after G9 that
principal is the **first** thing the drawdown consumes: the `convtd $` column runs flat
at \$168k from 2028 to 2036 and empties across 2037–2039, ahead of every assessable
dollar. The hold arm's cheapest years are cheap because of this.

Order of magnitude if the stamp were corrected: roughly A\$250k of additional assessable
income landing in years whose marginal rates run 15–40%, so **A\$50–90k of extra lifetime
tax on the hold arm** — three to four times the size of G9's effect, in the opposite
direction. That is enough to matter to the decision, which is why it should be settled
before P6 rather than after.

The fix itself is small — stamp `taxableAmount` at the full conversion amount, matching
what `ROTH_CONVERSION_TAX` already charges — but it is a *tax-treatment* change on a
shared path and needs its own decision, its own tests, and a golden re-read. The one
argument for the present behaviour is a user who seeds `contributionBasis` on a
Traditional IRA meaning "my after-tax Form 8606 basis"; if that reading is to be
supported it needs its own field, not a silent reinterpretation of a field the rest of
the engine treats as pre-tax.

### G8 — a shock revalues the balance but not the basis ledger

Also surfaced by the G3 reporter, which printed an `earningsBasis` larger than the
balance it belongs to — impossible under the design 53 §8 invariant
`contributionBasis + earningsBasis == balance`.

`REVALUE_ASSET_APPLY` (the dated market shock) cuts the balance and the holdings
together but leaves `contributionBasis` and `earningsBasis` untouched. The loss is
therefore charged to nobody: on the base plan's Roth the crash removes a large slice of
value while `earningsBasis` keeps its pre-crash figure, and the excess is still sitting
there, stranded, decades later on an account whose balance reached zero.

A crash should consume earnings before corpus — the loss falls on the gain first. Leaving
the ledger untouched instead overstates `earningsBasis` relative to the money actually
present, which misclassifies later withdrawals as earnings when part of them is corpus,
and over-assesses the design 84 G1 metric (clamped to balance, so conservative, but
wrong). Both errors push the same way: they **overstate the cost of holding**, on top of
the G2 bias that already does.

Distinct from G7, and not blocking — G7 inverts the answer, this one shades it — but it
should be fixed before the margin is quoted to two significant figures. Likely wider than
the Roth: any basis-bearing account revalued by a shock has the same shape.

### G10 — the spouse's AU return does not foot

Found by running the standing "cross-foot after touching the tax path" check following
G7. **Not caused by G7** — verified by re-running the same check against the immediately
preceding commit, which produces the identical nine violations. Recorded here because
this is where it surfaced, not because it belongs to this design.

`export:tax --check` reports nine years where the **spouse's** AU individual return fails
the design 71 §6 footing invariant, in the shape `Gross X + credits −Y != net`. Three
distinct patterns appear: net equal to gross with the credit ignored entirely; net
partway between; and credits fully offsetting gross while net stays positive. The
primary's return foots in every year, so this is specific to the **per-person** split
(design 76) rather than to the AU module — the likely suspect is credits being computed
household-wide and attributed on a different basis than the gross they offset, which is
also the shape of design 77's unresolved "Medicare levy IS creditable" note.

Magnitude is small — the largest violation is four figures in AUD against a lifetime Roth
charge in the hundreds of thousands — so it does not move any conclusion in this
document. It does mean the per-person AU return is not currently trustworthy as a
line-by-line artifact, which matters for anything that reads the return rather than the
netLiability total.

### G4 — no first-class lever for the Roth leg of the decant

`earlyWithdrawalSchedule` is an array of per-year objects carrying both a `taxDeferredAmount`
and a `rothAmount`. Driving the Roth leg through `variant.mjs`'s generic `params` escape
hatch means hand-writing the entire array per grid cell, which (a) is unreadable in a spec
file and (b) clobbers whatever the scenario had authored on the tax-deferred leg. Both legs
compete for the same pre-move years and the same cash, so silently destroying one while
sweeping the other would produce a study that measures the wrong interaction.

See §6.1.

**What landed.** `applyRothDecant` in `scripts/lib/variant.mjs`, wired into `buildVariant`
as `rothDecant: { startYear, endYear, annual | 'EMPTY', owners, destinationKey }`. Merges
onto the authored schedule year-by-year, preserving each year's `taxDeferredAmount` and its
own `destinationKey`; writes both param stores; enables the master switch only when the
amount is positive, so a zero-amount control arm does not switch on a lever the scenario
left off. 19 tests, four of which drive the real toolset — a lever that writes a param
nothing reads is the failure mode that produces a grid where every cell is identical.

Three behaviours the docstring warns about, because each can be misread as a *tax* result:

- **Amounts are per owner.** `owners: 'both'` draws `annual` from each person's wrapper.
- **A partial decant spends corpus first.** `reduceLedgerForWithdrawal` draws contributions
  before earnings, and contributions are already outside both s99B and §72(t). So a decant
  smaller than the contribution basis moves the tax-free half and reduces the Australian
  exposure by **nothing**, while still looking like action in the journal. Expect a flat
  region at the bottom of any `annual` sweep and do not read it as "the decant does not
  help". A wrapper that is all earnings and no basis has no flat region at all — which is
  why per-owner basis *composition* drives this more than balance does.
- **Where the cash lands is resolved by role, first match wins** — see G6.

### G6 — the decant's landing account is resolved by role, first match wins

Found while testing G4, and it is the kind of defect that produces a confident wrong
answer rather than an error.

`schedules()` resolves the destination as "that owner's first `us-stock` account" and, on
finding none, `continue`s — emitting **no event for that person, silently**. Downstream
that reads as "decanting this person's Roth changes nothing", which is a tax conclusion
drawn from a missing account. The synthetic reference household has exactly this shape: a
spouse with a Roth and no brokerage of their own.

`applyRothDecant` now rejects that case outright rather than letting it through. But the
first-match half remains open and cannot be fixed in the lever, because a schedule entry's
`destinationKey` applies to **every owner in that year** — a per-owner destination is not
expressible in the current schedule shape. In a household where one owner holds several
taxable accounts, or where their only `us-stock` account is a special-purpose sleeve rather
than a diversified brokerage, the decant's post-move growth path — and therefore the answer
— depends on an account nobody chose.

**What landed (2026-07-31).** The per-owner destination map — the third and most useful
of the three options originally listed, chosen because one household-wide destination is
wrong whenever the owners' taxable accounts differ in character. A schedule entry's
`destinationKey` now takes either form:

```js
const everyOwner = { destinationKey: 'usStockAccount' };
const perOwner   = { destinationKey: { primary: 'usStockAccount',
                                       spouse:  'sharedBrokerageAccount' } };
```

resolved by `resolveDecantDestination(spec, ownerId)` in the toolset. An owner absent
from the map falls back to the role lookup exactly as before, so nothing that worked
changes.

Three details worth keeping:

- **Routing is applied to every year carrying a Roth leg, not just the lever's own year
  range.** Confining it to the range is what produces a *split-destination* decant — the
  years you set route where you chose and the authored years keep pointing wherever the
  role lookup landed them. That is the same silent mis-routing in a subtler form. Years
  with no Roth leg are left alone; routing a pure tax-deferred year would move a decision
  this lever has no business touching.
- **An unresolvable key is now rejected**, not silently tolerated. It must be a state
  KEY, not an account id or name — design/72 Gap 2 was exactly that bug, where an id
  never resolved and the proceeds landed in the generic cash pool.
- **The schedule editor deep-copies the map.** A shallow `{ ...entry }` would hand every
  clone the same object and let an edit reach back into the active scenario — the
  shallow-copy trap design 39 §13 already paid for once.

### G5 — `moveYear` is a confounded axis

`moveYear` must be an axis (§1), but in any scenario carrying an inflation differential
between the two countries with `fxProcessModel: NONE`, the differential compounds into a
large real-spending divergence over a long horizon, and **it, not tax, is what actually
moves the move-date lever**. This is established: see the prior finding on the AU/US
inflation differential with pinned FX.

Two further contaminants, both pushing the same way:

- A **dated** shock is foreseen by any timing lever. Shifting the move past a scheduled
  crash looks free because the plan can see it coming. The three-test protocol from the
  earlier dated-crash finding applies here in full: no timing result is believable until it
  survives (i) removal of the dated shock, (ii) re-dating it, and (iii) a stochastic-path
  arm where crashes arrive endogenously.
- Property sale dates are typically timed *against* the move year, so sliding the move
  silently slides a sale window and drags a large, unrelated effect into the cell.

Method consequence, in §7.

---

## 6. Tooling

### 6.1 A `rothDecant` lever in `scripts/lib/variant.mjs`

`variant.mjs` is the single definition of every lever precisely so that a grid, a frontier
search and an MC arm cannot disagree about what a lever means. The Roth decant belongs
there rather than in the study driver.

```
rothDecant  { owners, startYear, endYear, annual | 'EMPTY' }
```

Semantics:

- **merges** `rothAmount` into the existing `earlyWithdrawalSchedule` entries, preserving
  each year's authored `taxDeferredAmount`; creates entries for years the schedule lacks;
- amounts are **real base-year USD**, consistent with the rest of the schedule (the toolset
  compounds them to nominal — do not pre-inflate);
- `'EMPTY'` resolves to a large sentinel, relying on the reducer's cap at the account's
  drawable balance, so "empty it" needs no balance lookup in the lever and therefore no
  private figure in a committed spec;
- sets `earlyWithdrawalEnabled` when any amount is positive, since the schedule is inert
  without it;
- absent ⇒ no-op, like every other lever.

Small — the merge semantics are the only subtle part.

### 6.2 `scripts/lab/roth-ledger.mjs` — the instrument

One run in, one per-year table out. This is what turns a horse race into an explanation, and
it closes G3.

| column | source |
|---|---|
| Roth balance, contribution basis, earnings basis | state |
| withdrawal, split contributions / earnings | the withdrawal actions |
| §72(t) penalty paid | `usPenaltyYTD` delta |
| AU ordinary income, total | state |
| **Roth slice of it** | per-account attribution (design 76 `bookAuResident`) |
| **marginal AU rate on that slice** | `engineDelta(computeAuTax, 'auOrdinaryIncomeYTD', slice, state)` |
| **AU tax attributable to the Roth** | slice × marginal rate |
| residency, age relative to each 59½ gate | state |

The marginal-rate column is the point. An average rate would understate the charge, because
the Roth slice sits on *top* of the year's other income and is taxed in the highest bracket
the household reaches. That is also the number that tells you *when* to decant: the answer
is driven by which years have room underneath them.

The reporter must run against the tax engine, not re-implement brackets. The published-base
rule applies: never transcribe a rate from our own output.

### 6.3 Reused as-is

`variant-grid.mjs` for the arm × `moveYear` cross product (`reduce` to convert a swept axis
into a break-even per cell), `frontier.mjs` where a single edge is wanted, `mc-run --paths`
+ `mc-report` for the paired-worlds robustness pass, `study-report.mjs` for the rendered
page, `export-tax-csv.mjs` + `crossfoot` to validate that the per-year story foots across
years before any of it is believed.

---

## 7. Method

**Arms.** Four, plus one sensitivity:

| arm | description |
|---|---|
| **A — hold** | baseline; the drawdown strategy draws the Roth as an AU resident on its own weights |
| **B — decant pre-move** | empty the Roth across the pre-move years, 10% on the earnings slice, proceeds to taxable brokerage |
| **C — defer the move** | slide `moveYear` past the **latest** owner 59½ gate, empty the wrappers penalty-free while still US-resident, then move |
| **D — partial decant** | sweep the annual decant amount; finds whether the answer is a corner solution or an interior one |
| **A′ — sensitivity** | arm A with the G2 correction approximated, to bound how much of B's margin is the modelling bias |

Arm C deserves a caution that arm B does not. Deferral has to clear the **latest** owner
gate, not the earliest, if every wrapper is to be emptied cleanly — and where one owner's
Roth is disproportionately earnings-heavy, that owner's gate binds no matter how small their
balance is relative to the household. Check which gate binds; do not assume it is the
largest holder's, and do not assume it is the oldest owner's.

**The base plan is not arm A.** Worth stating plainly, because it is easy to assume
otherwise: the authored scenario already carries a large scheduled Roth decant in the
years either side of the move — almost certainly the residue of an earlier optimizer run
saved back into the plan. Running it unmodified measures a decant arm and calls it a
baseline. Arm A has to be **constructed**, by zeroing the Roth leg across every year the
schedule touches (`rothDecant` with `annual: 0`, which leaves the tax-deferred leg
intact). Check the authored schedule before defining any arm.

**Sequencing.** G1 first, as its own change with tests — until it lands there is no
trustworthy objective. Then the lever (6.1) and the reporter (6.2), then **G7**, without
which arm A costs nothing. Then:

1. **Fix `moveYear`, sweep the Roth arms.** This is the clean question and it should be
   answered first and on its own. A × B × D at the plan's authored move year, scored on
   after-tax net worth (post-G1) and on lifetime tax paid, with the per-year ledger for the
   winning and losing arms.
2. **Then open the move-date axis** — but only with the G5 confounds controlled: an arm with
   the inflation differential neutralised, an arm with the dated shock removed, and a
   stochastic-path arm. Report how much of arm C's advantage survives each. If C's margin
   collapses when the differential is neutralised, the honest finding is "this is an FX
   question wearing a tax costume", and it belongs in a different study.
3. **Robustness.** Paired-worlds MC on the surviving contrast. Report the paired rescue and
   **reverse** counts, not the failure rates — a nonzero reverse count means state-dependent
   harm with a mechanism and is worth more than a difference in means. Never quote a mean of
   terminal wealth.

**Scoring.** After-tax net worth (post-G1) as primary; lifetime tax paid, decomposed, as the
explanatory secondary. If any arm touches an adaptive spending rule, the pass/fail flag stops
measuring anything and `spending-trace.mjs` is mandatory — a proportional rule cannot run out
of money, it just quietly spends less.

**Two standing traps** that have bitten prior studies on this scenario and will bite this
one: `monthlyExpenses` is not total outflow (use the `spendTotal` lever, which does the
mortgage arithmetic), and `spendTotal` collides with any named `spendingStrategy`.

---

## 7a. P4 result — decant vs hold at the plan's own move year

Run 2026-07-31 on `wip/roth-analysis`, all six gaps above closed except G2/G8/G9. Spec in
the gitignored `scripts/specs/`; figures in the study directory, not here.

**Every cell is solvent.** The comparison is therefore entirely about terminal wealth, not
survival — the pass/fail flag carries no information at this spending level, exactly as
`variant-grid`'s header warns, which is why the grid is scored on `afterTaxNW`.

> **Superseded in part by §7b.** Everything below is measured in the authored world,
> which contains one dated crash inside the decant window. P5 shows the sign reverses
> without it. Read this section as "what happens in the authored world", not as the
> study's answer.

**The answer is a corner solution: empty the wrapper, as early as possible.** Terminal
after-tax net worth rises monotonically with the decant amount when the window opens
early, and the largest arm — empty it — beats holding by **+4.1%**. Decanting wins at
every amount tested; there is no interior optimum to find.

**Where the gain comes from, and a cross-check that it is real.** Holding costs
A\$341,394 of s99B tax, all of it falling in a five-year burst in the 2040s when the
drawdown drains the wrapper. Emptying pre-move costs a single §72(t) charge of about
US\$26k and **A\$0** of Australian tax, ever. The headline gain is roughly three times the
tax avoided, which is the right order: the avoided tax is not merely saved, it stays
invested for the two-plus decades between the 2040s burst and the horizon. Discounting
the avoided charge forward at the plan's own growth rate lands in the same neighbourhood
as the observed gain, so the mechanism and the magnitude agree rather than merely
pointing the same way.

**Lifetime tax paid goes UP in the winning arm, and that is not a contradiction.**
Decanting pulls tax forward and moves capital into a wrapper whose growth is taxed
annually, so the household pays *more* tax in total while ending up *wealthier*. Anyone
scoring this study on `MIN_LIFETIME_TAXES` would pick the losing arm. Minimising tax and
maximising wealth are different objectives here, and this is a clean case of the two
disagreeing.

**A caveat about which metric did the work.** In every arm the Roth is fully consumed
well before the horizon, so no Roth balance survives to be discounted at the terminal —
`afterTaxNW` and nominal `netWorth` move almost together, and G1's residency-aware
discount is *not* what produces the ranking. That does not make G1 optional: without it
the metric was untrustworthy and could not have been used at all. But the effect here is
a **path** effect — tax leaving the household along the way and the compounding it
forgoes — not a terminal-stock effect. On a plan where the Roth survives to the horizon
(a shorter window, a bequest framing) the terminal discount would dominate instead.

**One anomaly, flagged not explained.** With the window opening later, the response is
**not monotone**: one mid-sized arm falls back to roughly the hold level while both its
neighbours sit well above it. Non-monotonicity along a lever is either a real threshold —
a bracket edge, a residency boundary, an age gate — or a bug, and single runs either side
cannot tell which. It does not affect the recommendation, because the early-window column
is monotone and dominates the late-window column nearly everywhere. It does mean the
*timing* sub-dimension is not yet trustworthy, and P5 should resolve it before any claim
about when to decant is made.

**Known biases** — as understood at the time, *and since revised*. This paragraph
originally read "G2, G8 and G9 each overstate the cost of holding, so all three flatter
the winning arm". G9 has since landed and did the reverse: it took the hold arm's charge
down 6%, so P4's +4.1% is if anything slightly understated on that account. The
correction is small. **G11, which G9 uncovered, is not** — it is worth several times G9
in the other direction, and until it is settled the +4.1% should not be quoted to two
significant figures.

**A defect this run found in its own instrument.** The first pass showed two "hold" cells
differing when they could not — same arm, different (inert) window. The `rothDecant` lever
was stamping `destinationKey` onto every year in its range, including years carrying only
a **tax-deferred** decant, so varying an inert Roth window silently re-routed where the
tax-deferred proceeds landed. Fixed, with a regression test asserting that two arms
differing in nothing produce identical schedules. Worth recording as method: a control
cell that is not constant is the cheapest bug detector in a grid, and it only works if a
control is actually included.

## 7b. P5 result — the move-date axis, with the confounds controlled

Run 2026-07-31. 80 cells: move year × decant × decant-window-start × world.

**Levels are not the unit here.** Sliding the move alone moves terminal wealth by tens
of percent, and deleting the dated 2028 shock roughly **doubles** it. The decant is worth
about 4%. Comparing levels across move years would drown the signal in effects that have
nothing to do with the Roth, so every cell is half of a pair and the reported quantity is
`decant − hold` **within** each (move, start, world). Anything shifting both halves
equally cancels.

### The inflation confound is cleared

Neutralising the AU/US inflation differential moves the *level* substantially — the hold
arm gains roughly \$3m — but leaves the *delta* almost untouched (e.g. +5.21% → +5.56% at
the authored move year, and similarly at every other). **The decant result is not an FX
artefact wearing a tax costume.** That was the most likely way for this study to be
fooled, and it is ruled out.

### The shock confound is not cleared — it inverts the sign

This is the finding.

| decant window from 2027 | as authored | AU infl = US | no shock | shock 2035 |
|---|---|---|---|---|
| move 2031 | +5.21% | +5.56% | **−0.76%** | **−0.33%** |
| move 2038 | +25.21% | +22.07% | **−2.69%** | **−0.19%** |
| move 2041 | +2.06% | +2.55% | **−7.59%** | +0.50% |
| move 2044 | +6.00% | +4.72% | **−3.56%** | **−5.11%** |

Remove the dated crash and **holding usually beats decanting**. Re-date it and the
advantage collapses to near zero. The P4 headline is therefore conditional on the
authored world, and must not be quoted as a general result.

**Why — and it is not the bug I first suspected.** The obvious hypothesis was G8: a shock
revalues the balance without adjusting the basis ledger, so a crash inflates the Roth's
apparent earnings and over-assesses s99B, manufacturing a decant advantage. Measured, the
opposite holds. **Without** the shock the s99B charge is *larger* — A\$690,440 against
A\$341,394 — because an uninterrupted market grows the wrapper bigger before it is drawn.
The decant still loses there.

So the driver is not the size of the s99B charge. It is what the decant **gives up**: a
Roth compounds tax-free, and moving that money into a taxable account subjects it to
annual tax on distributions and CGT on the way out. In a strong uninterrupted market that
forgone tax-free compounding is worth more than the s99B charge avoided. Insert a crash
and the compounding being given up is worth much less, so the s99B saving dominates.
**The decision is a bet on the return path**, and the authored scenario contains one
specific, foreseen crash sitting inside the decant window.

### No timing recommendation is supportable yet

The delta is badly non-monotone in the move year — +5.2%, +8.7%, **+25.2%**, +2.1%, +6.0%
across the authored column — and the +25% outlier goes *negative* in the no-shock world.
A response that swings by twenty points between adjacent move years and changes sign with
the crash date is threshold or interaction behaviour, not an economic gradient. Nothing
about *when* to move can be read off this.

### The one strategy that survives every world

Opening the decant window after **both** owners clear 59½, with the move deferred past it,
is positive in all four worlds — the only cell family that is:

| decant from 2043 | as authored | AU infl = US | no shock | shock 2035 |
|---|---|---|---|---|
| move 2044 | +5.59% | +4.56% | +2.30% | +0.30% |

That is arm C behaving exactly as §1 predicted: hold the wrapper while it compounds
tax-free, empty it **penalty-free** once past the age gate, and move afterwards, so the
earnings never become s99B income at all. It gives up nothing to the §72(t) charge and
nothing to early conversion into a taxable wrapper. The margin thins to +0.30% in one
world, so it is a robust *sign*, not a robust magnitude.

The same window with an **early** move is firmly negative (−4.26% at move 2031), which is
the correct sanity check rather than a puzzle: once resident, a 2043 decant is simply an
assessable post-move distribution with no step-up to collect.

### What P5 changes about the plan

- The P4 recommendation — empty it early, +4.1% — is **downgraded to world-conditional**.
- The only path-robust strategy found is **defer the move past the later 59½ gate and
  empty the wrapper penalty-free just before moving**, which is a materially different
  recommendation and one that trades against everything else deferring a move affects.
- **P6 is no longer optional.** A single dated crash cannot settle a question whose answer
  depends on the return path; stochastic paths, where crashes arrive endogenously, are the
  only honest instrument. Report paired rescue/reverse counts, not means.

## 8. Questions

**Q1 — do pre-residency accumulations get sheltered?** **Resolved: no.** s99B(2)(a)'s
carve-out for corpus attributable to derived amounts carries no time limit, so income
derived and capitalised before the residency date remains caught on distribution. The
engine's existing treatment is correct and this is not a sensitivity axis. Resolved from
the text (§4); worth a practitioner's confirmation before the result is acted on, since it
is the single assumption the whole comparison rests on.

**Q2 — are Roth conversions in scope?** **No.** Excluded by decision. Whether to keep
converting into a wrapper Australia does not recognise is a real and unobvious question —
converted principal becomes s99B corpus and does come out free, so it is not simply a
mistake — but it roughly doubles the grid and is separable. Its own study.

> **Landing G1 pre-empted part of that study's answer, and it is worth recording here.**
> On the synthetic reference scenario, at a terminal past the move, the conversion
> gradient **changes sign**: rewarded for a household that stays in the US, penalised for
> one that moves to Australia. The mechanism is not subtle — the conversion pays US tax up
> front *and* hands the subsequent growth to s99B with no credit, while the converted
> principal's IRA-earnings portion is denied the corpus exemption outright. Before G1 the
> metric priced the destination wrapper at par and could therefore only ever reward
> converting, which means any prior optimizer run that chose a conversion schedule under a
> cross-border scenario was climbing a biased gradient. That is a caution about *existing*
> results, not just about future ones. Quantifying it is the separate study's job; noting
> that the sign flipped is this one's.

**Q3 — do we model derived-vs-appreciation (G2) before running?** **No** — conservative
treatment, bias direction stated in the write-up, fidelity work as follow-up. Revisit if the
study lands inside the error bar.

**Q4 — which owner's 59½ gate binds arm C?** Empirical, per scenario. Determined in step 2,
not assumed.

---

## 9. Phases

- **P1 — G1. ✅ DONE (2026-07-31).** Residency-aware Roth pricing in `after-tax.js`,
  earnings-portion only, with `liquidationRateProvider` routing the slice through
  `computeAuTax`. 11 new tests; full suite green (4266 unit + 975 viz).
- **P2 — G4. ✅ DONE (2026-07-31).** `rothDecant` lever in `variant.mjs`, merge semantics,
  tested against a schedule that already carries a tax-deferred leg, plus toolset
  actuation. Surfaced G6, which needs a decision before P4.
- **P3 — G3. ✅ DONE (2026-07-31).** `scripts/lab/roth-ledger.mjs` — per-year attribution
  by removal, cross-footed against the engine's own settled figure every year, plus a
  balance-vs-bookings leak check. Found G7 and the baseline-is-not-a-control problem
  below on its first run.
- **P3a — G7. ✅ DONE (2026-07-31).** The one-case fix in `_drawPenaltyFree`, plus the
  EW-3 test that encoded the omission and a new EW-3b guard for the AU case.
- **P3b — G9. ✅ DONE (2026-08-04).** The rollover leg: shared lot consumption, the
  §408A(d)(4)(B) ordering, the EVT-43/44 twins on both drawdown paths, the
  mirror-image defect in the under-age branch, and a fixed-point gross-up. Leak check
  silent; hold arm A\$341,394 → A\$320,908, i.e. the opposite direction to the one
  predicted. Surfaced G11.
- **P3c — G11.** The conversion lot's corpus stamp. Needs a decision before P6, because
  it is worth several times G9 and pushes the other way.
- **P4 — study step 1. ✅ DONE (2026-07-31).** Fixed move year, arms A/B/D swept as one
  axis, ledger for the extremes. Result in §7a: decant wins, corner solution, +4.1%.
  Added `afterTaxNW`/`taxPaid` to the shared `summarize()` row and a general money-metric
  selector to the grid reporter, so a grid cell and an optimizer score are now the same
  number rather than two plausible ones.
- **P5 — study step 2. ✅ DONE (2026-07-31).** Move-date axis, paired deltas, four worlds.
  Result in §7b: inflation confound cleared, **shock confound inverts the sign**, P4
  downgraded to world-conditional, arm C the only path-robust strategy.
- **P6 — study step 3.** Paired-worlds MC on the surviving contrast. **Gated on a G11
  decision**: P6 is expensive and it would price a hold arm whose cheapest years are
  cheap for a reason the engine contradicts elsewhere. Run it after G11 is settled
  (either way — "we keep the current stamp, here is why" is a settlement).
- **P7 — G2** (fidelity follow-up, out of the study's critical path): derived income tracked
  separately from appreciation inside sheltered wrappers; makes
  `rebalanceDriftBandSheltered` an honest lever for an AU resident.

Run outputs, specs and any figure derived from the plan stay in the gitignored study
directory. This document stays free of them.
