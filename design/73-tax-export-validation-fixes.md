# 73 — Cross-border source defects surfaced by tax-export validation

**Status: PROPOSED.** Three gaps, all in the AU tax module, all found by reading the
`design/71` CSV exports line-by-line against a real scenario rather than by a failing test.

The instrument is `scripts/export-tax-csv.mjs`; the subject is `scenarios/fin-sim-scenarios.json`
(gitignored — the figures below are reproduced inline so this document stands alone). Every
number quoted was taken from a live run, not inferred.

**The unifying defect: income *source* is inferred from the wrong attribute.** Source is a
property of the income item — where services were performed, where the asset sits, who the payer
is. The AU module instead infers it from whatever attribute happened to be at hand at each call
site, and the attribute differs per income type:

| Income type | Source inferred from | Should be |
|---|---|---|
| Wages (`AU_WAGES_INCOME_TAX`) | **payment currency** (`wageCurrency === 'AUD'`) | place the work is performed |
| Bank / fixed-income interest | payer (the AU bank) — correct | payer residence |
| Rental (`AU_RENTAL_INCOME_TAX`) | **owner's residency** | situs of the property |

Because both AU assessability and the US §904 basket numerators are derived from that inference,
each mis-attribution is a two-sided error: it taxes (or fails to tax) in Australia, *and* it
inflates (or starves) the US foreign tax credit limitation.

**The machinery to fix all three already exists and is dead.** `au-tax-rates-base.js:286-289`
computes a non-resident assessable path — `assessableIncome = auOrdinaryIncomeYTD +
auCapitalGainsYTD`, taxed through `this._nonResidentBrackets` — and surfaces it as line 5 of the
AU return, "Tax on Income (Non-Resident Brackets)". Across the whole 44-year reference export
that line reads **0.00 in all 12 non-resident years**, because no feeder ever writes
`auOrdinaryIncomeYTD` or `auCapitalGainsYTD` while non-resident: every one of them diverts to the
flat-rate withholding bucket instead. None of the fixes below need a new accumulator or a new tax
path. They need the existing feeders to stop routing assessable income into a withholding bucket.

**Relates to:**
- **`design/71` (tax worksheet CSV export)** — the instrument. Gaps 1 and 3 are invisible in the
  UI because they show up as a line that is present-but-wrong or absent-but-should-exist; only a
  year-by-year flat file makes them obvious.
- **`design/52` (cross-border relief)** — owns `foreignGeneralIncomeYTD` / `foreignPassiveIncomeYTD`,
  the §904 basket numerators that Gaps 1 and 3 feed incorrectly.
- **`design/50`** — introduced `AuWagesIncomeApplyReducer` and the currency-based routing that
  Gap 1 identifies as the root cause.
- **`design/72` (company equity sale fixes)** — same class of finding (US-source income mis-handled
  in the FTC machinery), same diagnostic method.

---

## 0. Fixed in passing  ✅ DONE

Two items were found and fixed during the same validation pass. Recorded here for traceability;
no further work outstanding.

1. **The Form 8960 NIIT line had no drill-down.** A reader could see a 3.8% surtax on a base of
   694,183.29 against long-term capital gains of 650,000.00 with no way to account for the
   44,183.29 difference (dividends, bond coupons, money-market and savings interest). Added
   `NiitBaseByComponentDef` (`niit-base-by-component`), a `perDiff` report unioning the three
   §1411 accumulators — `usNetInvestmentIncomeYTD`, `usCapitalGainsYTD`, `usCollectibleGainsYTD` —
   and attached it to the NIIT line in `us-tax-document-2026.js`. Drilling only the NII
   accumulator would have explained 44k of a 694k line; the union foots exactly.

2. **`stateDelta` dropped the first accrual of a run.** `state-utils.js` computed `delta` only
   when *both* `before` and `after` were numbers, so a YTD accumulator materialising from absent
   (`undefined → 213.43`) recorded `delta: null`. Any report summing `stateDelta` — the new NIIT
   drill, and `ordinary-income-by-source` — silently under-footed its own tax line by the run's
   first accrual. Fixed via a shared `_numericDelta` helper used by both `MutationTracker.record`
   and `diffStates`; a genuine non-numeric transition still yields `null`. No computed tax figure
   reads `delta`, so nothing moved but the reports.

---

## 1. Gap 1 — a non-resident's AUD wages are sourced by currency, not by where the work is done

### Symptom

On the AU return, the two people's "Non-Resident Withholding Income" differ by exactly
**12,000.00 AUD** in both settled non-resident years, while the interest component is identical
to the cent:

| AU FY2025 (settles 2026-06-30) | primary | spouse |
|---|---|---|
| AU savings interest | 2,087.24 | 2,087.24 |
| AU wages | — | 12,000.00 |
| **Line 4 — NR withholding income** | **2,087.24** | **14,087.24** |
| Line 6 — NR withholding tax @15% | 313.09 | 2,113.09 |

(FY2026 is the same shape: 2,523.11 vs 14,523.11.) The interest legs match because
`AU_SAVINGS_EARNINGS_TAX` splits by account ownership via `accumulateByOwnership` and the account
is joint — the balances are not lopsided. The entire divergence is a 2,000 AUD/month salary paid
to the spouse for calendar 2026 (24,000 AUD total, 6 payments landing in each AU financial year).

The spouse is a **US resident performing the work in the US**, paid in AUD into an Australian
account.

### Cause

`MonthlyWagesHandler` routes any person whose `wageCurrency` is `AUD` to
`AuWagesIncomeApplyReducer`, documented as "AU-source wages" (`au-income-classes.js:61`). The
chained `AU_WAGES_INCOME_TAX` reducer (`au-tax-module-2026.js:77-105`) then branches on the
earner's residency, and the non-resident branch books the wage into
`auPersonNonResidentWithholdingYTD`:

```js
} else {
  const usePerPerson = personKey != null && state.auPersonNonResidentWithholdingYTD != null;
  next = { ...next, ...(usePerPerson
    ? { auPersonNonResidentWithholdingYTD: { ...state.auPersonNonResidentWithholdingYTD,
        [personKey]: (state.auPersonNonResidentWithholdingYTD[personKey] ?? 0) + amount } }
    : { auNonResidentWithholdingYTD: state.auNonResidentWithholdingYTD + amount }) };
}
```

Currency was used as a proxy for source. It is not one — an Australian employer can pay AUD to
someone who never sets foot in Australia, which is exactly this scenario.

### Why that is wrong

Source of employment income is the **place where the services are performed**, not the currency,
the paying entity's residence, or the account the money lands in.

The governing Australian authority is *FCT v French* (1957) 98 CLR 398 [R7], and its facts are
this scenario in mirror image: the taxpayer was an Australian-based engineer who spent two to
three weeks a year working in New Zealand, **with his salary continuing to be paid into his
Australian bank account throughout**. The High Court held the wages earned during those weeks
were sourced in New Zealand. Payment location and payment currency lost to place of performance
on facts materially identical to the spouse's.

One caveat worth recording: source is a question of fact, and the ATO's own position [R8] is that
*French* lays down no absolute rule that the place of performance always governs (cf. *FCT v
Mitchum* (1965) 113 CLR 401). Place of performance is the strong general principle, not a
statutory formula — which is an argument for modelling source as an explicit, user-settable
attribute rather than deriving it from anything.

Treaty side, from the US Treasury Technical Explanation of Article 15 (Dependent Personal
Services) [R9] — the operative sentence, quoted in full:

> Other remuneration of a resident of one of the Contracting States for employee services or for
> services performed as a director of a company **may be taxed only in the State of residence
> unless the employment is exercised or the services are performed in the other State**, in which
> case that other State may tax the remuneration for the services performed there, subject to the
> conditions set forth in paragraph 2.

Residence-only taxation is the **default**; the source state's right is the exception, and it is
unlocked by the employment being *exercised* there — not by who pays, from where, or in what
currency. Paragraph 2 then withdraws even that right where all three of (a) presence ≤183 days,
(b) employer not a resident of that State, and (c) remuneration not deductible against a permanent
establishment/fixed base/trade or business there are met.

For the spouse the exception never opens: the employment is exercised in the US. Work performed
in the US is US-source, taxable only in the US, and belongs on **no** Australian return at all.

Article 27(1) then confirms the direction of travel for the FTC question below: income derived by
a US resident "which, under the Convention, may be taxed by Australia, is deemed to have its
source in Australia" [R9]. Australia may *not* tax this wage under the Convention, so the deeming
rule does not fire, and the income is not Australian-source for any treaty purpose — including the
§904 basket.

The ATO states the structural rule plainly [R5]: a foreign resident pays Australian tax on all
Australian-**sourced** income, other than income already correctly taxed at source (interest,
unfranked dividends, royalties). Non-Australian-sourced income does not appear at all.

So the correct treatment is not "assess it at non-resident marginal rates instead of 15%" — that
would be right only if the work were performed in Australia. The correct treatment is that
Australia has no claim, and the AU return for those years should show **zero income**.

