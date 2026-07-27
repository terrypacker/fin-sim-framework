# 72 — Company equity sale: cross-border fidelity fixes

**Status: Gaps 1, 2 & 3 IMPLEMENTED** (+ the de-minimis sub-fix in §1). Gap 4 outstanding.
Suite green: 3779 unit + 906 viz. Surfaced by scenario testing of `CompanyEquity` sale timing
across a US→AU residency change.

**Result: the ~4.4× residency cliff was ~70% modelling artifact.** After both fixes the
2031→2032 step is **1.31×** (27.36× → 20.81×), and the post-move decay is the gentle slope you
would expect from shrinking compounding runway rather than a discontinuity. On the reference
scenario, lifetime tax falls 37.7% and ending net worth rises 6.0%; see the re-pinned design-52
lock-ins in `tests/unit/cross-border-relief-scenario.test.mjs` for the rationale.

Originally: sweeping a `CompanyEquity` sale year across a `moveYear` boundary produced a
**~4.4× collapse in terminal value per dollar of proceeds** the moment the sale landed in an
AU-resident year, causally attributable to the residency change (relocating `moveYear` relocated
the cliff exactly). It read as economics. It was mostly two missing tax reliefs — the sections
below are written in the order they were diagnosed, so the "Symptom"/"Cause" text describes
pre-fix behaviour.

This design collects those findings. Gaps 1–3 are correctness bugs. Gap 4 is a fidelity
limitation: `CompanyEquity` currently hardcodes a single tax characterisation that does not
survive contact with real instruments.

**Builds on / relates to:**
- **`design/52` (cross-border relief)** — owns the per-§904-basket FTC pools that Gap 1 shows
  can never be drawn against US-source income.
- **`design/57` (AU CGT reform)** — the FY2027+ regime (discount removed, indexation, 30%
  minimum tax) is confirmed firing correctly on the company-sale path; not a defect.
- **`design/62` (residency-CGT fidelity)** — owns the s855-45 cost-base reset that Gap 3 shows
  never reaches `CompanyEquity`.
- **`design/49`** — introduced `COMPANY_SALE` / `CompanySaleApplyReducer`.

---

## 1. Gap 1 — treaty re-sourcing is missing; US and AU tax are additive  ✅ FIXED

### Symptom

A US-source capital gain realised while AU-resident is taxed at a combined effective rate of
**~70%** — approximately the *sum* of the US rate (~23%: LTCG + NIIT) and the AU marginal rate
(~47%: top bracket + Medicare levy). The correct combined rate is **`max()`, ~47%**.

Proof the behaviour is additive without needing a per-country split: the observed combined
rate **exceeds AU's own top statutory rate**, and no `max()` computation can exceed the larger
of its inputs.

### Cause

`CompanySaleApplyReducer` chains `COMPANY_SALE_TAX`, which is assessed by both countries. The
US side generates a foreign tax credit, but the gain is **US-source**, and §904 will not credit
foreign tax against US-source income. The credit therefore lands in `ftcPoolPassive.<year>` and
is never drawn down — it ages out after the 10-year carryforward. Both revenue authorities are
paid in full.

### Why that is wrong

The US–Australia treaty relieves precisely this case via a **re-sourcing rule**. Treaty
Article 27 re-sources US-source income to foreign source "as necessary to permit relief from
double taxation under Article 22" — **for §904 limitation purposes only**. The IRS names
Australia explicitly as a country whose treaty "provide[s] for an additional credit allowing a
U.S. citizen credit for part of the tax imposed by the treaty partner on U.S. source income."

Operationally this is the **three-bite rule**, reported on a separate Form 1116 under the
category **"certain income re-sourced by treaty"** (Category F):

1. **US** taxes at the treaty-permitted rate.
2. **AU** taxes the full gain, less a credit for the US tax from step 1.
3. **US** collects only *residual* tax, and only if the US rate exceeds AU's.

Where AU's rate is the higher one — the usual case for capital gains post-`design/57` — step 3
nets to approximately zero and the combined burden is the AU rate alone.

### Scope of the defect

**No re-sourcing concept exists anywhere in `src/finance/`.** The FTC limitation baskets are
only `foreignGeneralIncomeYTD` and `foreignPassiveIncomeYTD`; there is no Category-F
equivalent. US-source income can therefore *never* generate usable limitation room. This is
not a mis-set rate — it is a missing basket, so the stranding is structural.

