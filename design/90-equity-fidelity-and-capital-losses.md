# 90 — Equity fidelity and capital losses

**Status** (2026-08-10): **PROPOSED.** No code written.

Two asks arrived separately and turn out to be one piece of work:

1. **Capital losses are floored to zero at every disposal site**, and no capital-loss
   carryforward exists. Every disposal computes `gain = Math.max(0, proceeds − basis)`, so a
   sale below basis books zero and the loss is discarded.
2. **Equity needs market-level modelling** — US, international ex-US, international ex-AU, AU
   — each with its own growth rate.

§1 is the argument that these are one document. The short version: **a capital loss only
exists when sleeves diverge, and today they structurally cannot.** Building the tax machinery
on the current return model produces correct code that almost never fires.

This doc also absorbs **AU franked dividends**, specified in design 76 §8 and still open,
because franking is the entire reason to hold AU equity and §7 is about to make AU equity an
allocable sleeve.

---

## 1. Why this is one document, not three

### 1.1 The measurement

Reported in the originating ticket: across **1,400+ disposals in a 44-year cross-border run,
zero booked a negative gain** — in a run that includes a −40% equity shock.

The floor at the disposal sites explains why no loss was *recorded*. It does not explain why
this would change once the floor is removed. That answer is in the return model.

**Re-measured after step 2 landed** (the floors are gone; nothing nets them yet), on a 44-year
reference plan carrying 5,646 disposals:

| | count | share |
|---|---:|---:|
| Disposals booking a net **gain** | 1,788 | 31.7% |
| Disposals booking a net **loss** | **264** | 4.7% |
| Disposals carrying **short-term** character | 12 | 0.2% |

So losses now exist — 264 of them where there were none. But their aggregate is **0.006% of
gross realized gains**: three and a half orders of magnitude too small to move a tax bill.

That is §1.2 measured rather than argued. The floor was never the binding constraint; the
return model is. It also sizes the ST/LT split honestly for a buy-and-hold plan — 12 rows in
5,646 — which is not a reason to skip it (§1212(b) is inexpressible without it, and harvesting
is what makes short-term character common) but is a reason not to expect step 3 to move
anything on its own.

### 1.2 Equity sleeves cannot diverge, by construction

`EquityReturnTickHandler.call` (`equity-return-tick-handler.js:84`) draws **one** market factor
per tick and gives every sleeve `beta × marketDev`. The per-sleeve idiosyncratic term is
optional and `idioVol` defaults to `{}` — absent ⇒ 0 — and when it is 0 the draw is *skipped
entirely* rather than drawn and multiplied by zero.

So on default configuration every equity sleeve is the **same random variable scaled by a
positive constant**. Sleeves cannot move in opposite directions. There is no state of the world
in which a US sleeve is below basis while another US sleeve is above it, beyond what the
different purchase dates of their lots produce.

That is the real reason the ticket found no losses, and removing the floor does not fix it. It
also means the design 39 §13 MPC harvest lever is being evaluated against a model that cannot
represent either half of what it does: it cannot represent the loss, and it cannot represent a
substitute holding that is genuinely different from what was sold.

### 1.3 What market sleeves buy the tax work

Real dispersion — US up while international is down — is what generates a harvestable loss in a
portfolio that is not, in aggregate, losing money. It is also what makes
`resolveSubstitute` (`tax-loss-harvest-handler.js`) mean something: "sell US, buy
international" is a strategy a person actually runs, and "sell a sleeve and rebuy the same
sleeve" is a wash sale wearing a disguise.

**Consequence for sequencing:** the loss machinery can be *built* first (it is well-specified
and independently correct), but it cannot be *measured* until §7 lands. Do not tune anything
against loss numbers taken before then.

### 1.4 The RNG-cursor worry was overstated — correcting an earlier read

`EQUITY_SLEEVES` (`rate-keys.js:106`) carries a ⚠️ in its docstring: the tick handler iterates
it to draw idiosyncratic terms, so changing the list shifts every subsequent draw.

**That warning is conditional, and the condition is false by default.** The single market draw
happens *before* the loop; the loop draws only when `idioVol[sleeve] > 0`, and skips otherwise.
With idio vol at its default of 0 across the board, **the loop consumes no uniforms at all and
the membership of `EQUITY_SLEEVES` is RNG-irrelevant**.

So re-shaping the sleeve list is safe for every scenario that has not opted into idiosyncratic
vol. This materially de-risks §7 — it does not need a cursor-migration story, it needs a
**guard**: a test asserting that the sleeve loop draws zero uniforms when all idio vols are 0,
so the property this relies on cannot be quietly lost. Scenarios that *do* set `idioVol` will
re-base, and that is unavoidable and correct.

---

## 2. The primary sources

Per project convention, nothing below is stated from memory. Everything is on disk.

### 2.1 United States — fetched for this design

