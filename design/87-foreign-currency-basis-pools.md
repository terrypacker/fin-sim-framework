# 87 — Foreign-currency basis pools: §988 on cash, not just on debt

**Status** (2026-08-06): **PHASES 1, 2, 2b BUILT**, suite green (4,615 unit + 1,017 viz);
phase 3 specified but deliberately not built. Grew out of design 86 G7/P8, which built
§988 on foreign-currency **debt** and, in doing so, made it obvious that the debt is
only one leg of the position.

> **Phases 1–2 are INERT on a scenario until `fxBasisRate` is authored, and that is the
> designed behaviour rather than a defect.** An unstamped pool is stamped at the rate in
> force on its first disposition, so every later disposition measures that rate against
> itself and yields zero. It understates §988 rather than inventing it — the same rule
> the debt leg's `bookingFxRate` follows. See §10 for the verification that this is
> inert *for the right reason*, and for what value to author.

**The one-line finding:** §988 does not attach to mortgages. It attaches to
*nonfunctional currency*, and a bank deposit **is** nonfunctional currency by statutory
definition. Every AUD-denominated cash account a US person holds is a currency basis
pool, and every debit from one is a realization event. The model books none of them.

---

## 1. Why this is not a design-86 sub-gap

Design 86 §7 open question 5 filed the offset deposit as a curiosity: "P8 covers
foreign currency debt only … the amounts are usually small." Both halves of that are
wrong, and the second is wrong in a way that generalises.

**§988(c)(1)(C)(ii)** — the definition, verbatim:

> For purposes of this section, the term "nonfunctional currency" **includes** coin or
> currency, and nonfunctional currency denominated **demand or time deposits or similar
> instruments issued by a bank** or other financial institution.

**§988(c)(1)(C)(i)** — the operative rule:

> In the case of any disposition of any nonfunctional currency — (I) such disposition
> shall be treated as a section 988 transaction, and (II) any gain or loss from such
> transaction shall be treated as foreign currency gain or loss.

Note what is *absent*: any threshold, any purpose test, any carve-out for ordinary
household banking. An AU savings account, an AU transaction account, and an AU offset
account are the same thing under this provision. So is the AUD leg of every
cross-currency transfer. The offset is not legally distinctive — it is just the
largest, slowest-moving pool in the plan, which is a statement about magnitude.

For an individual the gain/loss is then computed per **§988(b)**, over the window from
the currency's acquisition to its disposition — the regulation substitutes
"acquisition date" for "booking date" and "disposition" for "payment date" in the
§988(b) definitions.

---

## 2. The organizing principle: exposure = balance × holding period

This is what keeps the problem finite, and it is the reason phase 3 is separable from
phases 1–2 rather than being the same work at larger scale.

For a lot of `D` units acquired at rate `r_acq` and disposed at `r_disp` (foreign units
per USD throughout, matching `effectiveExchangeRates.USD_AUD`):

> **gain(USD) = D × (1/r_disp − 1/r_acq)**

If a lot is acquired and disposed inside the same few weeks, `r_acq ≈ r_disp` and the
term is ~zero **by construction**, however many transactions there are. So:

| pool | turnover | balance | §988 exposure |
|---|---|---|---|
| transaction account (rent in, expenses out) | days–weeks | modest | ~0, and mostly de minimis |
| savings account accumulating to a future conversion | years | large | **material** |
| offset held against a mortgage | decade+ | large | **maximal** |
| the AUD leg of a cross-currency transfer | instantaneous at the point of conversion | whatever is converted | **material, and unavoidable** |

High transaction *volume* is not the same as high *exposure*, and conflating the two is
what makes this look like an unbounded problem. It is not: two structures carry almost
all of it, and they are the two that phases 1–2 build.

---

## 3. The offset is the mirror leg of the loan, and that changes the sign of P8's number

Design 86 P8 books §988 on principal repayment of a foreign-currency mortgage. When
that mortgage is serviced **from a same-currency offset** — which is the whole point of
an offset, and what `resolveLoanCashKey` already makes the model do — each payment is
simultaneously:

1. a repayment of AUD principal (the debt leg, **built**), and
2. a disposition of AUD out of the deposit (the currency leg, **not built**).

With `P` of principal repaid from `D = P` of deposit:

> gain(debt) = P × (1/r_book − 1/r_pay)  ·  gain(deposit) = P × (1/r_pay − 1/r_acq)

If the facility was opened and the offset funded at the same time and rate
(`r_book = r_acq`), these are **exactly equal and opposite at every payment date**, and
the intervening FX path is irrelevant — only endpoints matter and the endpoints cancel.
A fully-offset facility is economically FX-neutral, which design 86 §8.2 already said;
what is new is that it is *also* §988-neutral, and the model currently shows only one
side of that.

**Consequence to state plainly: building phase 2 will mostly delete a number rather
than add one.** On an income-producing property, where both legs are recognized (see
§4), the P8 figure is largely an artifact of modelling one leg. That is a good reason to
build it, not a reason to skip it — an artifact that large sitting in ordinary income
distorts every downstream marginal-rate decision.

The cancellation breaks in three cases, and they are the ones worth modelling:

- **Different endpoints.** The offset was funded at a different time or rate from the
  loan's origination. Then the legs share no window and do not cancel.
- **Deploy and refill.** Spending offset AUD realizes the deposit leg *then*, at that
  spot, while the debt leg keeps waiting; refilling establishes a new basis at a new
  rate. After one round trip the legs are de-synchronized in time.
- **Personal use.** See §4 — the tax system denies the offsetting leg outright.

---

## 4. §988(e): the individual carve-out, and where the \$200 actually lives

**§988(e)(1)** switches the whole section off for "any section 988 transaction entered
into by an individual which is a **personal transaction**". **§988(e)(3)** then defines
personal as any transaction "except **to the extent** that expenses properly allocable
to such transaction meet the requirements of section 162 … or 212". That "to the
extent" is a fraction, which is why design 86 reuses `deductibleFraction` for it rather
than inventing a second knob.

**§988(e)(2)** is the de minimis, and its scope is narrower than design 86 assumed:

> If — (A) **nonfunctional currency is disposed of** by an individual in any
> transaction, and (B) such transaction is a personal transaction, no gain shall be
> recognized … The preceding sentence shall not apply if the gain which would otherwise
> be recognized on the transaction **exceeds \$200**.

Three things follow:

1. **It applies to currency dispositions, not to debt.** Retiring a mortgage is not a
   disposition of nonfunctional currency by the obligor. Design 86 applies the \$200
   floor to the debt leg, where it arguably has no home — recorded there as a caveat,
   and **carried forward here as phase-2 gap G4** because this is the leg it was
   written for.
2. **It is per transaction, and it is gain-only.** This is precisely the relief for
   high-volume personal spending out of a foreign account: buying groceries abroad is
   not meant to be three hundred §988 computations. It does nothing for a single large
   conversion, and nothing at all for losses.
3. **It does not reach business use.** Servicing an income-producing property's
   mortgage out of the offset is a §212 transaction; no de minimis applies and every
   unit computes.

**The asymmetry, and it is the whole reason this matters for a personal residence.**
On the personal share, gain above \$200 is recognized while the matching loss is a
nondeductible personal loss under **§165(c)** — *Quijano v. United States*, 93 F.3d 26
(1st Cir. 1996), where sterling borrowing against a UK residence produced a large real
currency loss and no deduction. Quijano also forecloses the obvious rescue:
**§988(d)(2)(B)** requires the taxpayer to have *identified* a hedging transaction as
such, and you cannot self-integrate after the fact. So a personal-use fully-offset
facility is a perfect economic hedge that is taxed on the full gain **in either FX
direction** — a genuine phantom, not a modelling artifact.

On an income-producing property none of that bites: both legs are §212, both are
recognized, and the position is symmetric.

> **A trap for whoever builds phase 3:** the business fraction is *live state*, read per
> transaction. A property that stops renting flips its loan and its offset from
> business to personal for subsequent payments only. The asymmetry is dormant in a
> rental scenario, not absent.

---

## 5. Scope

