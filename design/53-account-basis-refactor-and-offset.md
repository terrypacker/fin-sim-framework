# 53 — Account basis refactor + AU offset account

**Status**: **Proposed** (design only).

Three related changes to the `Account` class family, driven by three questions:

1. Are `contributionBasis` / `earningsBasis` on `InvestmentAccount` still needed now
   that every account carries `holdings` (design 25)?
2. The contribution/earnings split is a *retirement-account* concept — should it live
   on a narrower subclass rather than on the base `InvestmentAccount`?
3. Add an AUD **offset account** that offsets a home loan's interest.

**Builds on**:
- `design/25-holding-level-state.md` — per-holding `costBasis`, the FIFO consumption
  path (`consumeHoldingsFifo`), and the `balance === Σ marketValue` invariant.
- `design/43-basis-accounting-integrity.md` — the `contributionBasis` / `earningsBasis`
  ledger and its reconcile-on-load repair (`reconcileLedgerToBalance`).
- `design/40` after-tax metric (`src/finance/derived-metrics/after-tax.js`), the only
  metric that reads `earningsBasis` (the `SUPER` tax class).

---

## 1. Problem — two different "basis" concepts wearing one name

The codebase tracks **two** things called "basis" that answer different tax questions:

| Field | Lives on | Tax question | Read by |
|---|---|---|---|
| `Holding.costBasis` | each holding | **Capital gain** on sale: `gain = salePrice − FIFO(costBasis)` | brokerage sale reducers; after-tax `TAXABLE_BASIS` |
| `contributionBasis` / `earningsBasis` | `InvestmentAccount` | **Ordinary-income deferral**: withdraw contribution first (tax-free / already-taxed), then earnings (taxed) | retirement reducers (IRA/401k/Roth/super); after-tax `SUPER` |

Holdings cannot replace the contribution/earnings split for retirement accounts —
those accounts pay ordinary income on the *growth* portion, not capital gains, so
`costBasis` is the wrong quantity. Conversely, for **brokerage** the split is now
**dead**: since holdings landed, `STOCK_WITHDRAWAL_APPLY` computes the real CGT from
`consumeHoldingsFifo(sa.holdings, salePrice)` (`us-brokerage-classes.js:202-208`), and
the after-tax `TAXABLE_BASIS` path reads holdings (`_unrealizedGain`, `after-tax.js:175`).
The brokerage reducers still *write* `contributionBasis` / `earningsBasis` in parallel
(`newContrib = newBalance − newEarnings`, `us-brokerage-classes.js:214-224`;
`au-brokerage-classes.js:200-210`) but nothing *reads* them for tax. They are
**write-only bookkeeping** — the redundancy behind the confusing `C.Basis` / `E.Basis`
fields the editor shows for *every* investment type (`index.html:662-671`, gated by
`INVESTMENT_TYPES` in `accounts-controller.js:18`).

### Current hierarchy

```
Account (balance, holdings)
└ InvestmentAccount (contributionBasis, earningsBasis, loanBalance, minimumAge,
   │                 allowsEarlyWithdrawal, costBaseStepUpByCountry, balanceAtResidencyChange)
   ├ BrokerageAccount          ← does NOT conceptually need contribution/earnings basis
   ├ FourOhOneKAccount ┐
   ├ RothAccount       ├ true owners of the contribution/earnings split
   ├ TraditionalIRAAccount │
   └ SuperannuationAccount ┘
```

---

## 2. Target hierarchy

Introduce a `RetirementAccount` between `InvestmentAccount` and the four tax-deferred
account classes. `contributionBasis`, `earningsBasis`, `minimumAge`, and
`allowsEarlyWithdrawal` move onto it. `BrokerageAccount` extends `InvestmentAccount`
directly and becomes holdings-only.

```
Account (balance, holdings)
└ InvestmentAccount (loanBalance, costBaseStepUpByCountry, balanceAtResidencyChange)
   ├ BrokerageAccount                       ← holdings only, no contribution/earnings basis
   └ RetirementAccount (contributionBasis, earningsBasis, minimumAge, allowsEarlyWithdrawal)
      ├ FourOhOneKAccount
      ├ RothAccount
      ├ TraditionalIRAAccount
      └ SuperannuationAccount
```

Fields that stay on `InvestmentAccount` because brokerage uses them:
- `loanBalance` — AU brokerage margin loan (AR-5).
- `costBaseStepUpByCountry` — residency cost-base step-up on the proportional path
  (design 36 §12.2).
