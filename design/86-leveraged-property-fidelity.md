# 86 — Leveraged property fidelity: loss carryforward, interest-only debt, and interest deductibility

**Status** (2026-08-06): **IMPLEMENTED**, except G3's standalone-loan half (§3 G3).
§8.6's study is **RUN** (§10.1). Phase table in §5. Full suite green (4,506 + 996).

**P6's UI surface landed last** (2026-08-05) and is written up in §9. It closed the
last gap between "the engine can do it" and "a person can author it", and closing it
surfaced three defects that only an authoring surface makes reachable — including a
schedule gate that would have made the new *Interest Only* checkbox model a loan that
is never paid at all.

**Extended** (2026-08-05) with §8: the offset reframed as a *domestic-currency
liquidity option* rather than a return bet. That reframing is what finally gives the
"hold the loan" recommendation something to stand on, and it opens two new gaps —
**G8** (dated, currency-denominated one-off expense) and **G9** (fund an expense from
a nominated account) — plus it promotes **G7** from unscheduled to load-bearing.

**P7 and P8 are now BUILT** (2026-08-05), so every gap in this document is closed
except G3's standalone-loan half. Full suite green at that point (4,487 + 977).

**§8.6's study has now been RUN** (2026-08-06) — the thing the whole document exists
for. Method and what it changed are in §10.1; the corrections it forced are folded into
§8.4 and §8.7 where they belong. The headline is that the offset prices as **insurance,
not as a return bet**: near-zero carrying cost, a thin positive median on wealth, and
protection concentrated in the bad tail — at the studied facility size, zero worlds in
which parking the facility made solvency *worse*, against a nonzero count it rescued.
(That last property is **size-dependent** and does not extend to arbitrarily large
facilities — §10.4.) Most of the earlier return-framed advantage turned out to be two
study artefacts, not economics.

Running it also added one lever (`offset.fromBalance`, §10.1) and three method rules
that generalize beyond this document: a dated shock must be an axis and never a
constant; every stochastic consumer shares one RNG, so an FX-process comparison has to
switch the others off; and a deterministic grid systematically **overstates** an option
because the arm holding more risk has no upside tail to express.

**What is left is in §10**, and it is genuinely small: G3's standalone-loan half
(§10.2), §7's open questions, and the **facility-size** question §8.2 poses. The
original arms all fixed the facility at one size, so "how big should the loan be" was
asked and never answered; the `fromBalance` lever makes it expressible and **both views
are now run**. The wealth view supports only a threshold claim — below a certain size
the facility does no work — because above it the ordering between sizes is unstable.
The solvency view is cleaner and is the answer: rescue count climbs with size and is
still climbing at the largest size tested, so **no ceiling was found**. What stops that
being "borrow the maximum" is in §10.4, and it matters.

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

**Error 1 (a standalone investment loan deducts nothing) — BUILT as P9; see §10.2.**
The tempting shortcut was to emit the existing `AU_RENTAL_INCOME_TAX` action with a
negative amount, which needs no new action type, reducer or toolset wiring. **That is
wrong**, and only became wrong when G5 landed: that action feeds
`usPassiveActivityIncomeYTD`, so a borrow-to-invest interest deduction routed through
it would be *suspended under §469*. Interest on money borrowed to buy securities is
**§163(d) investment interest** — limited to net investment income, with its own
indefinite carryforward — not a passive activity loss. The two limitations have
different bases, different carryforwards and different release conditions.