Note the defect is **not specific to company equity**. Any US-source income realised while
AU-resident is affected — US dividends, US bond coupons, US brokerage capital gains. Company
equity merely makes it visible because it is a single large lump.

### Sketch

1. New basket `ftcResourcedByTreaty` (or a `resourced` flag on the existing pools) alongside
   general/passive.
2. At AU settle, classify AU tax on US-source income as creditable **into that basket**,
   rather than excluding it as `_auTaxOnUsSourceIncome` does today.
3. Apply the §904 limitation per-basket as now; the re-sourced basket's limitation is computed
   against the re-sourced income rather than against foreign-source income.
4. Guard: relief is capped at the US tax on that income — re-sourcing unlocks the credit, it
   does not refund AU tax.

`_extraStatePatches` in `src/finance/tax/tax-settle-classes.js` is the seam; it currently
*subtracts* `_auTaxOnUsSourceIncome` from the creditable amount, which is exactly the quantity
that should instead be routed to the new basket.

### Measured impact (with Gap 3)

Effective tax on the reference post-move sale fell from **70.0% to 20.9%** — better than the
~47% predicted, because Gap 3's step-up shrinks the AU base *before* re-sourcing credits what
remains. The two fixes are multiplicative, which is why they had to be measured together.

---

## 2. Gap 2 — marginal proceeds compound at ~2.9% instead of ~8%  ✅ FIXED

### Symptom

Identical marginal proceeds, credited to the same account in the same year, compound at
**8.2%/yr** in one scenario and **2.9%/yr** in another. Over ~36 years that is a 5.5×
divergence, and it is what turns an already-heavily-taxed post-move sale into a tranche with a
terminal multiple **below 1.0** — i.e. money that arrives and then loses value.

In the low case the marginal contribution is essentially **flat for three decades** before
reappearing at the very end of the run.

### Ruled out by measurement

- **Not consumed.** `cumulativeConsumption` delta between the paired runs is exactly **0**, and
  `spendingStrategy` is `FIXED` (not wealth-linked). The money is not being spent.
- **Not the multi-holding `transaction()` desync.** Holdings sum to the balance to the cent.
- **Not ongoing tax drag.** The cumulative-tax delta is flat and slightly *declining* after the
  sale year.
- **Not a different account.** The entire delta stays in the destination account in both cases.
  *(This one was the misread that cost the most time: the delta was tracked in the account the
  proceeds landed in, and that account was assumed to be the configured destination. It was
  not — see the Cause below.)*

### Lead

The behaviour correlates exactly with **whether the destination account survives to end of
run**. Post-move, the US brokerage acts as the cross-border funding account — the audit ledger
shows several hundred `INTL_TRANSFER_APPLY` debits sweeping it to fund AU-side spending. In the
low case it is drained to exactly **\$0** before simEnd; in the high case it retains a
substantial balance. A marginal dollar earns a cash-like return precisely when parked in an
account destined for exhaustion.

Suspect drawdown sequencing, or an interaction between the cross-border sweep and
`replenishSavings`. **Still unexplained.** *(It was neither: the account that drained is the
transaction account, and the proceeds were in it because routing had failed.)*

### Cause — the sale destination was never honoured

**The proceeds were not in the account the modeller chose.** They were credited to the US
cash pool, where they earned the savings rate (3% in the reference scenario — the observed
"2.9%") until spending consumed them.

`saleDestinationAccount` is written by the asset editors as `a.stateKey ?? a.id`. Any account
that had no `stateKey` when the destination was picked — **every account created in the UI**,
whose stateKey is stamped later — persists as a bare account **id** (`ac45`). The sale
handlers resolved it with a bare `state[saleDestinationAccount] != null` test, and runtime
account state carries `stateKey` but *not* `id`, so the id form always missed and fell through
to `defaultUsCashKey`. It never threw and never warned: the sale "worked", the money simply
landed somewhere else.

That also explains the drain-to-zero correlation the lead noted. The fallback *is* the
transaction account — the account spending is drawn from first and the cross-border sweep
empties. The exhaustion was a consequence of the mis-routing, not a separate mechanism.

Not company-equity-specific: the same helper is duplicated in the US real-property, AU
real-property and collectible sale paths, all with the same defect.

### Fix

