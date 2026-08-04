# 83 — US–AU tax treaty intricacies: §904 baskets, resourcing, and the limitation

**Status** (2026-07-30, `wip/allocation-reporting`):

| gap | what | status |
|---|---|---|
| **G1** | §904 numerators are gross; the denominator is net | **PROPOSED** |
| **G2** | §72(t) early-withdrawal penalty inflates the limitation base | **PROPOSED** |
| **G3** | the re-sourced basket should not exist for this taxpayer | **PROPOSED** |
| **G4** | carryforward pools carry no category, so G3 cannot migrate them cleanly | **PROPOSED** |
| **G5** | Art. 22(4) ordering — the US credit must not erode Australia's 22(2) base | **PROPOSED — unverified** |
| **G6** | super withdrawals are US-taxed but enter **no** §904 basket | **PROPOSED** |
| **G7** | AU house sale: no main-residence exemption, unapportioned CGT discount, no §121 | **PROPOSED** |

Scope: the Foreign Tax Credit machinery for a **US citizen resident in Australia**. Not the
AU return, not FITO (design 52), not NIIT (which is correctly outside all of this).

This doc exists because CY2034 of the `terry-jeanne-07-30` export showed a §904 limitation
fraction of **5.157** — the numerator was five times the denominator. That is impossible on a
real Form 1116 and it turned out to be the visible end of three separate defects.

---

## 1. The documents

Everything below is sourced from primary authority, now checked into `docs/us-tax/`:

| file | what it is | why it matters |
|---|---|---|
| `Treaty-Australia-Convention-1982-08-06.txt` | **the Convention** — the operative treaty | Art. 22(4), Art. 27(1)(c) |
| `Treaty-Australia-Protocol-2001-09-27.txt` | **the Protocol** — operative amendments | did *not* touch Art. 27(1)(c) |
| `Treaty-Australia-Protocol-TE-3-5-2003.txt` | Treasury's **Technical Explanation** of the Protocol | commentary, not operative |
| `IRS-Pub-514-Foreign-Tax-Credit-2025.txt` | Pub 514 | category definitions |
| `IRS-Form-1116-Instructions-2025.txt` | Form 1116 instructions | line-by-line mechanics |
| `CFR-26-1.904-4-Separate-Categories.txt` | Reg. §1.904-4 | ¶(k) treaty-resourcing rules |

**On the Technical Explanation.** Before this doc, `docs/us-tax/` held only the TE. A Technical
Explanation is Treasury's official *commentary* — it explains policy and interpretation, but it
is not the text that binds. Three distinct artifacts exist and only the first two are operative:

1. **Convention** (Sydney, 6 Aug 1982) — the treaty.
2. **Protocol** (Canberra, 27 Sep 2001) — a set of amendments *to* the Convention.
3. **Technical Explanation** — Treasury's guide to (2).

Working from the TE alone is how §4's ordering rule stayed invisible: the TE paraphrases
Art. 27 resourcing as happening "as necessary", but only the Convention carries the operative
"**to the extent necessary**" and the Art. 22(4) non-erosion sentence. Per
[[published-base-guard]], transcribe from the authority.

---

## 2. Ground truth — CY2034 as exported

```
L4   Standard Deduction                                 -40,790.00
L12  Gross Tax                                              198.28
L18  §904 limitation base (Chapter-1 gross tax)             198.28
L19  §904 total taxable income (denominator)              8,447.57

L30  Passive     — foreign income in basket               5,673.96
L31  Passive     — limitation fraction                    0.67167
L40  Re-sourced  — foreign income in basket              43,563.61
L41  Re-sourced  — limitation fraction                    1.00000   <- clamped from 5.157
```

Two baskets partitioning one taxpayer's income cannot have fractions summing to **1.67**. The
clamp on L41 is correct Form 1116 behaviour (*"If line 17 is more than line 18, enter '1'"*) —
it is a backstop, and here it is loadbearing, which is the smell.

---

## 3. G1 — numerators are gross, the denominator is net

`us-tax-rates-base.js:206-213`:

```js
totalTaxable:       taxableOrdinaryAfterFeie + cg + collectibles,   // AFTER the standard deduction
passiveNumerator:   state.foreignPassiveIncomeYTD,                  // GROSS
resourcedNumerator: usSourceOrdinaryUsdYTD + usSourceCapGainsUsdYTD // GROSS
```

Form 1116 line 17 is foreign **taxable** income — gross income in the category *less a ratable
share of deductions*. The form computes it explicitly:

| line | meaning |
|---|---|
| 3a | *"If you don't itemize deductions, enter your standard deduction on line 3a."* |
| 3d | gross foreign source income **in this category** |
| 3e | gross income from **all** sources |
| 3f | `3d ÷ 3e` |
| 3g | `3c × 3f` — the ratable share of the standard deduction |
| 7 | `1a − 6`, i.e. gross foreign income minus 3g and any definitely-related deductions |

The model never computes 3g, so the \$40,790 standard deduction is apportioned to nothing.

### Redone the Form 1116 way

`3e = 42,761.42 + 6,476.15 = 49,237.57`