- `balanceAtResidencyChange` — set by `AccountService.recordResidencyChange`.

`minimumAge` / `allowsEarlyWithdrawal` move down because only retirement accounts gate
withdrawals by age; brokerage never sets them.

### Why the class move is the *last* step, not the first

`us/au-brokerage-classes.js` currently *write* `contributionBasis` / `earningsBasis`. If
the field simply vanishes from brokerage's prototype chain those reducers throw on
`sa.contributionBasis`. So the field can only leave `InvestmentAccount` **after** the
brokerage reducers stop touching it. That reordering is the whole risk profile of Q1/Q2.

---

## 3. Q3 — AU offset account (interest-reduction only, linked, liquid)

### 3.1 What an offset account does

Cash held in an offset account reduces the *interest-bearing* principal of a linked
home loan without paying the loan down: `effectivePrincipal = max(0, mortgageBalance −
offsetBalance)`. The money stays liquid and spendable; while it sits there it "earns"
the mortgage rate by suppressing interest.

### 3.2 Fit with the current mortgage model

The mortgage model is thin, which keeps this small:
- Properties carry `mortgageBalance`, `monthlyMortgage`, `mortgageInterestRate`
  (`real-property.js:68-85`).
- **Amortization does not split interest vs principal** — the payment reducer just does
  `mortgageBalance −= payment` (`mortgage-payment-classes.js:117`).
- Interest surfaces in exactly one place today: rental deductible interest
  `deductibleInterest = mortgageBalance × rate / 12` (`rental-income-classes.js:57`).

Per the scope decision (interest-reduction only), the offset plugs in **only where
interest is already computed** — the rental deductible-interest line. There is no
owner-occupied interest-cost line in the model, so an offset against an owner-occupied
loan has no cash-flow effect today; it becomes meaningful the moment such a line is
added (a clean future extension, out of scope here). This is documented behavior, not a
gap to paper over.

### 3.3 Account shape

A new AUD, cash-like account type:

```
ACCOUNT_TYPE.OFFSET = 'offset'
ACCOUNT_ROLES.AU_OFFSET = 'au-offset'

class OffsetAccount extends Account {          // cash-like — NOT InvestmentAccount
  constructor(balance = 0, opts = {}) {
    super(balance, {
      country:  opts.country  ?? 'AU',
      currency: opts.currency ?? AUD,
      ...opts,
      type: ACCOUNT_TYPE.OFFSET,
    });
    this.offsetsPropertyKey = opts.offsetsPropertyKey ?? null; // stateKey of linked AU property
  }
}
```

It extends `Account` (not `InvestmentAccount`): it holds cash, has no holdings-driven
allocation, no contribution/earnings split. It behaves like an AUD savings account for
drawdown/replenish (liquid, participates in the AU cash pool per the linkage decision),
plus one extra field `offsetsPropertyKey` linking it to a property.

### 3.4 Where it reads through

`computeRentalTaxables` (`rental-income-classes.js`) gains an offset lookup: when a
property is targeted by an offset account, subtract that account's balance from
`mortgageBalance` before computing `deductibleInterest`:

```
const offset = offsetBalanceForProperty(state, propStateKey);   // Σ balances of offset accts linked here
const effPrincipal = Math.max(0, (propState.mortgageBalance ?? 0) - offset);
const deductibleInterest = effPrincipal * mortgageRate / 12;
```

Offset lookup walks `state` for `type === 'offset'` accounts whose
`offsetsPropertyKey === propStateKey` (mirrors how `_sumAfterTax` walks balance-bearing
state entries). Kept in one helper so both AU and (future) US rental paths share it.

---

## 4. Phased plan

Ordered so each phase is independently shippable and green.

### Phase 1 — Decouple brokerage from contribution/earnings basis
*Prerequisite for Q2. No hierarchy change yet.*

1. Rewrite `StockWithdrawalApplyReducer` (US + AU) to drop the parallel
   `contributionBasis` / `earningsBasis` writes — they already compute the authoritative
   result from holdings. Keep the `holdings` + `balance` writes.
2. Same for the contribution / dividend / earnings apply reducers: stop maintaining the
   two basis fields on brokerage state (`us-brokerage-classes.js:110,140-141,172,214-224`;
   `au-brokerage-classes.js:44-45,72-73,102-103,134-135,160,200-210`).
