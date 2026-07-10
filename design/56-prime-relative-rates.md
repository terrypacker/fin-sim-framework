# 56 — Prime-relative rates (central-bank anchored cash & loan rates)

**Status**: **COMPLETE** — all phases (1, 2a, 2b, 3, 4) implemented and green
(3242 unit + 864 viz + build). Verified end-to-end against `scenarios/terry-jeanne-evaluation.json`
via `scripts/run-scenario.mjs`: the sim runs cleanly to 2070 and its net worth is
**byte-for-byte identical to the stored baseline** ($10,970,797.43), confirming the
capability-only Gold work (Phase 4) is non-disruptive to a gold-free scenario.

Model the real-world relationship between a central bank's **Prime** (policy) rate and
the rates a household actually pays and earns. Today every cash-interest and loan rate
is an **absolute, independent** number: two accounts, a mortgage, and an offset all
carry their own hand-entered rate, and nothing links them. In reality a commercial bank
sets each product a **spread over the central-bank rate** — when the RBA/Fed moves,
every variable savings rate and mortgage moves with it. This design introduces a
per-country **Prime rate** and reframes each cash account's and loan's rate as a
**spread over Prime**, so a single Prime move (a rate scenario, an MC draw, a scheduled
hike) fans out to every prime-linked product at once.

Equity and bond holdings keep their own decoupled return rates (a stock's forward
return and a fixed bond's coupon do not track the policy rate the way a savings rate
does). A new **Gold** holding type is added with its own commodity-style growth and
US-collectibles CGT.

**Builds on**:
- `design/28-economic-regimes.md` — the `state.effective{Growth,Interest}Rates[rateKey]`
  substrate + `RegimeApplyReducer`. Prime is a new rate series that lives here, so
  regimes/shocks/schedules move it for free.