| CY2034 | model | Form 1116 |
|---|---|---|
| Passive 3f / 3g | — | 0.11524 / 4,700.49 |
| Passive fraction | 0.67167 | **0.11524** |
| Passive credit | 133.18 | **22.85** |
| Re-sourced 3f / 3g | — | 0.88476 / 36,089.51 |
| Re-sourced fraction | 5.157 → 1.0 | **0.88476** |
| Re-sourced credit | 65.10 | **175.43** |
| **total credit** | 198.28 | **198.28** |

Fractions now sum to **1.00000**. Net liability is unchanged *this year* — but the split
inverts, and the pools are separate and 10-year limited:

- passive pool: `1,891.25` → should be **`2,001.58`**
- re-sourced pool: `30,970.43` → should be **`30,860.10`**

### Lifetime effect

Rebuilding every year of the export the Form 1116 way (G1 and G2 together): **the model
over-credits by ≈ \$87,430**, concentrated in 2030 (+2,466), 2043 (+5,089), 2045 (+6,697),
2067 (+8,467), 2069 (+7,410). One-directional — both defects inflate the limit.

> Caveat on that figure: where apportioned deductions exceed a basket's gross income this
> estimate clamps line 17 to zero, whereas a real return carries a foreign loss with recapture
> (§904(f)). That mainly distorts the thin early years. Treat ~\$87k as the order of magnitude.

### Work

Track **gross** foreign income per basket alongside the existing accumulators, so `3f` is
computable, and net the apportioned deduction off before forming the fraction. The existing
`foreign*IncomeYTD` fields are already gross, so the missing input is `3e` (gross income from
all sources) plus the deduction apportionment step.

---

## 4. G2 — the §72(t) penalty inflates the limitation base

`us-tax-rates-base.js:172`:

```js
const grossTaxBeforeNiit = ordinaryTax + capitalGainsTax + collectiblesTax + penaltyTax;
```

with the comment *"including early-withdrawal penalties … This is the base the §904 FTC
limitation applies to."* Form 1116 line 20 says otherwise:

> *"Enter on line 20 your total U.S. income tax against which the credit is allowed (regular
> tax liability, as defined in section 26(b)(1)). Don't include any taxes listed in section
> 26(b)(2)."*

and on the form itself: *"Enter the total of Form 1040 … line 16, and Schedule 2 (Form 1040),
line 1z."* The §72(t) additional tax is reported in Schedule 2 **Part II**, not line 1z.

NIIT is already excluded on exactly this reasoning (CY2054 shows `L15 Gross Tax 1,140,107.35`
vs `L21 base 951,473.76`, differing by precisely the NIIT). The penalty belongs on the same
side of the line.

**CY2034 impact is 1.14. CY2030's is not:** penalty `12,569.11` against a true base of
`1,108.69` — the model's base was **12× too large**.

---

## 5. G3 — the re-sourced basket should not exist for this taxpayer

### 5.1 What the treaty actually does

Two operative provisions, both in the **1982 Convention** (not the Protocol):

**Art. 22(4)** — relief, and it is explicitly citizen-and-resident specific:

> *"For the purposes of computing United States tax, **where a United States citizen is a
> resident of Australia**, the United States shall allow as a credit against United States tax
> the income tax paid to Australia after the credit referred to in paragraph (2). The credit so
> allowed against United States tax shall not reduce that portion of the United States tax that
> is creditable against Australian tax in accordance with paragraph (2)."*

**Art. 27(1)(c)** — the resourcing that makes the credit usable:

> *"Where paragraph (4) of Article 22 … applies, income referred to in that paragraph shall be
> deemed to have its source in Australia **to the extent necessary** to give effect to the
> provisions of that paragraph."*

### 5.2 Why that removes the basket

Reg. §1.904-4(k)(1)(ii) is the general rule, and it already says a resourced basket is never
undifferentiated — it splits by underlying category:

> *"all items of **passive** category income that would otherwise be treated as derived from
> sources within the United States but which the taxpayer chooses to treat as arising from
> sources outside the United States pursuant to a … treaty are treated as income in a separate
> category for **passive category income resourced under the particular treaty**"*

But §1.904-4(k)(1)(iv)(A) switches the whole mechanism off for this fact pattern:

> *"**Exception for special relief from double taxation for individual residents of treaty
> jurisdictions.** Section 904(d)(6)(A) and paragraph (k)(1) of this section **do not apply** to
> any item of income deemed to be from foreign sources by reason of the relief from double
> taxation rules in any U.S. income tax treaty that is **solely applicable to U.S. citizens who
> are residents of the other Contracting State**."*

Art. 22(4) is textually "solely applicable to US citizens who are residents of Australia" — it
opens with that clause. Pub 514 and the Form 1116 instructions both carry the same carve-out in
their own words.

**Therefore: no separate limitation, and no third basket.** Re-sourced income lands in its
ordinary category by its own character.

### 5.3 Where the income should go

