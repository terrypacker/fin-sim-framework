# 77 — AU super fund tax: incidence, the age-60 gate, and FTC creditability

**Status: Gap 1 COMPLETE (implemented + green, 4,021 unit / 910 viz). Gaps 2 and 3 are
findings, not changes — see §3 and §4. Gap 4 (Medicare levy) is OPEN and needs a decision
from the owner; the research in §6 does not support the change as asked.**

Two questions were put to this document:

1. Ensure AU **super tax** is not part of the US foreign tax credit; it comes out of the
   balance of the super account and must stop at preservation phase (age 60).
2. Ensure the **Medicare levy** is not part of the FTC.

The answers are not symmetric. Question 1 turned out to be three separate things, of which
**one was a real and material bug** (§3), one was **already correct** (§4.1) and one was
**already correct but worth stating precisely** (§4.2). Question 2 asks for a change that
the tax law appears to contradict — the Medicare levy looks creditable, and §6 sets out why.
That one is left open rather than implemented.

**Relates to:**
- **`design/52` (cross-border relief)** — owns `_extraStatePatches`, the §904 basket funding
  seam where the creditable base is decided. §3.3 removes a subtraction from it.
- **`design/71` (tax worksheet CSV export)** — owns the return's footing rules. The new
  `memo` row type (§5.5) is the mechanism that keeps a disclosed-but-unassessed amount out
  of every subtotal.
- **`design/68` (year-of-death tax)** — established `auSuperDeathTaxYTD` as a *reporting
  bucket*: real tax, withheld at source, deliberately excluded from `netLiability`. Design 77
  is the same pattern applied to the ordinary Div 295 tax, which had been the odd one out.
- **`design/63` (inheritance)** — `neInheritanceTaxYTD`, the other reporting bucket.

---

## 1. The one-line summary

`auSuperTaxYTD` was being **paid twice**: once implicitly (the super balance was credited
with gross contributions and gross earnings, so the fund never actually bore the tax) and
once explicitly (the amount was added to the member's AU `netLiability`, and
`AU_TAX_PAYMENT_DEBIT` drew it out of their AU savings account).

Design 77 makes the fund bear it, once, where it actually falls.

## 2. What the model did before

Three sites, and the round trip between them is the bug:

| Site | Behavior |
|---|---|
| `SuperContributionApplyReducer` | debited AU cash by the gross contribution, credited super by the **gross** contribution |
| `SuperEarningsHandler` → `SuperEarningsApplyReducer` | credited super with **gross** growth |
| `AuTaxRatesBase.computeTax` | added `auSuperTaxYTD` into `netLiabilityPreFito` and `netLiability` |
| `AuTaxSettleApplyReducerBase.reduce` | chained `AU_TAX_PAYMENT_DEBIT { amount: tax }` — **including the super tax** |

So the member's own AU savings account funded the superannuation fund's tax liability, and
the fund's balance kept compounding as though the tax had never been levied.

Measured on the default `IntlRetirementScenario` (2026–2050): **A\$87,435** of lifetime super
fund tax was routed this way.

## 3. Gap 1 — incidence: the fund pays it, out of fund assets  ✅ FIXED

### 3.1 The law

The 15% is imposed by **ITAA 1997 Div 295** on the **superannuation fund's** taxable income —
concessional contributions it receives, and its own investment earnings. The taxpayer is the
fund (its trustee). The member is not assessed on it, it does not appear on the member's
notice of assessment, and the member has no way to pay it out of their own pocket even if
they wanted to. In practice a fund's unit price is quoted **net of** this tax, which is
exactly the arithmetic §5.1 now implements.

The one part of the super tax system that *is* personally assessed on the member is
**Div 293** (an additional 15% on concessional contributions for members over the \$250,000
income threshold). It is not modelled, and `super-tax-rate.js` carries a comment saying that
if it is ever added it must NOT go through this path — it is the member's liability.

### 3.2 The fix

- Contributions (`SuperContributionApplyReducer`): AU cash is debited the **gross**
  contribution; the super balance and `contributionBasis` are credited the **net**. Taking
  the same net figure into basis keeps `balance === contributionBasis + earningsBasis` true
  through the withholding — the tax leaves the fund, it does not become earnings.
- Earnings (`SuperEarningsHandler`): the growth is computed **twice** — once at `factor: 1`
  for the gross (the base the tax is levied on) and once at `factor: 1 - taxRate` for what is
  actually credited. Re-running the growth rather than scaling the result afterwards is
  deliberate: the balance increment and the per-holding transacts then come out of the *same*
  rounding pass, so the §4.4 invariant (`Σ holdings.marketValue === balance`) survives the
  withholding instead of drifting by cents.
