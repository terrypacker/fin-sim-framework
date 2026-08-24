# 94 — Equity as security positions (design 93's Option C)

**Status** (2026-08-24): **DRAFT — first pass, written from the substrate that design 93 §5
left behind.** Not ready to build. §12 lists what has to be researched or measured before it
is, and several of those could change the shape of §4–§7. One more design session is
expected before sequencing.

Design 93 asked whether units-as-substrate was the foundation for equity shares and answered
**yes, later**: Option A (units for bonds only) now, Option C (equity as positions in named
securities) as the destination, B (a synthetic unit for equity) rejected because a fiction in
a substrate gets taken literally by the next author. §5 of that document is closed. This one
works out what C actually is.

**Two findings from reading the engine reshape the estimate before anything else, and both
cut in the same direction.** Design 93 §6.3 named the per-security price path as C's real
cost — *"state size and RNG draws scale with the number of distinct securities rather than
with the four allocation classes"*. That is true only if every security gets its own draw,
and it does not have to:

1. **A security that tracks a market costs nothing extra.** `EquityReturnTickHandler` already
   draws ONE market factor and loads each sleeve on it via beta, and it already **skips the
   idiosyncratic draw entirely** when `σ_idio` is 0 rather than drawing and multiplying by
   zero — precisely so the idio-off path reproduces the market-only path bit for bit. A
   security declared as "tracks `EQUITY_US`, no idiosyncratic vol" therefore consumes **zero
   extra RNG draws and zero extra state**. The cost is paid per *concentrated* position, not
   per security, and a plan holding six index funds pays nothing.
2. **The migration can be numerically byte-identical.** Every existing equity bucket becomes
   a synthetic security tracking the `rateKey` it already carries, with zero idio vol. The
   growth path resolves security → rateKey → the same rate it reads today, so **no golden
   moves on the migration itself**. That turns C's riskiest step — "what does a saved
   scenario's EQUITY sleeve become when it has no ticker?" — into a mechanical one.

Both need confirming (§12.1, §12.2), but if they hold, C is smaller than §6.3 estimated and
the expensive part is not the representation at all — it is the tax machinery a named
security makes *reachable* (§8).

---

## 1. What this inherits, and what it is therefore not allowed to change

Design 93 built the substrate deliberately so that C is a data migration plus new entities,
never a rewrite. What is already in place, and the constraint each one imposes:

| built | constraint on C |
|---|---|
| `units` is generic and never bond-gated (§6.2 item 1) | C must not add `if (allocation === EQUITY)` to the substrate either. Instrument behaviour belongs in reducers. |
| Two first-class modes — SCALAR and UNITISED (§6.2 item 2) | **C is exactly "flip equity from scalar to unitised".** Every primitive already handles both as supported paths. |
| `instrumentOf(h)` as the single read path for instrument-level fields (§6.2 item 3) | C changes ONE function — `return securities[h.securityId] ?? _inline(h)` — instead of every consumer. But see §5.2: almost nothing reads it yet, so converting the consumers IS the work. |
| `securityId` reserved, nullable, round-tripping since §5a (§6.2 item 4) | C never touches the serializer, the schema registry, or the round-trip tests to introduce it. |
| `split()` (§5.4 item 6) | The corporate-action primitive exists and came back clean — four lines, basis and acquisition dates untouched. |
| The lot rule + `lotVintage` (§5.0a, §5.4a) | A purchase is a lot, and lots already carry their own vintage. Per-security lots need no new concept. |
| `compactLots` with an EXCLUSION key (§5.5) | **Free correctness**: `securityId` is not in any policy's mergeable set, so lots in different securities can never merge. C needs no compaction change. |
| Three invariant walks + the write gate | The par/unit invariants transfer to equity unchanged; §11 says what a fourth walk would have to hold. |

**The rule that binds hardest**: design 25's *state is plain data, no derived getters* —
`structuredClone` silently drops getters and it is used by history, MPC injection and replay.
A `securities` registry in state must be a plain map, and `instrumentOf` must be a free
function, not a method.

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

## 3. What C buys, stated plainly

Worth being explicit, because "equity shares" sounds like a representation change and the
representation is the cheap part.

1. **A position has an identity.** "500 shares of VTI" rather than "\$71,000 of EQUITY_US".
   Everything below follows from that.
2. **Wash sales become expressible** (US §1091). Today a tax-loss harvest cannot be
   disallowed because there is no notion of buying back *the same thing* — a sale and a
   repurchase inside 30 days are indistinguishable from a rebalance. This is the largest
   single fidelity gap C closes, and it is the one that can change a plan's answer: design
   58/61's harvesting levers currently bank losses the IRS would disallow. **Magnitude
   unmeasured — §12.3.**