| currently → re-sourced | correct | authority |
|---|---|---|
| `IRA_ROLLOVER_WITHDRAWAL_TAX`, `IRA_RMD_TAX`, `INHERITED_RA_DISTRIBUTION_TAX` | **General** | residual — not in the Pub 514 passive list |
| `WAGES_INCOME_TAX`, `BONUS_TAX`, `SE_INCOME_US_TAX`, `SS_INCOME_TAX` | **General** | Pub 514: general *"includes … wages, salaries"* |
| `US_RENTAL_INCOME_TAX` | **Passive** | Pub 514 passive list: *Rents* |
| US dividends / interest / capital gains | **Passive** | Pub 514 passive list |

Two baskets, not three. The 5.157 fraction becomes structurally impossible, because every
numerator is then a genuine subset of the denominator.

### 5.4 Settled: AU rental income stays passive

Considered and **rejected**. Pub 514's passive list contains *Rents* outright; rents leave
passive only via *"Passive income does not include … **active business rents and royalties**"* —
the active conduct of a trade or business, a high bar for an individual landlord. The model
already routes `AU_RENTAL_INCOME_TAX → foreignPassiveIncomeYTD`
(`au-tax-module-2026.js:200`) and is **correct as written**. Revisit only if a property is
deliberately modelled as an active business.

---

## 6. G4 — the pools cannot migrate cleanly

G3's awkward half. `ftcPoolResourced` holds real balances (CY2034 opens at **27,135.43**, and
CY2054 at **1,097,627.06**) accumulated across 10-year vintages. Collapsing the basket means
splitting those vintages between the general and passive pools **by the character of the income
that created each one** — and the pools record only amount and vintage, not category.

Options:

- **A — re-derive.** Re-run from `simStart` with the new classification; pools rebuild
  naturally. Correct, and free for a simulator: there is no historical filing to preserve.
- **B — apportion on migration.** Split each vintage by that year's general/passive gross-income
  ratio. Needed only for saved states that must not be re-run.
- **C — carry category on the vintage.** The durable fix, and a prerequisite if resourced-category
  tracking is ever needed for a non-citizen fact pattern (where (k)(1)(ii) *does* apply).

**Recommendation: A**, with C folded into G3's implementation since the vintage record is being
touched anyway.

---

## 7. G5 — Art. 22(4) ordering (unverified)

Art. 22(4) carries a sentence the model almost certainly does not implement:

> *"The credit so allowed against United States tax **shall not reduce that portion of the
> United States tax that is creditable against Australian tax** in accordance with paragraph (2)."*

This is the classic three-bite ordering for US citizens abroad: Australia credits US tax on
US-source income (22(2)); the US then credits Australian tax (22(4)); and the second credit may
not erode the base of the first. The model computes FITO (design 52) and the FTC as separate
passes with a handoff, but whether that handoff honours the non-erosion constraint has **not
been checked**. Flagged, not diagnosed.

---

## 7a. G6 — super withdrawals are taxed but never enter a basket

### 7a.1 The defect

`au-tax-module-2026.js:324`:

```js
// EVT-22: super withdrawal of earnings — US ordinary income, no AU tax
['SUPER_WITHDRAWAL_EARNINGS_TAX', (state, action) => ({
  ...state,
  usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + toUSD(action.amount, 'AUD', state),
})],
```

That is the whole classifier. It touches `usOrdinaryIncomeYTD` and nothing else — not
`foreignGeneralIncomeYTD`, not `foreignPassiveIncomeYTD`, not `usSourceOrdinaryUsdYTD`.

The consequence is worse than a missing numerator. `totalTaxable` is derived from
`usOrdinaryIncomeYTD`, so a super withdrawal:

- **raises the §904 denominator**, diluting every other basket's fraction, and
- **adds nothing to any numerator**, creating no limitation room of its own.

US tax goes up and the capacity to relieve it goes down, from the same dollar.

### 7a.2 Where it should go

**Foreign source.** Pub 514's sourcing table is directly on point:

| item | source |
|---|---|
| Pension distributions attributable to contributions | Where services were performed that earned the pension |
| **Investment earnings on pension contributions** | **Location of pension trust** |

`SUPER_WITHDRAWAL_EARNINGS_TAX` is exactly the second row. The trust is Australian, so the
income is **foreign source** — it belongs in a foreign basket, not the resourced one (nothing
is being resourced; it was never US-source).

**General category.** A pension distribution is not in Pub 514's passive list
(dividends, interest, rents, royalties, annuities, net gain on investment property). General is
the residual category, so it lands there — the same reasoning as decision #2 on IRA
withdrawals. Treaty Art. 18(5) confirms super is not an "annuity" for treaty purposes: annuities
are paid *"in return for adequate and full consideration (other than services rendered)"*, and
super is consideration for services, so it is a pension under Art. 18(4).

### 7a.3 The question this answers

> *Can Australian tax be credited against US tax on super, even though that tax was not
> imposed on the super?*

**Yes.** §904 limits by *separate category*, not by item of income. The statute never traces a
foreign tax to the specific income it sheltered — it asks only whether the tax is creditable and
whether the income is foreign-source **in the same basket**. Any creditable AU tax in the
general basket can shelter US tax on foreign-source general-basket income.

