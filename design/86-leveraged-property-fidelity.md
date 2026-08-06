# 86 — Leveraged property fidelity: loss carryforward, interest-only debt, and interest deductibility

**Status** (2026-08-05): **IMPLEMENTED**, except G3's standalone-loan half (§3 G3),
G6's UI surface, and G7. Phase table in §5. Full suite green (4,435 + 977).

Found while designing a study of AU mortgage **offset accounts** — whether cash is
better parked in an offset (earning the loan rate, certain and untaxed) or invested
(earning the market, risky and taxed). That question is decided almost entirely by the
*after-tax* cost of the loan, so it walks straight through the engine's debt and
loss-relief machinery and exposes what isn't there.

The gaps are not specific to offsets. They are the general "hold income-producing
property against debt" gaps, and every one of them **biases the same direction** —
toward borrowing and investing — which is what makes them worth closing together
rather than one at a time.

---

## 1. Why these belong in one document

An offset/leverage decision reduces to one comparison:

```
value of a dollar against the debt  =  r_loan × (1 − MTR_marginal)
value of a dollar invested          =  E[r_asset] − tax drag,  with variance
```

Every gap below moves one of those two terms:

| gap                                             | term it corrupts                          | direction of the error                |
|-------------------------------------------------|-------------------------------------------|---------------------------------------|
| G1 no revenue-loss carryforward                 | `MTR_marginal` too low                    | favours holding the debt              |
| G2 no interest-only mode                        | `r_loan` uncontrollable                   | corrupts both arms                    |
| G3 interest deductible only via the rental path | `MTR_marginal` = 0 or 1, never in between | both directions                       |
| G4 offset capacity unmeasured                   | hides idle capital                        | favours the offset                    |
| G5 no US passive-loss limitation                | `MTR_marginal` too high                   | favours holding the debt              |
| G5b the same loss breaks the §904 partition     | —                                         | **threw** in dev/test, silent in prod |
| G6 no loan term / IO expiry                     | `r_loan` optimistic for life              | favours holding the debt              |

A model can be wrong in one direction and still be useful for ranking. **Wrong in
both directions at once, on the same lever, is not** — you can no longer sign the
answer. That is the argument for treating this as one piece of work.

---

## 2. What the engine already gets right

Stated so an implementer doesn't "fix" any of it. All verified by reading the code and
by running a mortgaged, offset, rented property headlessly.

- **`OffsetAccount` semantics are correct.** `effectivePrincipal(state, key, loan)` =
  `max(0, balance − Σ same-currency offsets)` — `account-rules/loan-classes.js:144`.
  It feeds **both** the monthly `LOAN_PAYMENT` interest accrual and the rental
  deductible-interest line in `computeRentalMonth`, so the deduction and the accrual
  can never drift apart. The join is property-keyed (`offsetsPropertyKey` ↔
  `linkedPropertyKey`) with a same-currency guard, so a mis-linked cross-currency
  offset can't suppress principal 1:1 while ignoring FX.
- **An offset earns no yield.** No interest handler is wired to the `au-offset` /
  `us-offset` roles, and `economic-regimes-toolset.js:208` explicitly refuses to seed
  a `SAVINGS_*::<stateKey>` rate for one. The obvious double-count — suppress loan
  interest *and* earn a savings rate on the same dollar — is **not** present, even
  though offset accounts do carry a `CASH` holding with a `rateKey` on it. Nothing
  reads it. Leave it that way; consider asserting it (§6).
- **Sign conventions hold.** `net-worth.js:35` subtracts a `type === 'loan'` balance
  and adds an offset's; property contributes equity only, and the record's
  `mortgageBalance` is 0 post-design-54 so there is no double-count.
- **Negative ordinary income already offsets the same year's capital gain.**
  `_assessResidentPreFito` forms `discountedIncome = auOrdinaryIncomeYTD +
  netTaxableGain` and floors the **sum** — discount first, then revenue losses, which
  is the correct AU ordering. The `Math.max(0, auOrdinaryIncomeYTD)` at
  `au-tax-rates-base.js:231` feeds only the display split and the Div 115C min-tax
  top-up, not the assessment. **Within a year, relief is right.** G1 is strictly about
  crossing a year boundary.
- **Rental income and loss attribute by ownership**, not to a household scalar
  (design 73 Gap 3 / design 76), so a jointly-held property splits and a solely-held
  one does not.

---

## 3. The gaps

### G1 · No revenue-loss carryforward (AU) — **blocking**

