# 83 — US–AU tax treaty intricacies: §904 baskets, resourcing, and the limitation

**Status** (re-audited 2026-08-05 against `main` @ `1cc2176`):

| gap | what | status | evidence |
|---|---|---|---|
| **G1** | §904 numerators are gross; the denominator is net | **DONE** — §12 | Form 1116 line 3c/3e/3g apportionment in `_computeFtc`; invariants asserted |
| **G2** | §72(t) early-withdrawal penalty inflates the limitation base | **DONE** — §12 | `regularTax` split out; penalty added after credits |
| **G3** | the re-sourced basket should not exist for this taxpayer | **DONE** — §14 | two baskets; income booked to general/passive by character |
| **G4** | carryforward pools carry no category, so G3 cannot migrate them cleanly | **DONE** — §14 | option A + idempotent fold into general |
| **G5** | Art. 22(4) ordering — the US credit must not erode Australia's 22(2) base | **DONE** — §18 | option (b), pre-credit `regularTax` differential; the apportionment §14.5 wanted was moot, and G10 part 2's caps stopped being inert |
| **G6** | super withdrawals are US-taxed but enter **no** §904 basket | **DONE** — §15.2 | one line; measured −\$44,225 US / +A\$142,148 AU |
| **G7** | AU house sale: no main-residence exemption, unapportioned CGT discount, no §121 | **DEFERRED** — §11 | `au-real-property-classes.js:57-58` unchanged; no `mainResidenceFrom` field exists |
| **G8** | the FITO with/without pass removes the income but keeps its re-sourced numerator | **DONE** — §12 | found by the audit, forced forward by G1's invariant |
| **G9** | AU rental income was floored at zero **per monthly event** | **DONE** — §12 | new; found by G1's invariant on its first run |
| **G10** | the US-source base is sourced by **account domicile**, not by a sourcing rule | **DONE** — §14.3, §15.1, §17 | §865(g)(2) test live; Art. 10/11 caps live but inert; part 3 (Art. 18(1) pensions) landed and the base is down 79% |
| **G11** | Australia is assessing US Social Security, which Art. 18(2) reserves to the US | **DONE** — §16 | measured −A\$401,488 AU / +\$175,645 US; the saving clause loses on Art. 1(4)(a) |

### Audit note — nothing here had been built (2026-08-05)

Design 83 shipped as **documentation only**: commit `24e7579` (2026-07-30) added this
file and touched no source. Every line anchor cited below still resolves to the exact
code it described a week ago, which is itself the proof. Since then `main` has taken
design 84 (Roth/s99B), design 57 Part 3 (CGT top-up), and the spouse AU-return fixes —
none of which touch `_computeFtc`, the §904 baskets, the super classifier, or the AU
house-sale reducer.

Two things *did* move, both in this doc's favour:

- **The missing authorities are now on disk.** `341d5ec` added Reg. §1.402(b)-1,
  Reg. §1.679-1, Rev. Proc. 2020-17, Pub 523, Pub 901 and the Form 3520/3520-A
  instructions to `docs/us-tax/`. §7a.5's open question about super's US character —
  written when none of those were available — is now answerable without new fetching.
- **G5 is no longer unverified.** §7c below traces the handoff and names the defect.

Recommended disposition is in **§11**. Short version: G2 and G1 are cheap and should
land; G3+G4 and G6 are the real money and should land together; G5+G8 need a
measurement before a fix is designed; **G7 stays deferred** — the reference plan never
sells the AU house.

**§12 records what then landed**: G2, G1, G8 and a new G9. **§13** measured G5 and found
G10 underneath it. **§14** landed G3, G4 and G10 part 1. All with measured results.

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

Added by `341d5ec` on the same day, after this section was first written — they are what
close §10's open questions on super's character and on §121:

| file | what it is | which gap it serves |
|---|---|---|
| `CFR-26-1.402(b)-1-Employees-Trusts.txt` | Reg. §1.402(b)-1 | G6 — the non-deferral view of super |
| `CFR-26-1.679-1-Foreign-Trust-US-Beneficiary.txt` | Reg. §1.679-1 | G6 — foreign grantor trust |
| `IRS-Rev-Proc-2020-17-Foreign-Retirement-Trusts.txt` | Rev. Proc. 2020-17 | G6 — 3520 relief, and what it implies about character |
| `IRS-Form-3520-Instructions-2025.txt`, `-3520A-` | reporting | G6 |
| `IRS-Pub-523-Selling-Your-Home-2025.txt` | Pub 523 | G7 — §121, §1250, nonqualified use |
| `IRS-Pub-901-US-Tax-Treaties.txt` | Pub 901 | G3, G5 |

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

## 7. G5 — Art. 22(4) ordering

Art. 22(4) carries a sentence the model does not implement:

> *"The credit so allowed against United States tax **shall not reduce that portion of the
> United States tax that is creditable against Australian tax** in accordance with paragraph (2)."*

This is the classic three-bite ordering for US citizens abroad: Australia credits US tax on
US-source income (22(2)); the US then credits Australian tax (22(4)); and the second credit may
not erode the base of the first.

Originally flagged as unverified. §7c traces it.

---

## 7c. G5 + G8 — the FITO handoff, traced

### 7c.1 G5 — the handoff is measured after the credit it must not be reduced by

`tax-settle-classes.js:101-107`, in `UsTaxSettleHandler.call`:

```js
const withoutState = {
  ...state,
  usOrdinaryIncomeYTD: (state.usOrdinaryIncomeYTD ?? 0) - (state.usSourceOrdinaryUsdYTD ?? 0),
  usCapitalGainsYTD:   (state.usCapitalGainsYTD   ?? 0) - (state.usSourceCapGainsUsdYTD ?? 0),
};
const usTaxWithout    = this._settleService.computeUsTax(withoutState).netLiability;
const usTaxOnUsSource = Math.max(0, taxDetail.netLiability - usTaxWithout);
```

`usTaxOnUsSource` becomes `usTaxPaidOnUsSourceAud`, which is the **entire** input to
Australia's FITO (`au-tax-rates-base.js:318`) — it is the model's Art. 22(2) figure.

Both passes call `computeUsTax`, and `netLiability` is **net of the full FTC** — including
the re-sourced basket, which *is* the Art. 22(4) credit for Australian tax. So the quantity
handed to Australia as "US tax on US-source income" has already been reduced by the credit
for Australian tax. That is precisely what the second sentence of 22(4) forbids.

The with/without differencing is not the problem — it is exact, and design 52 §4.6 chose it
for good reasons. The problem is *which* liability is differenced. The 22(2) figure must be
measured with the 22(4) credit disregarded; the 22(4) credit is then computed against it.
That is a one-directional dependency, not a circularity, and it is why the treaty states the
paragraphs in that order.

### 7c.2 G8 — the "without" pass is internally inconsistent (new)

`withoutState` removes US-source income from `usOrdinaryIncomeYTD` and `usCapitalGainsYTD`,
but leaves `usSourceOrdinaryUsdYTD` / `usSourceCapGainsUsdYTD` untouched — and those two are
exactly the **re-sourced basket's numerator** (`us-tax-rates-base.js:213`). `ftcCurrentResourced`
is left alone too.

So the counterfactual pass computes a US return in which the US-source income has been
removed from the tax base while the credit for the Australian tax on that same income, and
the limitation room justifying it, both remain. Worse, `totalTaxable` falls while the
numerator holds, so the re-sourced *fraction rises* — the "without" return gets a **larger**
re-sourced credit than the real one.

This is a defect on its own terms, independent of G5's ordering question, and it does not
go away under G3: if the re-sourced income is reclassified into general/passive, those
numerators are still not removed by `withoutState`.

### 7c.3 Direction and magnitude

**G8 — measured, and the direction first written here was backwards.** This section
originally reasoned that G8 "overstates `usTaxWithout` ⇒ smaller differential ⇒ less FITO",
and concluded G5 and G8 pushed the same way. That is wrong, and §7c.2's own text says so:
an inflated re-sourced credit makes the without-pass pay *less*, which makes `usTaxWithout`
**smaller**, the differential **wider**, and the FITO **over**-funded. Australia was
under-taxed, not over-taxed.

Measured on the reference plan by reverting G8 alone against the shipped build
(`scripts/probes/probe-904-limitation.mjs` plus the AU settle totals):

| | lifetime US tax | lifetime AU tax |
|---|---|---|
| G8 fixed vs not | **−US\$42,520** | **+A\$64,262** |

Australia collects the tax it should have; the US then credits most of it back. Nobody's
intuition about the sign survived contact with the numbers here — the same lesson as
[[design-84-g11-conversion-provenance]], on the third consecutive gap.

**G5 remains unmeasured and its sign is not assumed.** The reasoning is that it understates
the 22(2) figure (a credit has been netted off) ⇒ less FITO ⇒ more AU tax, part of which
returns as creditable foreign tax in a later US year. Given the G8 record, treat that as a
hypothesis. **Measure before designing the fix**: §11 step 4 gives the procedure.

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
  §402(b), the grantor-trust rules, and Rev. Proc. 2020-17.
  **Update 2026-08-05:** all three are now on disk (`CFR-26-1.402(b)-1-Employees-Trusts.txt`,
  `CFR-26-1.679-1-Foreign-Trust-US-Beneficiary.txt`,
  `IRS-Rev-Proc-2020-17-Foreign-Retirement-Trusts.txt`), added by `341d5ec`. The blocker on
  that question is now analysis time, not documents — but it is still **out of scope for G6**,
  which implements the model's existing deferral position rather than re-litigating it.

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
5. **G5 + G8** — now diagnosed (§7c); measure, then fix. G8 is mechanical and can land
   ahead of the G5 ordering decision.