The US side is already right: line 83 adds `toUSD(amount, 'AUD', state)` to `usOrdinaryIncomeYTD`
unconditionally, so the 24,000 AUD is already inside the 1040's 318,375.35 gross ordinary income.

### The larger consequence — the §904 general basket

Line 84 also adds the wage to `foreignGeneralIncomeYTD`, the §904 **general basket numerator**,
unconditionally. US-source income has no business there. Measured on the reference run, that one
mis-attribution *is* the entire general basket for tax year 2026:

```
foreignGeneralIncomeYTD contributions, calendar 2026:
AU_WAGES_INCOME_TAX      15,483.87
TOTAL                    15,483.87   ← the CSV's "General — foreign income in basket"
```

Everything downstream of it on the Form 1116 worksheet rests on that figure: the limitation
fraction (0.01650), the §904 general limit (2,793.91), and the 1,161.29 of general FTC actually
taken. Reclassify the wage as US-source and the general basket goes to zero, the limit goes to
zero, and no general-basket credit is available in 2026. Self-consistently, the AU tax that
*generated* that credit largely disappears too, since it was the withholding on this same wage —
both sides of the double-tax relief collapse together, which is the correct outcome for income
only one country may tax.

### Fix — model source explicitly (option B)

Rejected alternative (option A): make the non-resident branch a no-op and drop the foreign-basket
add. Ten lines, correct for this scenario, but it hard-codes the opposite assumption and makes
the genuine cross-border commuter — a US resident who really does perform work in Australia —
unrepresentable. That income *is* AU-source and *is* assessable at foreign-resident marginal
rates. Trading one wrong default for another is not progress.

1. **New per-person field `workCountry`** (`'US' | 'AU'`), defaulting to the person's residency at
   the time the wage accrues, so existing scenarios are unchanged until someone sets it. This is
   the attribute that actually determines source; `wageCurrency` reverts to being purely a
   denomination concern.
2. **Thread it through the wage action.** `MonthlyWagesHandler` stamps `workCountry` on
   `AU_WAGES_INCOME_APPLY` / `WAGES_INCOME_APPLY`; `AuWagesIncomeApplyReducer` forwards it on the
   chained `AU_WAGES_INCOME_TAX` alongside `personKey` and `residency`.
3. **Branch on source, then on residency**, in `AU_WAGES_INCOME_TAX`:
   - `workCountry === 'US'` → US-source. Add to `usOrdinaryIncomeYTD` only. **No** AU accumulator,
     **no** `foreignGeneralIncomeYTD`. (The AUD still lands in the AU account — this is a tax
     classification change, not a cash-flow one.)
   - `workCountry === 'AU'` **and** earner is AU-resident → unchanged (AU ordinary income,
     per-person FEIE accumulator, general basket).
   - `workCountry === 'AU'` **and** earner is a non-resident → AU-source income of a foreign
     resident: assessable at **non-resident marginal rates** (30% from the first dollar — no
     tax-free threshold, no Medicare levy [R3]), *not* final withholding. Book it to
     `auPersonOrdinaryIncomeYTD` / `auOrdinaryIncomeYTD` — the same accumulator the resident branch
     uses — which is already wired into the non-resident bracket path and is simply never fed
     today. Keep `foreignGeneralIncomeYTD` in this case: the income genuinely is foreign-source.
4. **Rename the reducer's documentation.** `AuWagesIncomeApplyReducer` is "wages paid in AUD",
   not "AU-source wages". The misleading docstring is what made the defect survive review.

### Scope

The currency-as-source conflation is specific to wages. Interest and dividends infer source from
the payer, which is correct. Rental infers it from the owner — see Gap 3.

---

## 2. Gap 2 — one flat 15% rate stands in for every non-resident withholding type

### Symptom

`au-tax-rates-base.js:21` defines a single constant:

```js
/** Flat withholding rate on non-resident withholding income (ATO). */
const NR_WITHHOLDING_RATE = 0.15;
```

applied at line 290 to the whole `auNonResidentWithholdingYTD` pool. Six distinct income types
are pooled into that one accumulator, at rates that are not the same in law:

| Feeder | `au-tax-module-2026.js` | Modelled | Correct |
|---|---|---|---|
| Wages | 103 | 15% | *does not belong here at all* — Gap 1 |
| Bank savings interest | 159-160 | 15% | **10%** |
| Fixed-income interest | 194-195 | 15% | **10%** |
| Unfranked dividends | 282-283 | 15% | **15%** ✔ (the one correct case) |
| AU stock capital gains | 360 | 15% | not withholding — NR marginal rates |
| TAP real-property gains | 352 | 15% | not withholding — NR marginal rates |

