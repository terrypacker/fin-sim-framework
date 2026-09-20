---
id: account
kind: node
title: Account
node: account
panels: [config-list, config-graph, holdings, pools]
design: [54-loan-liability-accounts.md, 56-prime-relative-rates.md, 86-leveraged-property-fidelity.md, 87-foreign-currency-basis-pools.md]
stamps:
  panel:config-list: 786f94
  panel:config-graph: bbebb1
  panel:holdings: 359688
  panel:pools: b2d1aa
  node:account: 93babf
---

Every pot of money in the plan, and every debt: cash, brokerage, the four retirement
wrappers, a loan, an offset. One form covers them all, and the **Type** decides which
half of it you see — a loan shows a rate, a term and a payment source; a wrapper shows
its basis; a cash account shows a floor and the transaction flag.

An account is not the same thing as a *holding*. The balance of a holdings-bearing
account is the sum of its positions, and it is those positions —
[Holdings](../panels/holdings.md) — that carry the units, the basis lots and the
market they track. What lives here is the wrapper around them: who owns it, which
country taxes it, when the drawdown chain may reach it.

Three fields decide more than they look like they do.
**Transaction account** flags the one cash account per country that household money
flows through. **Drawdown** decides whether this account can fund spending at all —
left blank it is excluded, which is a real choice and a common accident. And on a
foreign-currency pool, the **§988 basis** is what a disposition of that cash is
measured against: currency is property to a US person, and spending it realises
ordinary gain or loss. See [Liquidity Pools](../concepts/liquidity-pools.md) and
[Drawdown Order](../concepts/drawdown-order.md).

## Fields

- `name` — What this account is called throughout the app, and the label on every chart that breaks the portfolio down. Free text.
- `type` — What kind of account this is: checking, savings, brokerage, 401(k), Roth, traditional IRA, superannuation, loan or offset. It decides the tax treatment of every dollar going in and out, which of the fields below apply, and which age gates stand between you and the balance. Changing it on an existing account is not a relabelling — it re-points the money at a different rule set.
- `country` — Which country's rules tax this account and which cash pool it belongs to. It also sets the default currency. A US person's Australian account is still theirs for US tax purposes — this decides where it sits, not who is taxed on it.
- `currency` — The currency the balance is held in. Defaults from the country. A non-base-currency balance is revalued as the rate moves, and for a US person a foreign cash balance is also a §988 pool — see the basis field below.
- `ownershipType` — Sole or joint, which decides how this account's income and gains are attributed between the two people. It matters wherever they have different marginal rates or different residencies.
- `ownerId` — The person who owns it when ownership is sole. Their age gates the retirement wrappers and their rate taxes the earnings, so this is an engine input rather than a label.
- `cashRate` — The interest rate the bank quotes, as an absolute decimal (0.03 = 3%). It is stored as a spread over the central-bank Prime rate, so a Prime move fans out to every linked account at once instead of being re-authored here.
- `fxBasisRate` — Foreign units per USD at which this pool's currency was acquired. Spending foreign cash is a disposition of non-functional currency and realises ordinary gain or loss against this rate. For a balance built up over years it is the balance-weighted average of the rates it came in at, so a long-accumulated pool is not at today's rate. Blank stamps the rate at the first disposition, which understates the exposure rather than inventing one.
- `cashDeductibleFraction` — The share of this pool put to an income-producing use, 0 to 1. It drives two tests at once: whether §988 applies to the expense at all, and whether a currency loss is deductible as a transaction entered into for profit. Blank means fully personal, which is the safe default — a personal currency loss is disallowed while the matching gain is still taxed. An offset backing a rental should be set explicitly.
- `drawdownPriority` — Where this account sits in the liquidation order, 1 first. BLANK EXCLUDES IT from the drawdown chain entirely: the balance still earns and still counts in net worth, but no spending shortfall will ever reach it, and it is not counted as reserve. That is the right setting for money that is genuinely not available, and the wrong one for an account you expected to fund retirement.
- `earningsBasis` — The earnings half of a retirement account's balance, computed as the balance less the contribution basis. Read-only: it is derived, and the two halves matter because a withdrawal takes basis out tax-free and earnings out taxable.
- `offsetsPropertyKey` — The property whose mortgage this offset account reduces. An offset does not earn interest; it lowers the interest-bearing principal of the linked loan instead, dollar for dollar, which is why draining one costs more than the cash it releases.
- `loanRate` — The annual rate the lender quotes, as an absolute decimal (0.06 = 6%). Where Prime is configured it is stored as a spread over it, so a Prime move re-rates this loan with every other.
- `monthlyPayment` — The fixed monthly principal-and-interest payment. Inert while interest-only is on, and inert again after the interest-only period expires when a maturity year is set, because the loan then re-amortises over the remaining term. A fixed payment below the accrued interest does not error — the balance simply grows.
- `interestOnly` — Pay exactly the interest accrued on the effective, offset-reduced principal each month. The balance is then flat by construction and a variable rate is tracked automatically. This is the safe way to express interest-only: a fixed payment set below the accrued interest negatively amortises instead, silently.
- `interestOnlyUntilYear` — The calendar year the interest-only period ends. From then the loan reverts to principal-and-interest over the remaining term, which needs a maturity year to amortise against. Blank means interest-only forever — and that payment step-up is exactly the exposure a "hold the leverage" plan is running.
- `maturityYear` — The calendar year the loan must be discharged: the whole remaining balance plus interest is paid in that year, and a shortfall runs the ordinary replenish path. Blank means no term at all.
- `deductibleFraction` — The income-producing share of the borrowed money's use, 0 to 1 — the use test, not the security. Blank keeps the default rule: fully deductible while a linked property is renting, nil otherwise. It also sets the §988 business share, so it moves the exchange gain or loss treatment too. On a standalone loan a stated fraction deducts the interest in full against Australian assessable income, and on the US return only up to net investment income.
- `linkedPropertyKey` — The property this loan finances. Only properties carrying no mortgage balance of their own are offered, because one that does synthesizes its own loan and a second against it would double-count the debt. The link is also what joins an offset account to this loan.
- `paymentSourceKey` — The account the monthly payment is debited from. Blank resolves in order: a same-currency offset linked to this loan's property, then the country's flagged transaction account, then its savings pool. Paying from the offset is what a real offset facility direct-debits, and it is not cosmetic — draining it raises the interest-bearing principal.
- `bookingFxRate` — Foreign units per USD on the date the debt was incurred. A non-USD loan held by a US person realises ordinary gain or loss on each principal repayment, measured against this rate. Blank stamps it at the first payment, which treats the loan as incurred then and so understates the exposure on a loan already outstanding at the start of the run.
