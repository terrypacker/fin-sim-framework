# 52 — True Cross-Border Relief (FEIE + basketed FTC + AU FITO)

**Status**: **Implemented** (branch `wip/true-foreign-tax-credit`). Shipped in five
commits: schema (P1), sourcing/basket dual-write tags (P2), FEIE (P3), the relief
flip — per-§904-basket FTC + pool funding + AU FITO landing together (P4–6) — and
cleanup (remove `ftcYTD`, per-basket/FITO document lines, evt/tax regold, scenario
lock-in). No pre-existing golden asserted a post-credit cross-border liability, so
the suite stayed green through the flip; the default US→AU retiree's lifetime tax
rose ~15.5% and ending wealth fell ~1.6% (the intended over-relief correction),
now pinned by `tests/unit/cross-border-relief-scenario.test.mjs`. Follow-up to
`design/51-tax-bucket-fx-normalization.md`, which normalized `ftcYTD` into USD but
explicitly left its *semantics* untouched: it still accumulates *income* and is
credited dollar-for-dollar against US tax. This design replaces that single line with
the three real regimes that govern a US/AU dual filer:

1. **FEIE** — the US Foreign Earned Income Exclusion (Form 2555).
2. **FTC** — the US Foreign Tax Credit (Form 1116), **per §904 basket**, with a
   10-year carryforward *per basket*.
3. **FITO** — the Australian Foreign Income Tax Offset, with its **own, different**
   rules (single bucket, **no** carryforward, \$1,000 de-minimis, with/without limit).

**Builds on**:
- The annual settle machinery in `src/finance/tax/tax-settle-classes.js`
  (`UsTaxSettleHandler` / `AuTaxSettleHandler` → `*_TAX_SETTLE_APPLY` → reset YTD +
  chain `*_TAX_PAYMENT_DEBIT`) and the rate computations
  `us/us-tax-rates-base.js` (`credits = min(ftcYTD, grossTax)`) and
  `au/au-tax-rates-base.js` (resident/non-resident, franking offset only).
- `AccumulateTaxesPaidReducer` (`src/finance/reducers/accumulate-taxes-paid-reducer.js`),
  which **already** converts each settle's `tax` (AU in AUD) into USD
  (`usd = tax / effectiveExchangeRates.USD_AUD`). This is the precedent for moving
  *actual tax paid* between the two returns in one currency.
- `design/51` `tax-fx.js` (`toUSD`/`toAUD`) — every cross-currency figure here routes
  through the same seam.
- `computeAuTax(state)` / `computeUsTax(state)` being **pure functions of state** — the
  FITO with/without limit and the FEIE stacking calc both work by evaluating them a
  second time on a modified state, no new bracket engine required.

**Author note — what `ftcYTD` really holds today (and why the naive rename is wrong).**
Tracing every write, `ftcYTD` is fed by **both** modules:
`au-tax-module-2026.js` adds AU-source income (wages, rent, savings, dividends —
AUD→USD) **and** `us-tax-module-2026.js` adds **US-source** income of AU residents
(IRA/401k withdrawals & RMDs, US dividends/interest, US wages, SS, US rental). So
`ftcYTD` is really *"all worldwide income taxed by both countries, in USD."* Because
that sum always exceeds US gross tax, `min(ftcYTD, grossTax)` **zeroes the entire US
return for any AU resident** — a crude "residence country taxes, source country's tax
is wiped" hack. Two things follow that shaped this redesign:
- The §904 numerator is **not** a rename of `ftcYTD` — that field wrongly includes
  US-source income. The foreign-source (AU-source) bases must be **re-derived**, split
  by basket.