This matters precisely because Australian super is **tax-free after 60**. There is no AU tax on
the super itself, and there never will be — but the distribution still generates general-basket
*limitation room* that AU tax from other sources can fill. The model currently throws that room
away.

### 7a.4 Why the fix only pays after G3

Putting super into general is correct but inert on its own: `foreignGeneralIncomeYTD` is 0.00 in
every year of the export, so the general **pool is empty** — room with no tax to apply against
it. The value is unlocked by **G3**, which moves the resourced AU tax into general. Then the
general basket holds the room (super) and the tax (ex-resourced) together.

**CY2044 is the clean illustration** — 83% of taxable income is super:

| CY2044 | model | G1+G3+G6 |
|---|---|---|
| Re-sourced fraction | 0.37220 | — (basket gone) |
| General numerator | 0.00 | 247,506.25 |
| credit taken | 11,918.17 | **27,301.56** |
| **net tax liability** | **15,792.16** | **408.77** |

with `299,234.45` of AU tax sitting unused in the resourced pool the whole time.

Across the four super-withdrawal years (2038, 2043, 2044, 2045; 397,972 USD of super income):

**US tax over-paid ≈ \$26,481** — 2044 (+15,383) and 2045 (+10,922) carry almost all of it.

### 7a.5 What is NOT in scope here

- **Fund tax stays uncreditable.** Div 295 tax is imposed on the *trustee*, and §901 credits the
  person on whom foreign law imposes legal liability (Treas. Reg. §1.901-2(f)). Design 77 §3.1
  settled this and it is unaffected — see [[design-77-super-fund-tax]].
- **The deferral position is assumed, not verified.** The model gives super qualified-pension
  treatment: contributions and in-fund earnings are not US income, and tax falls only on
  withdrawal. Many practitioners instead treat an Australian super fund as a foreign grantor
  trust or a §402(b) employees' trust, with **current** inclusion of contributions and earnings —
  and under that view the distribution's character would follow the underlying assets
  (dividends/interest → *passive*), not general. This is unresolved in practice, and the two
  positions are internally consistent in opposite directions. G6 stays consistent with the
  deferral position the model already takes. Revisiting it is a separate question requiring
  §402(b), the grantor-trust rules, and Rev. Proc. 2020-17 — none of which are in `docs/us-tax/`.

---

## 7b. G7 — taxation of an Australian house sale

The reference plan never sells the AU house, so none of this is live today. It will be.

The missing-exemption half of this was independently observed earlier, in a since-closed git
issue, and reached the same reading of `au-real-property-classes.js:57-58`. What §7b adds is
the statutory basis for *when* the exemption is actually due (s118-110(3) turns out to deny it
outright for a long-term non-resident), the discount-apportionment defect that sits alongside
it, the US §121 side, and the FTC timing interaction.

### 7b.1 What the model does now

`AuHouseSaleApplyReducer` (`au-real-property-classes.js:57-58`) is the whole computation:

```js
const adjustedBasis = Math.max(0, costBasis - accumulatedDep);   // Div 43 clawback
const gain          = Math.max(0, salePrice - adjustedBasis);
```

No main-residence exemption. `AuHouseSaleHandler` does not even pass `isPrimaryResidence`,
and the reducer never reads it — the flag exists on `RealProperty` and is consumed **only**
by the US house path.

**One omission, two opposite verdicts.** Because `isPrimaryResidence` is ignored here
entirely, the full gain always flows through to `AU_HOUSE_SALE_TAX`. That is *right* wherever
no exemption is due — a non-primary AU property is correctly fully assessable, and so is a
sale by a long-term non-resident (§7b.2, s118-110(3)) — and *wrong* wherever one is due: a
genuine AU main residence under s118-110 is **over-taxed**. The single missing check is
simultaneously load-bearing and harmless depending on the case, which is exactly why §7b.5
sequences the foreign-resident gate ahead of the exemption itself.

Downstream (`au-tax-module-2026.js:521`) the gain is split:

- `usCapitalGainsYTD += usdGain` — **no §121 exclusion, ever**
- `foreignPassiveIncomeYTD += usdGain` — correct: an AU-situs real-property gain is
  foreign-source and passive
- AU resident ⇒ the **entire** gain is added to `auDiscountableGainsYTD` (full 50% discount)
- AU non-resident ⇒ assessable at NR rates with no discountable slice

### 7b.2 The governing rules

All verified against `docs/au-tax/ITAA-1997` (Compilation No. 266, 1 Jul 2026) — the AU
statute is already on disk, so no new documents were needed.

**s118-110(3)–(5) — the foreign-resident denial.** This is the provision that decides case 1:

> *"(3) However, this section does not apply if, at the time the CGT event happens, you:
> (a) are an **excluded foreign resident**; or (b) are a foreign resident who does not
> satisfy the life events test.
> (4) You are an excluded foreign resident … if (a) you are a foreign resident at that time;
> and (b) the continuous period ending at that time for which you have been a foreign
> resident is **more than 6 years**."*

The life-events test (s118-110(5)) is narrow: terminal medical condition, death of a spouse
or minor child, or marriage breakdown. Absent one of those, a long-term foreign resident gets
**no main-residence exemption at all** — not a reduced one.

