# 87 — Foreign-currency basis pools: §988 on cash, not just on debt

**Status** (2026-08-06): **PHASES 1, 2, 2b BUILT**, suite green (4,615 unit + 1,017 viz);
phase 3 specified but deliberately not built. Grew out of design 86 G7/P8, which built
§988 on foreign-currency **debt** and, in doing so, made it obvious that the debt is
only one leg of the position.

**Revised 2026-08-08.** Everything above §12 was written against the *statute* alone,
because the regulations were not on disk. They are now — `§1.988-1` and `§1.988-2`, see
**§12** — and they correct three things this doc previously got wrong: what counts as a
realization event (§1), what happens on the personal branch (§4), and whether the lot
consumption convention is an open question (§5 G6, §8 Q3). **§12 is the entry point for
anyone picking this up cold**; the corrections are also inlined where they bite.

**Closed 2026-08-08.** The research is done and the remaining gaps are specified rather
than open questions. What is left is scheduling, plus two decisions (§8 Q1, §5 G6) that
need facts from outside the codebase. §12.5 states what a real-world-shaped scenario
needs and which of it exists; **§13 proposes the replay overlay** that grew out of
building the ingest tool, and is the natural successor to this design.

> **Phases 1–2 are INERT on a scenario until `fxBasisRate` is authored, and that is the
> designed behaviour rather than a defect.** An unstamped pool is stamped at the rate in
> force on its first disposition, so every later disposition measures that rate against
> itself and yields zero. It understates §988 rather than inventing it — the same rule
> the debt leg's `bookingFxRate` follows. See §10 for the verification that this is
> inert *for the right reason*, and for what value to author.

**The one-line finding:** §988 does not attach to mortgages. It attaches to
*nonfunctional currency*, and a bank deposit **is** nonfunctional currency by statutory
definition. Every AUD-denominated cash account a US person holds is a currency basis
pool, and the model books none of them.

> **Correction (2026-08-08).** This sentence used to end "…and **every debit from one is
> a realization event**." That is **wrong**, and it is the single most load-bearing error
> the regulations fixed. `§1.988-2(a)(1)(iii)` puts a withdrawal from a deposit, and a
> transfer to another deposit in the same currency, on the **non-recognition** list with
> carryover basis. Realization waits for an actual *disposition* — a conversion, or an
> exchange of the currency for property or services. See §1a.

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

## 1a. What is a disposition — and what is not

Added 2026-08-08 from `§1.988-2(a)(1)(iii)`, which the statute alone gives no hint of.
**Money leaving the account is not the taxable event.** Five transactions are on the
non-recognition list; two are decisive for a cash pool:

> **(C)** The withdrawal of nonfunctional currency from a demand or time deposit or
> similar instrument issued by a bank or other financial institution if such instrument
> is denominated in such currency;
>
> **(E)** The transfer of nonfunctional currency from a demand or time deposit … to
> another demand or time deposit … denominated in the same nonfunctional currency …
>
> The taxpayer's basis in the units of nonfunctional currency … received in the
> transaction shall be **the adjusted basis of the units … transferred**.

The reg's own example runs £1,500 through a purchase, a deposit, a withdrawal and *then*
an inventory buy, across four different spot rates, and holds that **no loss is realized
until the pounds buy the inventory**. Sorting the four event kinds:

| CSV / model event | §988 effect |
|---|---|
| credit — wages, rent, a `US_TO_AU` conversion | **acquires** basis at that day's spot; realizes nothing |
| AUD → USD conversion | **disposition.** The big one: no offsetting leg exists (§5 P1) |
| AUD spent on property or services | **disposition**, priced by `§1.988-2(a)(2)(ii)(B)` — treated as a sale of the units for USD at spot, *then* a purchase for those dollars |
| AUD paid against an AUD payable (a mortgage payment) | **disposition**, and the mirror of the debt leg — §3 |
| offset → transaction account, or any same-currency move | **non-event**, basis carries over |
| plain withdrawal of cash | **non-event** |

**The shipped code is correct on this and only the prose was wrong.**
`realizeCurrencyDisposition` has exactly three callers — `loan-classes.js` (a loan
payment), `intl-transfer-apply-reducer.js` and `AccountService.replenishSavings` (both
conversions) — and all three are genuine dispositions. Nothing fires on a bare debit.
**The risk was forward-looking:** phase 3 G5, built literally from the old sentence,
would have realized on every debit and been wrong in a way that a lot ledger makes
expensive to unwind.

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

**§1a and §4 both make this argument stronger than it was when written.** A transaction
account's churn shrinks twice more before it reaches the return: the same-currency
transfers and withdrawals inside it are not dispositions at all, and what remains is
mostly personal, which `§1.988-1(a)(9)` puts outside §988 entirely. The row that says
"~0" is now ~0 for three independent reasons rather than one.

