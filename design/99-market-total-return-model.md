# 99 — One return per market: accounts derive their growth from their holdings

**Status: PROPOSED (10 Sep 2026), revised the same day to bring fixed income into scope
(§3.4).** Written with the user after design 98 M1 surfaced open question 5 (are market
rates price or total?). Supersedes the per-wrapper growth
rates that design 90 §7.5 "re-homed" as a stopgap. Design 98 M2 now depends on phase P2.

---

## 1. The problem

An equity holding's growth rate can be set in **six** places today, resolved by a
precedence nobody can hold in their head:

| # | Where | Example | Read by |
|---|---|---|---|
| 1 | Holding `appreciationSchedule` | an authored per-year schedule | `computeHoldingsGrowth`, applied **last**, overrides everything |
| 2 | Handler `rateOverride` | one-off | `computeHoldingsGrowth` |
| 3 | `account.growthRate` | a pinned account | `seedPerAccountRates` → `<market>::<stateKey>` |
| 4 | Role param | `rothGrowthRate`, `brokerageGrowthRate`, … (six) | `collectRoleGrowthRates` → same key as #3 |
| 5 | Market param | `usEquityGrowthRate`, … (four, design 98 W1) | `collectBaseGrowthRates` → bare `<market>` key |
| 6 | Handler constructor default | `growthRate ?? 0.07` / `0.05` / `0.06` | `fallbackRate`, if no rate key resolves |

Plus a per-security **overlay** (design 94 §6.2) that is added to whichever of these wins.

Dividends carry the same confusion, with **two meanings** for one word:

- **Taxable accounts** (US brokerage, AU stock): a dividend handler pays
  `marketValue × yield` *on top of* growth. So the growth rate there is a **price** rate.
- **Tax-advantaged accounts** (IRA / Roth / 401(k)): `dividendYield` is a **carve-out**,
  a label on part of the same return (design 84 G2). So the growth rate there is a
  **total** rate. Super has neither and grows at a plain total rate.

The four market params were created as total market returns, but nothing enforces that.
A holding that falls through to its market key behaves as price or total depending on
which account it sits in. Design 98 F9 was this confusion producing a real error: AU
stock at 6% price plus a 4% dividend, a 10% total beside everyone else's 7%.

The root cause is that the account wrapper still carries a rate. Design 90 §7.1 said the
wrapper is the wrong axis: "the account you keep something in does not determine what
market it tracks." §7.5 kept the wrapper rates only "until the §7.3 sub-axis can express
the same thing as a mix". The sub-axis is built (§7.3a), so that condition is now met.

## 2. The model

**One number per market says what the market returns. Everything else is derived.**

| Level | Authored | Meaning |
|---|---|---|
| **Market** (4) | expected **total** return, dividend **yield** | the whole return of that market, and how much of it arrives as dividends |
| **Security** | optional β, idio vol, yield override | a concentrated position that differs from its market (design 94) |
| **Holding** | which security / market it tracks | no rate |
| **Account** | a mix of holdings | **no rate** — its growth is what its holdings earn |

The one rule every consumer follows:

> **price growth = total − yield.** The yield is then either **paid** as a dividend
> (taxable account: a handler credits it, with franking and cash-vs-reinvest intact) or
> **carved out** of the return as derived income (tax-advantaged account). The total is
> the same either way.

No one authors a price rate anywhere, so the double count cannot happen by construction.

### 2.1 Numbers are preserved for every library default

Today's wrapper rates already encode this model once the dividends are added back in:

| Account | Today | Under this design | Same? |
|---|---|---|---|
| US brokerage | 5% growth + 2% paid | US 7% total, 2% yield → 5% price + 2% paid | yes |
| AU stock (post design 98 M1) | 3% growth + 4% paid | AU 7% total, 4% yield → 3% price + 4% paid | yes |
| Roth / IRA / 401(k) | 7%, 2% carved out | US 7% total, 2% carved out | yes |
| Super | 7%, no carve-out | AU 7% total, no carve-out | yes |
| Intl sleeve in the US brokerage | 5% (account rate, §7.3a) + 2% paid | ex-US 7% total, 2% yield → 5% + 2% | yes, if ex-US yield is 2% |

**The table needed one fix first (found by the P1 guard, 10 Sep 2026).** The
`us-single-homeowner` library plan authored `brokerageGrowthRate` 0.06 beside the 2%
dividend: an 8% total on both of its brokerages, design 98 F9 again in a different plan.
Fixed to 0.05 in its own commit ahead of P1 (`5e8d2c9`, re-gold of that golden only: net
worth −2.4%). The other two library plans already matched.