So it got its own channel, and the §163(d) limitation with it. The consequence line
this section used to carry — *an arm that borrows against something other than the
rental and invests the proceeds is not yet modellable* — no longer applies. An arm
that borrows against the rental always was modellable: under tracing rules the loan's
character is fixed by what it originally funded, and drawing on an *offset* (the
borrower's own money) does not disturb it.

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

**The UI surface is now built too — see §9.** Until it was, the term was reachable only
from a spec file, which meant the single largest risk in the plan could not be authored
in the app that the plan is actually maintained in.

---

### G7 · No §988 gain or loss on foreign-currency debt

A US person repaying AUD-denominated debt realises exchange gain or loss under §988,
recognised as ordinary income on each payment. Unmodelled. Over a 25-year loan across
a moving USD/AUD path this is not small, and it is a **cost of holding foreign
leverage specifically** — which makes it in-scope for the question this design serves,
even though it is the lowest-value item here. Documented, not scheduled.

**Promoted by §8, and BUILT as P8.** This was the lowest-value item while every run
held the exchange rate constant, because a §988 gain on a pinned rate is identically
zero — measured, and confirmed: `fxProcessModel: NONE` produces exactly zero §988
events in every year. §8 requires a live FX process, and the moment the rate moves this
stops being a rounding error.

**Built.** `bookingFxRate` on `LoanAccount` and `mortgageBookingFxRate` on
`RealProperty` record the rate the debt was incurred at; each principal repayment
emits `SECTION_988_GAIN`, classified on the US return as ordinary income
(§988(a)(1)(A)), US-sourced by the taxpayer's residence (§988(a)(3)(A)) and therefore
in no foreign §904 basket. Four things are worth recording because they were decisions,
not transcription:

- **It is computed in the reducer, not the handler.** The handler's `payment` is only
  the *scheduled* one; when the cash pool is short the reducer funds less, and only
  principal actually repaid realizes exchange gain or loss. Computing it upstream
  would book §988 on money that was never paid.
- **The §988(e) asymmetry is modelled, because it is the point.** The income-producing
  share recognizes gain *and* loss; the personal share recognizes gain (above the
  §988(e)(2) \$200 de minimis) while the matching loss is disallowed as a personal loss
  under §165(c). Measured on an identical currency move: a loss that is fully
  deductible against a rental is worth **nothing at all** on the same property
  unrented. The business fraction reuses G3's `deductibleFraction` — §988(e)(3)'s "to
  the extent … §162 or §212" is the same fraction as s8-1's, and inventing a second
  knob would mean maintaining two independently-wrong ones.
- **A §988 loss must NOT be netted into `usOrdinaryIncomeYTD`.** That is G5b exactly:
  gross income falls, the baskets do not, and the §904 partition collapses. It is
  carried in `usSection988LossYTD` and enters `computeTax` through **both** `agi` and
  `unrelatedDeductions` — the pair `usNegativeIncomeYTD` already uses, which is what
  keeps `totalTaxable = grossIncomeAllSources − unrelatedDeductions − FEIE` exact.
  There is a regression asserting a large §988 loss beside foreign income leaves the
  invariant satisfied.
- **Added principal re-books at a balance-weighted harmonic mean.** Negative
  amortization or a redraw makes the debt a blend of dollars borrowed at two rates;
  preserving the total USD booking value is the only blend that does not manufacture
  §988 later out of an accounting choice.

**Two structural silences, and they are the finding rather than a caveat.** An
interest-only loan repays no principal, so it recognizes **nothing** until it
amortises or matures — deferring decades of currency movement into whichever year the
balloon lands, as a single lump of ordinary income. A fully offset loan is equally
silent, because an offset suppresses interest without repaying principal. **§988 bites
on repayment, not on holding the debt**, which means it does not weigh against holding
a fully-offset facility at all — it weighs against *exercising* it.

**Not modelled:** the §988 item on interest between accrual and payment
(Reg. §1.988-2(b)(3)) is identically zero here because the two are simultaneous. Nor is
§988 on the AUD *deposit* in the offset account itself; that is a separate transaction
class and is out of scope.

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

**BUILT as P7**, exactly as proposed below. `HEALTHCARE` → `EXPENSE_EVENTS`,
`healthcareEvents` → `expenseEvents`, `HEALTHCARE_EXPENSE` → `EXPENSE_EVENT`. The
scheduling helper (`buildExpenseEventSchedule`) lives beside the handler rather than in
either toolset, because both retirement toolsets schedule these and a field added on
one side only would change behaviour depending on which toolset owned the scenario.
The `healthcareSpendingYTD` defect below was real and is fixed. Two things the
implementation learned:

- **`reducer-coverage-manifest.js` gates reducer renames** and caught this one, which
  is what that gate is for.
- **A blank UI field must write `null`, not `''`.** The handler resolves the
  denomination with `currency ?? property ?? household`, and an empty string is not
  nullish — it would win that chain and reach the converter as a bogus currency code.

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

**BUILT as P7**, as proposed. `fundFrom` on an expense event: a state key debited
**directly**, falling back to the existing residency-default path when absent, or when
the nominated account cannot cover the amount. Explicitly *not* routed through
`drawdownPriority`, or the artefact above returns by another door.

Verified end-to-end across two currencies: an A\$150,000 event against a nominated
account holding less than that drew what the account had, sent the remainder down the
default path, and the two legs summed to **exactly** the event amount — each converting
at its own account's edge. A part-funded event must not silently under-spend, and does
not.

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

When this document was written `scripts/lib/variant.mjs` had **no loan or offset
lever**, and the parameter generator emitted no params for a property's mortgage
balance, payment, or rate spread, nor for an offset balance. Every axis of a leverage
study was unreachable from a spec file, so none of this would have been measurable even
once built. **All of the following are now built** (P1, then P7).

- **`loan` lever** — `{ balance, monthlyPayment, primeSpread, interestRate,
  interestOnly, deductibleFraction, interestOnlyUntilYear, maturityYear }` against a
  loan state key. (The term is two **absolute calendar years**, not the `termMonths`
  this section first proposed — see §3 G6 for why: a borrower knows the dates, not the
  duration, and it matches `plannedSaleYear` / `moveYear` elsewhere.) The lever writes
  the property field or the account field per key, whichever that loan is.
  It briefly seeded a placeholder `monthlyMortgage = 1` to force a payment event onto
  an interest-only mortgage; **that hack is gone** now the toolsets gate on
  `propertyNeedsLoanPayment` (§9.2).
- **`offset` lever** — `{ balance, deployTo: <stateKey> }`, where `deployTo`
  **moves** value to a named account rather than creating it. Arms that don't hold
  total wealth constant are not comparable, and that is the easiest thing in this
  whole area to get wrong.
- **`expenseEvents` lever** (P7) — dated one-off expenses in a chosen currency,
  optionally funded from a nominated account. It **appends** rather than replacing, and
  auto-enables the `EXPENSE_EVENTS` strategy by appending to `spendingStrategy` —
  which is a multi-select, so clobbering it would disable the plan's real spending
  strategy and change every arm rather than the one under test.
- **`randomSeed` param** (§8.8) — not a `variant.mjs` lever but the same class of
  problem: until it existed, no spec file could vary a stochastic run's path at all.

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
| **P4** | G3 `deductibleFraction`                 | **done** | The rental-path half. The standalone borrow-to-invest half shipped separately as P9 once P5 had shown why it could not share the §469 channel.                          |
| **P6** | G6 term / IO expiry + the loan UI (§9)  | **done** | Depends on G2. Turns "hold leverage forever" into a testable assumption — and, with §9, one that is authorable rather than spec-file-only.                              |
| **P7** | G8 expense events + G9 `fundFrom`       | **done** | One change: G9 is a field on G8's entry. Together they are the whole of what §8 needs from the engine, and neither is useful alone.                                     |
| **P8** | G7 §988                                 | **done** | Promoted from unscheduled. §8 requires a live FX process; on a pinned rate a §988 gain is identically zero, so this was free to defer and no longer is.                 |
| **P9** | G3 error 1 — §163(d) / s8-1 channel     | **done** | The last gap. Deliberately last: it needed P5 to exist before it was clear it must not reuse P5's pool. See §10.2.                                                      |

P7 is behaviour-preserving for any scenario that authors no expense events — which,
measured before the change, was **every** saved scenario, so there was no migration.
P8 is not behaviour-preserving in principle, but it is inert wherever the exchange rate
is pinned, which is every run predating §8.

Both landed with the full suite green (4,487 + 977).

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
  **WRITTEN** — `tests/unit/evt-offset-no-yield.test.mjs`. Four assertions, in the order
  a reader needs them: the sleeve really is stamped `SAVINGS_AU`/`SAVINGS_US` by the
  same `resolveRateKey` call every other cash sleeve uses (so the key looks like an
  oversight); that rate is non-zero in a live run and design 60's own compute helper,
  pointed at the offset, *would* pay it (so the behaviour rests on wiring, not on a 0%
  rate); no handler in a loaded sim is registered against an offset stateKey or either
  offset role; and over a year the offset does not move by a cent. The last two each
  carry a control — the same scan finds `AuSavingsInterestHandler` on the savings
  account, and that account compounds over the same year — because an assertion of
  absence that also passes on a broken detector or a dead run pins nothing.
  Verified by mutation: adding the offset roles to the AU `CASH_SLEEVE_INTEREST` wiring
  (the exact "fix" this guards against) turns both of those red.
- **A regression that a rental-linked loan does NOT also emit the P9 deduction** — the
  one failure mode that would deduct the same interest twice, silently, with every
  existing test still green. It is the first test in
  `tests/unit/evt-investment-interest.test.mjs` for that reason.
- **Golden re-baseline** at P3, with the direction and magnitude of the change stated
  in the commit rather than inferred later.
- **A regression that a §988 loss leaves the §904 partition intact** (P8). This is the
  same failure G5b already cost a study run once; the loss is routed away from
  `usOrdinaryIncomeYTD` precisely to avoid it, and that routing is a decision nothing
  else in the code makes obvious.
- **A regression that omitting `randomSeed` is byte-identical to seed 1** (§8.8), and
  that an explicit `buildSim({ seed })` still wins. The second is what stops a scenario
  parameter from silently collapsing every Monte Carlo path onto one ordering.
- **Authoring-surface regressions** (§9). Three, all pinning silent failures rather
  than rendering:
  · a blank term field round-trips as `null`, not 0, through both editors and the
    controller — `maturityYear: 0` and `deductibleFraction: 0` are real, and mean
    something quite different from "unset";
  · the LOAN_PAYMENT schedule gate fires for an interest-only mortgage with a zero
    payment, and for a standalone loan with no property in the scenario at all;
  · an **end-to-end** run with an authored standalone `LoanAccount` whose balance
    actually falls. That one is the only test that would have caught all three of
    §9.2's defects at once, because each of them leaves a loan sitting untouched.

  Files: `tests/unit/loan-account-authoring.test.mjs`,
  `tests/viz/editors/{loan-account-fields,mortgage-term-fields}.test.mjs`.

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

   **P8 raised the stakes on this one.** `deductibleFraction` is now doing double duty:
   it sets the s8-1 deduction *and*, via §988(e)(3), decides whether an exchange loss is
   deductible at all. Reusing it is right — the two provisions ask the same question —
   but it means an answer to Q4 moves two numbers, not one.

5. **Should the AU offset *deposit* be a §988 transaction too?** P8 covers foreign
   currency **debt** only. A US person's foreign-currency bank balance is also §988
   property, with gain or loss on disposition. For a personal account §988(e) and its
   \$200 de minimis apply, so the amounts are usually small — but "usually" is not
   "always" for a balance of this size, and the offset is precisely the account §8 is
   about. Out of scope, deliberately, and flagged rather than silently omitted.

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

### 8.4 What blocked this, and what remains

Three blockers were identified; **all three are now closed.**

- **FX is pinned.** `fxProcessModel` defaults to `NONE`. **An option on an exchange rate
  is worth exactly zero in a model with a constant rate.** This does not invalidate any
  existing result — those answer the return question, which is FX-insensitive by
  construction — but it does mean every result predating §8 is *silent* on this one,
  rather than negative on it. Turning the process on is a parameter, not a change.

  **Measured (§10.1): this is true of the FX leg and only the FX leg.** §8.1 names
  three, and under a pinned rate the other two still bite hard — an offset draw is not
  a disposal in either jurisdiction where a sale is one in both, and a forced
  liquidation still lands in the worlds where the plan is already failing. Most of the
  option's measured value turned out to be those two. So the blocker was real for the
  reason stated, but the pinned-rate results were *understating* the option rather than
  saying nothing about it.
- **No dated, currency-denominated expense** — G8, built as P7.
- **No targeted funding** — G9, built as P7.

A fourth blocker surfaced only once P8 made it visible, and it was the most dangerous
of the four because it fails quietly: see §8.8.

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

**Measured (§10.1): the interaction is larger than that, and it does not need an
exercise to fire.** An offset is the loan's *default payment source* —
`resolvePaymentSourceKey` prefers an explicit `paymentSourceKey`, then a same-currency
offset on the loan's property. So the moment the IO period ends and P&I begins, every
payment drains the offset. The drawable balance therefore follows the amortisation
schedule down to zero, and **the option has a maturity nobody authored**: not the
loan's stated maturity, but the date the offset runs out.

That is what makes the exercise value strongly timing-dependent. Early, with the offset
near full, it is worth several percent of terminal after-tax wealth. Late, the offset
cannot cover the need, the draw falls through to the same liquidation the other arm
performs, and the two arms converge — the option is worth almost nothing, not because
the need got cheaper but because the right to draw has amortised away. A study that
exercises at one date is measuring one point on a decaying curve.

It also makes the surface a **step function in the size of the need**, with steps at two
balance-sheet boundaries: the drawable balance itself (a draw that empties the offset
un-offsets the loan for its remaining life), and the point at which the selling arm
exhausts domestic cash and its cascade reaches the tax-gated wrappers. Quote the
surface, never a single break-even number.

P8 adds a second interaction of the same shape. §988 recognizes nothing on a
fully-offset or interest-only loan (§3 G7), so exchange gain and loss are **also** zero
until exercise — and then arrive concentrated. Both of the plan's deferred risks,
IO-expiry and currency, are triggered by the same act.

### 8.8 The seed was not reaching the RNG — found while building P8

Every stochastic process in the engine — FX (design 47), the yield curve (design 67),
equity return paths (design 74) — draws from the single seeded `sim.rng`. There was **no
scenario-level parameter feeding it.** `buildSim({ seed })` defaulted to 1 and only the
Monte Carlo runner ever passed anything else, so every deterministic run of a stochastic
scenario drew the identical sequence.

This is worse than a missing feature, and it is worth stating plainly because it is the
kind of thing that produces confident wrong answers: a seed sweep *appeared* to work.
Eight different seeds returned eight results that happened to be identical, which reads
as "the answer is robust to the path" when it actually means "one path was measured
eight times." Design 74 fixed the mirror-image defect inside Monte Carlo; the single-run
side was never wired at all.

**Fixed** by a `randomSeed` parameter applied in `ScenarioLoader`. The location is
forced: `buildSim()` runs *before* the params are loaded, so at construction time the
scenario does not yet know its own seed. `Simulation.reseed()` repoints the generator in
place, which is safe because `createRNG` returns a closure that re-reads `rngState` on
every call, so a handler that already captured `sim.rng` is unaffected.

**Precedence is the load-bearing part.** An explicit `buildSim({ seed })` always wins
over the parameter. Monte Carlo depends on that: its per-iteration seed is the entire
mechanism by which paths differ, and letting a scenario parameter override it would
collapse every iteration onto one ordering — design 74's defect, re-entered from the
other side. The default changed from `1` to `null` purely so that "the caller said
nothing" is distinguishable from "the caller asked for 1"; a run that sets no seed is
byte-identical to before, and there is a regression pinning that.

**Consequence for §8.6's study:** paired arms on shared seeds are now actually possible.
They were not before, and a paired Monte Carlo run on the old code would have compared
arms across a single FX world while reporting per-path deltas.

---

## 9. The authoring surface — P6's UI, and the three defects it found

Every gap above shipped as engine plus a `scripts/lib/variant.mjs` lever, on the §4
argument that unreachable from a spec means unmeasurable. That argument is right and it
is also only half the story: **unreachable from the app means unmaintainable**. The
plan this model exists to serve is edited in the workbench, and until this phase a loan
could not be seen there at all, let alone given a term. Interest-only, the IO expiry,
the maturity year, the stated deductible fraction and the §988 booking rate were all
spec-file-only — which is to say the single largest risk in a leverage plan (§3 G6's
half-million-dollar reversion) was invisible to the person holding the plan.

### 9.1 Two surfaces, because there are two kinds of loan

- **A mortgage** is not an authored account. It is synthesized at build time from the
  property record (`synthesizeLoanForProperty`, design 54 P2), so its terms belong on
  the **real-property editor**. The mortgage fields, previously scattered between the
  header block and the rental block, are now one *Mortgage* section carrying balance,
  payment, rate, and the five design-86 fields.
- **A standalone `LoanAccount`** has existed since design 54 and had no UI whatsoever —
  the type select offered no "loan". The **account editor** now does, with the same
  terms plus the two links (`linkedPropertyKey`, `paymentSourceKey`).

### 9.2 What building it exposed

Three defects, none of which any test would have caught, because each is only reachable
once a person can author the field:

1. **The LOAN_PAYMENT schedule gate was `monthlyMortgage > 0`.** An interest-only loan
   *derives* its payment, so that field is inert — and a mortgage with the new
   *Interest Only* box ticked and the payment left at 0 would have been scheduled no
   payment event at all. The loan would have sat there accruing nothing, being paid
   nothing, looking like a modelling choice. The gate is now
   `propertyNeedsLoanPayment` / `accountNeedsLoanPayment` (loan-classes.js, beside the
   handler for the P7 reason: a field honoured on one side only changes behaviour with
   whichever country owns the record). `variant.mjs` had papered over exactly this by
   seeding a placeholder `monthlyMortgage = 1`; that hack is deleted.
2. **`bookingFxRate` was never serialized.** A LoanAccount's §988 booking rate — the
   basis every exchange gain is measured against — survived neither save nor reload, so
   an authored rate silently reverted to "stamped at the first payment". That
   understates §988 rather than erroring, which is the failure mode this document keeps
   running into.
3. **An authored loan's terms never reached runtime state.** `_accountToStatePlain`
   projected balance and type but no rate, payment, links or terms, and
   `LoanPaymentHandler` reads *state*, not the record. So a standalone loan was a debt
   in net worth that nothing ever serviced. This is the offset link's bug (design 53
   §3) re-appearing one field-set over, and the fix is the same shape.