---

## 3. The offset is the mirror leg of the loan, and that changes the sign of P8's number

Design 86 P8 books §988 on principal repayment of a foreign-currency mortgage. When
that mortgage is serviced **from a same-currency offset** — which is the whole point of
an offset, and what `resolveLoanCashKey` already makes the model do — each payment is
simultaneously:

1. a repayment of AUD principal (the debt leg, **built** — design 86 P8), and
2. a disposition of AUD out of the deposit (the currency leg, **built** — Phase 2 G3;
   `LoanPaymentApplyReducer` calls `realizeCurrencyDisposition` on the cash it pays from).

*(This line said the currency leg was "not built" until 2026-08-12, long after Phase 2
landed. §9's phase table was right and this paragraph was stale — and it was the stale
half that got believed, because it is the one that reads like an argument rather than a
status table. When a doc states a build status in prose AND in a table, the prose is the
one that rots.)*

With `P` of principal repaid from `D = P` of deposit:

> gain(debt) = P × (1/r_book − 1/r_pay)  ·  gain(deposit) = P × (1/r_pay − 1/r_acq)

If the facility was opened and the offset funded at the same time and rate
(`r_book = r_acq`), these are **exactly equal and opposite at every payment date**, and
the intervening FX path is irrelevant — only endpoints matter and the endpoints cancel.
A fully-offset facility is economically FX-neutral, which design 86 §8.2 already said;
what is new is that it is *also* §988-neutral.

**MEASURED, 2026-08-12, and it is exact.** On a 44-year plan with a fully offset
AUD facility, a live `MEAN_REVERTING` FX path and both rates stamped at the same spot:
over three hundred payment events the debt leg and the deposit leg netted to **zero to
the dollar**. The prediction above is not approximately right, it is an identity.

**Consequence, as predicted: phase 2 deleted a number rather than adding one.** On an
income-producing property, where both legs are recognized (see §4), the P8 figure was
entirely an artifact of modelling one leg.

**⚠ The trap this leaves, and it bit a real study.** A pool with no authored
`fxBasisRate` is stamped at the spot of its **first disposition**, not at the date the
currency arrived (`currency-basis.js`: *"Author the real rate to fix that"*). For an
offset, the first disposition is the first loan payment — which an interest-only period
defers by years. So **stamping the debt leg alone is worse than stamping neither**: it
guarantees `r_book ≠ r_acq` and manufactures the very artifact phase 2 removed. Design 86
§8.9's facility lever did exactly this and recognized a five-figure USD §988 gain on a
position that should have recognized nothing, with the DEPOSIT leg the larger of the two.
Any tool positing a facility drawn at a given date must stamp **both** legs at that
date's rate; `scripts/lib/variant.mjs`'s `facility` lever now does, and
`tests/unit/variant-loan-offset.test.mjs` pins the equality.

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

**`§1.988-1(a)(9)` restates this as a definitional exclusion, and that changes the
character of what survives.** The reg says a transaction by an individual "shall be
considered a section 988 transaction **only to the extent** expenses properly allocable
… meet the requirements of section 162 or 212", and its Example 2 — a taxpayer spending
£1,000 on hotels, food and sundries on holiday — holds those dispositions are **not
§988 transactions**. Not "§988 transactions relieved by a de minimis": *outside the
section*. So on the personal share:

- **§988(a)(1)(A)'s ordinary characterization never attaches**, because §988 does not
  apply. Character falls back to §1001/§1221, and currency is a capital asset — so
  personal-share gain is **capital**, with holding period taken from the acquisition
  date of the units disposed of.
- **§988(e)(2) is the downstream backstop**, and it is broader than §988: "no gain shall
  be recognized **for purposes of this subtitle**". So ≤ \$200 of gain per transaction is
  excluded outright, not merely de-characterized.
- **Losses are unchanged** — nondeductible under §165(c), per Quijano.

> **Gap G10 (new, not built).** `computeCurrencyDisposition` books the personal share as
> **ordinary** §988 gain. Per the above it should be **capital**. The error is confined
> to character, not amount, and it runs against the taxpayer at ordinary rates. It is
> also *dormant on the live scenario*, where the offset is rental-linked and the business
> fraction is 1 — so this is a correctness fix with no expected effect on current
> numbers, and it needs a working-detector control to prove it fires at all (§10).
> **A capital branch needs a holding period, which a single `fxBasisRate` scalar cannot
> supply** — see §5 G6 for why that is the one real argument for a lot ledger.

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

### Phase 3 — the general currency pool (G5–G8, G11, G12). **Specified, not scheduled.**

Written down now, while the analysis is in hand, so it can be picked up cold.