So P1–P4 are expected to move **no golden**. No golden spec and no library plan authors a
growth rate or dividend param (checked 10 Sep 2026), so any movement must be traced to a
fallthrough this table missed. That is the guard, not a nuisance.

The one default that changes value is `auEquityGrowthRate`, 0.06 → 0.07. It is inert today
because every AU-equity holding sits in a role-seeded account. If a golden moves at P2,
something reads it that we did not know about.

### 2.2 Correlation: one common factor, not one market derived from another

The question "US and AU are correlated; should AU be built off the US rate?" separates
into two things that are easy to conflate:

- **Expected return (drift).** What each market returns on average. These are four
  independent **plan inputs**, not derived from each other. AU's long-run return is not a
  function of the US's.
- **Uncertainty (the random path).** How markets move together year to year. This is where
  correlation lives, and it is **already built** as a one-factor model (design 74 §4
  option B, re-based onto markets by design 90 §7.2):

  ```
  market move[k]  = β_k × global draw  +  idio_k × own draw
  security move   = its market's move × (β_s − 1)  +  idio_s × own draw     (design 94 §6.2)
  ```

  One uncorrelated master (the global draw); each market built off it through β and idio
  vol; each security built off its market the same way. This is better than "AU built off
  US": a US-specific shock does not leak into AU, and all four markets relate to one
  factor rather than to a chain.

Two parts of the uncertainty are not finished and stay where they already live:

- **idio vol is 0 on every market**, so the four still move in lockstep. That is design
  90 §7.4.
