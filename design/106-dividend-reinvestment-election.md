# 106 — Dividend reinvestment as an account election (and, later, a per-security one)

**Status:** proposed. Phase 1 is small and moves no golden; phase 2 carries a re-gold and
a real modelling fix that is worth having on its own merits.

## 1. The ask, and the rule it comes from

A brokerage DRIP election is made **per security, at the broker**, when the position is
opened, and it then applies to **every lot of that security at that broker**. It is not a
household-wide setting and it is not a per-lot setting.

The model has a `Security` (the instrument) and an `Account` (where it is held), and the
same security can be held in two accounts. Two accounts are, for this purpose, two brokers:
the same security may reinvest in one and pay cash in the other. So the election is a
property of the **(account × security)** pair, with the account carrying the default.

Today it is one Boolean for the whole plan.

## 2. What the model actually does today

Measured, not assumed:

| fact | where |
|---|---|
| One global Boolean `dividendReinvest`, `mc:false / opt:true`, default `false` | `src/scenarios/toolsets/us-retirement-toolset.js:389-394` |
| It is handed to `DividendScheduledHandler` **once per us-stock account** at build time | `us-retirement-toolset.js:1212-1219` |
| …and to `BondCouponScheduledHandler` for the same accounts, from the same field | `us-retirement-toolset.js:1226-1231` |
| The handler branches on it: `STOCK_DIVIDEND_APPLY` (reinvest) vs `STOCK_DIVIDEND_CASH_APPLY` (cash) | `src/finance/handlers/dividend-scheduled-handler.js:86-96` |
| Cash goes to the country's transaction account, not to the paying account | `src/finance/reducers/stock-dividend-cash-apply-reducer.js:57-61` |
| The AU path has **no cash branch at all** — franked dividends are unconditionally reinvested | `src/finance/handlers/earnings-handlers.js:392-421` |
| Sheltered wrappers never fire a dividend event: design 99 P2 gives them market **total** return inside the earnings handler | `us-retirement-toolset.js:1131-1141`, `:98-105` |
| A wrapper's yield slice moves its lots as `VALUE_KIND.PRICE` — no units, no vintage lot, no basis (§2.2) | `holdings-earnings.js` `computeHoldingsGrowth` (`yieldPaidSeparately` is false there) |
| A wrapper's BOND sleeve *does* separate its coupon, and reinvests it unconditionally into a new-vintage lot | `BondSleeveCouponHandler`, `us-retirement-toolset.js:1273-1291` |
| A super fund's income is reinvested net of 15% by `computeFundIncome` — money cannot leave the fund | `src/finance/holdings/holdings-earnings.js` (design 105) |

**The load-bearing observation: the wiring is already per-account.** Both handlers are
constructed inside `for (const acct of usStockAccounts)`. Nothing needs to be re-shaped to
make the election per-account — the loop is handed the same value for every account. That
is what makes phase 1 small.

### 2.2 What the retirement wrappers actually do — four treatments, not two

Worth stating plainly, because "the wrapper reinvests its dividends" is the intuitive
answer and it is not what the code does.

| where | what happens to the yield |
|---|---|
| **Taxable US brokerage** | Separated as a dividend, taxed, then routed by the flag — reinvested into the account (pro rata, §2.1) or paid out as cash. |
| **Taxable AU brokerage** | Separated, taxed with the franking gross-up, and **always** reinvested — into the paying lot. No cash branch exists. |
| **Super** | Separated by `computeFundIncome`, taxed at 15%, and reinvested **net** as `VALUE_KIND.UNITS` with `costBasisDelta` equal to the reinvested amount — a real purchase carrying basis (design 105). |
| **401(k) / IRA / Roth — equity** | **Never separated at all.** The earnings handler applies the market's TOTAL return in one move as `VALUE_KIND.PRICE`. |

So for the US wrappers the answer to "do they always reinvest?" is: **economically yes,
mechanically no.** The money stays in the account and compounds, and the balance is
identical to a full DRIP — but no units are bought, no vintage lot is opened, and no
basis is added. The dividend is modelled as though it were price appreciation.

Two consequences worth recording rather than fixing here:

- The yield slice *is* computed — `computeHoldingsGrowth` returns it as `derivedAmount`,
  and the IRA/401(k)/Roth apply rules add it to `derivedIncomeBasis` (design 84 G2), the
  s99B-assessable pool. So the wrapper knows what its dividend was; it just does not
  route it. A future "cash sits in the wrapper's sweep account" model would start there,
  not from scratch.
- Within one wrapper the two halves disagree: the BOND sleeve separates its coupon and
  reinvests it into a new-vintage lot at the prevailing yield (design 66 §G10b), while
  the equity sleeve folds its dividend into price. That asymmetry is invisible in a
  wrapper today because nothing there is taxed per lot, and it is the reason D3 is
  stated as "there is no branch to elect" rather than "reinvestment is already what
  happens".

### 2.1 The defect phase 2 has to fix first

The two reinvestment paths do not agree about *what a reinvested dividend buys*.

- **AU (correct).** `IntlAuStockDividendHandler` takes the per-holding `holdingActions`
  from `computeHoldingsDividends` and emits them, so each lot's dividend lands back in the
  lot that paid it (`earnings-handlers.js:398-421`, `holdings-earnings.js:396-410`).