- **G5 — a lot ledger on every foreign-currency cash account.** Credits create lots
  stamped with the spot rate; **dispositions** consume them — *not* every debit, per §1a.
  The codebase already has this shape twice — `Holding.costBasis` for CGT and design 84
  G9's rollover ledger — so this is a pattern to copy, not to invent. Beware
  [[basis-ledger-revaluation-drift]]'s failure mode: anything that revalues a balance
  outside the ledger (shocks, marks, direct `transaction()` calls) silently
  desynchronizes basis from balance.

  **G5 and G6 are separable, and this doc previously bundled them.** A lot ledger is
  what lets the pool's basis be *derived from history* instead of hand-authored (§10's
  burden), and that is true under **either** convention — a pro-rata pool built from real
  transaction history still needs the history. So G5 can be built and justified without
  ever settling G6.

- **G6 — the consumption convention. ANSWERED, and the previous answer was wrong.**

  This doc used to say the regulations "give individuals **no clear rule** for currency,
  and practice is split." **They give an explicit rule.**
  `§1.988-2(a)(2)(iii)(B)(1)`, verbatim:

  > The basis of nonfunctional currency withdrawn from an account with a bank or other
  > financial institution shall be determined under **any reasonable method that is
  > consistently applied from year to year by the taxpayer to all accounts** denominated
  > in a nonfunctional currency. For example, a taxpayer may use a **first in first out**
  > method, a **last in first out** method, a **pro rata** method … or any other
  > reasonable method that is consistently applied. However, a method that consistently
  > results in units of nonfunctional currency with the **highest basis being withdrawn
  > first shall not be considered reasonable**.

  One guardrail (never systematically highest-basis-first — FIFO and pro-rata both
  satisfy it by construction) and one lock (**all** nonfunctional-currency accounts,
  **every** year; changing later is a method change).

  **The decision: pro-rata is the incumbent, and FIFO must earn the switch.** The reason
  is that we have already built pro-rata without labelling it as such —
  `fxBasisRate` + `blendCurrencyBasisRate` *is* the reg's pro-rata method exactly, not an
  approximation of it:

  > basis consumed = `units / r` = units × (totalUsdBasis / balance)
  > = aggregate basis × (units withdrawn ÷ total units) ← the reg's own fraction

  and the harmonic blend on credit is precisely what holds that identity. So pro-rata is
  **stateless** — one scalar per account, O(1) per event, no G7 materiality gate needed
  because there is nothing to drown in. FIFO costs the whole of G5 plus G7.

  **What FIFO buys, and it is exactly one thing:** a holding period, which G10's capital
  personal branch needs and a scalar cannot supply. Note the authority here is thinner
  than it looks — `§1.988-2(a)(2)(iii)(B)` speaks to **basis** only, and neither reg uses
  the phrase "holding period" anywhere. That pro-rata forecloses long-term treatment is
  an inference from the method's logic (you cannot say which units left *and* say how
  long they were held), not a citable rule.

  **Which convention yields less tax is path-dependent and cannot be settled from
  first principles** — it turns on the AUD/USD path against the timing of credits and
  dispositions. It is also the wrong question: the choice is **locked at adoption and
  binds all future years**, so the criterion is robustness across paths, not the winner
  on the path that happened. Two cheap measurements decide it, both available from real
  transaction history *before* any rate data:

  1. **Pool structure.** An offset filled once and drained over a decade is nearly a
     single lot, and the two methods **converge** — the choice is then immaterial and
     pro-rata wins on cost alone. Only genuine churn separates them.
  2. **Personal-branch survivors.** Count dispositions whose personal-share gain clears
     the \$200 exclusion. If that count is ~0 — the expected result for a household pool
     paying bills — G10's holding period is never consulted and FIFO's sole advantage
     is worth nothing.

  If those two do not decide it, the tiebreak is dispersion across MC rate paths, not a
  point estimate. **Whatever is picked must match what is actually filed**, or the model
  stops predicting the return.
- **G7 — the de minimis at volume. Largely dissolved by §1a and G6.** The worry was that
  a transaction account generates one §988 computation per debit, so the model must
  *compute* each to know whether \$200 relieves it, and the journal drowns
  ([[sim-perf-telemetry-dominates]]). Three of the four legs of that argument are gone:
  most debits are **not dispositions** (§1a), most of the rest are **not §988
  transactions at all** (§4), and under pro-rata a disposition is an O(1) scalar
  operation with no lot walk. G7 survives only as a **FIFO cost**, which is one more
  reason for FIFO to have to earn the switch. If FIFO is ever adopted, the gate is a
  minimum balance or minimum holding period below which a pool is not tracked.
- **G8 — the AUD leg of foreign-currency income.** Rent received in AUD, AU wages, AU
  interest: each is an acquisition of currency at that day's rate. Phase 3 is where
  those become lots rather than untracked balance.

