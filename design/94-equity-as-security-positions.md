# 94 — Equity as security positions (design 93's Option C)

**Status** (2026-09-02): **COMPLETE — steps 0–10 BUILT.** Step 10 (§10.3) closed §10.2e's
three loose ends: the securities editor, an order-valued multi-select control, and the
cross-account Securities panel. What follows is the second pass's status, kept for the
reasoning it records.

**Status** (2026-08-26): **SECOND PASS; step 0 spiked and reverted, steps 1, 2, 2a and 3 BUILT.**
Steps 4–5 are specified tightly enough to build; steps 6–9 are not. §9.5 has the step-0 spike's
outcome — it confirmed §9.3, demonstrated §9.4 as a live defect, and found a third thing
(§9.5c). §4.1, §5.3, §9.6 and §9.7 are the implementation records for steps 2, 1, 2a and 3. The first pass (2026-08-24) was written from design 93
§5's substrate and left eleven open questions in §12. This pass answers eight of them — four
against the code, four against measurements taken for this document — and the answers moved
the design in three places (§6.2, §6.4, §9.3). **R1 (the wash-sale law) is also done**: the
sources are in `docs/` and §8.1 is written from them, with one AU ruling still to fetch.
§13 has the sequencing that follows.

Two measurements are committed as probes rather than left in this document, because a
number in a design doc goes stale silently: `scripts/probes/probe-security-registry-clone-cost.mjs`
(§6.4), `scripts/probes/probe-unitised-equity-rounding.mjs` (§9.3) and
`scripts/probes/probe-step3-regold-delta.mjs` (§9.7a). The first reports two
tables and the header says which one decides anything — the per-clone figure overstates the
run-level cost by roughly five-fold, and quoting it alone is how this document got §6.4 wrong
the first time.

Design 93 asked whether units-as-substrate was the foundation for equity shares and answered
**yes, later**: Option A (units for bonds only) now, Option C (equity as positions in named
securities) as the destination, B (a synthetic unit for equity) rejected because a fiction in
a substrate gets taken literally by the next author. §5 of that document is closed. This one
works out what C actually is.

---

## 0. What the second pass measured, and what it changed

The first pass opened with two findings that "cut in the same direction" — that a security
tracking a market is free, and that the migration is numerically byte-identical. **The first
is half right, the second is half true, and a cost neither of them considered turned up
alongside both.**

| # | claim (first pass) | verdict | where |
|---|---|---|---|
| 1 | A security tracking a market costs **zero extra RNG draws** | **HOLDS.** `EquityReturnTickHandler` skips the idio draw entirely at σ=0; the same rule extends to securities unchanged. | §6.2 |
| 2 | …and **zero extra state** | **FALSE as written, and now fixed.** A 20-security registry makes each `deepClone` ~38% dearer on a real plan, costing a whole run +7% at `full` and +5% at `metrics` — nothing at `off`/`journal`, because design 78 already took the batch paths off the clone path. `cloneState` + freeze (step 2, BUILT) recovers it: **+0.5% and +1.4%.** | §6.4 |
| 3 | The migration is **numerically byte-identical** | **HALF TRUE.** Exact on the growth path (0 divergences in 880,000 repricings). **Cent-scale on 6.5% of positions** once sells and buys are in the mix. C lands with a re-gold, not without one. | §9.3 |
| 4 | Wash sales are unreachable because "nothing can say the repurchase is substantially identical" | **UNDERSTATED, twice.** `resolveSubstitute` picks a replacement **with the same `rateKey`**; and the harvest fires 31 Dec while every rebalancer fires 1 Jan, so the model puts a repurchase one day inside §1091's 61-day window **every year**. It does not omit the rule — it constructs the fact pattern the rule disallows. | §8.1a |

Two further things the reading turned up, neither of which the first pass anticipated:

5. **Unitising equity silently changes what a reinvested dividend does.** `_patchHolding`
   routes a `marketValue` patch on a unitised holding through `reprice()`, on the stated
   grounds that "every caller that reaches here is a PRICE move". `AuStockDividendHandler`
   reinvests dividends through exactly that path. The premise is true only while equity is
   scalar; the moment C unitises it, every reinvested dividend **inflates the price of the
   existing units instead of buying more of them** — and because the money is conserved, no
   golden moves and no test fails. §9.4. This is the single most dangerous thing in the
   migration and it is invisible by construction.
6. **The rebalancer already contains the answer to "which security does a buy establish?"**
   `_inheritedTraits` gives a fresh lot the traits its siblings unanimously agree on, and
   returns `undefined` — meaning "use the defaults" — when they disagree. `securityId` joins
   that set and needs no new policy at all. §10 item 2.

**The net.** C is not cheaper than design 93 §6.3 estimated; it is differently expensive. The
RNG cost §6.3 feared is real only for concentrated positions; a **clone** cost it did not
consider is real for every security, but lands on the workbench and the optimizer rather than
on Monte Carlo, and a ten-line mitigation removes it; and the migration needs a re-gold and
one behavioural fix before it is safe. What has not changed is the shape: this is still a data
migration plus new entities, not a rewrite.

---

## 1. What this inherits, and what it is therefore not allowed to change

Design 93 built the substrate deliberately so that C is a data migration plus new entities,
never a rewrite. What is already in place, and the constraint each one imposes:

| built | constraint on C |
|---|---|
| `units` is generic and never bond-gated (§6.2 item 1) | C must not add `if (allocation === EQUITY)` to the substrate either. Instrument behaviour belongs in reducers. |
| Two first-class modes — SCALAR and UNITISED (§6.2 item 2) | **C is exactly "flip equity from scalar to unitised".** Every primitive already handles both as supported paths. |
| `instrumentOf(h)` as the single read path for instrument-level fields (§6.2 item 3) | C changes ONE function — `return securities[h.securityId] ?? _inline(h)` — instead of every consumer. But see §5.2: nothing calls it yet, so converting the consumers IS the work. |
| `securityId` reserved, nullable, round-tripping since §5a (§6.2 item 4) | C never touches the serializer, the schema registry, or the round-trip tests to introduce it. `holdings-roundtrip.test.mjs:257` pins it absent-by-default, and that test has to be **amended, not deleted**, when C turns it on. |
| `split()` (§5.4 item 6) | The corporate-action primitive exists and came back clean — four lines, basis and acquisition dates untouched. |
| The lot rule + `lotVintage` (§5.0a, §5.4a) | A purchase is a lot, and lots already carry their own vintage. Per-security lots need no new concept. |
| `compactLots` with an EXCLUSION key (§5.5) | **Free correctness**: `securityId` is not in any policy's mergeable set, so lots in different securities can never merge. C needs no compaction change. |
| Three invariant walks + the write gate (`holding-value-write-gate.test.mjs`) | The par/unit invariants transfer to equity unchanged; §11 says what the fourth and fifth walks have to hold. |
| **`_patchHolding`'s routing rule** (`holding-reducers.js:48`) | ⚠️ **The one inherited thing C BREAKS.** It routes every `marketValue` patch on a unitised holding through `reprice`, justified by an enumeration of callers that is true only while equity is scalar. §9.4 is the fix, and it is a precondition of step 3, not a follow-up. |

**The rule that binds hardest**: design 25's *state is plain data, no derived getters* —
`deepClone` (`state-utils.js:49`) drops prototypes and is used by history, the journal and
MPC injection. A `securities` registry in state must be a plain map, and `instrumentOf` must
be a free function, not a method.

## 2. Scope

**In scope.** A `Security` entity and registry; `Holding.securityId` becoming load-bearing;
the price path for securities that need their own; corporate actions as dated events;
migration of existing equity buckets; the tax machinery a named security makes reachable
(§8), to the extent §12's research supports it.

**Out of scope, named so they are not assumed in:**

- **Options, RSUs and vesting.** Design 93 already called these consumers of C, not part of
  it. They need a grant/vest/exercise lifecycle and their own tax treatment, and folding
  them in would make C unshippable.
- **A real price feed, tickers resolving to anything external, or historical backtesting.**
  Design 87 §13 has the observed-data replay overlay for substituting exogenous series; if
  per-security history is ever wanted, that is the seam, not this document.
- **Intraday, or any time granularity below the existing annual return tick.**
- **Bonds.** They are already unitised and design 66 owns their mechanics. C must not
  re-open them, though §5.1 does put their instrument fields behind the same accessor.
- **Company equity and speculative assets** (design 88). §12 D6 explains why they stay
  separate entities and names the one seam where they meet a security.

## 3. What C buys, stated plainly

Worth being explicit, because "equity shares" sounds like a representation change and the
representation is the cheap part.

1. **A position has an identity.** "500 shares of VTI" rather than "\$71,000 of EQUITY_US".
   Everything below follows from that.
2. **Wash sales become expressible** (US §1091) — and, more sharply than the first pass put
   it, the existing harvest lever's substitute rule becomes **checkable instead of asserted**,
   in a model whose own 31-Dec/1-Jan cadence puts a repurchase inside the statutory window
   every year. §8.1.
3. **Dispersion gets an honest home.** Design 90 §7.4 is still open and asks for non-zero
   idiosyncratic vol so sleeves can cross and losses become reachable. A *market* index's
   residual risk is a real thing and belongs on the sleeve; a *single company's* is not the
   same quantity and has nowhere to live today. C gives it one, and the two compose (§6.2).
   **This is the strongest link in the document**: design 90's §4 and §5 loss machinery is
   built, correct and nearly dormant, and concentration is what wakes it up.
4. **Concentration risk becomes modellable.** A plan with 40% in one employer's stock is a
   different plan from one with 40% in a total-market fund, and today they are the same
   object.
5. **Specific-identification lot selection becomes real.** Design 65's
   `consumeHoldings({selection})` seam already exists and already supports lot strategies;
   today "specific ID" can only mean "pick a lot", not "pick a lot of THIS security".
6. **Reporting stops lying by omission.** The allocation cube (`ASSET_CLASS` is report-only)
   can name what is actually held.

**What it does not buy**: better returns modelling *by itself*. A security tracking a market
with β=1 and σ_idio=0 has exactly the return process it has today, by construction (§6.2).
Fidelity improves only where a position genuinely is not the market — which is the point of
making the price path opt-in.

## 4. The `Security` entity

A plain-data record, registered like `collectibles` / `companyEquities` / `realProperties`
already are in `cfg`, and projected into `state.securities` as a plain map keyed by id.

```
Security {
  id                 // 'sec-vti', stable; what Holding.securityId names
  symbol             // 'VTI' — display only, never a lookup key
  name               // 'Vanguard Total Stock Market ETF'
  rateKey            // the market it tracks: EQUITY_US, EQUITY_INTL_EX_US, …
  beta               // loading on that market SLEEVE's deviation (default 1.0) — §6.2
  idioVol            // annualized firm-specific sd; 0 (default) ⇒ NO extra RNG draw
  dividendYield      // instrument-level; today this sits on Holding
  currency           // the currency it trades in
  country            // situs, for source rules (design 73)
  taxExemption       // 'none' | 'state' | 'federal' — a muni fund is a security
  issuingState       // for the design 59 Treasury/muni split
  qualifiedDividends // US: does its distribution qualify for the preferential rate
  frankingCredit     // AU: franking percentage (design 76 / the AU dividend path)
  isGold             // design 91 §8.10 — a bullion ETF is a US collectible and an
                     //   ordinary AU CGT asset; the branch already exists, this is
                     //   where it stops being a per-scenario flag
  identityGroup      // §1091 "substantially identical" — see §8.1; null ⇒ its own group
  // bond instrument fields move here too — see §5.1
  parPerUnit, couponRate, couponFrequency, maturityDate, duration,
  zeroCoupon, inflationLinked
}
```

**Three deliberate absences, each one a decision:**

- **No `assetKind`.** §12 D5 — closed against design 90 §7.3. `ALLOCATION` is the closed,
  authoritative four-value enum the rebalancer, glidepath, drawdown and the reporting cube
  are all built on, and this repo has been bitten twice by a second classifier drifting from
  the first (`residency-and-source`, `collectible-definition`). A security carries a
  `rateKey`; the holding keeps its `allocation`; and registration **validates** the pair
  against the existing containment guard — `CLASS_KEYS_BY_ALLOCATION[allocation]` must admit
  `security.rateKey` (`default-allocations.js:100`). That guard already exists and already
  does exactly this job for `resolveRateKey`. Reusing it means C adds no new classifier.
- **No price.** §12 D4 — closed, and for two independent reasons. (a) A price is per-period
  mutable, so putting it in the registry forfeits the by-reference clone sharing §6.4 needs.
  (b) Two accounts holding the same security legitimately grow at *different* rates today,
  because design 55 §8 seeds per-account `<rateKey>::<stateKey>` growth rates; a shared price
  would silently delete that feature for securitised holdings. That per-account override is
  arguably the thing that becomes a fiction once positions name securities — but resolving
  that is a change to the growth model, not to this representation, and C must not make it by
  accident. **Recorded as follow-up F2, not decided here.**
- **No `id`-as-symbol.** A symbol change is a corporate action (§7); if the symbol were the
  key, a rename would orphan every lot.

### 4.1 Step 2 implementation record  ✅ (2026-08-26)

`src/finance/holdings/security.js` holds the entity, `ScenarioLoader._projectSecurities`
puts the registry in state, `cloneState` keeps it cheap, and
`tests/unit/security-registry.test.mjs` (18 tests) pins the rules. 5,541 unit tests and
1,131 viz tests green; **no golden moved, and no scenario without securities gains a state
key or a serialized field.**

**A `Security` is built, not constructed.** `makeSecurity(spec)` returns a frozen plain
object carrying only the fields the spec actually gave — no `?? default` normalisation
anywhere, which is the opposite of every other `_serialize*` in the repo and is the single
most important decision in the step:

> `instrumentOf` merges `{ ...holding, ...security }`, so any key **present** on a security
> wins, including one holding a defaulted `null`. Writing `couponRate: spec.couponRate ?? null`
> would make every equity security a declaration that its lots pay no coupon — which is a
> different statement from silence, and would land on migrated lots that still carry inline
> fields. So: **absent is silence, an explicit null is a declaration**, and both survive
> serialization. Design 93 §5a's "no existing payload gains a field" discipline, turned into
> the merge rule.

**No second classifier.** `assertAllocationMatch` reuses `CLASS_KEYS_BY_ALLOCATION` —
exported from `default-allocations.js` for this, rather than copied — so the table that stops
role refining *across* classes is the same table that stops a BOND lot naming an equity
security. That is D5 enforced rather than merely decided, and it is why there is no
`assetKind`.

**The registry is projected at LOAD, not at `buildSim`.** `buildSim()` runs before the config
is read, so a registry written into `cfg.initialState` would be looked for at a moment it
does not exist — and would degrade *silently* to Option A rather than throwing. It sits
beside `_applyRandomSeed`, which is there for exactly the same reason, and before the
compile-vs-deserialize fork so it reaches both paths. (`state.people` has had three drifted
projections in this repo; one shared call site is how that stops recurring.)

**Absent means absent.** A scenario with no securities gets **no `state.securities` key** and
**no `securities` field in its serialized form**. An empty `{}` would put a new key in every
whole-state fixture in the repo to say nothing.

**What step 3 inherits.** Nothing about the entity — it is done. The open item is §5.3c's
punch list (three `AccountService` sites and `holding-utils.js` still read without a
registry) plus §9.5c's finding that units have to be established at every lot BIRTH site,
not only at the config→run boundary.

## 5. The instrument / position partition

### 5.1 The table, made concrete

Design 93 §6.2 sketched this for bonds. Extended to equity and made exhaustive:

| stays on `Holding` (the POSITION) | moves to `Security` (the INSTRUMENT) |
|---|---|
| `units`, `pricePerUnit` | `parPerUnit`, `couponRate`, `couponFrequency`, `maturityDate`, `duration` |
| `marketValue`, `faceValue` *(derived)* | `zeroCoupon`, `inflationLinked` |
| `costBasis`, `costBaseByCountry` | `rateKey`, `beta`, `idioVol` |
| `purchaseDate`, `acquisitionDateByCountry` | `dividendYield`, `qualifiedDividends`, `frankingCredit` |
| `acquisitionPriceLevel` | `taxExemption`, `issuingState`, `currency`, `country` |
| `cpiIndexRatio` — see below | `symbol`, `name`, `isGold`, `identityGroup` |
| `securityId`, `id`, `label` | |
| `rollAtMaturity`, `rollTermYears` — see below | |
| `fxBasisRate` (design 87 §988 basis) | |
| `taxLossPartner`, `appreciationSchedule` | |

Two rows design 93 §9 flagged as uncertain, now with an answer and its reasoning:

- **`cpiIndexRatio` is POSITION-level** (design 93's §12.7 handover; §12 D7 here). The
  *indexation ratio of the bond* is an instrument fact — every holder of the same TIPS has
  the same one. But design 93 §5b deliberately made it per-lot so that a TIPS bought seasoned
  carries the ratio it was bought at, and so that a roll can restart it. Under C the honest
  model is that the SECURITY carries a reference index level and the POSITION carries its own
  acquisition level, with the ratio derived — the same shape as `acquisitionPriceLevel` and
  the AU CPI indexation. **That is a change to the §5b representation, it is bond-only, and
  it is therefore explicitly deferred**: C leaves `cpiIndexRatio` on the position and does not
  re-open design 66. Recorded as follow-up F1.
- **`rollAtMaturity` / `rollTermYears` are POSITION-level**, confirming design 93 §9 item 4's
  tentative call. Two holders of the same bond can disagree about whether they roll it; it is
  ladder POLICY attached to a position. The tell is that `BondLadderReducer` sets them from
  its own configuration, not from anything about the instrument.

### 5.2 The seam is built but empty, and that is the real work — now measured

`instrumentOf(h)` exists (`holding-utils.js:73`) and returns the inline fields. **Nothing
calls it** — the only references in the tree are its definition and its re-export from the
generated `index.js`. It was shipped dark in design 93 §5a so that C would change one function
instead of every consumer; the consumers were never converted, so the codebase still reads
`h.couponRate`, `h.maturityDate`, `h.taxExemption`, `h.rateKey` directly.

**The surface, counted** (references to the eleven instrument-level field names, `src` only):

| where | refs | note |
|---|---|---|
| non-UI `src` | **252** across **25 files** | the step-1 scope |
| `src/visualization` | 22 | editors and renderers; a later step |
| of which `rateKey` alone | 98 | the dominant field by 3x |

The top five files are `holding.js` (44 — mostly the constructor and `toJSON`, i.e. *writes*,
not reads), `earnings-handlers.js` (35), `holdings-earnings.js` (31), `holding-utils.js` (30)
and `bond-ladder-reducer.js` (15). So the true read-site count is well under 252, and the
work is concentrated: **five files carry roughly 60% of it.**

**C's first phase is not the `Security` entity. It is converting the consumers to the accessor
while it still returns inline fields** — a pure refactor, provably behaviour-neutral, testable
by a static pass in the shape of the design-93 §4 write gate: *no direct read of an
instrument-level field outside `instrumentOf`*, with an annotated-exception count that cannot
drift (the write gate's `par-reviewed:` device, `holding-value-write-gate.test.mjs:130`).

**Do it at the FINAL signature, not the current one.** `instrumentOf(h)` cannot resolve a
`securityId` without the registry, so under C it becomes `instrumentOf(h, securities)`.
Converting 250 call sites to the one-argument form and then touching them all again is the
audit this seam exists to avoid. Step 1 converts to `instrumentOf(h, state?.securities)` with
the second argument accepted and ignored, so step 2's entity swap really is one function.

Two call sites will not have `state` in hand — inside `holding-utils.js` itself, and in
`holding-actions.js`. Both are position-arithmetic, not instrument reads; if either turns out
to need an instrument field, that is a finding worth stopping on, not a signature to widen.

Doing it in that order also means the refactor can be abandoned or paused without leaving half
a `Security` behind.

### 5.3 Step 1 implementation record  ✅ (2026-08-26)

Every instrument-level read in the engine now goes through `instrumentOf`, and
`tests/unit/instrument-read-gate.test.mjs` is what stops the next one being written
directly. 5,521 unit tests and 1,131 viz tests green; **no golden moved**.

#### 5.3a `instrumentOf` returns the holding itself

The first pass assumed the accessor would build a projection — the version design 93 §5a
shipped returned a fresh ten-field object with its own defaults. It now returns the holding
**unchanged** whenever there is no security to resolve:

```js
export function instrumentOf(h, securities = null) {
  if (!h || h.securityId == null || !securities) return h;
  const sec = securities[h.securityId];
  return sec ? { ...h, ...sec } : h;
}
```

Three reasons, and the first is why step 1 could be done at all:

1. **It makes the conversion provably neutral.** `instrumentOf(h).couponRate` is not merely
   *equivalent* to `h.couponRate` — it is the same property access on the same object. Had
   the accessor supplied its own defaults (`couponFrequency: 2`, `taxExemption: 'none'`),
   every one of ~90 sites would have needed an individual audit for a shifted default, and
   `if (h.taxExemption)` would have silently flipped from falsy to truthy.
2. **It allocates nothing.** `computeHoldingsGrowth` walks every holding of every account on
   every tick; an accessor that minted an object per holding per tick to hand back fields it
   already had would be a permanent tax on the hot path.
3. **The defaults stay at the call sites**, where they already are and where they are
   visible, instead of a second set inside the accessor drifting from them.

⚠️ The merge is `{ ...h, ...sec }` and step 2 has to settle two things about it, both
flagged in the source: an explicit `null` on a security **overrides** the holding (absent and
null are different, and `??` does not save you), and D11's yield chain depends on which of
those a security carrying no yield is.

#### 5.3b What actually moved

The §5.2 estimate was 252 references across 25 files. Counted as **reads off a holding**,
which is what the seam is for, it was ~90 across 18 — the rest are writes (a lot legitimately
carries inline instrument fields under Option A), `this.rateKey` handler config, or map keys
that have nothing to do with holdings. Converted: 23 call sites in 12 files.

Nine functions gained a `securities` parameter so the registry can reach the read:
`indexedRedemptionValue`, `consumeHoldings`, `buildHoldingsComparator`, `buildLotComparator`,
`ladderKey`, `mergeCouponReinvestLots`, `bondPrincipalUnits`, `resolveSubstitute`,
`snapshotHoldings`. Three file-local helpers now take the instrument view instead of the
holding — `yearsToMaturity`, `maturityTs`, `couponFederalExempt` / `couponStateExempt` — which
is the more honest signature anyway: a maturity date and a tax exemption are facts about a
bond, not about anyone's position in it.

**Two things the conversion turned up on its own:**

- `redeem` and `isMatured` in `BondMaturityReducer` need **both** views — `allocation`,
  `rollAtMaturity` and `rollTermYears` are the position's, `maturityDate`, `couponRate` and
  `inflationLinked` are the instrument's — so they take `(h, inst, …)`. The partition runs
  straight through a two-line predicate, which is a good sign the partition is real.
- `HoldingSplitReducer`'s children now inherit the parent's `securityId`. A child of a split
  is a piece of the same instrument, and §11's fourth walk is about not losing what a
  position is in. Inert under Option A. It also tripped the **write gate** by shape — a
  conditional spread beside a `marketValue` — which is the write gate working: the shape is a
  heuristic, this is the case where the heuristic is wrong, and the annotation is how you say
  so. `EXPECTED_ANNOTATED` 21 → 22.

#### 5.3c The punch list step 2 inherits

Three sites read through the seam but cannot pass a registry, because they take an account
**record** rather than state. Under Option A `instrumentOf` is the identity, so they are
correct today; under Option C they would read past the security:

| site | why it has no state |
|---|---|
| `AccountService.registerHolding` (rateKey backfill) | takes an account record |
| `AccountService.findOrCreateHolding` | takes an account record |
| `AccountService.transaction` (par-driven unit price) | takes an account record |

Plus one allowlisted file, and it is the interesting one. **`holding-utils.js` is exempt on
purpose**: `syncHolding` derives par from `parPerUnit`, `split` divides it, `establish` prices
off it and `promoteToUnitised` decides whether a lot is a dated bond at all. Those are the
primitives — the place the position/instrument split has to be *resolved* rather than
consumed. Threading a registry through the four most-called functions in the substrate is a
decision to make once the entity exists, and §9.5c already owns half of it (promotion has to
reach every birth site anyway).

#### 5.3d The gate, and what it can see

It matches on the **receiver name** (`h.couponRate`, `holding.maturityDate`, …), because
whether an arbitrary expression is a holding is undecidable. That makes it a ratchet, not a
proof — the same bargain the write gate strikes by matching one literal object shape. Writes
are invisible to it by construction (`{ couponRate: x }` is not `something.couponRate`), which
is right: only reads have to go through the seam. Assignment targets are excluded explicitly,
so a backfill still reads as the write it is.

**Verified non-vacuous by mutation**, the same control §9.6 used: revert one converted read
to `h.dividendYield` and the gate names the file and line while the goldens, the invariants
and the other 5,520 tests stay green.

## 6. Price paths — the cost, and why it is opt-in

### 6.1 The existing generator, and the constraint it imposes

`EquityReturnTickHandler` fires annually, draws **one** market factor from the seeded
`sim.rng`, and gives each of the four `EQUITY_SLEEVES` a deviation of
`beta·marketDev + σ_idio·√dt·z_sleeve`, plus a separate deterministic `driftComp` of
`((β·σ_market)² + σ_idio²)/2` (design 74 §5.3). One market draw drives everything, so
systematic risk survives portfolio aggregation — design 74 §4 explicitly rejects independent
per-sleeve draws because they diversify away the risk the exercise measures. **That reasoning
applies with more force to securities**: 30 independently-drawn stocks would produce a
portfolio far less volatile than any real one.

The handler carries a warning C must obey:

> ⚠️ **RNG-cursor ordering.** Idiosyncratic draws consume extra uniforms, so enabling them
> shifts every subsequent draw. Sleeves are iterated in the stable sorted `EQUITY_SLEEVES`
> order, and the idio draw is **skipped entirely** when `σ_idio` is 0.

`equity-sleeve-rng-neutrality.test.mjs` pins the skip. C must extend that test, not just
respect it.

### 6.2 The design that follows from it — corrected

The first pass wrote `dev[security] = beta · marketDev[security.rateKey] + idio`, and that is
wrong twice over. There is **one** `marketDev`, not one per rate key; and loading a security
on the raw market factor bypasses its sleeve's own idiosyncratic residual, so a security
"tracking EQUITY_AU" would not move with AU-specific risk. It would also collide head-on with
design 90 §7.4, which is about to give sleeves exactly that residual.

**A security loads on its SLEEVE's total deviation, and stores only its DIFFERENCE from it:**

```
sleeveDev[k]  = β_k·marketDev + σ_idio,k·√dt·z_k                     (unchanged, today's code)

secDev[s]     = (β_s − 1)·sleeveDev[s.rateKey]                        ← the overlay
              + (σ_idio,s > 0 ? σ_idio,s·√dt·z_s : 0)

secComp[s]    = geometric
              ? ((β_s² − 1)·Var(sleeveDev[s.rateKey]) + σ_idio,s²)/2
              : 0
              where Var(sleeveDev[k]) = (β_k·σ_market)² + σ_idio,k²
```

Everything the first pass wanted follows from the `−1`, and so does compatibility with design
90 §7.4:

- **A security with β=1 and σ_idio=0 stores nothing at all**, because both terms are exactly
  zero. Not "a small number"; zero. No RNG draw, no state entry, no growth-path arithmetic.
  That is what makes §9's migration inert and what keeps a plan holding six index funds free.
- **It stays inert when sleeve idio vol is turned on.** The security tracks whatever its
  sleeve does, including design 90 §7.4's dispersion, because it is expressed as a deviation
  *from* the sleeve rather than as an absolute rate. The two features compose instead of
  racing.
- **Cost scales with concentrated positions**, not with securities. A plan with one employer
  stock pays one extra uniform per year.
- **Enabling idio vol on a security re-bases that scenario**, exactly as enabling sleeve idio
  vol already does. Expected, documented, and its own commit with its own re-gold — design 90
  §7.4's advice, inherited verbatim.

**The draw set is the REGISTRY, not the portfolio.** Iterate `state.securities` sorted by
`id`, after the sleeve loop, and draw for every security with `idioVol > 0` **whether or not
any position currently holds it**. Conditioning the cursor on holdings would make the random
path depend on portfolio state, which changes under every MPC rollout, every optimizer probe
and every replay branch — the determinism guarantee would not survive it. The price is that
declaring an unheld security perturbs the run; that is the correct trade and it must be
written down where the registry is authored.

### 6.3 Where the deviation lives — the three-deep precedence question, dissolved

The first pass asked whether `effectiveGrowthRates` should carry per-security entries, and
worried about a three-deep precedence `<securityId>` → `<rateKey>::<stateKey>` → `<rateKey>`.

**Neither. It is an overlay, not a rate**, and the model already has this exact pattern:
property returns do **not** flow through `effectiveGrowthRates` — `AssetAppreciationHandler`
adds `state.propertyReturnDev[<sleeve>]` to the property's resolved rate directly (design 75
§4.2 A2, and the fold reducer that would otherwise be needed does not exist).

So:

- `SecurityReturnReducer` (or `EquityReturnReducer` extended) stores `state.securityReturnDev`
  and `state.securityReturnDriftComp` — sparse maps, entries only for securities with a
  non-zero overlay.
- `computeHoldingsGrowth` adds `securityReturnDev[h.securityId] ?? 0` (plus its comp) to
  `baseRate` — *before* the `appreciationSchedule` lookup, so an authored schedule keeps
  overriding the stochastic path exactly as it overrides the sleeve's today
  (`holdings-earnings.js:184`).
- **`effectiveGrowthRates` keeps its current shape and its current two-deep precedence.** No
  combinatorial `<securityId>::<stateKey>` fan-out, no new precedence table, and design 55
  §8's per-account override goes on working untouched because the overlay is additive and
  orthogonal to it.

That is the whole of §12 D1's growth half. The state half is §6.4, and it costs about 7% of
a workbench run before mitigation and ~0 after.

### 6.4 What the registry costs — measured twice, because once is misleading

Reducers receive `(state, action, date)` and nothing else (`reducers.js:49`), so the registry
has to be in state to be readable. And state is deep-cloned. Design 78 spent a whole document
driving that cost down; **this section exists because C must not quietly give it back.**

#### The per-clone number, which is the wrong one to quote

`scripts/probes/probe-security-registry-clone-cost.mjs`, table 1, on a real 44-year
cross-border plan (state 44,606 JSON bytes, 21 accounts carrying holdings, 37 holdings),
2,000 clones per row, registry entries carrying the full §4 record:

| registry | state bytes | µs/clone | vs baseline |
|---|---|---|---|
| none (today) | — | 51.9 | — |
| 5 securities | +5% | 56.9 | +10% |
| 20 securities | +19% | 71.4 | **+38%** |
| 50 securities | +48% | 101.2 | +95% |

(The synthetic default, whose state is smaller, reads higher: +51% at 20. A bigger state
dilutes the registry's share.)

**+38% on the hot path would be a serious objection.** It is also not what a run pays.

#### The run number, which is

`TELEMETRY_LEVELS` (`simulation.js:119`) is why. Three of the four levels are `silent`, and
silent means **no bus, no clones, no diffs**; only `full` clones per event, and only `full`
and `metrics` take history snapshots. Table 2, same plan, whole runs to 2070, interleaved
A/B, median of 3, 20 securities:

| telemetry | who runs it | without | with | delta |
|---|---|---|---|---|
| `off` | `scripts/` batch tooling, **Monte Carlo** | 649ms | 651ms | **+0.2%** |
| `journal` | ScenarioCompareRunner | 718ms | 715ms | **−0.4%** |
| `metrics` | the optimizer's MPC `rollToSnapshot` | 794ms | 837ms | **+5.4%** |
| `full` | the workbench UI | 4,332ms | 4,645ms | **+7.2%** |

At 50 securities the two clone-bearing levels scale roughly linearly: `metrics` +7.3%,
`full` +18.9%.

**So the honest statement is: a 20-security registry costs the workbench ~7% and the
optimizer ~5%, and costs Monte Carlo and the sweep tooling nothing measurable.** Design 78's
win was moving the batch paths off the clone-per-event path, and that win is untouched — the
registry cannot reach a path that does not clone. The first pass of this document asserted
the opposite ("an MC sweep pays it on every path"); that was inferred from design 78's prose
and is wrong. The measurement is table 2.

#### The decision

**Put the registry in state, and share it by reference when cloning.** Concretely, at step 2:

1. A `cloneState(state)` helper that deep-clones every key **except** `securities`, which it
   carries by reference. Used at the three clone sites — `journal.js:109`,
   `simulation-history.js:34`, `simulation.js:766`. This recovers the whole cost by
   construction: what remains is one property assignment per clone.
2. **Freeze the registry and every record in it at the config→run boundary.** Sharing a
   mutable object across every snapshot in a run is the journal live-alias defect waiting to
   happen — one in-place write and every past snapshot silently changes. Modules are strict,
   so a frozen record turns that write into a loud `TypeError` instead. Freeze is what makes
   the sharing safe *by construction* rather than by convention.
3. A corporate action that adds a security (a spin-off, step 8) **replaces the whole map**.
   That is copy-on-write, which is what `newState` already does one level up, and the old
   snapshots keep pointing at the old map — which is correct: they were taken before the
   spin-off.

**Do it at step 2, not later.** The invariant "nobody mutates the registry in place" is
cheap to establish when the registry is introduced and expensive to retrofit, because
retrofitting means auditing every write site that has appeared in between.

#### It was done, and it works — measured  ✅ (2026-08-26)

Same probe, same plan, same 20 securities, after `cloneState` + freeze landed:

| telemetry | before | after |
|---|---|---|
| `off` | +0.2% | +0.3% |
| `journal` | −0.4% | +1.2% |
| `metrics` | **+5.4%** | **+1.4%** |
| `full` | **+7.2%** | **+0.5%** |

(`metrics` and `full` at 7 reps; the residue is inside run-to-run noise.)

**One thing had to be found by measuring rather than by reasoning.** After converting the
three clone sites the workbench still read +3.9%, not ~0. The remaining cost was
`snapshotForDiff`, which shallow-copies every top-level key for the per-untracked-reducer
diff — and that copy did double damage: it paid for a 20-key spread on every reducer, *and*
it broke `diffStates`' reference-identity fast-path, so the diff then walked all 20
securities comparing identical references. Sharing the same keys there took `full` from
+3.9% to +0.5%. The lesson is small and worth keeping: **a by-reference optimisation is only
as good as the last place that copies the reference**, and the place that copied it was not
one of the three the design named.

**Do not reach for a generic escape.** An `Object.isFrozen` check or a `__shared` marker
inside `deepClone` puts a test on the hot path of every object in state to save one. Name
the one key.

#### Two alternatives, and why not

- **Registry as reducer/handler config rather than state.** Handlers already carry config
  this way — `EquityReturnTickHandler` holds its per-sleeve `beta` and `idioVol` maps on the
  instance and serializes them — and a reducer constructed with the registry would read
  `this.securities[h.securityId]` at zero clone cost and with no `cloneState` special case.
  Rejected for step 2, kept as the fallback: a corporate action cannot add a security to an
  immutable reducer, the state panel and schema registry cannot see it, and `instrumentOf`
  would resolve differently depending on whether its caller is a reducer or a report. The
  clone win is the same as option 1's, and option 1 keeps one uniform place where securities
  live.
- **No registry at all — keep instrument fields inline and let `securityId` be nothing but
  an identity label.** This deserves stating plainly because **most of §3's value comes from
  the identity, not from the shared record**: wash sales (§8.1), specific identification
  (§8.3), concentration (§6.2) and `split()` all need only "these two lots are the same
  thing", which is a string on the holding costing ~30 bytes per lot. The registry buys
  de-duplication and one place to edit an instrument — real, but not what the design is
  *for*. So if the sharing invariant ever proves unsafe, **the fallback is not to abandon C;
  it is to ship C without the registry.** Worth remembering before anyone treats the registry
  as load-bearing.

### 6.5 Step 4 implementation record  ✅ (2026-08-27)

`beta` and `idioVol` stopped being decoration. `EquityReturnTickHandler` applies the §6.2
overlay after the sleeve loop, `EquityReturnStepReducer` stores the sparse pair, and
`computeHoldingsGrowth` adds it to the holding's resolved rate. **5,594 unit tests and
1,131 viz tests green, and NO GOLDEN MOVED — not a cent, not a field.**

#### 6.5a The gate said "own re-gold". There was nothing to re-gold, and that is the result

Step 3's gate was a re-gold *rather than the absence of one*, and §0 was right to insist on
it. Step 4's gate is the opposite, and it is the identity that earns it: β = 1 with
σ_idio = 0 makes **both** terms exactly zero, so a migrated lot takes no draw, gets no map
entry and does no extra arithmetic. Every golden's registry is the four synthetic market
securities and nothing else, so every golden is byte-identical. `git status` after the step
lists three source files and two test files.

That is the claim §6.2 made in advance, checked at the two places it can fail
independently: at the **cursor** (`equity-sleeve-rng-neutrality.test.mjs` — an identity
registry consumes the same uniforms as no registry) and at the **arithmetic**
(`equity-return-paths.test.mjs` — an identity security contributes nothing even when the
overlay map exists and carries other keys).

#### 6.5b Sparse, and emitted as a pair — the stale-entry trap

§6.3 asked for sparse maps. Sparse alone is a bug: a security whose overlay is non-zero in
2031 and zero in 2032 would keep 2031's entry forever if the reducer only wrote keys it was
given. So the handler emits the two fields **as a pair and every tick, once it emits them at
all**, and the reducer replaces both maps whole. An empty map is therefore a positive
statement — *nothing this year* — and the absence of the field is the other statement:
*this scenario has no non-identity security at all*, which is what keeps the state key out of
every fixture in the repo. It is §4.1's "absent is silence, an explicit null is a
declaration", one level up.

#### 6.5c What the tests pin that a unit test cannot see

Three e2e cases, because the chain cfg → registry → draw set → state → growth path is
exactly the chain that unit tests pass over:

| case | what it proves |
|---|---|
| an **unheld** σ_idio > 0 security changes net worth | the draw set really is the registry (§6.2), in a real run |
| an **unheld** β ≠ 1 security does **not** | the control — the case above is about the DRAW, not about an extra registry entry |
| a **held** β = 2 security changes net worth | the overlay reaches `computeHoldingsGrowth`; and since β-only takes no uniform, both runs consume an **identical** RNG stream, so the difference is the growth rate and nothing else |

The middle row is the one worth keeping. Without it the first row passes just as well against
an implementation that re-based the run for any registry change at all.

#### 6.5d Two things step 4 deliberately did not touch

- **`effectiveGrowthRates` kept its shape.** No `<securityId>` entries, no third precedence
  level. The overlay is added to the holding's rate at the point of use, which is design 75
  §4.2 A2's property precedent, and it composes with design 55 §8's per-account seeding
  because addition is orthogonal to a lookup — pinned by its own test so **F2 is not
  answered by accident**.
- **The interest path.** The overlay is an equity return; a bond's coupon is contractual, so
  `useCoupon` skips it.

#### 6.5e What step 5 inherits — all three items are now closed by §9.8

- The overlay is **live but unreachable from any golden**, because no golden authors a
  security with a non-identity β or σ_idio. That is precisely §11's "green means nothing"
  argument, and it is step 5's whole job: a two-security golden holding a concentrated
  position with non-zero idio vol, plus a second position in the *same* security in a
  *different* account.
- That golden is the first fixture whose state will carry `securityReturnDev` /
  `securityReturnDriftComp`, and the first one whose run will be re-based by enabling
  idiosyncratic vol. Its own commit, its own re-gold — the same bargain design 90 §7.4
  strikes for sleeve dispersion.
- The fourth walk (*no reducer may change a position's `securityId`*) is still unbuilt and
  is listed against step 5 in §11.

### 6.6 Where the overlay is READ — the latency rule, found by step 5's golden

§6.3 said `computeHoldingsGrowth` adds `securityReturnDev[h.securityId]` to `baseRate`, and
step 4 built exactly that. It is wrong, and the golden this document asked for in §11 found
it on its first run — before it had a fixture.

**The sleeve deviation and the overlay were on two different clocks.** `EquityReturnStepReducer`
stores the tick's draw immediately, but the sleeve deviation does not reach a single account
until `EquityReturnReducer` folds it onto `effectiveGrowthRates` at the next PERIOD ADVANCE.
That one-boundary latency is what makes a year's rate the same rate for every account in the
run. Reading `securityReturnDev` at the point of use skipped it: the overlay went live the
instant the step reducer stored it.

The consequence is not a small timing wobble, because **earnings events for different
accounts sit either side of the tick on the same date**. In the step-5 golden, on 31 Dec
2032, one 401(k) position and one brokerage position held THE SAME SECURITY and were credited
in the same instant with two different years' draws:

| lot | draw it used | growth applied |
|---|---|---|
| `k401Account.h-401k-equity` | the 2032 tick (+0.120) | **+47.7%** |
| `usStockAccount.h-us-equity` | the 2033 tick (−0.753) | **−41.6%** |

Two positions in one instrument, 89 percentage points apart in one step, with per-account
growth rates 2 points apart. Compounded over eight years the two prices ended a factor of
four apart where the control arm has them 1.17 apart — the whole of which is design 55 §8's
per-account rate, correctly.

**The rule, stated so the next overlay does not repeat it:** *anything a growth path reads
per-period must be published on the same clock as the rate it modifies.* So
`EquityReturnReducer` — the fold, already running at the period boundary — now also
publishes `state.securityReturnOverlay` (`securityId → dev + driftComp`, sparse), and the
growth path reads that. `securityReturnDev` / `securityReturnDriftComp` remain exactly what
the tick drew, mean-0 and unsummed, which is design 74 §5.3's separation preserved.

Design 75 §4.2 A2 is still the right precedent for *not* routing through
`effectiveGrowthRates`; what it could not warn about is latency, because property
appreciation has exactly one consumer and one event, so its two clocks can never disagree.
Equity has eleven earnings handlers.

Two smaller notes worth keeping:

- The fold's `hasDev` early-return had to stop swallowing the pass. A security can carry an
  overlay in a year the sleeves net to zero.
- Absent still means absent: with no non-identity security, `resolveSecurityOverlay` returns
  an empty patch and `newState` hands back the same object. **No existing golden moved when
  this landed** — the only fixture that changed was the new one, which had none yet.

## 7. Corporate actions

`split()` is built. The rest are dated events in the existing event-series machinery, each a
reducer over the affected positions:

| action | effect | notes |
|---|---|---|
| **Split / reverse split** | `split(h, ratio)` on every position | Built, and **wired at step 8** — the primitive existed with nothing to fire it. Value-, basis- and holding-period-neutral (§305(a); s109-55 item 9). |
| **Symbol change / rename** | `security.symbol` only | Why `id` is not the symbol. **Built, step 8** — the one kind that touches no position. |
| **Cash dividend** | already modelled; C makes the rate instrument-level | Touches the qualified/franked classification — §8.2. And see §9.4: the *reinvestment* path needs fixing before equity is unitised at all. |
| **Spin-off** | basis apportioned between parent and new security by relative FMV; the US holding period **carries over** (§1223(1)(B)), the AU one does **not** (§7.1a) | **Built, step 8.** Still the only path that adds a security mid-run, so it is what §6.4's copy-on-write test exists for — and the test now exists. |
| **Merger / acquisition** | cash → disposal; stock-for-stock → carryover basis, no disposal; **boot → §356 vs s124-790, which disagree** | **Built, step 8.** The disagreement is §7.1a item 1, and it is why this is per-country code. |
| **Return of capital** | reduces basis, not income, until basis is exhausted | **Built, step 8.** The one place §301(c) and s104-135 agree. Interacts with `costBaseByCountry`. |

**Priority judgement** (superseded by §7.1b): splits and symbol changes are
cosmetic-but-cheap; spin-offs and mergers carry the tax content and the risk. A first C
release ships with splits only and is honest, provided the doc says so. — Step 8 shipped all
five, because R3 found that two of them are events **nothing else in the engine can
express**, not merely events it expresses imprecisely.

### 7.1 R3 — the mechanics, from the sources  ✅ **R3 DONE** (2026-08-27)

Primary sources fetched for this section and now on disk, cited by path below. §8.1's rule
applies here too: nothing in §7.1 or §7.2 is quoted from memory.

| source | file |
|---|---|
| IRC §301 — distributions of property; (c)(2)-(3) is return of capital | `docs/us-tax/USCODE-2024-title26-subtitleA-chap1-subchapC-partI-subpartA-sec301.txt` |
| IRC §305 — distributions of stock; a split puts nothing in income | `…-subchapC-partI-subpartA-sec305.txt` |
| IRC §307 — basis of stock received in a §305 distribution | `…-subchapC-partI-subpartA-sec307.txt` |
| IRC §354 — stock-for-stock in a reorganization, no gain | `…-subchapC-partIII-subpartB-sec354.txt` |
| IRC §355 — spin-off of a controlled corporation | `…-subchapC-partIII-subpartB-sec355.txt` |
| IRC §356 — boot: gain recognized to the extent of money received | `…-subchapC-partIII-subpartB-sec356.txt` |
| IRC §358 — basis to distributees; (b)(2) is the §355 allocation | `…-subchapC-partIII-subpartB-sec358.txt` |
| IRC §368 — what counts as a reorganization | `…-subchapC-partIII-subpartD-sec368.txt` |
| 26 CFR §1.358-1 — basis to distributees, applied | `docs/us-tax/CFR-26-1.358-1-Basis-To-Distributees.txt` |
| 26 CFR §1.358-2 — allocation among nonrecognition property; (a)(2)(iv) is the spin-off rule | `docs/us-tax/CFR-26-1.358-2-Allocation-Of-Basis-Among-Nonrecognition-Property.txt` |
| 26 CFR §1.301-1 — distributions of money and other property | `docs/us-tax/CFR-26-1.301-1-Distributions-Of-Money-And-Other-Property.txt` |
| IRC §1223(1) — the holding-period tack-on, with (1)(B) reaching §355 | `…-subchapP-partIII-sec1223.txt` (already on disk from R1) |
| ITAA 1997 Div 125 — demerger relief; s125-80 is the roll-over | `docs/au-tax/ITAA-1997/C2026C00324VOL04.txt` (s125-80 at line 9054) |
| ITAA 1997 Subdiv 124-M — scrip for scrip; s124-785 basis, s124-790 partial | same file, lines 6600 / 6640 |
| ITAA 1997 s104-135 — CGT event G1, capital payment for shares | `docs/au-tax/ITAA-1997/C2026C00324VOL03.txt` line 12713 |
| ITAA 1997 s115-30 / s109-55 — when the acquirer is treated as having acquired | same file, lines 21683 / 16400 |

The US material came from govinfo's USCODE-2024 granules and eCFR's renderer, both of which
answer automated fetches; the AU material was already on disk from earlier work. The
"ATO sites 403 every automated fetch" rule still holds for `ato.gov.au` rulings — none was
needed here, because Div 125 and Subdiv 124-M carry their own worked examples.

#### 7.1a What R3 actually settled: **the two countries do not agree**, three times

This is the finding, and it is the reason step 8 is per-country code rather than one
transform with a tax flag. Every one of the three has a worked example in its own statute,
which is what `corporate-actions.test.mjs` asserts against.

**1. Boot in a merger.** §356(a)(1) recognizes gain "in an amount not in excess of the sum
of such money and the fair market value of such other property" — the LESSER of the realized
gain and the boot. s124-790 does something different in kind: there is no roll-over for the
"ineligible part", and the gain is the cash less *the part of the cost base attributable to
it*. The Act's own example (s124-790, Ken: 100 Aim shares, cost base \$2, taken out for one
LBZ share worth \$4 plus \$1 cash each) works to a capital gain of **\$60**. On identical
facts §356 recognizes **\$100**. Neither is an approximation of the other, and picking one
would be wrong in one country every time.

**2. Basis after that merger.** §358(a)(1) SUBSTITUTES: the old basis, decreased by money
received, increased by gain recognized — \$200 − \$100 + \$100 = **\$200**. s124-785(2)-(3)
APPORTIONS by market value: \$200 × (1 − 0.2) = **\$160**. The same share carries two cost
bases, and this is the event that CREATES that split out of a lot that had one.

**3. The holding period of a spun-off interest.** §1223(1) tacks, and §1223(1)(B) removes
any doubt by treating "a distribution to which section 355 … applies" as an exchange for
that purpose. Australia does not tack: Div 125 deems no acquisition time, and s115-30's
table reaches *same-asset* and *replacement-asset* roll-overs only — a demerger is neither.
So a demerged interest's AU 12-month clock starts at the demerger while its US clock does
not. The asymmetry is between the two ACTIONS rather than the two countries: a
scrip-for-scrip merger sits in Division 124, "Replacement-asset roll-overs", so s115-30
item 2 tacks the AU clock there.

Where they DO agree is return of capital, and it is worth saying because it is the only
place they do: §301(c)(2) applies the payment against basis and §301(c)(3)(A) treats only
the excess as gain from a sale or exchange; s104-135(3) reduces the cost base and taxes only
the excess, with Note 1 — "You cannot make a capital loss" — supplying the same floor.

#### 7.1b What R3 says about D8's "and only if §7 goes past splits"

It should, and the reason is not completeness. **Two of these five are not modelled by
anything else in the engine, and one of them is a taxable event the model currently cannot
express at all.** A return of capital is a cash distribution that is not a dividend; the
dividend path books all of it as income. A cash merger is a disposal nobody chose — the
drawdown never sells it, so no existing path produces it. Both change tax in a direction the
plan did not pick, which is precisely the class of thing a planner wants to be able to ask
about.

### 7.2 Step 8 implementation record  ✅ (2026-08-27)

Five kinds, one dated event, one handler, one reducer:
`src/finance/holdings/corporate-action.js` (the position transforms, pure),
`corporate-action-classes.js` (the engine seam), and a `CORPORATE_ACTIONS` toolset.
5,720 unit + 1,131 viz tests green; **no golden moved**, which §7.2d explains.

#### 7.2a Sizes are FRACTIONS, and that is a decision

Every action but `SPLIT` is sized by a fraction of the position's market value rather than a
dollar amount or a share count. Three reasons, in the order they mattered:

- **it is what the two basis rules ASK for.** §1.358-2(a)(2)(iv) allocates "in proportion to
  their fair market values"; s125-80(3) wants a proportion "reasonable having regard to the
  market values". An author transcribing a real spin-off has the percentage in front of them;
- **it is mode-agnostic.** A scalar sleeve and a unitised position take the same input, so
  none of this waits on bonds being securitised (§5.1's F1/F2 stay closed);
- **it cannot mint money by arithmetic.** A dollar amount authored against a position whose
  value has drifted since the scenario was written would.

`unitsPerShare` (spin-off) and `exchangeRatio` (merger) are separate, because a share count
is a term of the deal and has nothing to do with the value ratio.

#### 7.2b The parent is REPRICED, not resized — the bug that would have conserved every dollar

A spin-off reduces what a share is worth; it does not reduce how many shares you hold.
Writing it as `resize` conserves market value, conserves basis, conserves the account
balance and passes every invariant in the repo — while silently cutting the unit count that
§1091's share matching (§8.1j) and step 6's per-security drawdown selection both read. It is
the compiler-path registry defect's shape again: correct money, wrong
structure, no detector. `reprice` + an explicit basis apportionment is the fix, and the test
asserts the count directly rather than the value.

#### 7.2c Two guards caught real design errors, and one of them was a legal one

- **§11's fourth walk** (`security-position-identity.test.mjs`) rejected the first merger,
  which set `securityId` on the surviving lot. The walk's message says a merger "is a
  DISPOSAL AND AN ACQUISITION, not a field write", and the walk is right about the structure
  even though it is wrong about the tax: §354 recognizes no gain, so what actually happens
  is a NEW LOT carrying the old basis and, per §1223(1), the old holding period. The rule
  survives intact and the law is modelled correctly. A guard written for one reason held a
  line that turned out to matter for another.
- **The e2e run caught a wrapper error the unit tests could not.** `sec-emp` is held in a
  brokerage *and* a 401(k), and the first version assessed the return of capital in both.
  Inside a sheltered wrapper the distribution is realised by the WRAPPER; the holder is
  taxed on distribution. Gated on `TAX_ADVANTAGED_ROLES`, the same set the rebalancer uses.
  This is §10.1c's lesson repeating exactly: the arithmetic was right in isolation and the
  wiring was wrong, and only a run through `ScenarioLoader` on a two-account plan showed it.
  **Named gap:** for an AU resident the sheltered gain is an amount derived by the trust
  estate and so assessable under s99B on distribution (design 84 G2). The rebalancer
  accumulates that; this does not. Both want the same accumulator, so it is not re-inlined.

#### 7.2d Nothing moved, because the toolset is inert by construction

`schedules()`, `handlers()` and `reducers()` all return `[]` for a scenario with no
`corporateActions`, which is every scenario in the repo. That is **F5 compliance, not
politeness**: the event queue's comparator is not a total order, so adding any event
re-resolves ties among unrelated events elsewhere — 560 fields across eleven goldens, worst
\$391,453 (§8.1m). A toolset that scheduled unconditionally would have re-golded the repo
for a feature nobody had switched on. Pinned by a test that loads the toolset with no
authored actions and asserts zero events and zero reducers.

The corollary is that this step ships **unmeasured on the reference plan**, and deliberately
so. There is no corporate action to author on it — the plan holds index sleeves, and index
sleeves do not spin off. The materiality question here is not "what does this cost the
reference plan" but "can the model express the event at all", and until step 8 the answer to
the second was no for four of the five.

#### 7.2e What step 8 deliberately did not do

- **No §368 qualification test.** The author asserts the deal is a reorganization by
  authoring a `MERGER`; nothing checks continuity of interest, the active-business
  requirement (§355(b)) or the device test (§355(a)(1)(B)). Those are facts about a
  transaction the model has no other view of, and a half-applied qualification test is worse
  than an honest declaration — it would refuse deals that qualify.
- **No stock dividend.** §305/§307 are on disk and the arithmetic is a `SPLIT` with a basis
  allocation, but §305(b)'s five exceptions turn some of them into §301 distributions, and
  choosing between them needs facts (elective cash, disproportionate distributions) that are
  not in a scenario.
- **No fractional-share cash-in-lieu.** Real spin-offs pay it and it is a small taxable
  disposal. The engine holds fractional units by design (design 93 §5b — the ladder is
  dollar-split), so there is nothing to round away.
- **No AU roll-over CHOICE.** Both Div 125 and Subdiv 124-M are elective — s125-55 and
  s124-780 both say "you can choose". Step 8 always takes the roll-over, which is what a
  taxpayer facing a gain does; the scenario where declining it is better (using up expiring
  capital losses) is expressible only once design 90's losses are reachable.

## 8. What a named security makes reachable — and why this is the expensive half

### 8.1 Wash sales — the rule, from the sources  ✅ **R1 DONE**

Primary sources fetched for this section and now on disk, cited by path below:

| source | file |
|---|---|
| IRC §1091 — loss from wash sales of stock or securities | `docs/us-tax/USCODE-2024-title26-subtitleA-chap1-subchapO-partVII-sec1091.txt` |
| 26 CFR §1.1091-1 — the 61-day period, ordering and matching rules | `docs/us-tax/CFR-26-1.1091-1-Wash-Sales.txt` |
| 26 CFR §1.1091-2 — basis of replacement stock, worked | `docs/us-tax/CFR-26-1.1091-2-Basis-Of-Wash-Sale-Stock.txt` |
| IRC §1223(3) — holding-period tack-on | `docs/us-tax/USCODE-2024-title26-subtitleA-chap1-subchapP-partIII-sec1223.txt` |
| Rev. Rul. 2008-5 — the IRA case | `docs/us-tax/IRS-Rev-Rul-2008-5-IRA-Wash-Sales.txt` |
| Pub. 550 (2025) ch. 4 — "substantially identical", the trigger list | `docs/us-tax/IRS-Pub-550-Investment-Income-and-Expenses-2025.txt` |
| ATO TR 2008/1 — the Commissioner's ruling on Part IVA and 'wash sale' arrangements | `docs/au-tax/ATO-TR-2008-1-Wash-Sale-Part-IVA.txt` |
| ATO TA 2008/7 — the Taxpayer Alert TR 2008/1 sits behind | `docs/au-tax/ATO-TA-2008-7-Wash-Sale-Part-IVA.txt` |
| ITAA 1936 Part IVA — ss 177A, 177D, 177F | `docs/au-tax/ITAA-1936/C2026C00333VOL03.txt` (s177A at line 12244, s177D at 13018) |

#### 8.1a What the model does today, and why it is worse than "unmodelled"

`resolveSubstitute` (`substitute-holding.js:27`) picks the harvest's replacement in two
steps: an explicit `taxLossPartner` if authored, **otherwise the first other holding in the
account with the same `rateKey`**. Its docstring calls that "economically similar but
legally distinct". Design 90 §1.3, looking at the same code, calls selling a sleeve and
rebuying the same sleeve "a wash sale wearing a disguise".

The second reading is the right one, and there is a worse problem beside it. **The engine's
own cadence puts a repurchase inside the window every single year, whether the harvester
asks for one or not:**

- `TAX_LOSS_HARVEST` is an EventSeries at `interval: 'year-end'`
  (`economic-regimes-toolset.js:912`), and `year-end` resolves to **31 December**
  (`date-utils.js:41`).
- Every rebalancer reduces on `US_PERIOD_ADVANCE` / `AU_PERIOD_ADVANCE`
  (`rebalance-to-target-reducer.js:262`, `opportunistic-rebalance-reducer.js:42`), and
  `PERIOD_ADVANCE_US` is dated **1 January**.

So the harvest sells on 31 December and the rebalancer buys the day after — one day inside
a 61-day window, in every year the strategy is enabled. The model does not merely omit
§1091; **its default configuration constructs the fact pattern §1091 disallows, annually.**

#### 8.1b The United States rule, mechanically

| element | rule | source |
|---|---|---|
| **Trigger** | A loss on a sale of stock or securities is disallowed if, within 30 days **before or after** the sale, the taxpayer acquired — by purchase, by a fully taxable exchange, or by contract or option — *substantially identical* stock or securities. | §1091(a) |
| **Window** | The regulation names it "the **61-day period**": 30 before + the sale day + 30 after. | §1.1091-1(a) |
| **Disallowed ≠ destroyed** | The disallowed loss moves into the replacement's basis: basis of the new = basis of the old **± (price the new was acquired at − price the old was sold at)**. §1.1091-2's two examples work both signs. | §1091(d), §1.1091-2 |
| **Holding period** | The replacement's holding period **includes** the period the sold lot was held. A wash sale cannot convert long-term into short-term. | §1223(3) |
| **Partial match** | When the amounts differ, acquisitions are matched against disposals **in acquisition order, earliest first**, and only the matched share of the loss is disallowed. §1.1091-1(h) Example 2 works it: 100 sold, 75 substantially identical bought inside the window ⇒ the loss on 75 shares is disallowed and the loss on 25 is allowed. | §1091(b)–(c), §1.1091-1(c)–(d), (h) |
| **Ordering across losses** | Multiple losses in a year are processed in **disposal order, earliest first**; same-day ties break by original acquisition order (FIFO). | §1.1091-1(b) |
| **No double-counting** | An acquisition that has already disallowed one loss is **disregarded** when testing another. | §1.1091-1(e) |
| **Across accounts, including IRAs** | Buying substantially identical stock inside the taxpayer's own IRA or Roth IRA within the window disallows the loss — the "different taxpayer" argument fails because command over the property never left. | Rev. Rul. 2008-5; Pub. 550 ch. 4 trigger #4 |
| **…and the IRA case is worse than a deferral** | Rev. Rul. 2008-5's holding, verbatim: *"The loss on the Sale of stock is disallowed under § 1091. A's basis in the individual retirement account or Roth IRA **is not increased** by virtue of § 1091(d)."* | Rev. Rul. 2008-5, HOLDING |

**The window is computable here**, unlike §8.2's qualified-dividend test. Lots carry
`purchaseDate` and disposals carry a date, so a ±30-day test against a declared identity
group is arithmetic the engine can do — the reason §8.2 is decided the other way is that
it needs ex-dividend dates, which the model does not have at all.

**And the IRA row is the one with money in it.** An ordinary wash sale defers a loss; a wash
into a sheltered account **destroys** it. A model that treats every wash sale as a deferral
would understate the cost of the exact cross-account harvesting a US/AU plan with an IRA,
a Roth and a brokerage is most likely to run.

#### 8.1c What the sources do NOT say — and why `identityGroup` is the right shape

Pub. 550 defines "substantially identical" as a facts-and-circumstances test and gives only
these anchors: *"Ordinarily, stocks or securities of one corporation are not considered
substantially identical to stocks or securities of another corporation"*; bonds and
preferred stock are not ordinarily identical to the same issuer's common **unless**
convertible and closely tracking; a reorganization's predecessor and successor securities
may be identical.

**There is nothing in any of these sources on two different funds tracking the same index**
— which is exactly the case the model's own substitute rule generates, and the case a real
harvester lives in. Saying more than that would mean quoting something not on disk, which
this repo does not do. What can be said from the sources: the test is facts and
circumstances, the statute supplies no mechanical rule, and the one anchor Pub. 550 gives
(different issuers are *ordinarily* not identical) does not reach two funds holding the
same basket.

So the identity relation **cannot be derived** — not from `rateKey`, not from `allocation`,
not from anything the engine holds. It has to be **declared**, which is what §4's
`identityGroup` is: default it to the security's own id, and let an author say that two
share classes, or two S&P trackers, are one group. A declared relation is honest about
being an assumption; deriving it from `rateKey` is the same assumption, unlabelled and
already wrong.

#### 8.1d Australia — no §1091, and the consequence is different in kind

Australia has no wash-sale provision. The ATO reaches the same arrangements through the
**general anti-avoidance rule**, and TR 2008/1 is the Commissioner's public ruling on
exactly this (TA 2008/7 is its Taxpayer Alert). The difference from §1091 is structural,
not cosmetic.

- **The arrangement in scope.** TR 2008/1 ¶4(a): *"the taxpayer disposes of, or deals with,
  the asset and at the same time, or within a short period after, acquires the same or
  substantially the same asset"*. No trust, no associate, no artifice is required — a plain
  market sell-and-rebuy is the first listed case, and the ruling's Example 2 is exactly that
  (a broker sale, repurchased the next day).
- **The tax benefit.** ¶11: the counterfactual is that the taxpayer *would not have disposed
  of the asset at all*, so the capital loss is a tax benefit under s177C(1)(ba). The
  objective feature that establishes it is *"there is otherwise no significant change in the
  taxpayer's economic exposure to, or interest in, the asset."*
- **The test.** s177D(2)'s eight matters — manner, form and substance, timing and duration,
  the result under the Act, the taxpayer's financial position, a connected person's, any
  other consequence, the nature of any connection — weighed for **dominant purpose**.
  ¶13 turns them into observations, two of which the engine walks straight into:
  - ¶13(b) form and substance: *"the taxpayer is left in materially the same economic
    position with respect to the asset as they were in prior to the scheme"*;
  - ¶13(c) timing: *"The period over which the scheme is carried out is short, and the time
    at which the scheme was entered into is **proximate to the derivation of a capital gain
    … or the end of the income year**."*
- **The consequence.** ¶14: the Commissioner exercises s177F(1) to cancel the benefit and
  determine that **"the whole or part of the capital loss … was not incurred by the taxpayer
  during the income year."** There is no basis uplift and no holding-period tack-on. Where
  the US **defers** the loss into the replacement lot, Australia **cancels** it — in whole or
  in part. (¶17 allows a s177F(3) compensating adjustment; out of scope.)

Four things follow for the model.

1. **There is no window to implement.** The AU test is purpose, not timing; a 61-day rule
   would be a fabrication. What ¶13(c) does say is that a *year-end* disposal proximate to a
   realised gain is an indicator — and the model's `TAX_LOSS_HARVEST` fires at year-end by
   construction, and harvests against gains by design. The engine builds the AU indicator for
   the same reason it builds the US window (§8.1a).
2. **The AU branch needs none of §1091(d)'s basis machinery** — no replacement-lot basis
   adjustment, no §1223 tack-on. It is a cancellation, and "whole or part" means the amount
   is a policy input.
3. **A purpose test is not computable from state.** The only honest AU model is a **declared
   policy switch** — "treat a harvest-and-rebuy within N days as a Part IVA cancellation" —
   with its arbitrariness stated where the user sets it. That is a defensible model of an
   anti-avoidance rule; a computed one would not be.
4. **The two jurisdictions cannot share one implementation.** US: disallow, then move the
   loss into the replacement's basis and tack the holding period. AU: cancel, and nothing
   moves. A shared "wash sale" flag that only suppresses the loss would be right for AU and
   wrong for the US, in the direction that overstates lifetime tax.

#### 8.1e What R1 settled, and what it did not

**Settled.** Every rule in §8.1b and §8.1d is quoted from a file in `docs/`. Nine sources,
both jurisdictions, including the ruling — TR 2008/1 — that TA 2008/7 defers to for the ATO
view and its worked examples. `ato.gov.au` and AustLII both 403 automated fetches (as
`docs/au-tax/ato-forms/SOURCES.md` already records), so it arrived by hand; provenance is in
`docs/au-tax/SOURCES.md`.

**Not settled, and deliberately not:**

- **"Substantially identical" for index funds** — §8.1c. No source addresses it, so the model
  declares it (`identityGroup`) rather than deriving it.
- **The AU cancellation fraction.** TR 2008/1 ¶14 says "the whole or part" without a rule for
  choosing. A policy input, and §8.1d item 3 says to label it as one.
- **s177F(3) compensating adjustments** (TR 2008/1 ¶17). Out of scope.
- **Materiality — R2.** How much loss the disallowance actually reaches, and how much of it
  lands in a sheltered account where Rev. Rul. 2008-5 destroys rather than defers it. That is
  a measurement, not a reading, and it is only meaningful once dispersion exists.

#### 8.1f R2 — the materiality, MEASURED  ✅ (2026-08-27)

`scripts/probes/probe-wash-sale-materiality.mjs`, 25 seeds x 3 arms, 2026–2050, TLH and
TARGET_ALLOCATION both on. §12 said R2 was "meaningful only after dispersion exists" — that
precondition is met, though **not by design 90 §7.4, which is still unbuilt**. It was met by
step 4: a security with idiosyncratic vol can fall in a year its market rose, which is the
first thing in this engine that can put ONE position under water while the book is fine. The
`concentrated` arm below realises **twice** the loss of the `base` arm, which is that
mechanism showing up as money.

| | base | concentrated | concentrated, uncapped |
|---|---|---|---|
| paths realising any loss | 25/25 | 25/25 | 25/25 |
| loss events per path | 2.5 | 4.6 | **1.0** |
| harvests SKIPPED, no substitute | 2.8/path | 2.6/path | **4.0/path** |
| realised loss per path | \$6,461 | \$12,836 | \$8,300 |
| **inside a 61-day window** | **100%** | **100%** | **100%** |
| … matched in a SHELTERED wrapper (loose) | 48.1% | 51.8% | 0% |
| … matched in a SHELTERED wrapper (strict) | 48.1% | 40.7% | 0% |
| permanent cost at 23.8% | \$740/path | \$1,243–1,582/path | \$0 |
| as a share of lifetime US tax | 0.3% | 0.4–0.5% | 0% |

Two identity relations are measured because §8.1c is explicit that the relation cannot be
derived and must be declared: **STRICT** = same `securityId`, **LOOSE** = same `rateKey`,
which is what `resolveSubstitute` uses today. They bracket the answer; nothing in the sources
picks between them. The sheltered share is an **upper bound** — the probe does not do
§1.1091-1(h)'s share-for-share partial match, so it counts a loss as fully washed when any
qualifying purchase falls in the window.

**Four findings, in descending order of how much they change the plan.**

**1. §8.1a's structural claim is confirmed, at 100%.** Every realised loss, in every arm, in
every one of 75 runs, has a substantially-identical purchase inside the 61-day window. Not
"often" — always. The 31-Dec harvest and the 1-Jan rebalance guarantee it, and so does the
harvester's own same-day rebuy. The model does construct the fact pattern §1091 disallows,
every single time it realises a loss at all.

**2. And it is worth about \$740–\$1,582 over a lifetime — 0.3–0.5% of US tax paid.** That
is the answer to the question R2 was asked. Roughly half the loss is matched inside a
sheltered wrapper, where Rev. Rul. 2008-5 destroys it rather than deferring it, and that half
is the only PERMANENT money in the exercise; the taxable half is timing.

**3. The number is small for reasons that are ARTEFACTS, not economics.** Two of them, and
both bound the loss harder than the market does:

- `taxLossHarvestCap` defaults to **\$3,000/yr and caps the HARVEST**, not the deduction
  against ordinary income that the \$3,000 figure actually comes from. Every capped arm's
  totals are multiples of 3,000, which is the tell.
- `resolveSubstitute` **switches the harvester off**: 2.6–4.0 skipped harvests per path,
  each one a `console.warn` nobody reads. Once an account no longer holds two lots with the
  same `rateKey` there is no substitute, and the strategy silently declines. The `uncapped`
  arm is the clean demonstration — remove the cap and the first harvest consumes the whole
  underwater lot, after which **every later harvest is skipped for the rest of the run**:
  one loss event per path, seed-independent, because it happens in 2027 before the
  stochastic path has diverged.

So the honest reading is not "wash sales don't matter". It is **"this harvester cannot
realise enough loss for wash sales to matter"**, and the two reasons are both fixable in a
fraction of step 7's size.

**4. Under the STRICT relation, every wash is a sheltered one.** In the concentrated arm,
strict-matched loss and strict-matched-AND-sheltered loss are the same number — 40.7%. The
taxable substitute the harvester picks is genuinely a different security, so under a declared
identity the disguise WORKS for the case that would only be deferred, and FAILS for the case
that is destroyed. §1091(d)'s basis machinery — the expensive half of step 7 — is exactly the
half those runs never need.

In the `base` arm strict and loose are identical at every row, and that is worth stating on
its own: **with no authored security, every equity lot names the synthetic for its market, so
the two relations are the same relation.** Option A cannot tell them apart at all. The bracket
only opens once a scenario declares a security, which is Option C's contribution to the
question.

#### 8.1g What R2 decides about step 7

**Split it.** The gate R2 was asked to open does not open for step 7 as scoped:

- **7a — the sheltered wash (SMALL, and it is where all the permanent money is).** Rev. Rul.
  2008-5 needs *no* §1091(d) machinery: disallow the loss and **do not** increase the
  replacement's basis. It is a disallow-and-drop, it is the entire \$740–\$1,582, and by
  finding 4 it is the only branch a declared-identity model reaches in these runs.
- **7b — full §1091 (LARGE, and it buys timing).** Basis transfer, §1223(3) tack-on,
  §1.1091-1(h) partial matching, disposal-order processing, the no-double-counting rule.
  Everything R1 documented, worth the deferral value of ~half the loss.
- **Before either: the harvester's own two artefacts (finding 3).** They bound the measured
  exposure more tightly than §1091 does, and fixing them changes the number this measurement
  produces. Building 7b on top of a strategy that can realise at most \$3,000 a year, and
  that turns itself off, is fitting a large rule to a small artificial number.

**Recommendation: do 7a and the finding-3 fixes; hold 7b until the number moves.** R2 is
CLOSED either way — it was asked to decide whether step 7 is worth its size, and the answer
is "a tenth of it is, and the rest is waiting on something else".

#### 8.1h Step 7a part 1 — the harvester, fixed  ✅ (2026-08-27)

R2 found the exposure small and named two artefacts as the reason. Fixing them **triples the
measured exposure**, which is the finding: R2 was measuring a strategy that could barely act.

**Three changes, and they only work together.**

**1. `taxLossHarvestCap` no longer defaults to \$3,000.** That figure is §1211(b)'s limit on
capital loss deductible against ORDINARY income, and the return already applies it — with the
§1212(b) carryforward for the remainder — in `_computeCapitalLossLimitation`
(`us-tax-rates-base.js`). Capping the HARVEST at the same number limited the same loss twice,
in the wrong place, and meant the strategy could never build the carryforward that is most of
what it is for. The param survives as an optional POLICY cap.

**2. A skipped harvest is recorded** (`tlh_skipped_no_substitute`), not left in a
`console.warn`. R2 measured 2.6–4.0 skips per lifetime path. A strategy that declines to act
must not look like one that had nothing to do.

**3. The substitute may be a SECURITY the account does not hold yet.** This is the one that
mattered, and it is the one only Option C could supply.

**The interaction is the whole story, and removing the cap ALONE makes things worse.** An
uncapped harvest consumes the entire underwater lot; the sleeve is then a single lot; a single
lot has no partner under `resolveSubstitute`; and **every harvest for the next twenty years is
skipped**. Measured: uncapping alone took realised loss per path DOWN from \$12,836 to
\$8,300 and skips UP from 2.6 to 4.0. The \$3,000 cap had been propping the harvester up by
never letting it finish a sale.

A real harvester rotates between two funds — sell A, buy B; next year sell B and buy A. The
model could not express "buy A again", because a substitute had to be a lot that already
existed and A was no longer one. It can now: a lot is a position in a security, and the
registry still lists A. `resolveSubstituteSecurity` picks a security in the same market and a
different §1091 identity group, and `StockHarvestApplyReducer` opens a fresh position in it.

**Identity is declared, and defaults to the security's own id** (`identityGroupOf`,
§8.1c). An un-securitised lot has NO identity and matches nothing — not "its rate key",
because deriving the relation from `rateKey` is the assumption §8.1c refuses, and it is
exactly the assumption the old substitute rule was making silently.

##### What it measured

Same probe, same 25 seeds, 2026–2050.

| arm | loss events/path | skips/path | realised loss/path | washed into a shelter (loose) | permanent cost at 23.8% |
|---|---|---|---|---|---|
| base (no authored security) | 1.0 | 3.8 | \$8,300 | 0% | \$0 |
| concentrated | **2.2** | **0.5** | **\$31,252** | 72.5% | **\$2,607–5,391** |
| concentrated, capped at \$3k (the old default) | 6.7 | 0.2 | \$18,920 | 55.1% | \$1,503–2,481 |
| concentrated + a declared-distinct substitute | 2.3 | 0.2 | \$21,273 | 54.0% | \$868–2,734 |

Four things to read off it:

1. **The harvester works now.** Skips 4.0 → 0.5; realised loss \$8,300 → \$31,252, which is
   2.4x what the old \$3,000-capped default managed.
2. **And so §8.1f's verdict is overturned by 7a itself.** The permanent exposure rises from
   \$1,243–1,582 to **\$2,607–5,391 per path — roughly 0.9–1.8% of lifetime US tax.** A
   working harvester washes more, because every harvest it performs is one the 1-January
   sheltered rebalance can match.
3. **Declaring a distinct substitute halves the strict exposure** (35.0% → 17.1%). Avoiding
   the wash is cheaper than pricing it, and it is a scenario-authoring act, not a code one.
4. **The base arm still skips 3.8 times per path**, and that is correct rather than a
   remaining defect: with no authored security every EQUITY_US lot is in one identity group,
   so there is genuinely nothing distinct to rotate into. An un-securitised book cannot
   harvest repeatedly, and now says so out loud instead of warning to a console.

##### What part 2 — the disallowance itself — is waiting on

The remaining half of 7a is Rev. Rul. 2008-5's disallow-and-drop, and it is now worth more
than R2 priced it at. It is **not blocked, but it forks on one decision that is not the
model's to make quietly:**

> **The US settle fires on 31 December — the same day as the harvest.** §1091's window for a
> 31-Dec sale does not close until 30 January, so the return is lodged BEFORE the sale's own
> wash window has closed. A real taxpayer files in April, when it has.

So the disallowance can be:

- **(a) lagged.** Keep the settle where it is, hold the loss in a pending ledger, and resolve
  it against the **capital-loss carryforward** at the next settle. Contained, no fixture moves,
  and the timing error is small because the destroyed loss mostly lives in the carryforward
  anyway — but the return for the year of sale is knowingly wrong for a year.
- **(b) move the US settle to April.** Structurally right, matches the real filing date, and
  makes the window arithmetic honest — but it re-golds every fixture in the repo and touches
  the FTC/FITO cross-border timing the settle feeds (design 83 G5's `usTaxPaidOnUsSourceAud`
  is consumed a fiscal year later).

That fork, and not the §1091 arithmetic, is part 2's real cost.

#### 8.1i Step 7a part 2 — the sheltered wash, built  ✅ (2026-08-27)

`src/finance/tax/us/wash-sale-reducer.js`. **5,660 unit tests and 1,131 viz tests green; no
golden moved** — no golden runs the harvester, and a scenario that never harvests gains no
state key.

**It implements one of §1091's two consequences, on purpose.** The ordinary wash — replacement
bought in a TAXABLE account — disallows the loss and moves it into the replacement's basis
(§1091(d)) with the holding period tacked on (§1223(3)). That is timing, it is the expensive
half, and R2 held it as 7b. The IRA case has no §1091(d) half at all — Rev. Rul. 2008-5's
holding is that basis "**is not increased**" — so this is a subtraction, which is exactly why
it is the small half with all the permanent money in it.

##### Three decisions, each with a reason that is not convenience

**1. IRA and Roth IRA only. A 401(k) is deliberately excluded.** Rev. Rul. 2008-5 and Pub. 550
ch. 4 trigger #4 name those two. The same "command over the property never left" reasoning
would plainly reach a 401(k) — and that is precisely why it is not extended: this repo does
not quote tax law it has not fetched. It is a deliberate UNDER-disallowance, and it is most of
why the modelled number is far below §8.1f's ±30-day upper bound: **the reference plan's
sheltered equity lives in a 401(k), not an IRA**, so a scan that counts every wrapper measures
an exposure the sources on disk cannot reach.

**2. §1091(b) matches SHARES, not dollars.** §1.1091-1(h) Example 2 works it: 100 sold, 75
substantially identical bought inside the window, and the loss on 75 is disallowed. So the
disallowed fraction is `matchedUnits / unitsSold` — which is what the unit counts design 93
put on every equity position are for. Identity is the DECLARED group (§8.1c), never the rate
key.

**3. The pending entry is written by `StockHarvestApplyReducer`, not by the tax payload.**
That reducer is the only place that knows all four facts at once: the loss, its character, the
units that left, and WHAT they were units of. `STOCK_WITHDRAWAL_TAX` carries the money but not
the instrument, and teaching a payload five emitters share to carry an instrument is a
manifest change this step does not need. **A disposal payload that cannot say what was
disposed of is the thing that made §1091 look expensive**, and routing around it is what made
7a.2 small.

##### The lag, and the line that stops it being cosmetic

The user's choice at §8.1h's fork was (a): keep the 31-December settle and resolve against the
carryforward. Built that way, and then measured — which surfaced a weakness the fork
description did not predict:

> **93% of the disallowance meets an EMPTY carryforward.** A harvested loss is spent against
> the year's gains long before the wash is identified a year later, so there is nothing left
> in the §1212(b) pool to take back.

Stopping at the clamp would have left a rule that fires, records, and collects almost nothing.
So what the carryforward cannot absorb is **recovered as gain on the following return**. It is
an approximation, stated as one: §1091 disallows the loss on the return for the year of sale,
and this adds it back a year later, which is what an amended return does in substance. It is
the lag's cost, made visible rather than absorbed.

##### What it measures

| arm | modelled disallowance | of which recovered as gain |
|---|---|---|
| base (no authored security) | \$0/path | — |
| concentrated | \$51/path | \$0 |
| concentrated, capped at \$3k (the old default) | \$611/path | \$611 |
| concentrated + a declared-distinct substitute | \$688/path | \$47 |
| **concentrated + the SAME security in an IRA** | **\$1,118/path** | \$1,039 |

The last row is Rev. Rul. 2008-5's actual fact pattern and the only one where the rule has
much to bite on; the others are small for the reason decision 1 gives. The honest summary is
that **the model now prices the wash it can source, and the gap to §8.1f's \$2,607–5,391
upper bound is almost entirely the 401(k)** — which is a research question (is there an
authority extending the ruling?), not a modelling one.

##### What 7b inherits

- The taxable-replacement wash is still unmodelled, so a harvest into a same-group lot in a
  taxable account keeps its loss in full. That is the direction that **understates** lifetime
  tax, and §8.1b said so before it was measured.
- The pending ledger, the identity relation and the share-matching arithmetic are all built
  and are what 7b needs; what 7b adds is §1091(d)'s basis transfer and §1223(3)'s tack-on,
  which are position writes rather than a subtraction.
- A purchase that ADDS to a seasoned IRA lot keeps that lot's original `purchaseDate`, so it
  is not seen as a replacement. Under-matching, in the same direction as the 401(k)
  exclusion, and recorded here rather than papered over.

#### 8.1j Step 7b — full §1091 on the taxable branch  ✅ (2026-08-27)

The half R2 held. **5,670 unit tests and 1,131 viz tests green; no golden moved.**

##### Where it lives, and why that made it small

R2 priced 7b as large because it assumed the wash had to be *found* — a window scan, a ledger,
a replacement lot located a year later and written back to. That is true of the sheltered case
(§8.1i) and it is **not** true of the dominant one:

> **The harvester sells and rebuys in one action, in one account, on one day.** Both lots are
> in hand at the instant the wash happens, so §1091 needs no ledger, no scan and no lag —
> it is arithmetic in `StockHarvestApplyReducer`, where the disposal already is.

And it is the dominant case by construction: in an un-securitised book every equity lot names
the synthetic security for its market, so `resolveSubstitute` falls through to an identical
partner and **every** harvest lands here.

##### All three consequences, unlike the IRA branch

| | rule | what the code does |
|---|---|---|
| §1091(a) | the matched share of the loss is disallowed | nets it out of `gain` / `usShortTermGain` / `usLongTermGain` before they reach the return |
| §1091(d) | it is **not** destroyed — it moves into the replacement's basis | `costBasis += disallowed` on the replacement lot |
| §1223(3) | the replacement's holding period **includes** the sold lot's | a lot BORN here inherits `purchaseDate`; an existing lot keeps its own |
| §1091(b) | shares, not dollars (§1.1091-1(h) Ex. 2) | `min(1, replacementUnits / unitsSold)` |
| §1.1091-1(e) | shares that disallowed one loss are disregarded for another | the matched units and dollars are removed from the §8.1i pending entry |

**§1223(3) is applied only to a lot born in the harvest.** An existing substitute already
carries its own, older holding period covering shares that were never sold; moving its
acquisition date would tack the sold lot's period onto them too. That asymmetry is the kind of
thing that conserves every total and is invisible to any aggregate test, so it has its own.

**Australia is deliberately untouched.** There is no §1091 there; TR 2008/1's answer is a Part
IVA *cancellation* — a different mechanism with a different consequence (§8.1d) — so `auGain`
and the AU term fields still carry the full loss. Pinned by its own test, because stamping the
US rule on the AU figure would pass every total-based check in the repo.

**The disallowance is stated on the payload** (`washDisallowed` on `STOCK_WITHDRAWAL_TAX`,
declared in the manifest) rather than silently netted. A tax adjustment that cannot be drilled
from the journal is the shape this repo has been bitten by more than once.

##### What it measures — and the headline is a zero

Same probe, same 25 seeds:

| arm | disallowed on the spot (§8.1j) | disallowed lagged (§8.1i) | **loss reaching the return** |
|---|---|---|---|
| base — no authored security | **\$8,300/path** | \$0 | **\$0/path** |
| concentrated | \$0 | \$51 | \$31,252/path |
| concentrated, capped at \$3k | \$0 | \$611 | \$18,920/path |
| concentrated + a declared-distinct substitute | \$0 | \$688 | \$21,273/path |
| concentrated + the SAME security in an IRA | \$0 | \$1,118 | \$31,252/path |

Two readings, and both are the point of the whole step:

**1. For an un-securitised book, tax-loss harvesting is now worth exactly nothing** — 100% of
what it realises is disallowed. That is not a bug and it is not pessimism: every substitute
such a book can offer is the same market synthetic, which is substantially identical, and
§1091 disallows the whole loss. The model used to book \$8,300 a lifetime of benefit the
taxpayer would never receive.

**2. Where a distinct security IS declared, the immediate disallowance is zero.** 7a.1 and 7b
compose exactly as they should: **avoiding the wash and pricing it are the same mechanism read
in two directions.** A plan that names two genuinely different funds harvests legally and keeps
its loss; a plan that names one thing twice keeps nothing. The only residue is the IRA case,
which no substitute choice can avoid because the rebalancer, not the harvester, does the
buying.

##### What is still not modelled

- **A taxable replacement bought ELSEWHERE inside the window** — the 1-January rebalance into
  the brokerage, rather than the harvester's own rebuy. It needs the lagged machinery §8.1i
  built, plus a replacement lot located a year later to write basis onto, and the lot may have
  been sold or compacted by then. Left out, and it is the one remaining §1091 gap.
  **⚠ "The one remaining gap" was wrong — see §8.1n.** This paragraph reasons about the
  harvester as the only SELLER; the rebalancer realizes taxable losses too and writes no pending
  entry at all, which reaches the SHELTERED branch (permanent) and not merely this taxable one.
- **AU Part IVA** (§8.1d) — a declared policy switch, not a computed rule, and it needs
  TR 2008/1 read rather than cited.
- The §8.1i under-matches noted there (401(k), additions to seasoned lots) are unchanged.

#### 8.1k Revisiting §8.1h's fork — the third option neither side offered  📋 (2026-08-27)

The fork was put as "keep the 31-December settle and lag the correction" (a) vs "move the US
settle to April" (b), and (a) was chosen. **The fork was badly framed: both options assumed the
settle and the FILING are one event.** They are not, and separating them is a third option that
is strictly better than either.

##### What (a) actually cost, now that it is built and measured

| | cost |
|---|---|
| **The return is knowingly wrong** | The 2032 return reports a loss §1091 disallows. Anyone drilling the tax report sees an incorrect return — a fidelity cost, not a rounding one, and the one that does not show up in any total. |
| **93% cannot reach the carryforward** | The loss was spent against the year's gains before the wash was identified, so the §1212(b) pool is empty and the disallowance has nothing to claw back (§8.1i). |
| **…so it needed a second mechanism** | The unabsorbed part is recovered as GAIN on the following return — an amended return approximated, and a SECOND year of lag on top of the first. |
| **…and the second mechanism had its own bug** | It initially recovered the whole amount into `usCapitalGainsYTD`, which is the LONG-term bucket, so a disallowed SHORT-term loss would have been taxed at the preferential rate. A §1222 character error hiding inside a §1091 fix, found and fixed at §8.1k. |

The last row is the tell. The lag did not just cost accuracy; it forced a workaround, and the
workaround had a fresh error surface of its own. That is what a wrong seam feels like.

##### The third option: a TAX_FILE event

Keep the 31-December settle exactly where it is — it becomes what it already resembles, **tax
computed and paid during/at the end of the year**. Add a separate annual event in April that
FILES the prior year's return: resolve the wash-sale window (closed by 30 January, so
everything is knowable), correct the return, and settle the difference.

**This is not option (b).** Nothing moves the settle, so no existing scenario changes, no
fixture re-golds, and the cross-border FTC/FITO handoff the settle feeds (design 83 G5's
`usTaxPaidOnUsSourceAud`) is untouched. That was the entire objection to (b) and it does not
apply.

And all three of (a)'s costs disappear at once: the disallowance lands on the **correct
return**, so there is no carryforward to claw back, no gain add-back, and no character
workaround to get wrong.

##### The one non-obvious requirement

**The settle RESETS the YTD accumulators, so April has nothing to recompute from unless the
return's inputs are preserved.** `computeUsTax(state)` reads those fields; a filing that
re-runs it needs the snapshot the settle currently discards.

That snapshot can be written **conditionally**, and this is what keeps the change inert: at
settle time `washPendingLosses` is already known, and a scenario with no pending entry can
never produce a correction. So no scenario that does not harvest gains a state key, and no
whole-state fixture moves — the same "absent is absent" discipline §4.1 and §8.1i already
follow.

##### Sketch of the work

1. `state.usPendingReturn` — the settle snapshots its inputs, only when a correction is possible.
2. `TAX_FILE_US` — an annual EventSeries in April, plus a handler.
3. The §8.1i resolution logic moves out of `WashSaleReducer` into a shared helper both the
   filing handler and (for a scenario with no filing) the settle can call.
4. Recompute the corrected return and emit the delta as a payment or a credit.
5. Delete the gain add-back and the carryforward clawback — they exist only to work around the
   lag.

**Seam value beyond wash sales.** "Tax year ends" and "return is filed" being one event is a
conflation the engine has carried from the start; several real things live in the gap —
estimated tax versus balance due, amended returns, and the treaty handoff's own timing. Named
here, not promised.

**Status: PROPOSED.** §8.1i and §8.1j stand and are correct as far as they go; this replaces
the lag, and the §1091 arithmetic underneath it is unchanged.

#### 8.1l Step 7c — `TAX_FILE`, specified

§8.1k argued the seam; this is the build. **The tax year ENDING and the return being FILED
become two events**, and every approximation §8.1i needed disappears because the filing can see
what the settle could not.

##### The two events

| | fires | does |
|---|---|---|
| `TAX_SETTLE_US` (today) | 31 December | computes the year's tax, resets the YTD accumulators, pays |
| `TAX_FILE_US` (new) | **15 April** | files the PRIOR year's return: resolves the now-closed §1091 windows, recomputes, settles the difference |

15 April is ≥ 30 days after 31 December, so **every** window opened by a sale in the filed year
is closed by the filing date. There is no residual lag and no "carry it to next year" branch —
the rule the filing applies is simply *resolve every pending entry whose sale falls in the year
being filed*.

##### The snapshot, and the trick that stops it drifting

`computeUsTax(state)` reads the YTD accumulators, the carryforward pools and
`currentPeriods.US` — and the settle destroys all of them. April has nothing to recompute from
unless the return's inputs are preserved.

Enumerating those inputs would be a manifest that drifts, which this repo has been bitten by
repeatedly. So the snapshot is defined **structurally instead of by list**:

> `UsTaxSettleApplyReducer` already builds the exact patch it is about to apply. The snapshot
> is the **pre-image of that patch** — `state[k]` for every `k` the settle changes — plus
> `currentPeriods.US`, which the 1-January advance moves later.

It cannot fall out of step with what the settle resets, because it is *derived from* what the
settle resets. Add a field to `YTD_FIELDS` or a new pool to the settle's patch and the snapshot
follows for free.

**Written conditionally**: only when `washPendingLosses` is non-empty at settle time. A
scenario with no pending entry can never produce a correction, so it gains no state key and no
whole-state fixture moves — the same "absent is absent" rule §4.1 and §8.1i follow.

##### The delta, as a differential

The filing does not trust the stored tax figure. It runs `computeUsTax` **twice** over the same
reconstructed state — once as filed, once with the disallowed loss removed — and takes the
difference:

```
filedState = { ...state, ...snapshot }          // the return as it was computed
ΔTax       = computeUsTax(corrected(filedState)).netLiability
           − computeUsTax(filedState).netLiability
```

Two passes rather than one because the reconstruction is not perfect: `people`, filing status
and residency are read from the CURRENT state and may have moved since December. Taking a
difference over one reconstruction makes every such drift **cancel exactly**, which a single
pass against a stored number would not. It is design 52 §4.6's with/without trick, reused for
the same reason.

ΔTax is non-negative by construction — removing a loss cannot lower a liability — so it settles
as an ordinary `US_TAX_PAYMENT_DEBIT`. A correction that could produce a refund would need a
credit action, and none exists because none can arise here.

##### What the correction actually changes

The disallowed loss is added back to the FILED year's capital-gain buckets, by character, before
`_computeCapitalLossLimitation` runs — `usCapitalGainsYTD` for long-term and
`usShortTermCapitalGainsYTD` for short. That is what §1091 says: on that return, the loss never
existed. The corrected closing carryforwards then replace what the settle wrote, which is safe
because nothing between 31 December and 15 April touches them.

##### What it deletes

- the carryforward clawback (§8.1i) — there is no stale pool to reach into any more;
- the gain add-back that worked around it, **and its §1222 character split** (§8.1k), which
  existed only because the add-back landed on a later year's return;
- `WashSaleReducer` itself, replaced by `UsTaxFileApplyReducer`. The resolution arithmetic —
  window matching, share matching, the ledger — moves to a shared helper and is unchanged.

The §1091 rules in §8.1i and §8.1j are untouched. 7c changes only WHEN the answer is applied
and WHAT it is applied to.

##### Edges

- **Terminal flush.** Design 68 Gap 2 fires the pending settle when the last survivor dies;
  the pending FILING has to fire too, or the final year's correction is lost. It joins the same
  flush set, and is inert when there is no snapshot.
- **A filing with nothing to correct** emits nothing at all, so a scenario that never harvests
  never sees the event in its journal.

#### 8.1m Step 7c — built, and the engine defect it uncovered  ✅ (2026-08-27)

`TAX_FILE_US` exists, §8.1i's lag is gone, and **5,676 unit tests and 1,131 viz tests are
green with no golden moved.** Getting to "no golden moved" took a detour worth more than the
step.

##### The claim in §8.1l was wrong, and measuring it found an engine defect

§8.1l promised the change would move no fixture because it does not touch the settle. The
first build moved **all eleven goldens**. The filing event was not firing — the divergence
was on 30 January 2026, months before any April — and the action counts were identical. Only
the ORDER had changed:

```js
this.queue = new IndexedMinHeap((a, b) => (a.date - b.date) || ((a.order ?? 0) - (b.order ?? 0)), …)
```

**That comparator is not a total order.** Same-date, same-order events tie, and a binary heap
resolves ties by array position — so *adding any node anywhere* re-resolves ties among
unrelated events elsewhere in the run. A standing annual series was enough.

And the ties are load-bearing. Giving the comparator a deterministic final tie-break
(by event type) and re-running the goldens moved **560 fields across eleven fixtures, worst
absolute \$391,453, with 64 fields dropped** from `us-single-homeowner` — whole lots that
exist under one tie order and not the other. **Which of two same-date events runs first is
worth hundreds of thousands of dollars over a 40-year run, and nothing decides it.**

That is not 7c's to fix — choosing the right order is a semantic question (should an expense
debit precede or follow the balance record?), not an alphabetisation — so it is recorded as
**F5** and left alone.