§11 turns this into a sequenced plan with the disposition of each gap.

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
| 19 | Does the FITO handoff honour Art. 22(4) non-erosion? | **No — it differences a post-FTC liability** | §7c.1; `tax-settle-classes.js:107` |
| 20 | Fix G8 before or after the G5 ordering decision? | **Before — it is independent** | the "without" pass is inconsistent on its own terms and stays wrong under G3 (§7c.2) |
| 21 | Build G7 now? | **No — defer** | the reference plan never sells the AU house; it is the largest gap and the only wholly inert one (§11) |
| 22 | Is Form 1116 line 3c just the standard deduction? | **No — 3a + 3b** | line 3b takes Schedule 1 Part II adjustments (½ SE tax, deductible contributions); including them is what makes Σ fractions ≤ 1 provable (§12.1) |
| 23 | Does the Form 2555 exclusion reduce the apportionment fraction? | **No — only the numerator** | instructions: lines 3d and 3e both "include any foreign earned income you have excluded on Form 2555"; line 1a does not |
| 24 | Assert the §904 invariants at runtime, or only in tests? | **Runtime, strict-gated** | `FTC_LIMITATION_STRICT` on the `AU_ATTRIBUTION_STRICT` pattern — it caught G8 and G9 within one run of landing (§12.1) |
| 25 | Should the §904 basket floor be per event or per year? | **Per year** | a monthly floor discards loss months and breaks the partition — G9 (§12.1) |
| 26 | Implement the G5 ordering fix now? | ~~No — option (c)~~ **Superseded: built after G10, §18** | the sequencing call was right; on the corrected base the fix is option (b) and G10 part 2's caps hold it to \$693k instead of \$1.09m |
| 27 | Is a US brokerage gain US-source for an AU-resident US citizen? | **No — foreign source** | §865(a)/(g)(1)(A)(i)(I) sources personal property by the seller's tax home, subject to the §865(g)(2) 10% test; Art 21(2) needs a US source that isn't there |
| 28 | Is the FITO input the citizen's marginal US tax? | **No — the treaty-capped source tax** | Art 22(2) excludes tax imposed "solely by reason of citizenship"; Art 10/11 cap it at 15%/10% |
| 29 | Should Australia assess US Social Security? | **No** | Art 18(2): taxable *only* in the paying State, for a resident of the other State **or a US citizen** (§13.5) |
| 30 | Can Australia's saving clause reach it back anyway? | **No** | Art 1(4)(a) names "paragraph (2) … of Article 18" as exempt from Art 1(3); the Protocol left both untouched (§16.1) |
| 31 | Does US Social Security stay in the Art. 22(2) base? | **No — it leaves entirely** | 22(2)'s credit is capped at "Australian tax payable on the income", which is now zero; this revises §13.2's table row (§16.2) |
| 32 | Does it keep a §904 basket numerator? | **No** | Art 27(1)(c) resources only "to the extent necessary" for Art 22(4) relief, and none is due (§16.2) |
| 33 | Does Art 18(1) reach a US retirement distribution? | **Yes for a periodic one** | Art 18(4) requires "periodic payments … by reason of retirement or death"; RMDs and inherited-account series qualify, discretionary drawdowns do not (§17.2) |
| 34 | Then is the US tax on it creditable by Australia? | **No** | 18(1) is *absent* from Art 1(4)(a), so the US charge is saving-clause-only, and Art 22(2)/27(1)(b) exclude citizenship tax (§17.1) |
| 35 | Which accumulator carries an Art 18(1) pension? | **`foreignGeneralIncomeYTD`** | it must be in the §904 numerator and out of the FITO counterfactual; that is exactly the genuinely-foreign accumulator (§17.3) |
| 36 | Split contributory from rollover IRA money for Art 18(4)? | **No — record the doubt** | no field distinguishes them, and this plan's IRA is rollover-funded; design 84 G9's ledger is what a contributory-heavy plan would need (§17.6) |
| 37 | Which G5 option, now that (a) is a no-op? | **(b) — the pre-credit differential** | after G3 every credit in every basket *is* Art 22(4) relief, so there is nothing to apportion and the whole of it is what the non-erosion sentence protects against (§18.1) |
| 38 | Pre-credit on `regularTax` or `grossTax`? | **`regularTax`** | §26(b)(1) — the same line G2 drew for the §904 base; keeps §72(t), NIIT, SECA and Additional Medicare out, matching Art 2 (§18.2) |
| 39 | Is option (b) the ~4× over-credit §13.3 feared? | **No — the Art 10/11 caps bind** | uncapped \$1.09m, capped \$693k against a \$767k ceiling; G10 part 2 went from 0 binding years to 20 (§18.3) |
| 40 | Total tax rises — is that a reason not to do it? | **No** | the AU tax G5 forgives was recoverable as US FTC, so forgiving it costs the household; the sign is plan-specific and correctness is the criterion (§18.4) |

---

## 10. Open questions

- ~~**G5** — does the FITO ↔ FTC handoff honour Art. 22(4)'s non-erosion sentence?~~
  **Answered 2026-08-05: no** — §7c.1. It differences a post-FTC `netLiability`. What
  remains open is the *magnitude*, and the design of the fix (§11 step 4).
- ~~**G8, new** — what is the combined FITO error from G5 + G8?~~ **G8 measured and built
  (§12.2); G5 measured (§13.1).** What is still open is whether the §865(g)(2) 10% test
  ever *fails* on a real path — a year where Australia taxes a gain at under 10% of it
  (large carried-forward capital losses, or a gain realised while non-resident) would flip
  that gain back to US-source. G10 must implement the test, not assume the result.
- ~~**Does Art. 18(1) reach a contributory IRA?**~~ **Position recorded and built —
  §17.** The build turned on a different element than expected: Art. 18(4)'s
  *"periodic"* requirement splits RMDs from discretionary drawdowns cleanly, and
  Art. 1(4)(a)'s omission of 18(1) is what makes the US charge citizenship-only. The
  *"in consideration for services rendered"* doubt survives for a genuinely
  contributory IRA and is **recorded, not resolved** (§17.6): no field separates
  rollover-funded from contribution-funded money inside an IRA, and this plan's IRA is
  rollover-funded, so there is almost nothing for the contested reading to bite on.
  Design 84 G9's rollover ledger is what a contributory-heavy plan would need.
- §904(f) overall foreign loss recapture is unmodelled; it is what makes the \$87k figure
  approximate, and it bites hardest in thin-income years.
- **Does s118-192's deemed acquisition also reset the s115-105 discount testing period?**
  s115-105(2)(d)(i) fixes the period from *"the day you acquired the CGT asset"*, and s115-30
  carries special acquisition rules. If it does reset, sub-case 2a gains materially on the
  discount as well as the cost base. Unverified — do not build on it.
- **Is Australian super actually tax-deferred for US purposes?** §7a.5 — the model assumes yes;
  the grantor-trust / §402(b) view says no, and flips G6's basket from general to passive.
  Needs §402(b), the foreign grantor-trust rules, and Rev. Proc. 2020-17 — **all three now
  on disk** (§1), so this is answerable whenever it is worth the time.
- The Convention text checked in is the 1982 original. The 2001 Protocol amendments are in a
  separate file and have **not** been merged into a consolidated text — Art. 27(1)(c) survives
  unamended, which is what §5.1 relies on, but any *other* article cited later must be read
  against both files.

---

## 11. Disposition and plan (2026-08-05)

Eight gaps, four dispositions. The ordering below is by dependency, not by size.

| gap | disposition | why |
|---|---|---|
| G2 | ~~BUILD — step 1~~ **DONE (§12)** | one line; wrong on its face; CY2030's limitation base is 12× too large |
| G1 | ~~BUILD — step 2~~ **DONE (§12)** | ≈\$87k of over-credit predicted, \$97,335 measured; makes the §904 invariants assertable |
| G8 | ~~BUILD — step 3~~ **DONE (§12)** | mechanical, independent, survives G3 — and G1's invariant forced it forward |
| G9 | **DONE (§12)** | did not exist when this table was written; found by G1's invariant on its first run |
| G3+G4 | **BUILD — step 5** | removes a basket that should not exist; unlocks G6 |
| G6 | **BUILD — step 6** | ≈\$26k; inert alone, so it rides with G3 |
| G5 | **MEASURE — step 4, then decide** | diagnosed but unsigned; the fix touches the FITO↔FTC contract |
| §904(f) | **LEAVE — see below** | |
| G7 | **LEAVE — see below** | |

### Step 1 — G2: penalties out of the limitation base

`us-tax-rates-base.js:172`. Split the Chapter-1 income tax from the §72(t) additional tax:
keep `penaltyTax` in `grossTax` and `netLiability`, remove it from the figure passed to
`_computeFtc` as `grossTax`. Mirror exactly how NIIT/SECA/Additional Medicare are already
handled two lines down — the pattern exists, the penalty was just left on the wrong side.
The stale comment on line 169-170 must go with it.

**Test**: a year with a large early-withdrawal penalty and foreign income — the FTC limit
must not move when the penalty does.

**Expect the golden to move.** One-directional (less credit ⇒ more US tax), largest in
penalty-heavy years (CY2030).

### Step 2 — G1: apportion the standard deduction

Form 1116 line 3g. Every input already exists:

- `3e` (gross income, all sources) = `totalGrossIncome`, already computed at
  `us-tax-rates-base.js:224` — just computed *after* `_computeFtc` and never passed in.
- `3d` (gross foreign income in category) = the numerators already passed.
- `3c` = `stdDeduction`, already in scope.

So the change is: move the `totalGrossIncome` computation above the `_computeFtc` call,
pass it in, and inside `basket()` form the numerator as
`max(0, gross − stdDeduction × gross/3e)` before dividing by `totalTaxable`.

**Then assert the invariants** (§8): Σ fractions ≤ 1, numerator ≤ denominator per basket
pre-clamp, base excludes NIIT/SECA/AddlMedicare/§72(t), Σ credits ≤ base. These are the
permanent guard, and §8 already notes `npm run crossfoot` cannot see them — they belong as
unit assertions in `_computeFtc`, not as worksheet crossfoots.

**Known incompleteness, accept it**: where the apportioned deduction exceeds a basket's
gross income, a real return carries a §904(f) foreign loss with recapture. Clamping to zero
is the same approximation the \$87k estimate used. Record it in the code comment.

### Step 3 — G8: make the "without" pass consistent

`tax-settle-classes.js:101-105`. `withoutState` must also zero `usSourceOrdinaryUsdYTD`,
`usSourceCapGainsUsdYTD` and `ftcCurrentResourced` — the counterfactual is "this taxpayer
had no US-source income", and such a taxpayer has no re-sourced numerator and no Australian
tax on US-source income to credit.

This is a pure bug fix and can land before the G5 ordering question is settled.

**Test**: in the without-pass, `ftc.resourced.credit` must be 0.

### Step 4 — G5: measure, then design

Do **not** design the fix first. Instrument, run, then choose. Procedure:

1. Add a temporary probe under `scripts/probes/` that, at each US settle, records
   `netLiability`, `usTaxWithout`, `usTaxOnUsSource`, and a second differential computed
   with the re-sourced/22(4) credit suppressed in both passes.
2. Run the reference scenario full-horizon; report per-year FITO delta and the lifetime
   AU-tax and US-tax deltas. [[defer-long-mc-reruns]] — this is a single deterministic run,
   not an MC sweep, so it is cheap.
3. Only then decide between:
   - **(a) suppress the 22(4) credit in both passes** — measure the 22(2) figure from a
     liability that credits only the general/passive baskets. Smallest change; matches the
     treaty's stated ordering.
   - **(b) compute the 22(2) figure pre-FTC entirely** — arguably over-corrects, since the
     general/passive credits are not 22(4) relief on US-source income.
   - **(c) leave it**, if the measured effect is immaterial, and record that as a decision.

Sequencing note: run this **after** steps 1–3 and again after step 5. G3 removes the
re-sourced basket, which is the very thing (a) proposes to suppress — the fix may become
trivial or moot. If the step-4 measurement is small, defer the decision until after G3.

### Step 5 — G3 + G4: delete the re-sourced basket

Blast radius is small and fully enumerated:

| file | change |
|---|---|
| `us-tax-rates-base.js` | drop `resourcedNumerator` / the `resourced` basket from `_computeFtc` |
| `tax-settle-classes.js:328` | route `usSourceAuTax` into general/passive by the character of the underlying income, not into `ftcCurrentResourced` |
| `us-tax-document-2026.js:155-159,223` | remove the re-sourced worksheet rows |
| `us-tax-toolset.js:101,104` | drop `ftcCurrentResourced` / `ftcPoolResourced` |
| `intl-retirement-state.js:161,164` | same |
| `state-schema-registry.js:263,267` | deregister both |
| `tests/unit/ftc-us-source-not-creditable.test.mjs`, `tax-cross-border-relief.test.mjs`, `cross-border-relief-scenario.test.mjs` | re-baseline |

The classification map is §5.3. Note that `_extraStatePatches` currently splits the
*general/passive* creditable amount by a general/passive **income** ratio
(`tax-settle-classes.js:310-316`) — the re-sourced AU tax needs the same treatment against
its own income's character, which is where G4 option **C** (carry the category on the
vintage) earns its place.

**G4: option A (re-derive) for the pools.** A simulator has no filed return to preserve.
Saved states carrying a non-empty `ftcPoolResourced` need a migration that folds the
balance into `ftcPoolGeneral` — a lossy but bounded one-liner, and the alternative
(option B apportionment) is not worth the machinery.

**This is the golden re-baseline.** Do it as its own commit.

### Step 6 — G6: super into the general basket

`au-tax-module-2026.js:324-327` — add `foreignGeneralIncomeYTD` alongside
`usOrdinaryIncomeYTD`. One line. It must land **with or after** step 5, because
`foreignGeneralIncomeYTD` is 0.00 in every year of the current export: without G3's
reclassification there is no general-basket tax to fill the room with, and the change
reads as inert (see [[mpc-lever-tests-scenario-shaped]] — a zero delta here would mean an
inert scenario, not a working fix).

**Test**: a super-withdrawal year must show a non-zero general numerator; paired with G3,
CY2044's credit should rise. §7a.4's \$26,481 is the target order of magnitude, not a
number to assert on.

### What to leave outstanding, and why

**G7 — the AU house sale. Leave it.** This is the largest single body of work in the doc
(§7b.5 is six steps, one of which — apportioning the CGT discount by residency days —
touches *every* AU CGT asset and needs its own golden re-baseline; another needs a US
§1250 25% rate bucket that does not exist anywhere in `us-tax-rates-base.js`). Against
that: **the reference plan never sells the AU house**, so every line of it is inert today,
and case 1 (sell while non-resident) is already correct — by omission, but correct.

The specific danger §7b.3 names is worth restating, because it is the reason *not* to do
this piecemeal: adding a naive main-residence exemption **without** the s118-110(3)
foreign-resident gate would break the case that currently works. G7 is all-or-nothing.

Revisit when either (a) a scenario actually sells the AU dwelling, or (b) the
`mainResidenceFrom` lever is wanted as an optimiser axis — §7b.2c already argues it is a
clean scalar like `moveYear`, which is the strongest reason to build it eventually.

**§904(f) overall foreign loss recapture. Leave it.** It is what makes the \$87k figure
approximate and it bites hardest in thin-income years, which are exactly the years where
the absolute dollars are smallest. Build it only if the step-2 invariants start tripping
the zero-clamp often enough to matter — the assertion will tell us.

**The super-deferral question (§7a.5). Leave it.** The documents are now on disk, so this
is no longer blocked, but it is a *position* change, not a defect fix: it would flip G6's
basket from general to passive and re-characterise contributions and in-fund earnings as
currently taxable. That is a much larger modelling change than G6, it is genuinely
unsettled in practice, and the model's current deferral position is internally consistent.
G6 should not wait for it.

---

## 12. Implemented — G2, G1, G8, G9 (2026-08-05, `wip/au-us-tax-treaty-intricacies`)

Steps 1–3 of §11, plus one gap that did not exist when §11 was written.

### 12.1 What changed

**G2 — `us-tax-rates-base.js`.** The Chapter-1 tax is split into `regularTax`
(§26(b)(1): ordinary + LTCG + collectibles) and `penaltyTax` (§72(t)). `_computeFtc`
receives `regularTax` as the limitation base; the penalty rides in `grossTax` and is added
to `netLiability` **after** the credit, on the same side of the line as NIIT / SECA /
Additional Medicare. `regularTax` is exposed on the result so the split is checkable.

**G1 — `us-tax-rates-base.js`.** `_computeFtc` now takes each basket's **gross** income
(Form 1116 line 3d) plus `grossIncomeAllSources` (3e) and `unrelatedDeductions` (3c), and
forms line 7 = `(3d − Form 2555 exclusion) − 3c × (3d ÷ 3e)`.

The one judgement call: **3c is not just the standard deduction.** Line 3b takes "any other
deductions that don't definitely relate to any specific type of income (for example,
deductions shown on Schedule 1 (Form 1040), Part II, Adjustments to Income)", so it also
carries the ½-SE-tax deduction and `usNegativeIncomeYTD` (deductible IRA/401k
contributions). §3's worked example apportioned the standard deduction alone; that is why
its figures and the shipped ones differ slightly. Including all three is not cosmetic — it
makes the identity

```
totalTaxable = grossIncomeAllSources − unrelatedDeductions − FEIE
```

hold **exactly**, which is what proves Σ numerators ≤ the denominator. Apportioning the
standard deduction alone leaves the other deductions unallocated and the fractions can
still overshoot.

Two subtleties from the instructions, both load-bearing:

- lines 3d and 3e *include* income excluded on Form 2555, even though line 1a excludes it.
  The exclusion is subtracted from the numerator, never from the apportionment fraction.
- the zero clamp on line 7 stands in for a §904(f) overall foreign loss with recapture,
  which is unmodelled. Recorded in code, and §10 keeps it as accepted.

**The invariants are now asserted** — `_assertFtcInvariants`, gated by
`FTC_LIMITATION_STRICT` on the `AU_ATTRIBUTION_STRICT` pattern (throw in dev/test, warn in
a production build). Three of §8's four: per-basket numerator ≤ denominator, Σ fractions
≤ 1, Σ credit ≤ the limitation base. The fourth (the base excludes NIIT/SECA/§72(t)) is
structural after G2 and is covered by a test instead.

**G8 — `tax-settle-classes.js`.** `withoutState` now also zeroes `usSourceOrdinaryUsdYTD`,
`usSourceCapGainsUsdYTD`, `ftcCurrentResourced` and `ftcPoolResourced`. §11 had this as an
independent step 3; the G1 invariant made it mandatory, because the old counterfactual
violated the invariant on its very first cross-border year.

**G9 (new) — `au-tax-module-2026.js`.** `AU_RENTAL_INCOME_TAX` floored the §904 passive
accumulator at zero **per monthly event**, while sending the signed amount to
`usOrdinaryIncomeYTD`. A geared property books negative months, so the positive months were
summed into the basket and the negative ones discarded: `foreignPassiveIncomeYTD` drifted
above the rent that reached the US totals, and the baskets stopped partitioning gross
income. Now signed into both; `computeTax` applies the single annual floor when it forms
the numerator.

This one is worth dwelling on. It is not a §904 defect at all — it is an accumulator that
had been wrong since design 52 — and **nothing in the model could see it** until the
partition became an asserted invariant. It surfaced on the first run after G1 landed.

### 12.2 Measured on the reference plan

`scripts/probes/probe-904-limitation.mjs` (new — it prints the limitation for every year of
a run, which no existing view did) against `main` @ `1cc2176`:

| | before | after |
|---|---|---|
| years with Σ fractions > 1 | **36 of 44** | **0** |
| worst Σ fractions | **1.69285** | 1.00000 |
| lifetime FTC credit | \$4,386,469 | \$4,289,134 |

**Over-credit removed: \$97,335.** §3 predicted "≈ \$87k" from a hand rebuild of the
export, so the estimate was good to about 11% — and the caveat it carried (the §904(f)
clamp) points the right way.

Lifetime tax, all four changes together:

| | lifetime US tax | lifetime AU tax |
|---|---|---|
| baseline | \$1,192,867 | A\$14,628,982 |
| shipped | \$1,225,115 | A\$14,546,741 |
| **delta** | **+\$32,249** | **−A\$82,241** |

Decomposed by reverting G8 alone:

| | lifetime US tax | lifetime AU tax |
|---|---|---|
| G1 + G2 + G9 | +\$74,769 | −A\$146,502 |
| G8 | −\$42,520 | +A\$64,262 |

Note that removing \$97,335 of credit only raises US tax by \$74,769 (before G8): the rest
was credit that never reduced a liability — it was capped by the shared headroom or banked
into a carryforward pool that later expired.

### 12.3 What this cost in re-baselining

Four tests moved, all with the arithmetic redone by hand rather than to the new output:

- `FTC-2`, `FTC-3` (`tax-cross-border-relief`) — the limits change because the numerator is
  now line 7. FTC-2: passive line 7 = 10,000 − 30,000×0.1 = 7,000, so the limit is
  7,923 × 0.1 = **792.30**, down from 1,131.857 on the gross numerator.
- `TWE-30` — the worksheet labels changed, and it now also checks that
  `3g = 3c × (3d ÷ 3e)` is recomputable from the exported rows alone.
- `EVT-RENT-12` — inverted by G9: the assertion was that a rental loss leaves
  `foreignPassiveIncomeYTD` untouched. It now asserts the opposite, and that the delta
  equals the `usOrdinaryIncomeYTD` delta — the equality that keeps the baskets a partition.

Three tests added: `FTC-G2` (the penalty moves `grossTax` and `netLiability` by exactly
itself and the limit not at all), and two `FTC-G1` cases (all-foreign income ⇒ fractions sum
to exactly 1; the SE and contribution deductions are apportioned too).

Suite: **4,370 pass, 0 fail.**

### 12.4 Correction

§7c.3 originally predicted that G8 would push the same way as G5 — less FITO, more AU tax.
Backwards, and §7c.2's own mechanism said so. The inflated re-sourced credit made the
counterfactual pass *cheaper*, which **widened** the differential and **over**-funded FITO.
Fixing it raises AU tax and lowers US tax. §7c.3 now carries the measured figures.

Three consecutive gaps in this family have now had their direction predicted wrongly before
measurement (this one, design 84 G11, design 84 G9). Treat any unmeasured sign claim about
the FITO ↔ FTC handoff as a hypothesis.

### 12.5 Next

§11 steps 4–6 are untouched: **G5** (measure, then decide), then **G3 + G4**, then **G6**.
G5's measurement is now cheaper than §11 assumed, because `probe-904-limitation.mjs` and
the AU settle totalling used in §12.2 already exist.

> **Superseded by §13.** G5 was measured and the answer was to *not* build it yet — the
> measurement uncovered G10, and G5 must follow it. Revised order: **G3 + G4 + G10**, then
> **G6**, then **G5**.

---

## 13. G5 measured — and why it must NOT be implemented yet (2026-08-05)