**s855-45(1) — no basis step-up.** The deemed re-acquisition at market value on becoming a
resident applies to every CGT asset *"except an asset: (a) that is **taxable Australian
property**"*. An Australian house is TAP, so it keeps its original cost base across the move.
The model correctly stamps no `costBaseByCountry.AU` for AU real property.

**s115-105 — the discount is apportioned, not all-or-nothing.** Its stated object is to
*"deny you a discount **to the extent that** you accrued a capital gain while a foreign
resident."* The discount is pro-rated over days of Australian residence in the ownership
period (s115-105/110/115), not switched on by residency at the sale date.

**s118-185** gives the partial exemption when a dwelling was the main residence for part only
of the ownership period; **s118-145** is the absence rule (6 years if income-producing,
indefinite if not).

### 7b.2a The computation, in the order it actually runs

Four stages. Each can independently gut or save the result, and they do **not** commute —
the exemption is applied first and the discount only to what survives it.

**Stage 0 — is the exemption available at all?**
Both s118-110(3) and s118-185(3) deny relief only if, *at the time the CGT event happens*,
you are an excluded foreign resident or a foreign resident failing the life-events test. It
is a **snapshot at the sale date**, not a look-back over the ownership period. Return, become
resident, then sell ⇒ the denial never engages. That single sequencing fact is worth more
than every rule below combined, and it is the whole difference between cases 1 and 2.

**Stage 1 — the cost base, and a trap that can dominate.**
s855-45(1)(a) gives no step-up (TAP). But **s118-192 can override that, and it is mandatory,
not elective**:

> *"(a) you would get only a partial exemption … because the dwelling was used for the purpose
> of producing assessable income; and (aa) that use occurred for the first time after …
> 20 August 1996; and (b) **you would have got a full exemption … if the CGT event had happened
> just before the first time (the income time) it was used for that purpose** … (2) You are
> taken to have acquired the dwelling … at the income time for its **market value at that time**."*

Limb (b) is the hinge: it only fires if the dwelling was already a fully-exempt main residence
immediately before it first earned income.

**Stage 2 — the exemption fraction.** s118-185(2):

```
CG × (non-main-residence days ÷ days in ownership period)
```

Note the direction — the formula yields the **taxable** slice, not the exempt one. The lever
is s118-145, which carries a precondition that is easy to miss:

> *"(1) If a dwelling **that was your main residence** ceases to be your main residence, you
> may choose to continue to treat it as your main residence."*

You cannot be "absent" from a home that was never your main residence. Where it is available:
**6 years** max while income-producing (s118-145(2)), **indefinite** if never rented
(s118-145(3)). s118-145(4) blocks treating any other dwelling as your main residence for the
same period — a real constraint if a US home is still owned.

**Stage 3 — s118-190** reduces the exemption further where the dwelling produced income and
interest would have been deductible. Secondary, but it is why a rented period costs twice.

**Stage 4 — the discount, on what survives.** s115-115(2), with the period fixed by
s115-105(2)(d) as acquisition → CGT event:

```
discount % = days Australian resident ÷ (2 × days in discount testing period)
```

Owned 20 years, resident for the last 3 ⇒ ~7.5%, not 50%. Note 1 to the section: *"The
percentage will be 0% if you were a foreign resident … during all of the discount testing
period."*

### 7b.2b Case 2 splits three ways on history alone

Which sub-case a dwelling is in changes the answer more than any modelling choice:

| | history | s118-192 | cost base | s118-145 absence rule | practical result |
|---|---|---|---|---|---|
| **2a** | lived in it → left → rented it | **applies** | reset to market value at first rental | available, 6-yr cap | pre-rental appreciation vanishes entirely |
| **2b** | bought as an investment, never lived in it | no — limb (b) fails | original cost | **unavailable** | only move-in→sale days are exempt |
| **2c** | lived in it → left → held vacant | no — no income use | original cost | available, **indefinite** | can be wholly exempt |

**2b is the harshest and the least intuitive**: moving in "as our primary residence" on return
buys only the days from move-in to sale. On a long hold that is a small fraction, and the
result is close to fully taxable despite the dwelling genuinely being the main residence at
the moment of sale.

### 7b.2b-dep Depreciation — the same field, opposite tax treatments

Depreciation accrues **only** through the rental path (`rental-income-classes.js:172` US,
`:261` AU), so a never-rented dwelling carries zero. Rates are right for both countries
(`rental-income-classes.js:77`):

```js
country === 'US' ? buildingBasis / 27.5      // MACRS 27.5-yr straight line
                 : buildingBasis * 0.025     // Div 43 capital works, 2.5%/yr
```

Both then land in one shared field, `accumulatedDepreciation`, and both sale reducers do the
same thing with it: `adjustedBasis = costBasis − accumulatedDep`. **That single treatment is
correct for Australia and wrong for the US.**