- **US (an approximation).** The handler discards `holdingActions` and sends one scalar
  `amount`. `StockDividendApplyReducer` then calls `distributeHoldingsCredit`, which splits
  the credit **pro rata by market value across income buckets**, and the bucket key is
  `allocation | taxExemption | issuingState | rateKey` — **`securityId` is not in it**
  (`src/finance/holdings/holding-utils.js:727-730`, `:797-829`;
  `src/finance/account-rules/us/us-brokerage-classes.js:148-168`).

So two US-equity securities in one account sit in the same bucket, and a dividend paid by
the high-yield one is partly reinvested into the low-yield one. With equal yields that is
invisible; with a per-security yield (design 94 §6.2, design 99) it is allocation drift the
model invented. It also means the US reinvest path **cannot express a partial
reinvestment**, which is exactly what a per-security election produces.

This is why per-security DRIP is phase 2 and not phase 1: the phase-1 checkbox is a routing
choice the existing branch already supports; the phase-2 checkbox needs the US path to buy
the paying security first.

## 3. Where the election lives — the account record, not a param

**Decision D1: the election is a field on the account record, and the global toolset param
becomes its default.** This is design 55 §8's pattern verbatim ("the global param becomes
the template default / fallback, not the value"), and the same pattern
`isTransactionAccount` already uses end to end: an account field
(`scenario-serializer.js:808`), a generated per-account param from a declarative template
(`src/scenarios/params/record-param-templates.js:96-104`), and a param-linked checkbox in
the account editor (`src/visualization/accounts/account-editor.js:280-281`).

**Decision D2: the field is nullable, and `null` means "inherit the global default".**
Deviation-only serialization, the rule `allowsEarlyWithdrawal` states at
`scenario-serializer.js:753-760`: a saved scenario that never touched the flag writes
nothing, so every existing scenario and every golden reloads byte-for-byte. It also keeps
one place to flip the whole plan, which is what the current param is good at.

**Decision D3: super and the sheltered wrappers do not get the election.** Not an
omission — there is no cash branch to elect. A super fund cannot pay its income out
(design 105), and IRA/Roth/401(k) equity earns total return in one move with no dividend
event to route at all (§2.2). Exposing a checkbox that does nothing is worse than not
exposing one. If a wrapper's dividends are ever separated from its price return, this
decision is the thing to revisit, not the field. Enforced by `DIVIDEND_ELECTION_ROLES`
(`src/finance/state/account-roles.js`), which the param template, the toolset and the
editor all read, so "where the election is live" has one definition rather than three.

## 4. Phase 1 — one election per account  ✅ **DONE** (2026-09-16)

`reinvestDividends: boolean | null` on brokerage accounts (`us-stock`, `au-stock`).

Touch list, in dependency order:

1. **Account class** — accept and carry `reinvestDividends` (default `null`) on the
   brokerage type. `src/finance/assets/` + `src/finance/builders/account-builder.js`
   (`.reinvestDividends(v)`, written only when not null — the shape at
   `account-builder.js:187-202`).
2. **Serializer** — emit only when non-null (`_serializeAccount`), read back in the
   deserializer's opts (`scenario-serializer.js:~808` / `:~1339`).
3. **Param template** — a `REINVEST_DIVIDENDS` entry on `ACCOUNT_TYPE.BROKERAGE`:
   `{ type: 'Boolean', mc: false, opt: true, nullable: true }`. A household choice, so
   `opt: true` per design 98 W2's rules; not uncertain, so `mc: false`. The generated key is
   `acct.<stateKey>.reinvestDividends`, and generated `acct.` keys are live on the
   optimizer/MPC candidate path since design 98 W0 fixed the flat-key write — a per-account
   Opt axis is real today, which it would not have been a year ago.
4. **Toolset** — two lines:
   `reinvest: acct.reinvestDividends ?? p.dividendReinvest` at
   `us-retirement-toolset.js:1218` and `:1229`.
5. **Editor** — a checkbox in the account editor's brokerage section, param-linked by
   adding it to the `_bindParamLinks` candidate list (`account-editor.js:277-282`) with
   `coerce: raw => !!raw`, and read on save the way `isTransactionAccount` is at `:1111`.
   It is tri-state in meaning but a plain checkbox in the UI; "inherit" is the state of an
   account that has never been touched, and the label carries the global default.
6. **Global param stays**, with its description updated to say it is the default for
   accounts that do not override. Deleting it would break every saved scenario's Opt config
   for no gain.

**Coupling that is preserved deliberately:** one flag still drives **both** dividends and
bond coupons, because that is what the code does today (`:1218` and `:1229` read the same
field) and because a broker's election covers what is held there. If they ever need to
split, the seam is a second field `reinvestCoupons` defaulting to `reinvestDividends`, and
nothing in phase 1 forecloses it.