§11 step 4 said measure before designing the fix, and run it after G3 in case G3 makes it
moot. The measurement did something better than settle the ordering question: it showed
that the **base** the ordering operates on is wrong, and that fixing G5 first would make
the model less accurate, not more.

`scripts/probes/probe-fito-handoff.mjs` (new) computes the Art. 22(2) figure four ways on
one run, wrapping `UsTaxSettleHandler.call` so every variant sees identical accumulators.

### 13.1 G5 is real, and it is the dominant term

| lifetime FITO funding (USD) | |
|---|---|
| **V0** — as shipped: `netLiability(full) − netLiability(without)` | **\$838,813** |
| **V1** — option (a): the same differential with the Art. 22(4) credit suppressed in both passes | **\$4,900,156** |
| **V2** — option (b): pre-credit (`grossTax`) differential | **\$4,938,035** |

**5.8×.** And the mechanism is exact, not approximate — in every year where the §904
headroom does not bind, `V1 − V0` equals the re-sourced basket credit to the dollar:

| year | 22(4) credit | V0 | V1 | V1 − V0 |
|---|---|---|---|---|
| 2047 | 384,081 | 80,431 | 464,512 | **384,081** |
| 2054 | 1,019,125 | 192,139 | 1,211,263 | **1,019,124** |
| 2067 | 1,261,331 | 266,005 | 1,527,336 | **1,261,331** |

That is the non-erosion sentence being violated in the most literal possible way: the US
charges \$1.21m on US-source income in 2054, hands \$1.02m of it straight back as a credit
for Australian tax, and then tells Australia that only \$192k of US tax was paid. Australia
credits the \$192k and taxes the rest. **Decision #19 is confirmed — with a mechanism, not
just a reading.**

V1 and V2 differ by under 1%, so the choice between options (a) and (b) is immaterial;
(a) is the smaller and more principled change and would be the one to make.

### 13.2 But the base is over-inclusive by ~72%

The same probe reports what `usSource*UsdYTD` actually contains over the run:

| item | lifetime USD | share | governing rule | US-source for 22(2)? |
|---|---|---|---|---|
| `STOCK_WITHDRAWAL_TAX` → capital gains | 19,434,876 | **68.5%** | §865(a); Art 13/21 | **No** |
| `STOCK_DIVIDEND_TAX` | 3,217,211 | 11.3% | §861(a)(2); Art 10 | Yes — **capped at 15%** |
| `BOND_COUPON_TAX` | 2,136,668 | 7.5% | §861(a)(1); Art 11 | Yes — **capped at 10%** |
| `SS_INCOME_TAX` | 1,775,749 | 6.3% | Art 18(2) | Yes — **in full** |
| `COLLECTIBLE_SALE_TAX` → capital gains | 878,061 | 3.1% | §865(a) | **No** |
| `CASH_SLEEVE_INTEREST_APPLY` | 712,692 | 2.5% | §861(a)(1); Art 11 | Yes — capped at 10% |
| `IRA_RMD_TAX` + `IRA_WITHDRAWAL_EARNINGS_TAX` | 219,575 | 0.8% | Art 18(1) | **Probably not** |
| `US_SAVINGS_INTEREST_CREDIT` | 5,101 | 0.0% | §861(a)(1) | Yes — capped |
| **total** | **28,379,933** | | | |

**The capital gains — 71.6% of the base — are not US-source at all.** Two independent
authorities say so:

- **§865(a)** sources gain on personal property by the **residence of the seller**, and
  §865(g)(1)(A)(i)(I) makes a US citizen a "United States resident" only if they do *not*
  have a tax home in a foreign country. A US citizen resident in Australia is a
  **nonresident** for this section, so the gain is **foreign source under US domestic law**.
  §865(g)(2) attaches a condition worth implementing rather than assuming: the citizen is
  treated as a nonresident *"unless an income tax equal to at least 10 percent of the gain
  … is actually paid to a foreign country"*. Australia taxes these gains at up to 45%, or
  ~22.5% after the CGT discount, so the condition is comfortably met — but it is a real
  test the model can evaluate, not a blanket rule.
- **Art 21(2)** (portfolio share gains are not mentioned in Art 13, even as amended by
  Art 9 of the Protocol) allows source-state taxation only *"if such income is derived …
  **from sources in** the other Contracting State"*. It is not. And Art 27(1)(b) expressly
  refuses to deem income US-source for 22(2) purposes when the US taxes it *"solely by
  reason of citizenship"*.

The model classifies these gains as US-source for one reason only: the brokerage account is
US-domiciled (`us-tax-module-2026.js`, `STOCK_WITHDRAWAL_TAX`, on the `isAuResident`
branch). Account domicile is not a sourcing rule for personal property.

### 13.3 Why that changes the recommendation

The two defects multiply rather than add. On the treaty-correct base, the 22(2) figure is
roughly

```
15% × dividends 3.22m  +  10% × interest 2.85m  +  full US tax on SS 1.78m
```

— order of magnitude **\$1.1–1.3m** lifetime. *(Arithmetic on the composition table above,
not a model run. Treat it as a bound, not a number.)*

Against that:

| | lifetime FITO |
|---|---|
| V0 as shipped | \$838,813 |
| treaty-correct, rough | **≈\$1.1–1.3m** |
| V1 (G5 fixed, base unfixed) | \$4,900,156 |

**V0 is wrong but close. V1 is right about the ordering and wrong by roughly 4× overall.**
Two errors happen to be partly cancelling: measuring after the 22(4) credit suppresses the
figure, and an over-inclusive base inflates it. Fixing only the half that is easy to fix
converts a modest under-credit into a large over-credit, and Australia would forgive tax it
is owed on the strength of US tax that was never creditable to it.

**Decision: option (c) — leave G5 for now, and fix the base first.** This is not "leave it
forever" and it is not the reading changing; §13.1 stands. It is a sequencing call of the
same shape as G6 being inert before G3.

### 13.4 New: G10 — the US-source base is over-inclusive

**PROPOSED.** `usSourceOrdinaryUsdYTD` / `usSourceCapGainsUsdYTD` are populated by account
domicile rather than by a sourcing rule. Consequences reach further than FITO: these
accumulators are also the re-sourced §904 basket's numerator, so misclassified income
creates limitation room in the wrong basket on the US return too. If the gains are foreign
source, they belong in **passive** — which is where G3 would put them anyway, from the
opposite direction.

That overlap is the sequencing answer: **G10 should be built with G3+G4**, not before them.
The work is the same work — deciding, once, what each item of income is and which basket it
belongs in.

Sub-parts, in descending size:

1. **Capital gains on personal property → foreign source**, gated on the §865(g)(2) 10% test
   against the AU tax actually paid on the gain. 71.6% of the base.
2. **Treaty rate caps on the 22(2) figure** — Art 10 dividends 15%, Art 11 interest 10%.
   The FITO input is not the citizen's marginal US tax on that income; it is what the US
   could have charged a plain Australian resident.
3. **Pensions (Art 18(1))** — taxable only in the residence state. Small here (0.8%) and
   genuinely contested for a contributory IRA, which Art 18(4) may not reach
   (*"in consideration for services rendered"*). Record the position rather than assume it.

Only after 1 and 2 does the G5 ordering fix produce a number worth having.

### 13.5 New: G11 — Australia is taxing US Social Security

**PROPOSED, and independent of everything above.** Art 18(2):

> *"Social Security payments and other public pensions paid by one of the Contracting
> States to an individual who is a resident of the other Contracting State **or a citizen
> of the United States** shall be taxable **only in the first-mentioned State**."*

US social security paid to a US citizen resident in Australia is taxable **only in the
United States**. `SS_INCOME_TAX` on the `isAuResident` branch adds the full AUD amount to
`auOrdinaryIncomeYTD`, so the model assesses it in Australia and then relieves the double
tax through FITO. The relief roughly masks the error, which is why it has survived — but
the AU marginal rate is generally the higher one, so the residue is a real over-tax, and
the FITO limit is computed off an assessable base that should not include the payment at
all.

Note the asymmetry this creates with §13.2: US social security is one of the few items in
the table that genuinely *is* US-taxable in full for 22(2) purposes — and it is the one
item Australia should not be taxing.

### 13.6 Status after this session

| gap | status |
|---|---|
| G5 | **ANSWERED, deliberately not implemented** — §13.3; blocked on G10 |
| G10 | **PROPOSED** — build with G3+G4 |
| G11 | **PROPOSED** — independent, small, self-contained |

Revised order for §11: **G3 + G4 + G10** together, then **G6**, then **G5**, with **G11**
droppable in anywhere. G7 stays deferred.

---

## 14. Implemented — G3, G4, G10 part 1 (2026-08-05)

§11 step 5 plus the sub-part of G10 that §13.4 said had to travel with it.

### 14.1 G3 — two baskets, not three

The re-sourced basket is gone from `_computeFtc`, the settle reducer, the state, the
schema registry, the toolset and the 1040 worksheet. Re-sourced income now lands in
general or passive **by character**, booked at the point of classification: pensions,
wages, SE income and social security to general; interest, dividends, rents and gains
to passive (§5.3).

The AU-side funding got *simpler*, which is the tell that G3 was the right call.
`_extraStatePatches` used to subtract the AU tax on US-source income and stage it in
the third basket; now the whole AU liability is creditable and is apportioned across
two baskets by basket income share. `_auTaxOnUsSourceIncome` — ~50 lines of
per-person `fitoLimit` reasoning — deleted entirely.

**One design point that is load-bearing.** The re-sourced income is kept in its own
accumulators (`usSourceGeneralUsdYTD` / `usSourcePassiveUsdYTD`) rather than added
straight into `foreign*IncomeYTD`. It has to be: the FITO handoff re-runs the whole
return on a counterfactual with US-source income removed, and it must be able to
remove it *from the baskets too*. Merged at source, that is impossible.

This was not foreseen — the first implementation did merge them, and the §904
invariants failed on the counterfactual pass within one test run, reporting fractions
summing to 1.035 on a return whose income had been removed but whose limitation room
had not. Same class of defect as G8, in a new place, caught the same way.

### 14.2 G4 — heal, don't migrate

Option A (re-derive) with C folded in. `_computeFtc` adds any surviving
`ftcCurrentResourced` / `ftcPoolResourced` into general — the residual §904 category —
merging vintage pools key-wise, and the settle clears `ftcPoolResourced` so the heal
is **idempotent**. Without that clear the same vintages would be folded in again at
every later settle, turning a one-off migration into a growing phantom pool.

A fresh run never populates these, so on any re-derived scenario the fold is a no-op.
It exists only so a state saved before G3 does not silently lose real balances.

### 14.3 G10 part 1 — sourcing by the seller, not by the account

`STOCK_WITHDRAWAL_TAX`, `COMPANY_SALE_TAX` and `COLLECTIBLE_SALE_TAX` no longer treat
their gains as US-source for an AU-resident US citizen. They are **foreign source**
under §865(a)(2), so they book as genuine foreign passive income and leave the
Art. 22(2) removal set in both currencies.