- `design/55-configuration-driven-parameters.md` §8 — per-account rates via the
  `<memberKey>::<stateKey>` seeding in `seedPerAccountRates`
  (`economic-regimes-toolset.js:110`). This is the exact hook the spread plugs into.
  §10/§13 also log the **MC-sweep concern this design exists to fix**: once rates went
  per-account, sweeping a *global* rate silently no-ops on any account with an explicit
  value, so there is no coherent "move all my rates" knob (GH #511's rate half). Prime
  restores exactly that knob — see §3.1. (The *balance* half of #511 — sweeping a
  holdings-derived balance — is a separate, non-rate problem and stays out of scope.)
- `design/54-loan-liability-accounts.md` — `LoanAccount.interestRate`
  (`loan-classes.js:157`), which becomes Prime-relative.
- `design/53-account-basis-refactor-and-offset.md` §4 — per-lot `Holding` growth via
  `computeHoldingsGrowth` (`holdings-earnings.js:62`) + the fixed-coupon BOND path;
  Gold slots in as a new `ALLOCATION`.
- `design/25` holdings + `design/29` collectibles — Gold reuses the collectible
  disposal/CGT machinery for its 28% US rate.

### Decisions locked (from design review)
1. **Per-country Prime.** `PRIME_US` and `PRIME_AU` are independent rate series (real
   central banks move independently). Time-varying through the design-28 regime
   substrate (seed → schedule/shock/MC-adjust → effective).
2. **Store the spread; enter the absolute.** The canonical per-account field is the
   **spread over Prime**; the editor input is the **absolute rate the bank quotes**,
   converted to a spread on entry. `effectiveRate(t) = Prime(t) + spread`.
3. **Spread is account-level, for cash & loans only.** Cash (savings/checking/offset)
   interest and loan interest are Prime-relative. Equity and bond holdings keep their
   own rates; bonds are explicitly excluded.
4. **Cash holdings inherit the account cash rate.** A `CASH` holding has no rate field
   today; it earns the account's Prime-relative cash rate.
5. **Gold is a new holding type** with commodity-style growth and **US collectibles
   (28%) CGT** (AU: ordinary CGT); it reuses the collectible tax path.
6. **Prime is THE rate sweep.** `usPrimeRate`/`auPrimeRate` become the systemic MC/Opt
   rate targets and the **per-account interest-rate MC levers are retired** — sweeping a
   rate now means sweeping Prime, which fans out coherently (§3.1). The per-account
   `primeSpread` remains an editable/opt target (idiosyncratic residual), not a
   systemic-rate sweep.
7. **Offset earns nothing.** `OFFSET` is cash but its economic effect is reducing loan
   interest, not earning; it carries **no `primeSpread`** and inherits a 0 earn rate.
8. **The prebuilt scenario auto-links; loaded saves do not.** To make Prime MC work
   out of the box, `buildDefaultConfig`'s cash accounts + loan are seeded with a
   value-preserving `primeSpread` (`spread = currentAbsolute − primeDefault`) at build.
   Arbitrary *loaded* user saves stay legacy-absolute and only opt in on re-edit (§11) —
   full back-compat. (Chosen over a blanket auto-migration; scoped to the seed only.)

---

## 1. Problem — rates are absolute and unlinked

- **No shared anchor.** `SAVINGS_US`, `SAVINGS_AU`, `FIXED_INCOME_*`, and each
  `LoanAccount.interestRate` are independent seeded numbers (`rate-keys.js`,
  `loan-classes.js:157`). There is no way to express "all my variable rates move when
  the central bank moves," which is how households actually experience rates.
- **Rate scenarios are clumsy.** To model a hiking cycle you must hand-move every
  savings and mortgage rate in lockstep — and MC/optimization can only sweep them
  independently, which is not how a policy rate propagates.
- **Two central banks, one knob.** The US→AU household straddles the Fed and the RBA,
  which set materially different policy rates; the model has no per-country policy rate
  to hang the spreads off.
- **Cash holdings can't carry a rate.** A `CASH`-allocation holding
  (`allocation.js`) resolves to the account's `SAVINGS_*` key but exposes no rate of
  its own, so a multi-sleeve cash account has nowhere to put a rate — the account
  setting is the natural home.

The design-28 substrate already carries time-varying, regime-adjustable, MC-samplable
rate series keyed by `rateKey`. Prime should be **one more series in that substrate**,
and the per-account rate should be **derived from it**, not independent of it.

---

## 2. Core idea — Prime × spread ⇒ effective rate

```
   central bank (per country)        commercial spread (per account)      effective
   ──────────────────────────   +   ───────────────────────────────   =  ─────────────
   PRIME_US(t)  (Fed policy)          usSavings.primeSpread  (+2.1%)       account cash rate(t)
   PRIME_AU(t)  (RBA policy)          mortgage.primeSpread   (+1.8%)       loan rate(t)
                                      auSavings.primeSpread  (+2.5%)       …
```

`effectiveRate(stateKey, t) = Prime(country, t) + account.primeSpread`.

Because Prime lives in `state.effectiveInterestRates` (design 28), a scheduled hike, a
shock, or an MC draw on `PRIME_US` propagates to **every** US cash account and
US variable loan in the same period, each keeping its own spread. Turn the spread
mechanism off (spread absent) and the account falls back to its absolute rate — pre-56
scenarios are byte-for-byte unchanged.

This is the **MC-coherence fix** (design 55 §13): one Prime draw is the systemic rate
knob that moves the whole cash+loan complex together, replacing the fragmented
per-account rate levers that couldn't express a policy move. See §3.1.

---

## 3. The Prime rate series

Two new `RATE_KEYS` entries, both in `INTEREST_RATE_KEYS` (they live in
`effectiveInterestRates`):

```js
PRIME_US: 'PRIME_US',   // Fed policy rate
PRIME_AU: 'PRIME_AU',   // RBA policy rate
```

- **Seed.** Two new global params `usPrimeRate` / `auPrimeRate` (defaults ≈ current
  policy, e.g. US 0.045 / AU 0.0435), seeded into `baseInterestRates[PRIME_US|PRIME_AU]`
  at compile in the ECONOMIC_REGIMES toolset alongside the other base rates.
- **Time-varying.** Prime is a first-class regime target: a `FinancialShock` or a
  scheduled step can author `{ PRIME_US: +0.01 }` and `RegimeApplyReducer` moves the
  effective value, exactly as it does for equity/inflation today. A dedicated
  **rate-schedule** (an optional `[{ year, PRIME_US, PRIME_AU }]` param) is the clean
  way to express a hiking/easing path; it compiles into scheduled adjustments.
- **MC / Opt.** `usPrimeRate`/`auPrimeRate` are the MC/Opt rate targets — sweeping Prime
  moves the whole cash+loan complex coherently (§3.1, the point).
- **Per-country independence** is automatic: two keys, two params, two effective
  entries; nothing couples `PRIME_US` and `PRIME_AU`.

### 3.1 Monte Carlo & Optimization — Prime is the rate sweep

This is the concern design 55 §13 parks (the rate half of GH #511). Once 55 §8 made
interest rates per-account, sweeping a *global* rate silently no-ops on any account with
an explicit value (55 §10 shadowing rule), so there was no coherent way to MC "all my
rates move." Design 56 resolves it (Decision 6):

- **`usPrimeRate` / `auPrimeRate` are the systemic rate targets.** One draw moves
  `PRIME_US`/`PRIME_AU` in the effective substrate; every Prime-linked cash account and
  variable loan re-derives `Prime + spread` in the same period. Two knobs (one per
  central bank) sweep the entire rate complex, per-country-independently.
- **The per-account interest-rate MC levers are retired.** They no longer appear as
  MC/Opt rate targets — the old fragmented per-account rate sweep is *replaced* by
  Prime, not kept alongside it. This removes the "MC double-move" foot-gun (a global
  and a per-account rate compounding) at the source rather than documenting it.
- **`primeSpread` stays an editable / Opt target**, but as the *idiosyncratic residual*
  (this bank's markup over policy), never a systemic-rate sweep. An optimizer may still
  tune a single account's spread; only the *shared* rate move is Prime's job.
- **Out of the box (Decision 8).** Because the prebuilt scenario auto-links its cash
  accounts + loan (§11), a Prime sweep on a freshly-built prebuilt scenario moves those
  rates immediately — no per-account configuration required. A loaded legacy save whose
  accounts are still absolute is simply not swept by Prime until those accounts are
  re-edited (they carry no spread, so `Prime + spread` never applies) — the intended,
  back-compatible behavior.
- **Balances stay out.** The *balance* half of GH #511 (sweeping a holdings-derived
  balance) is unrelated to rates and is not addressed here.

---

## 4. Account-level spread (cash + loans)

### 4.1 Storage — the spread is canonical
A prime-linked account/loan carries `primeSpread: number` (annual, e.g. `0.021`). The
**effective** rate is never stored; it is `Prime(country, t) + primeSpread`.

`primeSpread` replaces the load-bearing role of the absolute per-account
`interestRate` (design 55 §8) for **cash** accounts and of `LoanAccount.interestRate`
for **loans**. The absolute field is retained only as the migration source (§10) and as
the fallback when no Prime is configured.

### 4.2 Editing — the user enters the absolute rate
Decision 2: the user types **the rate the bank quotes** (absolute). On commit the
editor converts it to a spread against the country's Prime at **sim start** (`t0`):

```
primeSpread = enteredAbsoluteRate − Prime(country, t0)
```

and stores `primeSpread`. Re-opening the editor shows
`absolute = Prime(country, t0) + primeSpread` as the editable value, plus a read-only
hint `“= Prime (4.50%) + 2.10%”` so the relationship is visible (this is the "both" —
the absolute is the input, the spread is the derived, shown, quantity). Editing Prime
therefore shifts every linked account's displayed absolute — correct, and the whole
point.

*(Alternative considered: store the absolute + a per-account `primeBaselineAtEntry` and
compute `effective = absolute + (Prime(t) − baseline)`. Equivalent math, two fields,
more drift surface. Rejected for the single-field spread.)*

### 4.3 Which accounts
`primeSpread` applies to `SAVINGS`, `CHECKING` (cash) and `LOAN` (liability). It also
applies to a **holdings account that carries a `CASH` sleeve** (e.g. `BROKERAGE`): there
the account's `primeSpread` is the rate on its *cash* holdings only (its equity/bond
sleeves keep their own growth/coupon rates). This closes the "cash holdings can't carry
a rate" gap (§6) with a single account-level input rather than a per-holding field. An
equity/bond/retirement account with no cash sleeve simply never sets it.

**`OFFSET` earns nothing (Decision 7).** An offset is cash, but its economic effect is
reducing the linked loan's interest, not earning interest of its own. It carries **no
`primeSpread`** and contributes a 0 earn rate — the offset's benefit already flows
through the loan's Prime-relative interest (§5). (If a future design wants an offset to
earn on any un-offset excess, that is an additive `primeSpread` on `OFFSET`; explicitly
not in 56.)

