# 54 — Loan (liability) accounts + offset re-targeting

**Status**: **Proposed** (design only).

Promote a mortgage from three scalar fields on `RealProperty` to a first-class **Loan**
account: a *liability* that accrues real interest each period and amortizes into interest
vs principal. This is the foundation that (a) makes design 53's offset account bite on
**owner-occupied** loans, not just the rental deductible-interest line, (b) enables a true
interest/principal split, and (c) lets non-property loans (car, student, personal) exist
at all.

**Builds on**:
- `design/53-account-basis-refactor-and-offset.md` §3 — the asset-side `OffsetAccount`
  and the `offsetBalanceForProperty` helper. This doc **re-targets** the offset link from a
  property to a Loan account.
- `RealProperty` scalar mortgage fields — `mortgageBalance`, `monthlyMortgage`,
  `mortgageInterestRate` (`real-property.js:68-85`).
- `mortgage-payment-classes.js` — today's payment flow (`mortgageBalance -= payment`,
  no interest split, `:117`).
- `rental-income-classes.js` — the one interest surface today,
  `deductibleInterest = mortgageBalance × rate / 12` (`:57`).
- `net-worth.js` / `after-tax.js` — the `value − mortgageBalance` property-equity lines
  (`net-worth.js:38`, `after-tax.js:266`).

---

## 1. Problem — the loan is a scalar, not an account

A mortgage today is three fields on `RealProperty`. That has four consequences:

1. **No interest accrual.** Amortization is `mortgageBalance -= payment`
   (`mortgage-payment-classes.js:117`) — the payment never splits into interest and
   principal, and the balance never *grows* with accrued interest.
2. **No owner-occupied interest line.** Interest is computed in exactly one place — the
   rental deductible-interest line (`rental-income-classes.js:57`). An owner-occupied loan
   has no interest-cost line, so design 53's offset (§3.2) has nothing to reduce and no
   cash-flow effect.
3. **No standalone loans.** A car / student / personal loan with no backing property
   cannot be represented — the mortgage fields only exist on `RealProperty`.
4. **Loan entangled with property.** One property = one implicit mortgage; you can't model
   two loans on a property, or a loan that outlives/precedes the property.

---

## 2. Concept — Loan is a liability; Offset is its linked asset

The real-world structure (and the AU offset structure specifically):

- A **Loan** is a *liability*: outstanding principal you owe, that accrues interest and is
  paid down.
- An **offset account** is a separate *asset*: your own liquid cash, which *suppresses* the
  loan's interest without paying it down. The two coexist — you hold both at once, and the
  offset account links to the **loan**, not to the property.

So this doc adds a `LoanAccount` (liability) and **re-targets** 53's `OffsetAccount` from
`offsetsPropertyKey` → `offsetsLoanKey`. The offset stays exactly what 53 designed — a
cash-like asset account — it just points at the loan.

### Sign convention (decided): positive balance + liability marker

A liability could be stored as a **negative** `balance` (so `net-worth.js`'s generic
`total += balance` "just works") or as a **positive** `balance` (outstanding principal)
plus a type marker, with the wealth metrics special-casing the subtraction.

**Decision: positive `balance` = outstanding principal, discriminated by
`type === 'loan'`.** A negative balance would poison everything else that assumes a
positive asset — formatting, the editor, `AccountService.transaction`, `minimumBalance`,
`InsufficientFundsError`, drawdown/replenish. Keeping `balance` positive means those paths
stay unchanged, and the only cost is one extra branch in the two wealth metrics (which
already special-case real-property equity — see §7). Drawdown exclusion is via the existing
`drawdownPriority = null` plus a type filter (§8).

---

## 3. `LoanAccount` shape

```
ACCOUNT_TYPE.LOAN   = 'loan'
ACCOUNT_ROLES.US_LOAN = 'us-loan'
ACCOUNT_ROLES.AU_LOAN = 'au-loan'    // per-country, mirroring savings: drives currency + cash pool

class LoanAccount extends Account {          // liability — NOT InvestmentAccount
  constructor(balance = 0, opts = {}) {      // balance = outstanding principal (positive)
    super(balance, { ...opts, type: ACCOUNT_TYPE.LOAN });
    this.interestRate      = opts.interestRate      ?? 0;    // annual rate (decimal)
    this.monthlyPayment    = opts.monthlyPayment    ?? 0;    // fixed P&I payment
    this.linkedPropertyKey = opts.linkedPropertyKey ?? null; // optional: property this loan finances
    this.paymentSourceKey  = opts.paymentSourceKey  ?? null; // cash pool the payment debits (default: country cash)
    this.drawdownPriority  = null;                           // never a source of drawdown cash
  }
}
```