**Now.** Every AU accumulator is zeroed at settle (`tax/tax-settle-classes.js`,
`RESET_FIELDS.AU` and `PER_PERSON_AU_FIELDS`). There is no loss field anywhere in
`state/intl-retirement-state.js`. A year whose assessable income is negative is
assessed at zero and **the excess is destroyed**.

**Statute.** ITAA 1997 Div 36: a tax loss is carried forward indefinitely and deducted
from later assessable income. There is no time limit and, for individuals, no
continuity-of-ownership test. Losses are applied in the order incurred, and Div 36
deducts them from *total* assessable income — including the net capital gain — after
the Div 115 discount, which matches the order the engine already uses.

**Why it matters.** A negatively-geared property held by a person with little other
income generates a loss every year. Destroying it annually understates the value of
the deduction to zero, which is exactly the term the offset-vs-invest decision turns
on. In a measured two-person run, one spouse's rental loss was destroyed **every year
for the whole horizon** while the other's was absorbed — a pure artefact of who
happened to hold other income.

It also silently interacts with the plan's largest tax event: a loss pool that should
be sheltering an eventual property disposal instead evaporates a year at a time.

**Proposed.**

- Add `auPersonTaxLossPool: { [personKey]: number }` to
  `InternationalRetirementFinancialState`. Per-person, AUD, **not** in the settle
  reset set. A household scalar is wrong here: Australia has no joint assessment, and
  design 76 exists precisely because splitting one by headcount mis-attributes.
- In `_assessResidentPreFito`, deduct the pool from `discountedIncome` before the
  `Math.max(0, …)`, capped at it. Return the amount consumed and the closing balance
  as part of the result so the settle can write the pool back and the tax document can
  print both.
- When `discountedIncome` is negative, the settle **adds** its magnitude to the pool.
- Report on the AU return: opening pool, deducted this year, closing pool — the same
  three lines the §904 FTC baskets already print (`us-tax-document-2026.js:227`), so
  the two read alike.

**The trap.** `_assessResidentPreFito` is deliberately pure and FITO-free because it
is evaluated **twice** — once on the real state and once on `withoutUsSourceIncome(state)`
— to size the Art. 22(2) FITO limit without recursion (design 52 §4.5, design 83 G8).
A loss deduction must therefore be a *function of the state passed in*, never a
mutation, or the counterfactual pass will consume the pool and the differential will
be measured against a state that has already spent it. The pool write-back belongs in
the settle, on the real pass only.

Second trap: the counterfactual removes US-source income. If the pool were deducted
before that removal, the "without US-source" pass would show a larger loss deduction
than the real one and **overstate** the FITO limit. Deduct the pool inside each pass,
from that pass's own `discountedIncome`, and both passes stay consistent.

**Test.** Loss year followed by a profit year: year 2's assessable income must be
reduced by exactly year 1's excess, and the pool must land at zero. A three-year
version with partial absorption pins the ordering. A loss year followed by a
disposal year proves the pool reaches the discounted gain. And an FTC-bearing loss
year must leave `_assertFtcInvariants` satisfied — that assertion is what caught the
last state-partition mistake in this area.

---

### G2 · No interest-only loan mode — **blocking**

**Now.** A loan is `{ balance, monthlyPayment }` and `LoanPaymentHandler` pays the
fixed `monthlyPayment` against interest accrued on the effective principal. With a
prime-linked variable rate (`primeSpread`, design 56 Phase 3) the rate moves but the
payment does not, so "pay exactly the interest" is inexpressible — you pick a number
and hope.

**Consequence, and it is not benign.** Set the payment below accrued interest and the
balance **grows without bound**. The engine flags this (`loan_negative_amortization`,
`loan-classes.js:233`) but does not stop it, and nothing in a headline result makes it
visible. In a measured run, draining an offset while leaving the payment untouched
grew the loan by 47% over fifteen years — the run was silently modelling runaway
negative amortization while appearing to model an investment decision.

Interest-only is also not a corner case here: it is *the* structural feature of a
leverage-holding strategy, because a P&I loan destroys its own offset capacity every
month (see G4).

**Proposed.** An `interestOnly: boolean` on `LoanAccount`, honoured in
`LoanPaymentHandler.call()`: when set, `payment = interest` (computed on the effective
principal at the live rate), so the balance is flat by construction and the payment
tracks a variable rate automatically. Pairs naturally with G6.