**Australia — correct as written.** s110-45(2): expenditure *"does not form part of the cost
base **to the extent that you have deducted or can deduct it**"*. Div 43 reduces the cost base,
which enlarges the capital gain — and that enlarged gain then flows through s118-185 and the
CGT discount like any other. So Australia effectively taxes recaptured capital works at **half
rate** after the discount, and the main-residence exemption **proportionally shelters it**.

**United States — wrong twice.** Reducing basis enlarges the gain, but the model taxes that
increment at the ordinary LTCG rate (0/15/20%). Two defects:

1. **No §1250 bucket.** Depreciation-attributable gain is *unrecaptured section 1250 gain*,
   taxed at a **maximum 25% rate**, not the LTCG rate. There is no 25% bucket anywhere in
   `us-tax-rates-base.js` — only ordinary, LTCG and the 28% collectibles rate.
2. **§121 wrongly shelters it.** Pub 523: *"you **can't exclude the portion of gain equal to
   any section 1250(b)(3) depreciation adjustments allowed or allowable after May 6, 1997**,
   which must be recaptured and reported under section 1250."*

Note "allowed **or allowable**" mirrors Australia's "have deducted **or can deduct**" — in both
countries recapture bites whether or not the deduction was claimed. The model accrues
automatically, so it is consistent with both.

**The asymmetry that decides case 2:** moving in shelters the depreciation effect in Australia
(proportionally, through s118-185) and **never** shelters it in the United States. For a
long-rented dwelling this can be the largest single term in the answer, and it points the
wrong way from the intuition that "moving in makes it tax-free".

**Div 40 is unmodelled.** Australia runs a second regime — plant and equipment — whose disposal
balancing adjustment is assessable as **ordinary income**, not CGT. One `accumulatedDepreciation`
bucket cannot represent both. This is defensible for a property acquired after 9 May 2017,
since second-hand plant in residential rentals is largely non-deductible for individual
investors from that date, but it is a simplification and should be recorded as one rather than
discovered later.

### 7b.2c Fields: how a user declares which case they are in

The blocker is representational, not computational. `isPrimaryResidence` is a **static
boolean**, and every rule above turns on *when* the dwelling was the main residence. A boolean
cannot express "not a main residence for 18 years, then it is" — which is precisely the lever
worth searching.

**Minimum sufficient set — two dates and one election:**

| field | type | meaning | drives |
|---|---|---|---|
| `mainResidenceFrom` | date \| null | first became the main residence; **null = never** | s118-185 numerator; s118-145 eligibility; s118-192 limb (b) |
| `mainResidenceUntil` | date \| null | ceased to be; null = still is at sale | s118-185 numerator; start of the absence period |
| `claimAbsenceRule` | checkbox | make the s118-145 choice | 6-yr / indefinite extension; blocks another dwelling |

Everything else is already in state: `rentalEnabled` + `monthlyRent` give the income-producing
test and the 6-year cap, residency days come from `state.people[].residency`, and ownership
days from the acquisition date. Sub-case is **derived**, never entered:

- `mainResidenceFrom == null` ⇒ 2b
- `mainResidenceFrom != null` and income-producing after it ⇒ 2a (s118-192 fires)
- `mainResidenceFrom != null`, never rented ⇒ 2c

`isPrimaryResidence` should become a derived read (`mainResidenceFrom != null && sale ≥ from`)
so the US §121 path and any UI keep working unchanged.

**UI shape.** One dropdown plus conditional dates, rather than three checkboxes that can be
set to contradictory combinations:

```
Main residence history:  [ Never ▾ ]                       → 2b, no further inputs
                         [ From the start, then moved out ] → date: moved out
                         [ Became one later ▾ ]             → date: moved in
                         [ Throughout ▾ ]                   → full exemption path
  ☐ Claim the s118-145 absence rule        (shown only when a "moved out" date exists)
```

**For the first house to be modelled** — never a primary residence, rented for the whole
hold — this collapses to a single lever. `mainResidenceFrom` is null today; the question
"do we move in on return?" is answered by setting it to the return date or leaving it null.
Because the dwelling was never a main residence beforehand, s118-192 cannot fire and s118-145
is unavailable, so the whole computation reduces to:

```
cost base       = original acquisition cost − Div 43 deductions   (no step-up, no reset)
taxable gain    = CG × (days before move-in ÷ total ownership days)
discount        = AU-resident days ÷ (2 × total ownership days)
```

That makes `mainResidenceFrom` a clean scalar lever the optimiser can search, exactly like
`moveYear`.

**How the US side responds to the same lever** — §121 is *both* a cliff and a proration, which
is easy to get wrong. §121(b)(5) denies the exclusion for gain allocable to **nonqualified
use** — any post-2008 period the dwelling was not the main home — and Pub 523's ordering is:

1. gain = price − adjusted basis (basis already net of depreciation);
2. **subtract depreciation** — never excludable (§7b.2b-dep);
3. allocate what remains between qualified and nonqualified use **by a time fraction**;
4. exclude only the qualified slice, capped at \$250k / \$500k.

Pub 523's worked example is nearly this exact fact pattern: a property rented 2 years, converted
to a principal residence for 2 years, sold after 5. Of \$300,000 post-depreciation gain, 2/5 —
\$120,000 — is allocated to nonqualified use and is **ineligible**; depreciation is recaptured
separately under §1250; *"the balance of the \$250,000 exclusion can't be used."*