- **Uncertainty about the drift itself** (is the US's long-run return 7% or 5%?) becomes
  one systematic MC axis that shifts all four totals together. That is design 98 M2's
  `equityAnchorShift`, simplified by this design (§5).

## 3. What changes

### 3.1 Added

- Four **market yield** params beside the four totals: `usEquityDividendYield`,
  `auEquityDividendYield`, `intlExUsEquityDividendYield`, `intlExAuEquityDividendYield`,
  in the same `MARKET_GROWTH_PARAMS` table so a total and its yield cannot drift apart.
  Defaults: US 0.02, AU 0.04, ex-US 0.02, ex-AU 0.02 (the values the accounts pay today;
  sourcing them is P5).
- The yields are seeded into **`state.marketDividendYields`** (`rateKey → yield`) beside
  `baseGrowthRates`, and `baseDividendYield` resolves a holding's yield as security → lot
  → market → handler fallback → 0 (design 94 D11 with the market inserted). *Corrected
  while building P2:* the first draft put the yield on the synthetic market securities,
  but securities are frozen records built at load, outside the param bag — an MC draw on
  a yield would have had to rebuild the registry. An authored security's yield still wins.
- `computeHoldingsGrowth` takes `yieldPaidSeparately` from its caller. When true (the two
  taxable handlers), a holding grows at `total − yield`. When false (wrappers), it grows at
  `total` and `derived` carries the yield exactly as today.

### 3.2 Retired

| Retired | Replaced by |
|---|---|
| Six role params (`rothGrowthRate` … `superGrowthRate`), `ROLE_GROWTH_PARAMS`, `collectRoleGrowthRates` | the market total |
| `account.growthRate` and the equity branch of `seedPerAccountRates` | the holdings' markets |
| `brokerageDividendRate`, `auStockDividendRate`, `stockDividendRate`, account `dividendRate` / `dividendYield` | the market yield (per security) |
| Handler `growthRate` / `defaultRate` constructor fallbacks (6 in `earnings-handlers.js`) | nothing: an unresolvable rate key throws under `JOURNAL_STRICT` |
| `ROLE_PARAM_OVERRIDES` and design 98 W5's shadow tags | nothing to shadow any more |

**Not retired:** `primeSpread` on cash and savings accounts (§3.4, D-5).

Found while writing this: `IntlAuStockEarningsHandler.fromJSON` still defaults
`growthRate ?? 0.06` (`earnings-handlers.js:317`). Design 98 M1 missed it because it is
only reached if no rate key resolves. P2 deletes it with the others.

### 3.3 What an account that genuinely differs does

"This brokerage underperforms the market" is a statement about **what it holds**. Say it
by holding a security with its own β / idio vol / drift overlay (design 94), or by a
per-holding `appreciationSchedule` (still the deliberate override of last resort). Not by
a number on the wrapper.

### 3.4 Fixed income — the same shape, and one field with two meanings

The first draft left bonds out of scope. The code shows the same wrapper-vs-market
problem, smaller, and in one place worse:

| Level | Already exists |
|---|---|
| Market | `fixedIncomeInterestRate`, `auFixedIncomeInterestRate` (the `FIXED_INCOME_*` level), design 67's yield-curve shape, the Prime rates |
| Holding | contractual `couponRate`, `duration` (price marks to market on rate moves), TIPS/OID accretion (design 66) |
| **Account** | `acct.interestRate ?? <param>`, read in six places |

The six readers of `acct.interestRate`:

- `seedPerAccountRates` (interest branch) → `FIXED_INCOME_*::<stateKey>` / `SAVINGS_*::<stateKey>`;
- `FixedIncomeInterestHandler`, US fixed-income account (`us-retirement-toolset.js:1351`);
- `CashSleeveInterestHandler`, the cash sleeve of a 401(k)/IRA/Roth (`:1281`), falling back
  to `usSavingsInterestRate`;
- `BondSleeveCouponHandler`, the bond sleeve of the **same** 401(k)/IRA/Roth (`:1308`),
  falling back to `fixedIncomeInterestRate`;
- the AU savings (`au-retirement-toolset.js:717`) and AU bond coupon (`:743`) equivalents.

So on a US retirement wrapper, **one `interestRate` field is both the cash-sleeve interest
rate and the bond-sleeve coupon.** Setting it to describe one silently re-rates the other.

Bonds do not have the price-vs-total question: a coupon is paid and the price moves with
duration, and the model already keeps those apart. So the fix is only the retirement:

- **Bond lots** take their coupon from the holding (or its security) and otherwise the
  country's `FIXED_INCOME_*` market level. `acct.interestRate` no longer reaches a bond.
- **Cash sleeves inside wrappers** take the country's savings market rate
  (`SAVINGS_*`). `acct.interestRate` no longer reaches them.
- **Cash and savings *accounts*** keep `Prime + primeSpread` (D-5).
- `acct.interestRate`, and the fixed-income account's use of it, retire with the same
  loader rule as `account.growthRate` (§4). No library plan or golden authors it (checked
  10 Sep 2026), so this is also expected to be inert.

Not changed here: a coupon-less bond lot pays the **flat** market level, not the curve at
its tenor. Routing it through the curve is a modelling change that re-bases results, so it
joins P5 (D-6).

## 4. Migration of saved scenarios

The loader's existing alias mechanism (`_applyParamAliases`, design 55 §11) already
retires keys: a `null` target drops a key that nothing reads any more.

- **Role params and dividend-rate params** alias to `null`. When the value equals what
  the market now produces for that role (§2.1's table), the drop is silent. When it
  differs, the loader **warns** with the key, the value, and what the account will now
  earn. A user who authored 4% for their brokerage meant something, and a silent 7% would
  betray them.
- **`account.growthRate` / `dividendRate`**: the same rule, per account.

Open (D-2 below): whether a differing value is also **converted**, not just reported.

## 5. Consequences for design 98

- **M2 simplifies.** There are no wrapper MC axes to retire: they stop existing at P2.
  `equityAnchorShift` becomes a shift on the four market totals, applied in
  `collectBaseGrowthRates`. The shift can no longer be shadowed (there is nothing above
  the market key to pin), which is the problem W5 had to diagnose.
- **The two dividend MC axes** become four market-yield rows. They stay disabled by
  default for the reason M2 step 5 gives (additive total return, drawn independently).
- **W5's shadow machinery** (`ROLE_PARAM_OVERRIDES`, `shadowedBy` / `shadowedAll`, the
  panel chip, MC-LIVE-6) is deleted at P4. It was a correct diagnosis of a problem this
  design removes.
- **Opt** loses the six wrapper rates as levers. They were plan inputs, not decisions, so
  this is intended (design 98 D3 kept them listable; that decision is withdrawn).

## 6. Phases

Each is its own commit. P1–P4 are expected inert on every golden (§2.1).

**Why the cut-over is one commit (revised 10 Sep 2026).** The first draft split it into
three steps. None stands alone:
- relabel the market rates "total" first, and a taxable account still pays its dividend
  on top: the label is false and the value double-counts;
- apply `total − yield` first, and a taxable account still receives its *role* rate,
  which is a price rate (5% − 2% = 3%);
- add market yields beneath the account/role dividend params, and they are never read,
  because those params always have defaults.

The price → total flip is only consistent when every piece moves together. The library
defaults then come out identical (§2.1), so P2 is large but verifiable: the P1 guards
and every golden must stay green without edits.

One behaviour change in P2 is intended: a **cross-market lot** (an AU-market lot inside a
US brokerage) earns today 6% on the bare AU key **plus** the brokerage's 2% dividend, an
8% total. After P2 it earns AU's 3% price plus AU's 4% yield: 7%. The P1 test file
carries this as a `todo` that P2 turns into a pass.

| # | Step | Re-golds? |
|---|---|---|
| **P1** | Guard tests only (below): pin §2.1 on the library plans through the real handlers | No |
| **P2** ✅ | **The equity cut-over, one commit (BUILT 10 Sep 2026, §6.1):** market totals + yields become the only equity source (yields in `marketDividendYields`); taxable handlers grow at `total − yield`; the carve-out reads the security yield; role growth + dividend params, `account.growthRate` / `dividendRate`, the equity seeding branch and handler fallbacks retired; loader warning (§4); `auEquityGrowthRate` 0.07; descriptions say "total return" / "dividend yield" | No (expected) |
| **P3** ✅ | Editor: read-only expected return derived from the holdings (§8 Q2) — BUILT 10 Sep 2026, §6.2 | No |
| **P3b** ✅ | (BUILT 10 Sep 2026, §6.3) Fixed income (§3.4): `acct.interestRate` retired from bonds and wrapper cash sleeves; bond lots → holding coupon or `FIXED_INCOME_*`; cash sleeves → `SAVINGS_*`; `primeSpread` kept | No (expected) |
| **P4** ✅ | (BUILT 10 Sep 2026, §6.4) `ROLE_PARAM_OVERRIDES` (empty since P2) and W5's shadow surface deleted: `shadowedBy` / `shadowedAll`, the panel chip, the provenance field, and the tests still pinning its resting state (W5-1, W5-8, the chip viz test). The MC/Opt defaults moved in P2 — left behind they would have been dead axes | No |
| **P5** (a ✅ §6.5, b ✅ §6.6, c ✅ §6.7 — equity split only) | Modelling, three commits — (a) coupon-less bonds float on the curve (D-6) BUILT; (b) market totals + yields from a forward-looking CMA; (c) super mix from APRA MySuper stats: source the four totals and yields into `docs/`; super's default mix (today 100% AU via `auEquityIntlShare: 0`; real funds hold a large international share, design 90 §7.2); coupon-less bond lots priced off the yield curve at their tenor (D-6) | **Yes** |
| then | Design 90 §7.4 (idio vol), design 98 M2 (anchor), M3 (anchor sd) | **Yes** |

Guard tests to add at P1 and keep:

- **One source per equity rate:** every equity holding in every golden resolves its rate to
  a bare market key or a security overlay on one; no `<market>::<stateKey>` equity key
  exists. Added at P2, since it is false until then.
- **Total is total:** for each market, a taxable holding's `price + paid dividend` equals a
  wrapper holding's `growth` over one year, to the cent.

### 6.1 P2 implementation record (built 10 Sep 2026)

**Result.** Unit 6,244 / viz 1,390 green. The P1 guard passed across the cut-over
without an edit, and its cross-market `todo` now passes (converted to a plain test).

**What changed beyond §3.**

- **Price rate rounded to 12 decimal places** (`priceOf` in `holdings-earnings.js`). In
  binary floating point `0.07 − 0.04` is `0.030000000000000006`. Unrounded, the residue
  tipped an occasional per-lot cent and compounded: +10 cents on the reference plan's AU
  stock over two decades, 62 fixture fields. Rounded, the library defaults reproduce the
  old price rates exactly.
- **Configs without ECONOMIC_REGIMES** (the "joe" toolset, many unit fixtures) have no
  rate maps in state. Before P2 the retirement toolsets handed each handler its role rate;
  now they hand it the market's total and yield from `marketReturnFor` — the same table
  the maps are seeded from — as the rate of last resort. With the maps present they win.
  The hard-coded handler constants are gone; an unresolvable rate throws.
- **Record templates** no longer generate `acct.*.growthRate` / `acct.*.dividendRate`, so
  the params editor stops offering retired fields. `retireRateParams` drops saved ones.
- **MC, interim until design 98 M2:** the US and AU totals are enabled (sd 0.03, drawn
  independently, as the wrapper axes were); the international totals and all four yields
  are listed but off.

**Goldens.** All 13 re-golded and every changed field classified:

| Golden | Change |
|---|---|
| the other ten | structural only: per-account equity keys removed, AU bare rate 0.06 → 0.07, yield map added |
| `wash-sale-harvest`, `wash-sale-two-books` | the same, seen through an active return path (effective `EQUITY_AU` +0.01) |
| `two-security-concentration` | **62 value fields** — the intended correction below |

`two-security-concentration` is the one golden that authors a security yield (0.6%) away
from its market's (2%). Before P2 the brokerage priced that lot at its own 5% price rate
whatever its yield, so a low yield silently cut the total to 5.6%. After P2 it earns 6.4%
of price plus 0.6% of dividend: the market's 7%. The lot rose 11.8% over the 8-year run,
which is 1.014⁸; net worth +11.7k, lifetime tax +61. The knock-on fields (401(k), cash,
AU tax) flow through that golden's rebalancer and were not traced one by one.

**Tests.** About 40 files moved from role params to market params. Rewritten:
`evt-per-account-growth` (one market's total moves every account holding it; no
per-account key is seeded) and `market-growth-params` (W1: totals, `mc: true`, reach every
account). Deleted with the features they tested: EVT-PAIR-1…4 (per-account growth rates;
EVT-PAIR-5, per-account *interest*, stays), W5-2…W5-7 and MC-LIVE-6 (shadowing of retired
rows), and W3-3 (null-centered per-account MC rows — which also settles design 98 §7 Q1).
New: `retired-rate-params.test.mjs` (silent when equivalent, warns when not, strips both
param stores and the account fields).

**Scripts.** `scripts/lib/mc.mjs`'s growth column reads `usEquityGrowthRate`.
`variant.mjs`'s equity shift also shifts market totals a plan never authored (otherwise
inert on the built-in plan). The sequence-risk lab keeps `equityGrowth` as a price rate
(total = price + 2%); its retirement wrappers now follow that total, where before P2 they
sat at a fixed 7% whatever the lab swept. The shock-path probe's single Roth uses the US
total.