---

## 5. Effective-rate computation — one change in `seedPerAccountRates`

The plug-in point already exists (`economic-regimes-toolset.js:110`). Today it seeds
`baseInterestRates[`SAVINGS_US::usSavingsAccount`] = acct.interestRate`. Design 56:

```js
// for a cash account with a primeSpread:
const prime = baseInterestRates[primeKeyFor(acct.country)];         // PRIME_US | PRIME_AU
const perVal = (acct.primeSpread != null && prime != null)
  ? prime + acct.primeSpread                                        // Prime-relative
  : (acct.interestRate ?? baseMap[memberKey]);                      // legacy absolute / baseline
baseMap[`${memberKey}::${stateKey}`] = perVal;
```

- `computeHoldingsGrowth` already reads `<memberKey>::<stateKey>` first
  (`holdings-earnings.js:81`), so cash-holding interest picks up the Prime-relative
  value with **no handler change**.
- `RegimeApplyReducer` still fans class-level interest shocks onto the per-account key,
  so a Prime move and a separate savings-market shock compose.
- **Loans** are not in the earnings substrate. `LoanPaymentHandler`
  (`loan-classes.js:157`) reads `loan.interestRate` directly; change it to resolve
  `Prime(country, t) + loan.primeSpread` from `state.effectiveInterestRates`
  (falling back to the absolute `interestRate`). This makes a variable-rate mortgage
  track Prime period-by-period; a `primeSpread`-less loan stays fixed (back-compat).

