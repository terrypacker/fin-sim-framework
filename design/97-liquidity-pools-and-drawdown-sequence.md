# 97 — Liquidity Pools: the unified drawdown sequence (scaffolding)

**Status**: **Built** (2026-08-29) — §3 only. §§6.1/6.3/6.4 of the prior study's gap list stay
open by design. Tests: `tests/unit/evt-drawdown-sequence.test.mjs` (7).
**Related**: `design/53-account-basis-refactor-and-offset.md` (offset accounts),
`design/54-loan-liability-accounts.md`, `design/65-allocation-aware-drawdown.md` (the
`consumeHoldings({selection})` seam this extends), `design/61-holding-allocation-lever.md`
(the rebalancer that refills), `design/29-behavioral-layer.md`.
**Prior evidence**: `scenarios/offset-bucket-study/FINDINGS.md` §6 — the four gaps between
"three pools" as a strategy and what the engine can express. This design implements §6.2
only, and states precisely why the other three can wait.

---

## 1. The one thing that is missing

A pool strategy is an **ordered list of places to take money from**. The engine has two
orderings and no way to interleave them:

- **Accounts** are ordered by `account.drawdownPriority` (savings 0, super 1, 401k 2,
  roth 3, brokerage 4, ira 5) in `AccountService.replenishSavings`.
- **Sleeves** (CASH / BOND / EQUITY / GOLD) are ordered *inside one account* by the design-65
  `selection` passed to `consumeHoldings`.

Buckets 2 and 3 are sleeves of the **same** taxable brokerage. The offset is a **whole
account**. So an account-level priority is either *before both sleeves* or *after both*, and
the study's central policy — **"after bonds, before equity"** — has no expression. Measured
in the prior study: `drawdownPriority: 0` makes the offset bucket 1 (drained by 2033),
`drawdownPriority: 5` puts it behind the whole brokerage (never touched). Both ends are wrong
and there is nothing in between.

That single missing thing blocks **both** halves of the new study:

| STUDY.md table | required order | expressible today |
|---|---|---|
| Bonds as shock absorber | cash → **bond sleeve** → offset → equity sleeve | no |
| Bonds as dry powder | cash → offset → equity sleeve, bonds untouched | no |

---

## 2. What is NOT needed for this study (and why)

Worth stating, because the instinct is to build the whole concept first.

- **§6.1 years-based pool targets.** The plateau glidepath authored in the prior study already
  sizes bucket 2 at 5.4 crash-arm years across the window this study covers. A years-based
  target replaces hand-tuning; it does not change what the study measures.
- **§6.3 derived pool capacity.** Reporting. The offset's amortising cap is already measurable
  with `probe-bucket-cover.mjs`; the study reads final net liquidity, not capacity.
- **§6.4 the refill rule.** This one is *not* obviously safe to skip — see §7, which says how
  to check whether it distorts the table before deciding.
- **The "buy the dip" leg of the dry-powder arm.** Already emergent: with design-61
  `TARGET_ALLOCATION` on, a crash leaves BOND over-weight, and the next drift-band rebalance
  sells bonds and buys equity. The prior study measured exactly this — in the crash year the
  plan sold \$79k of bonds and bought \$45k of equity. The dry-powder arm therefore needs the
  **draw order** changed, not a new behavioral strategy.

---

## 3. The scaffolding: `drawdownSequence`

One new ordered list on state. Each entry is a **pool**: an account, optionally narrowed to a
set of allocation sleeves.

```js
state.drawdownSequence = [
  { key: 'auSavingsAccount' },                                  // bucket 1 — cash
  { key: 'usBrokerageAccount', sleeves: ['BOND'] },             // bucket 2 — the reserve
  { key: 'auOffsetAccount' },                                   // the backstop below it
  { key: 'usBrokerageAccount', sleeves: ['EQUITY', 'GOLD'] },   // bucket 3 — growth
];
```

Read it as the pools concept's *only* irreducible statement: a pool is a **named position in
one sequence**, not an emergent consequence of two independent orderings. Everything else in
the concept (years-based sizing, derived capacity, refill policy) attaches to entries in this
list later.