##### What it forced, and why the result is better than the original plan

The way past it is not to add a node at all:

> **The filing is scheduled LAZILY by the settle**, one occurrence at a time, only when a
> §1091 window is actually open. No `EventSeries`, so a scenario with nothing to amend has a
> byte-identical queue.

The handler binds by `static eventType` with no `handledEvents` — the engine's existing shape
for an event-driven-but-unscheduled handler — and the settle calls `sim.schedule` when
`state.washPendingLosses` is non-empty, the same condition its apply reducer uses to write the
snapshot, so the two cannot disagree about whether a filing has anything to serve.

**And it is what an amended return IS.** You lodge one when you have one. The version that
stood in the queue every year, of every scenario, waiting to do nothing, was the worse model
as well as the more disruptive one. Verified directly: with a total order imposed, the
standing-series build and the no-series build produce **byte-identical journals** — proof the
event was always inert and only its queue membership ever mattered.

##### What the numbers say

| arm | disallowed (§8.1i) | tax on the amended return | where the rest went |
|---|---|---|---|
| concentrated + the SAME security in an IRA | \$1,403/path | \$15/path | the §1212(b) carryforward |

The amendment cheque is small and **that is the correct answer**, not a disappointing one. A
harvested loss is mostly parked in the carryforward, so disallowing it removes a FUTURE
deduction rather than raising the current year's bill. §8.1i's lag got this wrong in the
other direction: unable to reach a carryforward that had already been spent, it added the
whole disallowance back as GAIN, taxing immediately what should merely have been un-banked.
7c is not only tidier than the lag — it is more accurate.