Together those three are the difference between a loan type that exists and one that
works. An e2e regression now runs a full scenario with an authored standalone loan and
asserts the balance actually falls.

### 9.3 Decisions worth recording

- **A blank term field is `null`, not 0.** `maturityYear: 0` is a loan due in year zero
  and `deductibleFraction: 0` states that nothing is deductible — both are real,
  authorable values that mean something quite different from "unset", which is what
  every pre-86 loan is and must remain. Both editors and the controller coerce blanks
  to null on every path.
- **The deductible fraction is clamped to `[0, 1]`.** Typing `50` meaning 50% would
  otherwise multiply both the s8-1 deduction and the §988(e) business split by fifty.
- **The loan property picker hides properties that already carry a mortgage.** Such a
  property synthesizes its own `<propertyKey>Loan`, and `findLoanForProperty` prefers
  that slot — so a second authored loan against the same house would double the debt
  while the authored half stayed invisible. A loan already linked to one keeps its
  option, so re-saving never silently unlinks it.
- **A liability hides its drawdown and minimum-balance rows,** and labels `balance` as
  *Principal Owed*. The ctor already forces `drawdownPriority` null (design 54 §8);
  showing an editable field for it invites the offset mistake §3 G9 measured.
- **The loan rate is its own input, not the cash-rate field.** `LoanAccount` reuses
  `interestRate` for the *loan* rate, which is a different quantity from the cash
  earnings rate the savings/brokerage field edits. Storage is Prime-relative either way
  (design 56), so the two look alike and must not be wired alike.
