# 97 — Liquidity Pools: the unified drawdown sequence (scaffolding)

**Status**: Part I (§§1–9) **Built** (2026-08-29) — the spend sequence (§3) and years-based
pool sizing (§9). Part II (§§10–15) — the pool GRAPH, which closes the two gaps Part I deferred
(`FINDINGS.md` §6.3 capacity, §6.4 the refill rule) — is split into **effort 1** (logic +
settings) and **effort 2** (the control surface, §14, sketched only).
**Effort 1 is BUILT** (2026-08-29); §16 records what building it changed.
Tests: `tests/unit/evt-drawdown-sequence.test.mjs` (7), `tests/unit/evt-years-of-spend-target.test.mjs` (6),
`tests/unit/evt-liquidity-pools.test.mjs` (26).
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

---

# Part II — the pool GRAPH

**Status**: PROPOSED, 2026-08-29. Part I (§§1–9) built the *spend* side: one ordered list, and
a years-based way to size what is in it. Part II is the rest of the concept, split into two
efforts at the author's direction:

- **Effort 1 (designed here)** — the data structure, the logic, and the settings exposed
  through the ordinary parameter surface. Closes `FINDINGS.md` §6.3 (derived capacity) and
  §6.4 (the refill rule), the two gaps Part I deliberately deferred.
- **Effort 2 (sketched in §21, not designed)** — the control surface: a real editor for the
  graph, a pool panel, and the optimizer/MPC hooks. Deferred by decision so effort 1 can be
  used by hand and in studies first.

§21 exists because effort-1 decisions foreclose effort-2 options. Everything in §21 is a
constraint on effort 1, not a promise about effort 2.

---

## 10. Why the sequence has to become a graph

§3's `drawdownSequence` is a **list**. Three things the concept needs cannot be said in a list,
and all three are already on the table:

1. **A pool can span accounts.** "One year of cash" is the AU savings account *and* the US
   savings account *and* the settled cash sleeve of the brokerage. As a list, that is three
   adjacent entries that nothing ties together — so nothing can size it, report it, or refill
   it as one thing. A pool has to be a **named node with a set of claims**.
2. **Refilling is a flow between two pools, and it has more than one source and more than one
   destination.** The bucket literature states the mechanic as a cascade — spend bucket 1,
   refill 1 from 2, refill 2 from 3, harvesting gains in up markets — and adds a gate: *pause
   equity sales in a falling market and let bucket 1 draw on bucket 2 and accumulated income
   instead.* That is three nodes and at least four directed edges, several of them conditional.
   The offset adds a fourth node whose only outbound edge is into cash, and "buy the dip"
   (§7.0, named there as unimplemented) is an edge pointing **back up** the cascade. A list
   cannot hold any of it.
3. **The spend order and the refill order are different orders over the same nodes.** Today
   they are different *mechanisms* over different objects (a sequence; a drift band). One
   node set with two edge types says it once.

So: **pools are nodes, flows are edges**, and §3's sequence is the degenerate case — the
ordered spend edges of a graph whose refill edges are all implicit in the rebalancer.

### 10.1 The (s, S) band is the classical name for this