`ScenarioLoader._normalizeSaleDestinations()` rewrites id → `stateKey` at load, against the
just-deserialized `accountService`. Both carriers are normalized, because either can be the
live one: the domain records (`companyEquities` / `realProperties` / `collectibles`, on the
service objects the toolsets read *and* the cfg lists that get re-serialized) feed the
toolset-compile path, and persisted `events[].data` feeds the serialized-graph path. The four
copied `resolveDestinationKey` helpers now delegate to a shared
`resolveSaleDestinationKey(state, dest, defaultKey)` in `cash-routing.js`, so the
cash-pool fallback survives for a genuinely unresolvable destination — one place, one
behaviour.

Upstream, the three asset editors now put the **stateKey** in the option value rather than
`a.stateKey ?? a.id`, and omit accounts that have no stateKey (they are inert — there is no
state to credit). A legacy id still selects its account in the dropdown, so re-saving migrates
it. The loader normalization stays a migration rather than a permanent crutch. Note that since
design 55 §3.1 (stateKey-at-creation) a UI-created account gets a stateKey immediately, so the
id form only reaches new saves from scenarios that predate it.

### Measured impact

On the reference scenario (US→AU move 2031, sale 2032, ±\$300k stake), the marginal tranche's
implied compound rate rises **3.6% → 4.2%/yr** and ending net worth rises ~3.5% in both arms.
The residual 4.2% is now ordinary economics, not an artifact: the destination brokerage grows
at 5% with a 2% dividend that is not reinvested, and ~\$107k of the \$476k proceeds goes to tax
in the sale year. The annual delta now sits in the destination account and compounds smoothly
at ~5%/yr instead of parking flat in cash for the first three years.

Golden lock-ins did not move — the default scenario's destination is stored as a stateKey.

### Reproduction

Pair two runs differing only by one company-equity tranche and track the per-account delta
annually (`npm run diff -- a.json b.json --track`). Pre-fix, the delta appears in the US
*checking* account rather than the chosen brokerage; that is the whole tell, and it is visible
by 12 months after the sale without instrumenting the engine.

---

## 3. Gap 3 — `CompanyEquity` is skipped by the residency cost-base reset  ✅ FIXED

`ChangeResidencyApplyReducer` (`src/finance/reducers/change-residency-apply-reducer.js`) applies
the ITAA97 s855-45 market-value cost-base reset on ceasing/commencing residency to:

- accounts (`accountService.recordResidencyChange`)
- collectibles (`collectibleService.recordResidencyChange`)
- real properties (`realPropertyService.recordResidencyChange`)

**...but not company equities.** `CompanyEquityService.recordResidencyChange()` exists and is
**never called**. `CompanySaleApplyReducer` computes a single `gain = salePrice - costBasis` and
hands the same figure to both countries, so AU assesses the entire gain from the original basis
rather than only post-arrival appreciation.

### Status: LIVE and binding

Initially parked on the assumption that a zero-basis instrument has nothing to reset. That
assumption does **not** survive the realistic case:

- Where the interests are **fully vested before the residency change**, Division 83A has no AU
  application (§4), so they are ordinary **CGT assets** in AU hands.
- Shares in a foreign private company are **not taxable Australian property**, so s855-45
  applies on commencing residency: the holder is taken to have **acquired them at market value
  at that date**.
- A vested interest in a company with a real valuation **has** an ascertainable market value at
  the move. The model asserts as much itself, by carrying the stake at a positive, annually
  appreciating balance-sheet value.

So the AU cost base should reset to market value at the move, and AU should assess only
**post-arrival appreciation** — not the whole gain from the original basis.

### The asymmetry the data model cannot express

This is the deeper issue. After a residency change the two countries hold **different bases for
the same asset**:

| | US basis | AU basis |
|---|---|---|
| Zero-basis incentive interest, post-move | **0** (unchanged) | **market value at move** (s855-45) |

`CompanyEquity` has a single scalar `costBasis`, and `CompanySaleApplyReducer` computes one
`gain = salePrice - costBasis` and hands it to both countries. There is no representation in
which US basis stays at zero while AU basis steps up. The collectibles and real-property paths
already solved this with `costBaseByCountry` — company equity needs the same treatment, not
just the same reducer call.

### Impact

Larger than Gap 1 for any interest whose value at the move is a substantial fraction of its
eventual redemption value. In that case AU's assessable gain shrinks to the post-arrival
increment, AU tax falls toward negligible, and the combined burden approaches the US rate
alone — i.e. **the residency cliff for such an interest largely disappears.** Combined with
Gap 1, most of the modelled ~4.4× cliff is attributable to missing relief rather than to real
economics.

### Fix