- **A term hint states the loan's life in words** under the fields, because the failure
  case is silent: an IO expiry with no maturity year has no term to amortise over, so
  `scheduledLoanPayment` falls back to the authored fixed payment. That is a real
  branch, and almost never what was meant.

### 9.4 What is still not authorable

~~**A standalone loan's interest is still deducted nowhere**~~ — closed by P9 (§10.2).
The account editor's *Deductible Frac.* field now does all three jobs it appears to do:
the rental deduction, the §988(e) business share (§3 G7), and — on a standalone loan —
the s8-1 / §163(d) deduction. Its tooltip, which used to state the deferral in so many
words, now states the split treatment instead.

---

## 10. What is left

Ordered by what unblocks what, not by size. Nothing below is in flight.

### 10.1 §8.6's study — **RUN.** What it took, and what it changed

The study is built and executed: four paired grids plus a paths-based Monte Carlo, with
the FX process on, G6 live in every arm, and `randomSeed` a real axis. The spec, the
runner and the numbers live outside this repo's public tree, as plan figures always do.
What belongs here is the method, because **most of the effort went into establishing
that the arms measured what they claimed**, and three of the four things that had to be
fixed fail silently.

**A new lever: `offset.<key>.fromBalance`.** Studying a facility larger than the one a
scenario authors raises the liability via the `loan` lever — and the proceeds have to
land somewhere in *every* arm. They did not. Raising an offset with no `deployTo`
credits the difference (correctly: it is the loan proceeds), while the arm that deploys
the facility starts from the authored balance and carries the extra debt without the
extra asset. `fromBalance` credits the drawn facility first, so both arms hold the same
pot. Regression in `tests/unit/variant-loan-offset.test.mjs`, including a case that
pins the defect itself so a spec omitting `fromBalance` cannot be mistaken for one that
does not need it.