- **G11 — pools are PER-ACCOUNT with basis carryover, not one commingled pool.**
  Added 2026-08-08, correcting a claim made while designing the ingest tool. It is
  tempting to read `§1.988-2(a)(2)(iii)(B)(1)`'s "consistently applied … to **all
  accounts**" as merging them. It does not: it requires the *method* be consistent, and
  the sentence it sits in speaks of currency "withdrawn from **an account**".

  The controlling mechanic is `(a)(1)(iii)(E)` — a transfer carries "the adjusted basis
  of the units … transferred". **The two models give different answers**, under either
  convention:

  > A: 100 units, basis \$100. B: 100 units, basis \$50. Move 50 units A→B.
  > *Per-account:* the 50 carry \$50 of basis out of A, so B becomes 150 units / \$100.
  > A later 50-unit disposal from B takes \$100 × 50/150 = **\$33.33**.
  > *Commingled:* one pool of 200 units / \$150; the same disposal takes
  > \$150 × 50/200 = **\$37.50**.

  So commingling is a **simplification** — arguably defensible as "a reasonable method
  consistently applied", but a recorded choice rather than something the regulation
  hands you. **Consequence for G5:** under per-account, `INTERNAL` rows do real work
  (they move basis between ledgers); under commingled they are pure no-ops. Decide
  before the ledger is written, not after.

  Either way **every account in the currency must be ingested**, because basis flows
  between them and a carryover you cannot see cannot be computed.

- **G12 — the `§988(e)(3)(B)` tax carve-out.** Not modelled, and invisible until you look
  at real data. §988(e)(3) adopts §212 **"other than that part of section 212 dealing
  with expenses incurred in connection with taxes"** — the same words in
  `§1.988-1(a)(9)(i)`. So currency disposed of to *pay tax* is a **personal** transaction
  even where it is unambiguously connected to an income-producing property. It falls to
  the capital branch (G10) with the \$200 exclusion, while every other expense of the
  same property is ordinary §988.

  This is a trap of exactly the shape the codebase keeps hitting: a broad rule
  (`property expense ⇒ business`) with a narrow statutory hole in it, where the hole is
  invisible unless you go looking. `currencyPoolBusinessFraction` reads one fraction off
  the account and cannot express it; the fraction has to be **per disposition**, which
  G5's ledger makes possible and the current scalar does not.

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

1. **Is an offset deposit business-use — and under WHICH test?** This is really two
   questions, and conflating them is a live imprecision in the model.

   | provision | test | decides |
   |---|---|---|
   | §988(e)(3) | expenses allocable meet **§162 or §212** | whether §988 applies (ordinary character) |
   | §165(c)(2) | transaction **"entered into for profit"** | whether the loss is deductible |

   "Entered into for profit" is the **broader** standard, so the two can diverge: a
   transaction that fails §212 may still clear §165(c)(2) and yield a deductible loss —
   just not an ordinary §988 one. The model drives both from a single
   `deductibleFraction`. That simplification errs in one direction only — it
   **over-disallows, never over-deducts** — and it is exact at both ends (a
   rental-linked pool clears both tests; a purely personal one clears neither).

   The offset deposit is precisely where the gap opens. §988(e)(3) is weak for it: the
   provision asks about "expenses properly allocable to such transaction" and a deposit
   has no expenses — and an offset earns no interest by design
   ([[offset-earns-no-yield]]), which undercuts the §212 story exactly where you would
   want it strong. But §165(c)(2) is a different and easier question, since the deposit
   exists to reduce the carrying cost of an income-producing asset. So the honest
   position is that the *loss* may well be deductible even where §988 does not reach the
   transaction. **Unresolved, and worth advice before anyone relies on §8's numbers.**

   *Quijano does not settle it:* those taxpayers **conceded** the borrowing was
   "neither carried out by a trade or business nor entered into for profit" — §165(c)(1)
   and (2) — so the court never had to decide whether a residence-linked facility could
   clear the profit test.
2. **Should the two legs be integrated when they genuinely match?** §988(d) allows it
   but §988(d)(2)(B) demands identification, and Quijano says it must be contemporaneous.
   Probably "no, and that is the finding" — but it should be a recorded decision rather
   than an omission, because a reader will ask.