`US_HOUSE_SALE_TAX` is deliberately untouched: real property is US-source under
§861(a)(5)/§865(c), and Art. 13(1) confirms the US may tax it.

**The §865(g)(2) test is implemented, not assumed.** That paragraph treats a citizen
as a nonresident *"unless an income tax equal to at least 10 percent of the gain … is
actually paid to a foreign country"*. So `au-tax-rates-base.js` now measures the
effective AU rate on each year's capital gains — with/without, the same technique as
the §770-75 FITO limit, because the CGT discount and the bracket the gain lands in
make any proportional split wrong — and the US classifiers gate on it.

On the one-settle lag: the AU FY ends 30 June and the US CY on 31 December, so a real
filer always knows the AU tax on the earlier gains of a US tax year and estimates the
later ones. Carrying the prior settle's realised rate is that same position rather
than an approximation invented for the model.

**Measured on the reference plan: 38 years carry a rate, spanning 22.54%–46.25%
(median 34.83%), and none falls below the 10% floor.** So on this plan the gate never
bites — but it is a live test, not a comment, and §10's open question ("does it ever
fail?") is answered *for this plan only*. A year with large carried-forward capital
losses, or a discounted gain against Australia's lowest bracket (~8%), would flip it.

### 14.4 Measured

Lifetime, reference plan, each step against the previous:

| | lifetime US tax | lifetime AU tax |
|---|---|---|
| after G1/G2/G8/G9 (§12) | \$1,225,115 | A\$14,546,741 |
| **+ G3 + G4** | \$1,421,198 (**+\$196,082**) | A\$14,283,386 (**−A\$263,355**) |
| **+ G10 part 1** | \$1,378,814 (**−\$42,384**) | A\$14,631,447 (**+A\$348,060**) |
| net of this session | **+\$153,698** | **+A\$84,705** |

G10's direction is exactly what §13.2 predicted: pulling 71.6% of the base out of the
FITO removal set means less FITO, so Australia collects more — and most of that comes
back as US foreign tax credit, so US tax falls. Lifetime FTC across the whole of
design 83 now runs \$4,386,469 → \$3,884,645.

Σ §904 fractions stay ≤ 1 in every year of every run.

### 14.5 G5 got HARDER, not moot

§11 step 4 warned the G5 fix "may become trivial or moot" after G3. It is neither.
Re-running `probe-fito-handoff.mjs`:

| | before G3 (§13.1) | after G3 + G10 |
|---|---|---|
| V0 as shipped | \$838,813 | **\$355,762** |
| V1 — 22(4) credit suppressed | \$4,900,156 | **\$355,762 — identical** |
| V2 — pre-credit | \$4,938,035 | \$1,361,034 |

**V1 is now a no-op.** Deleting the re-sourced basket removed the one credit line that
*was* the Art. 22(4) relief; it is blended into general and passive, so it can no
longer be suppressed by zeroing a basket. The erosion itself is undiminished — V2 still
exceeds V0 by ~\$1.0m lifetime — it simply stopped being separable, and option (a) as
§11 described it no longer exists as a code change.

Worth noting without over-reading it: §13.3's rough treaty-correct estimate was
\$1.1–1.3m lifetime, and V2 on the corrected base is \$1,361,034. Same order of
magnitude, but they are different quantities — V2 is a pre-credit *marginal citizen*
rate, the estimate is a *treaty-capped source* rate — so this is corroboration of size,
not agreement.

Any G5 fix now has to identify the credit attributable to re-sourced income
explicitly. `usSource{General,Passive}UsdYTD` already carry that split, so the
information exists; what does not yet exist is the decision about how to apportion a
blended basket credit between its foreign and re-sourced halves.

### 14.6 What this cost

Suite **4,371 pass, 0 fail**. `ftc-us-source-not-creditable.test.mjs` was renamed to
`ftc-us-source-resourcing.test.mjs` and rewritten: its whole premise — that AU tax on
US-source income must never be creditable — is what G3 reverses. Its end-to-end guard
("the pool stays under 25k") was a *proxy* for over-relief and is replaced with the
properties themselves: credit ≤ limitation base, Σ fractions ≤ 1, carryforward ≤
available, every settle.

Eight `evt-*` assertions moved from "the removal set is stamped" to "the passive
basket is stamped and the removal set is not". Two new tests exercise both sides of
the §865(g)(2) gate, which is the branch coverage that matters most here.

One refactor fell out: `withoutUsSourceIncome` is now exported from
`tax-settle-classes.js` and shared with the probe. The probe had its own copy, which
went stale the instant G3 added accumulators — and the §904 invariants caught it as a
partition violation rather than as the duplication it was.

### 14.7 Next

- **G10 part 2** — treaty rate caps on the Art. 22(2) figure (Art. 10 dividends 15%,
  Art. 11 interest 10%). Not built. This is the remaining half of §13.2: the FITO
  input is still the citizen's marginal US tax, where the treaty allows only what the
  US could have charged a plain Australian resident.
- **G10 part 3** — Art. 18(1) pensions. 0.8% of the base; record a position.
- **G6** — super into the general basket. Now unblocked: G3 has landed, so the general
  pool finally holds AU tax for super's limitation room to sit against.
- **G5** — see §14.5; needs a new approach.
- **G11** (Australia taxing US social security) and **G7** unchanged.

---

## 15. Implemented — G10 part 2, G6 (2026-08-05)

### 15.1 G10 part 2 — the Art. 22(2) figure is capped at the treaty rate

Rates transcribed from the operative text, not the TE. The 2001 Protocol **replaced**
both articles outright, so the Convention's originals do not govern:

| | source | cap |
|---|---|---|
| dividends | Protocol Art. 10(2)(b) | **15%** of the gross amount |
| interest | Protocol Art. 11(2) | **10%** of the gross amount |

Art. 10(2)(a)'s 5% rate needs a *company* holding ≥10% of the voting power, which an
individual never is; Art. 11(3)'s exemptions cover governments, central banks and
unrelated financial institutions. Neither reaches this taxpayer.

`usSourceDividendsUsdYTD` and `usSourceInterestUsdYTD` are new **subset tags** on
`usSourceOrdinaryUsdYTD` — never additional income, the same shape as NII inside
`usOrdinaryIncomeYTD`. The settle decomposes by chaining two counterfactuals:

```
marginalOnUncapped = full − (full without the uncapped US-source items)
marginalOnCapped   = marginalOnAll − marginalOnUncapped
art22(2)           = ceiling binds ? marginalOnUncapped + ceiling : marginalOnAll
```

Two choices worth recording:

- **The ordering is deliberate.** Marginal attribution does not commute; measuring the
  uncapped items first puts the capped slice at the taxpayer's *highest* rates, so the
  ceiling binds where it should rather than being flattered by a low-bracket
  measurement.
- **It is written as "binds or does not", not as `uncapped + min(capped, ceiling)`.**
  The two agree whenever the decomposition is monotone, but the §904 limitation is not
  monotone in income — removing income can *raise* tax — so the zero clamps let the
  parts sum to slightly more than the whole. The naive form moved lifetime tax by
  ~\$2k on a plan where the ceiling never binds at all. A non-binding ceiling must be
  exactly inert, and now is.

**And on the reference plan it is exactly inert.** Measured across 39 years carrying
US-source dividends or interest:

| | |
|---|---|
| years where the ceiling binds | **0 of 39** |
| lifetime marginal US tax on the capped slice | \$70,188 |
| lifetime treaty ceiling | \$737,125 |
| relief withheld by the cap | **\$0** |

Ten times more headroom than the cap needs. That is not a wasted change — it is
correct law that this plan does not happen to trip, and the reason it does not is
G10 part 1: once \$19.4m of misclassified capital gains left the Art. 22(2) base, the
remaining marginal US tax on US-source income is small enough that a 15%/10% ceiling
never reaches it. Before part 1 the caps would have bitten hard. Same "inert until its
prerequisite lands" pattern as G6 below, running the other way.

The caps stay in: a plan with more US-source investment income relative to US tax —
higher dividend yield, a smaller FTC, a year with no other US-source items — trips
them, and the alternative is silently over-crediting Australia.

> **Superseded by §18.3 later the same day.** The caps are no longer inert, and what
> tripped them was not a different plan — it was **G5**. Measuring the US tax before
> the credit for Australian tax roughly quadruples the figure the ceiling is tested
> against, and it then binds in **20 of 39 years** instead of 0, withholding \$410k
> of lifetime relief. This paragraph's instinct that the caps would earn their keep
> was right; its guess at what would trigger them was not.

### 15.2 G6 — super into the general basket

One line in `SUPER_WITHDRAWAL_EARNINGS_TAX`, and §7a.4 was right that it only pays
after G3.

The classifier touched `usOrdinaryIncomeYTD` and nothing else, which is worse than a
missing numerator: a super withdrawal **raised the §904 denominator**, diluting every
other basket's fraction, while **adding nothing to any numerator**. US tax went up and
the capacity to relieve it went down, from the same dollar.

Foreign source, general category, per §7a.2 — Pub 514 sources investment earnings on
pension contributions to the *location of the pension trust*, and a pension is absent
from the passive list, so general is the residual. Art. 18(5) confirms super is not an
"annuity" for treaty purposes.

**Measured: US tax −\$44,225, AU tax +A\$142,148.** §7a.4's estimate was ≈\$26,481 of
over-paid US tax across the super-withdrawal years — the right order, and the doc was
explicit that it was an order of magnitude rather than a number to assert on.

The AU movement is the now-familiar chain, and it is not a side effect to explain
away: more general-basket room ⇒ more FTC ⇒ lower US net liability ⇒ a smaller
with/without differential ⇒ less FITO ⇒ more AU tax. Australia collects more because
the US collects less on the same income.

### 15.3 Measured, this session

| | lifetime US tax | lifetime AU tax |
|---|---|---|
| after G3 + G4 + G10 part 1 (§14) | \$1,378,814 | A\$14,631,447 |
| **+ G10 part 2** | \$1,378,814 (**exactly inert**) | A\$14,631,447 |
| **+ G6** | \$1,334,594 (**−\$44,219**) | A\$14,773,629 (**+A\$142,182**) |

Lifetime FTC \$3,884,645 → \$3,976,012. Σ §904 fractions ≤ 1 in every year.
Suite **4,374 pass, 0 fail**.

### 15.4 Where design 83 now stands

| gap | status |
|---|---|
| G1, G2, G3, G4, G6, G8, G9, G10 part 1, G10 part 2 | **DONE** |
| G5 | ANSWERED, not built — §14.5; needs a new approach after G3 |
| G7 | DEFERRED — §11; the reference plan never sells the AU house |
| G10 part 3 | OPEN — Art. 18(1) pensions, 0.8% of the base |
| G11 | OPEN — Australia assessing US social security (Art. 18(2)) |

