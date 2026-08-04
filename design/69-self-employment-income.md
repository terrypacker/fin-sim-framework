# 69 — Self-Employment Income (US SECA + AU sole-trader), both countries

**Status**: **IMPLEMENTED** (2026-07-17; green — 3647 unit + 875 viz, plus an
end-to-end harness run confirming a self-employed person's income lands in the
SECA base while a wage earner's fills the SS wage base). Default golden scenario
is **INERT** (no self-employed person). Turn the dormant self-employment plumbing
into a scheduled, first-class income type in both countries, driven by a single
per-person **"Self-employed"** checkbox that sits next to the Monthly Wage field.

When checked, that person's `monthlyWage` is routed through the **self-employment
path** instead of the wages path, and — on the US side — it incurs **US
self-employment tax (SECA, IRC §1401)**: 12.4% Social Security up to the annual
wage base (coordinated with any W-2 wages) + 2.9% uncapped Medicare on 92.35% of
net earnings, plus the 0.9% Additional Medicare surtax over the statutory
threshold, with **half the regular SE tax deducted** from ordinary income.

The user-facing surface is one checkbox. The wage figure, currency, retirement
gating, inflation adjustment, and account routing are all **reused unchanged**
from the existing wage machinery.

---

## 1. Motivation & current state

The repo already has *most* of the SE plumbing, but it is orphaned and, on the US
side, functionally identical to wages:

- **Handlers/reducers exist but are never scheduled.** `SeIncomeUsHandler`
  (`SE_INCOME_US`) and `AuSeIncomeHandler` (`SE_INCOME_AU`), their `*ApplyReducer`s,
  and the `SE_INCOME_US_TAX` / `AU_SE_INCOME_TAX` classification reducers are all
  registered — but **nothing emits a `SE_INCOME_US` / `SE_INCOME_AU` event**, so
  they never fire. Wages, by contrast, are driven by the scheduled `MONTHLY_WAGES`
  event through `MonthlyWagesHandler`, which iterates `state.people`.

- **US SE income is taxed exactly like wages.** `SE_INCOME_US_TAX` today just adds
  the amount to `usOrdinaryIncomeYTD`. **The 15.3% self-employment tax (SECA) is
  computed nowhere.** That is the real functional gap.

- **AU SE income is already correct in substance.** Sole traders pay the *same*
  marginal income-tax rates as individuals — SE income *is* ordinary income, which
  is exactly what `AU_SE_INCOME_TAX` does. The one real AU distinction (no
  Superannuation Guarantee on your own income) is a non-issue here because super
  contributions are modeled as a *separate scheduled event*, never derived from
  wages.

So this design = **(a)** wire a `selfEmployed` flag so the wage scheduler routes
through the SE path, and **(b)** implement US SECA.

---

## 2. Tax law (research)

### 2.1 United States — self-employment tax (SECA), IRC §1401/§1402

| Component | Rate | Base | Cap |
|---|---|---|---|
| Social Security (OASDI) | 12.4% | 92.35% of net SE earnings | Annual wage base (\$176,100 in 2025, \$184,500 in 2026) |
| Medicare (HI) | 2.9% | 92.35% of net SE earnings | Uncapped |
| Additional Medicare | 0.9% | earned income (Medicare wages + net SE) over threshold | \$200k single / \$250k MFJ |

Key rules the model honors:

1. **92.35% base** — net SE earnings are multiplied by `1 − 0.0765` before SE tax
   (the notional deduction for the employer-half, IRC §1402(a)(12)).
2. **Wage-base coordination** — W-2 wages that were already subject to Social
   Security **fill the wage base first**. The SS portion of SE tax applies only to
   the *remaining* base: `min(seNet, max(0, wageBase − ssWages)) × 12.4%`.
3. **Half deductible** — half the regular SE tax (SS + Medicare, **excluding** the
   0.9% surtax) is an above-the-line deduction reducing AGI (IRC §164(f)). This is
   *not* circular: SE tax depends only on SE earnings and SS-wages, never on AGI,
   so we compute SE tax first, then subtract `seTax/2` when forming AGI.
4. **Outside the FTC / income-tax base** — SECA and Additional Medicare are
   Chapter-2/2A taxes; they are **not** creditable by the Foreign Tax Credit and
   are **not** part of the §904 limitation base. They are added on top of net
   liability, exactly like the existing NIIT (§1411) treatment.
5. **Totalization (US–AU agreement)** — SE income earned while covered by the
   Australian system is **exempt from US SECA**. We model this cleanly by SECA
   applying **only to US-source SE income** (`SE_INCOME_US_TAX`); AU-source SE
   income (`AU_SE_INCOME_TAX`) never feeds the SECA base. Documented simplification.

### 2.2 Australia — sole traders

Sole traders are taxed on business profit at the **same marginal rates as any
individual** — no separate SE tax, no employer Super Guarantee on their own
income. The existing `AU_SE_INCOME_TAX` reducer already implements this (ordinary
income + §904 General numerator + per-person FEIE cap when AU-resident). **No AU
tax change is needed**; the only AU work is scheduling (§4) and account routing.

### 2.3 Documented simplifications

- **Wages carry no employee FICA in this model** (pre-existing). Wage earners pay
  0% FICA; the self-employed pay full SECA. This over-states the *gap* relative to
  reality (where employees pay 7.65%), but faithfully models SE tax as requested.
- **Household-aggregate SS wage base.** US ordinary income is a household-level
  bucket in this model. We apply **one** wage base to the combined US SE earnings,
  filled first by combined US SS-wages. Exact for single filers and single-earner
  households; a minor *understatement* only for dual high-earner MFJ couples who
  both exceed the wage base. Acceptable for v1; revisit with per-person SE
  accumulators if needed.
- **§199A QBI (20%) deduction** — out of scope (deferred).

---

## 3. Sources

- IRS — Self-Employment Tax (Social Security and Medicare): <https://www.irs.gov/businesses/small-businesses-self-employed/self-employment-tax-social-security-and-medicare-taxes>
- IRS — Instructions for Schedule SE (Form 1040) (2025): <https://www.irs.gov/instructions/i1040sse>
- TurboTax — Self-Employment Tax vs. Income Tax
- ATO — Super for sole traders and partnerships: <https://www.ato.gov.au/businesses-and-organisations/super-for-employers/work-out-if-you-have-to-pay-super/super-for-sole-traders-and-partnerships>
- Moneysmart — Super for self-employed people: <https://moneysmart.gov.au/grow-your-super/super-for-self-employed-people>

---

## 4. Design

### 4.1 Data model — `person.selfEmployed`

A single boolean on `Person` (default `false`), threaded through the same chain
as every other person field:

- `person.js` (constructor + JSDoc)
- `person-builder.js` (`_selfEmployed`, setter, `build()`)
- `scenario-serializer.js` (serialize + `fromJSON`)
- `people-controller.js` (normalize to `Boolean`)
- `person-editor.js` + `tpl-person-editor` (checkbox next to Wage)
- `inflation-adjust-reducer.js` — **no change** (the flag is not inflated; the
  wage figure inflates as today).

### 4.2 `state.people` projection

Add `selfEmployed: person.selfEmployed ?? false` to the three sites that build the
runtime `state.people` map: `us-au-cross-border-toolset.js`,
`us-retirement-toolset.js`, `au-retirement-toolset.js`.

### 4.3 Scheduling — `MonthlyWagesHandler` routes SE

The handler already resolves currency (`wageCurrency` → US/AU), target transaction
account (`targetKey`), residency, retirement gating, and per-person field records.
Add a single branch: when `person.selfEmployed`, emit the **SE** apply action
instead of the wages apply action, keeping the same amount/currency/target/personKey:

| `wageCurrency` | not self-employed | self-employed |
|---|---|---|
| USD | `WAGES_INCOME_APPLY` | `SE_INCOME_US_APPLY` |
| AUD | `AU_WAGES_INCOME_APPLY` | `SE_INCOME_AU_APPLY` |

The per-person `FieldValueAction` label becomes `"… Self-Employment"` vs `"… Wages"`
for journal clarity. `generatedActionTypes` gains the two SE apply types.

### 4.4 SE apply reducers accept `targetKey` + `personKey`

Bring the SE apply reducers to parity with the wage apply reducers so they credit
the resolved transaction account and forward `personKey`:

- `SeIncomeUsApplyReducer`: read `targetKey, personKey`; credit
  `state[targetKey] ?? resolveCashKey(...,'US',...)`; forward `personKey` on
  `SE_INCOME_US_TAX`.
- `AuSeIncomeApplyReducer`: already forwards `personKey`; add `targetKey` routing.

Update the action field schemas (`SE_INCOME_US_APPLY`, `SE_INCOME_AU_APPLY` gain
`personKey`/`targetKey`; `SE_INCOME_US_TAX` gains `personKey`).

### 4.5 Tax reducers feed new accumulators (US)

Two new US YTD accumulators (USD), initialized in `us-tax-toolset.js` `state()` and
reset in `YTD_FIELDS.US` (`tax-settle-classes.js`):

- **`usSeEarningsYTD`** — net (gross) US-source SE income. Fed by
  `SE_INCOME_US_TAX` (in addition to its existing `usOrdinaryIncomeYTD` add and
  AU-resident branch). `SE_INCOME_US_TAX` is also upgraded to thread `personKey`
  into the AU per-person buckets, matching `WAGES_INCOME_TAX`.
- **`usSsWagesYTD`** — US wages+bonus subject to Social Security. Fed by
  `WAGES_INCOME_TAX` and `BONUS_TAX`. Used only to fill the wage base ahead of SE.

`AU_SE_INCOME_TAX` is unchanged (no SECA — totalization; §2.1.5).

### 4.6 SECA computation in `computeTax` (`us-tax-rates-base.js`)

New rate constants (SS/Medicare split; the 0.9% surtax thresholds are statutory,
un-indexed, like the NIIT thresholds). `_ficaWageBase` is **already** inflation-
scaled per year, so it is used directly.

```
seNet          = max(0, usSeEarningsYTD) × 0.9235
ssBaseLeft     = max(0, _ficaWageBase − max(0, usSsWagesYTD))
seSsTax        = min(seNet, ssBaseLeft) × 0.124
seMedicareTax  = seNet × 0.029
seTax          = seSsTax + seMedicareTax           // regular SE tax (deductible half)

addlMedThresh  = single ? 200_000 : 250_000
earnedForAddl  = max(0, usSsWagesYTD) + seNet
addlMedicare   = max(0, earnedForAddl − addlMedThresh) × 0.009

seDeduction    = seTax × 0.5                        // above-the-line, excl. surtax
agi            = usOrdinaryIncomeYTD − usNegativeIncomeYTD − seDeduction
```

`agi` feeds the existing ordinary/AGI/taxable pipeline unchanged. SE tax and the
surtax are added **outside** the FTC path (mirroring NIIT):

```
grossTax     = grossTaxBeforeNiit + niitTax + seTax + addlMedicare
netLiability = max(0, grossTaxBeforeNiit − credits) + niitTax + seTax + addlMedicare
```

New return fields (`selfEmploymentTax`, `additionalMedicareTax`,
`selfEmploymentTaxDeduction`, `seNetEarnings`) and conditional `lineItems`
(`Self-Employment Tax (SECA)`, `Additional Medicare Tax (0.9%)`,
`½ SE Tax Deduction`) so the tax document/journal surfaces them.

### 4.7 State income tax

No change. `SE_INCOME_US_TAX` already maps to `stateOrdinaryIncomeYTD`
(`state-income-classification.js`) — SE income *is* state-taxable ordinary income,
and states do not levy SECA.

---

## 5. Files touched

| File | Change |
|---|---|
| `finance/person.js` | `selfEmployed` field + JSDoc |
| `finance/builders/person-builder.js` | builder support |
| `scenarios/scenario-serializer.js` | serialize + fromJSON |
| `visualization/people/people-controller.js` | normalize |
| `visualization/people/person-editor.js` | populate + read checkbox |
| `index.html` (`tpl-person-editor`) | checkbox markup |
| `finance/handlers/monthly-wages-handler.js` | SE routing branch |
| `finance/account-rules/us/us-income-classes.js` | `SeIncomeUsApplyReducer` targetKey/personKey |
| `finance/account-rules/au/au-income-classes.js` | `AuSeIncomeApplyReducer` targetKey |
| `scenarios/toolsets/us-income-toolset.js` | action field schemas |
| `scenarios/toolsets/au-income-toolset.js` | action field schemas |
| `finance/tax/us/us-tax-module-2026.js` | `SE_INCOME_US_TAX`/`WAGES_INCOME_TAX`/`BONUS_TAX` accumulators |
| `finance/tax/us/us-tax-rates-base.js` | SECA + Additional Medicare in `computeTax` |
| `finance/tax/us/us-tax-rates-2024/2025.js` | SECA/surtax rate constants (base) |
| `scenarios/toolsets/us-tax-toolset.js` | init `usSeEarningsYTD`, `usSsWagesYTD` |
| `finance/tax/tax-settle-classes.js` | add both to `YTD_FIELDS.US` |
| 3× `state.people` projections | `selfEmployed` passthrough |
| tests | SECA math, routing, serialization |

---

## 6. Test plan (`SE-1..N`)

- **SE-1** SECA basic: \$100k US SE income, single → seNet 92,350; SS 12.4% +
  Medicare 2.9%; half deducted from AGI.
- **SE-2** Wage-base coordination: US wages already at/above the wage base ⇒ SE SS
  portion is 0 (only 2.9% Medicare on SE).
- **SE-3** Partial coordination: wages fill part of the base; SE SS applies to the
  remainder only.
- **SE-4** Additional Medicare: combined earned income over \$250k MFJ ⇒ 0.9% on the
  excess; under threshold ⇒ 0.
- **SE-5** Half-deduction reduces ordinary income tax (AGI lower than gross).
- **SE-6** FTC does not offset SECA/surtax (added on top).
- **SE-7** Routing: `selfEmployed=true` USD person ⇒ `SE_INCOME_US_APPLY` credits
  the transaction account; not `WAGES_INCOME_APPLY`.
- **SE-8** Routing: `selfEmployed=true` AUD person ⇒ `SE_INCOME_AU_APPLY`; AU tax =
  ordinary income (no SECA).
- **SE-9** Serialization round-trip preserves `selfEmployed`.
- **SE-10** Default golden scenario (no self-employed person) is **INERT**.