3. **What convention for lot consumption (G6) — ANSWERED 2026-08-08.**
   `§1.988-2(a)(2)(iii)(B)(1)` names FIFO, LIFO and pro-rata as reasonable methods and
   bars only systematic highest-basis-first. **Pro-rata is the incumbent** (it is what
   `fxBasisRate` already implements, exactly) and FIFO must earn the switch on the two
   measurements in §5 G6. The residual open item is not *which rule* but **whether the
   two measurements favour switching**, and that needs real transaction history.
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
| **2** | G3 offset acquisition rate + realization on disposition · G4 de minimis moved to this leg · UI authoring surface | **built** |
| **2b** | G9 foreign-currency bonds, per-holding, redemption path | **built** (sale-before-maturity remaining) |
| **—** | §11 `CASH ⇒ no capital gain` guard in `consumeHoldings` + `Holding` invariant | **built** |
| **—** | §11a invariant re-asserted at `_patchHolding`; `_unrealizedGainSplit` skips CASH; cash-interest reinvest raises basis | **built** |
| **—** | G10 personal share is **capital**, not ordinary §988 (§4) | **not built** — character-only, dormant on the live scenario |
| **3** | G5 lot ledger · G7 materiality gate (FIFO-only) · G8 income-side acquisition | **specified, not scheduled** |
| **3** | G11 per-account pools + basis carryover on transfer (§5) | **specified** — decide before G5 is written |
| **3** | G12 §988(e)(3)(B) tax carve-out; needs a per-disposition fraction (§5) | **specified**, blocked on G5 |
| **—** | G6 consumption convention | **answered** — pro-rata incumbent (§5 G6, §8 Q3) |
| **—** | ingest + validation of real history (`scripts/tax/section988-ingest.mjs`) | **built** — §12; computes no tax by design |
| **—** | §13 observed-data replay overlay | **sketch only**, successor design |

**Not a dependency, and not a dependent: design 90 §4.5** (§904 basket sourcing of capital
losses). It was considered as a candidate to fold into Phase 3, because both are about a
carried-forward quantity keeping a tag, and G11 states that rule for basis. They share no code
surface: Phase 3 is §988 **basis** on nonfunctional currency, §4.5 is §904 **source** on §1212
carryovers, and §988 gain is ordinary general-basket income that never reaches the capital-loss
pools. **Neither blocks the other; do not sequence them together.** Recorded here because the
question is a natural one to ask twice.

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
`blendCurrencyBasisRate` maintains going forward. *As of 2026-08-08 this has a name:*
it is the **pro rata method** of `§1.988-2(a)(2)(iii)(B)(1)`, expressed as a rate rather
than as a dollar aggregate. See §5 G6 — what looked like an implementation convenience
turns out to be one of the three conventions the regulation names. Two common cases:

- **Converted from USD.** The rate on the conversion date(s). Directly observable.
- **Earned in Australia and never converted.** AUD wages are included in income
  translated at the spot rate on the day earned, and that translated amount *is* the
  basis. So the pool's rate is roughly the average AUD/USD over the accumulation
  period, not today's rate. Authoring today's rate understates the position.

A pool whose history is genuinely unknown should be left null: the model will stamp it
and recognize nothing, which is the honest answer rather than a fabricated one.

**Phase 3's G5 lot ledger is what removes this authoring burden** — with per-lot basis
the rate stops being a single authored scalar and becomes an accumulated fact. That is
the strongest argument for eventually building it, and note it is an argument for **G5
alone**: deriving a pro-rata rate from real history needs the history just as much as
FIFO does. G5 does not commit you to G6's answer.

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

### 11a. The drift came back — the constructor is not a choke point

Added 2026-08-10. Fix 2 above ends with *"alone it would be insufficient — data can
drift again"*. It did, immediately, and for a reason the original write-up did not name:
**a holding's life is spent inside reducers that patch plain records, and none of them
re-enter the `Holding` constructor.** The constructor establishes the invariant at birth
and never again. Two reducer paths reopened the gap:

| path | how it drifted |
|---|---|
| `HoldingTransactReducer` | the design-60 money-market stream reinvested a CASH sleeve's interest with `costBasisDelta: 0` — copied from the reinvested-dividend convention, where basis *is* raised, just at the account level |
| `HoldingRevalueReducer` | a shock marks CASH down with the rest of the account and leaves `costBasis` where it was |

Measured on the default scenario at `simEnd`: the brokerage CASH sleeve had grown to
\$28,727 against a frozen \$24,000 basis — a **\$4,727 phantom unrealized gain**, all of
it compounded interest that had already been taxed as ordinary income when it accrued.

**Where it surfaced.** Not in tax: all *five* disposal emitters are safe. `consumeHoldings`
and the rebalancer carry the explicit guard; `stock-harvest-apply-reducer` computes
`consume − basisShare`, which is exactly zero once the invariant holds. The damage was in
the derived metric — `_unrealizedGainSplit` (`after-tax.js`) summed `marketValue − costBasis`
over *all* holdings and priced the gap as embedded CGT. `computeAfterTaxNetWorth` feeds
the optimizer and MPC objectives, so **the error sat inside a control loop**. Secondarily,
`basisRatio` / `unrealizedGain` in `holdings-selection` read the same stale basis as HIFO
sort keys; inert today only because CASH already sorts first, and a trap for the next
drawdown-ordering change.