3. Verify nothing reads brokerage `earningsBasis` / `contributionBasis`: after-tax
   `TAXABLE_BASIS` uses holdings; CGT uses FIFO. Grep + a targeted brokerage evt test to
   confirm tax unchanged (`evt-us-brokerage`, `evt-au-brokerage`, `basis-invariants`,
   `reducer-postconditions-*-brokerage`).
4. Stop serializing the two fields for brokerage (`scenario-serializer.js:619-621`,
   toolset `_serialize*` helpers) — leave the retirement path untouched.

**Exit test**: brokerage evt suites + basis-invariants green with the fields absent from
brokerage state.

### Phase 2 — Introduce `RetirementAccount`, move the fields
*Q1 / Q2 structural change.*

1. New `RetirementAccount extends InvestmentAccount` carrying `contributionBasis`,
   `earningsBasis`, `minimumAge`, `allowsEarlyWithdrawal` + `reconcileLedgerToBalance`
   moves alongside it (or stays a free function — it already guards on field presence).
2. Reparent `FourOhOneKAccount` / `RothAccount` / `TraditionalIRAAccount` /
   `SuperannuationAccount` to `RetirementAccount`. Remove the four fields from
   `InvestmentAccount`; `BrokerageAccount` now inherits none of them.
3. Builder: split `BaseInvestmentBuilder` — a lean brokerage builder (holdings, loan,
   country/currency) and a `RetirementBuilder` (adds the basis + age setters).
4. Serializer round-trip: the `in account` guards (`scenario-serializer.js:619`,
   `910`) already degrade gracefully; confirm the retirement classes still hydrate the
   fields and brokerage no longer carries them. `scenario-roundtrip` +
   `serializer-finance-roundtrip` cover this.
5. UI: gate `C.Basis` / `E.Basis` (`index.html:662-671`) on retirement types only.
   Narrow `INVESTMENT_TYPES` in `accounts-controller.js:18` to
   `{'401k','roth','ira','super'}` for the basis-bearing check (holdings visibility stays
   its own broader gate). Relabel `C.Basis`/`E.Basis` → `Contribution Basis` /
   `Earnings Basis` while we're here.

**Exit test**: full unit suite green; brokerage state has no basis fields; retirement
evt suites unchanged.

### Phase 3 — AU offset account
*Q3. Independent of Phases 1–2; can land in parallel.*

1. `ACCOUNT_TYPE.OFFSET`, `ACCOUNT_ROLES.AU_OFFSET`, `OffsetAccount` class + builder +
   serializer case + TypeRegistry registration.
2. `offsetsPropertyKey` linkage; editor row (a property picker) shown for type `offset`.
   Register `<stateKey>.balance` as `currency('AUD')` in `StateSchemaRegistry`.
3. `offsetBalanceForProperty(state, propStateKey)` helper; wire into
   `computeRentalTaxables` for AU (and US, symmetric) rental deductible-interest.
4. Decide toolset home: extend `AU_BANKING` (it already owns AU cash accounts and
   interest schedules) — the offset needs no interest schedule of its own (its "return"
   is the suppressed mortgage interest), so it's just a cash account + the rental hook.
5. New `evt-au-offset.test.mjs`: property with a mortgage + rental, assert
   `deductibleInterest` drops by `offsetBalance × rate / 12` and taxable rental rises
   accordingly; assert offset balance stays liquid/drawdown-eligible.

**Exit test**: `evt-au-offset` green; existing `evt-real-property` rental figures
unchanged when no offset is present.

---

## 5. Risks / open questions

- **Phase 1 dead-read assumption.** The claim "nothing reads brokerage
  `contributionBasis`/`earningsBasis`" is from a grep + reading the sale/after-tax paths.
  A `--fix`-grade verification pass (or a temporary throwing getter) should confirm no
  serialized-scenario or MC/opt path reads them before deletion.
- **Saved-scenario compatibility.** Old saved brokerage states carry the two fields.
  Deserialization drops unknown opts harmlessly, and `reconcileLedgerToBalance` only
  fires when the fields are present — so old saves load without them and behave
  identically. Worth an explicit round-trip test with a legacy brokerage fixture.
- **Owner-occupied offset has no effect today** (§3.2). This is intended under the
  interest-reduction-only scope; flag it in the editor help text so it isn't read as a
  bug. Full interest-cost modeling is the future extension that makes it bite.
- **Multiple offsets / partial offset.** `offsetBalanceForProperty` sums all offset
  accounts linked to a property and clamps at `mortgageBalance`; a single offset is the
  common case.
