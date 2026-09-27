# 113 — Fixed-rate loans, fixed periods and split loans

**Status:** BUILT, 26 Sep 2026. Decisions D1–D4 were taken with the author before drafting.
§10 records what the build decided that the text above did not. §9 lists what is open.

## 1. The ask

Two loan shapes that the model cannot express today:

- **US fixed mortgage, 15 or 30 years.** The rate is fixed for the whole term. It is not a
  spread over Prime. Only a variable loan (a HELOC, or an ARM after its fixed period) should
  follow Prime.
- **AU fixed period, usually 3 to 5 years.** The rate is fixed for a window, and the loan then
  reverts to a variable rate. AU borrowers commonly split one mortgage into a fixed part and a
  variable part, so the offset keeps working on the variable part.

## 2. What the code does today, and why it matters

The ENGINE already has two rate modes. `resolveLoanRate` (`loan-classes.js`) returns
`Prime(country, t) + primeSpread` when the loan has a spread, and otherwise the absolute
`interestRate`, which is fixed for life. Design 56 Phase 3 kept the second mode for
back-compatibility.

**The editors can only produce the first mode.** Both loan forms, the Accounts loan
(`account-editor.js`, the `LIABILITY_TYPES` branch) and the property mortgage
(`real-property-editor.js`, the `mortgageInterestRate` branch), store the rate typed into the
form as `absolute − Prime(country)` whenever a Prime rate is configured. A Prime rate is
configured by default. So **every loan authored in the app is variable.** A US 30-year fixed
mortgage follows every Prime Rate Schedule step, and under `primeRateModel:
INFLATION_LINKED` it moves every year with inflation. On a US plan that overstates both the
cost and the risk of the mortgage in exactly the scenarios (high inflation) where a fixed rate
protects the borrower.

There is also no way to express "fixed until year N, then variable", and no split loan: the
Accounts form offers a Linked Property only for properties that carry no mortgage of their
own.

## 3. Decisions

| # | Question | Decision |
|---|---|---|
| D1 | Rate after a fixed period ends | A separate **revert rate**, entered as today's absolute rate and stored as a spread over Prime. AU lenders revert to their standard variable rate, which is usually above the rate a new customer is offered, and that step-up is part of the risk of fixing. |
| D2 | Offset during a fixed period | A per-loan checkbox, **off by default**. Most AU lenders give no offset on a fixed loan and a few give full offset. |
| D3 | P&I payment when the fixed period ends | **Re-amortise** the balance at expiry over the months left to maturity, at the revert rate. This needs a Maturity Year. |
| D4 | Scope | Rate type, fixed period and revert rate, the offset rule, **break cost on early payoff**, the **extra-repayment cap** and **split loans**. Re-fixing at expiry is out of scope (§9). |

## 4. The rate type

A loan gets a `rateType`:

| `rateType` | Rate at year `y` | Typical use |
|---|---|---|
| `VARIABLE` | `Prime(y) + primeSpread` | AU standard variable, HELOC |
| `FIXED` | `interestRate` for the life of the loan | US 15/30-year fixed |
| `FIXED_PERIOD` | `interestRate` while `y < fixedRateUntilYear`, then `Prime(y) + primeSpread` | AU 3–5-year fixed, US 5/1 and 7/1 ARMs |

A fixed period ends on 1 January of `fixedRateUntilYear`, the same convention as
`interestOnlyUntilYear` (design 86 G6): a calendar year the borrower knows, not a duration.

For `FIXED_PERIOD`, `primeSpread` holds the **revert** spread (D1). When no Prime rate is
configured, the revert rate is stored as the absolute `revertInterestRate` instead, mirroring
how the editors fall back to `interestRate` today.

**Back-compatibility.** `rateType` absent means the loan resolves exactly as today: a spread
makes it variable, and no spread makes it fixed. Every saved scenario and every golden fixture
carries no `rateType`, so none of them moves. The new fields are projected into state only
when set, for the same reason. The editors write `rateType` on every save from now on.

**Defaults for a new loan.** The Rate Type select defaults to `FIXED` for a US loan and
`VARIABLE` for an AU loan. Those are the common products in each market; the default is only
a starting point in the form.

**What reads the rate.** `resolveLoanRate` is the single place a loan's rate is resolved. The
payment accrual (`LoanPaymentHandler`) and the rental interest deduction
(`computeRentalMonth`) both call it, so they stay in lockstep, as design 56 intended.
`resolveLoanRate` needs the current year for `FIXED_PERIOD`. It takes it from the loan
country's tax period, as `LoanPaymentHandler` already does for the IO window.

## 5. Offset during the fixed window (D2)