Remaining candidates, smallest first: **G11** is self-contained and wrong on its face.
**G10 part 3** is a recorded position rather than a build, and genuinely contested for
a contributory IRA (Art. 18(4)'s *"in consideration for services rendered"* fits a
401(k) rollover and fits a contributory IRA badly). **G5** needs a way to apportion a
blended basket credit between its foreign and re-sourced halves —
`usSource{General,Passive}UsdYTD` carry the split, so the information exists and only
the decision is missing. **G7** stays deferred until a scenario sells the AU dwelling.

---

## 16. Implemented — G11 (2026-08-05)

§13.5 proposed this on the strength of Art. 18(2) alone. The build added the second
half of the authority chain, which is the part that actually decides it.

### 16.1 The saving clause is the whole question, and it loses

Art. 18(2) of the 1982 Convention:

> *"Social Security payments and other public pensions paid by one of the Contracting
> States to an individual who is a resident of the other Contracting State **or a
> citizen of the United States** shall be taxable **only in the first-mentioned
> State**."*

The paying State is the United States, so US Social Security paid to an AU-resident
US citizen is taxable only in the US — on either limb, and an AU resident who is *not*
a US citizen reaches the same answer through the first limb.

That is where §13.5 stopped, and it is not sufficient on its own, because **Art. 1(3)
is a reciprocal saving clause**:

> *"Notwithstanding any provision of this Convention, except paragraph (4) of this
> Article, a Contracting State **may tax its residents** … as if this Convention had
> not entered into force."*

Read alone, that hands Australia back the right to tax its own resident on the
benefit and G11 evaporates. Art. 1(4)(a) is what closes it:

> *"The provisions of paragraph (3) shall not affect … the benefits conferred by a
> Contracting State under paragraph (2) of Article 9 …, **paragraph (2) or (6) of
> Article 18** …, Article 22 …"*

Art. 18(**2**) is named. Australia cannot use the saving clause to reach a payment
Art. 18(2) reserves to the United States. Checked against the 2001 Protocol as well:
the Protocol amends Convention Articles 1, 2, 4, 7, 8, 10, 11, 12, 13, 16, 21 and 22,
and its Art. 1 touches only the *last sentence* of Art. 1(3) (the former-citizen
lookback). Art. 1(4) and the whole of Art. 18 survive unamended.

Note that the carve-out is by paragraph, not by article — 18(2) and 18(6) are listed;
**18(1) is not**. That is not an oversight, and §17 turns on it.

### 16.2 What changed

`us-tax-module-2026.js`, `SS_INCOME_TAX`. The entire `isAuResident` branch is gone;
the classifier is now four lines and residency-invariant. Three things went with it,
and only the first was obvious from §13.5:

1. **The AU booking** — `auOrdinaryIncomeYTD` / the per-person map. This is the
   over-tax itself.
2. **The FITO removal set** (`usSourceOrdinaryAudYTD`, `usSourceOrdinaryUsdYTD`).
   Art. 22(2) allows a credit *"against Australian tax payable in respect of the
   income"* and caps it at *"the amount of Australian tax payable on the income"*.
   With Australia barred from taxing it, that cap is zero by the article's own terms.
   **This corrects a row of §13.2's table**: it listed `SS_INCOME_TAX` as US-source
   for 22(2) purposes *"Yes — in full"*, which answered the sourcing question and not
   the relief question. Sourcing was never the binding constraint here.
3. **The §904 re-sourcing** (`usSourceGeneralUsdYTD`). Art. 27(1)(c) deems income
   AU-source only *"to the extent necessary to give effect to"* Art. 22(4), and
   Art. 22(4) relieves Australian tax. There is none, so nothing is necessary and
   nothing is re-sourced. The benefit is plain US-source income in **no** foreign
   basket — exactly what it would be for a US resident.

Items 2 and 3 are what make the sign of the result interesting: G11 is not purely a
tax cut. It removes AU tax *and* it removes US §904 limitation room.

### 16.3 Measured

Reference plan, §904 invariants armed. Social Security is \$2,089,116 gross over the
run (\$1,775,749 taxable at 85% — the same figure §13.2's composition table reported,
which is the cross-check that the right income moved).

| | lifetime US tax | lifetime AU tax |
|---|---|---|
| after G10 part 2 + G6 (§15.3) | \$1,334,594 | A\$14,773,629 |
| **+ G11** | \$1,510,239 (**+\$175,645**) | A\$14,372,141 (**−A\$401,488**) |

Lifetime FTC \$3,976,012 → \$4,007,617. Σ §904 fractions ≤ 1 in every year.

**Both directions are real and they are the two halves of §16.2.** Australia stops
assessing a benefit it may not reach, net of the FITO it was already giving back;
the US collects more because the same benefit stopped manufacturing general-basket
limitation room out of a re-sourcing that was never due.

The single figure that nets them, because it is currency-consistent:
**USD-canonical cumulative tax falls from \$10,970,154 to \$10,886,775 — −\$83,379.**
Lifetime consumption is identical to the dollar, so nothing about the plan changed
except which revenue authority was paid.

**One caveat on reading the per-year table.** Every year before 2045 is
bit-identical (Social Security starts at 67), and 2045–2054 show the direct effect
cleanly. After that the two runs are no longer the same plan: less tax paid means
more assets carried, so realisations differ. CY2067 alone accounts for \$153,766 of
the US delta and it is **not** a treaty effect — the §904 denominator that year moves
from \$6,453,244 to \$6,971,442, a \$518k swing against roughly \$100k of Social
Security. Attribute the lifetime totals to G11; do not attribute any single late year
to it.

### 16.4 What this cost

Suite **4,374 pass, 0 fail** (unit) and **977 pass** (viz). Four assertions inverted,
all of them asserting the defect:

- `EVT-37` (`evt-income`) and `TE-8` (`tax-rates`) both required the full benefit in
  `auOrdinaryIncomeYTD` for an AU resident. They now require the opposite, and TE-8
  asserts the stronger property — that the AU-resident result is `deepStrictEqual` to
  the US-resident result, which is what "taxable only in the first-mentioned State"
  actually means.
- Two `design-76-gap-b-migration` tests used `SS_INCOME_TAX` as the worked example of
  *person-derived* AU income, because Social Security is per-recipient by definition
  and can never be halved across a household. That example no longer exists on the AU
  return. The per-person coverage moved to `WAGES_INCOME_TAX` (the other person-derived
  type) and Social Security got a new test in the same file asserting it reaches
  **neither** the per-person maps nor the household scalars.

The action still carries `residency` and `personKey`, unused by the classifier. They
describe the payment rather than its treatment, and a country that *may* assess a
foreign public pension would need exactly them; removing declared action fields is a
schema change and is out of scope here.

### 16.5 On design 85's rider

Design 85 §6 asks that the remaining design-83 gaps *"not add new `residency === 'AU'`
branches or new AU accumulator writes from US code."* G11 goes the other way: it
**deletes** one of the 37 residency branches and one of the 21 `bookAuResident` calls
that §85 §1 counts. It is the first change in this family to reduce the coupling
rather than hold it flat.

---

## 17. Implemented — G10 part 3 (2026-08-05)

§13.4 called this *"a recorded position rather than a build"* and sized it at 0.8% of
the Art. 22(2) base. Both halves of that turned out to be wrong, and in opposite
directions: it **is** a build, it is small but not that small, and the reasoning that
decides it is the mirror image of G11's.

### 17.1 The saving clause decides it — the other way from G11

Art. 18(1):

> *"Subject to the provisions of Article 19 …, pensions and other similar remuneration
> paid to an individual who is a resident of one of the Contracting States in
> consideration of past employment shall be taxable **only in that State**."*

The residence State is Australia, so on its face Australia has the exclusive right
and the US has none. **But Art. 1(4)(a) lists the paragraphs the saving clause cannot
touch, and it names "paragraph (2) or (6) of Article 18" — 18(1) is absent.** So
Art. 1(3) applies in full: the US may tax its citizen on the pension as if the
Convention had never entered into force, and it does.

That is the whole asymmetry with G11, and it is a one-word difference in Art. 1(4)(a):

| | Art. 18(2) — Social Security (G11) | Art. 18(1) — pensions (here) |
|---|---|---|
| exclusive right | United States (paying State) | Australia (residence State) |
| in Art. 1(4)(a)'s carve-out? | **yes** | **no** |
| may Australia tax it? | **no** | yes |
| may the US tax it? | yes (it is the paying State) | yes — saving clause only |
| does Australia credit the US tax? | n/a — nothing to credit | **no** — Art. 22(2) excludes it |

The last row is the operative one. Art. 22(2) allows a credit for US tax *"other than
United States tax imposed in accordance with paragraph (3) of Article 1 … **solely by
reason of citizenship**"*, and Art. 27(1)(b) refuses even to deem such income
US-source for 22(2) purposes. Strip citizenship away and Art. 18(1) leaves the US with
nothing; the US charge is therefore citizenship tax in its entirety.

Relief still exists — it just runs the other way, through **Art. 22(4)**: the US
credits the Australian tax, and Art. 27(1)(c) resources the pension to Australia to
the extent necessary to make §904 room for it. Australia taxes first, the US credits
second. That is the ordinary treatment of foreign-source income and it needs no
special machinery.

### 17.2 Where "periodic" draws the line, and why the model can honour it

Art. 18(4) defines the term:

> *"The term 'pensions and other similar remuneration' … means **periodic payments**
> made by reason of retirement or death, in consideration for services rendered, or by
> way of compensation paid after retirement for injuries received in connection with
> past employment."*

Periodicity is a real element, not a stylistic one — Art. 18(5) requires it of
annuities too (*"stated sums paid periodically"*), so a payment that is neither
periodic nor an annuity falls out of Article 18 **entirely**. It then lands in
Art. 21 (Other Income), whose paragraph (3) — *"items of income … not dealt with in
the foregoing Articles … **from sources in the other Contracting State** may also be
taxed in the other Contracting State"* — is exactly the source-State-taxes,
residence-State-credits pattern the model already implements via the removal set.

So the family splits, and the split is decidable from the action type alone:

| action | article | in the Art. 22(2) removal set? |
|---|---|---|
| `IRA_RMD_TAX`, `K401_RMD_TAX` | **18(1)** — a §401(a)(9) RMD is periodic and by reason of retirement | **no** (changed) |
| `INHERITED_RA_DISTRIBUTION_TAX` | **18(1)** — 18(4) reaches "retirement **or death**" in terms, and a SECURE 10-year drawdown is a defined series | **no** (changed) |
| `IRA_WITHDRAWAL_EARNINGS_TAX`, `IRA_ROLLOVER_WITHDRAWAL_TAX` | **21(3)** — a drawdown sized by this year's cash need is not a "periodic payment" | yes (unchanged) |

**A citation correction falls out of this.** §13.2 and the `isPersonalPropertyGainForeignSource`
docblock both cited *"Art 21(2)"* for the source-State rule. That is the **1982
original**, which Art. 11 of the 2001 Protocol omitted and replaced; the operative
paragraph is now **21(3)**. The substance survives verbatim, so no conclusion moves —
but §1 warned that "any *other* article cited later must be read against both files"
and this is the first place that bit. Both citations are corrected.