**Recompute cadence — ⚠ NOT free; the core Phase 2 task.** This claim is *aspirational*,
not what Phase 1 built. `seedPerAccountRates` runs **once at compile** and bakes
`SAVINGS_*::<stateKey> = Prime_seed + spread` into `baseInterestRates`. `RegimeApplyReducer`
rebuilds `effectiveInterestRates` from `baseInterestRates` each period and applies
`interestRateAdjustment`s — but a `PRIME_US` adjustment moves `effectiveInterestRates[PRIME_US]`,
which **nobody reads at runtime** (handlers read the derived `SAVINGS_*::<stateKey>`, and
PRIME→SAVINGS is not a class-member fan-out in `RATE_KEY_CLASS_MEMBERS`). So a
**time-varying Prime within a single run does NOT reach cash accounts today.**

- **MC/Opt on `usPrimeRate` works** already, because each MC iteration re-compiles and
  `seedPerAccountRates` re-derives `Prime_new + spread` (this is what Phase 1's PRIME-2
  test exercises — a *param* change, not a runtime move).
- **Time-varying-within-a-run** (schedules/shocks moving `PRIME_US` mid-sim) needs new
  plumbing (Phase 2b): store the per-account prime link in state (`{ stateKey, savKey,
  primeKey, spread }`) and, after `RegimeApplyReducer` has set `effectiveInterestRates`,
  recompute `effectiveInterestRates[`savKey::stateKey`] = effective[primeKey] + spread`
  each period. Fold into `RegimeApplyReducer` (it already owns the base→effective rebuild)
  or a dedicated reducer ordered after it. Loans (Phase 3) read Prime from
  `effectiveInterestRates` directly, so they get this for free once Prime is time-varying.

---

## 6. Cash holdings inherit the account cash rate

A `CASH` holding has no rate field and resolves to a `SAVINGS_*` key. With §5 seeding the
per-account `SAVINGS_*::stateKey` to `Prime + spread`, a cash sleeve earns the account's
Prime-relative rate automatically — closing the "cash holdings can't carry a rate" gap by
making the **account** the single place a cash rate is set (per Decision 4). No
per-holding cash-rate field is added.

**Two mechanics make this work for a cash sleeve in a *non-cash* account (e.g. a
`BROKERAGE` holding some `CASH`):**

1. **`resolveRateKey` routes `CASH` to `SAVINGS_{country}` regardless of role.**
   Previously the account *role* won (`default-allocations.js`), so a `CASH` sleeve in a
   `US_STOCK` brokerage resolved to `EQUITY_US` and would grow at the equity rate. A
   `CASH`-allocation carve-out (checked before the role) makes any cash sleeve resolve to
   the country's cash key. (Behavioral panic-sell cash is created with `rateKey: null`
   and bypasses the resolver, so it is unaffected — it stays zero-growth by design.)
2. **`seedPerAccountRates` seeds `SAVINGS_{country}::<stateKey>` from a non-cash
   account's `primeSpread`.** A cash account already seeds this via its primary (savings)
   branch; a brokerage's primary branch is its equity growth key, so its cash-sleeve rate
   is seeded separately from `primeSpread`. Absent `primeSpread`, the sleeve falls back to
   the shared `SAVINGS_{country}` baseline (the global savings rate) — a sensible default.

The **account editor** exposes the same absolute-entry / spread-store field on
`BROKERAGE` (labelled as the cash-sleeve rate); the mechanism is account-type-agnostic,
so extending it to other holdings accounts is additive.

---

## 7. Gold holding — new allocation, commodity growth, collectibles CGT

### 7.1 Allocation & growth
Add `GOLD` to `ALLOCATION` (`allocation.js`) and a `GOLD` rate key (a commodity return
series in `effectiveGrowthRates`, seeded from a global `goldGrowthRate`, regime-
adjustable like equity but on its **own** key — Gold does not track Prime and is not a
bond). `computeHoldingsGrowth` already grows any holding by
`state.effectiveGrowthRates[holding.rateKey]`, so a Gold sleeve with `rateKey: 'GOLD'`
grows with no handler change. Per-holding `growthRate`/`appreciationSchedule` overrides
work as they do for equity.