- `auSuperTaxYTD` / `auPersonSuperTaxYTD` are unchanged in meaning: still the tax accrued,
  still recorded by the year-versioned classifier against the **gross** base.
- Removed from `netLiabilityPreFito`, `netLiability` and `grossTax` on **both** the resident
  and non-resident paths, so `AU_TAX_PAYMENT_DEBIT` can no longer collect it.

### 3.3 The knock-on in the FTC seam

`AuTaxSettleApplyReducer._extraStatePatches` computed
`auCreditable = tax − superTax − usSourceAuTax`. With super tax gone from `tax`, subtracting
it again would understate the creditable base by the whole amount, so the subtraction is
removed. **The conclusion it encoded is unchanged and still correct** — see §4.1. A test now
pins this specifically: the state passed to that reducer carries a non-zero `auSuperTaxYTD`
precisely so a residual `− superTax` would fail.

### 3.4 Lifetime tax accounting

`cumulativeTaxesPaid` reads `action.tax`. Taking super tax out of `tax` would have silently
deleted A\$81k of genuinely-paid tax from the lifetime metric — and, worse, handed the
`MIN_LIFETIME_TAXES` objective a way to "avoid" tax by shovelling money into super while
still paying it. The AU settle now also carries `fundTax`, and `AccumulateTaxesPaidReducer`
adds it. Lifetime tax measures tax *paid*, not tax *invoiced to the member*.

### 3.5 Effect

Default scenario, 2026–2050:

| | before | after | Δ |
|---|---|---|---|
| ending net worth (USD) | 12,260,459 | 12,183,627 | −76,832 (−0.63%) |
| lifetime tax (USD) | 719,844 | 723,849 | +4,005 (+0.56%) |
| ending super balance (AUD) | 1,268,092 | 1,126,567 | −141,525 (−11.2%) |
| lifetime super fund tax (AUD) | 87,435 | 81,021 | −6,414 |

Net worth **fell**, and that is the correct direction: the old model let the super account
compound on ~A\$87k that had already been paid to the ATO. The household is not newly poorer —
the previous figure was overstated. The super balance falls furthest (−11.2%) because it is
the account that had been enjoying the free compounding.

Lifetime super fund tax **fell** (A\$87,435 → A\$81,021) for the same reason in reverse: a
smaller fund earns less, so there is less to tax. Lifetime tax nonetheless **rose**, via
§3.4's hand-off plus the second-order drawdown differences a smaller super book causes.

## 4. What was already right

### 4.1 Super tax was already excluded from the FTC  ✅ NO CHANGE NEEDED

`_extraStatePatches` has excluded it since design 52 §4.4, with the comment *"Super tax — not
a creditable foreign income tax."* Verified empirically before touching anything: a state with
A\$9,000 of super tax and a A\$48,570 AU liability staged A\$39,570 into the §904 baskets.

The reasoning is worth recording, because the comment asserted it without support and the
question will come back:

**IRC §901 credits the person on whom foreign law imposes legal liability**
(Treas. Reg. §1.901-2(f) — the "technical taxpayer" rule). For Div 295 tax that person is the
fund's trustee. The member is a beneficiary of a pooled vehicle, not the taxpayer, so there
is nothing for them to credit. There is no indirect-credit route either: §902 was repealed by
the TCJA, and §960 reaches only CFC-type inclusions.

The counter-argument, for completeness: if a super interest were treated as a **grantor trust**
owned by the member, §671 would pull the trust's items — including foreign taxes — onto the
member's return. This is a live area (the IRS has never officially classified Australian
super), but it does not rescue creditability here: an APRA-regulated fund is a pooled entity
with many members and no member is its owner, and the Div 295 tax is levied on the fund's
whole taxable income rather than on any member's interest. A single-member SMSF is the case
where the argument is strongest — and this model does not model SMSFs.

### 4.2 The age-60 gate already existed  ✅ ALREADY PRESENT (one hole closed)

`SuperEarningsHandler` has gated fund earnings tax at `age >= 60 → 0%` since design 36 §12.1,
with tests (`EVT-23` pension-phase pair). Confirmed live: on the default scenario the accrual
drops in 2039 as the first member turns 60 and reaches zero in 2044 as the second does.