Extends `Account` (not `InvestmentAccount`): no holdings, no contribution/earnings split.
Per-country role (`US_LOAN` / `AU_LOAN`) so the payment reducer resolves the right cash
pool and currency the same way savings do.

---

## 4. Interest accrual + amortization (the real loan)

Replace the scalar `mortgageBalance -= payment` with a monthly `LOAN_PAYMENT` flow that
splits interest from principal, with the offset reducing the interest-bearing base:

```
effPrincipal   = max(0, loan.balance − offsetBalanceForLoan(state, loanKey))   // §6
interest       = effPrincipal × interestRate / 12
payment        = min(monthlyPayment, loan.balance + interest)   // never overpay past payoff
principalPart  = payment − interest
loan.balance  -= principalPart                                  // debt shrinks by principal only
debit cash pool by `payment`                                    // full P&I leaves cash
```

- **Offset bites here**, universally — owner-occupied and rental alike — because interest
  is now computed on `effPrincipal`. That is the whole point of the loan-as-account move.
- **Negative amortization (decided: allow + flag)**: if `payment < interest`,
  `principalPart` is negative and `balance` grows. This is a real state (interest-only /
  underwater loan), so it is **not** clamped. Instead the reducer emits a journal
  `FieldValueAction` flag (e.g. `loan_negative_amortization`) whenever `principalPart < 0`,
  so the UI surfaces a ballooning balance rather than it reading as a silent bug.
- Record interest paid as a field value (feeds rental deductible-interest, §5, and any
  future interest-expense metric).

---

## 5. Migration — property scalars → Loan account

Per the design decision, a property's `mortgageBalance` / `monthlyMortgage` /
`mortgageInterestRate` **become a linked `LoanAccount`**; they stop being the source of
truth.

1. **Payment flow.** `UsMortgagePaymentHandler` / `AuMortgagePaymentHandler` operate on the
   linked `LoanAccount` (the §4 split) instead of decrementing `propState.mortgageBalance`.
2. **Rental deductible interest.** `computeRentalMonth` reads the linked loan's
   `effPrincipal × rate / 12` (`rental-income-classes.js:57`) instead of
   `propState.mortgageBalance × rate / 12`. Resolution: property → `linkedPropertyKey` loan
   → offset.
3. **Net worth / after-tax.** The property-equity branch stops subtracting the scalar
   mortgage; the Loan contributes its negative-signed liability instead (§7).
4. **Bootstrap.** Toolset / scenario seeding that sets `mortgageBalance` now seeds a
   `LoanAccount` linked to the property.
5. **Legacy saves — migration-on-load.** On deserialize, if a property carries legacy
   scalar mortgage fields and has **no** linked loan, synthesize a `LoanAccount` from them
   (a one-time upgrade). Old scenarios keep working and round-trip forward. A
   double-count guard (§7) keeps net worth correct during the window where a property
   *might* still carry a scalar and a loan.

---

## 6. Offset re-target

The one change to design 53's offset:

- `OffsetAccount.offsetsPropertyKey` → **`offsetsLoanKey`** (a `LoanAccount` stateKey).
- `offsetBalanceForProperty(state, propKey)` → **`offsetBalanceForLoan(state, loanKey)`** —
  sums balances of offset accounts whose `offsetsLoanKey === loanKey`, clamped at the loan
  balance (unchanged logic, new target).
- The rental line (§5.2) resolves property → linked loan → offset, so 53's rental behavior
  is preserved. The **new** capability is that owner-occupied loans now feel the offset,
  via §4's `effPrincipal`.
- **Generalized to US (decided).** 53 scoped the offset AU-only. Because the loan now
  carries a real interest line for every country, the offset is meaningful for US
  owner-occupied loans too, so the AU-only gate is dropped: `OffsetAccount` is wired into
  `US_BANKING` as well as `AU_BANKING` (53 §Phase 3.4), and `offsetBalanceForLoan` /
  `effPrincipal` are country-agnostic (they key on `offsetsLoanKey`, not currency). An
  offset account still carries its own currency and links only to a same-currency loan.

---

## 7. Wealth-metric changes (the ripple)