Call `CompanyEquityService.recordResidencyChange()` from `ChangeResidencyApplyReducer` alongside
the other three services, stamp `costBaseByCountry.AU`, and have the sale reducer read the
per-country basis when computing the AU gain — mirroring `us-collectible-classes.js`.

---

## 4. Gap 4 — one hardcoded characterisation for every instrument

### Limitation

`CompanyEquity` models exactly one thing: **an asset that appreciates at a rate, is sold in a
year, and produces a capital gain equal to `salePrice − costBasis`, characterised identically in
both countries.** `CompanySaleApplyReducer` has no notion of the gain being anything else.

Real instruments do not all behave that way, and the differences are not second-order — they
change the *rate schedule*, not just the base.

### US characterisation branches

| Instrument / event | Likely US treatment |
|---|---|
| Founder or investor stock, sold to a third party | Capital gain; basis = amount paid |
| Incentive units with a grant-time election | Capital gain on appreciation; basis often **zero** |
| Incentive units **without** a valid grant-time election | Some or all **ordinary** compensation income |
| Redemption by the issuer (partnership/LLC) | §736(b) capital, but §736(a) service payments are **ordinary** |
| Any partnership interest disposal | §751 "hot assets" (unrealised receivables, inventory) recharacterised as **ordinary** |
| Redemption by the issuer (corporation) | §302 — exchange treatment *only* if the tests are met; otherwise a §301 **distribution** |
| C-corp stock, 5-year hold, qualifying | §1202 QSBS — potentially **0%** federal |

Note the §751/§736 recharacterisation applies to a *portion* of the proceeds, so the realistic
model is a **split** between ordinary and capital, not a single flag.

### AU characterisation branches

Materially more consequential, because AU can switch the entire regime:

- **Division 83A (employee share scheme)** — where the interest is an ESS interest, the discount
  is **ordinary income at the deferred taxing point**, *not* a capital gain. That means no CGT
  discount and no `design/57` indexation relief; assessed at full marginal rates. The deferred
  taxing point is the earlier of: real risk of forfeiture ending, cessation of employment, or
  the 15th anniversary of grant.
- **CGT** — applies instead where Division 83A does not, or to post-taxing-point appreciation.
- **The inbound-resident switch:** where a foreign resident's ESS interests **fully vest before
  arrival in Australia**, there are no Division 83A implications at all, and subsequent gain is
  a CGT matter. Vesting date relative to `moveYear` therefore selects between two entirely
  different AU regimes.

**`vestingDate` is the required primitive.** It is not merely descriptive — compared against
the residency-change date it selects the AU regime, and it is the precondition for Gap 3's
s855-45 reset. A fully-vested-before-move interest lands in CGT + cost-base-reset; an interest
still vesting at arrival lands in Division 83A ordinary income with no reset. Vesting may be
**graded** (a fraction per anniversary), so the field should be a schedule, not a scalar.

### A third axis: redemption route

Independently of character, *how* the interest is liquidated changes the treatment:

| Route | Consequence |
|---|---|
| Third-party sale / whole-company sale | Cleanest — exchange treatment, capital |
| **Issuer buyback while the holder retains other interests** | **Partial redemption.** §302's exchange-treatment tests (substantially disproportionate / complete termination) can fail, recharacterising proceeds as a §301 distribution — i.e. a **dividend**, with no basis offset |
| Partnership/LLC redemption | §736(a) service payments ordinary; §751 hot assets ordinary |

The engine models liquidation as a single `plannedSaleYear` with capital-gain treatment and has
no notion of route. A partial issuer buyback is a materially different — and commonly worse —
event than the sale it is currently modelled as.

### A fourth axis: the payout may be contingent, not chosen

`plannedSaleYear` presumes the holder *picks* the year. For an interest that pays out only on a
liquidity event (a whole-company sale), the year is a **stochastic event the holder does not
control**. Modelling it as a chosen date overstates the actionability of the timing lever and
understates the variance — and where that event distribution straddles a residency change, the
cliff analysis in §1/§3 should be run as a *probability-weighted* result rather than a
point estimate. Candidate representation: an event probability distribution over years, run
through Monte Carlo, rather than a fixed `plannedSaleYear`.

The engine has no representation of any of this. Every company-equity sale is routed to
`COMPANY_SALE_TAX` as a capital gain in both countries, in a year the modeller chose.

**Most of the contingent-payout machinery already exists**, which makes this the cheapest slice
of Gap 4 to build first:

- `BernoulliDistribution` (`simulation-framework/distributions.js`) for the occurrence flag.
- `applyRealPropertySaleYearParams()` is the exact precedent for patching a sale year from an MC
  param — necessary because toolsets read `cfg.companyEquities`, not `cfg.parameters`.
- `US_COMPANY_SALE.schedules()` already filters `plannedSaleYear != null`, so a null year
  suppresses the sale with no new mechanism.

Two design points that are *not* free:

1. **Correlated draws.** Tranches paying from the same liquidity event must share one occurrence
   draw and one year draw. Independent sampling invents impossible worlds and understates
   variance by diversifying an undiversifiable risk.
2. **Non-occurrence semantics.** Nulling the sale year stops the sale but leaves the stake on the
   balance sheet at its appreciated value, inflating net worth. "Company failed" (value → 0) and
   "company survives but never exits" (value retained, never sold) are different outcomes and
   need to be distinguished — ideally a categorical draw rather than a Bernoulli.

### Sketch

Add a `taxTreatment` descriptor to `CompanyEquity`, defaulting to today's behaviour so existing
scenarios are inert:

```text
vestingSchedule: [{ date: '<YYYY-MM-DD>', fraction: 0.25 }, …],  // drives the AU regime switch
redemptionRoute: 'THIRD_PARTY_SALE' | 'ISSUER_BUYBACK' | 'PARTNERSHIP_REDEMPTION',
taxTreatment: {
  us: { character: 'CAPITAL' | 'ORDINARY' | 'DIVIDEND' | 'SPLIT', ordinaryFraction: 0 },
  au: { regime: 'CGT' | 'ESS_DIV83A' },   // derived from vestingSchedule vs residency date
},
```

`au.regime` should be **derived**, not hand-set: comparing the vesting schedule against the
residency-change date is exactly the determination, and making the modeller restate it invites
the two to drift.

`CompanySaleApplyReducer` then emits `COMPANY_SALE_TAX` split across the ordinary and capital
families per country, rather than a single capital-gain action. The AU `ESS_DIV83A` branch
routes the gain to `auOrdinaryIncomeYTD` instead of `auCapitalGainsYTD`, which also removes it
from the `design/57` indexation path.

This is the largest of the four items and probably wants its own design once the required
branches are known. Gaps 1–3 are independent of it and should not wait.

---

## 5. Test-infrastructure note

Building a **zero-equity control** for A/B comparison requires an explicit tombstone. Setting
`companyEquities: []` does **not** produce a scenario without company equity —
`ScenarioLoader._driftMergeDomainRecords` re-adds the scenario-class default:

```js
cfg.deletedDefaults = { ...cfg.deletedDefaults, companyEquities: ['companyEquityAccount'] };
```

Without it, the "no equity" baseline silently runs *with* the default stake and can end richer
than the one-tranche case, inverting the conclusion. The same trap applies to
`persons` / `accounts` / `realProperties` / `collectibles`.

---

## 6. Proposed phasing

| Phase | Item | Status |
|---|---|---|
| 1 | **Gap 3** — `costBaseByCountry` + `recordResidencyChange` for company equity | ✅ **DONE** |
| 2 | **Gap 1** — treaty re-sourcing basket (+ FITO de-minimis apportionment) | ✅ **DONE** |
| 3 | **Gap 2** — explain the 2.9% compounding anomaly | ✅ **DONE** — `saleDestinationAccount` id form never resolved; proceeds fell back to the cash pool |
| 4 | **Gap 4** — `vestingSchedule` / `redemptionRoute` / `taxTreatment` | Outstanding; likely its own design doc |

Gaps 1 and 3 were measured **together**, deliberately: both reduce the post-move penalty and
each alone understates the correction.

### Files touched (Gaps 1, 2 & 3)