Salas-Molina, Rodríguez-Aguilar & Guillen, [*A multidimensional review of the cash management
problem*](https://pmc.ncbi.nlm.nih.gov/articles/PMC10014414/) (Financial Innovation 9:67, 2023)
is the same problem with a different
vocabulary: a set of accounts, a cost function per transfer, and a policy that is a **temporal
sequence of transactions between accounts**. Its canonical answer — Miller–Orr — is a
**control band**: do nothing while the balance is inside (s, S); when it leaves, transact back
to a return point. "Refill bucket 1 when it drops below 12 months, and fill it to 24" *is* an
(s, S) band. Adopting that shape deliberately (§13.2) means the trigger and the fill target are
two separate numbers from the outset, which is what stops the refill from firing every period
and churning.

The review's six dimensions also name the axis this design is weakest on and effort 2 owns:
**the cost function**. Our edges will be gated on *market state*, not priced against a transfer
cost. That is a modelling choice, and it is the reason §21 keeps the optimizer hook open.

---

## 11. The data structure

One new authored object, `liquidityGraph`:

```jsonc
{
  "pools": [
    {
      "id": "cash",                              // stable identity — flows, params and the editor all key off it
      "label": "Bucket 1 — near-term cash",
      "claims": [ { "key": "auSavingsAccount" },
                  { "key": "usBrokerageAccount", "sleeves": ["CASH"] } ],
      "spendOrder": 10,                          // position on the spend walk; absent ⇒ never spent from
      "target":   { "mode": "YEARS_OF_SPEND", "value": 1 },
      "floor":    { "mode": "AMOUNT", "value": 0 },   // never spend below this
      "capacity": { "mode": "BALANCE" },
      "ui": { "x": 40, "y": 200 }                // opaque to the engine (§21)
    },
    {
      "id": "reserve", "label": "Bucket 2 — the reserve",
      "claims": [ { "key": "usBrokerageAccount", "sleeves": ["BOND"] } ],
      "spendOrder": 20,
      "target": { "mode": "YEARS_OF_SPEND", "value": 4 }
    },
    {
      "id": "offset", "label": "The backstop",
      "claims": [ { "key": "auOffsetAccount" } ],
      "spendOrder": 30,
      "capacity": { "mode": "OFFSET_CAP" }       // min(balance, linked loan balance) — §12
    },
    {
      "id": "growth", "label": "Bucket 3 — growth",
      "claims": [ { "key": "usBrokerageAccount", "sleeves": ["EQUITY", "GOLD"] } ],
      "spendOrder": 40
    }
  ],
  "flows": [
    { "id": "g2r", "from": "growth",  "to": "reserve",
      "trigger": { "belowTargetFraction": 0.75 },
      "gate":    { "sourceDrawdownUnder": 0.05 },
      "amount":  { "toTarget": true }, "priority": 10 },

    { "id": "r2c", "from": "reserve", "to": "cash",
      "trigger": { "below": { "mode": "YEARS_OF_SPEND", "value": 1 } },
      "amount":  { "toTarget": true }, "priority": 10 },

    { "id": "o2c", "from": "offset",  "to": "cash",
      "trigger": { "below": { "mode": "YEARS_OF_SPEND", "value": 1 } },
      "amount":  { "toTarget": true }, "priority": 20 },   // fires only after r2c cannot fill it

    { "id": "dip", "from": "reserve", "to": "growth",
      "gate":   { "sourceDrawdownUnder": null, "targetDrawdownOver": 0.20 },
      "amount": { "fractionOfSource": 0.25 }, "priority": 10 }
  ]
}
```

Read the four flows as the whole concept: **the cascade** (g2r, r2c), **the backstop as a
second source into the same pool, tried second** (o2c — the "multiple sources per pool"
requirement, and the thing §1 said had no expression), and **the reverse edge** (dip — the
"multiple destinations per source" requirement, and the buy-the-dip behaviour §7.0 recorded as
missing).

---

## 12. The central architectural statement: the graph COMPILES

**Effort 1 adds no second drawdown code path.** The graph is compiled, once, at scenario-build
time and re-derived per period only where it must be:

| produced | consumed by | when |
|---|---|---|
| `state.drawdownSequence` | `AccountService.replenishSavings` — **unchanged** | build time |
| `state.liquidityPools` (id → claims, target, capacity rule, trailing high) | the new flow reducer, the rebalancer's target source, telemetry | build time + per period |
| `state.poolFlows` (normalized edges) | the new flow reducer | build time |

The spend side is therefore *already built and already tested* (§3, §5): a pool's claims flatten
to consecutive `drawdownSequence` entries in `spendOrder` order, and every §3 semantic —
including "what the sequence does not claim follows it in `drawdownPriority` order" — is
inherited unchanged. A multi-account pool compiles to several adjacent entries; nothing
downstream needs to know they were one pool.

This is the property that makes effort 1 small enough to build in one pass, and it is the one
to defend under pressure: **if a change to the graph would require a change to
`replenishSavings`, the change is in the wrong place.**

### 12.1 Capacity — `FINDINGS.md` §6.3, closed

A pool is not a balance. The offset is `min(cash parked, outstanding debt)`, and the cap falls
on a schedule nobody authored — which is why its decay was invisible until it was plotted.

```
capacity(pool) = Σ over claims:
  BALANCE     → the claimed market value (the default; capacity == balance)
  OFFSET_CAP  → min(account.balance, linked loan balance)     ← the amortising cap
  AMOUNT / YEARS_OF_SPEND → an authored ceiling
```

Two consequences, both load-bearing:

- **A refill edge never fills a pool past its capacity.** Without this, `o2c` would happily
  push cash into an offset facility that suppresses no interest — the model would author the
  exact mistake the study warned against.
- **Cover reporting reads capacity, not balance.** `probe-bucket-cover.mjs` computes this by
  hand today; effort 1 moves it into the engine so the app can show it and effort 2 can plot it.

Note what capacity is *not*: it is derived every period, never stored as truth. The offset's
decay is loan arithmetic and must stay so — a stored capacity would drift the moment the loan
re-amortises (`offset-loan-reamortises-never-retires`).

### 12.2 Targets — §9 generalised onto the node

`poolCashYears` / `poolBondYears` (§9) are per-**ALLOCATION-class** knobs that happen to be
called pools. On the graph they become what they always meant: `pool.target`, in one of

- `YEARS_OF_SPEND` — value × the live annual spend line (§9's arithmetic, unchanged);
- `PERCENT` — of the rebalanced book;
- `AMOUNT` — a fixed figure in base currency.

`spendBasis: 'LIVE' | 'TRAILING'` is the second-order decision `FINDINGS.md` §6.1 flagged and
Part I never took: a guardrail strategy that cuts spending in a bad year would otherwise shrink
the reserve at the moment it is needed. **Effort 1 ships `LIVE` as the default** (it is what §9
built and measured) **and `TRAILING` as an option with a `trailingYears` window**, because the
option is three lines here and a re-measurement later.

**One authority.** For every ALLOCATION class claimed by a pool carrying a `target`, the
rebalancer's scheduled target for that class comes from the graph; unclaimed classes keep
`allocationSchedule` (STATIC / GLIDEPATH / REGIME_CONDITIONED) exactly as authored. Authoring
both a graph target and `poolCashYears`/`poolBondYears` **throws** — that is the
`two-param-stores-trap` shape, and it is the single most likely way for this feature to produce
a believable wrong number.

**The two companion settings from §9.3 apply unchanged and are still not forced.** A pool
target sizes the MIX; the design-61 LOCATED planner decides WHERE it sits, and its default
sends bonds to the age-gated wrappers where they are cover for nobody — measured at **0.0
years, in every year**. Effort 1 does not override `allocationLocationPolicy` (one lever
silently rewriting another is how levers stop meaning what they say), but it **does** add a
config-time *warning* when a pool's claims name only accounts that the location policy does not
prefer for that pool's classes. Warning, not throw: it is a plausible authoring, just almost
never the intended one.

### 12.3 Flows — `FINDINGS.md` §6.4, closed

An edge is `{ id, from, to, priority, trigger, gate, amount, cadence }`.

**`trigger` — when the destination wants money.** One of:
- `below: { mode, value }` — absolute (the Schwab rule of thumb, "refill bucket 1 once it
  falls below 12 months of expenses");
- `belowTargetFraction: f` — relative to the pool's own target;
- absent — fires whenever the destination is under target at all.

Trigger and `amount.toTarget` together are the (s, S) band of §10.1: **the trigger is `s`, the
target is `S`**, and keeping them separate is what stops a refill firing every period. This is
the substantive improvement over the drift band, which conflates them.

**`gate` — when the SOURCE may be sold.** This is the rule `FINDINGS.md` §6.4 called "probably
80 % of the pools concept", and the vocabulary is deliberately small:

| gate | meaning |
|---|---|
| `sourceDrawdownUnder: x` | fire only while the source is within x of its trailing high. `0` is §6.4's "do not refill while bucket 3 is below its trailing high"; `0.05` is the softer "harvest in up markets". |
| `targetDrawdownOver: x` | the reverse edge's condition — fire only when the DESTINATION is x below its high (buy the dip). |
| `notInRegime: [TAG]` | reuse the existing regime tags (`ECONOMIC_STRESS`, `PANIC_SELL_TRIGGER`). |
| `notBefore` / `notAfter` / `ageOver` / `ageUnder` | the ordinary time gates. |
| absent | always. |

A trailing high is per-pool state (`state.liquidityPools[id].high`, monotone, updated once per
period). It has to be **state**, not a window recomputed from the journal, because it must
survive serialization and replay identically — and because a peak set before the run's start
date is not knowable from the run.

**`amount`** — `toTarget` (fill the destination to its target, the usual case),
`fractionOfSource: f`, `max`, `min`. Every transfer is additionally clamped by: the source's
available balance above its own `floor`, the destination's `capacity`, and the destination's
shortfall.

**`priority`** orders edges *into the same destination* — that is how "try the reserve, then
the offset" is said. Edges *out of the same source* to different destinations run in the same
priority order and each sees the balance the earlier ones left, unless they declare `share`
(pro-rata split of what the source can give this period).

### 12.4 Two executors, and why the split is not an implementation detail

An edge moves value between two pools. **How** depends on whether the two ends are inside the
same rebalanceable book:

1. **In-portfolio** (e.g. `growth → reserve`, both sleeves of the taxable brokerage). Realised
   by the **existing design-61 rebalancer**: the graph supplies the target composition and the
   gate acts as a **veto on the rebalance leg** that would sell the gated source. No new
   transfer machinery, no new disposal path, no new tax path. When the gate is shut the pool
   simply stays under target for the period — which is exactly the intended behaviour and is
   visible in the pool telemetry.
2. **Cross-account** (e.g. `offset → cash`). Realised by a new `PoolFlowReducer` emitting
   `POOL_FLOW_APPLY`, which **must** route through the same debit/credit path
   `replenishSavings` uses — withdrawal tax, `INTL_TRANSFER_RECORD`, §988 realization on any
   cross-currency leg. This repo has found the same bug three times (`replenish-savings-bypasses-actions`,
   `tax-payment-funding-untaxed`, `disposal-tax-five-emitters`): a new way to move money that
   does not go through the taxing seam produces a believable, untaxed number.

**A gated in-portfolio edge is a veto; a cross-account edge is a transaction.** Stating it that
way is what keeps executor (1) free.

### 12.5 Cycles are allowed; simultaneous opposing edges are not

`growth → reserve` and `reserve → growth` are both wanted (harvest, and buy the dip), so the
graph is not a DAG and validation must not demand one. Instead:

- each edge fires **at most once per period**;
- edges evaluate in a fixed order (destination `spendOrder`, then edge `priority`, then `id`)
  so a period is deterministic and replayable;
- an opposing pair where **neither** edge has a `gate` or `trigger` is a config error — that is
  an unconditional laundering loop and there is no reading under which it is intended.

A conditional loop that does fire in both directions in one period is legal, visible in the
journal as two `POOL_FLOW_APPLY` entries, and cheap to find. That is the §3.1 principle again:
prefer the failure that is visible in the journal to the one that strands money silently.

### 12.6 When flows run

`PRIORITY.PRE_PROCESS`, on `US_/AU_PERIOD_ADVANCE`, **after** the inflation reducer has moved
`state.monthlyExpenses` (a years-based trigger reads the live spend line) and the regime
reducers have stamped `state.activeRegimes` (gates read them), and **before**
`RebalanceToTargetReducer` (which is `PRE_PROCESS + 4` and is executor 1). Spending happens
later in the period, so a period reads: *observe → refill → rebalance → spend*.

`cadence` defaults to the period; `ANNUAL` restricts an edge to the first period of the
calendar year. Note the 31-Dec trough convention (§9.4) is unchanged and is still the honest
measurement point — a pool you only have in January is not a reserve.

### 12.7 Validation — the same bar as §6

Every one of these throws at config time, for the reason §6 gives:

- duplicate `pool.id`; a flow naming an unknown pool; a self-edge;
- an unknown account `key`; sleeve narrowing on a non-BROKERAGE (§3's rule, unchanged);
- **claims that overlap across pools** — §3 checked this within one sequence; a graph must
  check it globally, because two pools claiming the same sleeve would be double-counted by
  every target, trigger and cover figure in the feature;
- a graph alongside `drawdownMode: 'PROPORTIONAL'` (§6, unchanged);
- a graph target alongside `poolCashYears` / `poolBondYears` (§12.2);
- a graph alongside a hand-authored `drawdownSequence` — the graph compiles to it, so both is
  two authorities on one field;
- an unconditional opposing edge pair (§12.5);
- `OFFSET_CAP` on a pool whose claimed account has no linked loan.

Plus one **warning** (not a throw): §12.2's location-policy mismatch.

### 12.8 Settings surface for effort 1

Deliberately the ordinary parameter surface — effort 2 is where this gets a real editor.

| param | type | notes |
|---|---|---|
| `liquidityGraph` | `LiquidityGraph` (three row-list tables), group `Spending` | the whole `{ pools, flows }` object. Absent ⇒ nothing changes. See §17 — this shipped as a JSON textarea and was replaced. |
| `poolTarget::<poolId>` | `Number`, `opt: true`, `mc: true` | a scalar overlay on one pool's `target.value`, generated per pool at render time so a study can sweep pool sizes without rewriting JSON. **`::`, never `.`** — dotted keys are silently dropped by the optimizer's `set()` (`optimizer-param-key-dot-collision`). |
| `poolFlowsEnabled` | `Boolean`, default `true` | authors the graph's *topology* without its *behaviour*: pools, targets, capacity and the spend order stay live, refill flows do not fire. This is the arm-vs-control switch every study of this feature will want, and it costs one flag. |

Deprecated-but-honoured: `drawdownSequence`, `poolCashYears`, `poolBondYears`. They keep
working exactly as built; each throws only when combined with a graph that says the same thing.

### 12.9 State, serialization and telemetry

- `state.liquidityPools`: `{ [id]: { claims, target, capacityRule, high, balance, capacity } }`.
  `high` is persisted (§12.3); `balance` / `capacity` are re-derived each period.
- `state.poolFlows`: the normalized edge list.
- Round-trips through `ScenarioSerializer` in both directions, and gains golden-fixture coverage
  — a field that is rebuilt from config on every load and silently drops is exactly how
  `mortgagePaymentSourceKey` was inert for two study arms (`FINDINGS.md` §7).
- **Telemetry**: one row per pool per period — `balance, capacity, target, yearsOfCover,
  inflow, outflow, gatedFlows[]`. Opt-in behind the existing telemetry level and **batched**;
  the naive per-period `getAll()` was quadratic once already (`design/78`).

`gatedFlows` is the field that makes the feature debuggable: the interesting event is usually a
flow that *did not* fire, and nothing else in the journal records a non-event.

### 12.10 Test plan

Reuses §5's shape; SEQ-1..6 all still apply through the compiled sequence.

- **POOL-1 identity** — no `liquidityGraph` ⇒ a golden run is byte-identical.
- **POOL-2 compilation** — a graph whose pools are single-claim compiles to exactly the §4
  arm-A `drawdownSequence`, and the run is byte-identical to authoring that sequence by hand.
  *This is the test that makes §12's claim true rather than aspirational.*
- **POOL-3 multi-account pool** — one pool claiming two accounts compiles to two adjacent
  entries and drains both before the next pool.
- **POOL-4 capacity** — an `OFFSET_CAP` pool reports `capacity = min(balance, loanBalance)`
  and a refill into it stops at the cap, with the loan amortising underneath.
- **POOL-5 trigger band** — a flow with `below` fires only when the destination crosses `s`,
  and fills to `S`; it does **not** fire in the periods between.
- **POOL-6 gate** — `sourceDrawdownUnder: 0` suppresses the refill in a down year and the
  destination runs under target; the same scenario with the gate removed refills. Both arms
  wealth-matched (`offset-arms-not-wealth-matched`).
- **POOL-7 reverse edge** — `targetDrawdownOver` moves reserve into growth in a crash year and
  in no other year.
- **POOL-8 cross-account executor** — an `offset → cash` flow emits `POOL_FLOW_APPLY` **and**
  the withdrawal-tax + `INTL_TRANSFER_RECORD` actions; asserted on the action stream, not on
  the balance (`disposal-tax-five-emitters`: count emitters, not fires).
- **POOL-9 one-authority** — a pool target overrides `allocationSchedule` for its claimed
  classes and leaves unclaimed classes alone; authoring both throws.
- **POOL-10 validation** — each item in §12.7, one case each.
- **POOL-11 determinism** — a graph with a legal cycle produces a byte-identical state on a
  re-run and on a serialize/reload round trip (`sim-is-bit-deterministic`).

Two traps carried forward from §7.2, both of which have already cost a session:
`cfg.params` rows are keyed by **`name`**, not `key`, so a preflight assertion that the graph
actually reached `state` is mandatory (`scripts/lib/preflight.mjs` already has the landing-check
idiom); and `(ΔMV − Δbasis)/MV` is a circular measure of return, so any "did it sell in a down
year" check must be measured on lots whose basis did not move.

### 12.11 Build order

1. `liquidity-graph.js` — the shape, `normalizeLiquidityGraph()` (all of §12.7), and
   `compileToDrawdownSequence()`. Pure, no engine dependency. Tests POOL-2/3/10.
2. Capacity + derived pool state (§12.1) and the telemetry rows. Tests POOL-4.
3. `PoolFlowReducer` + `POOL_FLOW_APPLY`, cross-account executor only, routed through the
   existing debit path. Tests POOL-5/8/11.
4. Gates, including the trailing high on state + serializer + goldens. Tests POOL-6/7.
5. The rebalancer as executor 1: graph targets as the target source, gate-as-veto. Tests
   POOL-9, and re-run `probe-refill-laundering.mjs` — §7's table is the regression test for
   this step, because it is the measurement the refill rule was deferred against.
6. Params, serializer round-trip, `poolTarget::` generation, deprecation guards.

Steps 1–2 are inert (nothing fires); step 3 is the first behavioural change. Each step is
independently shippable and each ends byte-identical for a scenario with no graph.

---

## 13. What effort 1 deliberately does NOT do

- **No cost function on an edge.** Gates are conditions on market state, not a priced
  comparison of "draw the offset" against "sell equity". The cash-management literature (§10.1)
  makes the cost function a first-class dimension and we are choosing not to — because the two
  costs were measured at the **same order of magnitude** (`FINDINGS.md` §5), so a price would
  not decide the edge anyway. It is the optimizer's job, and it is effort 2's hook.
- **No solver.** The graph is a policy the author writes, not one the engine derives. Johansson
  & Boyd, [*A Tax-Efficient Model Predictive Control Policy for Retirement
  Funding*](https://web.stanford.edu/~boyd/papers/retirement.html) (2025), is the shape of the
  alternative — pose the year's transfers as a convex program and re-solve every year — and it
  is a different project. Note the two are not rivals: an MPC still needs somewhere to *put* the
  answer, and this graph is a candidate action space for one.
- **No spending rule.** Forsyth, Vetzal & Westmacott, [*Optimal control of the decumulation of a
  retirement portfolio with variable spending and dynamic asset
  allocation*](https://arxiv.org/abs/2101.02760) (2021), finds that most of the achievable
  improvement comes from letting *withdrawals* vary, with dynamic allocation adding a further
  significant increment on top. This design moves the second lever only. That is a real limit on
  what any pool study here can claim: a pool graph tuned against a fixed real spend line is
  optimising the smaller of the two levers, and the guardrail/MPC spending work (design 58,
  design 89) is the other one.
- **No per-pool tax awareness.** Which *lot* gets sold inside a pool is still design-65's job.
- **No change to `PROPORTIONAL`** or the design-58 within-tier modes (§3.3, unchanged).

---

## 14. Effort 2 — the control surface, and the constraints it puts on effort 1

Not designed here. Sketched only far enough to name what effort 1 must not foreclose.

**What it is, roughly**: a direct-manipulation editor for the graph (drag nodes, draw edges,
edit a pool's target inline), a pool panel showing years-of-cover and capacity over time with
the flows as a sankey, and the optimizer/MPC surface that searches pool sizes and gate
thresholds instead of the author guessing them.

**What effort 1 must therefore get right now, and each is already in the design above:**

| constraint | where |
|---|---|
| Pool and flow **ids are stable and authored**, never positional — an editor needs to move a node without changing what a param key or a saved layout refers to. | §11 |
| Nodes and edges carry an **opaque `ui` blob the engine ignores** and the serializer preserves — otherwise the editor needs a second store, and a second store drifts. | §11 |
| The **telemetry cube is per-pool per-period**, and it records **gated (non-)flows**. A panel cannot render an event the engine did not record, and the interesting event is a flow that did not fire. | §12.9 |
| Optimizable knobs are **flat `::` keys** generated from pool ids. | §12.8 |
| **Capacity is derived**, so an editor that changes a loan cannot leave a stale pool capacity behind. | §12.1 |
| **`poolFlowsEnabled`** exists, so the control surface has an off switch for A/B without editing the graph. | §12.8 |
| **Cycles are legal**, so the editor never has to refuse an edge the author can reasonably want. | §12.5 |

---

## 15. Open questions for effort 1

1. **Does a pool's `floor` interact with `minimumBalance`?** §8 Q2 proposed a per-entry floor
   and deferred it; the graph gives it a natural home (`pool.floor`). Proposed: the effective
   floor is `max(pool.floor, Σ account.minimumBalance over claims)`, so neither silently
   overrides the other. Needs a test, because "the pool says draw it, the account says do not"
   is a spurious-`OUT_OF_FUNDS` shape (§3.1).
2. **Should income land in a pool?** Wages, coupons, dividends and rent currently land in a
   cash account by existing rules. Modelling them as inbound edges from an exogenous source
   node would make the graph complete — and would change the behaviour of every existing
   scenario, which is why the proposal is **no for effort 1**: the graph governs *reallocation*
   between pools, and income keeps its existing destination. Worth revisiting only if a study
   needs coupon income to be directed somewhere other than where it lands.
3. **Cross-border.** §8 Q3 settled that an explicitly named account is honoured over
   `crossBorderDrawdown: LOCAL_FIRST`. A *flow* is a stronger statement still — it moves money
   across the border on purpose. Proposed: honoured, converted through the same `fxOf`/`feeOf`
   path, with the §988 leg realized (§12.4). First thing to check if an arm's numbers look wrong.
4. **Does a `TRAILING` spend basis interact with the guardrail strategy the way §12.2 assumes?**
   Untested. The concern is real (`guardrail-spendtotal-wiring-artefact` is a reminder that the
   guardrail's own baseline is subtle), and `LIVE` is the default precisely so this can be
   deferred.
5. **What happens to a pool whose claims are all empty?** Proposed: it stays in the graph,
   reports zero balance and zero capacity, and is skipped by both walks — so authoring a pool
   for an account that only funds later in the plan is not an error. Same rationale as the
   dormant-at-value-0 property (`property-purchase-and-downsizer`).


---

## 16. Effort 1, as built (2026-08-29)

Five files, one new seam in `AccountService`, one new behavioral strategy. Full unit suite green.

| file | what it owns |
|---|---|
| `finance/pools/liquidity-graph.js` | the shape, `normalizeLiquidityGraph` (every §12.7 error), `compileToDrawdownSequence`, executor classification, `resolveLiquidityGraph` (the ONE normalization site the three callers share) |
| `finance/pools/pool-metrics.js` | balance / capacity / target / cover per pool, FX-normalised; `loanForOffset` |
| `finance/pools/pool-flow-reducer.js` | triggers, gates, the trailing high, the per-pool cube, `poolRefillPlan` |
| `finance/pools/pool-flow-apply-reducer.js` | executor 2 — delegates to the scoped draw |
| `services/account-service.js` | `+ opts.scopedSources` — an exclusive source list, no remainder fall-through, no Phase 2, returns `shortfall` instead of throwing |
| `behavioral/rebalance-to-target-reducer.js` | executor 1 — `poolGraph` as the target source, `_applyVeto`, the dip adjustment |
| `behavioral/behavioral-strategy-registry.js` | the `LIQUIDITY_POOLS` strategy + its two params |

§12's claim held: **`replenishSavings` never learned that pools exist.** The one change it took
was the scoped-draw option, which is a narrowing of the walk it already had — not a second walk.

### 16.1 Five things the build changed, all found by running it

1. **`capacity: BALANCE` means "no ceiling", not "ceiling = what it holds".** Implemented
   literally, `headroom` was identically zero and **no refill could ever fire** — and the
   failure is silent, because a pool sitting exactly at its stated capacity looks correct.
   Pools now carry a `capped` flag; an uncapped pool's headroom is infinite. This is the same
   shape as every other bug in this design's history: a wrong-but-runnable reading that
   produces a believable number.

2. **Buy-the-dip cannot be a cash-into-a-sleeve transfer.** §11's example wrote the reverse
   edge as `reserve → growth`, and the first tests wrote the reserve as a savings account.
   Validation rejected it, correctly: depositing cash into a brokerage does not land in the
   EQUITY sleeve the destination pool claims, so the pool would never fill and **the edge
   would fire every period forever**. A dip edge has to be *in-portfolio* — BOND sleeve into
   EQUITY sleeve of the same book — which makes it executor 1's business, not a transfer.

3. **So `toTarget` and `fractionOfSource` mean different things on an in-portfolio edge**, and
   the distinction is the whole of how executor 1 works:
   - `toTarget` — the destination's own `target` already states how big it should be, so the
     edge contributes **only its gate**. Recording an adjustment as well would fill the pool
     twice.
   - `fractionOfSource` — this is the case a static target *cannot* express ("on a 20 %
     drawdown, rotate a quarter of the reserve into equity"), so it is stamped on
     `poolRefillPlan.adjust` and the rebalancer shifts the target mix by it. The shift lasts
     while the gate is open and unwinds when it closes, which is what a dip-buy is: a
     temporary overweight, not a new policy.

   Both ends of such an edge must claim exactly one ALLOCATION class — the same
   no-unique-split rule a `target` follows — and that now throws.

4. **Two sources into one pool have to SHARE the shortfall.** Each edge recomputes the
   destination against what earlier edges already promised it, or "try the reserve, then the
   offset" fills the pool twice over. This is the `o2c`-after-`r2c` case from §11 and it is
   POOL-5d.

5. **The intra-period order is set by the framework's queueing, not by the priorities.**
   Emitted actions are unshifted, so the rebalancer (deciding at `PRE_PROCESS + 4`, one step
   after the flow reducer at `+3`) gets its APPLY processed *before* the cross-account
   transfer. That is the right way round — rebalance to the possibly-vetoed target, then raise
   the cash — but it is emergent rather than authored, and a future reducer inserted between
   them would change it silently.

### 16.1b The gate defect the first authored plan found (and the fix)

The first real configuration authored on this feature (`cash 1yr → bonds 2yr → offset →
equity`, with `growth → buffer` gated at `sourceDrawdownUnder: 0.05`) ran, produced plausible
tables, and was wrong in a way no test had asked about.

**A trailing-high gate cannot tell a falling market from a pool being spent down.** The
`high` is a peak of BALANCE, and in a decumulation plan the balance never returns to its peak
because the household keeps removing capital from it. Measured on that plan:

| year | growth pool | its trailing high | "drawdown" | 5 % gate |
|---|---|---|---|---|
| 2028 | \$2,311k | \$2,410k | 4.1 % | open |
| 2029 (crash) | \$1,161k | \$2,410k | 51.8 % | shut — correctly |
| 2034 | \$2,206k | \$2,410k | 8.5 % | **shut** |
| 2038 | \$2,194k | \$2,410k | 9.0 % | **shut** |
| 2042 | \$2,194k | \$2,410k | 9.0 % | **shut** |

By 2034 the market had fully recovered; the pool reads 9 % down because six years of spending
came out of it. So the gate **latched shut forever after the first crash** — which is not
"harvest in up markets", it is "never harvest again". Downstream the bond buffer sat at **zero
for a decade** while the plan spent equity directly, and the run still looked healthy: terminal
net worth was 18 % HIGHER than the corrected plan, because a deterministic path rewards
whoever held the most equity (§7.1, exactly).

`FINDINGS.md` §6.4's original wording — "do not refill bucket 2 from bucket 3 while bucket 3
is below its trailing high" — was written about a portfolio, and is simply wrong about a pool
being drawn down. That is the sentence this design inherited without re-examining.

**A second gate would not have saved it either.** `notInRegime` was the obvious fallback, and
on that plan's `MARKET_CRASH_2008_LITE` every active regime carries `tags: []` — so a
regime-tag gate is silently inert there. Two of the three gate kinds were unusable on the first
plan that tried them.

**The fix: a market-state pair that reads the rate table, not a balance history.**
`gate.sourceReturnOver` / `gate.targetReturnUnder` compare the pool's live, value-weighted
return (`poolMarketReturn` over `state.effectiveGrowthRates`) against a threshold. A withdrawal
does not change a return, so the confound is gone. `sourceReturnOver: 0` is the bucket
literature's rule stated exactly: *harvest in up markets, pause equity sales in a falling one.*
A pool holding no rated lots returns null, which leaves the gate **inert rather than shut** —
"no signal" must not read as "bad signal" (POOL-12b).

The drawdown pair is kept, because against an accumulating pool it is the right measure and it
is what a peak-to-trough statement means. The description now says which is which. Tests:
POOL-12 puts the two worlds side by side — same 20 %-below-its-high reading, market recovered
vs market falling — and asserts only the return gate separates them.

### 16.2 What is deliberately still not built

- **A cost function on an edge** (§13, unchanged). Gates are conditions on market state.
- **Persisting the trailing `high` across a mid-run save/load.** It is on `state.liquidityPools`
  and survives a replay from t0 byte-identically (POOL-11), which is what determinism needs;
  a mid-run resume would restart the high from the current balance.
- **A `TRAILING` spend basis regression test.** The plumbing and the `spendHistory` series are
  built and validated; nothing yet measures whether it behaves better than `LIVE` under a
  guardrail cut (§15 Q4).
- **The location-policy warning of §12.2.** Not implemented — the accessible-cover trap
  (§9.3(a), measured at *zero* years) is still only documented, not detected.
- **The `poolTarget::<poolId>` optimizer params of §12.8.** Not built, and the reason is a
  seam rather than a decision: `BEHAVIORAL_STRATEGY_REGISTRY[k].paramSchema()` takes no
  context, so it cannot see the authored pools and cannot generate one param per pool. Giving
  it context is a change every strategy in the registry would feel, and it belongs with
  effort 2's optimizer surface rather than tacked onto this.

  **A study does not have to wait for it.** `liquidityGraph` is an ordinary object param, so
  whole graphs sweep as axis values — exactly how `allocationGlidepath` takes whole anchor
  arrays today (`FINDINGS.md` §10). Sizing arms are authored as N graphs, not as N points on
  a scalar; that is more verbose and loses nothing.

### 16.3 The smallest arm-vs-control a study can run

`poolFlowsEnabled: false` keeps the pools, their targets, the compiled spend order and the
whole per-pool cube live and fires no refill edge (POOL-5c). It is the control arm for any
question about the refill rule, and it matters that it is a flag rather than "delete the
flows": deleting them would also change the pool sizing, and the two arms would then differ in
two ways at once — which is how `FINDINGS.md` §2's 5x cover error happened.


---

## 17. The controls (2026-08-29)

Both design-97 params shipped as `type: 'Object'` — a JSON textarea — and the schema comment
said why: *"the list is an ORDER over pairs of (account, sleeve set), and a control that
expresses that honestly is real UI work; a textarea over validated JSON says what it is, a
half-editor would not."*

That was right about the ORDER and has since stopped being true about the cost.
`buildRowListEditor` gained `reorderable` (a move-up button per row) for the design-95 lists,
which was the missing piece. With two more column types — `text` for an id the user invents,
`checkset` for an array-valued column over a closed list — an honest control is a composition
of parts that already exist. Both are now typed editors:

- **`DrawdownSequence`** — a reorderable (account, sleeves) row list. Deliberately NOT sorted:
  there is no invariant to sort by, and the order is the only thing the param says.
- **`LiquidityGraph`** — **three flat tables**: Pools, Claims, Flows.

### 17.1 Why a graph is three flat tables and not one nested editor

A pool holds a *list* of claims, so the natural shape is a list of lists — and a nested
repeating-row editor is exactly the "real UI work" the original comment named. Splitting
claims into their own table keyed by pool id makes all three tables flat, so all three are the
same shared component and none of them is bespoke.

It also makes the case that motivates the whole design as easy to author as the trivial one:
**a multi-account pool is one more row.** "One year of cash across two savings accounts" is
the reason a pool is a node rather than a sequence entry (§10), and in a nested editor it
would have been the awkward path.

The cost is that a pool's identity is a string typed in one table and selected in two others.
That is what `container.refresh()` is for: renaming a pool re-renders the claim and flow
tables, so a dangling reference shows as **"(not found)"** immediately rather than at Rebuild.

### 17.2 What the controls do NOT do

They do not re-implement `normalizeLiquidityGraph`. §6/§12.7 put validation at the config
boundary precisely because every way of getting a graph wrong produces a run that completes
and lies, and a second copy in the UI is a second thing to keep in step. What the editors do
is make the **vocabulary visible** — the account list, the sleeve set, the target and capacity
modes, the gate kinds — so most of those errors are no longer typable.

One is now structurally untypable rather than merely visible: **sleeve narrowing on a
non-brokerage account.** The sleeves column takes its options from the row's own account, so a
savings or offset claim renders "whole account" instead of checkboxes. §3.1's rule (sleeves
only mean something where the draw runs through `consumeHoldings`) stops being a paragraph in
a description string.

Two blanks stay load-bearing and are tested (`tests/viz/structured-param-editors.test.mjs`,
12 new tests):

- **blank sleeves = the WHOLE account**, so the key is omitted rather than written as `[]` —
  the normalizer rejects an empty claim outright, so writing `[]` would turn a valid config
  invalid;
- **an emptied list = `null`**, the shape every consumer reads as "no override".