| Source | Path |
|---|---|
| IRC §1211 — Limitation on capital losses | `docs/us-tax/USCODE-2024-title26-subtitleA-chap1-subchapP-partII-sec1211.txt` |
| IRC §1212 — Capital loss carrybacks and carryovers | `docs/us-tax/USCODE-2024-title26-subtitleA-chap1-subchapP-partII-sec1212.txt` |
| IRC §1222 — Other terms relating to capital gains and losses | `docs/us-tax/USCODE-2024-title26-subtitleA-chap1-subchapP-partIII-sec1222.txt` |
| 26 CFR 1.1411-4 — Definition of net investment income | `docs/us-tax/CFR-26-1.1411-4-Net-Investment-Income.txt` |

US Code 2024 edition, from the Government Publishing Office via govinfo.gov. The regulation is
the eCFR text current as of 2026-01-01 (govinfo's CFR volumes 302-redirect for this section;
the eCFR versioner API serves it).

**§1211(b)**, verbatim:

> In the case of a taxpayer other than a corporation, losses from sales or exchanges of capital
> assets shall be allowed only to the extent of the gains from such sales or exchanges, plus (if
> such losses exceed such gains) the lower of—
> (1) \$3,000 (\$1,500 in the case of a married individual filing a separate return), or
> (2) the excess of such losses over such gains.

**§1212(b)(1)**, verbatim:

> If a taxpayer other than a corporation has a net capital loss for any taxable year—
> (A) the excess of the net short-term capital loss over the net long-term capital gain for
> such year shall be a short-term capital loss in the succeeding taxable year, and
> (B) the excess of the net long-term capital loss over the net short-term capital gain for
> such year shall be a long-term capital loss in the succeeding taxable year.

Note what (A) and (B) require: the carryforward is **not one pool**. Short-term and long-term
losses carry forward *separately*, each netted against the other character's gain first. This
is the single strongest argument for building the short/long split rather than collapsing it —
§1212(b) is not expressible without it.

**§1222(1)–(4)** defines the character by holding period: "not more than 1 year" is
short-term, "more than 1 year" is long-term. §1222(9) defines "capital gain net income" and
(10) "net capital loss" as the excess of losses over the sum allowed under §1211.

**The \$3,000 is statutory and has never been indexed.** The amendment history in the §1211
file runs to 1986 and the figure has stood since Pub. L. 94–455 (1976) set the "applicable
amount" mechanism, fixed at \$3,000 from 1978. It must be **excluded from the bracket-inflation
wrapper**. Over a 44-year horizon its real value decays to near-nothing — that is the correct
behaviour, and inflating it would invent relief Congress has not granted.

### 2.2 Australia — already on disk

Income Tax Assessment Act 1997, Compilation No. 266, compilation date 01/07/2026, in
`docs/au-tax/ITAA-1997/C2026C00324VOL03.txt`.

| Provision | Line |
|---|---|
| s102-5 — Assessable income includes net capital gain (the method statement) | 8844 |
| s102-10 — How to work out your net capital loss | 9165 |
| s102-15 — How to apply net capital losses | 9181 |

**s102-5(1) settles the ordering question the ticket raised.** The method statement, in order:

> **Step 1.** Reduce the \*capital gains you made during the income year by the \*capital losses
> (if any) you made during the income year …
> **Step 2.** Apply any previously unapplied \*net capital losses from earlier income years to
> further reduce the amounts (if any) remaining after the reduction of \*capital gains under
> step 1. …
> **Step 5.** Reduce by the \*discount percentage each amount of any \*discount capital gain
> remaining after the application of steps 1 to 4.

Current-year losses **and** carried-forward losses both come off the **gross** gain, before
Division 115. Applying the discount first would halve the gain and then let the loss eat the
halved figure, wasting half of every loss. The difference is material and it runs one way.

> **On the step numbering.** This compilation includes the design 57 CGT reform commencing
> 1 July 2027, which inserted the deferred/residential categories as Steps 3–4 and pushed the
> discount from Step 3 to Step 5. For a pre-2027 gain those categories are empty, so the
> ordering this design depends on — *losses before discount* — is identical under both. One
> citation covers both rate modules.

**s102-10(2)**, verbatim:

> You cannot deduct from your assessable income a \*net capital loss for any income year.

So an AU capital loss offsets **capital gains only**, never ordinary income. This is the sharp
difference from the US, where §1211(b) allows \$3,000 against ordinary income. It also means the
AU capital-loss pool is a **different pool** from the existing Div 36 `auTaxLossPool` (design 86
G1), which *is* deducted from total assessable income. Merging them would let a capital loss
shelter wages, which s102-10(2) forbids in as many words.

**s102-15**: net capital losses "are applied in the order in which you made them" — FIFO by
loss year — and Note 1 points at s960-20(1) for the not-already-utilised condition. No expiry.

### 2.3 The franked-dividend provisions — all local, all findable