### 3.1 Semantics

1. **Absent ⇒ nothing changes.** No `drawdownSequence` on state ⇒ the existing
   `drawdownPriority` sort runs untouched, byte-for-byte. This is the non-negotiable property:
   every golden fixture and every existing scenario is on that path.
2. **Present ⇒ listed pools first, in list order.** Each entry draws only from its sleeves and
   is capped at their market value; when exhausted the walk moves to the next entry.
3. **Whatever the sequence does not claim follows it**, in existing `drawdownPriority` order.
   That includes **the unnamed sleeves of a named account** — naming an account's bond sleeve
   is a statement about *when to spend bonds*, not a decision to strand its equity. A partial
   sequence therefore degrades to today's behaviour rather than stranding money.

   This one was found by the test rather than reasoned out (SEQ-4 threw `InsufficientFunds`
   with 90k of equity untouched). The two candidate rules fail very differently: keying
   "unclaimed" by *account* strands the rest of a partially-named account and surfaces as a
   **spurious OUT_OF_FUNDS with the money still sitting there**, while keying it by *pool*
   can sell equity later than the author intended — which is at least visible in the journal.
   The visible failure is the right one to choose. A corollary worth stating: with only a
   BOND pool listed, that account's equity keeps its own `drawdownPriority` and can still be
   reached **before** a lower-priority backstop. Listing every sleeve is what makes the order
   fully explicit, and both study arms do.

   The remainder leg is passed *unnarrowed* rather than as "the classes not yet claimed":
   every pool ahead of it in the same walk has been drawn to exhaustion by the time it is
   reached, so the two consume identical lots — and the unnarrowed form cannot strand an
   allocation class that is not in `DRAWDOWN_SLEEVE_CLASSES`.

   A typo'd `key` still fails silently and plausibly, which is why §6 makes validation part
   of the build rather than an afterthought.
4. **An account may appear more than once** with disjoint sleeve sets. That is the whole point.
   Overlapping sleeve sets are a config error (§6).
5. Phase 2 (early-withdrawal, `_drawPenaltyFree` with penalty) and Phase 3 are **unchanged**.
   The sequence governs the penalty-free Phase 1 walk only — which is where every pool lives.

### 3.2 Implementation surface

Four touch points, in dependency order:

| # | file | change |
|---|---|---|
| 1 | `holdings/holdings-selection.js` | `selection.sleeveInclude?: Set<ALLOCATION>` — a filter, alongside the existing sleeve *order*. |
| 2 | `holdings/holdings-fifo.js` | `consumeHoldings` drops lots outside `sleeveInclude` before the consume loop, so it returns `consumed < amount` and the caller moves on. One filter line; every tally is computed from consumed lots and is unaffected. |
| 3 | `services/account-service.js` | `replenishSavings` builds `sources` from `state.drawdownSequence` when present. Each source carries its sleeve set; `_penaltyFreeAvailable` caps at the sleeve value; `_drawPenaltyFree` passes the per-segment selection. |
| 4 | toolset + serializer | a `drawdownSequence` param, projected to state; round-trips through `ScenarioSerializer`. |

(3) is the only non-trivial one. Note `sources` is already built and sorted in one place, and
`_drawPenaltyFree` already takes a `selection` argument per call — the seam exists, it is
currently handed the same selection for every account.

### 3.3 What this does NOT do

- It does not touch `PROPORTIONAL` drawdown mode or the design-58 within-tier modes. A
  sequence and a pro-rata split are different policies; listing both is a config error.
- It does not make the offset's capacity cap visible (§6.3 stays open). The offset still draws
  down to its balance; that it stops suppressing interest above the loan balance is unmodelled
  as before.
- It does not stop the rebalancer refilling a drained bucket by selling equity (§7).

---

## 4. Mapping the study onto it

Both tables become one axis: the sequence.

