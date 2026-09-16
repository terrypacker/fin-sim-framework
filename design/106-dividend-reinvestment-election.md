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

### 4a. The AU half, which is not free

`IntlAuStockDividendHandler` has no cash branch: there is no
`AU_DIVIDEND_FRANKED_*_CASH_APPLY`. Electing "no reinvest" on an AU brokerage account needs
one built — credit the AU transaction account, keep the franking credit assessable with the
gross-up exactly as the reinvest branch does (the credit attaches to the dividend, not to
where the cash lands), and add the EVT-26/EVT-27 variants to `design/requirements.md`.
Small, but it is new tax-path code rather than a re-route, so it is its own step.

## 5. Phase 2 — per security, within the account

**Shape.** `reinvestDividends` stays the account default; add
`dividendReinvestBySecurity: { [securityId]: boolean }`, absent entries inheriting the
default, the whole map omitted when empty.

**Decision D4: one map plus a default, not an allow-list and a deny-list.** The two lists
the ask describes are the same object read two ways: with a default of `false` the map's
`true` entries *are* the allow-list; with a default of `true` its `false` entries *are* the
deny-list. Storing lists instead needs a rule for "in both" and "in neither", and that rule
is the default we would have had to store anyway.

**Prerequisite — §2.1.** The US reinvest path must buy the paying security. Two ways:

- **(a) Emit the per-holding actions, as AU does.** The handler already has them from
  `computeHoldingsDividends`; the US path throws them away. Send `STOCK_DIVIDEND_APPLY`
  with `holdingActions` and stop the reducer re-distributing. Matches the AU path, which
  is the one that is right.
- **(b) Add `securityId` to `_incomeBucketKey`.** Cheaper to write, but it fixes the
  bucketing without giving the handler a way to split one payment two ways, so phase 2
  still needs (a). Not worth doing separately.

Take (a). **It moves goldens** — every account holding two or more securities that share an
income bucket with different yields will reprice its lots.
`tests/fixtures/golden-two-security-concentration.json` is the detector by construction
(design 94 §9.8), and the re-gold is the gate, not a surprise.

**The handler, after.** One `call()` partitions the account's holdings by the resolved
election and emits up to two actions plus the per-holding moves:
`STOCK_DIVIDEND_APPLY` for the reinvested slice (with its `holdingActions`) and
`STOCK_DIVIDEND_CASH_APPLY` for the rest. Both already chain `STOCK_DIVIDEND_TAX`, so the
taxable total is unchanged by the split — the invariant to pin is
`Σ STOCK_DIVIDEND_TAX.amount == computeHoldingsDividends().amount`, per year, per account.
Note for the journal: two reducers now fire for one economic event, so any rollup must
filter on `entry.reducer` before summing (the `AU_TAX_SETTLE_APPLY` double-count trap).

**UI.** The account editor already resolves each lot's security (`account-editor.js:774`).
Phase 2 adds a row list of the **distinct securities held in this account**, each with an
inherit/on/off control — a typed editor, not a JSON textarea, composed the way the existing
row-list editors are. A security that leaves the account leaves the list; its stale map
entry is pruned on save the way orphaned generated params are reconciled (design 55 §14).

**MC/Opt.** The map is an object, so neither flag — the template rules at
`record-param-templates.js:22-30` say arrays and objects are not sweep axes. The account
default stays the sweepable lever.

## 6. What this does not change, and one open question

- Wrappers and super (D3).
- The **destination** of a cash dividend. Today it is the country's transaction account
  (`resolveCashKey`), not the paying account's CASH sleeve.

**Q1 — should a non-reinvested dividend land in the account's own cash sleeve instead?**
A real broker sweeps it there, and the difference is not cosmetic: design 97's liquidity
pools and the reserve read where cash is, so routing dividends to the transaction account
overstates household liquid cash and understates the brokerage's. Out of scope here, but it
is the question this design sits next to, and phase 1 makes it more visible by letting one
account pay cash while another reinvests.

## 7. Sequencing

| step | what | size | gate |
|---|---|---|---|
| 1 | ✅ **DONE** (2026-09-16) — account field + serializer + builder + template + toolset + editor (US) | small | §4.1 has the record. No golden moved; the election is read from STATE, not captured at build time |
| 1b | AU franked-dividend cash branch + EVT-26/27 rows | small | AU-resident and non-resident cash payouts carry the same assessable amount and credit as the reinvest branch |
| 2a | US reinvest path emits per-holding actions (§2.1 fix (a)) | small–medium | **re-gold**; the two-security golden is the detector; Σ tax unchanged |
| 2b | `dividendReinvestBySecurity` + the split emit + the per-security editor rows | medium | a partial election reinvests one security and pays the other in cash, in one account, in one year, with tax unchanged |

Phases 1 and 1b are shippable and useful on their own; 2a is a fix the model wants whether
or not 2b ever happens.

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