Both `computeNetWorth` (`net-worth.js`) and the after-tax metric (`after-tax.js`) currently
treat **any** entry with a numeric `balance` as `+balance` (`net-worth.js:35`). A loan must
subtract. Add a **liability branch before the generic balance branch**:

```
if (val.type === 'loan') {            // liability: owed principal reduces net worth
  contribution = -(val.balance ?? 0);
} else if (typeof val.balance === 'number') {
  contribution = val.balance;         // asset (incl. offset accounts — positive)
} else if (val.kind === 'real-property' …) {
  // stop subtracting mortgageBalance once a linked loan exists (double-count guard):
  contribution = val.value - (hasLinkedLoan(state, val) ? 0 : (val.mortgageBalance ?? 0));
}
```

The offset account is an ordinary positive asset — it counts `+`. The loan counts `−`. The
property-equity line subtracts its scalar mortgage **only** when no linked loan exists,
which keeps net worth correct through migration and for any property still on the legacy
scalar path.

---

## 8. Drawdown / replenish exclusion

A loan is never a spendable pool. `drawdownPriority = null` (constructor default) plus a
`type === 'loan'` filter in `AccountService`'s drawdown and `replenishSavings` iteration
keep loans out of the cash pools. Confirm both paths skip liabilities (a loan with a stray
`drawdownPriority` must still be excluded by type).

---

## 9. Phased plan

### Phase 1 — `LoanAccount` type + interest accrual (standalone)
*No property coupling yet; a loan can stand alone (car/student/personal).*

1. `ACCOUNT_TYPE.LOAN`, `ACCOUNT_ROLES.US_LOAN` / `AU_LOAN`, `LoanAccount` class + builder +
   serializer case + `TypeRegistry` registration + `StateSchemaRegistry` (`balance` as the
   country currency; `interestRate` as `rate()`).
2. `LOAN_PAYMENT` handler + reducer: the §4 interest/principal split, cash debit, negative-
   amortization flag. (Offset term reads as 0 until Phase 3.)
3. `net-worth.js` / `after-tax.js` liability branch (§7); drawdown/replenish exclusion (§8).
4. `evt-loan.test.mjs`: a standalone loan amortizes (interest + principal split correct over
   several months), counts as **negative** net worth, is excluded from drawdown/replenish,
   and round-trips through the serializer.

**Exit test**: `evt-loan` green; net worth of a scenario with a loan is asset-total minus the
loan balance; drawdown never draws from a loan.

### Phase 2 — Property migration
*Move property mortgages onto linked loans; keep existing figures intact.*

1. `linkedPropertyKey` linkage + editor (property picker on a loan; loan picker / auto-link
   on a property).
2. Migrate `UsMortgagePaymentHandler` / `AuMortgagePaymentHandler` to operate on the linked
   `LoanAccount` (§5.1); wire the rental deductible-interest line to the linked loan (§5.2).
3. Migration-on-load shim (§5.5) + double-count guard (§7).
4. Bootstrap: toolset seeding creates a linked `LoanAccount` instead of scalar mortgage
   fields.