### 17.3 The accumulator choice is the load-bearing part

An Art. 18(1) pension has to be **in** the §904 general numerator (Art. 22(4) relief
needs the room) and **out** of the Art. 22(2) base (Australia grants no credit). At
first reading the model cannot express that, because `usSourceGeneralUsdYTD` is a
subset tag of the removal set `usSourceOrdinaryUsdYTD` and `withoutUsSourceIncome`
zeroes them together.

It can, and §14.1 already said how without knowing this case existed. Re-sourced
income sits in its own accumulators *only* so the FITO counterfactual can strip it out
again. Income that never enters the 22(2) base never needs stripping — so it belongs
in **`foreignGeneralIncomeYTD`**, the genuinely-foreign accumulator, which feeds the
same `generalGross` and which the counterfactual leaves alone. One line, no new state,
and the §904 invariants stay satisfied on both passes.

The design-83 accumulator split turns out to encode a three-way distinction that was
only ever described as two-way:

| accumulator | source under domestic law | in Australia's 22(2) credit base | example |
|---|---|---|---|
| `usSource{General,Passive}UsdYTD` | US | **yes** | a US dividend |
| `foreign{General,Passive}IncomeYTD` | foreign | no | AU rent; super (G6) |
| `foreign{General,Passive}IncomeYTD` | **US** | no | **an Art. 18(1) pension** |

The third row is new. It is US-source income that Australia may tax without crediting
anything, and it is the concrete answer to design 85 §8's first open question — *"the
treaty deems source while §861–865 source for domestic purposes, and the two answers
can differ for the same dollar."* Here they differ, and the resolution is that
"source" is not one fact: 27(1)(b) and 27(1)(c) deem source for **different
paragraphs' purposes**, and a dollar can be non-US-source for 22(2) and AU-source for
22(4) at the same time.

### 17.4 Measured

Reference plan, §904 invariants armed, on top of G11:

| | lifetime US tax | lifetime AU tax |
|---|---|---|
| after G11 (§16.3) | \$1,510,239 | A\$14,372,141 |
| **+ G10 part 3** | \$1,490,329 (**−\$19,910**) | A\$14,398,383 (**+A\$26,242**) |

Lifetime FTC \$4,007,617 → \$4,022,008. USD-canonical cumulative tax \$10,886,775 →
\$10,883,795 (**−\$2,980**). Consumption identical. Σ §904 fractions ≤ 1 every year.

The direction is the expected chain and, for once, it held: less removal set ⇒ a
smaller Art. 22(2) figure ⇒ less FITO ⇒ Australia collects more ⇒ more creditable
foreign tax ⇒ more US FTC ⇒ the US collects less.

**The size is bigger than §13.4's 0.8% for a reason worth noting.** That figure was
measured before G10 part 1 and G11 removed \$19.4m of capital gains and \$1.8m of
Social Security from the base. On the base as it now stands the pension family was
**3.5%** of it (`IRA_RMD_TAX` \$216,152 of \$6,294,820). Shares in this table are not
stable quantities; each gap enlarges the next one's share.

### 17.5 What the Art. 22(2) base is now

This is the clean end state of G10, and it is worth printing because it is what §13.2
set out to reach:

| item | lifetime USD | share |
|---|---|---|
| `STOCK_DIVIDEND_TAX` | 3,209,832 | 52.9% |
| `BOND_COUPON_TAX` | 2,144,697 | 35.3% |
| `CASH_SLEEVE_INTEREST_APPLY` | 708,909 | 11.7% |
| `US_SAVINGS_INTEREST_CREDIT` | 5,068 | 0.1% |
| `IRA_WITHDRAWAL_EARNINGS_TAX` | 3,398 | 0.1% |
| **total** | **6,071,904** | |

**99.9% dividends and interest** — exactly the two items Art. 10(2)(b) and Art. 11(2)
rate-cap, which is what §13.3 predicted a treaty-correct base would consist of.
Against \$28.4m at the start of §13.2, the base is down 79%.

That also puts G10 part 2 (the 15%/10% caps) in charge of essentially the whole
remaining base, so it is worth restating that **the caps still never bind on this
plan** — the marginal US tax on the capped slice stays roughly an order of magnitude
under the ceiling, for the reason §15.1 gave.

### 17.6 What this cost, and what remains contested

Suite **4,375 pass, 0 fail**; viz **977 pass**. Two assertions moved:

- `EVT-40` (`evt-ira`) required `usSourceOrdinaryUsdYTD > 0` on an AU-resident RMD. It
  now requires the opposite, plus `foreignGeneralIncomeYTD`, so the test states the
  whole treaty position rather than "an FTC was recorded".
- `design 76 P3`'s Gap D invariant — *"ordinary income and its removal slice land on
  the SAME person"* — used `IRA_RMD_TAX` as its example, which no longer has a removal
  slice. It moved to `IRA_ROLLOVER_WITHDRAWAL_TAX` (the same account, still Art. 21(3)),
  and a new sibling test asserts that an Art. 18(1) pension is attributed **with no**
  removal slice — so the Gap D rule is not misread as requiring one.

**The residual doubt, recorded rather than resolved.** Art. 18(4) requires the payment
be *"in consideration for services rendered"*. That fits a 401(k), and an IRA holding
rolled-over 401(k) money, squarely. It fits an IRA funded purely by the individual's
own deductible contributions badly: §219(f)(1) requires the contributions come out of
earned income, so there is a services link, but the payment is not made by an employer
"in consideration of past employment" in Art. 18(1)'s words. A strict reading would put
a contributory IRA's RMD in Art. 21(3) and back into the removal set.

The model carries no field separating rollover-funded from contribution-funded money
inside an IRA, so the classifier cannot split on it, and the position above is applied
to the whole account. On the reference plan that is comfortable rather than merely
convenient: the IRA is rollover-funded (two `K401_TO_IRA_CONVERSION` events against a
\$9,000 opening IRA balance), so the contested reading has almost nothing to bite on.
A plan with a large genuinely-contributory IRA would need the split before trusting
this. Design 84's rollover ledger (G9) is the machinery that would provide it.

---

## 18. Implemented — G5 (2026-08-05)

§14.5 left this needing *"a way to apportion a blended basket credit between its
foreign and re-sourced halves"*. It turns out not to need one. The apportionment
question was an artefact of asking the wrong question.

### 18.1 There is nothing to apportion, because it is all Art. 22(4) relief

The obstacle §14.5 described was real: G3 deleted the re-sourced basket, so option (a)
— suppress the Art. 22(4) credit and re-measure — has nothing to suppress, and §14.5
confirmed it as an exact no-op. The apparent next step was to identify *which part* of
the blended general/passive credit is 22(4) relief and suppress only that.

**Every part of it is.** Australia is the only foreign taxing jurisdiction in this
model, so every dollar of foreign tax credit in every basket is credit for Australian
income tax, allowed to a US citizen resident in Australia under Art. 22(1) as
qualified by Art. 22(4). The non-erosion sentence attaches to the whole of it:

> *"The credit so allowed against United States tax **shall not reduce that portion of
> the United States tax that is creditable against Australian tax** in accordance with
> paragraph (2)."*

Note what it does *not* say. It does not limit itself to credit for Australian tax on
US-source income, and it does not care which basket the credit sat in. Any credit that
reduces the liability reduces a with/without differential taken on that liability.