**Fixed on both sides, again independently:**

1. **`applyCashBasisInvariant` (holding.js), applied at `_patchHolding`** — the single
   write choke point for Transact / Revalue / SetBasis / Retitle, plus the split
   reducer's replacements (the one path that mints holdings without the constructor).
   Enforcing it there rather than per-reducer means a *new* reducer cannot reopen the
   gap, and reading the **patched** allocation means a Retitle into CASH heals the lot on
   the way in. `holding-utils`' proportional scaling needs no change: scaling `mv` and
   `cb` by the same factor preserves `cb === mv` once it is true.
2. **`_unrealizedGainSplit` skips CASH** — the metric-side mirror of the guard the
   disposal paths already carry, correct regardless of what the data says.
3. **`computeHoldingsCashInterest` credits `costBasisDelta: interest`**, so the action
   itself is honest rather than repaired downstream. This shelters nothing: the interest
   is ordinary income at accrual, and there is no capital gain on cash to shelter.

Three golden fixtures moved, each on exactly one field — a CASH lot's `costBasis`
snapping to its `marketValue`. Nothing else in the whole-state diff changed.

> **Regression note.** `EVT-CASH-INT-8` walks every CASH holding in every account after a
> full run and asserts `costBasis === marketValue`. The `after-tax` test pairs the CASH
> case with a **working-detector control**: an EQUITY lot with byte-identical numbers
> must still be discounted, or the test passes just as well against a metric that
> discounts nothing at all — §7 trap 5 again.

---

## 12. The regulations — what they changed, and how to get them

Added 2026-08-08. Phases 1–2b were designed and built against **the statute alone**,
because `§1.988-1` and `§1.988-2` were not on disk and
[[never-quote-tax-law-not-on-disk]] forbids citing what has not been read. That was the
right discipline and it still left three errors in this doc, all in the same direction:
**the statute reads far broader than the regime actually is.**

### On disk

| file | contents |
|---|---|
| `docs/us-tax/CFR-26-1.988-1-Definitions-Special-Rules.txt` | definitions; **(a)(9)** the individual exception; **(d)** spot rate |
| `docs/us-tax/CFR-26-1.988-2-Recognition-Computation.txt` | **(a)(1)(iii)** non-recognition list; **(a)(2)** computation, amount realized, **(a)(2)(iii)(B)** basis method |

**How to fetch them** — this cost time and is worth recording, cf.
[[tax-authority-sites-block-fetch]]. `WebFetch` on `ecfr.gov` 302s to
`unblock.federalregister.gov` and fails; the govinfo CFR volume URLs 404 because the
volume number for a given section is not guessable. What works is the eCFR **renderer
API** via `curl`, then strip the HTML:

```
https://www.ecfr.gov/api/renderer/v1/content/enhanced/current/title-26?chapter=I&part=1&section=1.988-2
```

### The three corrections

| # | this doc used to say | the regulation says | where |
|---|---|---|---|
| 1 | "every debit … is a realization event" | withdrawals and same-currency transfers are **non-recognition** with carryover basis; realization waits for a disposition | §1a — `§1.988-2(a)(1)(iii)` |
| 2 | personal share = §988 gain relieved by a \$200 de minimis | a personal transaction is **not a §988 transaction at all**; what survives is **capital**, and \$200 excludes it from the whole subtitle | §4, gap G10 — `§1.988-1(a)(9)` |
| 3 | "the regulations give individuals **no clear rule**… practice is split" | FIFO, LIFO and pro-rata are **named**; only systematic highest-basis-first is barred; consistency across all accounts and years | §5 G6, §8 Q3 — `§1.988-2(a)(2)(iii)(B)(1)` |

Only #2 is a code defect, and it is character-only and dormant on the live scenario.
#1 was a *prose* error the code happened not to share — the three callers of
`realizeCurrencyDisposition` are all genuine dispositions — but it would have propagated
into G5. #3 turned an open question into a decision, and reversed which way it leans.

### Spot rates — the source question, now settled

`§1.988-1(d)(1)` names acceptable sources explicitly: rates published by the **Federal
Reserve** under 31 U.S.C. 5151 (the H.10 release), the IMF's *International Financial
Statistics*, "newspapers, financial journals or other daily financial news sources", and
electronic financial news services. `(d)(2)` lets the Service pick the rate if
inconsistent sources distort income — so **one source, every date, no mixing**.

Two traps:

- **`(d)(3)`'s quarterly convention is not available here.** It is confined to *payables
  and receivables incurred in the ordinary course of business* for goods or services. A
  household currency pool gets no such relief, so a real-history calculation needs
  **daily** rates, not annual averages.