`offsetWhileFixed` (boolean, default false). While a loan is in its fixed window (an explicit
`FIXED` loan, or a `FIXED_PERIOD` loan before `fixedRateUntilYear`) an offset linked to it
reduces nothing unless the flag is on. The cash is still there and still spendable; it simply
earns nothing against that loan.

The rule applies only when `rateType` is set explicitly. A legacy loan with no spread resolves
as fixed but keeps today's offset behaviour, so no existing scenario changes.

The pool `OFFSET_CAP` ceiling (`pool-metrics.js`) counts only loans the offset can currently
reduce. Otherwise a pool would report headroom that earns nothing.

## 6. Payment at the end of a fixed period (D3)

Today's P&I path pays the authored `monthlyPayment` for the life of the loan. For a
`FIXED_PERIOD` loan with a `maturityYear`, from `fixedRateUntilYear` on the payment is
re-amortised:

```
payment = amortise(postFixedPrincipal, liveRate, (maturityYear − fixedRateUntilYear) × 12)
```

`postFixedPrincipal` is the balance at expiry. Unlike `postIoPrincipal` it cannot be known when
the loan is loaded, because a P&I loan amortises during its fixed window. It is stamped by the
first payment made at or after expiry and then held. The payment is anchored for the same
reason design 86 G6 anchored the post-IO payment: re-amortising the live balance every month
lets an offset stretch the loan to its maturity instead of shortening it. It still follows
Prime, because `liveRate` is the revert rate.

An interest-only loan inside a fixed period is common in AU. IO and the fixed period are
independent: the IO window decides the payment *shape*, and the rate type decides the *rate*.
An IO loan whose IO period outlasts its fixed period pays interest at the revert rate once the
fixed period ends. Its IO-expiry re-amortisation (design 86 G6) is unchanged.

Without a `maturityYear` there is nothing to amortise against, so the authored payment
continues. The form hint says so.

## 7. Break cost and the extra-repayment cap

### 7.1 Break cost on early payoff

`breakCostOnPayoff` (boolean). The editor defaults it on for an AU loan and off for a US loan,
since a US fixed mortgage usually carries no prepayment penalty. That is a product
assumption, not a statement of law, and the author can change it per loan. Absent in state
means off, so legacy loans are unaffected.

A cost is charged when a property **sale** discharges a loan that is inside its fixed window.
It follows the shape of an AU lender's calculation: what the lender loses by re-lending the
balance at today's rate for the rest of the fixed term.

```
drop       = max(0, primeAtFix − primeNow)
n          = months from the sale to the end of the fixed window
breakCost  = balance × drop/12 × (1 − (1 + r/12)^−n) / (r/12),   r = fixed rate − drop
```

- **`primeAtFix`** is Prime when the rate was fixed. It is stamped with the loan country's
  Prime by the first loan payment, and it can be authored (`fixedAtPrimeRate`) for a loan
  fixed before the run starts. If rates have risen since the fix, `drop` is 0 and nothing is
  charged. Lenders do not pay a break benefit, so the cost is never negative.
- **The end of the fixed window** is `fixedRateUntilYear` for `FIXED_PERIOD` and `maturityYear`
  for `FIXED`. A `FIXED` loan with no maturity has no window end, so no break cost can be
  priced. The form says so.
- **Simplifications.** Prime moves stand in for the wholesale swap rate the lender actually
  uses, and the balance is held flat over the remaining window instead of amortised. Both
  make the figure somewhat larger than a lender's quote. Lender admin fees are not modelled.

`r` is the rate the balance would re-lend at today. The cost comes out of the sale
proceeds alongside the mortgage payoff. It is recorded on the sale's `*_HOUSE_SALE_APPLY`
action as `breakCost`, with a `loanPayoffs` row per loan (balance, `n`, `drop`, amount).
**Tax treatment is not modelled** (§9 Q2): the cost is neither deducted nor added to the cost
base.

### 7.2 Extra-repayment cap

`fixedExtraRepaymentCap` (annual amount, loan currency; blank means no cap). In this model an
extra repayment happens when the authored `monthlyPayment` exceeds the scheduled amortising
payment. That scheduled payment is `amortise(balance, fixedRate, months to maturity)`, so the
cap needs a `maturityYear`. Without one the authored payment *is* the schedule and the cap is
inert.

Inside the fixed window, the part of each month's payment above the schedule is limited so
that the extra paid in the calendar year does not exceed the cap. Anything above that stays in
the cash pool. The running total (`fixedExtraYtd`, keyed by year) lives on the loan's state
entry and is written by `LOAN_PAYMENT_APPLY`.

A sale discharge is not an extra repayment. It is priced by the break cost.

## 8. Split loans

An AU split is a single mortgage held as two loan accounts, one fixed and one variable, secured
on the same property. It is modelled that way: the property's own mortgage is one part, and a
standalone Loan account linked to the same property is the other. Each part has its own rate
type, payment, IO window and maturity.