### Phase 1 — cross-currency transfers (G1, G2)

The highest value per unit of work, because a conversion has **no offsetting leg**: it
is the moment accumulated foreign basis is realized into dollars, and nothing else in
the model cancels it.

- **G1 — `INTL_TRANSFER_APPLY`, direction `AU_TO_US`.** `IntlTransferApplyReducer`
  debits the AU account and credits the US one. The AUD debited is disposed of;
  §988 gain/loss realizes against the basis of the lots consumed. The `US_TO_AU`
  direction is the mirror: it *acquires* AUD and establishes basis, realizing nothing.
- **G2 — the inline path.** `AccountService.replenishSavings` performs cross-currency
  sweeps *synchronously* inside the drawdown loop (design 44's stranding fix) and emits
  `INTL_TRANSFER_RECORD` as a journal marker rather than routing through
  `INTL_TRANSFER_APPLY`. **There are two conversion paths and both must realize**, or
  the §988 total silently depends on which drawdown branch ran. This is the same
  double-path shape as design 44 Gap A and it is the likeliest place for this work to
  be half-done.

### Phase 2 — the offset deposit (G3, G4)

- **G3 — an acquisition rate on the offset**, and realization on every debit. Mirrors
  `bookingFxRate` on `LoanAccount`, including the balance-weighted **harmonic** blend on
  credit: preserving total USD basis is the only blend that does not manufacture §988
  out of an accounting choice. Reuse `blendSection988BookingRate`; the algebra is
  identical, only the sign convention of the position differs.
- **G4 — move the \$200 de minimis to this leg** and off the debt leg, per §4.

### Phase 2b — foreign-currency BONDS (G9). **Built.**

The question "should the basis be per-holding rather than per-account?" has a precise
answer, and it is not uniform across sleeves. §988(c)(1)(B) is a **closed list** —
debt instruments, accrued items, and forwards/futures/options — plus §988(c)(1)(C) for
currency itself. Mapping that onto the four-value `ALLOCATION` enum:

| ALLOCATION | §988 property? | authority / reason |
|---|---|---|
| **CASH** | yes | §988(c)(1)(C) — it *is* nonfunctional currency. Account-level (G3). |
| **BOND** | yes | §988(c)(1)(B)(i) — a *debt instrument*. **Per-holding** (G9). |
| **EQUITY** | **no** | a share is on none of the (c)(1)(B) clauses. |
| **GOLD** | **no** | same. |

For equity and gold the currency movement is **embedded in the capital gain** via §1001
translation — cost at the purchase-date rate, proceeds at the disposal-date rate, and
the difference includes the FX move but is **capital**, not ordinary. Booking a separate
§988 item on an equity sleeve would double-count the movement *and* recharacterise
capital gain as ordinary income. This is why an account-level rate must not be applied
to a brokerage: it would silently claim the equity sleeves too.

**Built:** `Holding.fxBasisRate`, and realization in `BondMaturityReducer` when a
foreign-currency bond is redeemed. The holder's rule is **Reg. §1.988-2(b)(5)** — the
exact mirror of the (b)(6) obligor rule the mortgage leg uses — and it measures the
**principal** received (par), leaving the instrument's own price movement as capital.

> **The sign is transposed relative to the debt leg, and getting it wrong is silent.**
> `computeSection988Gain` is written in the obligor's convention, so a holder must pass
> `(units, spot, acqRate)`, not `(units, acqRate, spot)`. The first implementation here
> had it backwards and every negative test still passed — three "realizes nothing" cases
> return zero whether the code is right or inverted. Only CB-22/CB-27, which assert the
> *direction* of a non-zero result, caught it. Absence tests need a live control.

**Two defaults differ from the cash pool, deliberately:** a bond's §988(e)(3) share
defaults to **1** (a bond in a taxable account is held for the production of income,
§212) where a cash pool defaults to 0 (a household balance funds living expenses); and
no §988(e)(2) de minimis applies, for the same reason it does not on the mortgage.

**Remaining in G9, not built:** disposition *before* maturity. Reg. §1.988-2(b)(5) fires
when principal is received "**or the instrument is disposed of**", so a sale realizes the
accumulated position too — that runs through `consumeHoldings`, a different seam from
redemption. Coupons carry their own item between accrual and payment
(Reg. §1.988-2(b)(3), holder side), identically zero here because the two are
simultaneous.

### Phase 3 — the general currency pool (G5–G8). **Specified, not scheduled.**

Written down now, while the analysis is in hand, so it can be picked up cold.

- **G5 — a lot ledger on every foreign-currency cash account.** Credits create lots
  stamped with the spot rate; debits consume them. The codebase already has this shape
  twice — `Holding.costBasis` for CGT and design 84 G9's rollover ledger — so this is a
  pattern to copy, not to invent. Beware [[basis-ledger-revaluation-drift]]'s failure
  mode: anything that revalues a balance outside the ledger (shocks, marks, direct
  `transaction()` calls) silently desynchronizes basis from balance.
- **G6 — a consumption convention.** FIFO vs. average cost. The regulations give
  individuals **no clear rule** for currency, and practice is split; the codebase
  already carries a `FIFO` param elsewhere, so matching it is the least-surprising
  default. This is a genuine choice, not a lookup — record whichever is picked and why.
- **G7 — the de minimis at volume.** With G5 live, a transaction account generates one
  §988 computation per debit. §988(e)(2) excludes the personal ones at \$200 each, but
  the model still has to *compute* each to know. Needs a materiality gate (a minimum
  balance or a minimum holding period below which a pool is not tracked) or the journal
  drowns — see [[sim-perf-telemetry-dominates]] for how quickly per-transaction
  telemetry dominates runtime.
- **G8 — the AUD leg of foreign-currency income.** Rent received in AUD, AU wages, AU
  interest: each is an acquisition of currency at that day's rate. Phase 3 is where
  those become lots rather than untracked balance.

**Explicitly out of scope in every phase:** superannuation. A super interest is a
pension/trust interest, not a bank deposit — its cross-border treatment is design 83's
Art. 18 work and design 84's s99B work, and pulling it in here would conflate two
unrelated regimes.

---

## 6. Decisions already made, inherited from design 86 G7

These do not need re-litigating; they were settled building the debt leg and the
currency leg should match them.

- **Realize in the reducer, not the handler.** A handler's intended amount is not the
  amount that moved; only what actually left the account is disposed of.
- **Source follows the tax home, not the passport.** §988(a)(3)(A) sources by residence
  and §988(a)(3)(B)(i)(I) defines that as the §911(d)(3) tax home, so the source flips
  at the move year. `section988Residence(state, account)` already exists and should be
  reused verbatim — it takes the owner from the account, then the linked property, then
  the first person.
- **Gains tag the basket; losses do not.** A foreign-source gain joins
  `usOrdinaryIncomeYTD` *and* `foreignGeneralIncomeYTD` (a basket accumulator is a
  subset-tag of gross income, so the `Σ basket gross ≤ grossIncomeAllSources` invariant
  holds). A loss stays on the `agi` + `unrelatedDeductions` route, which apportions it
  pro-rata — the correct §904 treatment for a deduction, and the one that does not
  re-open design 86 G5b's negative-basket collapse.
- **An unstamped account is stamped at today's rate and realizes nothing this period.**
  For a balance already present at t0 the true acquisition history is unknowable to the
  model; treating it as acquired now **understates** §988 rather than inventing it.
  Authoring the real rate is the fix, and the field must be serialized — see §7.

---

## 7. Known traps, from the P8 build

Every one of these cost time on the debt leg and will recur on the currency leg.

1. **Declare new action fields in the toolset's `fields` map.** `pickPayload` keeps only
   declared fields, so an undeclared one is silently dropped and the classifier sees
   `undefined`. This is how the residency fix could have shipped inert.
2. **`scenario-serializer.js` has per-field allowlists in BOTH directions.** A new
   account field that is not added to both is silently lost on save/load, and the
   failure mode is understatement rather than an error.
3. **`_accountToStatePlain` projects a field allowlist too**, per-toolset and
   duplicated across the US and AU retirement toolsets. A field honoured on one side
   only changes behaviour with whichever country owns the record.
4. **`src/index.js` is generated** — run `npm run build:index` after adding exports, and
   do not hand-add re-exports ([[build-index-reexport-duplicate]]).
5. **FX-pinned is not a zero control for this.** §988 measures acquisition → disposition,
   so a pinned rate freezes the *rate of* gain, not the gain. Any regression that
   asserts "zero under `fxProcessModel: NONE`" must also pin the acquisition rate equal
   to the spot, or it is asserting the wrong thing — this is exactly how the debt leg
   was mis-verified the first time.

---

## 8. Open questions

1. **Is an offset deposit business-use under §988(e)(3)?** The provision asks about
   "expenses properly allocable to such transaction", and a deposit has no expenses. Its
   *function* is suppressing interest on an income-producing loan, which is a decent
   §212 argument, but it is not the clean answer the mortgage leg has. Note the irony:
   an offset earns no interest by design ([[offset-earns-no-yield]]), which weakens the
   profit-motive characterization exactly where you would want it strong.
2. **Should the two legs be integrated when they genuinely match?** §988(d) allows it
   but §988(d)(2)(B) demands identification, and Quijano says it must be contemporaneous.
   Probably "no, and that is the finding" — but it should be a recorded decision rather
   than an omission, because a reader will ask.
3. **What convention for lot consumption (G6)** — see phase 3. Blocking for phase 3
   only; phases 1–2 each touch a single-lot pool where the question does not arise.
4. **Does the AU side assess anything?** For an Australian resident an AUD balance is
   their own functional currency, so Div 775 ITAA 1997 has no forex realisation event
   and the answer is no. For a *US*-resident holding AUD there is no AU nexus either.
   So this is a one-sided item throughout — which is unusual enough in this codebase to
   be worth stating, since almost everything else here is a two-country question.

---

## 9. Phases

| phase | gaps | status |
|---|---|---|
| **1** | G1 `INTL_TRANSFER_APPLY` both directions · G2 the inline `replenishSavings` path | **built** |
| **2** | G3 offset acquisition rate + realization on debit · G4 de minimis moved to this leg · UI authoring surface | **built** |
| **2b** | G9 foreign-currency bonds, per-holding, redemption path | **built** (sale-before-maturity remaining) |
| **—** | §11 `CASH ⇒ no capital gain` guard in `consumeHoldings` + `Holding` invariant | **built** |
| **3** | G5 lot ledger · G6 consumption convention · G7 materiality gate · G8 income-side acquisition | **specified, not scheduled** |

---

## 10. Verification — and the working-detector control

`fxProcessModel: NONE` plus an unauthored `fxBasisRate` makes phases 1–2 produce
**exactly zero**, which is indistinguishable from dead wiring. Design 86 G7 was
mis-verified in precisely that way once already (§7 trap 5), and
[[offset-earns-no-yield]] records the general rule: an absence test needs a control that
proves the detector works. So the build was verified by *authoring* the missing rate and
confirming the predicted behaviour appears.

Four arms on the base scenario, offset `fxBasisRate` and `deductibleFraction` varied,
everything else held (concrete figures in the gitignored run notes):

| arm | net §988 | reading |
|---|---|---|
| offset basis **unset** (as authored) | full debt-leg gain | the currency leg is stamped at spot and thereafter zero — **inert for the right reason** |
| basis = the loan's booking rate, **business** use | **exactly zero** | §3's cancellation, end-to-end. The loss equals the gain to the cent |
| same basis, **personal** use | full gain again | §165(c) kills the offsetting leg. Terminal net worth is *identical* to arm 1 — the loss buys nothing. Quijano, reproduced |
| basis = a **later, different** rate | partial | mismatched endpoints, the case §3 says is worth modelling |

Arms 2 and 3 are the load-bearing pair: identical currency movements, identical economic
hedge, and the only difference is whether the property produces income. That is the
whole §988(e) asymmetry in two rows.

**What value to author.** `fxBasisRate` is the pool's USD cost basis expressed as a
rate, so for a balance built up over years it is the balance-weighted **harmonic** mean
of the rates at which the currency was acquired — which is what
`blendCurrencyBasisRate` maintains going forward. Two common cases:

- **Converted from USD.** The rate on the conversion date(s). Directly observable.
- **Earned in Australia and never converted.** AUD wages are included in income
  translated at the spot rate on the day earned, and that translated amount *is* the
  basis. So the pool's rate is roughly the average AUD/USD over the accumulation
  period, not today's rate. Authoring today's rate understates the position.

A pool whose history is genuinely unknown should be left null: the model will stamp it
and recognize nothing, which is the honest answer rather than a fabricated one.

**Phase 3's G5 lot ledger is what removes this authoring burden** — with per-lot basis
the rate stops being a single authored scalar and becomes an accumulated fact. That is
the strongest argument for eventually building it.

---

## 11. `CASH ⇒ no capital gain` — one invariant, two paths, one of them missing it

Found while checking whether the offset's currency basis had a home in
`Holding.costBasis`. It doesn't — and looking established that a CASH sleeve's
`costBasis` was carrying an arbitrary value that no longer bore any relation to its
market value.

**The first diagnosis was "stale data", and that was wrong.** Proportional scaling in
`holding-utils` preserves whatever basis:value ratio a lot is created with, so a bad
ratio is fixed in place for the life of the plan — but that is a symptom. The defect is
that two disposal paths disagree about the same fact:

| path | CASH treatment |
|---|---|
| `rebalance-to-target-apply-reducer` (rebalance sell) | **excludes CASH** — `taxable && allocation !== ALLOCATION.CASH`, with the comment "CASH has no gain" |
| `consumeHoldings` via `AccountService` (brokerage drawdown) | **no allocation guard** — CASH was treated as gain-bearing |

Cash has no capital gain: a unit of currency is disposed of for exactly its face, so
basis equals proceeds by definition and there is no price to have moved. The rebalancer
has always known that; the drawdown path did not. Measured on the real sleeve shape:
consuming \$10,000 of a cash lot carrying a stale basis booked over \$9,700 of phantom
capital gain, where the rebalancer would have booked nothing.

**It was dormant, not active.** A glidepath that targets 0% cash zeroes the sleeve
through the *rebalance* path (guarded) long before any drawdown reaches it. So the live
scenario measured a \$0 difference — which is exactly the shape of a bug that surfaces
the day someone changes an allocation schedule.

**A related worry, chased and dismissed.** The trace showed the sleeve vanishing with no
gain booked, which raised the question of whether rebalancing was tax-free in general.
It is not: `rebalance-to-target-apply-reducer` realizes CGT on taxable non-CASH sells
with the jurisdiction-correct action, and even accumulates sheltered gains for s99B
(design 84 G2). The zero was the CASH guard doing its job.

**Fixed in two independent places, because either alone is insufficient:**

1. **`consumeHoldings` now excludes CASH from realized gain** — basis share = proceeds,
   no per-country tally, and **no indexation** (ratcheting a currency balance's basis up
   for inflation would manufacture a capital *loss* on money that cannot have one). A
   partial consume re-asserts the invariant on the remainder rather than subtracting,
   which would otherwise leave a negative basis behind. This is the correctness fix: it
   holds regardless of what the data says.
2. **The `Holding` constructor enforces `CASH ⇒ costBasis = marketValue`.** This is the
   hygiene fix: it stops a meaningless ratio propagating into anything else that reads
   basis (reports, the allocation cube, future code). Alone it would be insufficient —
   data can drift again — but it heals every saved scenario on load.

This does **not** discard currency basis. A foreign-currency pool's §988 basis is a
**rate**, not an amount, and lives in `fxBasisRate`; `costBasis` was never able to
express it. The two were only ever confusable because both are called "basis".

> **Regression note (CB-28..32).** CB-29 is a deliberate working-detector control: an
> EQUITY lot with byte-identical numbers must still realize its gain. Without it,
> CB-28 would pass equally well against a `consumeHoldings` that realized nothing at
> all — the same trap §7 trap 5 and §10 record.