**Test.** An IO loan against a moving `PRIME_*` series holds its balance flat to the
cent across a rate path, and its cash outflow tracks the rate. A P&I loan is unchanged
byte-for-byte.

---

### G3 · Interest is deductible only through the rental path, and never traced

**Now.** Two complementary errors.

1. A standalone `LoanAccount` — no `linkedPropertyKey` — accrues interest and emits
   **no tax action whatsoever**. The only deductible-interest line in the engine is
   `computeRentalMonth`'s `deductibleInterest`
   (`account-rules/rental-income-classes.js:72`). So *borrow to invest in securities*
   produces a deduction of zero, when the interest is plainly deductible against the
   investment income.
2. Conversely, a loan linked to a rental is treated as **100% deductible regardless of
   what the borrowed money was actually used for**. Drawing down an offset to buy a
   boat raises the effective principal and therefore raises the deduction.

**Statute.** Deductibility under s8-1 follows the **use** to which the borrowed funds
are put, not the security taken over them (*Munro*; TR 95/33). This is also the
precise reason an offset is structurally different from a redraw: withdrawing from an
offset is a withdrawal of the borrower's *own* money and leaves the loan's character
untouched, whereas a redraw is new borrowing whose character is set by what the
redrawn money buys. The engine can express neither distinction today.

**Proposed** (smallest change that makes both directions expressible):
`deductibleFraction` on `LoanAccount`, default `null`. `null` preserves today's
behaviour exactly — deductible iff linked to a rental. A number in `[0, 1]` states the
income-producing share of the loan's purpose, and the deductible-interest line becomes
`interest × deductibleFraction` wherever it is computed. A standalone loan with a
non-null fraction emits a new deductible-interest action into the country's ordinary
income (negative), which is what unlocks the borrow-to-invest arm.

Explicitly **not** proposed: automatic tracing of borrowed funds through accounts.
That is a mixed-purpose-account problem with no clean model, and stating the fraction
is both honest and sufficient.

**Test.** Deductible fraction 0 / 0.5 / 1 on a rental-linked loan produces exactly
proportional deductions; `null` reproduces current output byte-for-byte.

#### G3 splits in two, and only half is built

**Built (error 2):** `deductibleFraction` on `LoanAccount`, `mortgageDeductibleFraction`
on `RealProperty`, applied in `computeRentalMonth`. This is the half that matters for a
property-secured loan — drawing an offset down for private use no longer inflates the
deduction — and it is inert at `null`.

**Deferred (error 1): a standalone investment loan still deducts nothing.** The
tempting shortcut is to emit the existing `AU_RENTAL_INCOME_TAX` action with a negative
amount, which needs no new action type, reducer or toolset wiring. **That is now
wrong**, and only became wrong when G5 landed: that action feeds
`usPassiveActivityIncomeYTD`, so a borrow-to-invest interest deduction routed through
it would be *suspended under §469*. Interest on money borrowed to buy securities is
**§163(d) investment interest** — limited to net investment income, with its own
indefinite carryforward — not a passive activity loss. The two limitations have
different bases, different carryforwards and different release conditions.