### 6.2 P3 implementation record (built 10 Sep 2026)

There were no growth or dividend fields to remove: the account editor never exposed the
per-account rates (they lived in generated params, dropped in P2). P3 is therefore only
the derived view.

- **The line.** In the holdings section, read-only: "Expected return 7.00% a year = 5.00%
  growth + 2.00% paid as dividends" on a taxable account, "Expected return 7.00% a year
  (2.00% of it dividends)" on a retirement account or super. It refreshes on every
  holdings change and on a country change, and is hidden when there are no equity lots.
- **The derivation** (`finance/holdings/effective-return.js`, `effectiveEquityReturn`)
  follows the engine's own resolution, so the number shown is the number the sim runs: a
  lot's market is its instrument's rate key (security, then lot), else the account's
  default for its role and country; its yield is the instrument's, else the market's;
  lots blend by market value. A lot on an authored `appreciationSchedule` is counted and
  named, not blended. Non-equity lots are left out (fixed income is P3b's).
- **Where the rates come from.** The host passes `marketRatesOf(cfg)` (beside
  `primeRatesOf` in `param-schema-utils.js`), read through `scenarioParamValues` so an
  edited market param shows before a Rebuild. A host that passes none hides the line
  rather than showing one computed off the defaults.
- **The table moved** to `finance/economic-regimes/market-returns.js` so the editor can
  read it without importing the regimes toolset; the toolset re-exports it.

### 6.3 P3b implementation record (built 10 Sep 2026)

**Result.** Unit 6,254 / viz 1,395 green. Numerically inert: ten goldens re-golded and
every changed field is a removed per-account fixed-income key —
`FIXED_INCOME_US::fixedIncomeAccount` and `FIXED_INCOME_AU::auFixedIncomeAccount` in the
base / effective interest maps and in `priorMarkRates` (the bond mark-to-market memory,
which now reads the bare market key at the same value). No balance or tax field moved.

**The eight readers of an account's own `interestRate`:**

| Reader | Now |
|---|---|
| US and AU savings accounts (`us-banking`, `au-banking`) | **kept** — a bank contract (D-5) |
| Cash sleeve of a US brokerage / 401(k) / IRA / Roth, and of AU stock / super | the country's savings rate |
| Bond-sleeve coupon fallback of a US wrapper, and of AU stock / super | the country's fixed-income rate |
| US and AU fixed-income accounts, and the per-account `FIXED_INCOME_*` seed | the country's fixed-income rate |

Every retired reader already fell back to exactly that param, so an unset field changes
nothing. On the cash sleeve it was also mostly unreachable already: the handler reads
`effectiveInterestRates` first, so the field only mattered without ECONOMIC_REGIMES.

**Kept, deliberately:** `primeSpread` on a brokerage or wrapper (the editor's "Cash Rate",
design 56 §6) — a Prime-linked cash-sleeve rate, not the overloaded field. The editor no
longer falls back to storing an absolute `interestRate` on a brokerage when no Prime is
configured: it stores nothing and says the cash sleeve earns the savings rate.

**Loader.** `retireRateParams` drops `interestRate` from every account whose role it fed
and warns unless the value equals EVERY rate it fed — a wrapper's fed two (cash sleeve and
bond coupon), so 4% on a Roth is silent only when both the savings and fixed-income rates
are 4%. The four params' defaults are mirrored in the module and pinned against the
schemas by a test.

