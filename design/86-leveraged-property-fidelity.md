# 86 — Leveraged property fidelity: loss carryforward, interest-only debt, and interest deductibility

**Status** (2026-08-05): **IMPLEMENTED**, except G3's standalone-loan half (§3 G3),
G6's UI surface, and G7. Phase table in §5. Full suite green (4,435 + 977).

**Extended** (2026-08-05) with §8: the offset reframed as a *domestic-currency
liquidity option* rather than a return bet. That reframing is what finally gives the
"hold the loan" recommendation something to stand on, and it opens two new gaps —
**G8** (dated, currency-denominated one-off expense) and **G9** (fund an expense from
a nominated account) — plus it promotes **G7** from unscheduled to load-bearing.

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

G8 and G9 (added later, §3) do not fit this table, and that is the point: they corrupt
neither term. They are the gaps that stop the *third* term — the option value of the
facility itself — from being written down at all. See §8.

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

**Promoted by §8.** This was the lowest-value item while every run held the exchange
rate constant, because a §988 gain on a pinned rate is identically zero. §8 requires a
live FX process, and the moment the rate moves this stops being a rounding error and
becomes a term in the very comparison §8 exists to make. It is now P8.

---

### G8 · No dated, currency-denominated one-off expense

**Now.** The engine has two one-off-expense channels and neither can express *a stated
amount, in a stated currency, on a stated date, funded from a stated account*.

- **`healthcareEvents`** (the `HEALTHCARE` spending strategy) has the right *shape*:
  `[{ date, amount, category, personId }]`, one `OneOffEvent` per entry scheduled by
  both retirement toolsets, a handler emitting `REPLENISH_SAVINGS` + `EXPENSE_DEBIT`,
  and a real list editor in the scenario tab. But the amount is denominated in
  `expensesCurrency` and converted at debit time, and the target account is chosen by
  the **person's residency** — not by the expense's own country or currency.
- **`RealProperty.repairModel`** gets currency and country right — amounts are in the
  property's currency, the debit targets the property's country, and
  `capitalizeRepairs` feeds the cost basis — but it is **stochastic only**. There is no
  dated form.

So "a known large domestic-currency expense in year *T*" is unreachable, and it is the
event the entire §8 question is about.

**Proposed: generalize `HEALTHCARE` rather than add a sibling strategy.** It is the
same machinery two fields short; healthcare is one *category* of a general thing, not a
kind of thing; and a parallel strategy would duplicate the handler, the reducer, the
editor and the toolset scheduling. Measured surface before deciding: **10 source files,
3 test files, and no authored events in any saved scenario** — so this is a rename plus
two fields, with no data migration.

- Strategy `HEALTHCARE` → `EXPENSE_EVENTS`; param `healthcareEvents` → `expenseEvents`.
- Each entry gains **`currency`** (explicit, *not* `expensesCurrency` — this is the one
  field that makes an FX question askable, because a domestic-currency cost has a
  foreign-currency cost that moves with the rate), **`fundFrom`** (G9), and optional
  `propertyKey` + `capitalize` so an improvement reaches the cost basis the way
  `capitalizeRepairs` already does.
- `category` stays and becomes the discriminator. `'healthcare'` becomes a value rather
  than a strategy, which is the correct relationship between the two.
- Accumulators go per-category. **And fix the latent defect found while scoping this:
  `healthcareSpendingYTD` is never reset by any settle path**, so it is a second copy of
  `healthcareSpendingTotal` under a name that claims otherwise. Decide which one it is
  rather than carrying both forward.
- An `expenseEvent` lever in `scripts/lib/variant.mjs`, so the same thing is reachable
  from a spec file. §4's argument applies unchanged: unreachable from a spec means
  unmeasurable.

**Traps**, all four of which this repo has already paid for once: the two param stores
(write via `makeSetParam`); `visibleWhen` against a **multi-select** `spendingStrategy`;
the up-front entry clone that both existing list editors document, without which an edit
reaches back into the active scenario; and the `_auSharedDelegated` guard, without which
a cross-border scenario schedules every event **twice**.