##### What it deleted

The carryforward clawback, the gain add-back, its §1222 character split, and `WashSaleReducer`
itself. The §1091 arithmetic moved unchanged into `resolveWashSales`, a pure function both the
filing handler and its apply reducer call.

The terminal flush (design 68 Gap 2) now includes `TAX_FILE_US`, so a death before April still
lodges the outstanding amendment.

#### 8.1n The REBALANCER writes no §1091 entry — FOUND and FIXED  ✅ (2026-08-30)

**Status**: found, reproduced deterministically, and **fixed**. 5,899 unit + 1,197 viz tests
green; no golden moved. It was dormant in the reference plan, but dormant by accident rather
than by rule — see "what the fix costs" below, which is the part of this section to read before
trusting a crash-year headline number.

##### How it was found — from the other end

Not by auditing §1091. Design 97 §19 was measuring whether a plan could be stopped from selling
equity in a crash, and step 0 of that work asked the sign of the realized gain on the
design-61 LOCATED planner's cross-account relocation. The answer at the early crash was a
**loss** — and the replacement was bought inside a wrapper. That is this section's fact pattern,
arrived at from a completely different question, which is worth recording because §8.1's own
review passes did not surface it in three rounds.

##### The claim §8.1j made, and the half of it that is not true

§8.1j's "what is still not modelled" names one residual gap — a TAXABLE replacement bought
elsewhere in the window — and reasons about the harvester throughout:

> The harvester sells and rebuys in one action, in one account, on one day.

That is true of the harvester. **It is not true that the harvester is the only seller.** The
rebalancer realizes taxable losses too, and `state.washPendingLosses` has exactly ONE writer:
`StockHarvestApplyReducer`. A loss realized by `RebalanceToTargetApplyReducer` therefore never
enters the pending ledger, so `resolveWashSales` never sees it — while the loss itself **does**
reach the return, because `characterizeCapitalGain` reads the signed
`usShortTermGain`/`usLongTermGain` off *any* disposal action.

§8.1j even records the adjacent observation without following it: *"the IRA case, which no
substitute choice can avoid because the rebalancer, not the harvester, does the buying."* The
rebalancer does the buying — and, on the other leg of the same relocation, the selling.

##### Confirmation — four links, all present

Reproduced on a two-account construction with no scenario behind it: a taxable brokerage holding
an EQUITY position under water, and an IRA holding only cash, under an ordinary authorable
`allocationLocationPolicy` naming the IRA as EQUITY's first home. One rebalance:

| # | link | observed |
|---|---|---|
| 1 | the rebalancer realizes a taxable loss | `STOCK_WITHDRAWAL_TAX` … `proceeds` 120,000, `costBasis` 200,000, `description: 'rebalance'` |
| 2 | the loss reaches the return | `usLongTermGain: -80000` on the same action; `characterizeCapitalGain` passes it straight through |
| 3 | a substantially identical replacement lands in a covered wrapper inside the window | a fresh IRA lot, same `identityGroup`, `purchaseDate` = the same day |
| 4 | §1091 never runs on it | `state.washPendingLosses` is `[]` after the rebalance |

Handing the entry the rebalancer never wrote to the **shipped** `resolveWashSales` — not a
reimplementation — returns `matchedFraction: 1`, **\$80,000 disallowed**. The full loss is
deducted today and the ruling destroys it.

Note link 1's action carries `gain: 0`. `_sellTax` clamps `gain` at zero, so any audit that
reads that field sees no loss anywhere and concludes there is nothing to disallow. The signed
fields are the only honest reading, and this is the second time in two days that clamp has
pointed an investigation the wrong way.

##### Why the reference plan does not show it, and why that is not reassurance

Measured on the reference plan the exposure is **\$0**, for two reasons that are both properties
of that plan rather than of the rule:

- its relocation crosses MARKETS — the taxable book sells the US market synthetic and the
  wrapper buys the AU one, so the identity groups differ and nothing is substantially identical;
- the receiving wrapper is an AU **super fund**, which `SHELTERED_ROLES` deliberately excludes
  (§8.1i: IRA and Roth only, because that is what Rev. Rul. 2008-5 and Pub. 550 name).

Change either — a plan whose wrappers have room for the same market's equity, which is what the
DEFAULT policy asks for, since `DEFAULT_LOCATION_POLICY` names **ROTH first** for EQUITY — and
the pattern is live. The construction above needed nothing exotic to produce it.

##### The fix, as built — the sell leg writes the entry, exactly as the harvester does

The seam was already proven; it just had one caller too few. `_washPendingEntries` in
`rebalance-to-target-apply-reducer.js`, called from the taxable sell leg **before** `holdings`
is rebuilt — which is the only moment the pre-sale lots and their post-sale counterparts are
both in hand, and therefore the only place the units and identity of what was sold can be
recovered exactly. That is also the answer to §8.1j's objection: the instrument never needed to
go on the payload, because the payload was never the right seam.

1. **`RebalanceToTargetApplyReducer`'s sell leg appends to `washPendingLosses`**, on the same
   terms §8.1i set: only a LOSS, only lots that name an identity group, `units` from the lots
   actually consumed. No new machinery, no manifest change, and no second copy of the matching
   arithmetic — `resolveWashSales` and the April `TAX_FILE_US` resolution (§8.1l/m) are reused
   whole.

2. **The one real difference from the harvester: the entry must be split by identity group.**
   The harvester sells a single lot, so `identityGroupOf(source)` is unambiguous. The rebalancer
   calls `consumeHoldings(matching, take, …)` across every lot of that allocation in the account,
   which may span several groups. `consumeHoldings` returns `newHoldings`, and `matching` is in
   hand, so units consumed per lot — and hence the loss apportioned per group — is an exact local
   diff. Emitting one undifferentiated entry would attribute a loss to whichever group happened
   to be first, and would match against the wrong replacements.

3. **The buy side needs nothing.** `_shelteredReplacements` reads IRA/Roth lots off their
   `purchaseDate`, and a rebalance buy establishes a fresh dated lot, so the replacement is
   already visible to the resolver.

4. **Scope: the sheltered branch only**, matching §8.1i's precedent. The §1091(d) taxable branch
   for a rebalance sell with a rebalance buy in another TAXABLE account is the same shape as
   §8.1j's named gap and carries the same cost — it needs a replacement lot located later to
   write basis onto. It is a timing effect; this one is permanent. The permanent half is closed
   and §8.1j's entry stands, now widened to name the rebalancer as well as the 1-January
   neighbour. **Reachability under the shipped default location policy, and the seam it would
   need, are worked out in §8.1o; the branch itself is BUILT at §8.1p.**

5. **The entry is dated `purchaseMs`, not `eventMs`** — the same date, through the same fallback
   chain, that the buy legs stamp on the replacement lot. §1091's window is ±30 days, so a sale
   and its replacement dated off two different clocks would silently fail to match, and a null
   date would skip the entry entirely.

Eleven tests in `tests/unit/rebalance-wash-pending.test.mjs`. The last one is the one that
matters: it drives the **shipped** `resolveWashSales` over state the reducer produced, so it
asserts what the return loses rather than the shape of a ledger row. Its two halves are the
IRA case (destroyed) and the super/cross-market case (stands) — the reference plan's own
configuration, pinned so that "the plan measures zero" cannot quietly become "the rule does
nothing".

One fixture detail cost a debugging pass and is worth repeating: **`consumeHoldings` rescales
`units` on a PARTIAL sale only for a lot carrying `pricePerUnit`** (design 93 §5b). A test lot
without one keeps its full unit count after a partial sale, the diff reports zero units
consumed, and no entry is written — a green-looking fixture measuring nothing.

##### Three things to be careful of, all of which can produce a believable wrong number

- **Double-matching.** §1.1091-1(e) says shares that disallowed one loss are disregarded for
  another. §8.1j already nets its on-the-spot disallowance out of the §8.1i entry; a rebalance
  entry is separate shares and should compose, but the two writers now share one ledger and that
  has to be tested rather than assumed. **Tested at §8.1o — and it failed: replacement shares
  were counted afresh for every entry and never consumed.**
- **Over-disallowance from innocent replacements.** `_shelteredReplacements` counts *every*
  IRA/Roth equity lot bought in the window — an ordinary contribution or a rebalance internal to
  the wrapper, not only a relocation. That is already true for harvester entries; the rebalancer's
  loss volume is larger, so a false match costs more.
- **Australia is untouched**, as in §8.1j: there is no §1091 there, and `auShortTermGain` /
  `auLongTermGain` must keep carrying the full loss. Stamping the US rule on the AU figure passes
  every total-based check in the repo.

##### What the fix costs — a drift with no tax in it

Measured on the reference plan, crash-dated: **no shock ⇒ byte-identical**; **with the crash ⇒
terminal net worth moves +\$22k on a \$14m book (+0.16 %)**, and every April filing it triggers
reports `delta: 0, disallowed: 0`. **No tax was assessed or removed.** The plan's relocation
sells one market's synthetic and buys another's inside a super fund, so nothing matches — which
is exactly what §8.1n predicted and what the end-to-end test pins.

The movement is the extra 15-April `TAX_FILE_US` event perturbing same-date ordering. §8.1m
already measured this mechanism at "560 moved fields across the goldens" when the filing was
scheduled unconditionally, and named its cause: **the queue orders by `date || order` with no
final tie-break.** The filing is scheduled only where a §1091 window is genuinely open, which is
what §8.1l says should happen — so the behaviour is correct and the drift is a pre-existing
engine weakness surfacing in more runs than before.

Two consequences worth stating rather than discovering:

- **A crash-year headline number is not comparable across this change.** Any study arm that
  realizes a rebalance loss will move by a fraction of a percent for reasons that are not tax.
- **The real fix is a final tie-break on the event queue**, not suppressing a correct filing.
  That belongs to design 34 §13 and is deliberately not attempted here.

##### Why this matters beyond one plan

If the disallowance is real and unmodelled, **the LOCATED planner books a tax benefit in every
down year in which it relocates a class into a covered wrapper**, whether or not anyone ever
authors a feature in this space. That is a correctness question about a default policy, not an
optional lever — which is what makes it worth a section rather than a backlog line.

#### 8.1o Two writers, one ledger — the double-match, and the filing tie  ✅ (2026-09-02)

**Status**: §8.1n's two named residuals, taken in turn. The test gap is closed; a defect the
gap was hiding is **found and fixed**; the §1091(d) taxable branch is **measured for
reachability and specified** below, and **built at §8.1p**. The reason no existing golden
moved was itself a finding — the whole §1091 path had no whole-state coverage — and the
`wash-sale-harvest` golden added at the end of this section closes it. 5,958 unit + 1,250 viz
tests green.

##### The gap §8.1n admitted, restated precisely

> My tests cover reducer → resolver, not reducer → April filing → assessed delta.

Between `resolveWashSales` returning a number and a taxpayer paying one there are three more
pieces, each with its own suite and **none of them wired to the others by any test**:

| link | what has to hold | whose suite |
|---|---|---|
| the classifier | `STOCK_WITHDRAWAL_TAX` books the rebalancer's SIGNED loss into `usCapitalGainsYTD` | design 90 §4 |
| the settle | schedules the April filing AND snapshots the return's inputs, both gated on the same `washPendingLosses` the sell leg just wrote | §8.1l/m |
| the filing | recomputes the filed year with the loss removed, and assesses the difference | §8.1l/m |

Each link is asserted somewhere against a HAND-BUILT input. Nothing asserted that the output
of one is a valid input to the next — and that is exactly the shape of defect the composition
hides, because every suite stays green while the chain delivers zero.

`tests/unit/wash-sale-filing-composition.test.mjs` runs the whole chain over one state object:
rebalance sell → classify the chained tax action → 31-December settle (schedule + snapshot) →
15-April filing → apply → payment. It asserts on the balance due and the §1212(b) pools rather
than on any intermediate shape. Stubbing `_washPendingEntries` back to its pre-§8.1n behaviour
fails three of its four tests, which is the working-detector check design 90 §10 asks for.

##### What the composition test found on its way through

The end-to-end arm exposes something the resolver-level assertion could not see, because it is
a property of the RETURN and not of the ledger: **in a year with no offsetting gains, the
disallowance is mostly not cash.** §1211(b) had let only the statutory ordinary-income
allowance through; §1212(b) carried the rest. So the April filing claws back a small payment
and **deletes the carryforward pool** — the money is real but it moves as a pool that is not
there next year, not as a bill. In a year with gains to absorb, the same disallowance is
charged at the full long-term rate immediately. Both arms are pinned, because a test that only
ever measured the first would read "the wash sale is worth almost nothing" and a test that only
measured the second would overstate it by an order of magnitude.

##### The defect the gap was hiding: replacement shares were never consumed

§8.1n listed double-matching first among "three things to be careful of", and said the two
writers now sharing one ledger "has to be tested rather than assumed". Tested, it fails.

`resolveWashSales` computed, for each pending entry independently, the total replacement units
in its group inside the window. Nothing was deducted. So **one IRA purchase disallowed a
same-sized loss in EVERY pending entry naming its group** — two equal sales lost twice the
replacement's worth of loss to a lot that can only cover one of them. The over-disallowance is
bounded only by how many losses the year realized, and it always runs against the taxpayer.

§1.1091-1(e), verbatim from `docs/us-tax/CFR-26-1.1091-1-Wash-Sales.txt`:

> The acquisition of any share of stock or any security which results in the nondeductibility
> of a loss under the provisions of this section shall be disregarded in determining the
> deductibility of any other loss.

The same regulation supplies the ordering the fix needs, which is why this is a transcription
rather than a judgement call:

- **(b)** where more than one loss is claimed in the taxable year, the section is applied to
  them "in the order in which the stock or securities ... were disposed of (beginning with the
  earliest disposition)";
- **(c)/(d)** acquisitions are matched "in accordance with the order of their acquisition
  (beginning with the earliest acquisition)".

So: replacement lots carry a remaining count, oldest acquisition first; entries are resolved
oldest disposition first; each entry takes only what earlier entries left. (b)'s same-day
tie-break — order of ORIGINAL acquisition of the shares sold — is not reachable, because an
entry records the sale and not the sold lot's purchase date; a stable sort keeps same-day
entries in the order the reducers wrote them, which is their sale order within the day. Stated
rather than hidden, and it can only matter when one day's sales exceed the replacement pool.

An entry belonging to a LATER year consumes nothing: it is carried to its own filing, where the
same lots are re-tested. That is a consequence of §8.1l's per-year resolution, and it means a
replacement lot can still be counted once in each of two filings — the same seasoned-lot
limitation §8.1i already records, now with a second way to reach it.

**Why it was latent.** With the harvester as the only writer, entries are one sale per harvest
and a book that harvests once a year has nothing to collide with. §8.1n added a writer whose
legs consume every lot of an allocation in an account, and a semiannual rebalance plus a
December harvest puts several same-group entries into one filing. The pre-existing bug became
reachable at the moment the ledger's second writer landed — which is the general shape worth
remembering: **widening who writes to a shared ledger re-prices every assumption the ledger's
reader made while it had one writer.**

Six tests in `wash-sale.test.mjs` ("replacement shares are consumed"). Three of them fail
against the old resolver; the other three (whole match, per-group isolation, later-year
carry) pass either way and are there to pin that the fix did not over-correct.

##### The §1091(d) taxable branch — reachable, and still open  *(built at §8.1p)*

§8.1n scoped itself to the sheltered branch and left the taxable one as §8.1j's standing gap.
It is **reachable under the shipped default**: `DEFAULT_LOCATION_POLICY` ranks EQUITY as Roth,
then the US taxable book, then the AU taxable book — so a relocation can sell equity in one
TAXABLE account and buy it in another, on the same day, in the same identity group. It is not
reachable within ONE account, because a rebalance never sells and buys the same allocation
there.

Why it is not closed here, stated as a cost rather than a preference:

1. **The seam that made §8.1n cheap does not exist for it.** The harvester's immediate wash
   (§8.1j) works because sell and rebuy are one action in one account, so both lots are in
   hand. §8.1n's sheltered case needs no basis write-back at all. The taxable case needs BOTH
   halves — a disallowance and a §1091(d) basis increase with a §1223(3) holding-period
   tack-on — and the replacement is established by a DIFFERENT action, on a different account,
   whose ordering within the day is not guaranteed.
2. **So it has to resolve late, and a late resolution can miss its target.** At the April
   filing the disallowed amount and its group are known, but the lot it must be written onto
   may have been sold, split, compacted or swept in the intervening months. A basis increase
   with nowhere to land is a silent loss of the deferral — a wrong number that still balances,
   which is the failure mode this design keeps naming.
3. **It is timing, not money.** The permanent half is closed. This half defers a loss and gives
   it back on the eventual sale; its value is the time cost of the deferral, not the loss.

The seam, if it is built: the sell leg already writes an entry with group, units and character.
A taxable §1091(d) needs (a) `_shelteredReplacements`' taxable sibling, restricted to lots the
run can still identify at filing time, and (b) a write-back step in `UsTaxFileApplyReducer`
that raises the surviving replacement lot's `costBasis` by the disallowed amount and back-dates
its `purchaseDate` to the sold lot's, exactly as the harvester's immediate branch does. Item
(b) is where the risk is, and it should not be attempted without a conservation check: the
disallowed dollars must appear in some lot's basis or be explicitly recorded as forfeited.

**Built at §8.1p, on that seam, with that conservation check** — `washDeferralUnplaced` is the
"explicitly recorded as forfeited" half. Read §8.1p for what the fact pattern actually turned
out to require, which none of the three attempts above would have produced.

##### The reason none of this moved a golden — and the golden that fixes it

**No golden fixture contained a wash-sale entry at all.** `washPendingLosses` and
`washSaleLedger` appeared in none of them, so the entire §1091 path — the two reducers that
write the ledger, the resolver, and the April filing that assesses it — had zero whole-state
coverage, and a defect in it shipped green through the repo's strongest gate. That is exactly
what the double-match above did.

`wash-sale-harvest` closes it. Three things have to be true at once before a fixture can reach
§1091, which is why none of the other ten does:

| requirement | how the golden meets it |
|---|---|
| the plan must HARVEST | `TAX_LOSS_HARVEST` is on — it is in no other golden's plan |
| there must be a LOSS to harvest | a dated crash puts the book under water; a book that only appreciates gives the harvester nothing to sell |
| the replacement must be substantially identical AND land in a wrapper the authority reaches | the taxable brokerage, the IRA and the Roth all hold one authored security while the harvester rotates into a second one in the same market |

That last row is the part worth keeping: two authored securities in one market are the only way
a book can express "economically similar, legally distinct" (§8.1c) — and therefore the only
way it can express the opposite either. The reference goldens hold nothing but the four
synthetic market securities, where every equity lot is substantially identical to every other
by construction, so they cannot pose the question at all.

What the run then contains, all of it in the fixture: the **rebalancer** writing entries as it
relocates equity into the wrappers (§8.1n) and the **harvester** writing them at year-end
(§8.1i); one filing that disallows and assesses a real balance due, paid the following April;
three further filings that correctly disallow **nothing** — the unmatched entry retires, the
snapshot is still retired, no payment is chained; and an entry still pending at simEnd because
its return has not been filed yet. It also brings the shock family and the first
`SECTION_988_GAIN` any fixture has reached into the coverage manifest, which lifted the
golden-coverage floor from 51 to 88 action types. Cost: ~150 ms.

`wash-sale-golden.test.mjs` is its paired test, and it exists because of how this particular
subject fails: **breaking §1091 makes the golden look healthier.** A disallowance that silently
stops firing removes a tax payment and raises terminal net worth, which is the shape of a
fixture diff a reader is inclined to accept. So the paired test names the mechanism instead —
both writers present, a filing that disallows, the April payment, the zero-delta filings, the
carried entry. Stubbing the resolver's matcher fails three of its seven tests; removing
§8.1n's writer fails five.

It has a twin: `wash-sale-two-books` (§8.1p) is the same plan with one more taxable account,
so the same loss is matched against a TAXABLE replacement and deferred instead of destroyed. A
diff between the pair isolates §1091's two consequences rather than two households.

**One thing it does NOT reach**: the share-consumption rule this section fixed. The golden puts
two same-group entries in one filing, but only one of them has a replacement in its window, so
the fixture is byte-identical with and without the fix (verified by running it against the old
resolver). `wash-sale.test.mjs` is the detector for that, and this is worth stating rather than
assuming — a golden that touches a rule is not the same as a golden that would notice it
breaking.

#### 8.1p Step 7b, finally — the §1091(d) taxable branch  ✅ (2026-09-02)

**Status**: BUILT. The half R2 held at §8.1f–g and §8.1j named as its standing gap: a loss
whose substantially identical replacement is bought in a TAXABLE account. §1091(a) disallows it
on the return exactly as the sheltered case does; §1091(d) then moves the disallowed loss into
the replacement's BASIS and §1223(3) tacks the sold shares' holding period onto it, so the
taxpayer gets it back on the eventual sale. 5,972 unit + 1,250 viz tests green; the two
wash-sale goldens are the only fixtures that move, and one of them is new.