**A dated crash is not a background condition.** The plan this was run against authors a
dated market crash. The arm that deploys holds more equity, so the crash lands on it
harder — and it accounted for *most* of the apparent advantage of parking the money.
Removing it moved the no-exercise delta by an order of magnitude. It is an axis in the
surface grid and removed outright everywhere else; a study that holds it fixed is making
a statement about one foreseen date.

**Stochastic consumers share one RNG, so switching one on re-orders the others.** A
property's `BERNOULLI` repair model draws from the same seeded `sim.rng` as FX, the
yield curve and equity paths. Two consequences, both fatal to an FX comparison: under
`fxProcessModel: NONE` the seed axis is *not* inert, so "NONE is the control" was false;
and turning FX on shifts the repair draws, so NONE-vs-live at a fixed seed is not
holding repairs constant. Any grid comparing FX process models must switch every other
stochastic consumer off — after which the FX-pinned panel is byte-identical across every
seed, which is the check that it is a control at all.

**One seed is one world.** §8.8 fixed the seed reaching the RNG; it did not make a
single seeded run a result. A one-seed FX grid produced sign-flipped cells that the
twelve-world view showed to be that seed's outlier. Paired grids over a stochastic
process need reducing over the world axis — median *and* the count of worlds whose sign
agrees — not one panel per seed.