**Test.** A dated event in each currency debits the right account for the right
converted magnitude; `category: 'healthcare'` reproduces the old behaviour; a
`capitalize` fraction moves the property's cost basis and shows up in a later disposal.

---

### G9 · An expense cannot be funded from a nominated account

**Now.** Every expense path resolves its debit target from residency or property
country, then leans on `REPLENISH_SAVINGS` and the drawdown queue for any shortfall. An
offset sits **deliberately outside** that queue (`drawdownPriority: null`), so it can
never fund anything.

Giving the offset a `drawdownPriority` is not the fix, and it is worse than useless — it
has been measured to be actively misleading. A priority puts the offset ahead of the
portfolio for *all* spending, so it empties early and the arm stops testing the strategy
it was built to test. "Hold it" and "spend it first" are the only two behaviours
available today, and the one that matters — **draw it when the need arrives** — is
neither of them.

**Proposed.** `fundFrom` on an expense event: a state key debited **directly**, falling
back to the existing residency-default path when absent, or when the nominated account
cannot cover the amount. Explicitly *not* routed through `drawdownPriority`, or the
artefact above returns by another door.

This is the smallest change that makes a targeted draw expressible, and it generalizes:
"fund this from that account" is a missing verb everywhere in the expense machinery, not
only for offsets.

**Test.** An event with `fundFrom` set to an out-of-queue account debits it and leaves
the drawdown order untouched; an event whose nominated account is short falls through to
the default path for the remainder; an absent `fundFrom` reproduces current behaviour
byte-for-byte.

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
| **P7** | G8 expense events + G9 `fundFrom`       | open     | One change: G9 is a field on G8's entry. Together they are the whole of what §8 needs from the engine, and neither is useful alone.                                     |
| **P8** | G7 §988                                 | open     | Promoted from unscheduled. §8 requires a live FX process; on a pinned rate a §988 gain is identically zero, so this was free to defer and no longer is.                 |

P7 is behaviour-preserving for any scenario that authors no expense events — which,
measured, is **every** saved scenario. P8 is not: it changes tax in any plan holding
foreign-currency debt across a moving rate.

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
4. **Does drawing an offset for a private purpose change the deduction?** §3 G3's
   "error 2" and its own next paragraph on offset-vs-redraw read in opposite
   directions, and §8 leans hard on the second. `deductibleFraction: null` preserves
   what I take to be the correct treatment, so nothing is broken — but the reading
   should be settled before anyone acts on §8's tax argument. See §8.3.

---

## 8. The AUD-liquidity option — what the offset is actually for

§1 frames the whole document around a **return** comparison: a dollar against the debt
earns `r_loan × (1 − MTR)`, a dollar invested earns `E[r_asset]` with variance. That
framing is correct and it produced a clean answer. It also produced a result it cannot
explain: **a fully offset loan is a balance-sheet no-op**, identical to never having
borrowed. It costs nothing and it earns nothing.

Which means the return framing can rank the *uses* of the facility but is structurally
incapable of valuing the *facility*. Any recommendation to hold the loan rests entirely
on option value, and nothing in §1's comparison prices an option.

### 8.1 The option has a name

It is a **call on domestic-currency liquidity**. For a household whose assets sit
predominantly in one currency while its liabilities and its lumpy spending needs sit in
another, the offset is the right to fund a large domestic expense without:

1. **converting** at whatever the exchange rate happens to be on the day of the need;
2. **liquidating** foreign assets into whatever the market happens to be on that day;
3. **realising** a capital gain in either jurisdiction.

Three legs, and they are not equally large. The **tax** leg is the most certain: an
offset withdrawal is not a disposal in any jurisdiction, whereas selling foreign
securities is a realisation in both. The **sequence-risk** leg is next: a forced
liquidation lands precisely in the worlds where a plan is already failing, so its cost
is concentrated exactly where it hurts. The **FX** leg is the smallest and the least
certain — which is worth saying plainly, because it is the one that sounds most
compelling.