5. Tests: `evt-real-property` rental + payment figures **unchanged** after migration (a
   synthesized/linked loan reproduces today's numbers); a legacy-scalar property fixture
   round-trips and upgrades on load without changing net worth.

**Exit test**: `evt-real-property` green with the loan as the mortgage source of truth; a
legacy save loads, upgrades, and reports identical net worth.

### Phase 3 — Offset re-target (design 53 → loan)
*Depends on 53's `OffsetAccount` existing.*

1. `offsetsPropertyKey` → `offsetsLoanKey`; `offsetBalanceForProperty` →
   `offsetBalanceForLoan` (§6). Rental resolution property → loan → offset.
2. `effPrincipal` in the §4 payment flow consults the offset, so an offset on an
   **owner-occupied** loan reduces interest paid and speeds principal payoff.
3. Drop the AU-only gate: register `OffsetAccount` in `US_BANKING` as well as `AU_BANKING`
   (§6), so a US owner-occupied loan can carry a same-currency offset.
4. Extend `evt-au-offset` (from 53): an offset on an owner-occupied loan lowers monthly
   interest and shortens the amortization vs the no-offset baseline; the rental-offset case
   from 53 still matches (property → linked loan → offset). Add a US mirror
   (`evt-us-offset`, or a US case in the same suite): a USD offset on a US owner-occupied
   loan reduces interest paid and speeds payoff.

**Exit test**: offset suites green for AU **and** US, each covering owner-occupied (new:
interest + payoff effect) and — where applicable — rental (53's effect, preserved); offset
balance stays liquid/drawdown-eligible.

---

## 10. Sequencing against design 53

Two tracks, one collision point.

**Track A — independent of loans** (53's basis / bond / editor work). Lands before, after, or
interleaved with everything below, in 53's own internal order; none of it touches loans,
offsets, net worth, or the rental line:
- 53 P1 (decouple brokerage basis) → 53 P2 (`RetirementAccount`)
- 53 P4 (bond coupon) → 53 P5 (holdings editor)

**Track B — the loan / offset chain**, with real dependencies:
- 54 P1 (standalone loan) — depends on nothing in 53.
- 54 P2 (property migration) — reworks the rental deductible-interest line
  (`rental-income-classes.js:57`) and the mortgage payment flow; depends on 54 P1.
- Offset integration — needs **both** 53 P3's `OffsetAccount` infra **and** 54 P2's linked
  loans; 54 P3 re-targets the offset link property → loan.

**The one collision.** The rental deductible-interest line and the offset link target are
touched by 53 P3 (offset → property → rental) *and* by 54 P2 / P3 (loan → rental,
offset → loan). 53 P3's **property-linkage + rental hook is superseded by 54**; the
`OffsetAccount` class / type / builder / serializer itself is **permanent and reused
unchanged**. Net worth has no collision — 53 never touches it; 54 P1 adds the liability
branch and 54 P2 the double-count guard.

### Recommended global order (co-landing 53 + 54)

1. **53 P1** — decouple brokerage basis
2. **53 P2** — `RetirementAccount`
3. **54 P1** — `LoanAccount` + accrual (net-worth liability branch, drawdown exclusion)
4. **54 P2** — property migration (mortgage payment → loan, rental line → `loan.effPrincipal`,
   net-worth double-count guard, migration-on-load)
5. **53 P3 (infra only)** — `OffsetAccount` type / class / builder / serializer / TypeRegistry
   + editor row. **Skip** the property-linkage + rental hook — wire straight to loans in the
   next step.
6. **54 P3** — offset ↔ loan wiring (`offsetsLoanKey`, `offsetBalanceForLoan`, `effPrincipal`
   in the payment flow, `US_BANKING` + `AU_BANKING` registration, evt tests)
7. **53 P4 → P5** — bond coupon + holdings editor (any time; fully independent)

This writes the rental line **once** (step 4) and the offset link **once** (step 6) — no
throwaway.

### If 53 must ship before 54

53 P3 lands **as written** (offset → property → rental deductible-interest), delivering the
rental-interest offset immediately. 54 then reworks it: 54 P2 moves the rental line to
`loan.effPrincipal`, and 54 P3 renames `offsetsPropertyKey → offsetsLoanKey` and
`offsetBalanceForProperty → offsetBalanceForLoan`. The rework is small (one field rename,
one helper rename, one rental-line rewrite, `evt-au-offset` update) and the `OffsetAccount`
infra is untouched — the interim value of a shippable 53 usually justifies it.

## 11. Risks / open questions

- **Sign convention** (§2). Chosen: positive `balance` + `type === 'loan'` marker, with the
  metrics subtracting. The alternative (negative balance) was rejected because it poisons
  every asset-assuming path. Worth a throwing-getter / grep pass to confirm nothing sums
  `balance` without the new liability branch.
- **Double-count during migration** (§7). The property-equity line must subtract the scalar
  mortgage *only* when no linked loan exists. A property that carries both a legacy scalar
  and a fresh loan (mid-migration) is the fixture to test.
- **Negative amortization** (§4) — *settled*: allowed + flagged rather than clamped, so
  interest-only / underwater loans are modelable; the `loan_negative_amortization` flag keeps
  it from reading as a silent bug.
- **Offset generality** (§6, Phase 3) — *settled*: the AU-only gate is dropped; the offset
  works for US owner-occupied loans too (`OffsetAccount` registered in `US_BANKING` +
  `AU_BANKING`, country-agnostic `effPrincipal`).
- **Role granularity** (§3). Per-country `US_LOAN` / `AU_LOAN` (currency + cash-pool
  resolution) vs a single `LOAN` role. Per-country chosen to mirror savings; revisit if a
  loan needs to be paid from an arbitrary account regardless of country.
- **Legacy save compatibility.** Migration-on-load synthesizes a loan from scalar fields;
  needs an explicit round-trip test with a pre-54 property fixture (mirrors 53 §7's
  legacy-brokerage concern).