3. **Concentration risk becomes modellable.** A plan with 40% in one employer's stock is a
   different plan from one with 40% in a total-market fund, and today they are the same
   object. Design 88's speculative assets and design 93's company equity gesture at this;
   C is the general case (§12.6 asks whether they should merge).
4. **Specific-identification lot selection becomes real.** Design 65's `consumeHoldings({selection})`
   seam already exists and already supports lot strategies; today "specific ID" can only
   mean "pick a lot", not "pick a lot of THIS security".
5. **Reporting stops lying by omission.** The allocation cube (`ASSET_CLASS` is report-only)
   can name what is actually held.

**What it does not buy**: better returns modelling. A security tracking a market key has
exactly the return process it has today. Fidelity improves only where a position genuinely
is not the market — which is the point of making the price path opt-in (§6).

## 4. The `Security` entity

A plain-data record, registered like `collectibles` / `companyEquities` / `realProperties`
already are in `cfg`, and projected into `state.securities` as a plain map keyed by id.

```
Security {
  id                 // 'sec-vti', stable; what Holding.securityId names
  symbol             // 'VTI' — display only, never a lookup key
  name               // 'Vanguard Total Stock Market ETF'
  assetKind          // EQUITY | BOND | FUND | ... — see §12.5, this is the field most
                     //   likely to collide with `allocation` and needs a decision
  rateKey            // the market it tracks: EQUITY_US, EQUITY_INTL_EX_US, …
  beta               // loading on that market's factor (default 1.0)
  idioVol            // annualized idiosyncratic sd; 0 (default) ⇒ NO extra RNG draw
  dividendYield      // instrument-level; today this sits on Holding
  currency           // the currency it trades in
  country            // situs, for source rules (design 73)
  taxExemption       // 'none' | 'state' | 'federal' — a muni fund is a security
  issuingState       // for the design 59 Treasury/muni split
  qualifiedDividends // US: does its distribution qualify for the preferential rate
  frankingCredit     // AU: franking percentage (design 76 / the AU dividend path)
  // bond instrument fields move here too — see §5.1
  parPerUnit, couponRate, couponFrequency, maturityDate, duration,
  zeroCoupon, inflationLinked
}
```

**`id` is stable and `symbol` is decoration.** A symbol change is a corporate action (§7),
and if the symbol were the key a rename would orphan every lot.

**Deliberately absent: a price.** A security's price lives on the *position*
(`pricePerUnit`), because design 93 §3 made value flow from the count and because two
accounts holding the same security at different cost bases are two positions, not two
securities. Whether a security should ALSO carry a shared current price — so two accounts
holding VTI cannot drift apart — is a real question and is **§12.4**.

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
| `cpiIndexRatio` — see below | `symbol`, `name`, `assetKind` |
| `securityId`, `id`, `label` | |
| `rollAtMaturity`, `rollTermYears` — see below | |
| `fxBasisRate` (design 87 §988 basis) | |
| `taxLossPartner`, `appreciationSchedule` | |

Two rows design 93 §9 flagged as uncertain, now with an answer and its reasoning:

- **`cpiIndexRatio` is POSITION-level**, and this is not obvious. The *indexation ratio of
  the bond* is an instrument fact — every holder of the same TIPS has the same one. But
  design 93 §5b deliberately made it per-lot so that a TIPS bought seasoned carries the
  ratio it was bought at, and so that a roll can restart it. Under C the honest model is
  that the SECURITY carries a reference index level and the POSITION carries its own
  acquisition level, with the ratio derived — which is the same shape as
  `acquisitionPriceLevel` and the AU CPI indexation. **That is a change to the §5b
  representation and needs its own decision (§12.7).** Until then it stays on the position
  and C leaves it alone.
- **`rollAtMaturity` / `rollTermYears` are POSITION-level**, confirming §9 item 4's tentative
  call. Two holders of the same bond can disagree about whether they roll it; it is ladder
  POLICY attached to a position. The tell is that `BondLadderReducer` sets them from its own
  configuration, not from anything about the instrument.

### 5.2 The seam is built but empty, and that is the real work

`instrumentOf(h)` exists and returns the inline fields. **Nothing calls it.** It was shipped
dark in design 93 §5a so that C would change one function instead of every consumer — but
the consumers were never converted, so today the codebase still reads `h.couponRate`,
`h.maturityDate`, `h.taxExemption` directly in the bond reducers, the earnings paths and the
tax classifiers.