One asymmetry worth planning around: Exception 1 excludes from nonqualified use *"any portion of
the 5-year period ending on the date of the sale … **after** the last date you … used the
property as your main home."* Renting **after** you move out is forgiven; renting **before** you
move in is not. The rent-then-occupy order — yours — is the penalised one.

So both countries prorate by time, and the two fractions are similar but not identical (AU over
the whole ownership period, US over post-2008 nonqualified use). The lever is therefore smoother
than a pure cliff, but the 2-of-5 **eligibility** gate is still a hard edge: below it the §121
exclusion is zero. Sample either side of the 2-year mark rather than trusting a coarse sweep.

### 7b.3 The three cases

| | AU main residence | AU discount | US §121 | model |
|---|---|---|---|---|
| **1. Sell while still non-resident** | **denied** — s118-110(3), excluded foreign resident | denied | fails 2-of-5 use test | **correct** |
| **2. Sell as resident, moved in as main residence** | partial (s118-185/145) | apportioned | **\$500k applies** | **wrong both sides** |
| **3. Sell as resident, never main residence** | none | apportioned | none | **discount wrong** |

**Case 1 is right today — but by omission, not by rule.** The model applies no exemption
because it has no exemption logic, and the correct answer happens to be no exemption. Adding
a naive main-residence exemption without the s118-110(3) foreign-resident gate would *break*
the case that currently works. That gate must land first.

**Case 2 is wrong in both directions**, which is why it cannot be waved off as conservative:
missing the AU main-residence exemption **overstates** AU tax, while granting the full 50%
discount **understates** it. Net effect is unsignable without the numbers.

**Case 3** understates AU tax: the full discount is granted for a gain largely accrued while
foreign-resident.

### 7b.4 The US side and the credit

The user's framing — *taxed in Australia first, then a foreign tax credit to the IRS* — is
how the model already routes it: AU-situs gain → `foreignPassiveIncomeYTD` (passive basket,
correct per Pub 514: gains on property that produces passive income), and the AU tax reaches
the §904 pools through the settle patch. Structurally sound.

Two things it misses:

1. **§121 is location-blind.** The US exclusion applies to a principal residence wherever it
   sits, on the 2-of-5-year ownership-and-use test. In case 2 the couple would qualify, and
   the model grants nothing. (Note `us-real-property-classes.js:20` already records that the
   2-of-5 test is unmodeled for the *US* house too — the flag stands in for it.)
2. **A timing trap worth planning around.** The AU FY ends 30 June, the US CY on 31 December,
   and the FTC is funded at the AU settle. So:
   - a sale in **Jan–Jun** falls in an AU FY that settles that same June → the AU tax lands
     in the **same** US calendar year as the gain. Aligned.
   - a sale in **Jul–Dec** falls in an AU FY that settles the *following* June → the AU tax
     reaches the FTC pools **a year after** the US taxes the gain.

   The second case pays full US tax in the year of sale and relieves it only later, out of
   carryforward. Real law softens this (§904(c) allows a one-year carryback); the model has
   carryforward pools only. **Selling in the first half of a calendar year is worth real
   money** and the model would currently exaggerate that effect.

### 7b.5 Work

Ordered so that the first house to be modelled (sub-case **2b**, §7b.2c) is fully computable
after step 2, and the wider generality can follow.

1. **Gate first.** Plumb the main-residence state through `AuHouseSaleHandler` and implement
   s118-110(3)/s118-185(3) — foreign resident at the CGT event ⇒ exemption denied. This
   guards case 1, which is correct today only by omission and would otherwise regress.
2. **Fields + the 2b path.** Add `mainResidenceFrom` / `mainResidenceUntil` /
   `claimAbsenceRule` (§7b.2c), derive `isPrimaryResidence` from them so the US §121 path and
   the UI are untouched, and implement the s118-185 day-count fraction. 2b needs nothing
   further: no s118-192, no absence rule.
3. **Apportion the CGT discount** by residency days (s115-105/110/115), replacing the binary
   resident/non-resident switch. This also fixes case 3 and touches **every** AU CGT asset,
   not just property — the widest of these changes, and worth its own golden re-baseline.
3b. **Split the depreciation component out of the gain** (§7b.2b-dep) and give the US a
   **§1250 25% bucket** alongside ordinary / LTCG / 28% collectibles. Until this exists the
   US side cannot both recapture depreciation and exclude the rest, because there is nowhere
   to put a differently-rated slice. Australia needs no change here — s110-45(2) basis
   reduction is already right.
4. **2a / 2c generality**: the s118-145 absence rule and the mandatory s118-192 market-value
   reset. An `auMainResidenceExemptFraction` already exists for the *foreign* dwelling of an
   AU resident; the AU-dwelling case is its mirror and should share a helper.
5. Apply §121 on the US side for an AU dwelling that meets the use test.
5. Only then consider §904(c) carryback, which is what makes the Jul–Dec timing trap real
   rather than an artifact.