```js
// Arm A — bonds as shock absorber, offset as overflow past bonds
[ {key:'auSavings'}, {key:'brokerage', sleeves:['CASH','BOND']},
  {key:'auOffset'},  {key:'brokerage', sleeves:['EQUITY','GOLD']} ]

// Arm B — offset as the spend source, bonds held as dry powder
[ {key:'auSavings'}, {key:'auOffset'},
  {key:'brokerage', sleeves:['EQUITY','GOLD']}, {key:'brokerage', sleeves:['BOND']} ]
```

Arm B keeps the bond sleeve **last**, so it is spent only after equity is gone; the
"buy the dip" behaviour comes from the drift-band rebalance (§2), not from the sequence.
The ladder-length rows (2/4/6-year bonds) are the existing design-66 ladder params, and the
crash columns are `shocks[0].preset` + `startDate` — both already axes.

---

## 5. Test plan

- **SEQ-1 identity**: no `drawdownSequence` ⇒ a golden run is byte-identical.
- **SEQ-2 filter**: an entry with `sleeves:['BOND']` consumes only BOND lots and stops at the
  sleeve's value even when the account holds more.
- **SEQ-3 interleave**: the case that motivates the design — a deficit larger than the bond
  sleeve draws bond, then the offset, then equity, in that order, in one period.
- **SEQ-4 remainder**: what the sequence does not claim — an unlisted account *and* an
  unlisted sleeve of a listed account — follows it, in priority order.
- **SEQ-5 validation**: unknown `key`, overlapping sleeve sets, and a sequence combined with
  `PROPORTIONAL` each throw at config time (§6).
- **SEQ-6 taxes**: the disposal actions raised by a sleeve-filtered draw are identical in shape
  to an unfiltered one (`disposal-tax-payload-parity` already pins the family; extend it).

---

## 6. Validation is part of the feature, not a follow-up

Three failure modes here are silent and plausible-looking, which is the class of bug this
codebase keeps re-finding (a wrong-but-runnable config that produces a believable number):

- an unknown `key` — the pool is skipped and the money comes from somewhere else;
- overlapping sleeve sets — a sleeve is drawn twice in one walk;
- a sequence set alongside `drawdownMode: 'PROPORTIONAL'` — one of the two silently wins.

All three throw at config time, where the same class of error is already thrown for authored
allocation mixes (`assertAuthoredMixes`).

---

## 7. The one thing that could invalidate the study's table — MEASURED, and it does not

**The concern.** The rebalancer refills bucket 2 by selling bucket 3. Spending drains BOND;
the next drift-band rebalance restores the BOND target by selling EQUITY. Net of the round
trip the plan sold equity to fund spending — laundered through the bond sleeve — and a cover
schedule cannot see it, because bucket 2 looks refilled (`FINDINGS.md` §6.4). If that
dominates, the arms converge and the study's table measures the rebalancer.

**The answer: the arms separate on every crash column, by 100 % of the larger.**
`scripts/probes/probe-refill-laundering.mjs`, run on `scenarios/offset-bucket-study`
(9k/month, FX pinned, 2027–2042, deterministic):

| shock | down years | equity sold in them, A | …B | terminal netLiq A | …B | …control |
|---|---|---|---|---|---|---|
| none | — | \$0 | \$0 | \$6,449k | \$6,283k | \$6,552k |
| GFC 2029 | 2029 | **\$0** | \$111k | \$3,900k | \$3,588k | \$3,837k |
| GFC 2033 | 2033 | \$0 | \$0 | \$4,632k | \$4,341k | \$4,492k |
| Dot-com 2029 | 2029, 2030 | **\$0** | **\$263k** | \$2,752k | \$2,565k | \$2,863k |
| Dot-com 2033 | 2033, 2034 | **\$0** | \$65k | \$3,692k | \$3,517k | \$3,667k |
| Stagflation 2029 | — | \$0 | \$0 | \$5,773k | \$5,519k | \$5,891k |
| Stagflation 2033 | — | \$0 | \$0 | \$5,987k | \$5,776k | \$6,078k |

Three things read straight off it:

1. **Arm A never sells equity in a down year, in any column.** The behavioural claim a bucket
   strategy exists to make survives the rebalancer. In the GFC year arm A *buys* \$53k of
   equity while selling \$92k of bonds — it uses bucket 2 to buy the dip.