### 6.4 P4 implementation record (built 10 Sep 2026)

Deleted design 98 W5 whole: `ROLE_PARAM_OVERRIDES`; `tagShadowedRows` and the `accounts`
option of `buildVariables` that fed it; the `shadowed` field of the run provenance and the
runner's "axes that reach NOTHING" warning; the MC panel's shadow chip and its CSS; and
the tests that pinned their resting state (`mc-shadowed-axes`, `mc-shadow-chip`). Nothing
else read them. W5 was a correct diagnosis of a problem P2 and P3b removed at the root —
there is no account-level rate left to shadow a market axis.

### 6.5 P5a implementation record — coupon-less bonds float (built 10 Sep 2026)

**Decided with the user:** P5 runs as three commits, (a) → (b) → (c). Coupon-less bonds
float WITH rate regimes, like a bond fund (D-6). Market totals will come from a
forward-looking capital-market-assumptions report; super's mix from APRA's MySuper
statistics — each fetched into `docs/` before any number changes.

**The rule.** A BOND lot that names its own `couponRate` keeps it (a fixed contractual
coupon, design 53 §4). One that names none earns the regime-adjusted curve at its
remaining tenor — a fund, with no maturity, at the 5y anchor, where the default curve's
spread is 0. Applied on both coupon paths (brokerage and wrapper bond sleeves) and on the
fixed-income accounts' interest path; the flat market param the handler carries is now
only the last resort, for a config with no curve in state. Two kinds of lot do not float:
inflation-linked (the curve is nominal — the maturity roll holds a TIPS's real yield flat
for the same reason) and zero-coupon (its return is accretion).