**Four findings that change what §8 says about itself.** Three are written up where they
belong: §8.4's claim that the option is worth zero under a pinned rate is true only of
the FX leg (see the note added there); §8.7's IO interaction is larger and differently
shaped than described (see the note added there); and the carrying cost, once the arms
are matched and the dated crash removed, is approximately zero — which is §8's own
opening premise measured rather than asserted, and *not* what the earlier return-framed
study reported.

The fourth is about **which run to believe**, and it is a general lesson rather than a
§8 one. The deterministic grids and the paths-based Monte Carlo disagree about the
*direction* of the exercise value in the size of the need: the grids say it grows, the
Monte Carlo says it shrinks. Both are right about their own world. A grid holds the
return fixed, so the arm holding more equity has no upside tail to express and the
option looks uniformly good; with sampled paths that tail is real, and in the good
worlds it swamps everything the option saves. **A deterministic surface systematically
overstates an option**, and overstates it more the larger the exercise. Quote the paths
run.

What survives both is the shape §8 predicted and the return framing did not: near-zero
premium, a thin positive median on wealth with roughly a third of worlds mildly behind,
and — the cleanest number in the study — **zero worlds in which holding the facility
made solvency worse**, across every need size, against a nonzero count it rescued. An
insurance payoff, concentrated in the bad tail, which is §8.1's ordering of the three
legs confirmed rather than assumed.