2. **Arm B sells equity in every crash column that has a down year**, worst in the dot-com
   (\$263k). It spends the offset early (\$183k in 2028, then the facility is gone), so by the
   time the crash lands there is nothing between spending and bucket 3. That is
   `FINDINGS.md` §5's "a late draw is nearly free, an early draw costs most", arriving from
   a completely different direction.
3. **A beats B on the terminal cell in all seven columns**, by \$166k to \$312k.

So the refill rule (§6.4) stays deferred. It is not disproved — the rebalancer *is* visibly
refilling bonds by selling equity in arm A's up years (the alternating ±\$150k rows) — it is
just not large enough to swamp the draw order, which is what the table needs it not to do.

### 7.0 Arm B is UNDER-SPECIFIED, and the gap is worth \$130–155k

The two arms are `STUDY.md`'s two tables. Arm A ("Bonds as Shock Absorber") is fully
determined by its own sentence — *spend the bonds and use the offset as an overflow past
bonds* — so `cash → BOND → offset → EQUITY` is the only reading.

Arm B ("Bonds as Dry Powder / Offset Option") is not. *Spend the offset* fixes the front of
the order; *use the bonds to buy into the market* is a statement about BUYING and says nothing
about what funds spending once the offset is dry. The table above uses **bonds are never
spent** (`--b-tail equity`, the default). The other reading — bonds spent, just after the
offset instead of before it — is `--b-tail bonds`:

| column | metric | B: bonds never spent | B: bonds after the offset | arm A |
|---|---|---|---|---|
| GFC 2029 | equity sold in down years | \$111k | **\$0k** | \$0k |
| | terminal netLiq | \$3,588k | \$3,720k | \$3,900k |
| Dot-com 2029 | equity sold in down years | \$263k | \$257k | \$0k |
| | terminal netLiq | \$2,565k | \$2,629k | \$2,752k |
| Dot-com 2033 | equity sold in down years | \$65k | **\$0k** | \$0k |
| | terminal netLiq | \$3,517k | \$3,673k | \$3,692k |

So the reading changes arm B's headline: in the **GFC** column all of B's down-year equity
selling is an artefact of the choice, and in **dot-com 2029** almost none of it is — the grind
is long enough that the bond sleeve is exhausted either way and equity is sold regardless.
Arm A still wins every column under both readings, which is why §7's conclusion holds; but no
individual arm-B cell should be quoted until the reading is settled.

A third thing the sentence leaves open: *use the bonds to buy into the market* is not
implemented as a rule here. The dip-buying in these runs is the design-61 drift-band
rebalance doing it as a side effect. An explicit "on a drawdown of X %, rotate N of bonds
into equity" is a behavioural strategy that does not exist yet.

### 7.1 What this measurement is not

- **Deterministic, one path, FX pinned.** A fixed return gives the equity-heavier arm no bad
  tail, so the *cost* of arm A is an upper bound and its *benefit* is structurally invisible.
- **"Down year" means "shock year" here.** Returns are a flat 10 %, so the only negative years
  are the ones a preset creates. The down-year column is vacuous in the no-crash and
  stagflation runs, which is stated in the output rather than reported as a zero.
- **CONTROL is not wealth-matched to the arms.** With no sequence its wrappers keep their
  authored priorities (super 1, 401k 2, roth 3) *ahead* of the taxable book; under either
  sequence they fall behind it. Read control for the cost of sequencing at all, not as a
  third arm of the same experiment.
- It is the **prior study's** scenario (9k/month, the plateau glidepath), not the new one.
  Structurally the same plan; the levels will move.

### 7.2 Two measurement traps this probe hit, both worth carrying forward

- **The row identity in `cfg.params` is `name`, not `key`.** `ScenarioLoader` syncs with
  `cfg.parameters[p.name] = p.value`, so a row pushed as `{key, value}` reads back fine in the
  probe and is dropped on the way to the compiler. The first run reported all three arms
  byte-identical and a confident "the arms converge" — the same shape as the finding. The
  probe now **throws** if `state.drawdownSequence` is absent on an arm that authored one.