`finance/economic-regimes/couponless-yield.js` holds `couponlessYield` and the
`yearsToMaturity` the bond price reducer already used, so a bond's mark and its floating
coupon measure its tenor identically.

**Effect.** Every coupon-less lot in the goldens is an undated fund, so it moves only
while a rate regime holds the market away from the flat param. Eleven goldens are
byte-identical; the two with a crash preset moved:

| Golden | Net worth | Coupon income over the run |
|---|---|---|
| `wash-sale-harvest` | −0.40% (−24,407) | 359,187 → 336,372 (−6.4%) |
| `wash-sale-two-books` | −0.37% | — |

In `wash-sale-harvest` the 2029 `MARKET_CRASH_2008_LITE` shock cuts the US fixed-income
level from 4.00% to 0.60% for the rest of the run. Before P5a its bond funds kept paying
4% through that; now they pay the market's rate. Coupon income is identical through 2028
and about 5.5–5.9k a year lower from 2029. Measured by running the committed and the
working tree side by side on the same golden.

### 6.6 P5b implementation record — sourced market returns (built 10 Sep 2026)

**Sources** (all on disk in `docs/market-returns/`; `SOURCES.md` holds every figure and
the arithmetic): Vanguard VCMM (AU asset-allocation report, US forecast page), BlackRock's
CMA workbook ("Starting point", 10-year, geometric, gross of fees), J.P. Morgan's 2026
LTCMA USD/AUD matrices (compound column; downloaded by hand — no scripted route), and
MSCI index factsheets for the yields. Two search summaries misquoted figures (MSCI World
ex Australia's yield, J.P. Morgan's EAFE); both were caught by reading the documents.

**Decisions (user):** equal-weighted mean of the providers; developed ex-US (EM will be
its own market later); J.P. Morgan left out of ex-AU (it has no world-ex-Australia row);
totals to 0.1%, yields to 0.01%.

| market | total (was) | yield (was) |
|---|---|---|
| US | 7.0% (7%) | 1.10% (2%) |
| Developed ex-US | 6.9% (7%) | 2.53% (2%) |
| Australia | 6.7% (7%) | 3.43% (4%) |
| International ex-AU | 7.5% (7%) | 1.47% (2%) |