**Consequence for the earlier return study.** It predates `fromBalance` and holds the
dated crash fixed, so its magnitudes do not stand. Re-running it is mechanical — add
`fromBalance` to every arm that sets an offset balance, clear the dated shock — and the
instructions are written into that study's own run sheet rather than here.

### 10.2 G3 error 1 — a standalone investment loan deducts nothing — **CLOSED**

**Built as P9.** The *Deductible Frac.* field is no longer partly inert: on a standalone
loan it now drives an s8-1 / §163(d) deduction as well as the §988(e) business share.
The consequence line can be struck — **an arm that borrows against something other than
the rental and invests the proceeds is now modellable.**

It got its own channel, as §10.2 required. `US_INVESTMENT_INTEREST_DEDUCTION` /
`AU_INVESTMENT_INTEREST_DEDUCTION`, emitted by `LoanPaymentHandler` and classified in
each country's tax module, with `_computeInvestmentInterestLimitation` in
`us-tax-rates-base.js` applying §163(d) and `usInvestmentInterestCarryforward` persisted
at the settle beside the §469 pool. The pool *shape* is P3/P5's; the pool is not.

Five decisions worth recording, because four of them are places the obvious
implementation is wrong:

1. **Only a standalone loan emits.** A rental-linked loan already deducts through
   `computeRentalMonth`'s `deductibleInterest`, scaled by the same field. Emitting here
   too would deduct the same interest twice, and nothing else in the suite would notice
   — so that is the first test in the file.
2. **`deductibleFraction: null` still deducts nothing.** Deductibility follows the USE
   of the borrowed funds, nothing traces proceeds into what they bought, and every
   pre-86 loan carries the null. A stated `0` agrees on the number and differs on the
   claim, which is the distinction §9.3 already fought for on the term fields.
3. **`min(interest, payment)`, not the accrual.** An individual is cash-basis. On a
   negatively amortising loan the unpaid interest is capitalised into the balance and
   is not yet deductible — deducting the accrual would relieve tax on money that never
   left the borrower, in precisely the interest-only arms this document exists to study.
4. **The two jurisdictions genuinely differ on the same loan, and that is the finding.**
   Australia allows the whole amount against any assessable income — negative gearing —
   and if that drives the year negative, G1's Div 36 pool already carries it, so the AU
   half needed no new machinery at all. The US quarantines it to net investment income
   and pools the rest indefinitely. The AU half is ten lines; the US half is a
   limitation. A single "deduct the interest" path would have been wrong in one country.
5. **It is accumulated POSITIVE and never nets into `usOrdinaryIncomeYTD`.** The G5b
   lesson: a negative that lowers gross income while leaving every foreign basket
   untouched stops the baskets partitioning income and collapses the §904 denominator.
   It enters via `agi` AND `unrelatedDeductions`, exactly as the §988 loss does.

**Two approximations, stated rather than buried.** The deduction is taken above the
line, because this model has no itemized-deduction machinery and §163(d) interest is a
Schedule A deduction — the same shortcut `usSection988LossYTD` takes, and the larger of
the two errors. And the §163(d)(4)(B)(iii) election (treat net capital gain as
investment income, at the price of the preferential rate on the elected amount) is not
modelled; not electing is the statutory default and the conservative one, but it means a
large-gain year does not unlock the deduction the way a real return might elect to.