So this needs its own channel, and the §163(d) limitation with it. That is a design
decision rather than a typing exercise, and it is deferred deliberately rather than
approximated. Consequence to state in any result: **an arm that borrows against
something other than the rental and invests the proceeds is not yet modellable.** An
arm that borrows against the rental is, and always was — under tracing rules the
loan's character is fixed by what it originally funded, and drawing on an *offset*
(the borrower's own money) does not disturb it.

---

### G4 · Offset capacity is unmeasured

**Now.** An offset only suppresses interest up to the loan balance; `effectivePrincipal`
correctly clamps at zero. But nothing reports the excess, so an offset over-funded
relative to its loan looks identical to one exactly sized — while the surplus earns
**nothing at all**, being neither invested nor offsetting.

This is not hypothetical. A P&I loan amortises toward zero, so an offset that starts
correctly sized ends up entirely idle; after payoff, 100% of it is dead capital
earning zero in perpetuity. In a measured run the surplus was already meaningful on
day one and became the entire balance by payoff — invisible in every existing report.

**Proposed.** A derived metric `offsetIdleCapacity` = `Σ_offsets max(0, balance − Σ
linked loan balances)`, recorded per period alongside net worth. Optionally a warning
when it exceeds a threshold for a sustained window, in the same spirit as the existing
negative-amortization flag.

**Test.** Offset exceeding its loan reports the difference; offset below reports zero;
loan payoff reports the full balance.

---

### G5 · No US passive activity loss limitation (§469)

**Now.** `AU_RENTAL_INCOME_TAX` adds its **signed** amount to `usOrdinaryIncomeYTD`
(`au-tax-module-2026.js:194`), so a foreign rental loss reduces US ordinary income
immediately and without limit. Measured, this drove US ordinary income negative every
year for a household whose only other US income was investment income.

**Statute.** §469 suspends passive activity losses and carries them forward until the
activity produces passive income or is disposed of. Rental activity is passive per se
under §469(c)(2); the §469(i) \$25,000 active-participation allowance phases out
entirely above \$150,000 MAGI and does not apply to most cross-border cases.

**Proposed.** A `usPassiveLossCarryforward` pool mirroring G1's structure: suspend the
loss, release it against later passive income or on disposal of the activity. Sharing
G1's shape is deliberate — one pattern for suspended losses, two jurisdictions.

**Deliberately sequenced after G1**, not with it. G1 is the term the offset decision
turns on; G5 is a second-order correction on the US return that mostly moves the FTC
arithmetic, and doing both at once puts two new pools into the settle in one change.

#### G5b · …and the unlimited loss breaks the §904 partition outright

Not a modelling nicety. A large enough rental loss makes
`_assertFtcInvariants` **throw**:

```
§904 limitation invariant violated — general numerator … exceeds §904 denominator 0.00.
Gross income all sources 33008.90, unrelated deductions 45909.50,
basket gross general=50503.20 passive=0.00
```

The mechanism: the signed rental loss reduces `usOrdinaryIncomeYTD` (and, floored at
zero in `computeTax`, the passive basket), but it does **not** reduce the general
basket it is effectively being deducted against. Total gross income falls below the
general basket's own gross, the baskets stop partitioning income, and the denominator
collapses to zero while a numerator is still positive. Design 83 §8 built that
assertion precisely to catch this class of thing.

Reproduced on a mortgaged, rented, unoffset property in a low-other-income year.
`_ftcStrict()` is true in dev and test and false in a production build, so **the app
survives this and every headless script dies on it** — which is the worst split,
because the studies are the thing that would have caught it.

Whatever fixes G5 must restore the partition, and there should be a regression that
runs a loss year with foreign tax paid and asserts the invariant holds. Until then,
`FTC_LIMITATION_STRICT=off` lets a study run — but a result obtained that way is
standing on a §904 computation that has already been told it is inconsistent, and must
be quoted as such.

---

### G6 · No loan term, IO expiry, or balloon

**Now.** A loan amortises — or negatively amortises — forever. There is no maturity.

**Reality.** Offset loans carry a 25–30 year term, and an interest-only period is
typically 5 years, after which the loan reverts to P&I amortised over the *remaining*
term — a payment step-up precisely when a "hold the leverage into later life" plan is
relying on it. A plan that assumes indefinite interest-only is assuming away the main
risk of the strategy.

**Built**, as `interestOnlyUntilYear` and `maturityYear` — absolute calendar years
rather than durations, matching `plannedSaleYear` / `moveYear` elsewhere, and matching
how a borrower actually knows these dates. `scheduledLoanPayment()` resolves the
payment for the point in the loan's life: the interest inside the IO window, the
amortising payment over the REMAINING months once it expires (recomputed each month,
so a variable rate re-amortises the way a real P&I loan does), the whole balance at
maturity, and the authored fixed payment for a term-less loan. A maturity shortfall
runs through the existing replenish / insufficient-funds path.

Measured on the reference plan: reverting an IO loan to P&I after five years costs
roughly half a million dollars of terminal wealth against the same loan left
interest-only for life. That gap was previously unmodellable, and it is the main risk
of a "hold the leverage into later life" plan.

---

### G7 · No §988 gain or loss on foreign-currency debt

A US person repaying AUD-denominated debt realises exchange gain or loss under §988,
recognised as ordinary income on each payment. Unmodelled. Over a 25-year loan across
a moving USD/AUD path this is not small, and it is a **cost of holding foreign
leverage specifically** — which makes it in-scope for the question this design serves,
even though it is the lowest-value item here. Documented, not scheduled.

---

### Out of scope, but adjacent — flag when quoting any result

There is no **US capital-loss carryforward** (§1211's \$3,000 annual ordinary offset,
§1212's indefinite carryforward) and no **NOL** machinery. Neither is on the offset
critical path, but both are the same "losses don't survive the year boundary" defect
as G1 and G5, and whoever builds the loss-pool pattern should shape it so a third
consumer costs a day rather than a redesign.

---

## 4. Tooling that must land alongside

`scripts/lib/variant.mjs` has **no loan or offset lever**, and the parameter generator
emits no params for a property's mortgage balance, payment, or rate spread, nor for an
offset balance. Every axis of a leverage study is currently unreachable from a spec
file, so none of this is measurable even once it is built.

- **`loan` lever** — `{ balance, monthlyPayment, primeSpread, interestOnly,
  deductibleFraction, termMonths }` against a loan state key.
- **`offset` lever** — `{ balance, deployTo: <stateKey> }`, where `deployTo`
  **moves** value to a named account rather than creating it. Arms that don't hold
  total wealth constant are not comparable, and that is the easiest thing in this
  whole area to get wrong.

Both follow the existing `applyProperty` pattern: write the record **and** the state
entry **and** the param, via `makeSetParam`, because a workbench export populates the
authored `cfg.params` list while `buildDefaultConfig()` populates only the flat
`cfg.parameters` bag. Writing one store gives a lever that is silently inert against
the other source.

---

## 5. Phasing

| phase  | contents                                | status   | why here                                                                                                                                                                |
|--------|-----------------------------------------|----------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **P1** | Tooling levers (§4) + G2 interest-only  | **done** | Nothing is measurable without levers, and G2 is the smallest fidelity fix that stops a study silently measuring negative amortization.                                  |
| **P2** | G4 offset capacity metric               | **done** | An hour's work; it is a study output and it makes P1's arms readable.                                                                                                   |
| **P3** | G1 AU revenue-loss carryforward         | **done** | The load-bearing one. Touches the settle, the FITO counterfactual and the tax document.                                                                                 |
| **P5** | G5 + G5b US §469 and the §904 partition | **done** | Promoted ahead of P4: until this landed, no unoffset arm could run at all without `FTC_LIMITATION_STRICT=off`. Reuses P3's pool pattern in the other jurisdiction.      |
| **P4** | G3 `deductibleFraction`                 | **half** | The rental-path half is built. The standalone borrow-to-invest half is deferred — see §3 G3, it needs a §163(d) channel that must NOT reuse the §469 one P5 just built. |
| **P6** | G6 term / IO expiry                     | open     | Depends on G2. Turns "hold leverage forever" into a testable assumption.                                                                                                |
| —      | G7 §988                                 | open     | Documented, unscheduled.                                                                                                                                                |

P1, P2 and the built half of P4 are behaviour-preserving for any scenario that doesn't
opt in. **P3 and P5 are not** — they change tax in any plan with a loss year.

Measured after the fact: the full suite (4,428 + 977) stayed green through both, which
means the golden scenarios contain **no AU loss year and no net passive loss**. That is
a statement about the goldens' coverage, not evidence the changes are inert — the
reference cross-border plan moves under both, and any result predating them is not
comparable.

Two habits this repo has earned the hard way apply to P3 and P5 in particular:
transcribe published bases from the authority rather than from our own output, and
measure the magnitude of an expected effect before projecting it — recent gaps in this
codebase have twice been predicted backwards.

## 6. Test plan

Per-gap tests are listed above. Across all of them:

- **`npm run crossfoot`** after P3 and P5. A loss pool that opens, deducts and closes
  across years is exactly the class of bug a single-year view cannot see, which is
  what that tool exists for.
- **A regression asserting an offset earns no yield** — that it holds a `CASH` holding
  with a live `rateKey` while no handler credits it is a correct behaviour standing on
  the absence of a wiring. Absences are not self-documenting; pin it.
- **Golden re-baseline** at P3, with the direction and magnitude of the change stated
  in the commit rather than inferred later.

## 7. Open questions

1. **Should the AU loss pool be deducted before or after the FITO counterfactual
   split?** §3 G1 argues *inside each pass*. Worth confirming against Art. 22(2)'s
   text: the counterfactual is "the tax that would be payable but for the US-source
   income", and whether a loss deduction is part of "would be payable" is not
   self-evident.
2. **Does a loss pool survive a residency change?** A departing resident's carried-
   forward losses remain available if they resume residency. Design 62's deemed-
   disposal machinery is the natural place to decide this, and it should be decided
   explicitly rather than by whichever reset list the field lands in.
3. **Should `deductibleFraction` be time-varying?** A loan's purpose changes when
   redrawn funds are deployed. A scalar is right for P4; a schedule may be needed
   later, and the field should be shaped so that is an extension rather than a
   migration.