- **`(ΔMV − Δbasis) / MV` is a circular measure of return.** Selling an appreciated lot drops
  market value by the proceeds and basis by only the basis share, so the residual reads as a
  loss: **selling manufactures the down year that the metric then counts the selling in**, and
  the arm that sells more looks like it lived through more of them. The probe measures return
  on lots whose basis did not move — per *lot*, not per account, because in the crash year a
  rebalance touches at least one lot of every account and an account-level test came back
  empty in the one year that matters.

---

## 8. Open questions

1. **Does the sequence live on the account list or beside it?** Proposed: a scenario-level
   param, because it is a statement about *the plan*, not about any one account, and because
   `drawdownPriority` must keep working untouched for every scenario that has no sequence.
2. **Should an entry be able to name a floor** ("draw the offset only down to A\$100k")?
   `minimumBalance` already does this per account; a per-entry floor would be the pool-level
   analog and is the natural next field. Not needed for this study.
3. **Cross-border.** The sequence is a flat list, so it silently spans countries — which is
   what `crossBorderDrawdown: 'GLOBAL'` means today. When `LOCAL_FIRST` is set, is a
   cross-country entry skipped or honoured? Proposed: **honoured**, on the grounds that
   authoring the sequence is a more specific statement than the mode. Must be tested, and it
   is the first thing to check if an arm's numbers look wrong.

---

## 9. The years-of-spend target source — BUILT

**Status**: Built (2026-08-29). `ALLOCATION_SCHEDULE.YEARS_OF_SPEND`.
Tests: `tests/unit/evt-years-of-spend-target.test.mjs` (6).
Probe: `scenarios/offset-bond-pool/probe-pool-years-held.mjs`.

`FINDINGS.md` §6.1, implemented. §3 above says how a pool is *spent*; this says how big it is.

### 9.1 Why a percentage cannot say "four years"

A pool target is a number of YEARS; a glidepath weight is a PERCENT, and they diverge in
exactly the wrong direction. Measured on the reference plan — accessible book, 31-Dec trough,
fixed-percentage target:

| bond cover | 2027 | 2029 | 2032 | 2035 | 2038 | 2042 |
|---|---|---|---|---|---|---|
| no crash | 3.5 yr | 8.8 | 9.0 | 9.0 | 10.5 | **13.6** |
| dot-com 2033 | 3.5 yr | 8.8 | 9.0 | 5.4 | 6.0 | **4.5** |

It **over-provisions as the book grows and under-provisions after a crash** — inverted from
what a reserve is for. `FINDINGS.md` quoted this over 44 years; it is already fatal over 16, and
it means a study row labelled "4 Year Bonds" is not four years for most of its own horizon.

### 9.2 What was built

A fourth `allocationSchedule` mode. `RebalanceToTargetReducer.resolveScheduledTarget()` already
returned a fresh mix every period — that is how the age glidepath works — so this is a new
**target source**, not a new rebalancer, exactly as §6.1 predicted:

```
CASH   = min(room, cashYears × annualSpend / book)     ← filled first
BOND   = min(room, bondYears × annualSpend / book)
GOLD   = the authored gold weight
EQUITY = whatever is left
```

Three deliberate properties:

- **The spend line is read live** (`state.monthlyExpenses`, which `InflationAdjustReducer`
  inflates: \$9,270 in 2027 → \$14,442 in 2042). That is the whole point — the reserve grows
  with the spend line rather than with the book.
- **Fill order is CASH → BOND → GOLD → EQUITY**, so a book too small for the pools ends up all
  cash and no equity, not a proportionally shrunken copy of a mix it cannot afford.
- **No spend line or no book falls back to the authored mix**, so selecting the mode without
  sizing a pool is inert rather than a zero-reserve plan.

### 9.3 It needs TWO companion settings, and neither is optional

Both were found by running the thing rather than reasoning about it.

**(a) A location policy, or the cover is exactly zero.** The mode sizes the MIX; the design-61
LOCATED planner decides WHERE it sits, and its default sends bonds to the tax-favoured
wrappers — correct for tax, useless as cover for someone retiring at 49. Measured:

| arm | 2029 | 2032 | 2035 | 2042 |
|---|---|---|---|---|
| years 2/4, **default** location | **0.0 yr** | 0.0 | 0.0 | 0.0 |
| years 2/4, accessible-first location | 2.4 | 1.9 | 1.7 | 3.2 |

Not "somewhat less" — **zero**, in every year. Fixed with config, not code: author
`allocationLocationPolicy` with the taxable roles first for BOND and CASH. The mode
deliberately does not force this, because location is a separate lever and one mode of one
strategy silently rewriting another is how levers stop meaning what they say.

**(b) A drift band of 5 points or tighter, or the target is not the holding.** With location
fixed the target was right and the *realisation* was not: the taxable account's bond target
was 18 % of its own total and it held 10 %, an 8-point gap that never breaches the authored
10-point band. So the account sat at roughly HALF its authored pool indefinitely.

| arm (accessible-first location) | 2029 | 2032 | 2035 | 2038 | 2042 |
|---|---|---|---|---|---|
| 2/4, band 10 pt (default) | 2.4 | 1.9 | 1.7 | 3.0 | 3.2 |
| 2/4, band 5 pt | 3.7 | 3.1 | 3.0 | 4.2 | 4.4 |
| **2/4, band 2 pt** | **3.3** | **3.5** | **3.4** | **4.4** | **4.6** |
| **2/6, band 2 pt** | **5.5** | **5.7** | **5.6** | **6.4** | **6.7** |

At 2 points the rows finally mean what they say — 4 years realises 3.3–4.6, 6 years realises
5.5–6.7, and the two rows are cleanly distinct instead of overlapping. The same holds through
the dot-com column (3.3–4.5 and 5.5–6.7), which is the point of a reserve.

**What the band costs, and why the number is misleading**: terminal net liquidity 10 pt →
2 pt is −\$324k (−3.6 %) with no crash and −\$48k (−1.4 %) through the dot-com. Almost none of
it is tax (\$572k → \$598k of lifetime tax). **The cost is not churn — it is the cost of
actually holding the reserve.** The wide band looked cheaper because the plan was quietly
holding half the bonds it claimed and the rest in equity.

### 9.4 Residual caveats

- **±0.7 years of wobble** remains at band 2. That is the 31-Dec trough convention: a year of
  spending is drawn out of the pools before the next rebalance refills them. It is the honest
  number — a pool you only have in January is not a reserve.
- **The located planner is currency-blind**, and this mode inherits it. The years fraction is
  computed on an FX-normalised book (the `to-base-currency` convention every other valuation
  site uses), but `planLocatedTargets` multiplies that fraction by a raw sum of per-account
  totals in mixed AUD and USD. Measured effect: the dollar target lands about **12 % high**
  (\$528k against \$472k wanted in 2029). Small, in the safe direction, and a pre-existing
  design-61 defect rather than one this mode introduced — but it means the realised pool
  should always be measured, never assumed.
- The mode changes the mix, so **it does not compose with a GLIDEPATH**: `allocationSchedule`
  picks exactly one source. A plan that wants both an age path and year-sized pools needs the
  glidepath to govern only the equity/gold split of the residual, which is not built.

### 9.5 What this deliberately does NOT include

**No refill policy** (`FINDINGS.md` §6.4), by decision, 29 Aug. Worth writing down because the
arithmetic says the need for one goes UP under this mode, not down:

- Under a **percentage** target a crash cuts equity, so bonds go over-weight and the rebalancer
  sells bonds to buy equity — free "accidental dry powder", measured in the 2029 crash row
  (\$53k of equity bought, \$92k of bonds sold).
- Under a **years** target the bond target is a dollar figure off the spend line and the spend
  line did not crash, so bonds sit at target and **there is no bond → equity rotation**.
  Spending then pulls the pools under target and the refill sells equity at the bottom.

So adopting years-based targets removes the accidental dip-buying. That is a real behavioural
change and it is not measured here — the study is one axis by decision, and this is the first
thing to look at if a crash column reads worse than expected.