So the fix is option **(b)** after all — the pre-credit differential — and §11's
objection to it (*"arguably over-corrects, since the general/passive credits are not
22(4) relief on US-source income"*) was true only while the third basket existed. G3
retired the objection at the same time as it retired option (a).

### 18.2 What changed

`tax-settle-classes.js`, two lines. The Art. 22(2) differential is taken on
**`regularTax`** instead of `netLiability`, on both legs of the G10-part-2 cap
decomposition so the parts still sum to the whole.

`regularTax` and not `grossTax`: §26(b)(1) Chapter-1 income tax, which is the line
design 83 G2 already drew for the §904 limitation base. The §72(t) additional tax,
NIIT, SECA and the Additional Medicare surtax stay outside — the same line Art. 2
(Taxes Covered) draws for what Australia is being asked to credit, and the treaty
status of NIIT in particular is contested enough that including it would be a
position rather than a mechanic.

### 18.3 G5 and G10 part 2 turn out to be coupled

This is the part that was not foreseen, and it is why the answer is defensible rather
than merely larger.

Measured on the base as it stood before this change:

| lifetime Art. 22(2) figure (USD) | |
|---|---|
| **as shipped** — post-credit differential | **\$280,102** |
| option (b) — pre-credit, **uncapped** | \$1,094,612 |
| option (b) — pre-credit, Art. 10/11 ceilings applied | **\$693,306** |
| *the ceilings alone* (15% × dividends + 10% × interest) | *\$767,342* |

| years the ceiling binds | of 39 with capped income |
|---|---|
| as shipped | **1** |
| pre-credit | **20** |

**G10 part 2 was inert; G5 makes it load-bearing.** §15.1 measured the Art. 10/11 caps
as binding in 0 of 39 years and said they stayed in because *"a plan with more
US-source investment income relative to US tax … trips them"*. What actually tripped
them was measuring the US tax correctly: a pre-credit differential is roughly 4× a
post-credit one, and at that size the citizen's marginal rate clears the 15%/10%
ceilings in half the years.

That coupling is what keeps the fix honest. Uncapped, option (b) would hand Australia
\$1.09m — 3.9× the shipped figure — which §13.3 warned against as *"right about the
ordering and wrong by roughly 4× overall"*. Capped, it lands at \$693k, just under the
\$767k the treaty ceilings permit in aggregate, because in 19 of the 39 years the tax
actually paid is below the ceiling and `min` applies. §13.3's independent arithmetic
estimate of the treaty-correct base — recomputed without Social Security, which G11
has since removed — is \$768k. The two agree to within the gap between "what the
treaty permits" and "what was actually charged", which is the right relationship for
them to be in.

**Had G5 landed before G10 part 2, it would have been a large over-credit.** §13.3
called that sequencing risk correctly, for a reason it could not have known.

### 18.4 Measured

Reference plan, §904 invariants armed, on top of G10 part 3:

| | lifetime US tax | lifetime AU tax |
|---|---|---|
| after G10 part 3 (§17.4) | \$1,490,329 | A\$14,398,383 |
| **+ G5** | \$1,799,736 (**+\$309,407**) | A\$14,078,287 (**−A\$320,096**) |

Lifetime FTC \$4,022,008 → \$3,819,898. USD-canonical cumulative tax \$10,883,795 →
\$10,986,690 (**+\$102,895**). Consumption identical. Σ §904 fractions ≤ 1 every year.
On the re-pathed run the Art. 22(2) figure settles at \$709,815 lifetime against a
\$783,668 ceiling, and the ceiling binds in 20 of 39 years.

The chain: Australia grants more FITO ⇒ collects less ⇒ there is less Australian tax
for the US to credit ⇒ US FTC falls ⇒ the US collects more. **Total tax rises**, which
is worth stating plainly rather than burying: the household is not better off. The
Australian tax that G5 forgives had been almost entirely recoverable as US foreign tax
credit, so forgiving it converts recoverable tax into unrecoverable tax. Correctness
and the household's interest point in opposite directions here, and correctness is
what this document is for.

**The sign is plan-specific.** On the synthetic default scenario the same change moves
lifetime tax the *other* way, −5.8% (723,849 → 682,015), because there the US FTC was
limitation-bound and the displaced Australian tax was not fully recoverable. Neither
direction is evidence about the other.

### 18.5 Why this is not over-relief

The guard rail this change has to clear is the one `cross-border-relief-scenario`
states in its own comment — *"a large downward swing would mean the ftcYTD over-relief
has returned"*. It does not, and the relief is bounded twice, independently, and by
mechanisms that already existed:

1. **On the AU side**, s770-75's FITO limit — the marginal AU tax on the US-source
   income, computed with/without. Australia cannot forgive more tax than it charged on
   that income, however large the US figure gets, and FITO has no carryforward, so
   excess is simply lost.
2. **On the US side**, the Art. 10/11 ceilings from G10 part 2 (§18.3), which now bind
   in half the years.

New test **FITO-G5** pins the property directly rather than the number: loading the
general pool with more Australian tax than §904 can absorb must leave
`usTaxPaidOnUsSourceAud` **exactly unchanged** while the US liability it was measured
against demonstrably falls. Both halves are asserted — without the second, the test
would pass on a state where the credit never bound.

### 18.6 What this cost

Suite **4,376 pass, 0 fail**; viz **977 pass**. One golden re-baselined
(`cross-border-relief-scenario`, 723,849 → 682,015) with the reasoning and the
opposite-signed reference-plan result recorded next to it, so the next reader does not
read a 5.8% drop as the over-relief the test guards against.

---

## 19. Two findings this session did not build

Both surfaced while measuring the above. Neither is in design 83's gap list; both are
recorded so they are not re-discovered.

### 19.1 The §904 pool apportionment key excludes re-sourced income

`_extraStatePatches` splits the creditable Australian tax between the general and
passive carryforward pools by basket **income** share, and the key is

```js
gen  = foreignGeneralIncomeYTD
pass = foreignPassiveIncomeYTD
```

— the genuinely-foreign accumulators only. But `_computeFtc` forms each basket's
numerator from `foreign* + usSource*`. So the income that decides *which pool banks
the tax* is a strict subset of the income that decides *how much that pool can
credit*, and after G10 part 1 the excluded part is large: \$6.07m of re-sourced
dividends and interest, all passive.

Measured by A/B — running the alternative key `foreign* + usSource*` — the effect on
the reference plan is **US +\$1,397 / AU −A\$5,274 lifetime**, about 0.1%. Real, and
too small to justify a change that would move the golden. Recorded, not built.

There is a second wrinkle in the same three lines, and it is the more interesting one:
`_extraStatePatches` runs at the **AU settle (30 June)** but reads accumulators that
reset at the **US settle (31 December)**. The apportionment key is therefore always a
January-to-June sample of the US calendar year's income mix, whichever definition it
uses. That is a structural consequence of the two tax years, not a bug to fix in
isolation.

### 19.2 The Art. 21 citations were to superseded text

§13.2 and the `isPersonalPropertyGainForeignSource` docblock both cited *"Art 21(2)"*
for the rule permitting source-State taxation. Art. 11 of the 2001 Protocol **omitted
Article 21 and substituted** a new one; the operative paragraph is **21(3)**. The
language survives close to verbatim, so no conclusion in this document moves — but §1
warned that *"any other article cited later must be read against both files"*, and
this was the first place that mattered. Corrected in §17.2 and in the code.

Worth generalising: the checked-in Convention is the 1982 original and the amendments
live in a separate file. Any citation in this document to an article the Protocol
touched — **1, 2, 4, 7, 8, 10, 11, 12, 13, 16, 21, 22** — must be read against both.
Articles 18 and 27, which carry most of §16 and §17, are untouched.

---

## 21. G7 — implemented, except the discount apportionment (2026-08-06)

Built for a dwelling **rented first and possibly occupied later** — sub-case 2b, the
history that the deferral in §7b.5 was ordered around and which the reference plan's AU
house actually has. **All five applicable steps are done**; step 4 is not applicable.

| step | status | note |
|---|---|---|
| 1 — s118-110(3) foreign-resident gate | **done** | Snapshot at the CGT event, not a look-back |
| 2 — `mainResidenceFrom`/`Until` + s118-185 | **done** | `acquisitionDate` added; absent ⇒ denial, never a guess |
| 3 — CGT discount by residency days | **done** | Opt-in on `acquisitionDate`, so no re-baseline was needed after all |
| 3b — depreciation split + §1250 bucket | **done** | Promoted: §7b.5 assumed a never-rented dwelling |
| 4 — s118-145 absence rule + s118-192 | **not applicable** | Both limbs need main-residence status *before* the income time; rent-then-occupy fails both |
| 5 — §121 with nonqualified-use proration | **done** | Applied to BOTH countries' dwellings |

**The ordering in §7b.5 was wrong for this dwelling, in both directions.** Step 3b was
listed as optional generality and is in fact required — a rented property accrues
`accumulatedDepreciation`, §121 can never shelter it, and without a 25% bucket there was
nowhere to put a differently-rated slice. Step 4 was listed as the generality to finish
with and is *unavailable*: s118-145(1) applies to "a dwelling **that was your main
residence**" and s118-192(1)(b) asks whether a full exemption would have been available
just before the income time, so a dwelling rented from the start fails both limbs.

**What this corrects, and it is not what the headline suggests.** Neither concession is
the round number people expect. Australia exempts the *fraction of ownership days* the
dwelling was the main residence — rent for twenty years, move in for three, and roughly
3/23 is exempt, not the lot. The United States prorates the \$250k/\$500k the same way
under §121(b)(5), and **the rent-then-occupy order is the penalised one**: Pub 523's
Exception 1 forgives renting *after* you move out, not *before* you move in. Both
countries prorate by time; both penalise this order.

**Case 1 was also wrong, against the taxpayer, and step 3 fixes it.** The model gave a
foreign resident a 0% CGT discount, but s115-115 *apportions* by AU-resident days over
the whole ownership period — it does not deny. What a foreign resident loses is the
main-residence exemption (s118-110(3)), a different provision; conflating the two is
exactly what the binary switch did, and it was wrong in both directions. A returning
resident was given the full 50% on a gain that mostly accrued abroad; a departing one
was given nothing.

**Step 3 needed no golden re-baseline, contrary to the plan.** The apportionment is
computed from the asset's `acquisitionDate`, and with none stated it falls back to the
pre-G7 binary — so it is opt-in per property. It also bites far more narrowly than
"every AU CGT asset" suggested: design 62's s855-45 deemed acquisition restarts the
clock at the move for every non-TAP asset, leaving its testing period wholly inside the
residency at 50%. **Australian real property is the only class that reaches it**, which
is a narrow set and a large number — measured at an 11.9% effective discount, not 50%,
for a thirty-year hold with eight resident years.

Two accumulators rather than one scaled figure (`auDiscount{ApportionedBase,Allowance}YTD`,
plus per-person twins): a year can contain both an apportioned property disposal and a
flat-rate share sale, and averaging them into one rate would produce a discount neither
asset attracts.

**Two things landed that design 83 never contemplated**, because G7 is only useful with
them:

- **A property purchase path** (`property-purchase.js`). Design 83 has no way to acquire
  a dwelling mid-run, which makes the commonest retirement move — sell the family home,
  buy something smaller — inexpressible. A property with a future `purchaseYear` sits
  dormant at value 0, which the engine already treats as absent (`HouseRunningCostHandler`
  skips `value <= 0`; appreciation on 0 is 0), so dormancy needed no gate. The price is
  stated in today's money and grown at the property's own appreciation rate, because the
  quantity a downsize preserves is the *ratio* between the home sold and the home bought.
- **The s292-102 downsizer contribution** (`au/downsizer-contribution.js`). Up to
  A\$300,000 per person into super, outside the caps. Its eligibility gate is
  s292-102(1)(b) — the dwelling must have qualified *at least partly* for the
  main-residence exemption — which makes it **the same lever as `mainResidenceFrom`**.
  Moving in before selling buys a slice of s118-185 and the entire downsizer capacity
  together, and for a long-rented dwelling the second is frequently the larger. Figures
  are transcribed from secondary knowledge and are **unverified against the ATO**.

Suite green throughout: 4,581 + 996, with no golden re-baseline — every pre-G7 property
keeps its exact answer, because a bare `isPrimaryResidence` can only mean "throughout"
or "never" and is treated as meaning exactly that.

Tests: `tests/unit/evt-main-residence.test.mjs` (23),
`tests/unit/evt-property-purchase.test.mjs` (14),
`tests/unit/evt-downsizer-contribution.test.mjs` (11).

## 20. Where design 83 stands after this session

| gap | status |
|---|---|
| G1, G2, G3, G4, G5, G6, G8, G9, G10 (parts 1–3), G11 | **DONE** |
| G7 | **DONE** (step 4 not applicable) — see §21 |

G7 is the only gap left, and it is unchanged: six steps (§7b.5), one of which
apportions the CGT discount by residency days across *every* AU CGT asset, another of
which needs a US §1250 25% rate bucket that does not exist. It is inert until a
scenario sells the dwelling, and §7b.3's warning still governs — adding a
main-residence exemption without the s118-110(3) foreign-resident gate would break
case 1, which is correct today by omission. All-or-nothing.

Cumulative effect of design 83 on the reference plan, from the pre-G1 baseline:

| | lifetime US tax | lifetime AU tax |
|---|---|---|
| baseline (`main` @ `1cc2176`) | \$1,192,867 | A\$14,628,982 |
| after G1/G2/G8/G9 (§12) | \$1,225,115 | A\$14,546,741 |
| after G3/G4/G10p1 (§14) | \$1,378,814 | A\$14,631,447 |
| after G10p2/G6 (§15) | \$1,334,594 | A\$14,773,629 |
| after G11 (§16) | \$1,510,239 | A\$14,372,141 |
| after G10p3 (§17) | \$1,490,329 | A\$14,398,383 |
| **after G5 (§18)** | **\$1,799,736** | **A\$14,078,287** |
| **net** | **+\$606,869 (+50.9%)** | **−A\$550,695 (−3.8%)** |

The Art. 22(2) base, which is where most of this lives, went from \$28.4m of
account-domicile guesswork (§13.2) to \$6.07m that is 99.9% dividends and interest —
the two items the treaty rate-caps — and is now measured before the credit that
Art. 22(4) forbids it to be reduced by.

**The single most repeated lesson, for the fourth and fifth time this session:** every
unmeasured sign claim in this family has a real chance of being backwards, and every
"share of the base" figure moves when a neighbouring gap lands. §13.4 sized G10 part 3
at 0.8%; by the time it was built it was 3.5% of a base three-quarters smaller.
Measure, then decide.