The providers disagree by up to ~4 points (US: Vanguard ≈5.2, J.P. Morgan 6.7, BlackRock
9.0), but the averages land near the old 7%, so most of the change is in the yields — how
much of each return is paid out and taxed. The shock presets were calibrated with a 7% US
base; the new US total is 7.0%, and the calibration probe sets its own base anyway.

**Goldens.** All 13 re-golded. Twelve moved between −0.56% and +0.18% of net worth.
`au-single-homeowner` fell 20.1% (4.25M → 3.40M). Attributed by re-running with one market
param restored at a time (via `cfg.parameters` — see below): putting the AU total back to
7% recovers 839k of the 853k; the AU yield accounts for ~21k. It is the cliff design 98 M1
exposed: the plan's super, AU stock and 2036 inheritance all track the AU market, and 0.3
points less over 30 years tips super from 204k left in 2066 to exhausted, after which the
inherited brokerage is drawn down instead of compounding. Correct, and a warning that this
plan is unusually sensitive to the AU rate.

**Found while building.**
- The US and AU single-homeowner plans' `buildDefaultConfig` silently DROP market params
  passed to it (no forwarding loop, unlike intl-retirement) — which is why the first
  attribution probe showed four identical runs. Pre-existing; fixed in its own commit:
  the intl plan's forwarding loop moved to `src/scenarios/toolset-param-forwarding.js` and
  all three plans call it, each from its own toolset list (`_paramToolsets()`, pinned to
  `getToolsets()` by a test). No golden moved: the harness's `fxProcessModel: 'NONE'`
  belongs to `US_AU_CROSS_BORDER`, which neither plan declares, so it is still not
  forwarded. `single-homeowner-param-forwarding.test.mjs` checks the effect on a run, not
  just the field.
- The allocation cube rounded each row to the cent and asserted Σ rows === net worth; that
  held by luck with round rates and failed by a cent with sourced ones. The cube now settles
  the rounding residue onto the largest recognised / speculative row, so both documented
  invariants hold exactly (`_absorbRoundingResidue`, with a direct test).
- Tests that pinned 7% / 2% / 4% now derive their expectations from the market table, so
  the next re-base does not break them again. `accounting-integrity` checks the US
  brokerage lot by lot — its domestic and ex-US lots no longer share a rate.

### 6.7 P5c implementation record — super's equity market mix (built 11 Sep 2026)

**Source.** APRA's Quarterly Superannuation Industry Publication, June 2026, Table 9a
"MySuper asset allocation" — every MySuper product, actual (effective) exposure. Listed
equity is 39.7% Australian and 60.3% international (hedged and unhedged pooled; the engine
applies no FX effect to equity growth). The file, the rows and the arithmetic are in
`docs/market-returns/SOURCES.md`, which also records the APRA tables that were read and
rejected: Table 1a of the MySuper statistics holds no allocations (single-strategy
products are exempt from SRS 533.0), Table 1b covers lifecycle products only, and the
older Table 6a series ended in September 2023.

**Decisions (user):** equity split only — super stays 100% equity; the ~19% a MySuper fund
holds in cash and fixed income is not modelled. SUPER only — an AU brokerage keeps its
domestic default. No lifecycle glide.

**Mechanism.** `DEFAULT_EQUITY_MARKET_MIX_BY_ROLE` in `default-allocations.js`;
`resolveEquityMarketMix` now resolves authored mix → role default → domestic market.
`_bootstrapDefaultHolding` already splits by whatever the resolver returns, so an
un-authored super starts as two lots. An authored `equityMarketMix` still wins, and the intl
plan's `auEquityIntlShare > 0` stamps one, so that lever still overrides the default.
Deposits spread pro rata over the lots, so contributions keep the split; the ex-AU share
then drifts up only because ex-AU compounds faster (0.603 → about 0.67 over 40 years).

**Goldens.** Twelve of 13 re-golded (every one with a super account), each attributed:
- `au-single-homeowner` **+24.6%** (3.40M → 4.23M): P5b's cliff reversing. Super's gross
  rate is now 0.397 × 6.7% + 0.603 × 7.5% = 7.18%, above the 6.7% that exhausted it; super
  ends at 319k instead of 0, and the inherited brokerage compounds instead of being drawn.
- Eight intl-plan goldens +0.10% to +0.93%, from the higher super rate.
- `bond-par-conservation`, `tips-ladder-conservation`, `two-security-concentration`: k401
  lots move too — TARGET_ALLOCATION's default LOCATED placement is household-wide, so a
  larger super moves where the bonds are placed.