**One hole was found and closed.** `SuperEarningsDirectHandler` — the handler for a directly
injected `SUPER_EARNINGS` event, as opposed to the scheduled `INTL_SUPER_EARNINGS` path — had
**no age gate at all** and taxed a 70-year-old's fund earnings at 15%. The same member got a
different answer depending on which event fired. It now applies the identical gate.

**What the age-60 proxy elides.** Worth stating plainly, because "stop at 60" is not quite the
rule and the difference can be large:

- The real trigger is the fund entering **retirement phase** — earnings on assets supporting a
  retirement-phase income stream are **exempt current pension income (ECPI)**, taxed at 0%.
  That requires the member to have met a condition of release *and to have actually commenced
  an account-based pension*. Turning 60 permits this; it does not do it. A 62-year-old who
  leaves everything in accumulation still pays 15%.
- The exemption is capped by the **transfer balance cap** (A\$2.0M from 1 July 2025, A\$2.1M
  from 1 July 2026, indexed). Anything above the cap must stay in accumulation and **keeps
  being taxed at 15%**. The model exempts the whole balance. On the default scenario the super
  book ends around A\$1.13M, comfortably under, so the simplification is currently harmless —
  but it would silently over-exempt a larger book.
- A **transition-to-retirement income stream (TRIS)** in the pre-retirement phase gets **no**
  ECPI: its supporting assets are taxed at 15% regardless of when it commenced.

None of these are modelled. They are listed here and in `super-tax-rate.js` so the proxy is a
known simplification rather than an assumed rule.

## 5. Implementation map

| § | File | Change |
|---|---|---|
| 5.1 | `finance/handlers/earnings-handlers.js` | `SuperEarningsHandler` credits growth net of fund tax; emits `grossAmount` + explicit `taxRate` |
| 5.1 | `finance/account-rules/au/au-super-classes.js` | `SuperEarningsApplyReducer` credits net, classifies on gross; `SuperEarningsDirectHandler` gains the age-60 gate (§4.2) |
| 5.2 | `finance/account-rules/au/au-super-classes.js` | `SuperContributionApplyReducer` credits net of contributions tax |
| 5.3 | `finance/tax/au/au-tax-rates-base.js` | super tax out of `netLiabilityPreFito` / `netLiability` / `grossTax`, both residency paths; new `superFundTax` field + `memo` line item |
| 5.3 | `finance/tax/tax-settle-classes.js` | `− superTax` removed from the creditable base (§3.3) |
| 5.4 | `finance/tax/tax-settle-classes.js`, `finance/reducers/accumulate-taxes-paid-reducer.js` | `fundTax` on `AU_TAX_SETTLE_APPLY`, counted into `cumulativeTaxesPaid` |
| 5.5 | `finance/tax/tax-worksheet-export.js`, `au-tax-document-2026/2027.js` | `memo: true` → `rowType: 'MEMO'`, excluded from every footing sum |
| — | `finance/tax/au/super-tax-rate.js` | **new** — the shared 15% constant + `superEarningsTaxRate(age)`, previously private to `au-tax-module-2026.js` |

### 5.5 Why a new row type

The fund tax must stay **visible** — a reader looking at the household's Australian tax burden
should see it — while staying out of **every subtotal**, because it is not the member's
liability. The return already had `sub` for breakdown rows that must not be re-added; `memo`
is the same idea for disclosed-but-unassessed amounts. Both the document reconciliation tests
and `verifyWorksheetRows`' components-sum-to-Gross-Tax check filter on it. The memo line is
also positioned *below* Net Tax Liability, so even a naive reader summing a column stops
before it.

## 6. Gap 4 — the Medicare levy  ⚠️ OPEN: the research does not support the change

The Medicare levy is currently **inside** the creditable base — it is part of `netLiability`,
which is what `_extraStatePatches` apportions into the §904 baskets. Verified: on a A\$150,000
resident return, A\$3,000 of Medicare levy sits inside the A\$39,570 staged as creditable
foreign tax.

Removing it was requested. **It should not be removed without a deliberate decision, because
the levy appears to be creditable**, and excluding it would make the model less accurate — it
would overstate US tax by denying a credit the taxpayer is entitled to claim.

### 6.1 Why it looks creditable

- **It is a tax on net income.** The levy is imposed on **taxable income** — the same base as
  income tax, after deductions — not on gross wages. It therefore satisfies the net gain
  requirement of Treas. Reg. §1.901-2(a)(3) on all four sub-tests (realization, gross receipts,
  cost recovery, and the attribution requirement added by the 2022 final regulations, which a
  residence-based levy on worldwide taxable income meets).