---

## 8. Order of work

G1 and G2 are mechanical, independently correct, and do not depend on G3. G3 is a
classification change that subsumes part of G1's symptom but not its cause.

1. **G2** — one line, plus a test that a penalty-heavy year keeps the penalty out of the base.
2. **G1** — needs `3e` plumbed through; the fraction assertion (`Σ fractions ≤ 1`) becomes a
   permanent invariant and would have caught this on day one.
3. **G3 + G4(C)** — reclassify, delete the third basket, re-derive pools.
4. **G6** — one classifier line; land it **with or after G3**, since alone it is inert.
5. **G5** — verify first, then decide.

### Invariants worth asserting once G1 lands

- `Σ basket fractions ≤ 1.0` — the check that makes the 5.157 impossible.
- basket numerator ≤ denominator, per basket, before any clamp.
- limitation base excludes NIIT, SECA, Additional Medicare **and §72(t)**.
- `Σ per-basket credit ≤ limitation base`.

None of these are currently asserted, and `npm run crossfoot` cannot see them — it only checks
worksheet lines that carry a `drillReport` link, and none of the §904 worksheet lines do.

---

## 9. Decision record

| # | question | decision | why |
|---|---|---|---|
| 1 | Is AU rental income general? | **No — passive** | Pub 514 passive list includes *Rents*; the only exit is active business rents |
| 2 | Are IRA withdrawals general? | **Yes** | not in the passive list; general is the residual category |
| 3 | Should the resourced basket be labelled passive/general? | **Moot — it should not exist** | §1.904-4(k)(1)(iv)(A) disapplies (k)(1) for Art. 22(4) relief |
| 4 | Is the L41 = 1.0 clamp a bug? | **No — the clamp is correct** | Form 1116 line 19 mandates it; the bug is a numerator that reaches it |
| 5 | Does G1 cost real money? | **Yes, ≈ \$87k over the run** | both G1 and G2 inflate the limit in the same direction |
| 6 | Migrate or re-derive the pools? | **Re-derive** | a simulator has no filed return to preserve |
| 7 | Can AU tax offset US tax on super it was never imposed on? | **Yes** | §904 limits per basket, not per item — no tracing |
| 8 | Which basket for super withdrawals? | **General, foreign source** | Pub 514 sourcing: earnings → location of pension trust; pensions absent from the passive list |
| 9 | Is super fund (Div 295) tax creditable to the member? | **No — unchanged** | §901 / Reg. §1.901-2(f): liability is the trustee's (design 77 §3.1) |
| 10 | Does an AU house sold while non-resident keep the main-residence exemption? | **No — none at all** | s118-110(3)/(4): >6 years foreign-resident ⇒ excluded foreign resident |
| 11 | Does the AU house get a s855-45 basis step-up on return? | **No** | s855-45(1)(a) excludes taxable Australian property |
| 12 | Is the CGT discount on/off by residency at sale? | **No — apportioned by residency days** | s115-105 object: deny "to the extent" accrued while foreign resident |
| 13 | How does a user declare the main-residence history? | **Two dates + one election**, sub-case derived | every rule turns on *when*; a static boolean cannot express it (§7b.2c) |
| 14 | Keep `isPrimaryResidence`? | **Yes, but derived** from `mainResidenceFrom` | leaves the US §121 path and the UI untouched |
| 15 | Is basis reduction the right depreciation mechanic? | **Yes for AU, no for US** | s110-45(2) vs §1250: the US needs a separately-rated 25% slice |
| 16 | Does §121 shelter depreciation? | **No, never** | Pub 523 / Reg. §1.121-1(d): §1250 adjustments after 6 May 1997 are excluded from the exclusion |
| 17 | Is §121 a 2-year cliff? | **Cliff *and* proration** | §121(b)(5) nonqualified use prorates on top of the eligibility gate |
| 18 | Model Div 40 plant & equipment separately? | **No — record as a simplification** | largely non-deductible for second-hand residential plant post 9 May 2017 |

---

## 10. Open questions

- **G5** — does the FITO ↔ FTC handoff honour Art. 22(4)'s non-erosion sentence?
- §904(f) overall foreign loss recapture is unmodelled; it is what makes the \$87k figure
  approximate, and it bites hardest in thin-income years.
- **Does s118-192's deemed acquisition also reset the s115-105 discount testing period?**
  s115-105(2)(d)(i) fixes the period from *"the day you acquired the CGT asset"*, and s115-30
  carries special acquisition rules. If it does reset, sub-case 2a gains materially on the
  discount as well as the cost base. Unverified — do not build on it.
- **Is Australian super actually tax-deferred for US purposes?** §7a.5 — the model assumes yes;
  the grantor-trust / §402(b) view says no, and flips G6's basket from general to passive.
  Needs §402(b), the foreign grantor-trust rules, and Rev. Proc. 2020-17.
- The Convention text checked in is the 1982 original. The 2001 Protocol amendments are in a
  separate file and have **not** been merged into a consolidated text — Art. 27(1)(c) survives
  unamended, which is what §5.1 relies on, but any *other* article cited later must be read
  against both files.