- **The model's `effectiveExchangeRates.USD_AUD` is a simulated path, not a published
  rate.** That is correct for projection and wrong for anything that has to reconcile to
  a filed return. A history-based calculation must source H.10 and say so.

### What this opens

The natural next step is a **history-based calculation from real transaction data**,
separate from the simulator: build lots from actual credits, classify each debit into the
four kinds of §1a, price dispositions at H.10 daily rates, and split the result into
ordinary / capital-LT / capital-ST / disallowed. That is G5's ledger applied to the past
rather than the future, and it is what would supply both §10's authoring value and the
two measurements G6 needs.

**The hard part is not the arithmetic.** A FIFO or pro-rata engine is small and will be
right the first time. A transaction export **cannot tell you what each debit bought**,
and that is what decides whether it is a disposition at all (§1a) and, if so, whether it
is ordinary or capital (§4). The work is a payee/description classification table
producing `(kind, businessFraction)` per row, with an unclassified bucket that fails
loudly rather than defaulting. Note `businessFraction` is **live state read per
transaction** — a property that stops renting flips its subsequent payments to personal,
per §4's trap.

> Anything built on real account data belongs outside `design/` —
> [[design-docs-are-public]]. This section describes the method; the numbers do not
> go here.

---

## 12.5. What a real-world-shaped scenario needs — and what exists

Running the ingest tool over a decade of real history was the first time this design met
a full-fidelity example rather than a constructed one. The shape it found is worth
recording, because it is the shape the model has to be able to represent:

> An AUD offset/transaction account attached to **one** income-producing property, with
> AU wages and short-let rental income flowing in continuously, mortgage interest and
> property expenses flowing out, mixed-use credit-card payments, periodic AUD→USD
> conversions through an FX broker, and same-currency sweeps to and from several other
> AUD deposit accounts.

Mapping that onto this design:

| the scenario needs | status |
|---|---|
| conversions realize §988 with no offsetting leg | **built** — phase 1 (G1, G2) |
| a mortgage serviced from a same-currency pool, both legs | **built** — phase 2 (G3) + design 86 P8 |
| source follows the tax home, flipping at the move year | **built** — §6 |
| income *acquiring* basis at the day's rate | **G8, not built.** Today the balance grows without the pool's basis rate following it |
| a **per-disposition** use fraction, not a per-account scalar | **G5 + G12, not built.** One account here is simultaneously §212 (property expenses), personal (household), and carved-out (tax payments) |
| personal share as **capital**, with a holding period | **G10, not built** |
| same-currency sweeps carrying basis between accounts | **G11, not built** |
| a **published** rate per transaction date | **built, outside the engine** — `rates/`, deliberately not `effectiveExchangeRates` |

**The honest summary: the engine can model the *structure* today but not the
*heterogeneity*.** Everything unbuilt above is a variant of one thing — the model
carries a single scalar (`fxBasisRate`, `deductibleFraction`) per account where reality
carries a distribution per transaction. That is a fair simplification for projecting a
future, because a projected account genuinely is homogeneous. It stops being fair the
moment the account is real.

**So the two uses want different machinery, and this is the finding that motivates §13.**
Projecting forward wants the scalar: cheap, and no worse than the assumptions around it.
Reconstructing a past wants the ledger. Building the ledger *into* the engine to serve
the second use would slow down the first for no gain — which is the argument for keeping
the reconstruction outside and letting its **output** flow in.

---

## 13. Observed-data replay — sketch, not a specification

Grew out of §12: once real transactions, real published FX and a real basis history are
sitting on disk, the question "could a run *use* these?" answers itself. This section is
ideas, deliberately at sketch altitude. Nothing here is decided.

> **Name collision, flagged early.** [[design-81-run-as-replayable-artifact]] already
> uses "replay" for re-running a simulation's **own recorded output** — playback and
> branch, to avoid recomputing a whole run. This is a different thing wearing the same
> word: substituting **externally observed data** for what the model would have
> generated. If both get built they need distinct names, and the codebase has been
> bitten by exactly this before ([[design-60-collision-renumbered-79]]). Suggest
> *playback* for 81 and *observation overlay* for this.

### 13.1 The non-negotiable: absence must change nothing

A run with no overlay must be a **valid run**, not a degraded one. That is the whole
design constraint and everything below bends to it. Concretely:

- Overlay data is **additive configuration**, never a required input. No golden fixture,
  no unit test and no MC arm may depend on a file of real transactions —
  [[golden-fixture-harness]] stays data-free.
- An overlay with **no coverage** for a date must not silently mean zero. This is §7
  trap 5 wearing new clothes, and it is how the debt leg was mis-verified once already.
  Every source declares a coverage window and an explicit out-of-window behaviour
  (*fall through to the model* or *fail*), chosen per source and recorded.
- Any overlay arm needs a **working-detector control**: an otherwise identical run with
  the overlay off, proving the overlay moved something.