| Gap | File |
|---|---|
| 2 | `finance/account-rules/cash-routing.js` — shared `resolveSaleDestinationKey` |
| 2 | `finance/account-rules/us/us-income-classes.js`, `us-collectible-classes.js`, `us-real-property-classes.js`, `au/au-real-property-classes.js` — four copied resolvers now delegate |
| 2 | `scenarios/scenario-loader.js` — `_normalizeSaleDestinations` (id → stateKey, records + persisted events) |
| 2 | `visualization/assets/company-equity-editor.js`, `collectible-editor.js`, `real-property-editor.js` — destination select emits stateKeys only |
| 3 | `finance/assets/company-equity.js` — `costBaseByCountry` / `acquisitionPriceLevel` / `acquisitionDateByCountry` |
| 3 | `finance/services/company-equity-service.js` — `recordResidencyChange` step-up |
| 3 | `finance/reducers/change-residency-apply-reducer.js` — step 1d, copy-on-write |
| 3 | `finance/account-rules/us/us-income-classes.js` — per-country gain on sale |
| 3 | `finance/tax/us/us-tax-module-2026.js`, `finance/tax/au/au-tax-module-2027.js` — consume `auGain` / `auIndexedGain` |
| 3 | `scenarios/toolsets/us-company-sale-toolset.js`, `us-income-toolset.js`, `scenario-compiler.js`, `us-au-cross-border-toolset.js`, `scenario-serializer.js` |
| 1 | `finance/tax/tax-settle-classes.js` — `ftcCurrentResourced` + de-minimis apportionment |
| 1 | `finance/tax/us/us-tax-rates-base.js` — third basket + shared headroom cap |
| 1 | `finance/tax/us/us-tax-document-2026.js` — category-F lines (footing) |
| 1 | `scenarios/toolsets/us-tax-toolset.js`, `finance/state/intl-retirement-state.js`, `finance/services/state-schema-registry.js` |

### Two sub-fixes the work forced out

**Shared §904 headroom cap.** Per-basket limits are `grossTax × numerator / totalTaxable`, but
`totalTaxable` is net of deductions while the numerators are not, so the fractions can sum past
1. With two baskets that was latent; with three it broke the 1040 footing check (credits
exceeded gross tax). Baskets now draw against a shared remaining-headroom budget in declaration
order, with the re-sourced basket last — the treaty grants an *additional* credit, so it is the
one that should be squeezed, and its unused foreign tax stays banked in its own pool.

**FITO de-minimis apportionment.** Under the A\$1,000 shortcut `fitoLimit` is null, so
`_auTaxOnUsSourceIncome` returned 0 — declaring the *entire* AU liability to be tax on AU-source
income. In a large-realisation year that leaked six figures of AU tax on US-source income into
the general/passive baskets. Now apportioned by US-source income share when no detail computed a
limit. This was a **pre-existing** hole that Gap 3 exposed by shifting which years take the
shortcut; `FTC-US-9` is the guard.

---

## 7. Open questions

1. Does the re-sourced basket need its own carryforward vintage pool, or can it share the
   existing 10-year mechanism keyed by year?
2. Should re-sourcing be opt-in per scenario (a treaty-election flag), given that claiming it
   is an election in practice?
3. ~~Does Gap 2 affect non-equity inflows?~~ **Yes** — answered by the fix. The same
   unresolved-destination defect was present in the US real-property, AU real-property and
   collectible sale paths, and is fixed in all four. A UI-created destination account was the
   trigger in every case.
4. For Gap 4, is a two-country `taxTreatment` sufficient, or does the deferred taxing point
   need to be a **schedule** (vesting tranches taxed at different points)?

---

## 10. Tooling added alongside this work

Two general-purpose scripts, both born as throwaway probes during this investigation and worth
keeping because the existing tools could not answer their questions:

| Script | npm | Answers |
|---|---|---|
| `scripts/diff-scenarios.mjs` | `npm run diff` | *Where* and *when* do two scenarios diverge? Point-diffs every numeric state field ranked by \|delta\| at any date (`--at`), or tracks an annual delta series (`--track`). `run-scenario.mjs` compares only final summary rows and account balances, which cannot surface the accumulators — tax buckets, FTC pools, YTD income — that actually explain a divergence. |
| `scripts/sweep-scenario.mjs` | `npm run sweep` | Which way does a lever push, and is the response *smooth*? Varies one param over a range and tables terminal metrics. |

Both were load-bearing here. The point-diff located the FTC stranding and the de-minimis leak;
the track mode's flat-delta signature is what identified Gap 2; and the sweep is what proved the
cliff tracked `moveYear` rather than the calendar.

**The heuristic worth remembering** — a sweep step larger than the statutory difference at that
boundary can justify is the tell for a missing relief rather than real economics. That is how
this entire design doc got written.

Also noted while building the sweep tool: **company equity has no generated per-record params**
(only the global `companySaleYear`, node-linked to `companyEquityAccount`), unlike
`prop.*` / `acct.*` / `coll.*` / `person.*`. A multi-tranche scenario therefore cannot sweep its
2nd or 3rd tranche without direct cfg mutation — another argument for the per-record treatment
in §4.