**So C's first phase is not the `Security` entity. It is converting the consumers to the
accessor while it still returns inline fields** — a pure refactor, provably behaviour-neutral,
and testable by a static pass in the shape of the design-93 §4 write gate: *no direct read of
an instrument-level field outside `instrumentOf`*. That gate is what makes the entity swap
in a later phase a one-line change rather than an audit.

Doing it in that order also means the refactor can be abandoned or paused without leaving
half a `Security` behind.

## 6. Price paths — the cost, and why it is opt-in

### 6.1 The existing generator, and the constraint it imposes

`EquityReturnTickHandler` fires annually, draws **one** market factor from the seeded
`sim.rng`, and gives each of the four `EQUITY_SLEEVES` a deviation of
`beta·marketDev + σ_idio·√dt·z_sleeve`. One market draw drives everything, so systematic risk
survives portfolio aggregation — design 74 §4 explicitly rejects independent per-sleeve draws
because they diversify away the risk the exercise measures. **That reasoning applies with
more force to securities**: 30 independently-drawn stocks would produce a portfolio far less
volatile than any real one.

The handler carries a warning C must obey:

> ⚠️ **RNG-cursor ordering.** Idiosyncratic draws consume extra uniforms, so enabling them
> shifts every subsequent draw. Sleeves are iterated in the stable sorted `EQUITY_SLEEVES`
> order, and the idio draw is **skipped entirely** when `σ_idio` is 0.

### 6.2 The design that follows from it

Securities load on the same single market factor, in a stable sorted order, **after** all
existing sleeve draws, and a security with `idioVol === 0` **draws nothing**:

```
dev[security] = beta[security] · marketDev[security.rateKey]
              + (idioVol > 0 ? idioVol · √dt · z_security : 0)
```

Consequences, and they are the whole cost argument:

- **A portfolio of index funds is bit-identical to today.** Zero extra draws, zero extra
  state, no golden moves. This is what makes the migration in §9 free.
- **Cost scales with concentrated positions, not with securities.** A plan with one employer
  stock pays one extra draw per year.
- **Enabling idio vol on a security is a re-baseline for that scenario**, exactly as enabling
  sleeve idio vol already is. Expected and documented, not a surprise.
- **Ordering must be stable and defined once.** Sorted by `security.id`, appended after the
  sleeves. Any other rule and two runs of the same scenario diverge.

### 6.3 What is still unknown

State size per path, and whether `effectiveGrowthRates` should carry per-security entries at
all or whether the reducer should resolve security → rateKey at read time. The second is
almost certainly right — it keeps state flat and costs a map lookup — but the growth path's
per-account `<rateKey>::<stateKey>` override precedence (design 55 §8) has to keep working,
so the resolution order becomes three-deep: `<securityId>` → `<rateKey>::<stateKey>` →
`<rateKey>`. **Needs a measurement and a written precedence table — §12.1.**

## 7. Corporate actions

`split()` is built. The rest are dated events in the existing event-series machinery, each
a reducer over the affected positions:

| action | effect | notes |
|---|---|---|
| **Split / reverse split** | `split(h, ratio)` on every position | Built. Value-, basis- and holding-period-neutral. |
| **Symbol change / rename** | `security.symbol` only | Why `id` is not the symbol. |
| **Cash dividend** | already modelled; C makes the rate instrument-level | Touches the qualified/franked classification — §8. |
| **Spin-off** | basis apportioned between parent and new security by relative FMV; holding period **carries over** (§1223) | The one with real tax content. Needs research — §12.8. |
| **Merger / acquisition** | cash → disposal; stock-for-stock → carryover basis, no disposal | Same. |
| **Return of capital** | reduces basis, not income, until basis is exhausted | Interacts with `costBaseByCountry`. |

**Priority judgement**: splits and symbol changes are cosmetic-but-cheap; spin-offs and
mergers carry the tax content and the risk. A first C release could ship with splits only and
still be honest, provided the doc says so.

## 8. What a named security makes reachable — and why this is the expensive half

### 8.1 Wash sales (US §1091)

The reason to want C, and the part I know least well.

Today, `TaxLossHarvestHandler` sells a losing lot and the rebalancer buys equity back —
possibly the same day, certainly within 30 days. Nothing disallows the loss, because nothing
can say the repurchase is *substantially identical*. With securities it can.

What this needs, none of which should be written from memory:

- the exact §1091 window (30 days before AND after), what "substantially identical" covers
  for funds tracking the same index, the basis adjustment to the replacement lot, and the
  holding-period tack-on;
- whether the disallowance applies across accounts (it does, including IRAs, under Rev. Rul.
  2008-5 — **verify**);
- the AU position, which is not a mirror: Australia has no §1091 but has anti-avoidance
  doctrine (TA 2008/7 and Part IVA) that can strike down a wash sale. Whether that is
  modellable at all is a genuine open question.

**Deep dive §12.3.** Per this repo's rule, the primary sources go into `docs/` and are cited
from there before a line is written — never quoted from memory.

### 8.2 Dividend character

`qualifiedDividends` and `frankingCredit` are instrument facts that today are approximated at
the sleeve level. Moving them onto the security is easy; what is not easy is that the US
qualified-dividend rules have their own holding-period test (61 days in the 121-day window
around ex-dividend), which the model has no ex-dividend dates to evaluate. **Likely answer:
carry the flag, do not model the holding-period test, and say so.** Flagged rather than
decided — §12.9.

### 8.3 Specific identification

Design 65's selection seam already takes a lot strategy. Adding "of this security" is small
once positions are per-security. Low risk, real value, good early win.

## 9. Migration

Every existing equity holding gets a synthetic security derived from what it already carries:

```
sec-auto-<rateKey>   { rateKey, beta: DEFAULT_EQUITY_BETA[rateKey], idioVol: 0,
                       symbol: '', name: '<market> index', assetKind: EQUITY }
```

and then `promoteToUnitised`-style unitisation at the config→run boundary
(`projectHoldingsToState`, which already exists and already does this for bonds):
`units = marketValue / pricePerUnit` at an arbitrary `pricePerUnit` of 100, matching the
`PAR_PER_UNIT` convention design 93 §5b settled for exactly this reason.

**The claim to verify (§12.2): this is numerically byte-identical.** The security has zero
idio vol so it draws nothing; it resolves to the same `rateKey` so it grows at the same rate;
unitisation is value-preserving by construction and design 93 already proved that path on
bonds (`units` + `pricePerUnit` reproduce the stored `marketValue` exactly). If it holds, the
migration phase can ship with **no golden movement at all**, which is a very strong position
to be in for a change this size.

Saved scenarios on disk are never rewritten — promotion is an act at the run boundary, not a
side effect of deserialization. That rule is design 93 §5b's and C inherits it.

## 10. Blast radius

Where per-security positions are felt, roughly in descending order of risk:

1. **Tax paths** — dividend classification, disposal character, §988 (a foreign-currency
   security), the AU franking path, wash sales. Highest risk, and §8 is why.
2. **Rebalancing (design 61)** — the rebalancer buys and sells *allocations*. With securities
   it must choose WHICH security to buy, which is a new policy decision it does not currently
   have. Probably: buy the largest existing position in that allocation, or a designated
   default security per (allocation, account). **Needs a decision — §12.10.**
3. **Drawdown selection (design 65)** — already pluggable; gains a dimension.
4. **Lot count** — more securities means more lots; §5.5's compaction handles it correctly
   without change (different `securityId` ⇒ never merged), but the counts go up. Measure.
5. **Reporting / the allocation cube** — mostly an improvement, but `accountBalanceKeys()`
   and the cube's domain assumptions need checking.
6. **Workbench / account editor UI** — a security picker, and the holdings table gains
   columns. Real work, low risk.
7. **MC runner and MPC** — state size per path; snapshot cost; `serializeScenario`.

## 11. How this gets guarded

Design 93's tooling transfers almost unchanged, which is a good sign for the design:

- **The write gate** already forbids raw `{...h, marketValue}`; equity positions are covered
  by it the moment they are unitised.
- **The unit-derivation walk** (`marketValue === units × pricePerUnit`) applies verbatim.
- **The par walks** are bond-specific and simply do not fire on equity.
- **A new fourth walk is needed**: *no reducer may change a position's `securityId`.* A
  position is a position IN something; changing what it is in, in place, is the equity
  analogue of the par desync — it silently relabels history. Corporate actions that genuinely
  replace one security with another (a merger) must do it as a disposal-and-acquisition, not
  a field write.
- **A golden holding two securities in the same allocation** is the coverage equivalent of
  §7's dated-bond golden, and for the same reason: without one, every per-security path is
  unreachable and green means nothing. It should hold a concentrated position with non-zero
  idio vol, so the price-path branch is exercised.