##### The seam, and why it is the April filing

§8.1j settles the harvester's own wash at the moment of sale, and can, because that reducer
sells and rebuys in one action, in one account, on one day — both lots in hand. **Every other
wash in this engine is cross-account.** The rebalancer sells in the taxable book while a
different action, on a different account, buys the replacement, with no ordering guarantee
between them within the day. The pairing is only knowable once the window has closed, and that
is what the April filing already is (§8.1l). So `resolveWashSales` now returns
`basisAdjustments` alongside the disallowance, and `UsTaxFileApplyReducer` writes them.

Four decisions inside that, each of which could have been made wrongly and still balanced:

1. **One pool, two consequences.** §1091 does not rank replacements by where they sit — a
   share is a share, and §1.1091-1(c)/(d) match them in order of acquisition regardless. So
   the sheltered and taxable lots are ONE pool, consumed in acquisition order, and the wrapper
   decides only what happens to the money afterwards. This is a behaviour change to the
   sheltered branch as well: a taxable replacement acquired earlier now takes shares that
   previously fell to an IRA lot, which is the reg's answer, not a preference.
2. **§1223(3) as arithmetic.** The replacement is back-dated by the sold shares' holding
   period: `replacementPurchase − (saleDate − soldAcquisition)`. For a same-day sell-and-rebuy
   this reduces to the sold lot's own purchase date, which is exactly what §8.1j stamps — the
   two are the same rule, and one of them is now visibly the general case of the other. It
   requires the sold lot's acquisition date, so both writers stamp `heldFromMs` on the entry;
   absent, the basis still moves and only the tack is skipped, because the deferral is the
   money and must not be forfeited over a missing field.
3. **A partial match splits the lot.** A replacement lot can be larger than the shares matched
   against it. Raising the whole lot's basis would hand the taxpayer basis nobody paid for;
   tacking the whole lot's date would age shares that were never sold. So the lot is
   bifurcated with `resize` — which conserves value and basis exactly — and only the matched
   half carries the adjustment. Both halves need distinct ids, and the `-1091` suffix is
   itself disambiguated, because one lot can be split twice in a single filing when two
   entries each match part of it. That is not hypothetical: the new golden does it.
4. **US-domiciled taxable only.** `costBasis` is the origin/US basis while
   `costBaseByCountry.AU` carries Australia's own (s855-45). There is no §1091 in Australia
   (§8.1d), so raising `costBasis` on an AU-situs lot would let a US rule silently re-price an
   AU disposal. Deliberate under-disallowance, in the same direction as the 401(k) exclusion.

##### What resolving late costs, made visible instead of silent

Four months pass between the sale and the filing, and the replacement lot may have been sold,
swept or compacted meanwhile. A basis increase with nowhere to land is a deferral silently
lost — so it is counted: `washDeferralUnplaced` accumulates the dollars that found no lot. It
is written only when non-zero, so a run that never loses one gains no state key, and both
goldens measure zero. The disallowance itself stands either way; §1091(a) does not depend on
the taxpayer still holding the replacement.

##### The golden twin, and the fact pattern nobody would have guessed

`wash-sale-two-books` is `wash-sale-harvest` plus **one account**: a second US brokerage seeded
with the OTHER security. That single difference is the whole mechanism, and it is worth
stating because the first four attempts to reach this branch all failed:

- the harvester cannot produce it — `resolveSubstitute` deliberately rotates into a legally
  DISTINCT partner (§8.1h), so its own rebuy is never substantially identical to what it sold;
- the rebalancer buying in the taxable book cannot produce it either, in these plans: the
  taxable account funds the spending, so it sells rather than buys;
- a second brokerage holding the SAME security does not produce it — both books then rotate
  the same way and neither's rebuy matches the other's sale.

What does produce it: **two taxable books harvesting past each other.** Seed the second book
with `sec-alt`, and on 31 December one book sells `sec-core` and buys `sec-alt` while the other
sells `sec-alt` and buys `sec-core` — each rebuy is the other sale's substantially identical
replacement, same day, taxable account. That is not a contrivance; it is what a household with
two brokerage accounts and one harvesting policy does every year, and it is precisely the case
§8.1j described and held.

##### The measurement that corrects the intuition

The two halves are worth very different amounts, and the difference is the horizon:

| | measured on `wash-sale-two-books` |
|---|---|
| loss disallowed in the filed year | \$110,443, across three matched entries |
| cash it costs that April | \$681 — the rest was absorbed by §1211(b)/§1212(b) |
| effect of the basis transfer on the END state | 123 fields move; terminal net worth by about \$154 on a \$6.7m book |

**"Timing, not money" is exactly right, and on a finite horizon it means "nearly free".** The
transfer only becomes money when the re-based lot is disposed of, and most of these are not,
inside the run. So the honest reading of this build is: it makes the model CORRECT, and it
should not be expected to move a study's headline. R2 was right to hold it and right about why.

##### Two defects the new golden found on its way in

- **The harvester minted colliding lot ids.** `tlh-<security>-<ms>` is the same id every time,
  and a harvest can fire several times on one account on one day — several source lots, one
  policy. Two lots sharing an id is not cosmetic: `HoldingTransactReducer` matches on it, so
  each lot's growth, dividends and coupons land on whichever it finds first. Fixed by the same
  disambiguation the rebalancer's `_freshHoldingId` already used. It had never been reached
  because no fixture harvested twice in a day.
- **`basisAdjustments` was applied but undrillable.** `pickPayload` keeps only DECLARED fields,
  so until the type registry named it the journal recorded a filing whose basis transfers were
  invisible — the deferral happened and nothing could show where it went. The third time this
  repo has been bitten by that shape; declared now.

Left open, and small: the harvester leaves a **zero-value dust lot** behind after a full
harvest (the rebalancer sweeps its own, `_sweepDust`; the harvester does not). Value-conserving
and inert, but it is the immortal-dust pattern design 61 already fixed once.

### 8.2 Dividend character

`qualifiedDividends` and `frankingCredit` are instrument facts that today are approximated at
the sleeve level. Moving them onto the security is easy; what is not easy is that the US
qualified-dividend rules have their own holding-period test (61 days in the 121-day window
around ex-dividend), which the model has no ex-dividend dates to evaluate. **Decision (§12 D9):
carry the flag, do not model the holding-period test, and say so in the code.** An annual tick
cannot see a 61-day window; pretending otherwise would be the kind of fiction design 93
rejected Option B for.

### 8.3 Specific identification

Design 65's selection seam already takes a lot strategy. Adding "of this security" is small
once positions are per-security. Low risk, real value, good early win.

## 9. Migration

### 9.1 The mapping

Every existing equity holding gets a synthetic security derived from what it already carries:

```
sec-auto-<rateKey>   { rateKey, beta: 1.0, idioVol: 0,
                       symbol: '', name: '<market> index' }
```

**β = 1.0, not `DEFAULT_EQUITY_BETA[rateKey]`.** The first pass wrote the latter and it would
double-count: the sleeve's beta is already applied inside `sleeveDev`, and §6.2's overlay is
relative to the sleeve. A synthetic security must be the identity, and `(β−1) = 0` is what
makes it one.

### 9.2 The unitisation

Then `promoteToUnitised`-style unitisation at the config→run boundary: `units = marketValue /
pricePerUnit` at a `pricePerUnit` of 100, matching the `PAR_PER_UNIT` convention design 93 §5b
settled for exactly this reason.

`projectHoldingsToState` (`holding-utils.js:254`) is the boundary, and it is called from
exactly two places — `us-retirement-toolset.js:114` and `au-retirement-toolset.js:910`, both
inside their own `_accountToStatePlain`. That is the good news (one shared function, no third
drifted copy — design 93 was explicit about why) and the thing to re-check first, because
`state.people` has had three drifted projections and account projection has already been found
to skip the schema registry on the compiler path. **Step 0 confirms every account-bearing path
reaches this function before step 3 relies on it.**

Saved scenarios on disk are never rewritten — promotion is an act at the run boundary, not a
side effect of deserialization. That rule is design 93 §5b's and C inherits it.

### 9.3 "Byte-identical" — narrowed, with numbers

The claim was that unitisation is value-preserving by construction, so the migration moves no
golden. `scripts/probes/probe-unitised-equity-rounding.mjs` replicates the four primitives'
arithmetic (`reprice` → 8-dp price, `syncHolding` → 2-dp re-derived value, `resize` → 8-dp
units, `addValue` → units at the prevailing price) over 20,000 positions from \$1k to \$2M:

| path | 44 years | 100 years |
|---|---|---|
| **growth only** (reprice each year) | **0 divergences in 880,000 repricings.** Exact. | still 0 |
| **full lifecycle** (grow, sell a fraction, buy new money) | **6.5% of positions diverge**; worst \$0.04; mean end-of-horizon gap \$0.0001; worst relative 2.8e-7 | 45.7% diverge; worst \$0.15; mean gap \$0.0019; worst relative 1.2e-6 |

Why the two paths differ: a repricing round-trips through an 8-dp per-unit price and back to a
2-dp value without loss at any realistic position size, so growth is exact. A *unit* change
rounds a different quantity, and the two representations can land a cent apart.

**The error accumulates, slowly.** The first pass's instinct — that re-deriving value from the
unit count each period stops rounding from compounding, design 93 §9.5's argument — is right
about the mechanism but wrong as an absolute: each unit-changing operation is another sub-cent
coin flip, and the 100-year column shows the gap random-walking upward. What stays tiny is the
*relative* error, ~1e-7 over a plan horizon. Both columns are in the probe's output for
exactly this reason.

The goldens are whole-state exact-match fixtures, and a cent is a diff. **So: the migration
lands with a re-gold, and the re-gold is the deliverable of step 3, not an accident of it.** The
honest statement to carry forward is *"exact on the growth path; cent-scale on unit-changing
paths; ~1e-7 relative"* — not "byte-identical". A run whose equity is never sold or contributed
to will in fact be identical; no real scenario is that run.

The probe is arithmetic, not the engine. **Step 0 repeats it against a real golden** — that is
the cheap experiment, and it now has a specific prediction to falsify: cent-scale movement on
accounts with equity flow, none on accounts without.

### 9.4 The hazard that does not show up in any test

⚠️ **`_patchHolding` reprices what should buy units.**

`holding-reducers.js:48` routes a `marketValue` patch on a unitised holding through `reprice`,
and justifies it by enumerating the callers: *"the dividend, growth and cash-interest streams
touch scalar sleeves only, and the one stream that reaches a dated bond (accretion) is a change
in what a unit is worth"*. That enumeration is correct today and **false the moment equity is
unitised**:

- `computeHoldingsGrowth` → appreciation → `reprice` is **right**. Price moved, units did not.
- `computeHoldingsDividends` → `AuStockDividendHandler` reinvests the dividend into the sleeve
  via `holdingActions` (`earnings-handlers.js:390`) → `reprice` is **wrong**. A reinvested
  dividend buys more units at the prevailing price; it does not raise the price of the units
  already held.

The money is conserved either way — `marketValue` ends up the same — so **no golden moves, no
invariant fires, and no test fails.** What breaks is everything downstream of the unit count:
`pricePerUnit` drifts up by the dividend yield every year, two accounts holding the same
security diverge in price for a reason that has nothing to do with markets, and a later split
or per-share report reads a fabricated price.

This is precisely the class of defect design 93 §4 exists to prevent — a value change whose
KIND is left implicit — reappearing one layer down, in the choke point that was built to
prevent it. The fix is to make the kind explicit on the action rather than inferred at the
patch site: `HoldingTransactAction` gains a discriminator (`valueKind: 'PRICE' | 'UNITS'`,
defaulting to PRICE so bonds are unchanged), the dividend path sets `'UNITS'`, and
`_patchHolding` routes on it instead of on an assumption about its callers.

**This is a precondition of step 3.** Unitising equity before fixing it ships a silent defect
that no gate in the repo can see.

Two adjacent things this reading turned up, both **out of scope and recorded so they are not
lost**: the reinvested dividend carries `costBasisDelta: 0` while the accretion and
cash-interest streams step basis with the money (`"basis step-up: no double-tax at
redemption"`), and the retained bond coupon takes the same zero. If a reinvested, taxed
dividend adds no basis, it is taxed again as gain at disposal. That is a tax question for
design 90's successor, not a representation question — **F3**, and it belongs in
`design/inconsistencies.md` either way.

### 9.5 Step 0 outcome — the spike was run  ✅ (2026-08-26)

`promoteToUnitised` was temporarily extended to unitise EQUITY at the `PAR_PER_UNIT`
convention, the whole suite was run, and the patch was reverted. Three findings, one of them
not on the list of questions the spike was meant to answer.

#### 9.5a §9.3's prediction holds, and the re-gold is small

**11 failures out of 5,505 tests.** Ten are goldens; the eleventh is
`holdings-roundtrip.test.mjs:164`, which asserts *"equity is left scalar under Option A"* —
i.e. the one test whose job is to fail here, and which step 3 amends rather than deletes.

Nothing else moved. Not the holdings invariants, not the write gate, not the par walks, not
one behavioural test.

Across all ten goldens: **49 value fields moved, none by more than \$0.15**, on net worths of
\$4M–\$12M.

| golden | fields | new `units`/`price` | value moves | max \|rel\| |
|---|---|---|---|---|
| speculative-stake | 22 | 22 | **0** | — |
| speculative-conversion | 22 | 22 | **0** | — |
| payroll-limits | 22 | 22 | **0** | — |
| bond-par-conservation | 14 | 14 | **0** | — |
| tips-ladder-conservation | 14 | 14 | **0** | — |
| au-super-streams | 5 | 4 | **0** | — |
| au-single-homeowner | 13 | 2 | 11 | 1.5e-8 |
| cross-border-disposals | 23 | 22 | 1 | 4.2e-8 |
| cross-border-reference | 39 | 22 | 17 | 7.2e-7 |
| us-single-homeowner | 26 | 6 | 20 | 6.1e-1 ⚠ |

**Six of ten goldens move nothing at all** beyond gaining the two new fields — exactly §9.3's
prediction that a book without equity flow is identical. The rest move at 1e-7 to 1e-8, which
is the rounding.

⚠ **The 6.1e-1 is not what it looks like, and this is the trap the re-gold has to survive.**
It is `k401Account.earningsBasis`: 0.0164 → 0.0064. A one-cent move on a residual that is
itself under two cents. Several near-zero dust fields will show enormous *relative* moves in
step 3's re-gold, and every one of them has to be read in absolute terms before anyone
concludes the behaviour changed. **Read the absolute column first.**

#### 9.5b §9.4's hazard, demonstrated

Under the spike, `auStockAccount.holdings.0` finished the run with:

- `units`: **600** — exactly the count it was promoted with at boot (\$60,000 ÷ 100)
- `pricePerUnit`: 1037.87 — up from 100
- and a run that paid and *reinvested* \$22,595 of AU dividends into that very holding
  (`metrics.au_stock_dividend`)

**The unit count never moved.** Every dollar of reinvested dividend inflated the price of the
600 units already held instead of buying more, precisely as §9.4 predicts, because
`_patchHolding` routes the credit through `reprice`. Market value is right to the cent, so
**5,505 tests saw nothing.**

That is the argument for step 2a stated as a measurement rather than a worry: this defect is
not merely hard to catch, it is invisible to every gate the repo has. The `valueKind`
discriminator and the fifth invariant walk (§11) are what make it visible.

#### 9.5c The §9.2 audit found a third mode: mixed

`projectHoldingsToState` is the only *promotion* point — but it is not the only place a state
holding is **born**. Lots created during a run never pass through it:

- `_newSleeve` (`rebalance-to-target-apply-reducer.js:419`) — every rebalance buy;
- `AccountService`'s four `new Holding(...)` sites (`:205`, `:219`, `:250`, `:282`);
- accounts created at death by `bequest-service.js` (`:254`, `:435`), which start `holdings: []`
  and fill at runtime.

The spike shows the consequence directly: in `us-single-homeowner`, `iraAccount.holdings.0`
gained `units` and `pricePerUnit` while **`iraAccount.holdings.6` moved in value but gained
neither** — a booted lot unitised, a run-created lot still scalar, in one account.

So "flip equity from scalar to unitised" is **two** changes, not one: promote at the config→run
boundary *and* establish units at every birth site. Step 3 owns both, and the fact that the
suite stayed green with the book half-converted is evidence that design 93's two-modes-are-both-
first-class rule is real — but mixed mode must be a deliberate transitional state, not the
resting one, because `split()` cannot act on a lot with no unit count and per-share reporting
would be inconsistent across lots in one account.

### 9.6 Step 2a implementation record  ✅ (2026-08-26)

`VALUE_KIND` (`holding-actions.js`) is the discriminator; `HoldingTransactAction` carries it,
`_patchHolding` routes on it, and the five emitters in `holdings-earnings.js` each say what
their money is. **5,518 tests green, no golden moved** — which is the point: on a scalar
holding the two kinds are the same operation, so step 2a is inert until step 3 unitises
equity and then it is already right.

Five decisions worth keeping, because each one is a place the obvious version is wrong:

1. **The kind is stored only when it is not `PRICE`.** An explicit `'PRICE'` on every action
   would add a field to every journal payload and every whole-state fixture in the repo, for
   no information — design 93 §5a's discipline, and the same reason `cpiIndexRatioFactor` is
   conditional. An absent field and an explicit PRICE are one behaviour, at the constructor,
   in `toJSON`, and at the reducer's default.
2. **It is declared in the payload manifest** (`HOLDING_ACTION_ENTRIES`). `pickPayload`
   copies only the fields the manifest names, so an undeclared field is dropped from the
   journal *silently* — the drift class design 91 closed. A test pins it.
3. **`addValue` gained `basisDelta`, defaulting to `amount`.** A reinvested dividend books
   income and steps no basis (`costBasisDelta: 0`), so routing that credit through
   `addValue` unchanged would have started stepping basis and moved every golden. Whether it
   *should* step is follow-up **F3**; the parameter keeps answering it a deliberate change
   rather than a side effect of this one.
4. **The SCALAR branch was left alone on purpose.** Routing it through `addValue` would round
   the value to 2dp where today it is written raw — several fixtures carry unrounded market
   values from exactly this path — so "tidying" it would move goldens for no reason. The
   comment there says so.
5. **The coupon emitter declares nothing, deliberately.** Both bond coupon handlers
   destructure `{ amount, … }` and discard `holdingActions` — a coupon is paid to cash, not
   retained — so any kind declared there would be untestable. The comment records what it
   would be (UNITS) if a caller ever emits them.

**The fifth walk earns its place, and that was checked rather than assumed.** With the
routing mutated to ignore the declared kind — the exact defect §9.5b measured — **2 of the 13
new tests fail and the entire rest of the repo stays green**, goldens and holdings invariants
included. A gate whose removal nothing else notices is the only kind worth adding here,
because the defect conserves every number an invariant could check.

### 9.7 Step 3 implementation record  ✅ (2026-08-26)

Equity is a position in a security. `promoteToUnitised` does both stamps, the four synthetic
market securities are always in the registry, four birth sites establish units, and the
re-gold is what §9.3 said it would be. **5,575 unit tests and 1,131 viz tests green.**

#### 9.7a The re-gold, read in absolute terms

`scripts/probes/probe-step3-regold-delta.mjs` is committed rather than quoted, for the reason
§0 gives: **551 new fields, 90 moved, worst absolute move \$0.62 on a \$4.27M net worth**
(1.5e-7 relative), no field dropped and no lot-structure change. Two of the ten goldens move
nothing at all beyond gaining the new fields.

§9.5a warned that the trap would be a dust field showing a vast RELATIVE move; the largest
relative move here is 1.0e-6, so the trap did not spring — but the probe prints the absolute
column first anyway, because the next re-gold is where it will.

The honest statement §9.3 asked for holds: *exact on the growth path, cent-scale on
unit-changing paths, ~1e-7 relative*.

#### 9.7b Two decisions the spec did not make, and what forced each

**1. The registry is always present — §4.1's "absent means absent" is REVERSED here, on
purpose.** All four synthetic market securities are minted whether or not the scenario holds
them at boot. The alternative — mint from the boot portfolio — is wrong for a reason that is
only visible once you look at the birth sites: a lot born mid-run takes its market from
`resolveRateKey`, which is bounded by the ACCOUNT's country and role, not by what the
portfolio already holds. A rebalance into an AU sleeve of an account that started 100% US
would name a security that is not in the registry, and `instrumentOf` falls back to the
holding **silently** — Option A wearing Option C's field. Four frozen records shared by
reference across every snapshot cost nothing (§6.4). The `sec-auto-` prefix is reserved:
`buildSecurityRegistry` throws on an authored collision, because a shadowing record would
change what every un-securitised lot in that market resolves to, in every account at once.

**2. A lot born mid-run joins at its siblings' price, never at the convention's 100.**
`PAR_PER_UNIT` is right at the config→run boundary because every lot in the run is promoted
at the same instant and they are therefore consistent with each other. It is wrong at a birth
site, and not cosmetically: a 2035 vintage lot minted at 100 beside a boot lot standing at
380 claims 3.8x the shares for the same money. `prevailingPrice(siblings)` is the fix and it
is value-weighted, not "the template's", so a dust lot cannot throw it.

#### 9.7c §9.5c's audit was right about the shape and one short on the count

The design named `_newSleeve`, four `AccountService` sites and the bequest service. What the
walk actually found, run against all ten goldens, was **three** live birth sites plus one the
audit did not name:

| site | what it needed |
|---|---|
| `distributeHoldingsCredit`'s vintage lot | the largest runtime source of equity lots in the model — one per bucket per year from every reinvested dividend and wrapper deposit |
| `_newSleeve` (the rebalancer) | plus `securityId` in `_inheritedTraits`, which is D10 |
| `_inheritedLot` (`inheritance-classes.js`) | the bequest path — and it had no `rateKey` either, so it also had no market to name |
| `consumeHoldings`' partial remainder | **not on the list**: it derived the remainder's par as `units × (parPerUnit ?? 0)` |

The `AccountService` sites turned out not to need anything. They operate on account
RECORDS, and every record passes through `projectHoldingsToState` at the boundary — which is
§9.5c's own point, arrived at from the other side: the four sites it named are on the config
side of a line the audit was drawing.

**The fourth one is the interesting one, and it is why the walk is a test and not a
checklist.** `consumeHoldings`' `?? 0` was unreachable while equity was scalar and stamped
`faceValue: 0` on every partly-sold share lot the moment it was not. A par of zero is not
the absence of a par: `BondPriceAdjustReducer` pulls a price TOWARD `faceValue` every period,
`BondMaturityReducer` redeems AT it, and `_syncBalance` has a ghost-par sweep. It moved no
money in these goldens, and no gate in the repo was looking at it. The birth walk now checks
that an equity position carries neither `parPerUnit` nor `faceValue`, which is the assertion
that caught it.

#### 9.7d The one thing that DID move money, and it was compaction

`compactLots`' fungibility key is "every field the merge does not handle itself", and
`pricePerUnit` was not on the handled list. Under §4's per-position price two lots in the
same security legitimately stand at different prices — each was established at whatever price
prevailed when it was born, and each is then repriced off its OWN rounded market value, so
even two lots born on the same day drift apart in the eighth decimal. Leaving the price in
the key made compaction **unreachable for every equity vintage lot**: `us-single-homeowner`'s
three equity accounts went from 3, 7 and 3 lots to 22 each, which is §5.5's unbounded-lot-count
leak with a tax rationale.