15% is the AU–US treaty rate for **portfolio unfranked dividends**. It looks as though one
income type's rate was generalised into a constant named for the whole bucket.

### Why that is wrong

The **concept** is sound — for interest, unfranked dividends and royalties the withholding genuinely
is a *final* tax, and that income is correctly kept off the assessable-income return [R1, R5].
What is wrong is the single rate, and which income types were let into the bucket.

- **Interest — modelled 15%, correct 10%.** Article 11(2) limits the source state to "10 percent
  of the gross amount of the interest", and the Technical Explanation adds in the same breath that
  "**Australia's statutory rate of tax on interest paid to nonresidents is generally 10 percent**"
  [R9], corroborated by [R1, R2]. Statutory and treaty coincide at 10%, so unlike the dividend case
  there is no rate anywhere in the system that could have produced 15%. Every non-resident year
  over-taxes AU interest by half again.

  The 2001 Protocol replaced Article 11 but **left the rate alone** — new paragraph (2) "is similar
  to existing paragraph (2) … subject to a maximum rate of 10 percent" [R13]. It added exclusive
  residence-state taxation (i.e. 0%) in paragraph (3), but only where the *recipient* is a
  government body, a central bank, or an unrelated **financial institution** — never an individual
  depositor. 10% is the rate for this model, before and after 2003, with no exceptions reachable by
  a natural person holding a bank account.

  Article 11(7) also settles the source rule the intro table asserts: interest has its source in the
  State of the payer (or a resident of it) [R9].
- **Unfranked dividends — modelled 15%, correct 15%.** Article 10(2) caps the source state at "15
  percent of the gross amount of the dividends" where the beneficial owner is a resident of the
  other State [R9, R13]. The 1982 Technical Explanation is explicit about the counterfactual: "In
  the absence of a Treaty, Australia, like the United States, imposes a tax of 30 percent on gross
  dividends paid to nonresidents. By Treaty, Australia is willing to reduce that tax to, but not
  below, 15 percent" [R9]. This is the one feeder the constant fits, and it is almost certainly
  where the 0.15 came from.

  **The reduced tiers are unavailable to individuals — settled by the Protocol text.** The 2001
  Protocol replaced Article 10 wholesale, and both sub-15% rates require a **corporate** beneficial
  owner: 5% where "the beneficial owner of the dividend is a **company** resident in the other State
  and owns directly shares representing at least 10 percent of the voting power", and 0% where a
  **company** has owned ≥80% of the voting power for the 12 months ending on the declaration date
  *and* clears the Article 16 Limitation-on-Benefits public-trading test [R13]. A natural person
  holding shares always falls to 15%. Since this model taxes individuals, **15% is the only dividend
  rate it can ever need** — do not build the tiering.
- **Franked dividends are exempt from withholding entirely.** Confirmed in the Protocol's own
  words: Australia's imputation system means "franked dividends are exempt from Australian dividend
  withholding tax **by statute**", while unfranked dividends "are subject to full dividend
  withholding tax when the shareholder is a foreign person" [R13, corroborating R1, R2]. The model
  has no franked non-resident path, so nothing is currently wrong; it is a gap to guard against when
  the rate table lands.
- **Royalties — not modelled. 5%, and this corrects an earlier draft *twice over*.** The original
  Article 12(2) capped the source state at 10% [R9]; Article 8(a) of the 2001 Protocol "reduces the
  maximum rate of withholding tax in paragraph (2) of Article 12 of the Convention to **5 percent**
  from 10 percent" [R13]. So the 5% I first took from a secondary source is right for current law,
  the 10% I then "corrected" it to is right only for pre-2003, and both belong in a year-keyed table
  rather than a constant. The Protocol also narrowed the *definition* of royalties (equipment hire
  moved to business profits; broadcasting/transmission rights added) — relevant only if royalties
  are ever modelled.
- **Capital gains are not withholding income at all.** A foreign resident's gain on Taxable
  Australian Property is *assessable* income — ITAA 1997 s855-10 restricts the foreign resident's
  CGT net to TAP — reported on an Australian return and taxed at foreign-resident marginal rates
  (30% from the first dollar) [R3, R5]. Routing it through a flat 15% final tax roughly halves it.

  **Correction to an earlier draft of this document:** the CGT discount is *not* flatly denied to
  foreign residents. Since 8 May 2012 the discount **percentage is apportioned** — s115-105 /
  s115-110 / s115-115 adjust it so as to deny the discount only *to the extent the gain accrued
  while the taxpayer was a foreign or temporary resident* [R3, R4]. A taxpayer who held the asset
  through both resident and non-resident periods keeps a pro-rated discount, and one who was a
  foreign resident on 8 May 2012 may elect a market-value calculation instead of pro-rating. Full
  denial applies only where the asset was acquired after 8 May 2012 *and* the taxpayer was a
  foreign resident for the whole ownership period. This matters here because the reference scenario
  has people moving between residencies mid-ownership, which is precisely the apportioned case.