- **The instrument-accessor gate** (§5.2) is new and is what makes the entity swap safe.

## 12. What needs a deep dive before building

Ordered by how much they could change the design above.

1. **§12.1 — Growth-rate resolution and state size.** Confirm the three-deep precedence
   (`<securityId>` → `<rateKey>::<stateKey>` → `<rateKey>`) works with design 55 §8's
   per-account overrides, and measure state size and snapshot cost per MC path with, say, 20
   securities. *Could change §6.3.*
2. **§12.2 — Prove the byte-identical migration.** Build the synthetic-security mapping
   against one golden and confirm zero movement. If it does not hold, C's risk profile changes
   completely and the phasing in §13 has to change with it. *Highest-value cheap experiment.*
3. **§12.3 — Wash sales.** Primary sources into `docs/` first (§1091, Rev. Rul. 2008-5, Pub.
   550), then the AU question (TA 2008/7, Part IVA). Then measure how often the existing
   harvesting levers would actually trip a wash sale — if the answer is "rarely", §8.1 stops
   being the reason to build C. *Could change §3's whole justification.*
4. **§12.4 — Shared price, or per-position price?** Two accounts holding VTI: one security,
   two positions, and today nothing stops their `pricePerUnit` drifting apart. A shared price
   on the security is more honest but breaks design 93 §3's "value flows from the position".
   *Structural; decide before §5 is implemented.*
5. **§12.5 — `assetKind` vs `allocation`.** `allocation` is a closed, authoritative
   four-value enum and this repo has already been bitten by a second classifier drifting from
   the first. Either `allocation` is derived from the security and stamped, or `assetKind`
   does not exist. *Decide before the entity is written.*
6. **§12.6 — Overlap with design 88 speculative assets and company equity.** Both already
   model a single concentrated holding with its own value behaviour. Does `Security` absorb
   them, sit beside them, or ignore them?
7. **§12.7 — `cpiIndexRatio` under C.** See §5.1. Whether the reference index level moves to
   the security and the ratio becomes derived.
8. **§12.8 — Spin-off / merger tax mechanics**, if §7 is to go past splits.
9. **§12.9 — Qualified-dividend holding-period test**, or the documented decision not to
   model it.
10. **§12.10 — The rebalancer's security choice.** Which security a buy establishes. Affects
    design 61 directly.
11. **§12.11 — Whether `dividendYield` moving to the security is behaviour-neutral.** It is
    currently per-holding with a fallback to the account rate; the fallback chain has to
    survive.

## 13. Provisional sequencing

Deliberately ordered so the risky, decision-heavy work comes after two cheap experiments that
could invalidate it.

| step | what | size | gate |
|---|---|---|---|
| 0 | §12.2 migration spike + §12.1 measurement | small | throwaway; informs everything |
| 1 | §5.2 convert consumers to `instrumentOf` + a static gate | medium | behaviour-neutral refactor |
| 2 | `Security` entity, registry, serialization, round-trip | small | mirrors `Collectible` |
| 3 | Migration: synthetic securities + equity unitisation | medium | target: no golden moves |
| 4 | Price path for `idioVol > 0` securities | small | RNG ordering is the whole risk |
| 5 | A two-security golden + the fourth invariant walk | small | do BEFORE 6 |
| 6 | Rebalancer + drawdown security awareness | medium | needs §12.10 |
| 7 | Wash sales | large | own document, gated on §12.3 |
| 8 | Corporate actions beyond splits | medium | gated on §12.8 |
| 9 | UI / reporting | medium | independent |

Steps 0–5 are the substrate; 6–9 are the value. **Splitting the release there is deliberate**:
after step 5 the model represents securities correctly and behaves exactly as it does today,
which is a shippable, reversible state.

## 14. References

- design 93 — the units substrate; §6 chose Option C, §6.2 lists what A was constrained to do
  so this document is additive, §6.3 estimates the cost this document revises.
- design 90 §7 — moved equity granularity from the account WRAPPER to a MARKET axis
  (`EQUITY_US`, `EQUITY_INTL_EX_US`, …). **A security is the next refinement of that same
  axis**, which is why C is a continuation rather than a new idea.
- design 74 §4/§5 — the one-market-draw return process and the RNG-cursor rule §6 must obey.
- design 65 — the `consumeHoldings({selection})` seam specific identification plugs into.
- design 61 — the rebalancer that has to learn which security to buy.
- design 88 — speculative assets; the closest existing thing to a concentrated single holding.
- design 87 §13 — the observed-data replay overlay, if per-security price history is ever
  wanted.