**Inert until stated**, and measured so: the full suite (4,531 + 996) is green with no
re-baseline, and `npm run crossfoot` foots every linked line on both returns. Note what
that last check can and cannot see — crossfoot only verifies lines carrying a
`drillReport` link, and the two new §163(d) worksheet lines carry none, so it is
evidence this channel broke nothing, not evidence the channel itself foots. The
cross-year behaviour is pinned by the end-to-end tests instead.

Tests: `tests/unit/evt-investment-interest.test.mjs` (22).

### 10.3 Open questions still unanswered

§7's five, unchanged by the UI phase — except that **Q4 got sharper**. Q4 asks whether
drawing an offset for a private purpose changes the deduction; `deductibleFraction` is
now a field a person can type a number into, on two screens, and it moves two provisions
at once (s8-1 and §988(e)(3)). §8's tax argument leans on the answer.

Q2 (does an AU loss pool survive a residency change?) is the one most likely to bite a
cross-border run silently.

### 10.4 Facility size — answered on both views; no ceiling found

§8.2 states the sizing rule ("an option is sized to the exposure it covers, not to what
you can service") and then no arm ever tested it: every run to date fixes the facility
at one size. The `fromBalance` lever built in §10.1 is what makes a size axis
expressible at all, so this is now reachable rather than blocked.

**It needs a per-size grid, not an axis.** Sizing moves two lever paths in lockstep —
the loan's balance (the liability) and the offset's `fromBalance` (the proceeds) — and a
`variant-grid` axis writes one dotted path. One grid per size keeps them matched by
construction, and the zero-size grid is a free control: with no facility there is
nothing to place, so the paired delta must be *exactly* zero at every other axis.

The wealth view is run, and it supports exactly one claim: **there is a threshold, and
below it the facility does no work.** The smallest facility tested sits at or below zero
for every need that fits inside it, while every larger one is clearly positive at every
need. Above the threshold the ordering between sizes is *not* stable — it inverts with
the size of the need, and the cell-to-cell moves along a row exceed the differences
between columns, which is the same step-function behaviour §8.7 describes. Anyone
quoting an optimum off that surface is reading noise. It also prices neither
serviceability nor lender IO caps, and a deterministic grid overstates an option
anyway (§10.1).

**The solvency view settles it, and it is the cleaner of the two.** Measured against a
no-facility baseline on shared seeds, the count of worlds a facility *rescues* climbs
monotonically with its size and **is still climbing at the largest size tested** — so
the sweep found no ceiling, and the experiment has not yet reached its own constraint.
The smallest facility tested is inert on both metrics, which is the one place the wealth
and solvency views agree exactly. The counts are small (single-digit worlds out of
several hundred), so the finding is directional: *more facility is more insurance over
the range tested*, not a ranking of adjacent sizes.

Two things stop that being a recommendation to borrow the maximum. The constraint that
actually binds — **serviceability at origination** — is not represented in the model at
all, so this is a floor on the answer rather than a target. And §10.1's headline claim,
that parking the facility never made a world insolvent, is measured at *one* size and
**does not extend upward**: on the park-versus-deploy contrast the reverse-rescue count
goes from zero at the smaller facilities to nonzero at the larger ones. A bigger
facility is worth having and simultaneously raises the cost of getting the parking
discipline wrong. That mechanism is unexplained and worth finding, because the
insurance framing depends on it.

Two refinements the study wants and does not have. First, **the need should be sampled,
not dated** — every arm uses one need of known size and timing, which answers "what is
this facility worth given this shock" rather than "how big should the facility be".
Second, and larger: §8.7's drain has an **authorable escape** that nothing has tested.
An offset is only the loan's *default* payment source; `paymentSourceKey` overrides it.
Pointing the loan at an ordinary cash account would stop P&I consuming the cover, which
may be worth more than any sizing decision and is a single field.

### 10.5 Smaller, genuinely optional

- ~~**§6's "an offset earns no yield" regression**~~ — **DONE**, see §6. The reason it
  was worth writing rather than trusting: the offset's whole return in §8 is the loan
  interest it suppresses, so crediting it a savings rate as well pays the same dollar
  twice and quietly inverts the AUD-liquidity argument. Nothing else in the suite would
  have gone red.
- **A UI for the offset's idle capacity** (G4/P2). The metric is recorded per period;
  nothing surfaces it, so an over-funded offset still looks identical to a right-sized
  one in the app, which is the reading §8.2's sizing rule depends on.