### 8.2 It is not a hedge, and the difference matters

**Filling the offset is FX-*neutral*, and that is what makes it work.** A full offset is
a domestic-currency asset exactly matched by a domestic-currency liability: net exposure
zero. Emptying it into foreign assets does not remove a hedge — it *creates a short*
domestic-currency position, financed at the loan rate.

So the strategy is not "hedge using the offset." It is: hold a zero-cost, zero-exposure
position that can be converted into domestic spending on demand. Calling it a hedge
invites sizing it against currency exposure, which is the wrong axis; it should be sized
against **plausible domestic cash needs**.

That is a different sizing rule from the one a leverage framing implies. Leverage is
sized to what you can service. An option is sized to the exposure it covers — which may
be far less, or occasionally more, than the maximum facility available.

### 8.3 Why an offset specifically, and not "borrow later"

Two reasons, and both survive the model being silent on them.

**Tax character.** §3 G3's statutory point cuts directly here. An offset withdrawal is
the borrower's own money and leaves the loan's character untouched; a redraw is new
borrowing whose character is set by what the redrawn money buys. Where the security is
an income-producing property, drawing the offset to fund a deductible expense on that
property restores deductible interest on the drawn amount *and* the expense itself is
deductible. Selling foreign securities achieves neither. (Subject to open question 4.)

**Serviceability.** A facility originated while wage income exists cannot be
re-originated once it does not. "Borrow later if needed" is not a substitute for a
facility that already exists; it is a bet on a future underwriting decision. This is the
one part of the original premise — *take it while you can qualify* — that was always
right, and it is right for this reason rather than for a return reason.

### 8.4 None of this is currently measurable, and the reason is specific

Three blockers, in order of severity:

- **FX is pinned.** `fxProcessModel` defaults to `NONE`. **An option on an exchange rate
  is worth exactly zero in a model with a constant rate.** This does not invalidate any
  existing result — those answer the return question, which is FX-insensitive by
  construction — but it does mean every result to date is *silent* on this one, rather
  than negative on it.
- **No dated, currency-denominated expense** (G8). The event the question is about
  cannot be authored.
- **No targeted funding** (G9). The draw itself cannot be expressed as distinct from
  "hold forever" or "spend it first."

### 8.5 The FX process, decided

`MEAN_REVERTING` primary; `RANDOM_WALK` as a sensitivity; `fxVolatility` an axis in
both. This is a decision, not a default, and picking wrongly answers a different
question:

- **Mean reversion** pins the long-run level and leaves *timing* risk — which is exactly
  what a timing option monetises. It is the model under which the option's value is a
  real, isolable quantity.
- **A random walk** introduces permanent *level* risk. The offset does **not** hedge
  level risk — it is a zero-exposure position (§8.2) — so a random-walk-only study
  measures something the strategy never claimed to do and understates the option.

### 8.6 The output that settles it

Not another terminal-wealth table. A **break-even on exercise**: *how large, and how
likely, does a domestic-currency cash need have to be before the option covers its
carrying cost?*

Same shape as the break-even-return framing that was the best idea in the return study,
and for the same reason: a break-even is a number a person can hold an opinion about,
and a wealth delta is not. Three paired arms on shared seeds — draw the offset, sell
foreign assets and convert, and a no-expense control to isolate the shock's own cost —
give the option's value per world directly as the paired delta.

### 8.7 One interaction to carry into the arms

With the offset full, G6's IO-expiry term is **inert**: a P&I payment at zero accrued
interest merely moves money between two accounts on the same balance sheet.

**That inertness ends at exercise.** A drawn offset re-exposes the plan to the term, and
does so at the moment cash is tightest — the payment steps up precisely when the reason
for drawing has not gone away. Any arm that exercises must run G6 live, and a study that
holds G6 fixed because "it was inert last time" will silently understate the cost of
exercising.