- **Where the 15% on gains probably came from.** **Foreign Resident Capital Gains Withholding** is
  15% since 1 January 2025, with the previous $750,000 property threshold removed so it applies to
  every property sale [R10]. It really is 15% — but it is a *collection* mechanism: the vendor
  claims it as a credit on assessment and is refunded any excess [R10]. A payment on account, not a
  final tax. Modelling it as the final liability is the single largest under-taxation in this
  document.

### Fix

1. **Replace the scalar with a per-type rate table** on `AuTaxRatesBase`, so subclasses can vary
   it by financial year the way brackets already do:
   `{ interest: 0.10, unfrankedDividend: 0.15, frankedDividend: 0, royalty: 0.05 }` — treaty rates
   for a US-resident **individual**, verified against [R9] and [R13]. Statutory fallbacks where no
   treaty applies: 0.10 / 0.30 / 0 / 0.30. Only `royalty` is year-sensitive within the treaty (10%
   before the Protocol's 2003 entry into force, 5% after); the others are stable across both
   instruments. The corporate 5%/0% dividend tiers are deliberately absent — they are unreachable by
   a natural person, so modelling them would be dead code.
2. **Split the accumulator by withholding type** — `auPersonNrWithholdingYTD` becomes a map of
   `{ interest, unfrankedDividend, royalty }` (or three parallel fields). Each feeder books into
   its own type; the settle sums `Σ typeAmount × typeRate`. The AU tax document then reports one
   bracket row per type instead of one flat band, which is also what makes the CSV self-checking.
3. **Move capital gains out of the withholding bucket** into `auPersonCapitalGainsYTD` /
   `auCapitalGainsYTD` on the non-resident path — already summed into `assessableIncome` and taxed
   through `_nonResidentBrackets`, with no Medicare levy and no tax-free threshold, exactly as
   required [R3]. Feed `auPersonDiscountableGainsYTD` only with the **resident-period share** of
   the gain: s115-115 apportions the discount by days of Australian residence over the ownership
   period, so a straddling holding keeps a pro-rated discount and a wholly-non-resident post-2012
   holding keeps none. `design/62` already owns residency-aware cost-base handling and is the right
   home for the day-count; do not reuse the resident branch's unconditional discount wiring.
4. **Treaty-awareness guard.** The reduced rates apply because the recipient is a US resident.
   Key the table off the counterparty country already implicit in the model's two-country scope,
   and leave a comment where a third country would force a real treaty lookup.

### Interaction

Lowering interest 15% → 10% reduces AU tax, which reduces the US **passive**-basket FTC that AU
tax generates. Moving capital gains to marginal rates increases AU tax substantially in
non-resident disposal years. These push in opposite directions; they should be measured together,
not one at a time.

---

## 3. Gap 3 — a non-resident's AU rental income is assessed nowhere

### Symptom

`AU_RENTAL_INCOME_TAX` (`au-tax-module-2026.js:117-127`) has **no non-resident branch**:

```js
let next = { ...state, usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + toUSD(amount, 'AUD', state) };
if (isAuResident) {
  next = { ...next,
    auOrdinaryIncomeYTD:     state.auOrdinaryIncomeYTD + amount,
    foreignPassiveIncomeYTD: (state.foreignPassiveIncomeYTD ?? 0) + toUSD(Math.max(0, amount), 'AUD', state) };
}
return next;
```

When the owner is a foreign resident the income falls straight through: it reaches
`usOrdinaryIncomeYTD` and stops. Australia assesses nothing, and — the half that is easy to miss —
**it never enters `foreignPassiveIncomeYTD` either**.

It does not bite the current scenario (its rental years are resident years), which is precisely
why it needs writing down before someone models a US-resident landlord with an Australian
property and quietly gets a tax-free rent stream.

### Why that is wrong

Rental income from real property is sourced **where the property is** — always. Article 6 of the
AU–US treaty is a sourcing provision, and unlike the dividend, interest and royalty articles it
imposes **no rate cap on the source state**. The Technical Explanation [R9]:

> This Article provides that income from real property may be taxed by the Contracting State where
> the property is located. This rule does not confer an exclusive right of taxation on the State
> where the property is located. It simply provides that the situs State has the **primary** right
> to tax such income […] The provision in the U.S. Model for a binding election to be taxed on a
> net basis was deleted. Such an election is available under U.S. law and **Australia taxes income
> from real estate on a net basis.**

Two things fall out. The situs right is *primary, not exclusive* — the US taxes it too and
relieves by credit, which is exactly why the passive basket in step 1 below matters. And the net
basis is confirmed on both sides, so the model's existing signed net-rent amount (gross less
deductions, possibly negative) is the right quantity to assess; no gross-basis variant is needed.
So:

- **Australia**: an Australian rental property held by a foreign resident produces assessable
  Australian income at **non-resident marginal rates** on a lodged return. The ATO is explicit
  that a foreign resident earning rent from Australian property **should lodge an Australian
  return each year and include net rental income** — gross rent less rental deductions [R12] — and
  that a foreign resident pays tax on all Australian-sourced income other than the interest /
  unfranked dividend / royalty categories already taxed at source [R5]. It is not withholding
  income and there is no exemption. The model taxes it at zero.
- **United States**: because it is foreign-source, it belongs in the §904 **passive** basket
  regardless of the owner's residency. Gating `foreignPassiveIncomeYTD` on `isAuResident` starves
  the passive limitation for exactly the taxpayer who needs it — a US resident paying AU tax on AU
  rent, who currently gets basket room of zero and so cannot credit that AU tax at all.

Note this is the **mirror image of Gap 1**: wages are treated as foreign-source when they are not,
because currency was used as the proxy; rent is treated as domestic-source when it is not, because
residency was used as the proxy. One fix does not imply the other — they fail in opposite
directions.

### Fix

1. **Drop the `isAuResident` gate on `foreignPassiveIncomeYTD`.** AU-situs rent is foreign-source
   to the US in every case. This is a two-line change and is independently correct — it can ship
   ahead of the rest.
2. **Add the non-resident AU branch**, booking net rent to `auOrdinaryIncomeYTD` (per-person where
   available) so it lands on the existing non-resident bracket path. Rental losses
   are already signed and must stay signed — a negative net rent reduces the assessable amount and
   must not be floored at the accumulator (the existing `Math.max(0, amount)` floor is correct for
   the *basket numerator* only, where a loss contributes zero limitation room).
3. **Per-person attribution.** Unlike savings and wages, the rental reducer has no per-person path
   at all — it writes the household `auOrdinaryIncomeYTD` even when `state.people` is populated.
   `perPersonShare` in `tax-settle-service.js:174` then splits the household scalar **evenly across
   residents**, so a property owned outright by one spouse is taxed half to each. Nothing is lost,
   but the attribution is ownership-blind. Route it through `accumulateByOwnership` against the
   property asset the way `AU_SAVINGS_EARNINGS_TAX` does.

---

## 4. Interaction found in the primary text — Article 27(2) and FEIE

Reading Article 27 for the source rule turned up a constraint that bears on Gap 1 and is worth
recording before anyone implements it. Article 27(2) is an **anti-double-exemption** rule [R9]:

> […] certain exemptions granted with respect to earned income by the source country, in
> accordance with Articles 14 […], 15 (Dependent Personal Services), 17 […], or 19 […], will be
> inapplicable **to the extent that such income is not taxed by the residence country**.

The Technical Explanation's own worked example turns on **IRC §911** — the Foreign Earned Income
Exclusion, which this codebase already implements (`design/52` §4.2, `_computeFeie`). A US
resident performing services in Australia who would be exempt at source under Article 14/15 may
nonetheless be taxed by Australia to the extent the income is excluded from US tax by §911. "The
purpose of the exemption at source […] is to avoid double taxation, not to provide double
exemption."

This does **not** touch the spouse's case — Article 15 gives Australia no taxing right at all over
work performed in the US, so there is no source-country exemption for 27(2) to withdraw. It bites
only the `workCountry === 'AU'` branch of the Gap 1 fix, where an AU-performed wage is exempted at
source by Article 15(2)'s 183-day test *and* excluded from US tax by FEIE. Today that combination
would silently produce income taxed by neither country. Guard it when the branch is written, or at
minimum leave a comment at the Article 15(2) test pointing here.

---

## 5. Sequencing

There is no shared new component to build first — the non-resident bracket path already exists.
The ordering below is by blast radius, smallest first, so each step can be measured on its own.

1. **Gap 3, step 1** (drop the `foreignPassiveIncomeYTD` residency gate) — independent, two lines,
   ship immediately.
2. **Gap 2, steps 1-2** — the per-type rate table and the split withholding accumulator. Interest
   15% → 10% is the only rate that moves; dividends stay at 15%.
3. **Gap 2, step 3** — capital gains off the withholding bucket onto the bracket path. This is the
   first change that makes line 5 of the AU return non-zero, so it is the one to watch.