### 7.2 Tax — US collectibles 28% (AU: ordinary CGT)
Decision 5: on disposal, Gold is taxed at the **US 28% collectibles rate**, reusing the
`COLLECTIBLE_SALE`/`COLLECTIBLE_SALE_TAX` machinery (`us-collectible-classes.js`) rather
than the 15/20% brokerage CGT. Because Gold is a **holding inside an account** (not a
standalone collectible asset), the account's disposal path must route a `GOLD`-sleeve
sale through the 28% tax computation. Two options for the design phase:
  - **(a)** Tag the holding (`taxClass: 'COLLECTIBLE'`) and branch the brokerage sale
    reducer to emit `COLLECTIBLE_SALE_TAX` for gold lots (localized, keeps Gold in the
    account).
  - **(b)** Model Gold sleeves as first-class collectibles and reuse the existing
    disposal reducer wholesale (more reuse, but Gold then isn't an account holding).

Recommend **(a)** — it honors "Gold *holding*" and confines the change to the disposal
reducer's tax branch. AU disposal uses the standard AU CGT path (Gold is an ordinary
CGT asset in AU).

### 7.3 After-tax metric
Add a `GOLD`→collectible mapping to `after-tax.js`'s `TAX_CLASS` so the embedded-CGT
net-worth metric sizes gold's latent 28% liability correctly.

---

## 8. Equity & bond holdings — unchanged

Equity forward returns (`EQUITY_*`) and fixed-bond coupons (`Holding.couponRate`,
design 53 §4) stay on their own keys, decoupled from Prime (Decision 3). No change; this
section exists to pin the scope boundary.

---

## 9. `earningsBasis` — explicitly out of scope

`earningsBasis` is the earnings half of the retirement deferred-tax ledger
(`contributionBasis + earningsBasis == balance`), read by every retirement
withdrawal/conversion and the after-tax metric. It is **load-bearing and unrelated to
rates**, so it stays as-is and is not touched here. (The orthogonal cleanup — deriving
the contribution/earnings split instead of hand-editing it — belongs to design 53, not
56.)

---

## 10. UI

- **Prime**: two global params (`usPrimeRate`, `auPrimeRate`) render in the Scenario
  editor like any rate; an optional Prime **schedule** editor (year → rate) is the
  time-path affordance. No new panel.