### 13.2 Three kinds of substitution, and only two are safe

The single most useful distinction here. They are not variations on a theme:

| kind | example | what substitution means | risk |
|---|---|---|---|
| **exogenous series** | FX, published interest rates, CPI, market returns | pin a path the model would have sampled | **low** — the model already treats these as given |
| **opening state** | balances, cost basis, `fxBasisRate`, lot ledgers | seed, not a path | **low** — it is authoring, just sourced from data |
| **endogenous events** | wages, spending, transfers, conversions | override what the model *decides* | **high** — the run can go internally inconsistent |

Endogenous substitution is where this gets dangerous: replayed spending that the drawdown
logic did not choose can leave the model solvent on paper while the real account was
overdrawn, or vice versa. It is not forbidden, but it should be the last thing built and
the first thing suspected.

**The rule that falls out of the table, and the strongest reason to want this at all:
substitute exogenous, compare endogenous.** Pin the observed FX path and the opening
state, let the model generate wages/spending/tax as it normally does, and diff its output
against what actually happened. That is a **backtest**, and it is the first thing that
would make this model falsifiable. Substitute the endogenous events too and you have
merely built a reconciliation — useful for tax figures, worthless as validation, because
you have replaced the thing you wanted to test.

### 13.3 Where the seams already are

Encouragingly, most of this is a wiring exercise rather than new machinery:

- **FX** — `effectiveExchangeRates.USD_AUD` is already a single choke point every consumer
  reads, and `rates/DEXUSAL-daily.csv` is already a pinned published series with a
  documented carry-forward rule. This is the cheapest possible first overlay.
- **Opening state** — `fxBasisRate` is *exactly* what the ingest tool computes. §10's
  authoring burden ("author the real rate, and if you cannot, leave it null and
  understate") becomes "derive it from history". This is the highest value per unit of
  work in the whole section.
- **Dated events** — the event queue already orders by date then `order`
  ([[event-queue-date-only-ordering]]), so injecting dated observations is a matter of
  choosing an `order` band, not restructuring anything.
- **Provenance** — the journal already carries per-action payloads, so an `observed: true`
  flag on overlaid values costs almost nothing and buys the ability for a report to say
  *this figure is measured, that one is modelled*. Without it a mixed run's output is
  uninterpretable, and someone will quote a modelled number as though it were observed.

### 13.4 Traps this codebase has already paid for

- **The RNG is shared** ([[rng-shared-by-all-stochastic-consumers]]). If an overlay stops
  FX from being *sampled*, every downstream draw shifts and the overlay arm is no longer
  comparable to its control — the difference is contaminated by re-sequencing rather than
  by the data. The overlay must **consume and discard** the draw it replaces, or each
  consumer needs its own stream. This is subtle, silent, and would invalidate every
  comparison made before someone noticed.
- **Granularity is not free.** A transaction file is daily; the engine steps in periods.
  Aggregating dispositions to a period **changes the §988 answer** — each disposition
  carries its own rate, its own holding period and its own \$200 test, none of which
  survive being summed. That argues strongly for computing §988 in the ingest tool and
  overlaying the **result**, not the raw transactions. Overlay at the altitude the answer
  lives at.
- **The historical/projection boundary** is a discontinuity waiting to happen. A run that
  replays to date *T* and projects after it must hand over consistent state at *T*; a
  balance that jumps there is the classic failure. Worth an explicit invariant check.
- **Real data revises.** `rates/README.md` already records that FRED restates history.
  An overlay makes a run's output a function of a file that changes underneath it, so an
  overlaid run needs its sources' versions pinned in the output or it is not reproducible
  — which is the one property [[sim-is-bit-deterministic]] currently guarantees.

### 13.5 Anti-goals

- **Not an ETL framework.** Two or three high-leverage series, hand-fed. The moment it
  grows a plugin architecture it has eaten the project.
- **Not a bookkeeping system.** It reconstructs enough to compute a tax figure and to
  seed a projection. It is not trying to be the source of truth for the accounts.
- **Not a default.** If an overlay ever becomes the normal way to run the model, the
  model has quietly acquired a dependency on private data, and nobody can run the test
  suite. The synthetic path stays first-class.

### 13.6 If it gets built, the order that de-risks it

1. **Opening-state overlay only** — seed `fxBasisRate` from the ingest output. No path,
   no boundary, no RNG interaction. Immediately retires §10's authoring guess.
2. **Published FX overlay**, with the discard-the-draw fix and a working-detector control.
3. **The backtest** — pin FX and opening state, project the known window, diff against
   observed. The first falsifiable thing here, and the deliverable that justifies the rest.
4. **Endogenous event overlay** — only if 3 shows a gap that only real events can close,
   and with the internal-consistency risk stated up front.