4. **Gap 1** — `workCountry`, threaded through the handler and reducer, branching on source.
5. **Gap 3, steps 2-3** — rental onto the bracket path, with ownership attribution.

## 6. Test plan

- **Unit, per gap.** A US-resident earner with `wageCurrency: 'AUD'` and `workCountry: 'US'`
  produces zero AU assessable income, zero NR withholding, zero `foreignGeneralIncomeYTD`, and the
  full USD-converted amount in `usOrdinaryIncomeYTD`. The same earner with `workCountry: 'AU'`
  produces AU assessable income at NR marginal rates. Interest at 10% and unfranked dividends at
  15% in the same year, proving the rates are no longer shared. A non-resident TAP disposal taxed
  at marginal rates, with a straddling holding keeping a **pro-rated** discount and a
  wholly-non-resident post-2012 holding keeping none. A US-resident landlord with AU rent: AU
  assessable > 0 **and** `foreignPassiveIncomeYTD` > 0.
- **Published-base guard.** Extend `tests/unit/tax-rates-published-bases.test.mjs` with the
  foreign-resident marginal brackets and the withholding rates, transcribed **from the authority
  named in §7**, never from our own output — the standing rule from the AU Stage 3 and HI Act 46
  work. The foreign-resident schedule to reproduce (2024‑25 and 2025‑26, unchanged between them
  [R3]): 30% on $0–$135,000; **$40,500 plus 37c** for each $1 over $135,000 to $190,000;
  **$60,850 plus 45c** for each $1 over $190,000. No tax-free threshold, no Medicare levy.
- **Export footing.** `npm run export:tax -- <cfg> --cc AU --check` must stay green; the AU return
  for a fully non-resident, US-performed-work year should reduce to all-zero lines.
- **Golden.** All three gaps move lifetime tax. Expect AU liability to *fall* in the affected
  non-resident years (the wage leaves the AU return, interest drops 15%→10%) and to *rise* in
  non-resident disposal and AU-rental years. The US FTC falls alongside the AU tax that generated
  it. Re-pin `tests/unit/cross-border-relief-scenario.test.mjs` deliberately, with the reasoning
  recorded, the way `design/72` did.

---

## 7. References

Retrieved 2026-07-20. Rates and thresholds below were current for FY2024‑25 / FY2025‑26; anything
implemented against them must be re-checked at the financial year the rates module targets, and
transcribed into `tax-rates-published-bases.test.mjs` **from these sources**, never from our output.

The two treaty documents (R9, R13) are held locally at `scenarios/austtech.pdf` and
`scenarios/Treaty-Australia-Protocol-TE-3-5-2003.pdf`. They fetch as unparseable binary through
web tooling but extract cleanly with `pdftotext -layout`, which is how they were read.