- **Account editor** *(Phase 1 done)*: an **absolute-rate input** with a read-only
  `“= Prime (x%) + spread”` hint; on save it stores `primeSpread` (§4.2). Shown for cash
  types (label "Interest Rate") **and `BROKERAGE`** (label "Cash Rate" — it sets the rate
  on the account's `CASH` sleeve, §6). Loans gain the same treatment in Phase 3.
- **Holdings editor**: `GOLD` joins the allocation dropdown; a gold sleeve shows the
  growth-rate cell (like equity), not the coupon cell.

---

## 11. Serialization, back-compat, migration

- **New fields**: `Account.primeSpread`, `LoanAccount.primeSpread` in
  `toJSON`/`fromJSON` + the account serializer. Absent → the resolver uses the legacy
  absolute `interestRate`, so old saves are byte-for-byte unchanged.
- **New rate keys** `PRIME_US`/`PRIME_AU`/`GOLD` + `goldGrowthRate`/`usPrimeRate`/
  `auPrimeRate` params. Absent on old saves → Prime defaults seed in; no spread means no
  account is Prime-relative until re-edited.
- **Prebuilt seed auto-links (Decision 8).** `buildDefaultConfig` seeds its cash
  accounts + loan with a **value-preserving** `primeSpread` at build time —
  `primeSpread = currentAbsoluteRate − primeDefault(country)` — so the shipped prebuilt
  scenario is Prime-linked out of the box: a Prime MC sweep (§3.1) moves its rates with
  no manual configuration, and because the spread is derived to reproduce the current
  absolute at `t0`, the *un-swept* prebuilt sim is byte-for-byte unchanged. This is the
  **only** place migration is automatic.
- **Loaded user saves stay legacy (opt-in, non-destructive)**: a save's existing cash
  `interestRate`/loan `interestRate` is **left untouched** — it still works via the
  absolute fallback (§5) and only becomes Prime-linked when the user re-edits that
  account (§4.2 converts the entered absolute to a spread). No blanket auto-migration of
  loaded saves. (A one-time convert-all pass — `primeSpread = interestRate − primeDefault`,
  drop the absolute — remains available as an explicit user action but is not the default.)
- **`GOLD` ALLOCATION** is additive to `ALLOCATION_VALUES`; schema validation and the
  allocation→rateKey map gain the entry.
- Round-trip tests extend `holdings-roundtrip` (gold sleeve) and a legacy fixture
  (absolute rates, no Prime) asserting identical sim output.

---

## 12. Phased plan

### Phase 1 — Prime series + cash spread + prebuilt auto-link (no gold, no loans)
1. `PRIME_US`/`PRIME_AU` rate keys + `usPrimeRate`/`auPrimeRate` params; seed into
   `baseInterestRates`.
2. `Account.primeSpread` + serializer; `seedPerAccountRates` computes
   `Prime + spread` for cash accounts (§5), absolute fallback retained.
3. Account editor: absolute-input / spread-store + Prime hint.
4. **Prebuilt auto-link (Decision 8, §11)**: `buildDefaultConfig` seeds its cash accounts
   with a value-preserving `primeSpread = currentAbsolute − primeDefault`, so the shipped
   scenario is Prime-linked out of the box.
5. **Exit test**: a savings account with `primeSpread` earns `Prime + spread`; moving
   `usPrimeRate` moves it; an unset spread is byte-for-byte legacy. Cash-holding
   interest tracks it. **The freshly-built prebuilt scenario is Prime-linked, and its
   un-swept sim is byte-for-byte identical to pre-56** (value-preserving conversion).

### Phase 2 — Time-varying Prime + the MC-coherence fix (regimes / schedule / MC)
*This phase is where the design-55 §13 rate-sweep concern is actually resolved (§3.1).*
*Split into 2a (targets — mostly config) and 2b (runtime propagation — the real work).*

**Phase 2a — MC/Opt targets + retire the per-account rate levers (Decision 6). — DONE.**
1. **Done.** `usPrimeRate`/`auPrimeRate` are `mc:true, opt:true` (`us-`/`au-banking-toolset.js`
   paramSchema) + curated MC targets in `intl-retirement-mc-config.js` (NORMAL, mean = default,
   stdDev 0.01) + curated Opt targets in `intl-retirement-opt-config.js` (CONTINUOUS 0–0.10,
   step 0.005, enabled:false).
2. **Done.** Per-account interest-rate levers retired: the generated `INTEREST_RATE` template
   is `mc:false` (`record-param-templates.js`; feeds CHECKING/SAVINGS only, so fixed-income is
   untouched — bonds excluded per Decision 3); the global `usSavingsInterestRate`/
   `auSavingsInterestRate` are removed from the MC config **and** flipped to `mc:false, opt:false`
   in the toolset schema (so they can't be re-added as a rate knob in the UI — kills the
   double-move at the source, not just in the default set). Both still work as seed / fallback
   params. `fixedIncomeInterestRate` stays an MC target.
3. **Done.** `param-sweep-schema.test.mjs` SWEEP-10/11 stay green (Prime is now the curated
   MC/Opt rate target with `mc:`/`opt:true`; the retired savings rates simply left the curated
   lists).
4. **Done.** Exit test `tests/unit/prime-mc-coherence.test.mjs` (MCC-1…4): Prime is an
   enabled MC + Opt target, the savings-rate + generated per-account interest levers are
   `mc:false`, and one `usPrimeRate` move lifts the **whole** US cash complex (savings + a
   linked brokerage cash sleeve) by exactly the same Δ while the AU complex is untouched — the
   coherent "move all my rates" knob GH #511 lacked.

**Phase 2b — time-varying Prime WITHIN a run (the real plumbing; see §5 ⚠). — DONE.**
1. **Done.** `seedPerAccountRates` now returns the prime links (`{ stateKey, savKey,
   primeKey, spread }`, both cash-account and cash-sleeve cases); `state()` stores them as
   `state.primeLinks`.
2. **Done.** New `PrimeRelinkReducer` (`prime-relink-reducer.js`) at `PRE_PROCESS + 2`
   (after `RegimeApplyReducer` at +1), on the same action types. It adds the runtime Prime
   **delta** (`effective[primeKey] − base[primeKey]`) onto each linked
   `effective[savKey::stateKey]` — using the delta (not an overwrite with `Prime + spread`)
   so the baked-in spread **and** any SAVINGS-class market shock `RegimeApplyReducer` fanned
   onto the key both survive and *compose* (§5). Zero delta ⇒ no-op (byte-for-byte legacy).
3. **Done.** `primeSchedule` param `[{ year, PRIME_US, PRIME_AU }]` (absolute rates) compiles
   in `schedules()` via `schedulePrimeRateSteps` into non-overlapping L-profile regime steps
   (`adjustment = absolute − seed`) authored through the existing shock path; a
   `PrimeScheduleList` editor renders it.
4. **Done.** Exit test `tests/unit/evt-prime-timevarying.test.mjs` (PRIME-TV-1…5 end-to-end
   on the prebuilt + PRIME-TVU-1…4 isolated `reduce()` postconditions): a mid-run
   shock/schedule `PRIME_US` hike lifts every linked US cash rate by exactly the move and
   credits more interest; a spread-less account and the independent AU series are unchanged.
   *(Note: comparing credited interest across a with-shock vs no-shock run is confounded —
   injecting a shock's recovery-tick events perturbs event ordering by a few cents
   regardless of the rate; the effective **rate** is the clean, unconfounded signal.)*

### Phase 3 — Loans track Prime — DONE.
*The prebuilt loan is **synthesized from a property mortgage** (`synthesizeLoanForProperty`),
not a standalone `LoanAccount`, so Prime-linking threads through the property's mortgage.
The default prebuilt has **no** mortgaged property (both houses are unmortgaged), so there is
no prebuilt loan to auto-link (Decision 8's "+ loan" is moot for the shipped default); a user
Prime-links a mortgage by entering its rate in the property editor.*
1. **Done.** `RealProperty.mortgagePrimeSpread` + serializer; `synthesizeLoanForProperty`
   threads it onto the loan as `primeSpread`. New `resolveLoanRate(state, loan)` resolves
   `Prime(country,t) + primeSpread` from `state.effectiveInterestRates[PRIME_{country}]`
   (`PRIME_KEY_BY_COUNTRY`), fallback to the absolute `interestRate`. Used by BOTH the
   `LoanPaymentHandler` interest accrual **and** the rental deductible-interest line
   (`computeRentalMonth`) so the two never diverge for a variable rental mortgage.
   Time-varying comes free from Phase 2b (PRIME_* stays current in the effective map; the
   loan reads it directly each month). A standalone `LoanAccount` inherits `primeSpread` from
   `Account` and round-trips via the account serializer; `seedPerAccountRates` step 2 now
   skips liabilities so a loan never seeds a bogus `SAVINGS_*::<loanKey>`.
2. **Done.** Property editor (`real-property-editor.js`) mortgage-rate field is
   absolute-input / spread-store with a `= Prime (x%) + spread` hint (mirrors the Phase 1
   account editor); `primeRates` threaded from `workbench-app.js`. Viz test
   `tests/viz/editors/mortgage-prime-rate-field.test.mjs`.
3. **Done.** Exit test `tests/unit/evt-prime-loans.test.mjs` (PRIME-LOAN-1..3 e2e on a
   mortgaged prebuilt property + PRIME-LOAN-U1..2 isolated `resolveLoanRate`): a mid-run
   PRIME_US hike raises a linked mortgage's effective rate and ending balance (slower paydown);
   a spread-less mortgage is byte-for-byte unchanged.

### Phase 4 — Gold holding — DONE.
1. **Done.** `GOLD` added to `ALLOCATION` (+`isCollectibleAllocation`/`COLLECTIBLE_ALLOCATIONS`
   in `allocation.js`); `RATE_KEYS.GOLD` (a commodity series in `effectiveGrowthRates`);
   `resolveRateKey` routes `GOLD → RATE_KEYS.GOLD` before the role check (country-agnostic,
   like the CASH carve-out) so a gold sleeve in a US_STOCK brokerage grows on its own key,
   not equity. `collectBaseGrowthRates` seeds `GOLD` from the new global `goldGrowthRate`
   param (default 0.05, `us-retirement-toolset` paramSchema, mc/opt=true) + DEFAULT +
   passthrough. `computeHoldingsGrowth` grows a `rateKey:'GOLD'` sleeve with no handler
   change. Holdings editor (`account-editor.js`): `GOLD` in the allocation dropdown +
   rate-key group; equity-style cell gating (cost basis shown for CGT, no coupon/duration/
   dividend); switching to GOLD pins `rateKey='GOLD'`.
2. **Done.** Disposal 28% branch (§7.2a): `consumeHoldingsFifo` now also returns
   `collectibleProceeds`/`collectibleBasis` (the consumed GOLD-lot slice); the US brokerage
   disposal — BOTH `StockWithdrawalApplyReducer` (event path) and the `account-service`
   `_drawPenaltyFree` drawdown engine — splits the gold gain into `COLLECTIBLE_SALE_TAX`
   (→ `usCollectibleGainsYTD` @ 28%, +AU CGT if resident) and keeps the rest on
   `STOCK_WITHDRAWAL_TAX` (ordinary brokerage CGT). AU brokerage disposal is unchanged
   (gold in an AU brokerage is already ordinary AU CGT). `after-tax.js`: `TAX_CLASS.COLLECTIBLE`
   + a gold/ordinary gain split in the `TAXABLE_BASIS` branch (gold @ 28% via a new
   `collectibleLiquidationRate` on both providers; AU-domiciled gold @ AU CGT); a gold-less
   account is byte-for-byte the pre-56 single-rate discount.
3. **Done.** Exit test `tests/unit/evt-prime-gold.test.mjs` (GOLD-1..6): GOLD resolves to
   its own key regardless of role; `effectiveGrowthRates.GOLD` tracks `goldGrowthRate`
   independently of equity/Prime; a gold sleeve grows at the GOLD rate; FIFO tallies the
   collectible slice; a US sale routes the gold gain → `COLLECTIBLE_SALE_TAX` (28%) and the
   rest → `STOCK_WITHDRAWAL_TAX`; `computeAfterTaxValue` sizes the gold liability at 28% and
   the equity gain at 15%, gold-less unchanged.

---

## 13. Risks / open questions

- **⚠ Static seed vs time-varying Prime (the Phase 2b crux).** Phase 1 bakes
  `SAVINGS_*::<stateKey> = Prime_seed + spread` into `baseInterestRates` once at compile.
  MC/param changes re-seed (work), but a Prime move *within a run* (schedule/shock) does
  **not** reach cash accounts without new plumbing — see §5's corrected "Recompute
  cadence" and Phase 2b. This is the single biggest under-statement in the original draft.
- **Spread display when Prime changes.** Storing the spread means the account editor's
  displayed absolute shifts if the user edits Prime afterward. Correct behavior, but
  potentially surprising — the Prime hint mitigates it. Confirm this is the desired UX.
- **`t0` for the spread conversion.** `primeSpread = absolute − Prime(t0)` uses Prime at
  sim start. If a scenario's start date or `usPrimeRate` changes after accounts are
  entered, previously-entered spreads keep their old baseline (they encode a spread, not
  an absolute) — which is the intended semantics, but worth a doc note.
- **Gold as holding vs collectible (§7.2).** Option (a) keeps Gold an account holding
  but threads a `taxClass` branch into the brokerage disposal reducer; (b) is more reuse
  but relocates Gold out of accounts. Locked to (a) pending implementation friction.
- **Loan effective-rate source.** Loans are outside the earnings substrate; Phase 3
  reads Prime from `state.effectiveInterestRates` directly. Ensure the loan payment
  event fires after the period's effective map is built (ordering, design 34 §13).
- **Offset accounts — resolved (Decision 7).** `OFFSET` carries **no `primeSpread`** and
  earns nothing; its benefit flows through the linked loan's Prime-relative interest
  (§4.3). An earn-on-excess-offset rate is a future additive change, not in 56.
- **MC double-move — resolved at the source (Decision 6).** Rather than *document* that
  sweeping `PRIME_US` and a per-account rate compounds (55 §10's shadowing note), 56
  **retires the per-account interest-rate MC levers** (§3.1): Prime is the only systemic
  rate sweep, so there is no second rate knob to double-move. `primeSpread` remains an
  Opt-only idiosyncratic residual, never a systemic-rate MC target.
- **Fresh-scenario rate sweep — resolved (Decision 8).** Retiring the per-account rate
  levers would otherwise leave a *loaded-legacy* save with no rate MC target until its
  accounts are re-linked. Accepted for arbitrary saves (they opt in on re-edit); the
  **prebuilt** scenario avoids the gap entirely by auto-linking at build (§11), so the
  flagship scenario always has a working Prime sweep.

---

## Decisions

| # | Question | Decision |
|---|----------|----------|
| 1 | Prime scope | **Per-country** `PRIME_US` / `PRIME_AU`, independent, time-varying via the design-28 regime substrate. |
| 2 | Stored field | **The spread** (`primeSpread`); the editor input is the **absolute** bank rate, converted on entry. `effective = Prime(t) + spread`. |
| 3 | Spread granularity | **Account-level, cash + loans only.** Equity/bond holdings keep their own rates; bonds excluded. |
| 4 | Cash-holding rate | **Inherits the account cash rate** (Prime + spread); no per-holding cash-rate field. |
| 5 | Gold | **New `GOLD` holding type**, commodity growth on its own key; **US 28% collectibles CGT** (AU ordinary CGT), reusing the collectible tax path. |
| 6 | MC rate sweep | **Prime is THE rate sweep**; `usPrimeRate`/`auPrimeRate` are the systemic MC/Opt targets and the per-account interest-rate MC levers are **retired** (§3.1, fixes 55 §13). `primeSpread` stays an idiosyncratic Opt residual. |
| 7 | Offset earn rate | **None.** `OFFSET` carries no `primeSpread`, earns 0; its benefit flows through the linked loan's Prime-relative interest. |
| 8 | Fresh-scenario linking | **Prebuilt auto-links; loaded saves opt in.** `buildDefaultConfig` seeds value-preserving `primeSpread` so the prebuilt Prime sweep works out of the box; arbitrary saves stay legacy-absolute until re-edited. |
| 9 | `earningsBasis` | **Untouched, out of scope** — retirement deferred-tax ledger, unrelated to rates. |