- **It is administered as income tax.** It is assessed, collected and disputed through the
  ITAA machinery and appears on the same notice of assessment. It even has a progressive
  feature — the low-income phase-in this model already implements in `_medicareLevyDetail`.
- **The "it's really a social security tax" objection does not hold.** Foreign social security
  taxes are non-creditable when they are **covered by a totalization agreement**. The
  US–Australia agreement (in force 1 October 2002) covers the Superannuation Guarantee and the
  age pension system. It does **not** cover the Medicare levy. The surface analogy to US
  FICA/Medicare tax also breaks on the decisive point: US Medicare tax is imposed on *wages*;
  the AU Medicare levy is imposed on *taxable income*, including investment income.
- The closest on-point administrative ruling found is Canadian (CRA 1997-0078787, holding the
  Medicare levy an "income or profits tax" creditable under ITA §126(1)(a)) — persuasive on the
  characterisation question, not binding on the IRS. No US authority was found treating it as
  non-creditable. Practitioner guidance for US expats in Australia routinely reports the
  combined "marginal rate + 2% Medicare levy" as the creditable Australian tax.

### 6.2 What would change it

The one clean argument for excluding it is **conservatism** — deliberately understating the
credit so the plan is not built on a position that has never been tested by the IRS. That is a
legitimate modelling choice, but it is a *policy* choice, not a correction, and it should be
visible as one rather than buried in `computeTax`.

### 6.3 Recommendation

Leave the levy creditable. If it is to be excluded, do it as an **explicit, named, defaulted-off
switch** (something like `medicareLevyCreditable`, default `true`) rather than silently, so the
return can still show the levy in gross tax while the FTC seam sees a reduced base — and so the
\$-effect of the assumption is measurable rather than baked in. The seam is the same
`_extraStatePatches` line design 77 §3.3 just simplified; subtracting a per-person Medicare
levy there is a small change once the decision is made.

**Not implemented pending that decision.**

## 7. Test record

4,021 unit (+4 net) / 910 viz, green. Nine tests encoded the pre-77 behavior and were
rewritten; three are worth calling out.

- **`TE-1: super tax stacks on top of ordinary income tax`** asserted the exact bug —
  `netLiability(withSuper) − netLiability(withoutSuper) === 1500`. It is now inverted to assert
  the difference is **0**, plus a new test that the memo line sits below Net Tax Liability.
- **`SuperContribution: … conserved (I3/I5)`** broke on money conservation
  (`Δsrc=−6000 Δdst=5100`). The helper already had a `fee` parameter for exactly this —
  "intended leakage (tax withheld) so it is explicit, not silent" — so the fix declares
  `fee: 900` rather than loosening the invariant.
- **`DRAWDOWN_WITHINTIER: a committed policy bites under a snapshot-seeded rollout`** went to a
  delta of **exactly zero** and looked like a broken MPC shim. It was not. Instrumenting
  `AccountService.replenishSavings` showed both rollouts reaching it with the correct committed
  policy (`SEQUENTIAL` / `PROPORTIONAL`) across 81 real deficit draws — the shim was intact; the
  *scenario* had stopped exercising the lever, because leaving ~A\$87k more in AU cash reshaped
  the draw so that every tier touched now has a single member, and the two policies are then the
  same walk by definition. The test asserted a **net-worth proxy** (\$1,156 on \$8.87M — 0.013%,
  barely over its own `> 1` threshold) for something it could observe directly. It now asserts
  the policy the drawdown engine actually sees. This is the design-65 lesson again: a
  scenario-shaped assertion reports on the scenario, not on the mechanism.

## 8. Open questions

1. **The Medicare levy decision (§6).** Owner's call. Recommendation: leave creditable.
2. **Transfer balance cap (§4.2).** The pension-phase exemption is applied to the whole balance.
   Harmless at the default scenario's ~A\$1.13M ending super; wrong above ~A\$2M. Worth a guard
   or a warning before anyone models a larger super book.
3. **Div 293.** Not modelled. It is the member's own liability and would go through the normal
   `netLiability` path, *not* the fund-withholding path built here.
4. **Effective vs statutory fund rate.** A real fund's Div 295 rate is below 15% after franking
   credits and its own one-third CGT discount. The model uses the statutory 15%, so it slightly
   overstates fund tax.