| # | Source | Used for |
|---|---|---|
| R1 | ATO — [Interest, unfranked dividends and royalties](https://www.ato.gov.au/individuals-and-families/investments-and-assets/foreign-resident-investments/interest-unfranked-dividends-and-royalties) | Withholding is a final tax on these three categories; franked dividends exempt |
| R2 | PwC Worldwide Tax Summaries — [Australia, Corporate: Withholding taxes](https://taxsummaries.pwc.com/australia/corporate/withholding-taxes) | **Statutory** (non-treaty) rates: interest 10%, unfranked dividends 30%, royalties 30%; franked dividends exempt. Its treaty column (dividends 0/5/15, interest 0/10/15, royalties 5) is *current, post-Protocol, and corporate-inclusive* — the tiers it lists are the ones R13 shows are unreachable by an individual. Useful for the statutory fallbacks; defer to R9/R13 for treaty rates |
| R3 | ATO — [Tax rates: foreign resident](https://www.ato.gov.au/tax-rates-and-codes/tax-rates-foreign-residents) | Foreign-resident marginal brackets; no tax-free threshold; no Medicare levy |
| R4 | ATO — [CGT discount for foreign residents](https://www.ato.gov.au/individuals-and-families/investments-and-assets/capital-gains-tax/foreign-residents-and-capital-gains-tax/cgt-discount-for-foreign-residents) | Post-8-May-2012 discount **apportionment**, not outright denial; market-value election |
| R5 | ATO — [Tax on Australian income for foreign residents](https://www.ato.gov.au/businesses-and-organisations/international-tax-for-business/in-detail/income/tax-on-australian-income-for-foreign-residents) | The structural rule: all Australian-**sourced** income is taxed except that already correctly taxed at source |
| R6 | Asena Advisors — [US–AU DTA Article 15: Dependent Personal Services](https://asenaadvisors.com/blog/dta-article-15-dependent-personal-services/) | Superseded by R9, which says the same thing from the primary source. Retained only as a plain-English cross-check |
| R7 | *FCT v French* (1957) 98 CLR 398 — [ATO Legal database](https://www.ato.gov.au/law/view/print?DocID=JUD/98CLR398/00004&PiT=99991231235958) | Source of wages is the place of performance, even where salary is paid to a bank account in the other country |
| R8 | ATO ID 2003/438 — [Legal database](https://www.ato.gov.au/law/view/document?docid=AID/AID2003438/00001) | Source is a question of fact; *French* is not an absolute rule (cf. *FCT v Mitchum*) |
| R9 | **US Treasury Technical Explanation of the 1982 AU–US Convention** — [irs.gov/pub/irs-trty/austtech.pdf](https://www.irs.gov/pub/irs-trty/austtech.pdf) (29pp; read in full via `pdftotext -layout`) | **Primary source, read directly.** Art 6 situs/primary-not-exclusive/net basis; Art 10(2) 15% cap and the 30% no-treaty counterfactual; Art 11(2) 10% cap + "Australia's statutory rate … is generally 10 percent"; Art 11(7) interest source = payer's State; Art 12(2) 10% royalty cap; Art 15(1) residence-only-unless-exercised + the three Art 15(2) conditions; Art 27(1) deemed source; Art 27(2) anti-double-exemption and its §911 example |
| R10 | ATO — [Foreign resident capital gains withholding overview](https://www.ato.gov.au/individuals-and-families/investments-and-assets/capital-gains-tax/foreign-residents-and-capital-gains-tax/foreign-resident-capital-gains-withholding/foreign-resident-capital-gains-withholding-overview) | FRCGW 15% from 1 Jan 2025, $750k threshold removed; credited on assessment, refundable |
| R11 | Asena Advisors — [US–AU DTA Article 6: Income from Real Property](https://asenaadvisors.com/blog/dta-article-6-income-from-real-property/) | Superseded by R9. Retained only as a plain-English cross-check |
| R12 | ATO — [Rental income you must declare](https://www.ato.gov.au/individuals-and-families/investments-and-assets/property-and-land/residential-rental-properties/rental-income-you-must-declare) | Foreign-resident landlords lodge annually and declare **net** rental income |
| R13 | **US Treasury Technical Explanation of the 2001 Protocol** (signed 27 Sep 2001, released 5 Mar 2003) — [home.treasury.gov](https://home.treasury.gov/system/files/131/Treaty-Australia-Protocol-TE-3-5-2003.pdf) (41pp; read in full via `pdftotext -layout`) | **Primary source, read directly.** Which Convention articles the Protocol amends (see caveat 1); Art 10 replaced — 15% general, 5% and 0% both requiring a *corporate* beneficial owner, franked dividends statutorily exempt; Art 11 replaced but the 10% cap retained, 0% only for governments/central banks/unrelated financial institutions; Art 12(2) royalty cap cut 10% → 5% and the royalty definition narrowed; Art 27 re-sourcing restated |

**Caveats on this reference set.**

1. **Both primary sources have now been read in full — this caveat is closed.** R9 explains the
   1982 Convention; R13 explains the 2001 Protocol that amends it. The Protocol touches Convention
   Articles **1, 2, 4, 7, 8, 10, 11, 12, 13, 16, 21 and 22** [R13]. Critically for this document, it
   does **not** touch **Article 6 (Income from Real Property), Article 15 (Dependent Personal
   Services), or Article 27 (Miscellaneous)** — so every passage quoted in Gap 1, Gap 3 and §4 is
   still current law, not superseded 1982 text. Of the rate articles, only royalties moved. R13 also
   restates the Article 27 re-sourcing rule that `design/72` Gap 1 depends on, independently
   confirming that citation.
2. **The ATO site rejects automated fetches (HTTP 403).** R1, R3, R4, R5, R10 and R12 were reached
   through search-result summaries rather than by retrieving the pages. The figures are consistent
   across multiple independent results, but open each page in a browser when transcribing exact
   bracket bases into the published-base test.
3. **Statutory section numbers are cited from knowledge, not verified.** ITAA 1936 s128B / s128D
   (withholding, and its non-assessable non-exempt treatment) and ITAA 1997 s855-10, s115-105,
   s115-110, s115-115 could not be retrieved — AustLII also returned 403. The *substance* of each is
   confirmed by the ATO and secondary sources above; the *section numbers* should be checked on
   AustLII or the Federal Register of Legislation before they appear in code comments.