Everything §8 needs was already on disk; it had simply never been located. Recorded here so
the next reader does not re-derive it, and so §8 is not blocked on a download that is not
needed.

| Provision | File | Line |
|---|---|---|
| s207-20 — General rule: gross-up and tax offset | `ITAA-1997/C2026C00324VOL05.txt` | 5390 |
| s207-70 — Gross-up and tax offset under s207-20 | `ITAA-1997/C2026C00324VOL05.txt` | 6273 |
| s67-25 — Refundable tax offsets: franked distributions | `ITAA-1997/C2026C00324VOL02.txt` | 23947 |
| "qualified person" — the 45-day rule's operative test | `ITAA-1997/C2026C00324VOL05.txt` | 7455, 7573, 11785 |
| "qualified person" — the ITAA 1936 definition it leans on | `ITAA-1936/C2026C00333VOL02.txt` | 753, 1335 |

Design 76 §8's small-shareholder threshold — "believed A\$5,000 — **verify against the
authority**" — is still unverified. It must be read out of the sections above before §8 quotes
it, per `never-quote-tax-law-not-on-disk`. Everything needed to do so is local.

---

## 3. The seam: `consumeHoldings` already does most of this

The temptation is to write a new loss ledger. That would be the third implementation of a
pattern the codebase already has twice — design 87 §5 makes exactly this observation about its
own G5 lot ledger ("this is a pattern to copy, not to invent", citing `Holding.costBasis` and
design 84 G9's rollover ledger).

For equities the ledger **already exists and is already lot-based**. `consumeHoldings`
(`holdings-fifo.js:86`) walks lots under a selection policy and, per lot, computes:

- a basis share, and a per-country basis share from `costBaseByCountry`;
- a **holding-period test** — `held12mo`, measured from
  `acquisitionDateByCountry[country] ?? purchaseDate`;
- a **gain tally split by that test**, into `realizedDiscountableGainByCountry`.

That is a per-lot, per-country, holding-period-gated gain split. It is exactly the computation
the US short/long classification needs. It is currently unavailable for that purpose for two
reasons, both incidental:

1. **It is gated behind the AU indexation context.** The whole block sits inside
   `if (idxCountry)`, where `idxCountry = indexation?.country`. A caller that wants a holding-
   period split and no CPI indexation has no way to ask for one.
2. **It is floored per lot**: `realizedDiscountableGainByCountry[idxCountry] += Math.max(0, take − idxBasisShare)`.
   The loss is discarded at the innermost level, before any caller sees it.

### 3.1 The change

Lift the holding-period split out of the indexation gate and make the tally **signed**, keyed by
country and by character:

```
realizedGainByCountryAndTerm: {
  US: { short: <signed>, long: <signed> },
  AU: { short: <signed>, long: <signed> },
}
```

One generalisation, three consumers:

- **AU Division 115** reads the `long` bucket for discount eligibility — the ≥12-month test it
  already performs, now expressed once instead of inline.
- **US §1222** reads `short` / `long` for character.
- **The loss ledger** reads the sign.

**Per-lot signing is load-bearing, not a detail.** Character is a property of the *lot*, not of
the account. A disposal that consumes one lot held 8 months at a loss and one held 8 years at a
gain is a short-term loss and a long-term gain — netted at the account level first, it becomes a
single mis-charactered number and §1212(b)(1)(A)/(B) can no longer be computed. Tally per lot,
net later.

**Backward compatibility.** Callers that pass no new option must be byte-identical. The
existing `realizedDiscountableGainByCountry` stays, computed from the new signed tally, until
every caller has moved.

### 3.2 What this hands design 87

Design 87 G6 concluded that pro-rata is the incumbent for currency pools and that "what FIFO
buys, and it is exactly one thing: **a holding period**", which its G10 capital branch needs and
a scalar cannot supply. The equity path already has that holding period; after §3.1 it will
expose it as a first-class, signed, per-character result. If G5's lot ledger is ever built, this
is the shape to match — and §3.1 should be reviewed against design 87 §5 before it is written,
so the two ledgers do not diverge the way the five disposal emitters did.

---

## 4. Capital losses — United States  ✅ BUILT (step 3)

**Implementation record.** `_computeCapitalLossLimitation` (`us-tax-rates-base.js`), the
two pools on `IntlRetirementState`, `characterizeCapitalGain`
(`tax/capital-gain-character.js`) at six classifier sites, the settle write-back, and the
four worksheet lines. Tests: `tests/unit/capital-loss-netting-us.test.mjs` (21).

**What it moved: nothing measurable, as predicted.** The golden re-gold diff is two new
fields at `0` and not one other value — no balance, no tax, no net worth. On the 44-year
reference plan both pools end **empty**, because every year's losses are fully absorbed by
that same year's gains and a net capital loss never forms. §1.1 sized this in advance:
losses are 0.006% of gross gains, so there is nothing for §1211(b) or §1212(b) to bite on
until §7 lands.

That is why `capital-loss-netting-us.test.mjs` is written as the **working-detector
control** §10 demands, with losses constructed large enough that a pool written-but-never-read
cannot pass. Judging this step by its golden diff would be judging it by a measurement that
was always going to read zero.



### 4.1 State

Two carryforward pools, per §1212(b)(1)(A) and (B):

- `usShortTermCapitalLossCarryforward`
- `usLongTermCapitalLossCarryforward`

and two signed YTD accumulators alongside the existing `usCapitalGainsYTD`.

`usCapitalGainsYTD` currently means "long-term capital gain, floored at the settle"
(`us-tax-rates-base.js:212`: `const cg = Math.max(0, usCapitalGainsYTD)`). It becomes the signed
long-term figure, with a new signed `usShortTermCapitalGainsYTD` beside it.

### 4.2 Computation, in §1211/§1212 order

1. Net within character (§1222(5)–(8)): net short-term result, net long-term result.
2. Apply each pool to its own character's gain first, then across (§1212(b)(1)).
3. Combine. A positive long-term residue stacks in the §1(h) LTCG brackets as today; a positive
   short-term residue is taxed at **ordinary** rates — a new behaviour, and the reason the
   split is not free.
4. If the combined result is a net loss, allow the lower of \$3,000 and the excess against
   ordinary income (§1211(b)), as an above-the-line deduction — the same entry point
   `usNegativeIncomeYTD` and `usSection988LossYTD` already use, which `us-tax-rates-base.js:166`
   documents as the pair that keeps the Form 1116 identity exact.
5. Carry the remainder forward, by character.

### 4.3 The reset allowlist

The pools must survive `US_TAX_SETTLE_APPLY`. `YTD_FIELDS.US` in `tax-settle-classes.js:31` is
the allowlist; the two pools are **deliberately excluded**, and the exclusion needs a comment
saying so, in the style the file already uses for `usPassiveLossCarryforward` and
`usInvestmentInterestCarryforward`.

Follow the §469 precedent exactly (`tax-settle-classes.js:424`). `computeTax` is **pure** and is
re-run on the US-source-removed counterfactual that sizes the FITO limit (design 52 §4.5, design
83 G8). It must therefore *report* a closing balance rather than draw the pool down in place,
and `_extraStatePatches` owns the write-back on the real pass only. Drawing down inside
`computeTax` would let the counterfactual consume the pool and then hand the real pass an
already-spent balance.

### 4.4 Two interactions to settle before building

- **NIIT (§1411) — settled by the regulation, and the current floor is half right.**
  `us-tax-rates-base.js:257` builds the NII base as `max(0, nii + cg + collectibles + unrecap1250)`
  with `cg` pre-floored. `26 CFR 1.1411-4(d)(2)` says, verbatim:

  > The calculation of net gain may not be less than zero. Losses allowable under section 1211(b)
  > are permitted to offset gain from the disposition of assets other than capital assets that
  > are subject to section 1411.

  So there are **two** rules where the model has one:

  1. **Net gain floors at zero.** The existing `Math.max(0, …)` on the gain component is correct
     and stays. A net capital loss does not drive the NII base negative.
  2. **The §1211(b) allowance is separately deductible against other NII** — via
     `(f)(4)(i)`, "the amount of losses that were allowable under chapter 1 in excess of the
     amounts taken into account in computing net gain". The model has no equivalent, so it
     currently **overstates** NII in a loss year by up to the \$3,000 allowance.

  The regulation's Example 1 also confirms the carryforward flows through: a §1212(b) carryover
  used in a later year reduces that year's net gain for §1411 purposes too, not only for
  chapter 1. So the pools must feed the NII computation, not just the income-tax computation.

  Note the floor is applied **to the gain component**, not to the sum. Flooring `cg` alone (as
  today) and flooring the whole base are the same only while `nii ≥ 0`; keep the two floors
  distinct so a future negative NII component cannot be silently rescued by a gain.
- **§904 numerators.** A loss on foreign-source personal property reduces the foreign passive
  basket numerator and therefore the FTC limit. The gain currently books to
  `foreignPassiveIncomeYTD` or `usSourceCapGainsUsdYTD` depending on the §865(g)(2) test
  (design 83 G10). Letting a signed figure flow through unchanged is *probably* right and is
  certainly better than flooring, but it interacts with the design 83 partition invariants.
  Build it, then run those invariants — they caught a partition violation once already.

---

## 5. Capital losses — Australia  ✅ BUILT (step 4)

**Implementation record.** `AuTaxRatesBase._applyCapitalLosses` runs s102-5 Steps 1–2 and
hands `_cgtRelief` a state whose gain figures are already net — so neither rate module
(the flat-discount one or the FY2027 indexation override) has to know capital losses
exist. `characterizeAuCapitalGain` signs six classifier sites;
`auPersonCapitalLossPool` is written beside the Div 36 pool in `_auLossPoolPatch` and
sliced per person in `tax-settle-service`. Tests:
`tests/unit/capital-loss-netting-au.test.mjs` (15).

**Two things this got wrong first and are worth not repeating.**

- **Materializing `auDiscountableGainsYTD` for `_cgtRelief` destroyed its old-save
  fallback.** That method has always read an ABSENT key as "all of it qualifies";
  once `_applyCapitalLosses` always supplied the key, a default of 0 silently withdrew
  the Division 115 discount from every synthetic state. The rule now lives in both
  places. Four rate tests caught it, which is the only reason it is a paragraph here
  rather than a defect.
- **Scaling the FY2027 real gain by the nominal reduction ratio masked a different
  design's invariant.** A ratio couples the real bucket to *every* reduction in the
  nominal figure — including the FITO counterfactual, which strips US-source gain from
  the nominal bucket and relies on the separate `usSourceRealCapGainsAudYTD` signal to
  strip the real one. Under a ratio the real bucket shrinks on its own and papers over a
  missing signal, which is the design 57 Part 2 D defect `FITO-D` exists to detect. The
  loss is now subtracted as an absolute amount, keeping the two reductions independent.

**Golden movement:** the two new pool fields at `0`, plus `auCgtEffectiveRate` in its
12th significant figure — cent-quantization from routing the gain through the netting,
which is the granularity a tax return uses anyway. No balance moved.



### 5.1 State

`auPersonCapitalLossPool` — **per person**, not a household scalar.

This follows the Div 36 precedent verbatim and for the stated reason. `tax-settle-service.js:293`
carries the comment: "NOT a perPersonShare: there is no household scalar to split, because a
carried-forward loss belongs to one taxpayer and splitting it would let one spouse's loss
shelter the other's income." Identical logic, identical shape.

It is a **separate field** from `auPersonTaxLossPool`. s102-10(2) is the reason (§2.2).

### 5.2 Computation, in s102-5 order

Within `_cgtRelief` (`au-tax-rates-base.js:138`), which already owns the discount and already
receives the state:

1. **Step 1** — reduce current-year gross gains by current-year gross losses.
2. **Step 2** — apply the pool, oldest loss year first (s102-15).
3. **Step 5** — apply the discount percentage to what remains of the *discountable* base.

Steps 1 and 2 operate on `auCapitalGainsYTD` and reduce `auDiscountableGainsYTD` alongside it;
the existing `auDiscountApportionedBaseYTD` / `auDiscountAllowanceYTD` pair (design 83 G7) must
be reduced consistently, or a loss will shrink the gain while leaving the apportioned relief
sized for the pre-loss figure.

### 5.3 Which gains the losses eat first — a decision, and it is worth money

s102-5(1) Step 1 Note 3:

> If you have more than one capital gain within a category mentioned in paragraph (a), (b), (c)
> or (d), you can choose the order in which you reduce them.

The Act hands the taxpayer the choice. **Apply losses against non-discountable gains first.**
A dollar of loss applied to a non-discount gain saves a full dollar of assessable income; applied
to a discount gain it saves fifty cents, because the discount would have halved that dollar
anyway. This is standard practice, it is what any agent preparing the return would do, and the
alternative is modelling a taxpayer who volunteers to waste half of every loss.

This is a **modelling choice the Act permits**, not a rule the Act imposes, so it is recorded
here rather than buried in code, and the implementation should name this section.

### 5.4 The reset allowlist

`PER_PERSON_AU_FIELDS` (`tax-settle-classes.js:69`) is reset per person at each AU settle, with
the dead-person filter above it. `auPersonCapitalLossPool` must **not** be in that list.

Note the death interaction: `tax-settle-classes.js:360` drops keys for deceased people from the
per-person reset maps. A capital loss pool does not transfer to a surviving spouse on death — it
dies with the taxpayer. Being excluded from the reset list is not sufficient to get that right;
the pool needs its own handling at death, and design 68 owns that path.

---

## 6. The short-term / long-term split

The model has no ST/LT distinction: `usCapitalGainsYTD` is taxed entirely at the §1(h) LTCG
rates. §1212(b) cannot be expressed without one (§2.1), so it is in scope.

**Scope of the change.** Every emitter must stamp the character, the tax module must tax
short-term at ordinary rates, and the NIIT and §904 numerators must take the combined figure.
`consumeHoldings` supplies the character for free after §3.1 — the holding-period test is
already computed per lot; only the date basis differs (US acquisition, `> 1 year` per §1222,
against AU's deemed-acquisition date and `≥ 12 months` for Div 115).

**The two tests are not the same test** and must not be collapsed:

| | US §1222 | AU Div 115 |
|---|---|---|
| Threshold | **more than** 1 year | **at least** 12 months |
| Measured from | acquisition | the **deemed** acquisition — the residency step-up date (design 62 §4, s855-45) |

A cross-border household disposing of a lot bought before a move and sold 13 months after it is
long-term for the US and ineligible for the AU discount. The per-country keying in §3.1 is what
keeps that straight.

### 6.1 Denser timelines

Recorded because it constrains the design, though nothing here builds toward it.

The intent is a future scenario and toolset running on minute- or hour-resolution events over a
few weeks. The lot machinery generalises to that cleanly: `purchaseDate` is a timestamp,
`consumeHoldings` is date-based, and the holding-period test is `(saleMs − acqMs) > YEAR_MS`.
None of it is period-indexed.

**The constraint this places on the work below:** do not introduce holding-period or loss
accounting that reads `state.currentPeriods[cc].startMs` as a *year boundary*. Read it as a
timestamp. The tax **settle** is legitimately annual and can stay period-indexed; the **lot and
character** machinery must not become so. This is cheap to honour now and expensive to unpick
later.

---

## 7. Market equity sleeves  ✅ BUILT (step 5 — keys and wiring; §7.4 still open)

**Implementation record.** The four market keys replace the six account-wrapper keys in
`rate-keys.js`; `MEMBER_RATE_KEY_BY_ROLE` and every earnings handler's `static rateKey`
point at markets; `RATE_KEY_CLASS_MEMBERS` is empty; betas and `EQUITY_SLEEVES` are
re-based. Guard: `tests/unit/equity-sleeve-rng-neutrality.test.mjs`.

**Behaviour is preserved exactly, and the golden proves it precisely.** 60 fields moved
and **every one of them is a rate-key rename inside `baseGrowthRates` /
`effectiveGrowthRates`** — no balance, no tax figure, no net worth. Each account kept its
own rate to the digit (`EQUITY_US_BROKERAGE::usStockAccount` 0.05 →
`EQUITY_US::usStockAccount` 0.05; `EQUITY_AU_SUPER::superAccount` 0.07 →
`EQUITY_AU::superAccount` 0.07).

### 7.5 The sequencing in §9 was wrong, and the code said so

§9 called step 5 "structural only". It is not, and could not have been, for a reason
worth recording: `collectBaseGrowthRates` seeded **genuinely different rates per account
wrapper** — brokerage 5%, AU stock 6%, Roth/IRA/401k/super 7%. A naive collapse onto one
`EQUITY_US` rate would have re-rated every US account in every scenario.

Those per-wrapper rates *are* the account-type proxy for asset mix that §7.1 says market
sleeves exist to replace — but they cannot retire until the §7.3 sub-axis can express the
same thing as a mix. So the migration route is not "replace", it is **"re-home"**: each
wrapper rate now seeds a per-ACCOUNT override (`<marketKey>::<stateKey>`) via
`collectRoleGrowthRates`, which is what it always was in substance. Precedence is
unchanged — account's own `growthRate`, then its role's rate, then the market's.

**Two latent defects this surfaced.**

- **The per-holding rate lookup ignored per-account seeding.** `computeHoldingsGrowth`
  resolved `ratesMap[h.rateKey]` before falling back to the account-level rate, so a
  holding carrying an explicit `rateKey` took the shared series. That was invisible while
  no equity series was seeded at the bare key — every equity holding missed and fell
  through to the per-account rate. The market axis seeds `EQUITY_US` as a real shared
  rate, at which point the bare-key hit starts winning and silently overrides every
  account's own growth rate with the market's. Now `<rateKey>::<stateKey>` first, matching
  the account-level precedence.
- **A phantom per-account-type key existed for accounts that did not exist.**
  `EQUITY_US_K401` was seeded from `k401GrowthRate` whether or not any 401k was in the
  scenario, and a test asserted against it. Per-ACCOUNT keys cannot do that.

### 7.6 What step 5 did NOT do

`idioVol` is still 0 everywhere, so the four sleeves remain a deterministic multiple of
one draw and **cannot cross**. Everything §1.2 says still holds: losses stay
structurally near-impossible, and the harvest lever stays unmeasurable. §7.4 — the
correlation structure — is the step that changes that, and it is the one that re-bases
every stochastic run.



### 7.1 The defect

`rate-keys.js:33` spends the equity granularity axis on the **account wrapper**:
`EQUITY_US_ROTH`, `EQUITY_US_IRA`, `EQUITY_US_K401`, `EQUITY_US_BROKERAGE`, `EQUITY_AU_STOCK`,
`EQUITY_AU_SUPER`. Each carries its own base growth rate and its own beta.

A Roth holding a US total-market fund and a Roth holding an international fund are the **same
sleeve**. A Super balance — which in reality is a diversified fund with a large international
allocation — is modelled as "AU equity at beta 0.7". The account you keep something in does not
determine what market it tracks, and the model has no way to say otherwise.

### 7.2 The change

Market replaces account-type as the sleeve axis. Four sleeves:

| Sleeve | Meaning |
|---|---|
| `EQUITY_US` | US market |
| `EQUITY_AU` | Australian market |
| `EQUITY_INTL_EX_US` | Developed + emerging ex-US — the international sleeve a US-domiciled investor buys |
| `EQUITY_INTL_EX_AU` | Ex-Australia — the international sleeve an AU-domiciled investor buys |

`EQUITY_US` and `EQUITY_AU` already exist as **class** keys with member fan-out
(`RATE_KEY_CLASS_MEMBERS`). Under this change they become sleeves in their own right and the
fan-out table shrinks or disappears.

Super's diversification is then expressed as what it is — a **mix of market sleeves** — instead
of a beta fudge. That is strictly more honest and it is also the only way an "how much
international should the Super balance hold" question becomes askable.

**Two international sleeves, not one**, because ex-US and ex-AU overlap heavily but are not the
same basket: ex-US contains Australia and ex-AU contains the US, which is roughly 60% of global
market cap. Modelling them as one sleeve would make a US investor's international allocation and
an AU investor's international allocation identical, which is the opposite of true.

### 7.3 Allocation stays a closed four-value enum

The markets are a **sub-axis under `ALLOCATION.EQUITY`**, not new `ALLOCATION` values.

`ALLOCATION` is a closed enum that the rebalancer, drawdown selection and the reporting cube are
built on — `ALLOC_WEIGHT_CLASSES`, `ALLOCATION_PRESETS`, the glidepath anchors and the
design-58 drawdown sleeve weights all assume its four members. Splitting `EQUITY` into four
would touch every one of them plus their tests, for a lever that works just as well one level
down.

So: a per-holding market attribute drives `rateKey`, and the intra-equity market mix is a
second, smaller lever beneath the existing allocation weights.

`resolveRateKey` (`default-allocations.js:130`) needs its class-containment guard extended —
`CLASS_KEYS_BY_ALLOCATION[EQUITY]` must admit all four market keys, so role can still only
refine *within* the class. That guard is what stops a BOND sleeve in a `us-stock` brokerage
resolving to `EQUITY_US`; it must keep doing that job.

### 7.4 Dispersion is the point

Per-sleeve `idioVol` currently defaults to 0, which is what makes sleeves perfectly correlated
(§1.2). Market sleeves with zero idio vol would be **no better than what exists** — four names
for one random variable.

So §7 is not done when the keys exist. It is done when the sleeves have **plausible correlation
structure**: distinct betas on the shared market factor *and* non-zero idiosyncratic vol, so
US and international can genuinely diverge. That is what turns §4 and §5 from correct-but-dormant
into a lever worth searching.

Note the cost: enabling idio vol **does** advance the RNG cursor (§1.4), one extra uniform per
sleeve per tick. That is a deliberate, one-time re-basing of every stochastic result, and it
should land as its own commit with its own re-gold so it is not confused with the tax changes.

---

## 8. AU franked dividends

Fully specified already in **design 76 §8**, which is not superseded — this section records why
it is being pulled forward and what it is blocked on.

**Why now:** §7 makes AU equity a sleeve a user can allocate to. Franking is the reason to hold
it. The model currently makes a franked dividend a **pure tax shield** — design 76 §8.1 measured
a fully franked resident dividend producing `auOrdinaryIncomeYTD` of **0** and a franking credit
equal to **100% of the cash**, where Div 207-20 includes both the cash and the gross-up in
assessable income and the real credit at a 30% company rate is `cash × 30/70` ≈ 42.9%. Two errors,
both favouring the household, and they compound rather than cancel. Answering "how much AU equity
should I hold" against that is answering a different question.

Design 76 §8.3 is explicit that this is inert only because the reference scenario holds few AU
shares: "**Expanding AU share holdings turns all three live at once.**" §7 is that expansion.

**Sequencing is design 76 §8.7 unchanged**, and its ordering constraint matters: gaps 1 and 2
must land **together**, because fixing gap 2 alone — shrinking the credit 2.33× with no
offsetting income — makes franked dividends look *worse* than reality. A wrong answer arrived at
by a correct edit.

**Blocked on two things:**

1. **A spec amendment, not a code change** (design 76 §8.6). `design/requirements.md` EVT-26
   specifies the AU treatment as "Franking Credit" where EVT-28 says "Ordinary Income". The
   reducer implements the table faithfully. Amend the row first, or code and spec disagree and
   the next reader trusts the wrong one.
2. **Primary sources** (§2.3). Div 207-20, s67-25, and the qualified-person rule are not on
   disk.

**Open questions carried over from design 76 §8, unchanged:** the 45-day rule (recommend
note-don't-build for a buy-and-hold model), partial franking (recommend a per-holding percentage
defaulting to 100%), and whether refundability breaks the design 71 §6 footing invariant — a
refundable credit can drive net tax negative, and the fix is to distinguish "refund owed" from
"clamped", not to relax the invariant.

**User has data for this section.** Ask before building.

---

## 9. Sequencing

Ordered so each step is independently reviewable and the re-gold diffs stay attributable.

| # | Step | Re-golds? |
|---|---|---|
| 1 | `consumeHoldings` signed holding-period tallies (§3) | No — byte-identical by construction |
| 2 | Disposal emitters stop flooring; character on the payload; parity test extended | No — nothing consumes the new fields yet |
| 3 | US §1211/§1212 netting, \$3,000 offset, carryforward (§4) | **Yes** |
| 4 | AU s102-5 netting, per-person pool (§5) | **Yes** |
| 5 | Market sleeves, idio vol at 0 (§7.2–7.3) | Structural only |
| 6 | Correlation structure — betas and non-zero idio vol (§7.4) | **Yes**, and re-bases every stochastic result |
| 7 | Franked dividends (§8) | **Yes** |

Steps 1–2 are behaviour-preserving and land the plumbing where it can be reviewed on its own.
Steps 3 and 4 are separate commits because US and AU netting are genuinely different rules and a
combined diff hides which one moved what. Step 6 is isolated because it is the only step that
touches the RNG.

**Do not measure the harvest lever before step 6.** §1.3.

---

## 10. Verification

- **`tests/unit/disposal-tax-payload-parity.test.mjs`** — extend `REQUIRED` with the signed-loss
  and character fields. This test exists because five independent emitters build the same
  payload from scratch and had silently drifted; adding fields without adding them here
  reproduces that failure exactly. Its static AST scan is what catches an emitter that is never
  exercised by a scenario.
- **U-conservation harness** (`unrealized-gain-conservation-harness`) — `Σ(mv − costBasis)`
  should now be conserved across a disposal *including* when the disposal is at a loss. This is
  the harness that finds missed CGT; it is also the one that would catch a signed tally leaking.
- **A working-detector control.** Per `offset-earns-no-yield`, an absence test needs a control
  that proves the detector works. For §4 and §5: a scenario with a *known* loss must show a
  reduced liability, not merely "no crash" — otherwise a pool that is written but never read
  passes every test.
- **Golden fixtures** — `REGOLD=1`, then read the diff. Three independent sources of movement
  (loss recognition, character, sleeve re-basing), which is why §9 re-golds at step boundaries.
- **Design 83 §904 partition invariants** — re-run after step 3 (§4.4).
- **An RNG-neutrality test for §7** — assert the sleeve loop draws zero uniforms when every idio
  vol is 0, so the property §1.4 relies on cannot be lost silently.

---

## 11. Out of scope — with reasons, so they stay findable

- **The bond-ladder basis reset — design 62 §9.5's "Not covered".** `materializeLadder`
  (`bond-ladder-reducer.js:145`) stamps `costBasis: face` and `costBaseByCountry: null` on every
  rung, so a re-materialization marks the whole bond sleeve to market and discards any residency
  step-up those lots carried.

  **Directly adversarial to this design**, which is why it is named here rather than left in
  design 62. Bonds after a rate rise are exactly where losses live, and a lever that silently
  resets basis to market **launders the tax asset away** — the loss vanishes and the subsequent
  recovery to par is then taxed as a real gain. Both errors run against the household.

  Out of scope because it fires only at bootstrap and on a rung-count change, only when
  `BOND_LADDER` is selected, and so is off the golden path — meaning it can be fixed on a clean,
  isolated diff. Folding it in would contaminate the re-gold this design must keep reviewable.
  **Recommend fixing it before step 6**, so ladder scenarios are trustworthy by the time
  dispersion makes losses common.

- **Corporate capital losses (§1211(a), §1212(a)) and the §1256 election (§1212(c)).** No
  corporate entity and no futures in the model.

- **US capital loss carrybacks.** §1212(b) grants individuals carryforward only; the carryback
  in §1212(a)(1)(A) is corporate. Nothing to model.

- **§1091 wash sales.** Not modelled today, and out of scope here. Worth flagging as the next
  thing to want: once §7 gives sleeves real dispersion and the harvest lever starts firing, a
  model with losses but no wash-sale rule will over-value harvesting, because it can sell and
  rebuy the same sleeve with no consequence. `resolveSubstitute` is the seam that would enforce
  it.

- **AU capital losses while a foreign resident.** s855-10 restricts a foreign resident's CGT net
  to Taxable Australian Property, which restricts which losses arise at all. The residency-aware
  cost-base handling belongs to design 62; do not reach for the resident branch as a stand-in.

- **Franking credits inside super** (design 76 §8.4). A 15% fund rate (0% in pension phase)
  against a 30% credit is a systematic cash refund. Separate, and only worth building if AU
  shares actually land in super — which §7 makes newly plausible, so revisit after step 6.

- **§1.1411-4(f)(4) deductions properly allocable to NII, beyond the §1211(b) allowance.** The
  regulation's (f) paragraph is a whole deduction regime. Only the capital-loss slice is in
  scope here; the rest is untouched and unmeasured.