That needs the property↔loan join to handle more than one loan. Today it assumes one, and two
places get it wrong as soon as there are two (a property with no mortgage of its own and two
standalone loans linked to it can already produce this):

- **The offset is counted once per loan.** `offsetBalanceForLoan` subtracts the whole offset
  from every loan linked to the property, so a A\$100k offset against two loans suppresses
  A\$200k of principal.
- **A sale pays off only the first loan** that `findLoanForProperty` finds. The other stays on
  the books after the house is gone.

Changes:

- `findLoansForProperty(state, propKey)`: every loan linked to the property, the property's
  own synthesized loan first and then the others by state key. `findLoanForProperty` keeps its
  single-loan meaning for callers that want it.
- **Offset allocation.** The offset is spread across the property's loans that it can
  currently reduce (§5), in that order, each taking at most its balance.
  `offsetBalanceForLoan` returns that loan's share. The total offset used can never exceed the
  cash.
- **Sale.** The sale pays off every linked loan: the payoff is the sum of their balances plus
  each one's break cost, every loan is zeroed, and each loan's balance is snapshotted.
- **Rental interest.** The deduction is summed over all linked loans, each with its own rate
  and `deductibleFraction`.
- **Editor.** The Linked Property select offers every property, including ones with their own
  mortgage, and the hint explains that linking to a mortgaged property makes a split.

## 9. Open items

- **Q1 — Re-fix at expiry.** Out of scope (D4). A real AU borrower usually re-fixes or chooses
  variable when a fixed period ends. It could be expressed as a dated rate schedule on the loan,
  or as an MPC decision (design 81).
- **Q2 — Tax treatment of a break cost.** Not modelled. Before modelling it, the relevant
  provisions (AU and US) have to be fetched into `docs/` and cited, not quoted from memory.
- **Q3 — Variable P&I payment reset.** Outside this design but found while writing it: a
  variable P&I loan keeps its authored payment when Prime moves, so a rate rise lengthens the
  loan instead of raising the payment. AU lenders usually recalculate the payment.
- **Q4 — Rate levers.** Whether the fixed rate, the revert rate or `fixedRateUntilYear`
  should be Monte Carlo or optimizer axes (design 98).

## 10. As built

- **One field list.** `LOAN_RATE_TERM_FIELDS` (`loan-classes.js`) names the seven authored
  terms and the `mortgage…` field each is mirrored as. The loan synthesizer, both retirement
  toolsets' state projection and the serializer all read it, so a term cannot reach one path
  and miss another. Every term is written only when set, and every golden fixture is
  byte-identical.
- **Runtime stamps** live on the loan's state entry and are written by
  `LOAN_PAYMENT_APPLY` from a `fixedStamps` field on the action: `fixedAtPrimeRate` (when not
  authored), `postFixedPrincipal` / `postFixedFromYear` (§6) and `fixedExtraYtd` /
  `fixedExtraYear` (§7.2). Only the part of an extra repayment the cash pool actually funded
  counts toward the cap.
- **The offset is allocated, not reduced per loan.** `offsetBalanceForLoan` returns this
  loan's share; the last loan it can reduce takes whatever remains. A property with one loan
  therefore gets the whole offset exactly as before.
- **Split loans in the sale.** The handler names every loan (`loanKeys`) only when there is
  more than one, and the break cost only when it is positive, so a single-loan sale's action
  is unchanged. A replayed legacy action falls back to the single-loan lookup.
- **Editors.** `LoanRateTermsForm` (`visualization/common/loan-rate-terms-form.js`) holds the
  controls for both forms. A loan saved before design 113 shows the type it resolves as;
  if that is fixed, its Offset While Fixed box starts ticked so saving it unchanged keeps
  its offset. The Linked Property picker now offers mortgaged properties.
- **Behaviour change on re-save.** A spread-less mortgage used to be converted to a Prime
  spread the next time its form was saved (design 56's opt-in on re-edit). It now stays
  fixed. That conversion was the bug that made a US fixed mortgage unauthorable.
- **Found and fixed in passing:** the AU retirement toolset did not project
  `postIoPrincipal` onto a standalone loan's state entry (the US toolset did). Both toolsets
  seed every account and the first to run wins, so an AU standalone interest-only loan in
  an AU-only plan, or wherever AU ran first, fell back to the legacy live-balance post-IO
  schedule. A mortgage synthesized from a property was unaffected. Regression test:
  TERM-10 in `evt-interest-only-loan.test.mjs`. The two copies have since been merged into one
  `accountToStatePlain` (`src/scenarios/toolsets/account-state-projection.js`), so they
  cannot drift again.