The merge now derives `pricePerUnit` as Σvalue / Σunits — the only price at which the
survivor holds every absorbed lot's units AND every absorbed lot's dollars — and the lot
counts return to the fixtures exactly.

Worth recording how it was caught, because the first re-gold measurement **passed the eye
test**: net worth moved by cents in every golden, which is what §9.3 predicted. The tell was
in a column the delta probe prints for this reason — 1,499 NEW fields in one golden and 285
in another, i.e. fifty-odd whole lots that had not existed before, with the same money
redistributed across them. A structure change that conserves every total is precisely the
shape design 94 keeps finding, and it is invisible in any aggregate.

#### 9.7e §11's fifth walk, now e2e

`equity-position-birth.test.mjs` carries the assertion §11 said becomes runnable at step 3:
`cross-border-reference` pays and reinvests \$22,595 of AU dividends, and the paying lot must
end the run holding **more than the 600 units it was promoted with**. It ends with 1,537.98
at a price of 404.89.

Verified non-vacuous by the same mutation §9.6 used — force `_patchHolding` to ignore the
declared kind and the assertion fails naming *the unit count is still 600*, which is
§9.5b's measured number reproduced exactly.

#### 9.7f What step 4 inherits

- §5.3c's punch list is **unchanged but no longer latent**. The three `AccountService` sites
  still read `instrumentOf(h)` with no registry — and that is now SAFE rather than merely
  correct-by-accident, because the migration keeps every lot's inline fields and a synthetic
  security is silent about everything except `rateKey`, `beta` and `idioVol`. It becomes
  live again the moment a real security declares a field those sites read.
- `beta` and `idioVol` are on every synthetic security and **nothing reads them yet**. That
  is step 4's seam, and it is deliberately inert: β = 1.0 with σ_idio = 0 is the identity,
  so a migrated lot behaves exactly as it did before it named anything.
- The RNG-neutrality extension (§11) is step 4's, not this step's: no draw is taken per
  security yet, so there is nothing yet to pin.

### 9.8 Step 5 implementation record  ✅ (2026-08-27)

`two-security-concentration` is the eleventh golden and the first that can see a security at
all. **5,614 unit tests and 1,131 viz tests green; one new fixture, no existing golden
moved.**

#### 9.8a What the golden holds, and why each part is there

| element | what it makes reachable |
|---|---|
| `sec-emp` — β 1.35, σ_idio 0.35 | the §6.2 price path, including the annual per-security draw. The only place in the repo where a security consumes a uniform |
| the same `sec-emp` in a taxable brokerage AND a 401(k) | **§4's D4 made observable** — one instrument, two positions, two bases, two prices, each priced off its own design 55 §8 account rate |
| `sec-exus` — β 0.90, σ_idio 0 | the beta-only branch: it overlays every year and never draws |
| a security-level `dividendYield` | §12 D11's chain (`instrumentOf(h).dividendYield ?? h.dividendYield ?? fallbackYield`) under CI rather than in one unit test |
| the AU lot, left on its synthetic | the migrated and the authored representations in one fixture, side by side |
| `equityReturnStochastic: true` | the first and only golden with it on — which also moved `EQUITY_RETURN_STEP_APPLY` out of the coverage manifest's KNOWN_GAPS |
| 8 years, crossing the 2031 move | short, and still pins that a residency change does not disturb what a position is held IN |

**It is also the repo's RNG-order tripwire.** Nothing else in the fixtures depends on the
draw sequence, so a change to draw ordering re-bases this fixture and nothing else. That is
a feature and it needs to be read as one: a diff here is not necessarily a money bug.

#### 9.8b §11's fourth walk

`tests/unit/security-position-identity.test.mjs` — *no reducer may change a position's
`securityId` in place*, reported as the TRANSITION so the reducer named is the one that did
it. Absent → present is not a violation (that is a birth, and the third walk's subject);
`sec-a` → `sec-b` and `sec-a` → absent are.

Run against six goldens, and **verified non-vacuous by mutation**: make `HoldingTransactReducer`
rewrite the id and the walk fails naming `HoldingTransactReducer: k401Account.h-401k-equity
sec-emp → sec-mutant`. Without the mutation the walk is green everywhere, which is the point
— it is a ratchet, not a discovery.

The same file carries the four assertions that say what the FIXTURE MEANS, because a fixture
diff cannot: two prices for one security, the concentrated position separated from its sleeve,
the overlay published only for the two authored securities, and the registry still frozen at
the end of the run.

#### 9.8c The golden earned its keep before it had a fixture

The first run of it exposed §6.6's latency defect — a step-4 bug that every unit test in the
repo agreed with, because a unit test drives ONE account and the defect is only visible when
two accounts' earnings events straddle a tick. §11's claim that "without one, every
per-security path is unreachable and green means nothing" turned out to be literally true
within an hour of the golden existing.

Worth noting HOW it surfaced, since it is the same shape as §9.7d: the fixture was not the
detector. The tell was two positions in one security whose prices had drifted a factor of
four apart, which was visible only because the golden was built to put them side by side and
the control arm was run beside it.

#### 9.8d What step 6 inherits

- The rebalancer's `_inheritedTraits` already carries `securityId` (D10, §9.7c), so the buy
  path is correct today. What step 6 adds is the collapse to a single unanimity check, which
  waits on the five inherited fields actually moving onto the security.
- This golden authors no rebalance, deliberately — the subject here is the price path. Step 6
  wants a target mix in a book holding two securities in one sleeve, and that is a change to
  THIS golden's params, not a twelfth fixture.
- **F2 is now measurable rather than theoretical.** §9.8a's second row is the per-account
  growth-rate override and the per-security overlay operating on the same instrument at the
  same time; the fixture holds both prices, so the day F2 is decided the cost of deciding it
  either way can be read off a diff.

## 10. Blast radius

Where per-security positions are felt, roughly in descending order of risk:

1. **Tax paths** — dividend classification, disposal character, §988 (a foreign-currency
   security), the AU franking path, wash sales. Highest risk, and §8 is why.
2. **Rebalancing (design 61)** — **and the answer is already in the code.** The rebalancer's
   buy path does not need a new policy: `_inheritedTraits`
   (`rebalance-to-target-apply-reducer.js:402`) already gives a fresh lot the traits its
   siblings *unanimously* agree on and falls back to resolved defaults when they disagree.
   `securityId` joins `rateKey`, `taxExemption`, `issuingState`, `dividendYield` and
   `duration` in that set: a sleeve where every lot is one security buys more of it; a mixed
   sleeve buys a generic sleeve position, which is honest. Better still, once those five
   fields come from the security, the whole function **collapses to one unanimity check** on
   `securityId`. That is a simplification C pays for itself with. (§12 D10.)
3. **Drawdown selection (design 65)** — already pluggable; gains a dimension.
4. **Lot count** — more securities means more lots; §5.5's compaction handles it correctly
   without change (different `securityId` ⇒ never merged), but the counts go up, and per §6.4
   every lot is cloned per event. The reference run carries 28 holdings across 14 accounts;
   measure this alongside the registry, not separately.
5. **Reporting / the allocation cube** — mostly an improvement, but `accountBalanceKeys()` and
   the cube's domain assumptions need checking (`ASSET_CLASS` is report-only, and the cube has
   already been found to drop what `accountBalanceKeys()` does not name). **BUILT at step 9 —
   §10.2a.** The check came back clean: the cube deliberately does not use
   `accountBalanceKeys()`, and the header already says why.
6. **Workbench / account editor UI** — a security picker, and the holdings table gains columns.
   22 instrument-field references. Real work, low risk. **BUILT at step 9 — §10.2b.** The
   "low risk" held; the non-obvious part was that a picker without a rule about the fields
   BELOW it would have shipped a form full of controls the engine ignores.
7. **MC runner and MPC** — state size per path and snapshot cost, quantified in §6.4;
   `serializeScenario` gains the registry.


### 10.1 Step 6 implementation record  ✅ (2026-08-27)

Items 2 and 3 of the list above, built. **5,626 unit tests and 1,131 viz tests green; one
fixture moved, and it is step 5's own, by design (§9.8d said step 6 would re-param it).**

#### 10.1a D10's collapse, delivered as BEHAVIOUR rather than as deleted code

The first pass expected `_inheritedTraits` to shrink to a single unanimity check on
`securityId`. It cannot, yet, and the reason is worth recording rather than working around:
**bonds are not securitised.** §9.1's migration mints synthetic securities for the four
EQUITY markets only, so every BOND lot in the repo still carries `taxExemption`,
`issuingState` and `duration` inline with no instrument to move them to. Deleting the four
field checks would silently drop a treasury sleeve's state-tax exemption on its next rebuy.

What step 6 does instead is change **what the question is asked of**:

```js
const insts = lots.map(h => instrumentOf(h, securities));   // ← the whole change
```

Unanimity is now judged on the INSTRUMENT view. When the lots name one security, that
security answers all five fields at once — which IS D10's collapse, just expressed as
behaviour instead of as a smaller function. Where nothing names a security, `instrumentOf`
returns the holding and the comparison is the historic one, field for field. `securityId`
itself stays a record read: it is what a position NAMES, not something an instrument says
about itself.

**It is not a refactor — it changes a number, and the golden holds it.** `h-401k-equity`
carries no inline `dividendYield`; `sec-emp`, which it names, pays 0.006. Judged as records
the sleeve unanimously agrees on *nothing* and the rebalancer establishes a lot paying
nothing; judged as instruments it agrees on 0.006. Verified non-vacuous by mutation — drop
the `instrumentOf` call and that assertion alone fails.

**A deliberate non-choice.** The established lot still carries the inherited values INLINE
rather than leaving them to the security. Omitting them would be truer to §5.1's partition,
and it is tempting — but a lot's inline fields feed `compactLots`' fungibility key, and a
new lot that omits `rateKey` beside seasoned siblings that carry it would never merge with
them. That is §9.7d's unbounded-lot-count leak, re-introduced from the other side. Inline
values on a securitised lot are harmless because the security WINS the merge, so they are
shadowed by definition and can never drift into being read. Moving the fields off positions
for real is the migration D10 is waiting on, and it is nobody's step yet.

#### 10.1b The security tier — item 3's "gains a dimension", made concrete

Design 65 gave the liquidation primitive two axes: which ALLOCATION class (Lever A) and
which LOT within it (Lever B). Step 6 adds a third, between them:

| axis | question | set by |
|---|---|---|
| Lever A | which asset class? | `sleeveOrder` / `sleeveWeights` / `sleeveScore` |
| **security tier** | **which instrument in that class?** | **`securityOrder`** |
| Lever B | which units of it? | `lotStrategy` |

"Raise cash out of the employer stock before touching the index fund" is none of the other
two — both lots are EQUITY, and it is not a statement about lots. Under Option A every
equity lot was the same undifferentiated thing, so the only way to say it was to arrange the
account by hand. **This is the first lever in the engine that Option C makes expressible at
all**, which is worth more than its size.

An **order, not a filter**, on the same reasoning `sleeveOrder` uses: a filter fails a draw
the named securities cannot cover; an order exhausts them and carries on. An id naming
nothing ranks with the unlisted rather than throwing — ids are scenario data and the registry
is projected later at load, so nothing can validate them where they are set.

#### 10.1c What wiring it up exposed: the design-65 levers were unreachable headlessly

`drawdownLotStrategy`, `drawdownSleeveOrder` and `drawdownRebalanceWeight` are scenario-schema
params read by the US_RETIREMENT toolset out of `cfg.parameters`. But `buildDefaultConfig`
neither enumerates them into its parameter bag nor forwards them — its forwarding loop
**deliberately skips scenario-schema keys**, since the enumerated block is supposed to own
them. So:

```js
loadScenarioSim({ params: { drawdownLotStrategy: 'HIFO' } }).sim.state.drawdownLotStrategy
// → 'FIFO'
```

No warning, no error. The UI path worked the whole time, because the editor writes the value
straight into a saved scenario's `parameters` — which is exactly why it survived: **two param
stores, and the only one being fed was the one a human fills in.** Every headless caller —
a golden, an MC arm, an optimizer probe naming `drawdownLotStrategy` in its search space
(`optimization-problem.js`), any test — was silently getting the default.

Fixed by naming all four in the enumerated bag. Every default is the historic no-op, so no
existing run moves; what changes is that the levers can now be set by something other than a
person clicking. It is the same family as `config-field-in-state-is-not-read`, and it is the
second time in this document that wiring a new lever end to end was what found an old one
that was never wired at all (§6.6 was the first).

The dynamic `sleeveWeight::<CLASS>` keys are NOT fixed here — they are read by
`sleeveWeightsFromParams(p)` off the same bag and have the same gap. Left alone deliberately:
it is a different key shape, and fixing it belongs with whoever next needs Lever A headlessly.

#### 10.1d The golden gained a target mix, and now holds both D10 branches

Per §9.8d this is a change to step 5's fixture rather than a twelfth golden.
`two-security-concentration` now runs `TARGET_ALLOCATION`, which puts the two cases D10
distinguishes in one run:

| account | its equity sleeve | what the rebalancer establishes |
|---|---|---|
| `k401Account` | one security (`sec-emp`) | `sec-emp` — more of the same thing |
| `usStockAccount` | two (`sec-emp` + `sec-exus`) | `sec-auto-EQUITY_US` — the generic market position |

Both are asserted directly in `security-position-identity.test.mjs`, because a fixture diff
cannot say which branch it is showing.

#### 10.1e What step 7 inherits

- The security tier has **no UI**: `drawdownSecurityOrder` is declared with an empty
  `options` list, because the ids are scenario data and the picker that reads the registry
  belongs with the security editor (item 6 above, step 9). A headless caller sets it today.
- `LOT_STRATEGY.SPECIFIC` is still the MIN_GAIN proxy (design 65 OQ3). §8.3 is now *half*
  built: a caller can say WHICH SECURITY, not yet WHICH LOTS of it under a bracket-aware
  rule.
- Nothing in step 6 touched tax. The security tier changes which lots are sold, so it moves
  realised gains around — which is precisely the surface **R2** has to measure before step 7
  is worth its size.

### 10.2 Step 9 implementation record  ✅ (2026-08-27)

Items **5** and **6** of §10's list, built. 5,726 unit + 1,147 viz tests green; **no golden
moved** — every change here is a read, a column or a control.

#### 10.2a The cube names the instrument, and adds no rows to any existing scenario

§3 item 6 said "reporting stops lying by omission". The lie was specific: `rateKey` names
the MARKET a bucket tracks, and a plan with 40% in one employer's stock and a plan with 40%
in a total-market fund produce **the identical row**. Concentration — the risk an allocation
view exists to show (§3 item 4) — was not merely unlabelled, it was unrepresentable.

`securityId` now joins `(allocation, rateKey)` in the bucket key, alongside a `security`
display column and a `units` column. The important property is what it does NOT do:

> **The new key adds zero cardinality to every scenario in the repo.** Step 3 gave every
> migrated equity lot the synthetic security for its own market, so `sec-auto-EQUITY_US` and
> `rateKey: EQUITY_US` are the same partition. A bucket splits only where an author put two
> real instruments in one sleeve — which is exactly the case the cube could not previously
> show.

Pinned by a test rather than asserted, because "additive" is the kind of claim that is true
when written and false three commits later.

Two smaller decisions with reasons:

- **`units` is emitted only when EVERY lot in the bucket has one.** A partial sum is worse
  than no number — an undercount presented as a count, which is the shape design 93 §5 spent
  eight defects on. Mixed and scalar buckets carry `null`.
- **`securityId` joined the row SORT too.** Without it, two instruments in one sleeve tie on
  `(stateKey, assetClass, rateKey)` and fall back to array order — which is `Object.entries`
  order, the very thing that sort exists to remove.

The panel gains a **By security** view (`by: ['security']`, filtered like the return-series
view so a house does not collapse into one enormous `(none)` band) and three CSV columns. The
CSV column list is now an exported constant: a column that exists on the row and not in the
export is a number nobody can trace back to the lot it came from, and no chart test can see
that.

**§10 item 5's other half — `accountBalanceKeys()` — needed no change, and the reason is
already in the code.** The cube header records that scoping accounts to the schema registry
"looks more precise and is strictly worse": loan accounts do not register under the `account`
display kind, so every loan silently vanished and the cube ran ~\$218k above net worth on a
real plan. Duck-typing on a numeric `balance` also means `state.securities` — a plain object
with no balance — is skipped without a special case. Re-verified by THE INVARIANT test, now
run against a book whose buckets are split by security.

#### 10.2b The editor's half: an editable box the engine ignores is a lie

The holdings editor is where §5.1's partition either becomes visible or becomes a trap.
`instrumentOf` merges `{ ...holding, ...security }`, so a lot that names a security has its
instrument fields decided elsewhere — and an editor that still showed a writable
`dividendYield` box would be a control that looks live, accepts input, and moves nothing.
That is §9.5b's defect transplanted into the UI, and it would be just as invisible: the
number stays plausible and the money stays right.