- The US-source writes in `us-tax-module-2026.js` are **not** US-FTC input at all;
  under real rules that income is relieved on the **AU** return via **FITO**. They move
  to the FITO path. (Which is also why Phase 1 and Phase 2 of the old draft cannot ship
  apart — see §5: doing so would double-tax the flagship "US retiree in AU drawing an
  IRA" scenario, which today is over-relieved, not double-taxed.)

---

## 1. Problem

The current single-line model (`us/us-tax-rates-base.js:85`,
`au/au-tax-rates-base.js` franking-only) has five defects:

1. **No FEIE.** A US citizen resident in AU can exclude up to the annual cap
   (**US\$132,900 for 2026**) of *foreign earned* income (AU wages/SE) from US tax
   entirely. The model has no exclusion, so it over-taxes AU-earned wages on the US
   return and then leans on the `ftcYTD` hack to erase it.
2. **Credits income, not tax.** `min(ftcYTD, grossTax)` treats every doubly-taxed
   dollar as fully creditable, so it can wipe a US bill many times larger than the AU
   tax actually paid.
3. **No §904 limitation and no baskets.** A real FTC is capped at
   `usTax × foreignSourceTaxable / totalTaxable`, computed **separately per basket**
   (Passive vs General). Excess in one basket cannot shelter US tax in the other.
4. **No carryforward.** Excess foreign tax in a high-foreign-rate year is lost instead
   of carrying forward **10 years within its basket** (e.g. AU CGT on a house sale
   crediting this year's US tax on the sale, remainder sheltering *future* super-
   withdrawal gains — both **passive**).
5. **Unilateral — no AU FITO.** The AU return grants **no** relief for US tax on
   US-source income (only a franking offset). Combined with defect 2 that is masked
   today (the US side is wiped), but any correct US return re-exposes it: an AU
   resident with US-source IRA/401k income would be **double-taxed** without a FITO.

---

## 2. Goals & Non-Goals

### Goals
- **US FEIE.** Exclude foreign *earned* income (AU-source wages/SE) up to the annual
  cap when elected, applying the IRS **stacking rule** (excluded income still lifts the
  marginal rate on the remainder). Per-scenario **toggle**, designed to become an
  MPC/optimizer lever bound by the **5-year revocation lock**.
- **US FTC, per §904 basket.** Credit the **actual AU tax paid** on AU-source income
  (USD), capped by the per-basket §904 fraction, with a **10-year carryforward pool per
  basket** (Passive, General). Income excluded by FEIE earns **no** FTC (mutual
  exclusivity on the same dollars).
- **AU FITO (real ATO rules).** Offset AU tax by US tax paid on US-source income —
  **single bucket, no carryforward, A\$1,000 de-minimis shortcut, with/without limit.**
- **A sourcing + basket rule (§4.1)** assigning each taxable dollar to exactly one
  *source country* and (for AU-source) one *basket*, so no dollar is relieved twice.
- Preserve `design/51`'s canonical-currency invariant: US pools are **USD**; the FITO
  figures are **AUD**; all crossings route through `tax-fx.js`.
- **Ship the US side and the AU side together** — no release window in which any
  scenario is double-taxed.

### Non-Goals (deferred)
- **Baskets beyond Passive + General** (GILTI, foreign-branch, §901(j), treaty-
  resourced, lump-sum). Two baskets only.
- **FTC carryback** (the real §904(c) 1-year carryback). Carryforward only.
- **FEIE housing exclusion/deduction** (Form 2555 Part VI). Cap only.
- **Exact FY↔CY alignment.** AU FY (Jul–Jun) and US CY (Jan–Dec) differ; the pool /
  FITO handoff carries a bounded, documented timing lag (§5).
- **Exact per-article treaty re-sourcing.** One sourcing rule (§4.1), modeled as an
  assumption.
- **State (US-state) FTC.** US states largely don't grant FTC; unchanged.
- **Whether AU super *contributions/earnings* tax is a creditable foreign income tax**
  for US FTC purposes — flagged as an open question (§10), defaulted per §4.4.

---

## 3. State model

All reset semantics in §5. `ftcYTD` is **removed** (replaced), with a one-release
back-compat read shim for pre-52 saves.

### US side (canonical currency USD)

| Field | Meaning | Reset |
|---|---|---|
| `usFeieElected` *(param)* | Whether FEIE is elected. v1: static boolean. Target: per-year election vector + 5-year revocation lock (MPC lever). | n/a (input) |
| `foreignGeneralIncomeYTD` | AU-source **earned** income (USD), pre-FEIE. FEIE base **and** §904 General numerator (post-exclusion). | at US settle |
| `foreignPassiveIncomeYTD` | AU-source **passive** income (USD). §904 Passive numerator. | at US settle |
| `ftcPoolGeneral` | Carryforward pool of unused AU tax, **General** basket: `{ [vintageCY]: remainingUSD }`, ≤10 vintages. | **carries forward**; drawn down; vintages >10y expire |
| `ftcPoolPassive` | Same, **Passive** basket. | as above |
| `usSourceOrdinaryUsdYTD` | US-source **ordinary** income (USD) booked while AU-resident — the "without" removal set for the US-side FITO pass (§4.6). | at US settle |
| `usSourceCapGainsUsdYTD` | US-source **capital gains** (USD) booked while AU-resident — same pass. | at US settle |

### AU side (canonical currency AUD)

| Field | Meaning | Reset |
|---|---|---|
| `usSourceOrdinaryAudYTD` | US-source **ordinary** income in AUD (the slice that hit `auOrdinaryIncomeYTD`). FITO with/without removal set. | at AU settle |
| `usSourceCapGainsAudYTD` | US-source **capital gains** in AUD (the slice that hit `auCapitalGainsYTD`). Split from ordinary because AU taxes gains differently (CGT discount). | at AU settle |
| `usTaxPaidOnUsSourceAud` | US tax **paid** on US-source income (AUD), from the most recent US settle — the FITO input. | consumed at AU settle; **not** carried (ATO: excess lost) |

Note the asymmetry vs the old draft: **there is no AU pool.** FITO has no
carryforward, so the AU side carries only a single-year input figure.

---

## 4. Mechanism

### 4.1 Sourcing + basket rule (the anti-double-relief invariant)

Every taxable dollar is **sourced** to one country; each **AU-source** dollar also
gets one **basket**. Direction of relief follows source: the *source* country taxes in
full; the *residence* country grants the relief.

| Income (reducer family) | Source | Basket | Relief path |
|---|---|---|---|
| AU wages, AU self-employment | AU | **General** | US **FEIE** (up to cap) then **FTC** General on excess |
| AU rental | AU | Passive | US FTC Passive |
| AU savings interest, AU fixed-income interest | AU | Passive | US FTC Passive |
| AU dividends (franked/unfranked) | AU | Passive | US FTC Passive |
| AU brokerage capital gains | AU | Passive | US FTC Passive |
| AU property sale | AU | Passive | US FTC Passive |
| Super earnings tax (accumulation 15%) | AU | — | AU-only tax; **not** creditable for US FTC (§4.4) |
| US wages, US self-employment | US | — | AU **FITO** |
| IRA / 401k withdrawal & RMD | US | — | AU FITO |
| US dividends, interest, brokerage cap gains, US rental, Social Security | US | — | AU FITO |

**Baskets are needed only on AU-source rows.** The US never credits its own US-source
income and AU has no baskets, so US-source rows carry no basket. This narrows the
mechanical work: only the AU-source reducers need passive/general tags + FEIE-earned
tags; every US-module `ftcYTD` write is **deleted** and replaced by
`usSourceIncomeAudYTD` accumulation for FITO.

`foreignGeneralIncomeYTD` / `foreignPassiveIncomeYTD` come from the AU-source reducers;
`usSourceIncomeAudYTD` from the US-source reducers (the amounts that already feed
`auOrdinaryIncomeYTD` via `toAUD`). Disjoint sets ⇒ the two reliefs cannot stack, and
neither feeds the other's *input* (see §8 circularity).

### 4.2 US return — FEIE (Form 2555, with stacking)

At the US settle, when `usFeieElected`, the taxpayer is AU-resident, **and** has
completed a full qualifying year (a **partial-year move-in suppresses FEIE** until the
first full qualifying year — proxying the BFR/PPT timing):

```
excluded_p   = min(foreignGeneralIncome_p, FEIE_CAP)      // per qualifying person p
excluded     = Σ_p excluded_p                             // MFJ: each spouse’s own cap
```

`FEIE_CAP` is a year-specific constant on the US rates subclass (2026 = 132_900),
inflation-indexed like the brackets. **Stacking rule** — excluded income still pushes
the remainder up the brackets:

```
usTax_stacked = bracketTax(taxableIncome_including_excluded)
              − bracketTax(excluded_stacked_at_bottom)
```

so the non-excluded income is taxed at its true marginal rate (IRS *Foreign Earned
Income Tax Worksheet*), not from zero. Excluded income is removed from the General
§904 numerator and earns **no** FTC (mutual exclusivity).

### 4.3 US return — per-basket §904 FTC with 10-year aging pools

Replace `us/us-tax-rates-base.js` Step 6 (`credits = min(ftcYTD, grossTax)`) with a
per-basket limit and draw-down:

```
totalTaxable = taxableOrdinary + max(0, usCapitalGains) + collectibles   // post-FEIE
for basket in [General, Passive]:
  frac_b   = totalTaxable > 0 ? clamp01(foreign<Basket>Income / totalTaxable) : 0
  limit_b  = grossTax * frac_b                              // §904, per basket
  avail_b  = currentYearForeignTax_b + Σ pool<Basket> vintages
  credit_b = min(avail_b, limit_b)
credit       = credit_General + credit_Passive
netLiability = max(0, grossTax − credit)
```

**Draw-down order** (IRS): current-year foreign tax first, then carryover vintages
**oldest→newest**; the unused remainder of each basket's current-year tax opens a new
vintage; vintages older than 10 years expire. Pools are drawn down and rewritten at the
settle (§5).

### 4.4 Funding the US pools (AU settle → US FTC)

`AuTaxSettleApplyReducer` computes the AU `netLiability` (AUD). Apportion the AU tax
**attributable to AU-source income** to the two baskets by AU-source taxable income
share, convert to USD, and add as this year's basket contribution:

```
auCreditable        = auNetLiability − auSuperTaxYTD       // AU income tax on AU-source income; super tax excluded (not US-creditable)
auGeneralShare      = auSourceGeneralTaxable / auSourceTaxable
foreignTax_General  = toUSD(auCreditable * auGeneralShare, 'AUD', state)
foreignTax_Passive  = toUSD(auCreditable * (1 − auGeneralShare), 'AUD', state)
```

**Super tax is excluded** from `auCreditable` — neither the 15% contributions tax nor
the 15% accumulation-earnings tax is a creditable foreign *income* tax for US FTC
purposes. For the common all-AU-source resident with no super tax, `auCreditable` ≈ the
whole AU tax (matching `AccumulateTaxesPaidReducer`'s existing AUD→USD conversion).
These per-basket foreign-tax figures are what the next US settle consumes (§4.3,
`currentYearForeignTax_b`), then banks the unused remainder into the vintage pools.

### 4.5 AU return — FITO (real ATO rules)

On `au/au-tax-rates-base.js`, gated to AU residents. Because `computeAuTax` is pure, the
**with/without limit** is a second evaluation:

```
foreignTaxAud = usTaxPaidOnUsSourceAud                       // US tax paid on US-source income
if foreignTaxAud <= 1000:                                    // A$1,000 de-minimis
  fito = foreignTaxAud                                        // no limit calc
else:
  auTaxAll     = computeAuTax(state).netLiability
  auTaxWithout = computeAuTax({ ...state,                     // disregard US-source income
                    auOrdinaryIncomeYTD: auOrdinaryIncomeYTD − usSourceOrdinaryAudYTD,
                    auCapitalGainsYTD:   auCapitalGainsYTD   − usSourceCapGainsAudYTD }).netLiability
  fitoLimit    = max(0, auTaxAll − auTaxWithout)              // ATO “step 1 − step 2”
  fito         = min(foreignTaxAud, fitoLimit)
auNetLiability = max(0, auGrossTax − frankingOffset − fito) + superTax + nrWithholdingTax
```

The ordinary/CG split matters because AU taxes the two differently (the CGT discount
halves the taxable gain), so the "without" pass must remove each US-source slice from
its own bucket. **No carryforward** — any `foreignTaxAud > fito` is **lost** (ATO). This
is the deliberate asymmetry with the US side.

### 4.6 Funding FITO (US settle → `usTaxPaidOnUsSourceAud`)

At the US settle, measure the **marginal** US tax caused by US-source income via a
second (pure) `computeUsTax` pass — symmetric with the AU-side limit (§4.5) — and hand
it to the AU side in AUD:

```
usTaxAll        = netLiability                                  // the return just computed
usTaxWithout    = computeUsTax({ ...state,                      // disregard US-source income
                    usOrdinaryIncomeYTD: usOrdinaryIncomeYTD − usSourceOrdinaryUsd,
                    usCapitalGainsYTD:   usCapitalGainsYTD   − usSourceCapGainsUsd }).netLiability
usTaxOnUsSource = max(0, usTaxAll − usTaxWithout)
usTaxPaidOnUsSourceAud = toAUD(usTaxOnUsSource, 'USD', state)   // consumed at next AU settle
```

The with/without pass is exact where a proportional split is not: it holds FEIE and the
AU-source FTC constant, and it correctly reflects that US-source income *consumes* §904
headroom (removing it raises the foreign fraction in the "without" pass). Cost is one
extra pure evaluation per year. `usSourceOrdinaryUsd` / `usSourceCapGainsUsd` are the
US-measured US-source slices — the same reducers that fund `usSource*AudYTD` (§4.5) track
the USD figures for this pass. The FY↔CY lag (US CY *N* funds the AU FY settle that
follows) is the bounded timing offset noted in §5 / non-goals.

---

## 5. Timing, ordering & reset semantics

- **Settle order.** AU FY settle fires **Jun 30**, US CY settle **Dec 31**. Within
  calendar year *N*: the AU return (FY *N-1→N*) funds the US basket pools *before* the
  US return (CY *N*) consumes them; the US return then produces
  `usTaxPaidOnUsSourceAud` for the *next* AU FY settle (Jun 30 *N+1*). Both handoffs are
  one-directional, so no fixpoint (§8).
- **Reset asymmetry (the crux).**
  - `foreignGeneralIncomeYTD`, `foreignPassiveIncomeYTD`, `usSourceIncomeAudYTD` are
    per-year §904/FITO inputs → **reset at their settle** (add to `YTD_FIELDS`).
  - `ftcPoolGeneral` / `ftcPoolPassive` **must NOT be in the reset list** — the settle
    draws them down by the credit used and **carries the remainder forward** (expiring
    >10y vintages).
  - `usTaxPaidOnUsSourceAud` is a single-year handoff: written at the US settle,
    consumed (and any excess **lost**) at the next AU settle — never accumulated.
- **First/last year.** If a US settle precedes the first AU settle (mid-year simStart),
  the pools are empty and the FTC is 0 that year; the AU tax funds the *next* year's
  pool — a documented one-year lag, not a leak (exactly how a carryforward behaves).
  FITO in year 1 likewise waits for the first US settle.
- **10-year cap.** Real §904(c) is 10 years, and you asked for it: vintages are keyed by
  settle year and dropped once >10 years old. FITO has **no** cap (nothing to age).

---

## 6. Display / reporting

- US tax document: an **FEIE** line (excluded amount), then a **Foreign Tax Credit**
  section **split by basket** — General and Passive, each showing *limit / current-year
  foreign tax / carryover used / carryforward remaining*. The
  `foreign-tax-credit-detail` drill shows the per-basket pool ledger with vintages.
- AU document: a **Foreign Income Tax Offset** line, with the with/without limit and the
  de-minimis flag when it applies.
- `AccumulateTaxesPaidReducer` is unaffected structurally, but because both
  `netLiability` figures now reflect real relief, US/AU `cumulativeTaxesPaid`, after-tax
  net worth, and any `MIN_LIFETIME_TAXES` objective **shift**. Intended correctness
  change; the main regold surface.

---

## 7. Testing

New `tax-cross-border-relief.test.mjs`:
- **FEIE-1:** AU wages below cap, elected → excluded from US tax; US tax on remaining
  income uses the **stacked** marginal rate (assert > naive removal).
- **FEIE-2 (mutual exclusivity):** excluded AU wages generate **no** General-basket FTC.
- **FEIE-3 (toggle):** same scenario, `usFeieElected` off → General FTC instead;
  lifetime tax differs; toggle is the only input changed.
- **FTC-1 (tax-paid, not income):** low-AU-rate passive income → US credit = the AU
  *tax* (USD), not the income; residual US tax collected.
- **FTC-2 (§904 per-basket cap):** high foreign tax on a small passive share → credit
  capped at `grossTax × passiveFrac`; remainder to the passive pool; General pool
  untouched.
- **FTC-3 (basket isolation):** excess General tax does **not** offset US tax in the
  Passive basket.
- **FTC-4 (carryforward + your example):** AU house-sale CGT credits this year's US tax
  on the sale; remainder carries in the **Passive** pool and shelters a later super-
  withdrawal-gain US tax; draw-down oldest-first; a vintage expires at year 11.
- **FTC-5 (reset asymmetry):** income numerators zero at the US settle; pools persist.
- **FITO-1:** AU resident with US-source IRA withdrawal — AU tax drops by the US tax
  paid, capped by the with/without limit; **no** carryforward of the excess.
- **FITO-2 (de-minimis):** US tax ≤ A\$1,000 → offset in full, limit calc skipped.
- **RELIEF-1 (no double relief / sourcing):** with everything active, a US-source dollar
  is relieved only by FITO and an AU-source dollar only by FTC/FEIE; total tax on each ≈
  the higher of the two rates, never < either.

**Regold:** every cross-border evt/tax golden that asserts `ftcYTD > 0` or a post-credit
`netLiability` (they encode the income-credit hack), plus scenario-level lifetime-tax /
net-worth goldens. Expect a broad, directional diff: US returns for AU residents go from
≈0 to positive; AU returns fall where US tax was paid on US-source income.
Requirements gate + build; browser-verify a post-move retiree's US & AU returns show
FEIE + basketed FTC + carryforward and a FITO with no double taxation.

---

## 8. Risks

- **Circular settle dependency.** US FTC needs AU tax paid; AU FITO needs US tax paid.
  The **sourcing rule (§4.1) breaks the cycle**: US FTC credits AU tax only on
  *AU-source* income; AU FITO offsets US tax only on *US-source* income — disjoint sets,
  one-directional per-year handoffs (§5). No fixpoint iteration.
- **`ftcYTD` semantics were wrong, so this is not a rename.** The re-derivation of
  foreign-source bases by basket (and moving US-source writes to the FITO path) touches
  ~30 reducer writes across both modules — larger than the old draft implied. Mitigated
  by the §4.1 table as the single source of truth.
- **Phase entanglement.** Shipping the US side without FITO would double-tax the
  flagship AU-retiree-with-IRA scenario (today over-relieved). Hence **ship together**.
- **Timing / FX lag.** Pool funded at the AU-settle rate but credited at the US-settle
  rate; FY↔CY offset. Bounded and documented (non-goal to make exact).
- **State growth.** Vintage pools grow to ≤10 entries/basket then self-expire — bounded.
- **Behavioral shift is large.** Headline lifetime-tax and ending-wealth move for every
  cross-border scenario — call it out in the PR; correctness fix, not a regression.

---

## 9. Implementation checklist

1. **Schema:** remove `ftcYTD` (back-compat read shim); register
   `foreignGeneralIncomeYTD`, `foreignPassiveIncomeYTD` (USD),
   `ftcPoolGeneral`/`ftcPoolPassive` (USD vintage maps), the US-source slices
   `usSourceOrdinaryAudYTD`/`usSourceCapGainsAudYTD` (AUD) +
   `usSourceOrdinaryUsdYTD`/`usSourceCapGainsUsdYTD` (USD), `usTaxPaidOnUsSourceAud`
   (AUD), `usFeieElected` (param) + an *earned-only* per-person AU accumulator for the
   FEIE cap. Update `YTD_FIELDS`: the income numerators reset at **their own** settle
   (the AUD US-source pair at AU settle, the USD pair at US settle; the two foreign-
   source numerators at US settle); **exclude** the pools and `usTaxPaidOnUsSourceAud`.
2. **Sourcing/basket tags (§4.1):** rewrite the AU-source reducer writes in
   `au-tax-module-2026.js` to feed `foreignGeneralIncomeYTD` / `foreignPassiveIncomeYTD`
   (and tag AU wages/SE as FEIE-earned); **delete** the `ftcYTD` writes in
   `us-tax-module-2026.js` and replace with `usSourceIncomeAudYTD` accumulation.
3. **FEIE (§4.2):** `FEIE_CAP` per year on the US rates subclass; stacking calc in
   `computeTax`; `usFeieElected` gate; remove excluded income from the General numerator.
4. **US FTC (§4.3):** per-basket §904 limit + vintage draw-down/expiry; expose FEIE +
   per-basket FTC + carryforward line items.
5. **Fund US pools (§4.4):** `AuTaxSettleApplyReducer` apportions AU tax to baskets →
   USD → pool contributions.
6. **AU FITO (§4.5–4.6):** `au/au-tax-rates-base.js` with/without limit, \$1,000
   de-minimis, no carryforward; `UsTaxSettleApplyReducer` produces
   `usTaxPaidOnUsSourceAud`.
7. **Tests + regold (§7):** `tax-cross-border-relief.test.mjs`; regold cross-border
   evt/tax + lifetime-tax/net-worth; `npm run test:unit`, `requirements`, build;
   browser-verify.
8. Update `design/51` §2 non-goal + the `currency-display-phases` memory to point here
   as the resolution.
9. **Future (out of scope, note the seam):** promote `usFeieElected` to a per-year
   election vector with the **5-year revocation lock** as an MPC optimization lever.

---

## 10. Open questions

**Resolved**
1. ~~Super tax creditability.~~ **Excluded** — neither AU super contributions nor
   earnings tax funds the US FTC pool (§4.4).
2. ~~Per-person FEIE cap on a joint (MFJ) return.~~ **Yes** — exclude each spouse's own
   AU-earned income up to their own cap, then aggregate; a dedicated *earned-only*
   per-person accumulator is added (the existing `auPersonOrdinaryIncomeYTD` mixes wages
   with AU interest/rent and cannot be reused).
5. ~~FEIE eligibility on partial-year move-in.~~ **Suppress** FEIE until the first full
   qualifying year (§4.2).

3. ~~US-source ordinary/CG split (§4.5).~~ **Two sub-fields**
   (`usSourceOrdinaryAudYTD`, `usSourceCapGainsAudYTD`, plus the USD pair for §4.6) —
   the split is unrecoverable once the AU buckets are lumped, so it is captured at each
   US-source reducer write.
4. ~~FITO input fidelity (§4.6).~~ **Exact with/without** US pass, symmetric with the
   AU-side limit; one extra pure `computeUsTax` call per year, no double-tax leak.

*All design questions resolved — ready to implement.*