**Gate.** No golden may move: every fixture leaves the field null and takes
`p.dividendReinvest`. New tests: (a) two brokerage accounts, one electing reinvest and one
not, produce one `STOCK_DIVIDEND_APPLY` and one `STOCK_DIVIDEND_CASH_APPLY` in the same
year; (b) round-trip — an account with the flag set survives save/load, one without it
writes no key; (c) the generated param appears, cascades onto the record on Rebuild, and
its Opt axis produces a non-identical rollout (the design 98 W0 detector's shape).

### 4.1 Phase 1 implementation record  ✅ (2026-09-16)

Built as specified, with three corrections the build forced.

**1. The election is read from STATE, not captured at build time.** §4's touch list said
"two lines in the toolset". That would have been the design-58 trap: a scenario loaded
from a save restores its handlers from JSON and does **not** re-run the toolset, so an
election read in the constructor is stale on every loaded plan until the next Rebuild —
a lever that works in tests and does nothing in the app. Instead `_accountToStatePlain`
projects `reinvestDividends` (when non-null), and both handlers resolve it at call time:

```
data?.reinvest ?? account?.reinvestDividends ?? this.reinvest
```

one-off event, then the account's election, then the household default the handler was
built with. `us-retirement-toolset.js:149`, `dividend-scheduled-handler.js:95`,
`bond-coupon-handler.js:103`.

**2. There are two copies of `_accountToStatePlain`, and whichever toolset seeds an
account's state entry first wins** (`patches[stateKey] === undefined`). The field went
into the US copy first and the election did nothing, because on the cross-border plan the
AU toolset seeds `usStockAccount`. Both copies now carry it. Worth knowing generally: a
field added to one copy is present or absent depending on toolset order, and the symptom
is "the feature does nothing", not a crash.

**3. The control is tri-state, not a checkbox.** A checkbox cannot say "follow the
plan-wide default" — unchecked would mean "pay cash", which writes `false` and silently
unsubscribes the account from the household lever. The editor row is a three-option
select (Default / Reinvest / Pay cash); `''` maps to null. The generated *param* stays a
plain Boolean, because a param exists to be set and swept; "inherit" is expressible in
the editor, which is where it belongs.

**4. The role gate has to predict itself on the create form.** A new account has no role
— the controller derives it from type + country on save — so a gate reading `node.role`
hides the election until the account has been created and reopened. The editor predicts
the role the same way the controller derives it, and re-gates on a country change,
because flipping a new brokerage to AU takes the election away again until phase 1b.

**What moved:** nothing. 6,572 unit tests, 1,515 viz tests, all eleven goldens
byte-identical — the field is absent from an unelected account at every layer (the state
projection, the serializer and the param generator all gate on non-null), so there was
nothing for a fixture to record.

**The files:**

| file | what |
|---|---|
| `src/finance/state/account-roles.js` | `DIVIDEND_ELECTION_ROLES` — the one definition of where the election is live |
| `src/finance/assets/investment-account.js` | `BrokerageAccount.reinvestDividends`, tri-state |
| `src/finance/builders/account-builder.js` | `.reinvestDividends(v)`, passed only when non-null |
| `src/scenarios/scenario-serializer.js` | emit/read, deviation-only, `!= null` (not truthiness — `false` is an election) |
| `src/scenarios/params/record-param-templates.js` | `REINVEST_DIVIDENDS` on BROKERAGE, gated by `appliesTo` |
| `src/scenarios/params/scenario-param-generator.js` | `appliesTo(record)` — a per-record gate the type key cannot express |
| `src/scenarios/toolsets/{us,au}-retirement-toolset.js` | the state projection; the param's label/description as the DEFAULT |
| `src/finance/handlers/dividend-scheduled-handler.js`, `bond-coupon-handler.js` | the three-level resolution |
| `index.html`, `account-editor.js`, `accounts-controller.js` | the tri-state row, role-gated, param-linked |
| `tests/unit/evt-dividend-reinvest-election.test.mjs` (DRIP-1…5b) | precedence, coupons, two e2e runs through the loader, round trip, param generation |
| `tests/viz/editors/reinvest-dividends-election.test.mjs` | the role gate and the tri-state round trip |

**One trap found on the way, unrelated but worth the line:** the household default is
spelled `stockDividendReinvest` at the scenario level and forwarded to the toolset's
`dividendReinvest` (`intl-retirement-scenario.js:1300`). A headless caller passing the
toolset spelling is silently ignored. Two param stores, one of them fed only by a human —
the same shape design 65's levers hit.

### 4a. The AU half  ✅ **DONE** (2026-09-16)

`IntlAuStockDividendHandler` had no cash branch: before phase 1b, **every** franked
dividend was reinvested. Electing "no reinvest" on an AU brokerage needed the branch
built — credit the AU transaction account, keep the franking credit assessable with the
gross-up exactly as the reinvest branch does (the credit attaches to the dividend, not to
where the cash lands), and add the EVT-26/EVT-27 variants to `design/requirements.md`.

**What was built.** `AU_DIVIDEND_FRANKED_{RESIDENT,NONRESIDENT}_CASH_APPLY`, two reducers
over one shared base in `au-brokerage-classes.js`, registered in `AU_BROKERAGE`
unconditionally (the election is per account and can be flipped after the scenario is
built; a reducer that exists only once someone has elected cash would make the first flip
a silent no-op). The handler now branches on two axes — residency × election — and drops
its `holdingActions` on the cash branch, because the money leaves rather than buying units.

**The household default is TRUE on the AU side, and false on the US side.** Not an
inconsistency: `auDividendReinvest` defaults to what the AU path has always done, and
defaulting it to `false` to match the US would silently re-route every existing AU
scenario's dividend stream. The US param defaults false because it always has.

**Decision D5: the tax is identical on both branches, and that is the whole claim.** A
dividend is derived when it is paid; where it is banked afterwards is not a tax fact. Both
cash reducers chain the same tax action with the same amount, and the resident branch keeps
its s207-20 gross-up and offset. Pinned by DRIP-6c, which runs the two arms for one year
and asserts the assessed amount is equal to the cent. (Over a longer run the reinvested arm
compounds a bigger book and so pays a bigger dividend the next year — the economics working,
not the tax differing, which is why the assertion is on year one.)

**The cash branch must stamp `stateKey`**, because it credits a *different* account than the
one that paid and so cannot fall back to `action.stateKey ?? 'auStockAccount'` the way the
reinvest reducers do. That key is what `resolveAttributionAsset` uses to attribute the
income — and the franking credit — to an owner (design 76 Gap C). Requiring it here is what
exposed that the reinvest branch never stamped it either: **F6**, §4b.

### 4b. F6 — the dividend must name the account that paid it  ✅ **DONE** (2026-09-16)

Stamping `stateKey` on the cash branch made it obvious that the **reinvest** branch did not
stamp it at all, and the same question turned out to apply on the US side. Done as its own
pass after phase 1b, because it re-golds twelve fixtures.

**The four sites.**

| # | site | before | after |
|---|---|---|---|
| F6a | `IntlAuStockDividendHandler` reinvest branch | no `stateKey` — both reducers fell back to `'auStockAccount'` | stamps the paying account, as the cash branch already did |
| F6b | `StockDividendCashApplyReducer` | chained `STOCK_DIVIDEND_TAX` with the **savings** key it had just credited | `action.stateKey ?? key` — the payer, with the destination as the replay fallback |
| F6c | `BondCouponCashApplyReducer` | the same, for `BOND_COUPON_TAX` | the same fix |
| F6d | the four bare `AuDividend*Handler` dispatchers | hard-coded `auStockAccount` | honour `data.stateKey`, defaulting to the canonical key |

The handler in F6a is built **per account** — it has always known which account it was
computing for. It simply never said, and both reducers' `action.stateKey ?? 'auStockAccount'`
fallback silently supplied the wrong answer.

#### What the re-gold actually showed — two different stories

**Eleven goldens moved a little, and legibly.** `auPersonOrdinaryIncomeYTD` shifts from
`spouse` to `primary` (on `cross-border-reference`: spouse 4,200 → 34, primary 44,914 →
49,048) with small knock-on tax and cash. That is F6b/F6c: a US brokerage dividend taken as
cash was being attributed through the *transaction account*, which design 55 §7.4 made a
household hub with no particular relation to the brokerage, so a solely-owned account's
dividend was being split across the household. The totals are conserved; only the owner
changed. This is exactly what design 76 Gap B/C exist to do.

**`au-single-homeowner` moved by 33 fields and roughly A$870k of net worth, and that is not
attribution — the model was creating money.** The §4a measurement recorded this as a
six-figure attribution move; running it down showed something worse.

Before F6a, the AU dividend path emitted two things per event: `holdingActions` that grew
**the paying account's lots**, and an `_APPLY` whose scalar balance credit landed on
**`auStockAccount`** whatever the payer. This golden holds an inherited AU brokerage beside
the primary one, and it pays **A$443,521** of dividends over thirty years. Every one of them
grew the inherited account's lots *and* credited `auStockAccount.balance`.

The committed fixture records the result plainly, and nothing was asserting on it:

```
auStockAccount.balance = 67,428.18     Σ holdings = 0
```

A brokerage drawn down to no lots at all, carrying sixty-seven thousand dollars of balance —
a §4.4 invariant violation that is **spendable**. It fed `netWorth`, `netLiquidity` and the
drawdown cascade, which is why removing it moves so much: the household had been living
partly on money the model invented, sparing real accounts that are now drawn instead.

After F6a that account holds 31,798 with no lots, so **F6 removes about half the phantom and
not all of it**. The remainder has a different root cause and is recorded below as F7.

#### F7 — the phantom's actual root cause  ✅ **DONE** (2026-09-16)

**The first diagnosis was wrong, and the §4.4 gate is what corrected it.** F7 was written
up as the `!holdings.length` fallback in `computeHoldingsGrowth` /
`computeHoldingsDividends` manufacturing a return on a balance no asset backs. That
fallback is real and it is a latent hazard, but it was not producing the money. It was
*sustaining* a phantom that two missing stamps had already created.

**F7a — the AU earnings path had the same hole as the dividend path, and a wider one.**
`IntlAuStockEarningsHandler` emitted `AU_STOCK_EARNINGS_APPLY` with no `stateKey`, and
`AuStockEarningsApplyReducer` did not merely fall back to the canonical key — it read
`state.auStockAccount` **outright**, ignoring any stamp it was given. So on
`au-single-homeowner` the inherited brokerage's price appreciation — **A\$424,013 across
the run** — was added to `auStockAccount`'s scalar balance year after year while the
inherited account's own lots grew correctly from `holdingActions`. Money in a balance with
no asset behind it, compounding, spendable, and drawn down by the household as real cash.

The US sibling has stamped its key since design 76 and its reducer honours it; the AU one
was the outlier on both halves. Fixed to match, and the trace that found it is the same
month-by-month walk §4b used: a lone `AU_STOCK_EARNINGS_APPLY(5,073.24)` with no account on
it, landing on a balance that then ran A\$5,073.24 clear of its lots.

**F7b — an overdraw in `AccountService.transaction` broke §4.4 permanently.** `balance`
takes the whole debit; the sleeves are capped at what they hold (`toRemove = Math.min(-amount,
totalMv)`), and the shortfall was dropped. Because the CREDIT branch then lands a later
deposit on the sleeves in full, both sides recover by the same figure and **the gap
survives forever**. On `us-single-homeowner` one −\$3,000 debit against an empty transaction
account in 2036 left the balance \$3,000 below its own CASH sleeve for the remaining thirty
years — money the household held and the balance could not see.

The fix carries the shortfall onto a **CASH** sleeve, which may go negative: an overdrawn
account is an overdraft, and what it owes is cash it does not have. It heals by
construction — the sleeve goes to −X, the next deposit adds to both sides, and the two reach
zero together. An account with **no** CASH sleeve keeps the existing floors and its desync
stays visible to the gate, because owning −\$3,000 of a stock is a worse lie than a balance
that disagrees with its sleeves. That also preserves the two `account-service.test.mjs`
cases that pin the floor, which had been asserting the floor and not the invariant.

**What it cost.** `au-single-homeowner` fell another **A\$871k** of net worth (5.13M → 4.26M),
so across F6 and F7a that run shed roughly **A\$1.74M of invented wealth** over forty years.
The corrected run is coherent rather than merely smaller: no out-of-funds date, no
accumulated deficit, and every account reconciling to its lots. Eight fixtures moved; six of
them by cents on a cash sleeve.

**The fallback stays, and is now guarded rather than load-bearing.** With no phantom seed
there is nothing for it to compound, and the gate below is what will notice if a future
change reintroduces one. Whether it should be deleted outright for holdings-bearing types is
a design-25 question, not this document's.

**The waiver list is empty.** Both entries the §4.4 gate was born with were defects, and
both were fixed rather than tolerated — which is what a waiver list is meant to drive
toward. Guarded by `F7a` in `evt-dividend-reinvest-election.test.mjs` and `F7b`
(overdraw, heal, partial, and the no-cash-sleeve case) in `account-service.test.mjs`.

#### The §4.4 gate  ✅ **DONE** (2026-09-16)

F7 was possible because the goldens pin **values** and nothing pinned the **relationships
between** them. `findOutOfSync` (golden-harness.js) now checks
`balance === Σ holdings.marketValue` on every account of every golden's end state, asserted
per golden in `golden-scenarios.test.mjs` and — like the NaN check — **also under `REGOLD`**,
because a fixture records values, so a balance adrift from its assets re-golds forever as
just another number.

Three decisions, each measured rather than chosen:

- **Tolerance is per LOT, not flat.** Each `marketValue` is rounded to the cent as it is
  written, so a sum over N lots can sit half a cent per lot from a balance rounded once:
  `0.01 + 0.005 × lots`. Measured across the goldens, the largest legitimate drift is 2c on
  a 13-lot super account, which this admits at 7.5c. `holdings-invariant.test.mjs` uses a
  flat ±\$1.00 — reasonable for the few-year run it does, and over a forty-year golden a
  place for real money to hide.
- **An EMPTY holdings array is checked, not skipped.** `holdingsOutOfSync` in
  `holding-utils.js` returns false for one, correctly for the load path it serves (there is
  nothing to rescale). Reusing it here would have skipped exactly the shape F7 takes.
- **Liabilities are skipped.** A loan's balance is debt owed and it holds nothing
  (design 54 §8); `au-super-streams` carries A\$249,669 of mortgage that is not a violation.

What it found on its first run were **two defects, both since fixed** (F7a and F7b above):
the A\$31,798 phantom on `au-single-homeowner`, and a second one it would have taken much
longer to notice — `us-single-homeowner`'s drained cash account, `balance 0` against a
\$3,000 CASH sleeve. That one points the *other* way, understating rather than inventing,
which is presumably why nothing had. Neither was visible in any fixture diff, because a
fixture diff compares a number to the same number a year later; only a check on the
RELATIONSHIP could see it.

Waived, not skipped: a companion test asserts every waiver is **still** out of sync, so a fix
that lands without deleting its line fails as loudly as a regression, and another asserts each
waiver says what it is worth and what owns it. The checker has its own tests
(`golden-sync-invariant.test.mjs`, SYNC-1…8), including the two scoping decisions above,
because a gate that silently stops catching things is worse than no gate.

#### Guarded by

`F6-1` (a second AU brokerage keeps and is taxed on its own dividend) and `F6-2` (a US cash
dividend is taxed against the brokerage, never the savings account) in
`evt-dividend-reinvest-election.test.mjs`. `stateKey` is now declared on all six AU dividend
APPLY types, so the journal — and every design 71 report — shows which broker paid.

### 4c. Phase 1b implementation record  ✅ (2026-09-16)

| file | what |
|---|---|
| `au-brokerage-classes.js` | the shared cash base + the two reducers |
| `au-brokerage-toolset.js` | registration, and `stateKey` declared on all six AU dividend APPLY types for journal visibility |
| `earnings-handlers.js` | the two-axis branch; `reinvest` resolved from state; `reinvest` serialized, defaulting TRUE on `fromJSON` so a save written before the field reloads reinvesting |
| `au-retirement-toolset.js` | the `auDividendReinvest` household default |
| `scenario-serializer.js` | the two new reducer classes in both registry blocks — without this a saved graph throws `Unknown reducer type` on load |
| `account-roles.js` | `au-stock` joins `DIVIDEND_ELECTION_ROLES` |
| `golden-specs.js` + `golden-au-dividend-cash.json` | a new golden: the default US→AU plan with the AU default flipped to cash, crossing the 2031 move so it reaches the non-resident branch before it and the resident branch after |
| `reducer-postconditions-au.test.mjs` | conservation, untouched holdings, and the attribution stamp |
| `evt-dividend-reinvest-election.test.mjs` (DRIP-6…6d) | the election end to end, and the tax invariance |

**What moved:** no existing golden. One new fixture. 6,581 unit tests and 1,516 viz tests
green.

## 5. Phase 2 — per security, within the account  ✅ **DONE** (2026-09-16)

**Shape.** `reinvestDividends` stays the account default; add
`dividendReinvestBySecurity: { [securityId]: boolean }`, absent entries inheriting the
default, the whole map omitted when empty.

**Decision D4: one map plus a default, not an allow-list and a deny-list.** The two lists
the ask describes are the same object read two ways: with a default of `false` the map's
`true` entries *are* the allow-list; with a default of `true` its `false` entries *are* the
deny-list. Storing lists instead needs a rule for "in both" and "in neither", and that rule
is the default we would have had to store anyway.

**Prerequisite — §2.1.** The US reinvest path must buy the paying security. Two ways were
weighed, and **the one this document originally chose was wrong**:

- **(a) Emit the per-holding actions, as AU does.** Rejected at build time. The AU path
  adds the money to the lot that paid, via `addValue` — and `addValue`'s own comment says
  what is wrong with that: *"this is still an addition to an EXISTING lot, which §5.0a says
  a purchase should not be… the paths where it was a purchase — the dividend spread and
  ladder absorption — now open a lot instead."* Taking (a) would have regressed design 93
  §5.0a, the rule that a reinvestment is a PURCHASE with its own holding period, which
  FIFO, HIFO, the Division 115 12-month gate, the post-2027 indexation clock and the
  residency step-up all read. It would also have dropped the basis: those actions carry
  `costBasisDelta: 0` (design 94 F3). "Matches AU" was the wrong test — the AU path is the
  one that needs fixing, and §4b's F7 work is what made that visible.
- **(b) Add `securityId` to `_incomeBucketKey`, and have the handler pass the per-security
  amounts.** Taken. `distributeHoldingsCredit` already copies `template.securityId` onto the
  vintage lot it opens; the only reason the lot named the wrong instrument is that the
  bucket key could not tell two securities apart, so the template came from whichever had
  the biggest lot. With the key fixed, each security gets its own vintage lot — basis,
  holding period, compaction and §4.4 all unchanged.

The bucket key alone is not enough: the payment was still **split pro rata by market
value**, so a high-yield holding's dividend partly bought a low-yield one. The handler
therefore hands the reducer the actual per-security breakdown (`_bySecurity`, mirroring the
coupon path's `_reinvestBuckets`), and `distributeHoldingsCredit` gained an `only` filter so
each slice is weighted and landed within its own security's lots.

**The handler, after.** One `call()` partitions the payment by the resolved election and
emits up to two apply actions: `STOCK_DIVIDEND_APPLY` for the reinvested slices (carrying
`_bySecurity`) and `STOCK_DIVIDEND_CASH_APPLY` for the rest. Both chain
`STOCK_DIVIDEND_TAX`, so the taxable total is unchanged by the split — the invariant pinned
by DRIP-SEC-7 is `Σ STOCK_DIVIDEND_TAX == computeHoldingsDividends().amount`, whether the
payment is wholly reinvested, wholly cash, or split. Note for the journal: two reducers now
fire for one economic event, so any rollup must filter on `entry.reducer` before summing
(the `AU_TAX_SETTLE_APPLY` double-count trap).

**AU takes the same election with no new plumbing.** Its `holdingActions` are already per
LOT, so filtering them to the elected securities *is* the split; only the two amounts have
to be re-totalled. Its lot mechanics are untouched here — the `addValue` blend above is a
defect in its own right, not phase 2's to fix.

**UI.** A row list under the account's own election: one row per **distinct security the
account holds**, each a tri-state select — a typed control, never a JSON blob. Two levels of
inheritance (security → account → plan-wide) is one more than a reader should have to hold
in their head, so each row's default option names what the account currently resolves to
("Account default (pay cash)") and re-labels when the account's answer changes. Lots with no
`securityId` get no row: an un-securitised sleeve is not an instrument anyone can elect for.
The list follows the holdings, and a security that leaves the account has its entry pruned
on save, the reconciliation design 55 §14 does for orphaned generated params.

### 5.1 Phase 2 implementation record  ✅ (2026-09-16)

**2a — the reinvestment buys the paying instrument.** `securityId` joined
`_incomeBucketKey`; `computeHoldingsDividends` now returns a `bySecurity` breakdown beside
its amount; the handler stamps it as `_bySecurity` on the reinvest branch; and
`StockDividendApplyReducer` spends it one slice at a time through
`distributeHoldingsCredit`'s new `only` filter. An action without slices — a replayed one,
or an account with no lots — still takes the whole-account path.

Concretely, on 15k at 5% beside 10k at 1% in one account: the 850 payment used to be split
510/340 by market value, so the 1% security was credited with 240 of a dividend it had
contributed 100 to. It is now 750/100.

**No existing golden moved economically** — only lot IDs, which now carry the security. That
is itself the finding: *no golden reinvested a multi-security account*, because every one of
them took the `dividendReinvest: false` default. The fix shipped with nothing watching it,
so step 2 added `dividend-drip-per-security`, which also closed two KNOWN_GAPS that had been
open as long as the manifest has existed — `STOCK_DIVIDEND_APPLY` and `BOND_COUPON_APPLY`,
the US reinvest branches, reachable until now by unit test alone.

**2b — the election.** `account.reinvestDividendsBySecurity`, `{ [securityId]: boolean }`,
null when empty and deviation-only at every layer (record, serializer, state projection) so
an account with no per-security opinion is byte-identical. Resolution is
`data.reinvest ?? bySecurity[securityId] ?? account.reinvestDividends ?? household default` —
a one-off event's instruction still outranks a standing election, because it is about that
payment rather than about the account.

**What the new golden holds**, which is the clearest statement of the feature: the account
elects reinvest, the 4% income fund elects OUT, and every year one dividend event splits two
ways — `sec-gro` accumulates a vintage lot per year naming itself, `sec-inc` has none, and
the savings account carries its cash. The assessed tax is identical to either undivided
arm (DRIP-SEC-7).

**The files:**

| file | what |
|---|---|
| `holding-utils.js` | `securityId` in `_incomeBucketKey`; `only` on `distributeHoldingsCredit` |
| `holdings-earnings.js` | `bySecurity` breakdown beside `amount` / `holdingActions` |
| `dividend-scheduled-handler.js` | the two-way split and `_bySecurity` |
| `us-brokerage-classes.js` | the reducer spends the slices per security |
| `earnings-handlers.js` | the same election on the AU side, by filtering its per-lot actions |
| `investment-account.js`, `account-builder.js`, `scenario-serializer.js`, both toolsets | the field, deviation-only, through to state |
| `index.html`, `account-editor.js`, `accounts-controller.js` | the per-security row list, pruned on save |
| `golden-specs.js` + `golden-dividend-drip-per-security.json` | the split, held over time |
| `evt-dividend-per-security.test.mjs` (DRIP-SEC-1…9) | slicing, vintage lots, §4.4, the fallback, both readings of the map, and the tax invariance |
| `reinvest-dividends-election.test.mjs` | the rows: which securities, the inherited label, pruning, following the holdings |

**MC/Opt.** The map is an object, so neither flag — the template rules at
`record-param-templates.js:22-30` say arrays and objects are not sweep axes. The account
default stays the sweepable lever.

## 6. What this does not change, and one open question

- Wrappers and super (D3).
- The **destination** of a cash dividend. Today it is the country's transaction account
  (`resolveCashKey`), not the paying account's CASH sleeve.

**Q1 — should a non-reinvested dividend land in the account's own cash sleeve instead?**
**CLOSED as mis-framed** (2026-09-16), and the measurement is the reason.

A real broker sweeps the cash into the account, and the difference looked material: design
97's liquidity pools and the reserve read where cash is, so routing every dividend to the
transaction account overstates household liquid cash and understates the brokerage's. The
model is also already inconsistent about it — money-market interest on a brokerage's CASH
sleeve stays in the sleeve (`CashSleeveInterestApplyReducer`), while the dividend on the
equity beside it leaves the account entirely.

Then the surface was measured, across all fourteen goldens: **exactly one brokerage, in two
scenarios, has a CASH sleeve at all.** Every other `us-stock`, `au-stock` and
`fixed-income` account has none, and between them they route A\$8k–112k of dividend and
coupon cash per run. So "land it in the account's cash sleeve" has nowhere to land: it would
fall back to today's behaviour almost everywhere, and where it did not, the same event would
behave differently depending on whether somebody had authored a cash lot — an inconsistency
rather than a model.

**The real question is one level up: should a brokerage hold cash at all?** Making it so is
not a dividend change. A new CASH sleeve on every brokerage moves the allocation mix the
rebalancer targets — the specs author `CASH: 0`, so a dividend landing there would be swept
straight back into equity at the next rebalance (design 61) — and it moves pool
classification and drawdown ordering (design 97). Those are the two designs that own the
question, and answering it inside a dividend-routing change would settle it by accident.

Handed on rather than answered here, with the number above so whoever picks it up starts
from the surface rather than from the intuition.

## 7. Sequencing

| step | what | size | gate |
|---|---|---|---|
| 1 | ✅ **DONE** (2026-09-16) — account field + serializer + builder + template + toolset + editor (US) | small | §4.1 has the record. No golden moved; the election is read from STATE, not captured at build time |
| 1b | ✅ **DONE** (2026-09-16) — AU franked-dividend cash branch + EVT-26/27 rows | small | §4a/§4c have the record. New golden `au-dividend-cash` reaches both branches; DRIP-6c pins the tax invariance. Uncovered **F6** (§4b) |
| F6 | ✅ **DONE** (2026-09-16) — the dividend names the account that paid it (4 sites) | small | §4b has the record. **Twelve goldens re-golded.** Eleven moved by attribution alone; `au-single-homeowner` shed ~A$870k of invented net worth. Uncovered **F7** |
| §4.4 gate | ✅ **DONE** (2026-09-16) — `findOutOfSync` on every golden, per-lot tolerance, waivers with a staleness gate | small | §4b. Found two defects on its first run, neither visible in any fixture diff |
| F7 | ✅ **DONE** (2026-09-16) — F7a the AU earnings stamp (and a reducer ignoring it), F7b overdraw onto the CASH sleeve | small | §4b. Another ~A$871k off `au-single-homeowner`; **waiver list now empty**. The first diagnosis was wrong and the gate is what corrected it |
| 2a | ✅ **DONE** (2026-09-16) — the reinvestment buys the PAYING instrument (`securityId` in the bucket key + per-security slices), **not** fix (a) | small–medium | §5.1. No golden moved economically — which is the finding: none reinvested a multi-security account |
| 2b | ✅ **DONE** (2026-09-16) — `reinvestDividendsBySecurity` + the split emit + the per-security editor rows | medium | §5.1. New golden `dividend-drip-per-security` splits one payment two ways every year; DRIP-SEC-7 pins the tax invariance |
| F8 | ✅ **DONE** (2026-09-16) — AU reinvests into a vintage lot WITH basis, like the US path | small | §7.1. Closes design 94 F3's AU half: AU capital gains halved on `au-single-homeowner`, ~A$41.6k less tax over the run |
| F7 fallback | ✅ **DONE** (2026-09-16) — an EMPTY holdings array earns nothing; an ABSENT one keeps the scalar model | small | §7.1. Nothing moved — preventive, with the §4.4 gate as the backstop |
| Q1 | ✅ **CLOSED as mis-framed** (2026-09-16) | — | §6. One brokerage in fourteen goldens has a CASH sleeve; the question belongs to designs 97 and 61 |

**Design 106 is complete.** Phases 1 and 1b are the election; 2a is the fix the model wanted
whether or not 2b ever happened; 2b is the per-security half the ask started from. F6, F7
and the §4.4 gate were not in the original plan — each was found by the step before it, and
the gate is the one worth keeping in mind: it is now the only thing in the suite asserting a
RELATIONSHIP between fixture values rather than the values themselves.

### 7.1 The three items 2b left, closed  ✅ (2026-09-16)

**F8 — the AU lot mechanics, fixed.** AU reinvested a dividend by `addValue` into the lot
that paid it, with `costBasisDelta: 0`. Both halves were wrong, and design 94 had already
written down why: §5.0a says a purchase is a NEW lot (the paying lot was bought on a
different day, and FIFO, HIFO and the Division 115 12-month gate all read that date), and
F3's own sentence is *"if a reinvested, taxed dividend adds no basis, it is taxed again as
gain at disposal."* The AU brokerage was being taxed twice on every reinvested dividend.

The four AU dividend-apply reducers now reinvest through the same `reinvestDividend` helper
the US path uses — a vintage lot per security per year, carrying the basis the dividend was
taxed on — and the handler hands them `_bySecurity` instead of emitting `holdingActions`.
**This closes the AU half of design 94 F3.** Two of the four (the UNFRANKED pair, reachable
only from authored one-off events) were also crediting `balance` while touching no lots at
all, which is a §4.4 break waiting for the first scenario to author one; they are fixed by
the same change.

What it moved: cents on most goldens (rounding, `addValue` unrounded vs
`distributeHoldingsCredit` rounded per bucket) and one real result on `au-single-homeowner`
— **AU capital gains halved** (`auPersonCapitalGainsYTD` 8,341.98 → 4,024.31) and
**cumulative tax fell about A\$41.6k**, with the inherited brokerage ending A\$79k higher
because that tax was never owed. That is the double-taxation coming out.

**F7's fallback, closed.** `computeHoldingsGrowth` / `computeHoldingsDividends` now
distinguish an **empty** holdings array from an **absent** one: the first is an account
drawn down to nothing, which earns nothing; the second is the pre-substrate scalar shape,
where `balance × rate` is the whole model and every scalar-account unit test lives. Nothing
moved — after F6 and F7a there is no lot-less account with a balance left to feed on — so
this is preventive, and the §4.4 gate is the backstop if a future change reintroduces one.

**Q1, closed as mis-framed** — §6. Measuring the surface before changing it showed that
only one brokerage in the whole fixture set has a CASH sleeve to receive a dividend, so the
question is not where the cash goes but whether a brokerage holds cash at all. That belongs
to design 97 (pools) and design 61 (rebalance targets), and is handed on with the number.

**Design 106 is closed.** What it set out to do — choose reinvestment per security per
account — is done in both countries. What it found on the way was worth more than the
feature: four missing attribution stamps (F6), a phantom balance that had been compounding
and being spent for a decade (F7), a permanent §4.4 break in the cash primitive (F7b), a
double-taxed AU reinvestment (F8, closing design 94 F3's AU half), and a gate that now
asserts a RELATIONSHIP between fixture values rather than the values themselves — the
absence of which is what let all of them sit.



## 8. References

- design 55 §8 — per-account fields with the global param as fallback; §4 the template
  registry; §3 the `acct.<stateKey>.<field>` key scheme; §14 orphan pruning.
- design 94 §7 (the "Cash dividend" row, which points here), §9.4 the reinvestment path,
  §6.2 the per-security overlay that makes §2.1 material.
- design 99 P2 — markets carry total return and yield; why the wrappers have no dividend
  event.
- design 105 — a super fund reinvests its income net of tax; why super is out.
- design 97 — liquidity pools, the reason Q1 is not cosmetic.
- design 98 W0/W2 — generated `acct.` keys are live axes; the `mc`/`opt` rules used in §4.
- `design/requirements.md` EVT-13 (US brokerage dividend), EVT-26/27 (AU franked).