So the picker arrives with a rule attached. Every instrument-level control routes through
one helper: **declared by the security ⇒ rendered inherited** (disabled, showing the
instrument's value, captioned with which instrument); **silent ⇒ still the lot's to set**.

The test that mattered most is the third: **an explicit `null` on the security counts as
declaring.** The check is `field in sec`, not `sec[field] != null` — §4 rule 2, and the exact
shape of the `destinationKey` guard this repo has already been bitten by. A `??` here would
show a migrated lot's stale inline value as live and editable while the engine read null.

The fields stay RENDERED rather than hidden, deliberately: a control that vanishes leaves the
reader unable to see what the instrument actually says, which is the same lying-by-omission
the cube's new column fixes on the reporting side.

#### 10.2c §10.1e's assumption was wrong, and the correction is the useful part

Step 6 wrote that `drawdownSecurityOrder`'s empty `options` list would be filled by "the
picker that reads the registry [which] belongs with the security editor". That framing
assumed the picker DEPENDS on an editor. It does not, and the reason is step 3's own work:
**the four synthetic market securities are always present**, so a plan that authored no
instruments at all still has a registry with something in it — and "draw the international
sleeve before the domestic one" is expressible today, on any scenario.

So the param now resolves its options from the scenario record at render time
(`optionsFrom: 'securities'`), through `scenarioSecurityRegistry` — extracted at this step
because there is now a second caller, and a picker composed slightly differently would offer
instruments the run does not have. One call site, for the reason `state.people`'s three
drifted projections supply.

**Recorded limitation, not worked around:** the `EnumMulti` control expresses order by CHECK
ORDER (ticking appends), so there is no way to re-order without unticking. For a set-valued
param that is right; for an order-valued one it under-serves the parameter. A drag-orderable
variant is the honest fix and is not step 9's. ✅ **ANSWERED at step 10** — `ordered: true`
routes to a reorderable control (§10.3b). Step 10 also found that `optionsFrom` never reached
the param entry at all, so the resolver described above was dead on every path.

#### 10.2d Two defects the work uncovered

- **The holdings panel never passed the registry.** `snapshotHoldings` has taken a
  `securities` argument since step 1 and the panel passed none, so a position whose market
  lives on its security showed a blank column. `src/visualization` is outside §5.2's static
  read gate by design (§5.2's table counts its 22 references separately), which is exactly
  why this needed a test rather than a scan.
- **`?? ` was wrong for a display label.** `syntheticEquitySecurities` declares
  `symbol: ''` — an empty string is a real, deliberate value meaning "no ticker" — so
  `symbol ?? name ?? id` let it win and printed a blank cell. `||` is right for a LABEL and
  `??` is right for a VALUE, and the two are only distinguishable when something declares an
  empty one. Found by the test that asserted the fallback, not by looking at the code.

#### 10.2e What step 9 did not build, and why it is not blocking  — ✅ **all three built at step 10 (§10.3)**

**There is no UI to CREATE a security.** `cfg.securities` is authored data, like
`cfg.corporateActions` — deliberately not a service record (§4: a Security is plain frozen
data shared by reference), so a CRUD editor would need a graph node kind, a modal, and a
launch point, which is a chunk of its own rather than the tail of this one. §10's item 6
asked for "a security picker, and the holdings table gains columns", and that is what
shipped.

It is not blocking because of §10.2c: the picker, the drawdown order and the By-security view
all work against the synthetic set on a scenario that authors nothing. What an author cannot
yet do from the UI is add a *concentrated* position — which is the case §3 item 4 exists for,
and so the first thing a securities editor should be measured against.

Also untouched, and named so it is not mistaken for an oversight:

- **The snapshot table does not total units.** Summing counts of different instruments
  produces a number that looks like a quantity and is not one. ✅ **ANSWERED at step 10**, by
  changing the GROUPING rather than the rule: the Securities panel totals units *within* an
  instrument across accounts, and still never across instruments (§10.3c).
- **The unit columns are hidden, not em-dashed, for a scalar book.** Both modes are
  first-class (design 93 §5); a column of dashes says "missing data" about a representation
  that is deliberate.

### 10.3 Step 10 implementation record  ✅ (2026-09-02)

§10.2e's three named gaps, closed. 5,997 unit + 1,302 viz tests green; **no golden moved** —
every change here is an editor, a control or a read.

#### 10.3a The securities editor, and why it is still not a service

§10.2e said a CRUD editor "would need a graph node kind, a modal, and a launch point". It
got the modal and the launch point and **not** the node kind, and that is the decision worth
recording rather than the code.

Every other editable record in this app is a service record on the config graph, and the
`ConfigurationList` reads its rows from `graphQueryApi.getByKind`. The obvious way to make a
`Security` appear there is to give it a service. That would have been wrong twice over:
§4's first rule is that the registry is plain frozen data **shared by reference** across
every snapshot of a run (which is what took the workbench clone cost from +7.2% to +0.5%),
and a live service copy alongside `cfg.securities` is a second store of the same truth —
the shape this repo has already been bitten by in `state.people`'s three drifted projections
and in `cfg.params` vs `cfg.parameters`.

So the list takes an **injected row provider** for that one kind, and
`src/scenarios/scenario-securities.js` is the only writer. It writes to the active scenario
record, which is design 15's source of truth and where `serializeScenario` was already
reading `securities` from — so Save, Download, Rebuild and the run agree with no second
harvest step. `snapshotServices` does not touch the key, so the Save path cannot clobber it.

Three properties the form is built around, each of which is a defect if inverted:

- **Absent is not null, expressed as a control.** `instrumentOf` merges
  `{ ...holding, ...security }`, so a key merely PRESENT wins — an explicit `null` included
  (§4 rule 2). A form that wrote every box it rendered would silence every lot's inline
  value the moment a security was named. Every instrument field therefore carries a DECLARE
  toggle: off writes no key; on with an empty box writes an explicit `null`. The tri-state
  is the merge rule made visible, and a `??`-shaped form cannot express it.
- **Only fields the ENGINE reads are offered.** §10.2b's rule, applied to authoring. Five of
  `SECURITY_FIELDS` have no reader anywhere today — `qualifiedDividends`, `frankingCredit`,
  `currency`, `country`, `isGold` — and are exported as `UNREAD_SECURITY_FIELDS` with a test
  asserting the complement, so adding one to the entity without a reader is a decision
  somebody has to make in the editor rather than an accident. They are not DROPPED: the save
  starts from the record and edits it, so a value authored in JSON round-trips untouched.
- **The id is settable once.** A rename would orphan every lot naming it, silently, because
  `instrumentOf` falls back to the lot when a `securityId` resolves to nothing.

Delete does **not** rewrite the positions that name it, and says so at the point of deletion
with a count. Clearing the field on every lot from the editor is §11's fourth walk — *no
reducer may change a position's `securityId`* — committed one layer up.

The `idioVol` box carries §6.2's warning in its own tooltip, because it is the one field on
this form whose effect is not local: the draw set is the REGISTRY, so **declaring an unheld
security with idiosyncratic vol perturbs the whole run.** Authoring UI is exactly where that
price gets paid without anyone reading §6.2.

#### 10.3b The ordered control — and the defect it uncovered

`ordered: true` routes an `EnumMulti` to a reorderable list (numbered rows, arrows, drag,
and an Add picker) instead of the checkbox group. The group stays, because
`behavioralStrategies` is a SET and position means nothing in it; these are two controls
because they are two kinds of parameter, not one control with a flag.

Two implementation notes with reasons:

- **Drag state lives in the editor's closure, not on `dataTransfer`.** jsdom has no
  DataTransfer, so the other choice is a reorder control that cannot be tested — which is
  how the arrows silently stop working.
- **An option the scenario no longer offers is KEPT and marked**, not dropped. A security
  deleted while it was in the order would otherwise vanish from the control while remaining
  in the saved value: the panel and the run disagreeing, silently.

**And the useful finding: `optionsFrom` never reached the param entry.** §10.2c resolved
`drawdownSecurityOrder`'s options from the scenario registry at render time, and nothing in
`_mergeParamSchema` copied the flag off the schema onto `cfg.params` — `options`,
`visibleWhen`, `node` and `dynamicOptionsFrom` are each re-synced there by name, and this
one was not. So `_dynamicEnumOptions` returned null on **every** path and the picker drew an
empty list, on a fresh load as much as on a saved scenario.

The symptom is why it survived step 9's tests: an empty picker reads as *this scenario has
no securities* — a plausible answer — rather than as a lost field. It is the same family as
the stale-persisted-`node` defect, and the fix is the same shape: `optionsFrom` and `ordered`
are schema-owned metadata about the CONTROL (the user's selection lives in `value`), so they
are re-synced rather than backfilled, and cleared when the schema drops them.

#### 10.3c Units are totalled — by changing the grouping, not the rule

§10.2e recorded "the snapshot table does not total units" as a limitation, and the refusal
was right. But it left a real question unanswerable — *how many shares of this do I own?* —
because a plan holds one instrument across several wrappers and no view crossed them.

A per-SECURITY rollup is the grouping in which the sum is legitimate. So the rule does not
change, it becomes precise: **units total within a security and never across securities.**
`security-rollup.js` implements it over the allocation cube (not its own walk of `state` —
the cube is where `securityId` joined the bucket key, where FX conversion happens once, and
where THE INVARIANT is guarded), and `SecuritiesPlugin` renders it: one row per instrument,
expandable to the per-account breakdown whose counts sum to it.

The footer totals money and prints `n/a` under Units — not a blank, which reads as missing
data. `totalSecurityRollup` has no `units` field at all, so the rule lives where the next
author will hit it rather than in a comment.

Three smaller decisions:

- **`units` is null unless every contributing bucket has one**, extending the cube's own
  rule across accounts. A partial sum is an undercount presented as a count.
- **`avgPrice` is `marketValue / units`, and is labelled as a blended value, not a price.**
  §4 put the price on the POSITION, so across two accounts there is no single one.
- **The money headers name the currency the cells are actually rendered in.**
  `formatAmount` converts to the reader's display currency, so a header hard-coded to the
  cube's base labels an AUD column "USD" the moment the reader switches — which is exactly
  how the guardrail FX defect read.

Units are also the one figure on the panel that needs no conversion caveat: a count crosses
currencies untouched, which is why the cross-account sum is worth having at all.

#### 10.3d Verified in the running app, not only in jsdom

The reference plan, in a fresh browser profile: author `sec-emp` (β silent, `idioVol` 0.25)
from Nodes → Securities; it appears in the drawdown-order picker without a Rebuild
(§10.2c's resolver, now that the flag reaches the entry); point two lots in two different
wrappers at it; Rebuild and step forward eighteen months. The panel reports ONE row with
the two wrappers' counts summed under it and the breakdown adding back to it, and the
instrument's per-unit value has **separated from its sleeve's** — §6.2's per-security
overlay diverging an instrument from its market, on data authored entirely through the UI.
That path did not exist before this step.

**Unrelated defect found on the way, and FIXED — and it was not one panel but twelve:** a
saved layout with the Graph tab closed left `#graphRoot` absent, and
`WorkbenchApp.initScenario()`'s `getElementById` handed `null` to `ConfigGraphView`, which
dereferences it immediately. The throw was uncaught at boot, so everything after it was
skipped — including the scenario list, which made the app read as "no scenarios" with the
cause nowhere near it.

A plugin's `render()` runs on its first MOUNT, so a closed panel has no DOM; but these
panels do not OWN the components they display — the views, presenters, the animator and the
editor factory are all built at `initScenario()` regardless of whether anyone is looking.
Sweeping every tab showed **11 more panels with the same fatal shape** (`config-list`,
`inspector`, `timeline`, `exec-history`, `lineage`, and the three Monte-Carlo and three
Optimize panes), plus `chart`, where the symptom was milder and worse to diagnose: the chart
captured `null`, guarded on it, and stayed dead for the session even after the tab was
reopened.

`WorkbenchRuntime.paneHost()` now owns these elements — session lifetime rather than
visibility lifetime — and `hostPanePlugin()` is what the panels adopt them with. Pinned by
`tests/viz/workbench-boot-with-closed-tabs.test.mjs`, which boots the real app once per
closed tab: the bug arrives by ADDING a panel, so a per-panel unit test would not have
caught the next one. Nothing to do with securities; recorded here because this is where it
surfaced.

## 11. How this gets guarded

Design 93's tooling transfers almost unchanged, which is a good sign for the design:

- **The write gate** already forbids raw `{...h, marketValue}`; equity positions are covered by
  it the moment they are unitised.
- **The unit-derivation walk** (`marketValue === units × pricePerUnit`) applies verbatim.
- **The par walks** are bond-specific and simply do not fire on equity.
- **The instrument-accessor gate** (§5.2) ✅ **BUILT** (`tests/unit/instrument-read-gate.test.mjs`,
  §5.3d) — what makes the entity swap safe, and a ratchet rather than a proof, by the same
  bargain the write gate strikes.
- **A fourth walk** ✅ **BUILT at step 5** (`tests/unit/security-position-identity.test.mjs`,
  §9.8b): *no reducer may change a position's `securityId`.* A position is a
  position IN something; changing what it is in, in place, is the equity analogue of the par
  desync — it silently relabels history. A merger that genuinely replaces one security with
  another must do it as a disposal-and-acquisition, not a field write.
- **A fifth walk, from §9.4** ✅ **BUILT** (`tests/unit/holding-value-kind.test.mjs`, §9.6):
  *a PRICE move must leave `units` alone and a UNITS move must leave `pricePerUnit` alone.*
  The bug §9.4 describes conserves every number, so the assertions are about **which
  primitive ran**, not about what the value is — that is the only thing checkable. Verified
  non-vacuous by mutation: ignore the declared kind and 2 of its 13 tests fail while the rest
  of the repo stays green. The e2e version — a year of reinvested dividends must raise the
  unit count — ✅ **BUILT at step 3** (`equity-position-birth.test.mjs`, §9.7e).
- **The equity-position birth walk** ✅ **BUILT** (`tests/unit/equity-position-birth.test.mjs`,
  §9.7c): no reducer may BIRTH a scalar equity lot, every equity position in the final state
  carries a unit count and a `securityId`, and none of them carries a par. Reported as the
  TRANSITION, so the reducer named is the one that created the lot. It found a birth site
  §9.5c's audit did not name.
- **The RNG neutrality test extended** ✅ **BUILT at step 4** (§6.5):
  `equity-sleeve-rng-neutrality.test.mjs` pinned that the sleeve loop draws zero uniforms at
  σ=0; it now also pins that a registry of identity securities draws zero, that a β-only
  security draws zero (the beta term is a multiple of a deviation already drawn), that the
  draw set is the registry rather than the portfolio (an unheld σ>0 security moves the
  cursor), and that securities are iterated in sorted `id` order so authoring order cannot
  change which uniform each one consumes.
- **The registry-sharing tests** from §6.4.
- **The authoring rules, at the keystroke that breaks them** ✅ **BUILT at step 10**
  (`tests/unit/scenario-securities.test.mjs`): `scenarioSecurityRegistry` throws on a
  duplicate id and on the reserved `sec-auto-` prefix, and it throws at LOAD — on a scenario
  that no longer opens. The editor validates the whole resulting set through the same
  builder before committing, so the bad edit is never written.
- **The declare tri-state** ✅ **BUILT at step 10**
  (`tests/viz/editors/security-editor.test.mjs`): silent writes no key, declared-empty writes
  an explicit `null`, and an existing explicit null reads back as DECLARED. That last one is
  the case a `??`-shaped form gets wrong every time — it shows the box unticked and then
  deletes the author's statement on the first save.
- **The unread-field complement** ✅ **BUILT at step 10** (same file): every `SECURITY_FIELDS`
  entry is either offered by the editor or listed in `UNREAD_SECURITY_FIELDS`. Adding a field
  to the entity without a reader is then a decision, not an accident — §10.2b's rule turned
  into a gate.
- **A golden holding two securities in the same allocation** ✅ **BUILT at step 5**
  (`two-security-concentration`, §9.8a) — the coverage equivalent of
  design 93 §7's dated-bond golden, and for the same reason: without one, every per-security
  path is unreachable and green means nothing. It should hold a concentrated position with
  non-zero idio vol so the price-path branch is exercised, and a second position in the *same*
  security in a *different* account so §4's no-shared-price decision is observable rather than
  theoretical.

## 12. Decisions, and what remains

The first pass's §12 was eleven open questions. Eight are now decided; three are genuine
research and stay open. Old tags are kept because design 93 §8.2 cites §12.7.

| tag | question | status |
|---|---|---|
| **D1** (§12.1) | Growth-rate resolution and state size | **DECIDED.** Overlay, not a rate key — §6.3; precedence untouched. State cost measured **per clone and per run** — §6.4: +7% workbench, +5% optimizer, ~0 for Monte Carlo — and mitigated by sharing the registry by reference at step 2. |
| **D2** (§12.2) | Prove the byte-identical migration | **MEASURED, and the claim narrowed** — §9.3. Step 0 repeats it on a real golden. |
| **D3** (§12.3) | Wash sales | **SPLIT; R1 DONE for the US, R2 DONE and it re-split step 7 (§8.1f–g).** The *gap* is characterised (§8.1a), the *US rule* is quoted from `docs/` (§8.1b–c), the *AU rule* is Part IVA cancellation rather than deferral (§8.1d) with TR 2008/1 still to fetch. R2 is now measured: the exposure is real but small, and small for reasons that are the harvester's own artefacts — §8.1g holds 7b and recommends 7a. |
| **D4** (§12.4) | Shared price, or per-position price? | **DECIDED: per-position.** Two independent reasons — §4. The per-account-rate tension it exposes is **F2**. |
| **D5** (§12.5) | `assetKind` vs `allocation` | **DECIDED: no `assetKind`.** Design 90 §7.3 already closed this; C validates the pair through the existing containment guard — §4. |
| **D6** (§12.6) | Overlap with design 88 speculative assets and company equity | **DECIDED: separate, with one named seam.** A `Security` is a fungible instrument a position is held IN, inside an account; company equity is an untraded asset with a discrete liquidity event, its own `speculative` semantics (design 88 §2) and no unit count. Merging them would drag the metric-scope machinery into C for no gain. The seam is the *conversion*: an IPO or stock-for-stock sale deposits a **position in a security**, and that is the one place the two entities meet. Out of scope here. |
| **D7** (§12.7) | `cpiIndexRatio` under C | **DEFERRED, deliberately.** Bond-only, and re-opening design 66 inside C is scope creep. Position-level, unchanged. **F1.** |
| **D8** (§12.8) | Spin-off / merger tax mechanics | **DECIDED and BUILT at step 8.** R3 is done — §7.1 has the sources and §7.2 the record. The answer R3 returned is that **the two countries genuinely disagree three times** (boot recognition, post-merger basis, and whether a demerged interest's clock tacks), so this is per-country code rather than one transform with a tax flag. The "only if §7 goes past splits" caveat is answered in §7.1b: two of the five are events **nothing else in the engine can express**. |
| **D9** (§12.9) | Qualified-dividend holding-period test | **DECIDED: carry the flag, do not model the test**, and say so — §8.2. An annual tick cannot see a 61-day window. |
| **D10** (§12.10) | The rebalancer's security choice | **DECIDED and BUILT at step 3, and CLOSED at step 6.** `securityId` joined `_inheritedTraits`' unanimity set — §10 item 2, §9.7c. The collapse arrived at step 6 as BEHAVIOUR rather than as deleted code — unanimity is judged on the instrument, so one security answers all five fields — because the five cannot move off positions until bonds are securitised. §10.1a has the reasoning and the number it moved. |
| **D11** (§12.11) | Is `dividendYield` moving to the security behaviour-neutral? | **DECIDED: yes, if the fallback chain is preserved in order.** Today `h.dividendYield ?? fallbackYield` (`holdings-earnings.js:270`), where the fallback is the handler's account-level `dividendRate`. Under C: `instrumentOf(h).dividendYield ?? h.dividendYield ?? fallbackYield` — the security wins, an un-securitised holding keeps its inline value, and the account rate stays the floor. Pin it with a three-case test. |

**Remaining research** (each blocks only the step that needs it):

- **R1 — wash-sale primary sources.** ✅ **DONE.** Eight sources on disk and cited by path in
  §8.1: §1091, §1.1091-1, §1.1091-2, §1223(3), Rev. Rul. 2008-5, Pub. 550 ch. 4, TA 2008/7,
  and ITAA 1936 Part IVA. **One outstanding: TR 2008/1**, which TA 2008/7 defers to for the
  ATO view and its worked examples. `ato.gov.au` and AustLII both 403 automated fetches, so
  it has to arrive by hand. The AU paragraphs in §8.1d rest on the Alert until it does, and
  no AU wash-sale code should be written before then.
- **R2 — wash-sale materiality.** ✅ **DONE — §8.1f.** 25 seeds x 3 arms. The window claim
  is confirmed at **100%** — every realised loss in 75 runs has a substantially-identical
  purchase inside the 61-day window — and about half of it lands in a sheltered wrapper,
  where Rev. Rul. 2008-5 destroys it. But the permanent money is **\$740–\$1,582 per
  lifetime path, 0.3–0.5% of US tax**, and it is that small because of two artefacts of the
  harvester rather than anything about the world: a \$3,000/yr cap on the HARVEST, and
  `resolveSubstitute` silently switching the strategy off (2.6–4.0 skipped harvests/path).
  The dispersion precondition was met by **step 4**, not by design 90 §7.4. Verdict in
  §8.1g: **split step 7** — 7a (the sheltered wash, small, all the permanent money) and the
  harvester fixes now; 7b (full §1091 basis machinery, timing only) held.
- **R3 — spin-off / merger mechanics.** ✅ **DONE — §7.1.** Sixteen sources on disk and
  cited by path: §§301/305/307/354/355/356/358/368, 26 CFR §§1.301-1/1.358-1/1.358-2,
  §1223(1)(B), and ITAA97 Div 125, Subdiv 124-M, s104-135 and s115-30. The finding is
  **three genuine US/AU disagreements**, each with a worked example in its own statute,
  and one agreement (return of capital). Unblocked step 8, which is built.
- **F5 (new, §8.1m) — the event queue's comparator is not a total order.** `(date) || (order)`
  leaves same-date, same-order events tied, and a heap resolves ties by array position, so
  ADDING ANY EVENT re-resolves ties among unrelated events elsewhere. Measured: imposing a
  deterministic tie-break moves **560 fields across eleven goldens, worst \$391,453, 64 fields
  dropped**. Which of two same-date events runs first is worth six figures over a long run and
  nothing decides it. Choosing the right order is a semantic question, not an alphabetisation,
  so this needs its own design — and until it has one, **every new EventSeries re-golds the
  repo**, which is a tax on exactly the kind of work this document keeps doing.
- **F4 (new, §8.1k) — a `TAX_FILE` event, separating the tax year's END from the return's
  FILING.** §8.1h's fork was framed as a binary and both halves assumed those are one event.
  Separating them removes every approximation §8.1i needed, and — unlike moving the settle —
  moves no fixture. Proposed, not scheduled.
- **R4 (new, from §8.1i) — is there an authority extending Rev. Rul. 2008-5 to a 401(k)?**
  The reference plan's sheltered equity lives in a 401(k), and nothing on disk reaches it, so
  the modelled disallowance sits far below the measured ±30-day exposure. That gap is a
  research question, not a modelling one. Blocks nothing; it only sizes §8.1i.

**Follow-ups recorded, not scheduled:**

- **F1** — `cpiIndexRatio` as a derived instrument/position pair (design 93 §12.7's real
  question, deferred here).
- **F2** — per-account growth-rate overrides on a securitised holding are a modelling
  contradiction once positions name securities. Not C's to resolve; C must not resolve it by
  accident either.
- **F3** — reinvested dividends and retained coupons add no basis while accretion and cash
  interest do. Tax question; `design/inconsistencies.md`.

## 13. Sequencing

Ordered so the decision-heavy work comes after the cheap experiments that could invalidate it,
and so the two silent hazards are fixed before the change that makes them reachable.

| step | what | size | gate |
|---|---|---|---|
| 0 | ✅ **DONE** — §9.3 spike against the real goldens, §9.2 projection-path audit, §6.4 clone measurement on a real plan | small | outcome in §9.5; both probes committed |
| 1 | ✅ **DONE** — §5.2 convert consumers to `instrumentOf(h, securities)` + the static gate | medium | §5.3 has the record; 23 sites in 12 files, no golden moved |
| 2 | ✅ **DONE** — `Security` entity, registry, serialization, round-trip + §6.4's `cloneState` + freeze | small | §4.1 has the record; the mitigation took `full` from +7.2% to +0.5% |
| 2a | ✅ **DONE** — §9.4 `valueKind` discriminator + the fifth invariant walk | small | §9.6 has the record; 5,518 tests green, no golden moved |
| 3 | ✅ **DONE** — synthetic securities + equity unitisation, at the boundary AND at every birth site (§9.5c) | medium | §9.7 has the record; 551 new fields, worst absolute move \$0.62; 5,575 tests green |
| 4 | ✅ **DONE** — price path for `idioVol > 0` securities + the extended RNG-neutrality test | small | §6.5 has the record; the re-gold the gate asked for was **empty** — the identity holds, 5,594 tests green |
| 5 | ✅ **DONE** — a two-security golden (concentrated + same security in two accounts) + the fourth walk | small | §9.8 has the record; it found §6.6's latency defect on its first run |
| 6 | ✅ **DONE** — rebalancer + drawdown security awareness | small–medium | §10.1 has the record; D10's collapse is behavioural, and wiring the lever found the design-65 params unreachable headlessly |
| 7a.1 | ✅ **DONE** — the harvester's artefacts: uncap, record the skip, and rotate into a SECURITY | small | §8.1h has the record; it **tripled** the exposure R2 measured, which was measuring a broken strategy |
| 7a.2 | ✅ **DONE** — the SHELTERED wash (Rev. Rul. 2008-5: disallow, no basis uplift) | small–medium | §8.1i has the record; lagged onto the carryforward per the fork, with the unabsorbed 93% recovered as gain |
| 7c | ✅ **DONE** — `TAX_FILE`: the tax year's END and the return's FILING are two events | small–medium | §8.1l is the spec, §8.1m the record. Scheduled LAZILY, which is both why no fixture moved and what an amendment actually is. Uncovered **F5** |
| 7b | ✅ **DONE** — full §1091 on the taxable branch: disallow, basis transfer, §1223(3) tack-on, share matching | small, not large | §8.1j has the record. R2 sized it as large by assuming the wash had to be FOUND; the dominant one happens inside one action with both lots in hand. Remaining gap: a taxable replacement bought elsewhere in the window |
| 8 | ✅ **DONE** — corporate actions beyond splits: rename, spin-off, merger (stock / boot / all-cash), return of capital | medium | §7.1 has R3, §7.2 the record. **No golden moved** — the toolset is inert with nothing authored, which is F5 compliance rather than luck. The e2e run found the sheltered-wrapper error the unit tests could not (§10.1c again) |
| 9 | ✅ **DONE** — reporting: the cube names the instrument (+ a By-security view and CSV columns); UI: the holdings editor's security picker with inherited instrument fields, the snapshot table's Security/Units/Price columns, and `drawdownSecurityOrder`'s options | medium | §10.2 has the record. No golden moved. It found two defects — the holdings panel never passed the registry, and `??` was the wrong operator for a display label — and corrected §10.1e's assumption that the picker needed an editor first |

| 10 | ✅ **DONE** — §10.2e's three gaps: the securities editor (a node kind in the list, not a service), `ordered: true` for an order-valued multi-select, and the cross-account Securities panel that totals units per instrument | medium | §10.3 has the record. **No golden moved.** It found `optionsFrom` never reaching the param entry, which made step 9's dynamic picker dead on every path |

Step 8's five kinds close §7's table except for the two it names as out of scope in §7.2e
(stock dividends under §305(b), and §368 qualification), both of which need facts a scenario
does not carry.

**Design 94 is complete.** Steps 0–5 are the substrate; 6–9 are the value; 10 is the
authoring surface that makes 6–9 reachable without hand-editing JSON. What remains is
recorded rather than scheduled: §8.3's other half (`LOT_STRATEGY.SPECIFIC` is still the
MIN_GAIN proxy), and the three follow-ups F1–F3 plus F4/F5 in §12.

**Splitting the release at step 5 is deliberate**:
after step 5 the model represents securities correctly and behaves as it does today up to a
documented cent, which is a shippable, reversible state.

Two changes from the first pass's ordering, both forced by §0: **2a is new and is a hard
precondition of 3**, and **step 3's gate is a re-gold rather than the absence of one**.

## 14. References

- design 93 — the units substrate; §6 chose Option C, §6.2 lists what A was constrained to do
  so this document is additive, §6.3 estimates the cost §0 revises, §8.2 is the handover.
- design 90 §7.4 — the open dispersion step. §6.2 is written so the two compose rather than
  race; §1.2/§1.3 are why losses are structurally near-impossible today and why §8.1's
  substitute rule is the shape it is.
- design 90 §7.3 — `ALLOCATION` stays a closed four-value enum with markets as a sub-axis;
  that decision is what closes D5.
- design 74 §4/§5 — the one-market-draw return process, the RNG-cursor rule §6 must obey, and
  the σ²/2 drift compensation §6.2 extends.
- design 75 §4.2 A2 — property returns bypass `effectiveGrowthRates` entirely. The precedent
  §6.3 follows.
- design 78 — telemetry and clone cost; the reason §6.4 is a design decision and not a
  footnote.
- design 65 — the `consumeHoldings({selection})` seam specific identification plugs into.
- design 61 — the rebalancer, whose `_inheritedTraits` already answers D10.
- design 88 — speculative assets and company equity; D6 says why they stay separate.
- design 87 §13 — the observed-data replay overlay, if per-security price history is ever
  wanted.
- **Primary sources on disk** — the eight files listed at the top of §8.1. Per this repo's
  rule, nothing in §8.1 is quoted from memory; every rule cites a file in `docs/`.