- `wash-sale-harvest`, `wash-sale-two-books`: holding ids only. The LOCATED rebalance sells
  all of super's equity into bonds on 1 July 2026, before super's first earnings credit.
- Every intl-plan golden: later holding ids shift by one (super's bootstrap makes two).

**Open — rebalance buys ignore the mix.** A rebalance BUY into an equity sleeve whose lots
disagree on `rateKey` (a split super, or the intl plan's US brokerage with its ex-US lot)
takes `resolveRateKey`, i.e. the DOMESTIC market (`_inheritedTraits` → `_newSleeve`). Under
TARGET_ALLOCATION a super therefore drifts back towards 100% AU whenever it buys equity —
visible in `wash-sale-harvest`, whose later `reb-EQUITY-*` super lots are all `EQUITY_AU`.
Pre-existing for every mixed account; P5c makes it reach every rebalanced super. Plans
without TARGET_ALLOCATION are unaffected. Fixed in its own commit — §6.8.

### 6.8 Rebalance buys follow the market split (built 11 Sep 2026)

**Rule** (`_equityBuySplit`, rebalance-to-target-apply-reducer.js). An EQUITY buy into a
sleeve whose lots do not agree on a market is split by market:
- lots present → pro rata on the sleeve's current value per market (the rule deposits
  already follow; it also covers an account whose split lives only in authored lots, like
  the intl plan's 60/40 US brokerage);
- sleeve empty → the account's resolved mix (authored → role default → domestic);
- one market → the old single-lot path, unchanged.
Each leg is the GENERIC market position for its market (design 94 D10 — never an arbitrary
sibling's security) and joins at its own market's price. The last leg absorbs the rounding.

**Goldens.** The five TARGET_ALLOCATION goldens moved, −0.09% to +0.05% of net worth:
- super keeps its split — `wash-sale-harvest` ends 39.4% AU / 60.6% ex-AU (was 100% AU);
  `bond-par-conservation` 38.5% AU (had drifted to 63%);
- the intl US brokerage keeps its authored ex-US share — about 37% at the end of
  `bond-par-conservation` (was diluted to 22% by all-US buys).

**`wash-sale-two-books`.** The different lots leave a smaller 2030 wash (\$86k disallowed,
was \$111k). The year still nets an \$8.7k capital loss after the add-back, so the \$3,000
allowance applies either way and tax does not change; the disallowance shrinks the
carryforward instead (\$5.7k, against about \$91.8k without it). Correct under §1211(b) /
§1212(b). `wash-sale-golden`'s §1091(a) test now accepts either form of the bite — a higher
liability OR a smaller carryforward (user decision); this golden no longer exercises the
balance-due payment.

## 7. Decisions

| # | Question | Recommendation |
|---|---|---|
| D-1 | Where does the yield live? | On the **market** (with a security override), not the account. A 4% ASX yield is a fact about the ASX. |
| D-2 | A saved scenario's differing account rate: warn only, or convert? | **Warn only** at P2. There is no faithful conversion: a rate on a wrapper of mixed holdings has no single holding to move to. Revisit if a real saved scenario needs it. |
| D-3 | Price-vs-carve-out, or one uniform path (every account grows at price and reinvests the yield)? | Keep **two paths**, chosen by the handler's `yieldPaidSeparately`. Numerically identical, and the carve-out is what the design 84 s99B tax logic reads. |
| D-4 | Does super pay franked dividends? | Out of scope. It is design 90 §8.4, and the market yield gives it a number to use when it lands. |
| D-5 | Do cash/savings accounts keep an account-level rate? | **Yes**, `Prime + primeSpread`. A bank account's rate is a contract with one institution, like a mortgage rate: it genuinely belongs to the account. It is the one account-level rate that survives. |
| D-6 | Should coupon-less bond lots read the yield curve at their tenor? | Yes, but in **P5**, not P3b: it changes results. P3b only removes the account override. |

## 8. Open questions

1. ~~**Per-holding `dividendYield` on a lot.**~~ **Resolved 10 Sep 2026:** kept as a
   lot-level override, the middle of the D11 chain (security → lot → market).
2. ~~**The editor.**~~ **Resolved 10 Sep 2026:** the account editor loses its growth,
   dividend and interest fields and shows a **read-only effective rate**, derived from the
   holdings, so the derivation is visible rather than hidden. Built in P3.
3. ~~**Bond / fixed-income sleeves.**~~ **Moved into scope 10 Sep 2026:** §3.4, phase P3b.
