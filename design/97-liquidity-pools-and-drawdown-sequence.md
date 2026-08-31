# 97 — Liquidity Pools: the unified drawdown sequence (scaffolding)

**Status**: Part I (§§1–9) **Built** (2026-08-29) — the spend sequence (§3) and years-based
pool sizing (§9). Part II (§§10–15) — the pool GRAPH, which closes the two gaps Part I deferred
(`FINDINGS.md` §6.3 capacity, §6.4 the refill rule) — is split into **effort 1** (logic +
settings) and **effort 2** (the control surface, §14, sketched only).
**Effort 1 is BUILT** (2026-08-29); §16 records what building it changed.
Tests: `tests/unit/evt-drawdown-sequence.test.mjs` (7), `tests/unit/evt-years-of-spend-target.test.mjs` (6),
`tests/unit/evt-liquidity-pools.test.mjs` (30).
§19 closed the "do not sell equity in a down market" requirement; **§20 reopens it** on a
different footing, answers it (§20.9), and records three engine defects the reopening found and
fixed — each silent, each producing believable numbers.
Study: `scripts/lab/sequence-risk/`. Probes: `scripts/probes/probe-pool-gate-foresight.mjs`,
`probe-offset-payment-drain.mjs`, `probe-return-autocorrelation.mjs`.
**Related**: `design/53-account-basis-refactor-and-offset.md` (offset accounts),
`design/54-loan-liability-accounts.md`, `design/65-allocation-aware-drawdown.md` (the
`consumeHoldings({selection})` seam this extends), `design/61-holding-allocation-lever.md`
(the rebalancer that refills), `design/29-behavioral-layer.md`.
**Prior evidence**: the offset-bucket study's own findings §6 (private, and referred to below
as `FINDINGS.md`) — the four gaps between
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
`scripts/probes/probe-refill-laundering.mjs`, run on the offset-bucket study plan
(FX pinned, 16-year horizon, deterministic):

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
Probe: `probe-pool-years-held.mjs`, in the study's own (private) directory.

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

(§19 is CLOSED and nothing in it was built. "Do not sell equity in a down market" is answered by
the rebalancer, not the spend walk; the veto that answers it makes the plan worse; and the sale
it was all aimed at turns out to carry ~no tax cost, because the class is immediately rebought
elsewhere. Read §19.2c before proposing anything in this space — the metric, not the mechanism,
is what went wrong.)


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
---

## 18. Scoring a pool SEARCH — the paired Monte Carlo counterfactual

**Status**: steps 1–3 **Built** (2026-08-30). Step 4 (the price frontier) proposed.
Tests: `tests/unit/mc-trough-metric.test.mjs` (8),
`tests/unit/pool-graph-generator.test.mjs` (16), `tests/unit/pool-arms-search.test.mjs` (13),
`evt-liquidity-pools.test.mjs` POOL-9a.

**Scope of this section**: the ENGINE and TOOLING a pool search needs, and the decisions taken
in building them. Measurements, arm lists, results and study conclusions live with the study
that produced them, not here — a design doc that accumulates a study's tables stops being
readable as a design.

Everything above §17 builds pools and measures them on **one deterministic path**, which
cannot price a sequencing device: order only matters when there is a bad price to avoid. The
search restates the question so a number can answer it —

> Generate identical return / inflation / rate / lifespan paths, run each path under each
> funding strategy, and measure the DISTRIBUTION OF DIFFERENCES in terminal wealth, minimum
> real wealth, spending shortfall and probability of failure. The value of a pool shape is the
> improvement in the chosen risk metric, **net of its incremental interest cost and tax**.

— and makes it a SEARCH rather than an A/B: an authored graph is one point in a space of
shapes and sizes, and pool-less is another point in the same space.

### 18.1 Five of the six pieces already existed

| the question needs | already built |
|---|---|
| identical worlds across strategies | `mc-run.mjs` seeds path *i* from *i*; `pairedRescues` / `pairedMetric` consume it |
| a whole strategy as an arm value | `levers.params.liquidityGraph` — §16.2's point exactly, and why the un-built `poolTarget::` params (§12.8) do not block a study |
| real sequence risk | `--paths` (year-by-year draws, `--drift GEOMETRIC`) |
| spending shortfall | `--spending` ⇒ `shortfallReal` / `wentShort` per path (design 89 phase 6) |
| **the interest cost leg** | the same cube's `INTEREST` category. "Net of its incremental interest cost" is a subtraction, not a feature |
| probability of failure | `failed` / `oof` per path |

### 18.2 Step 1 — the metric a reserve is scored on

MC carried two path metrics and neither can score a reserve. **`maxDrawdown`** is a fraction of
net WORTH, which counts the house and any company equity — the two things a reserve cannot
spend, so a plan can hold its net-worth drawdown flat while its spendable book collapses. And
**terminal wealth** is measured after the recovery, so it rewards whoever carried the most
equity through it (§7.1) — the bias a reserve study must not score itself on.

So the sampler records the **price level** beside the level it deflates, and `computePathShape`
reports the trough of REAL net liquidity in two forms:

| | |
|---|---|
| `minRealNetLiquidity` | the whole-path floor |
| `troughRealNetLiquidity` (+ `…Year`, `…Drawdown`) | the level at the bottom of the deepest fall from a running high — **the ranking metric** |

**Why two.** The whole-path floor is the OPENING BALANCE on any plan still accumulating at t0,
so every arm scores the same number and it is the one number no strategy can change. Found by
running it: the first real run put the median trough in the first sampled year. A peak has to
be set before there can be a fall, so the post-peak form cannot be reached by the opening
balance. The floor is kept because on a plan that decumulates from day one the two coincide and
the floor is the more direct statement; `mc-report --floor` asks for it.

Four decisions worth keeping:

1. **The deflator is sampled WITH the point**, never reconstructed afterwards. A per-run
   average price level would deflate a trough at the wrong instant, and the whole difference
   between *the reserve held* and *inflation ate it* lives in that number.
2. **It is the RESIDENCE price index** — the one `InflationAdjustReducer` inflates
   `state.monthlyExpenses` by — so real net liquidity is denominated in the basket it must
   cover (`expense-price-level.js`; currency is not the axis).
3. **A point with no price level deflates by 1**, making an un-indexed series a nominal trough
   rather than a shorter window.
4. **A path that only ever rose reports a zero drawdown, not null.** Null would drop it from
   every percentile and quietly restrict the distribution to the paths that fell.

Two limits: the series starts at the first year BOUNDARY, so t0 is not a candidate; and a path
that ran out of funds troughs at ~0 by construction, so **failure is the primary key**.

### 18.3 Step 2 — the graph is a function, not a document

`scripts/lib/pool-graph.mjs`. `buildPoolGraph(cfg, spec)` turns `{ order, cashYears, bondYears,
refill, refillTriggerYears, harvestGate, exclude }` into a whole `liquidityGraph`, reading the
plan for account TYPES only; `SHAPES` names the points on the shape axis. `POOL_LESS` is
`order: []` ⇒ `null`, so **the control is produced by the same call as every arm** and cannot
drift from them.

Hand-authored, a size grid is thirty near-identical JSON documents that drift in exactly the
ways nobody notices — a sleeve dropped from one arm, a flow left in another — and the study
then measures the drift.

1. **The residual rule makes §3.1 structural.** Every drawdown sleeve of every account the
   graph touches is claimed by exactly one pool; a class no named kind claims falls to the LAST
   pool in the spend order. "No bond bucket" therefore means BOND joins growth, rather than
   BOND keeping its own `drawdownPriority` and being spendable ahead of the pool that was
   supposed to come first.
2. **Four shapes throw rather than emit a plausible graph**: a *targeted* pool that would
   absorb the residual (a "4 year" reserve quietly becoming the whole book); cash accounts with
   no cash pool (unclaimed means drawn AFTER every pool, so the plan would sell investments
   while holding cash); a pool the plan cannot fill; and a refill edge into an unsized pool.
3. **Only the gate that survived §16.1b is emittable** — `sourceReturnOver`, never the
   trailing-high pair.

`OFFSET_CAP` is claimed only where the offset links to a property (§12.1). `exclude` drops a
book from the pools, and the doc comment insists on what that does NOT mean: an excluded
account keeps its `drawdownPriority` and is still spent, just after every pool.

**The reverse "buy the dip" edge is deliberately not generated.** §16.1(2) makes it a different
object — an in-portfolio edge needs exactly one allocation class at each end, so it cannot
attach to a `growth` pool holding EQUITY and GOLD together.

**The faithfulness check belongs with the study**: reproduce a hand-authored graph from a spec
and diff the claim sets. It is the generator's real test, and it needs a real plan.

### 18.4 Step 3 — the space, the hygiene and the landing gate

`scripts/lib/pool-arms.mjs`. `poolArmGrid()` enumerates the space; `poolArmSpec()` writes the
`{ base, arms }` file `mc-run.mjs` reads; `assertPoolArmLanded` and `assertArmsWealthMatched`
are the preflight. Three decisions:

1. **The hygiene lives in the spec's `base`, so the CONTROL gets it too.** Every setting there
   is one the pooled arms need and the control does not — which is exactly why both must have
   it. Applied to the pooled arms alone, the control runs a different allocation policy (§12.2)
   and a different crash, and the grid reports the difference as the pool shape. §16.3 makes
   this point about deleting flows; it is the same mistake one level up.
2. **Refill on/off is the FLAG, the gate is the graph.** `poolFlowsEnabled: false` with the
   flows still generated keeps pools, targets and spend order identical across the pair
   (§16.3); CASCADE vs CASCADE_HARVEST is a real difference in the graph.
3. **The control is emitted once.** A "pool-less, 4 bond years" arm is the control run again
   under a name claiming it measured something.

**Three shared-machinery defects fell out of building it**, all of the same family — a wrong
thing that runs:

- `mc-run.mjs` merged an arm's levers over the spec's base with a plain spread, so
  `base.params` was dropped **entirely** for any arm carrying `params` of its own — silently
  giving every arm a different baseline than the spec states. `params` now merges one level
  deep (`mergeArmLevers`); every other lever is still replaced whole, because nothing else in a
  lever set is a bag of independent keys.
- **`--spending` was not one of `mc-run.mjs`'s flags.** Its hand-rolled parser accepted and
  ignored it, so a run asked for the classified-spending cube, paid none of its 7.5x, and wrote
  arm files with no spending data. The flag is wired (`serializeArm` was also dropping
  `spendingRuns`) and the parser is now the shared `parseFlags`, which **rejects an unknown
  flag and names the near miss**. The fix is to stop hand-rolling the parser that permits the
  typo.
- A cfg's accounts carry `type` (a serializer export) or only a `__type` class discriminator
  (`buildDefaultConfig`). A helper reading only `type` classifies every account as
  none-of-the-above against a synthetic base. `accountType()` reads either, and an untyped list
  throws with the cfg-shape diagnosis rather than the plan-has-no-accounts one.

### 18.5 A pool target of ZERO is a target

`_resolvePoolTarget` guarded with `target > 0`, conflating *the pool resolved no target* with
*the pool's target is nothing*. So the 0-year row of a size sweep fell through to the AUTHORED
weight for that class, and the bottom row of a series was not a member of it. The guard is now
`Number.isFinite`. Test POOL-9a pins both halves, since a pool with genuinely no target must
still fall through — that is the case the old guard was written for.

Found in the field, by a size sweep whose 0-year arm held more bonds than its 2-year arm.

### 18.6 What any pool search must control for

Three properties, each learned by getting one wrong. They are stated here because they are
constraints on the tooling, not findings about a plan.

1. **Arms must be ALLOCATION-matched, not merely wealth-matched.** §9.2 is explicit that a
   years-of-spend target sizes the MIX with equity taking the residual, so the size axis is
   also an equity-share axis — and a pool-less control holding its authored weights differs
   from every pooled arm by both a drawdown order and a portfolio. `assertArmsWealthMatched`
   was watching the wrong invariant. The remedy is a second control per pooled arm, pool-less
   but pinned to that arm's realized mix: **pooled vs matched control is the pool effect at
   constant allocation; matched control vs authored control is the allocation effect.**
2. **The ranking percentile must clear the failure rate.** A failed path troughs at ~0, so on a
   plan failing 15-20 % of the time a p10 trough reads zero for every arm including the
   control. Read a percentile above the failure mass, or condition on survival with failure as
   the primary key.
3. **Shape is not a deterministic axis, and must be gated structurally.** Changing the ORDER
   money is taken in only matters when there is a bad price to avoid, so on a smooth path two
   orders that draw the same dollars agree to rounding. Gate shape on the compiled
   `drawdownSequence` differing — a smooth path cannot hide that, and a dropped shape lever
   cannot survive it — and let the paths price it. Size and the refill flag DO move a
   deterministic answer, and a failure to do so there is a dead lever.

4. **An account no pool claims is not deprioritised — on many plans it is never spent.** §3.1
   rule 3 puts unclaimed accounts after every pool, and a plan whose pools do not run dry never
   reaches them. Measured: pool-less arms drained the age-gated wrappers to zero over the
   horizon while every pooled arm ended holding them untouched, because the graph named only
   the accessible book. Authoring a partial graph therefore authors "never touch the wrappers"
   **silently**, and the effect is large and high-variance — it swings the terminal composition
   in both directions rather than costing a little. A study that means to compare draw ORDERS
   must either claim every spendable account or state the exclusion as one of its axes; the
   generator's `exclude` doc comment says this about an explicit exclusion, and it is equally
   true of an implicit one. `POOL_KIND.WRAPPERS` + `withWrappersAt()` make the placement an
   axis rather than an accident.

   **The corollary is sharper than the rule**: a pool placed BELOW a pool that never runs dry
   is not a low-priority pool, it is an unclaimed one. Measured on a placement sweep, putting
   the wrappers after the growth bucket left 88-92 runs out of 100 byte-identical to not
   claiming them at all — the two positions are the same arm except on the near-failure paths
   where the book actually empties. So "spend it last" and "never spend it" are the same
   statement unless something ahead of it is exhausted, and a study sweeping position has to
   check which of its points are distinct rather than assume the order it wrote is the order
   it gets.

Corollary for any preflight: probe deep enough that the reserve is being SPENT. At a near date
every arm differing only below the bonds is literally the same run, because the pools ahead
still cover the whole spend line.

### 18.7 Step 4 (proposed) — report the price, not the winner

Per path, Δ against the matched control on terminal after-tax NW, `troughRealNetLiq`,
`shortfallReal` and failure, against the cost leg (Δ lifetime `INTEREST` + Δ lifetime tax).
Plotted, that is the frontier the question asks for: expected dollars given up per point of
failure probability, and per dollar of tail trough.

**The objective**: rank on the post-peak trough of real net liquidity at a percentile above the
failure rate, subject to failure probability ≤ the matched control, with terminal wealth and
interest cost reported alongside rather than inside the objective. The alternative — scoring on
the existing `MAX_CRRA_UTILITY` — prices the whole path in one number and hides the very trade
the study exists to show.

### 18.8 Traps carried forward

- **Wealth-match AND allocation-match every arm** (§18.6).
- **No dated shock when `--paths` is on**: double-counted downside, and a *foreseen* dated
  crash biases exactly this class of timing lever.
- **Preflight that the graph reached state** (§7.2 — `cfg.params` rows key on `name`).
- **Identical sampled-variable set across arms**, or common random numbers stop pairing.
- **`mc-report` globs the output directory** — prune between runs, or a stale arm joins the
  report.
- **A glidepath and pool targets do not compose, and the collision is silent.** Authoring both
  is legal: under §12.2 the graph governs the classes a pool targets, so the glidepath is left
  governing only the residual and the anchors the author wrote are not the mix the plan holds.
  §9.4 says this about `YEARS_OF_SPEND`; it is equally true of a graph target, and deserves the
  same warning the location-policy mismatch was promised (§12.2). For a study whose axis IS the
  pool, the glidepath comes out.
- **Pool shape is fixed for life, and should not be** (raised 30 Aug, not built). A glidepath
  says the MIX may change with age; nothing yet says the pool STRUCTURE may. The natural shape
  is `target` taking an anchored schedule the way `allocationGlidepath` does, or a pool carrying
  `notBefore`/`notAfter`. Non-trivial precisely because of §12.2: a time-varying pool target and
  a glidepath would be two schedules over the same classes.

---

## 19. Not selling equity in a down market — CLOSED, all three candidates fail

**Status**: CLOSED 30 Aug 2026 as stated, and **REOPENED the same day on a different metric —
see §20**. Everything below stands: all three candidate mechanisms are measured, one exists and
fails economically (§19.2(3)), and §19.2b/§19.2c dispose of the other two. What §20 changes is
not a candidate but the *harm* — §19.2c's own diagnosis was that the requirement had none, and
a requirement that names one is a different requirement. Read §19.2c first; it is still the
reason none of §19.3–§19.5 was built.

**Two things below are now false as written**, both found by §20 and both fixed there, and
neither rescues a candidate (§20.9 reaches §19's verdict by an independent route): `gate.sourceReturnOver` was reading the return of the year it was
deciding in (§20.2), and `equityReturnReversionSpeed` never reached the return process (§20.3).
The §19.2(3) veto measurement was taken with the clairvoyant gate, so its *mechanism* number
(crash-year disposals to zero) was flattered; its economic verdict — worst arm of the set —
was not, and if anything the honest gate can only be worse.

### 19.1 The requirement

*Do not sell equities while the market is down; use the offset facility instead.* It is the
classic bucket-strategy rule — pause equity sales in a falling market and let the near-term
buckets carry the household — and it is what the offset in the pool study is FOR.

A pool's `spendOrder` is unconditional (§3), so the graph cannot say it today.

### 19.2 Three things measurement established first

Each of these changes what the feature should be, and each was arrived at by getting the
previous one wrong.

1. **Score GROSS disposals, never net.** A crash year that sells \$114k of equity and buys \$97k
   back nets to −\$17k and reads as "barely touched" — the drift band buys the dip, so *every*
   net measure says no equity is sold in a crash. The sale still happened, at the bottom, still
   realizing. §7's original probe used the net measure and this design believed it twice.

2. **The seller in a crash is the REBALANCER, not the spend walk.** Measured per account under a
   dated crash: the taxable brokerage sold \$114k of equity while a super account bought \$77k —
   the design-61 LOCATED planner moving a class between accounts. With a bond reserve in front
   of it the spend walk never reaches the equity sleeve at all, so essentially none of that sale
   is a spending draw.

   **Therefore a spend-side feature cannot, by itself, stop the sale that was measured.** A pool
   cannot intercept a draw that does not pass through it. That is the single most important
   sentence in this section and it is why §19.3's obvious design is not the answer.

3. **The rebalance veto — which DOES intercept it — works mechanically and fails economically.**
   `gate.sourceReturnOver` on the `growth → buffer` edge is executor 1's veto (§12.4), and under
   a dated crash it takes crash-year gross equity disposals from \$114k to **zero**. It is also
   the worst arm measured: failure 39/100 against 33 (no flows) and 32 (an ungated cascade), 0
   worlds rescued and 6 broken, median after-tax wealth down \$1.8m.

   The mechanism is the finding. With equity pinned, the rebalancer cannot sell it to refill the
   buffer — so the cascade drains **the buffer** into cash to fund spending instead. The
   household leaves the crash holding less cover and more equity, and rebuilds the reserve by
   selling into the recovery. **The veto does not hold cash instead of selling equity; it spends
   the reserve instead** — and the reserve is what was providing the protection. It is a
   leverage strategy wearing a protection strategy's name, and it prices like one: it wins the
   rebound paths and breaks the ones without a rebound.

   Corollary, and the design constraint for anything built here: **the gap has to be funded from
   somewhere.** Refusing to sell equity in a crash is not a saving, it is a redirection, and the
   whole value of any feature in this space is *which source absorbs it*.

### 19.2b The attribution — MEASURED (30 Aug 2026)

§19.2(2) named the rebalancer as the crash-year seller and stopped there. But a rebalancer sells
equity in a crash for two structurally different reasons, and §19's two live candidates address
one each — so the sale was split before either was built. Three arms, same pools, sizes and
spend order, one variable at a time: the baseline; the same plan under
`allocationLocation: PER_ACCOUNT`, where no cross-account placement is possible; and that again
with no reserve to restore. Two crash dates, early and late, because the facility decays.
(Numbers in `POOL-SEARCH.md` §9.)

**The generalizable results, which is all that belongs here:**

1. **Cross-account LOCATION churn is the majority of the crash-year sale** — half to two thirds
   of it, at both crash dates. It is the design-61 LOCATED planner relocating a class, it is a
   real tax event, and **no liquidity feature can displace it**, because it is not a liquidity
   event. This is candidate B's target.
2. **Within-account target RESTORATION — the only component a spend-side gate could prevent —
   is a small single-digit percentage of the sale, and at the early crash it is indistinguishable
   from zero.** Candidate A's ceiling is therefore an order of magnitude below the number §19
   set out to reduce. The no-reserve arm changes the MIX as well as the mechanism, so it bounds
   that component rather than measuring it cleanly — which only strengthens the conclusion,
   since even the ceiling is small.
3. **The facility that would fund candidate A decays to nothing well inside the plan.** Its
   capacity is `min(balance, linked loan balance)` (§12.1) and the loan amortises: measured
   against the household's own live spend line it starts under two years of spend, falls below
   one within four years, and is **identically zero for the last third of the run**. §19.3's
   second caveat was right and is quantitative. Worse, the two facts compose in the wrong
   direction: restoration is largest at the LATE crash, which is exactly when the facility is
   already gone.

**Decision (superseded by §19.2c — B was not built either).** A is bounded
above by a small fraction of the sale, funded by an instrument that expires before that fraction
gets interesting. B addresses the majority and has no such decay. §19.5's closing paragraph
still stands on its own merits — `spendWhen` as a way to hold a facility out of the ordinary
walk is a real policy — but it is not this requirement's answer, and the attribution run also
showed the facility falling at a flat rate in every arm, crash or no crash: that is the
amortisation schedule, not a response to anything.

### 19.2c The requirement does not survive its own metric — CLOSED (30 Aug 2026)

§19.2b said "build candidate B". Before building it, one thing was checked that nothing in this
section had checked: **whether the location churn is a harm at all.**

It is not obviously one. The planner sells taxable equity and **rebuys the same class inside a
wrapper**. The household keeps the exposure; nothing is lost to the market; the entire cost is
the tax. So the question is the SIGN of the realized gain, and measured on both crash dates the
answer is: **small, and inconsistent in sign.** At the early crash the relocation realizes a
LOSS — in this model a tax *benefit*, so freezing it would destroy value. At the late crash it is
noise on a relocation several times its size. (Numbers in `POOL-SEARCH.md` §10.)

Three things follow, in ascending order of importance.

1. **Candidate B is not worth building either.** Its target is real and is the majority of the
   volume (§19.2b), but removing it is not reliably a saving.

2. **The metric was wrong the whole way, and this is the second time.** §19.2(3) killed the veto
   because it scored perfectly on the mechanism and worst on the economics. §19.2b then picked
   the next candidate *by the same mechanism number*. Gross disposal volume was never a proxy for
   harm: **selling equity in a crash and immediately rebuying the same class in another account
   is not "selling into a down market" in the sense §19.1 means.** The exposure is retained, only
   the tax changes, and in a crash the lots sold are at or below their basis. A requirement stated
   as "do not sell X" needs a harm to name; this one never had one, and every candidate it
   generated was scored against the absence.

   The generalizable rule, and the reason this section is worth keeping now that it is closed:
   **a mechanism metric may select a candidate but must never validate one.** Both halves of §19.6
   said this; §19.2b applied only the first half.

3. **What the measurement actually found is a correctness question elsewhere.** The realized loss
   at the early crash sits on a taxable sale whose replacement lands in a SHELTERED wrapper — the
   Rev. Rul. 2008-5 fact pattern, where the loss is disallowed *and destroyed*, with no basis
   increase anywhere. That rule is unmodelled (design 94 §8.1). If the loss is not real, the
   location planner is manufacturing tax benefits in every down year, in every plan, whether or
   not anyone ever builds a feature here. **That belongs to design 94 and is larger than anything
   §19 proposed.**

Nothing below this line was built. §19.3–§19.5 are kept as the record of what was considered and
why each was rejected; §19.6's measurement design is the part worth reusing.

### 19.3 Candidate A — `pool.spendWhen` — MEASURED AS NOT WORTH BUILDING for this requirement (§19.2b)

The §12.3 gate object applied to the spend walk: shut ⇒ the pool is skipped and the walk moves
on. The vocabulary exists, and `poolMarketReturn` already reads the live rate table.

**Its value is not "the offset gets spent ahead of equity".** §19.2(2) shows the walk never
reaches equity anyway. The hypothesis worth testing is one position further forward:

> In a crash, promote the offset to the **front** of the walk, so the cash and bond pools are
> not drawn down at all. The reserve stays at target, the rebalancer has nothing to refill, and
> the facility — not the reserve — absorbs the year's spending.

That is the §19.2(3) corollary answered with the one source that is neither the reserve nor the
equity. It is the only untested candidate, and it is a genuinely different proposition from what
was measured: the veto redirected the gap onto the reserve, and this redirects it off the balance
sheet entirely, at the cost of loan interest.

Two known reasons it may still disappoint, both worth stating up front rather than discovering:

- **It may not touch the measured sale.** The \$114k was cross-account location churn, which is
  driven by the location policy and not by spending. Keeping the pools full removes the *refill*
  pressure; it does not obviously stop the planner relocating a class.
- **The facility is small relative to the gap**, and it decays: an offset's capacity is
  `min(balance, linked loan balance)` and the loan amortises (§12.1). A backstop sized in years
  of spend is a different instrument from one sized by whatever debt happens to remain.

### 19.4 Candidate B — freeze the LOCATION planner in a crash — REJECTED on measurement (§19.2c)

Not designed, not sketched anywhere else, and the only candidate that addresses the measured
\$114k directly: suppress cross-account relocation of a class while that class is down, so a
crash cannot trigger a taxable sale whose only purpose is to move equity into a wrapper.

It belongs to design 61 rather than here, and it is named in this section only so the next
session does not re-derive §19.2(2) from scratch. It is also the candidate with no obvious cost:
deferring a location move is not deferring a spend.

### 19.5 If `spendWhen` is built

One architectural decision is forced. **§12's build-time compile has to move.**
`compileToDrawdownSequence` runs once, in the toolset's state projection; a conditional order
must be re-derived every period. The seam exists — `PoolFlowReducer` already runs at
`PRE_PROCESS`, after the regime reducers stamp `state.activeRegimes` and before spending — so
the move is small, but it weakens §12's "no second drawdown code path" guarantee and should be
taken deliberately.

On the condition: `notInRegime` looks like the natural fit and is **inert today** — the shock
presets carry `tags: []` (§16.1b), so a regime-tag gate silently never fires. Either the shock
library learns to stamp tags, or the condition uses `poolMarketReturn`, which is built, tunable,
and does not require the crash to be declared.

`spendWhen` is also worth having for its own sake, independent of this requirement: *hold this
facility out of the ordinary walk so it is still there later* is a real policy, and the
alternative (a `floor` on the pools above it, §15 Q1) says something weaker and less directly.
Measured on the pool study, a claimed offset with no such gate is drained early in ordinary
years and is gone before any crash arrives.

### 19.6 How to test whichever is built

The measurement design is settled and should not be re-derived:

- **A dated shock, identical on every arm.** The usual objection (a foreseen crash biases a
  timing lever) does not apply to a gate: it reads current market state and reacts, it cannot
  foresee. Note the pool study's standing hygiene sets `shocks: []`, which is why the veto went
  three rounds without ever meeting a crash — the arm set for this question must override it,
  and must **assert that the override landed**.
- **Score gross taxable equity disposals in the crash year, per account** (§19.2(1) and (2)),
  alongside failure, the post-peak trough and after-tax wealth. A mechanism result and an
  economic result are different questions and this feature separates them: the veto scored
  perfectly on the first and worst on the second.
- **Include an arm that changes nothing but the mechanism.** The veto's verdict was mis-attributed
  for three rounds because the grid held no ungated cascade, so two things differed at once.

---

## 20. Reopening §19 — the requirement with a harm and a price (30 Aug 2026)

**Status**: **CLOSED with an answer** (30 Aug 2026). The engine work is built (§20.2, §20.3,
§20.4b, all with tests), the scenario and arms are in `scripts/lab/sequence-risk/`, and the
study is run — §20.9 has the numbers and §20.10 says what would have to exist for the answer to
be different. Three probes are in source control and are the record of the measurements:
`probe-pool-gate-foresight.mjs`, `probe-offset-payment-drain.mjs`,
`probe-return-autocorrelation.mjs`.

**The one-line answer.** The policy is not a liquidity strategy in this engine; it is leverage
plus a bet on a number the engine cannot produce. Deferring equity sales into the offset earns
nothing under IID returns (a coin flip: 164/300 paths, +\$4.9k median on \$13m) and LOSES under
the only other process available, which turns out to be momentum rather than mean reversion
(66/300 paths). What does move money in these arms is the borrowing, and it prices like
borrowing: a better median with a fatter left tail and more ruin.

### 20.1 What is actually different from §19

§19.2c closed the requirement on a real defect in it: *"do not sell X" names no harm*. Gross
disposal volume was the only thing being scored, and most of that volume turned out to be the
location planner selling taxable equity and rebuying the same class in a wrapper — exposure
retained, only the tax changed, and the sign of that tax was inconsistent. Nothing was left to
save.

The restatement names both sides:

- **the harm** — shares sold at a depressed price are permanently gone from the recovery. That
  is a claim about the *wealth path*, not about volume, and it is scored on terminal after-tax
  wealth and on failure;
- **the price** — an offset drawn down stops suppressing loan principal, so the deferral is
  bought with interest.

§19's rule survives intact and governs the whole of §20: **a mechanism metric may select a
candidate but must never validate one.** Disposal volume appears in the report as diagnostics
and never as an outcome.

**The load-bearing consequence, and it is not about liquidity at all.** Whether the rule can
work is decided by the RETURN PROCESS before any pool shape is chosen. `EquityReturnTickHandler`
defaults to `WHITE_NOISE` — explicitly, "equity returns are close to IID" — and every arm in
§§16–19 ran on it. Under IID returns *there is no recovery to wait for*: a down year says
nothing about the next, so "spend the offset now and refill it after the market comes back"
degenerates to **borrow at the loan rate to stay invested**. That is §19.2(3)'s "leverage
strategy wearing a protection strategy's name" — reached this time by reading the process
rather than by three rounds of measurement.

The handler also offers `MEAN_REVERTING`, where a down year does predict an up one. So the
study's primary axis is `equityReturnModel`, not the pool graph:

- pays under `MEAN_REVERTING` and not under `WHITE_NOISE` ⇒ the strategy is worth exactly the
  mean reversion the author believes in and nothing else. That converts a real-world intuition
  into a number a scenario can carry, and every future bucket question inherits it;
- pays under both ⇒ it is the leverage, and §20.7's arm B is what shows that.

Either way the section closes with a finding, which is what §19 could not do.

### 20.2 The gate could see the year it was deciding in — MEASURED and FIXED

Every candidate in §19 rests on `gate.sourceReturnOver`, which reads `poolMarketReturn`, which
read `state.effectiveGrowthRates`. Two writers sit one priority step apart inside the same
period advance:

| priority | reducer | what it does |
|---|---|---|
| `PRE_PROCESS + 1.5` | `EquityReturnReducer` | folds this tick's draw onto the rate table |
| `PRE_PROCESS + 3` | `PoolFlowReducer` | the gate reads it |

and the holdings grow later in the same period. `probe-pool-gate-foresight.mjs` patches
`_gateOpen` to record what the gate saw *at the instant it saw it*, and measures the realized
return over the year that follows (Δ market value net of Δ cost basis, the convention of
`probe-bucket-sequencing.mjs`):

```
                          corr w/ realized(t)   corr w/ realized(t-1)
  the LIVE rate table           1.0000                0.0704
```

Perfect correlation with the year the gate is deciding in. Since the equity tick is annual, that
is a full year of foresight: the gate paused equity sales in the year the market was *about to*
fall. It is worth an enormous amount, it has nothing to do with liquidity, no household can do
it, and the failure is silent — the number is believable either way. It is the same shape as the
three mis-attributions §19 already records, one layer further down.

**The fix.** `PoolFlowReducer` already computes `marketReturn` per pool per period; it now stamps
it on the cube, and `sourceReturnOver` / `targetReturnUnder` read the **prior** period's stamp.
`sourceReturnOver: 0` therefore means *"sell the source only after an up year"*, not *"only in an
up year"* — the two differ by a year of foresight and only the first is implementable. The
absent-reading defaults are unchanged and now also cover the first period: no reading leaves
`sourceReturnOver` open and `targetReturnUnder` shut, because "no signal" is not "bad signal"
(POOL-12b's rule).

The existing gates were changed rather than joined by honest siblings, deliberately: a
clairvoyant gate has no legitimate use, and no shipped finding depends on one — §19 built
nothing. `evt-liquidity-pools.test.mjs` POOL-12 now declares the world on the cube; **POOL-12c**
is the regression, and it asserts the property from both sides in one test, because a
catastrophic *current* rate that leaves the gate open would also pass against a gate that reads
nothing at all.

**The generalizable rule.** *A reducer that gates on a rate table stamped earlier in the same
period advance is reading the future.* Swept for siblings: `PoolFlowReducer` is the only consumer
of `effectiveGrowthRates` as a SIGNAL. The behavioral trio that also reacts to market state
(`PanicSellReducer`, `DownturnRothConversionReducer`, `OpportunisticRebalanceReducer`, all at
`PRE_PROCESS + 4`) read `state.activeRegimes`, which a shock stamps on the same tick it books its
revaluation — they react to a fall that has already happened, and are unaffected.

The probe stays, and it still prints the LIVE row next to the acted-on one. That row is not a
bug report: it is a standing demonstration that the live rate table IS the coming year's return,
which is why no gate may read it.

### 20.3 The mean-reversion speed never reached the process — WIRED

`EquityReturnTickHandler` has always accepted `reversionSpeed`, and
`economic-regimes-toolset.js` never passed it — so `MEAN_REVERTING` ran at the constructor's
`0.3` whatever a scenario said. A process switch whose one tuning knob cannot be reached is a
switch with a hidden constant behind it, and §20.1 makes that constant the single number this
study's answer turns on.

Added `equityReturnReversionSpeed` (default `0.3`, mirroring `yieldCurveReversionSpeed`) and
passed it to both the equity handler and `PropertyReturnTickHandler`, which already borrows the
equity model and vol and would otherwise disagree about what `MEAN_REVERTING` means whenever
`shareMarketFactor` is off. `variant.mjs` exposes it as `stochastic.equityReversion`.

The test is a pair, and needs to be: the OU sweep must move the run, and the same sweep under
`WHITE_NOISE` must be exactly inert. Either assertion alone passes against a param that reaches
nothing.

### 20.4 The offset has a second drain, and pinning it only changes which end dies

An arm that spends the offset in a down market measures that policy only if nothing else is
draining the offset meanwhile. `resolveLoanCashKey` (design 54 P4) says something is: absent an
explicit `paymentSourceKey`, a loan direct-debits a same-currency offset linked to its property,
ahead of the ordinary cash resolver. `probe-offset-payment-drain.mjs`, one variable — where the
mortgage debits — on a synthetic 16-year run:

```
        A: payment debits the OFFSET (default)   B: payment debits AU savings
year     offset       loan    facility           offset       loan    facility
2026   A$264,000  A$369,116  A$264,000         A$300,000  A$368,280  A$300,000
2030   A$120,000  A$248,336  A$120,000         A$300,000  A$227,887  A$227,887
2034         A$0  A$132,332        A$0         A$300,000   A$83,887   A$83,887
2037         A$0   A$37,440        A$0         A$300,000        A$0        A$0
```

`facility` is `min(balance, loan)` — `POOL_CAPACITY_MODE.OFFSET_CAP` (§12.1), the figure that
decides how much spending the backstop can actually absorb.

**Two different decay mechanisms, and pinning converts one into the other.** In A the direct
debit consumes the cash at the full P&I, flat, and the facility is dead in year 9 — of the
policy's own money, before any crash. In B the offset holds, and the facility now tracks the
**loan**, which amortises to zero anyway. This is §19.2b's "the facility decays to nothing well
inside the plan" split into its causes, and it explains §19.2b's other observation — the facility
falling at a flat rate in every arm, crash or no crash — as the direct debit, not a response to
anything.

**Consequence for the arm design, and it is not optional.** The scenario that tests the mechanism
must pin `paymentSourceKey` **and** run the loan interest-only, or the facility expires before the
theory can be exercised and a null result means only "the offset ran out". Facility decay is a
real constraint and deserves its own arm — but it is a *second* question, and leaving it inside
the first one is how §19 spent three rounds attributing results to the wrong cause.

### 20.5 The mechanism needs no new code

§19.5 held that testing this forces `spendWhen`, and with it §12's build-time compile out of the
toolset's state projection — weakening the "no second drawdown code path" guarantee. It does not,
because **spending the offset first with a return-gated refill is the conditional spend**:

- **up year** — spend the offset, refill it from equity ⇒ net identical to selling equity to
  spend;
- **down year** — spend the offset, refill gate shut ⇒ the offset carries the year and equity is
  untouched.

The refill is `growth → offset`, `amount: toTarget`, `gate: { sourceReturnOver: 0 }`. It is a
cross-account edge, so `PoolFlowApplyReducer` executes it through `replenishSavings` — real
disposal, real CGT, the taxing seam intact (§12.4). All of it exists.

This is worth stating as a general property rather than a trick: **a conditional draw order and an
unconditional draw order with a conditional refill are the same policy**, and the second is
expressible in the graph as it stands. `spendWhen` may still be worth building for the reason
§19.5's closing paragraph gives — holding a facility out of the ordinary walk so it is still there
later — but that is a separate argument and this study does not need it.

### 20.6 The minimal scenario

§19's measurements were taken on a plan carrying a bond reserve, a cross-account location planner
and a rebalancer, and every one of those turned out to sit between the policy and the thing it was
supposed to change (§19.2(2): "a pool cannot intercept a draw that does not pass through it").
The scenario for §20 removes each of them by construction:

| element | setting | why |
|---|---|---|
| growth book | one taxable brokerage, EQUITY only | no bond reserve between the spend walk and equity — the draw the policy is about actually reaches it |
| location | `allocationLocation: PER_ACCOUNT` | no cross-account relocation, which §19.2b measured as the majority of crash-year volume and §19.2c showed is not a harm |
| the facility | offset + property + interest-only loan, `paymentSourceKey` pinned to cash | §20.4 |
| spending | fixed, real | a guardrail cannot run out of money, so `failed` would stop being informative |
| shocks | dated, identical on every arm, and **asserted to have landed** | the pool study's standing hygiene is `shocks: []`, which is why §19's veto went three rounds without meeting a crash |

A dated shock is legitimate against a gate that reads the *prior* period, and only now: §19.6
argued a gate "reacts, it cannot foresee", which was the right principle applied to a mechanism
that did not satisfy it (§20.2). The stochastic arms carry the weight regardless; the dated crash
is the readable case.

### 20.7 The arms and the metric

One variable each (§19.6's third rule, which the veto grid lacked):

| arm | what it is |
|---|---|
| **A** control | spend equity directly; the offset is untouched |
| **B** mechanism | offset first in `spendOrder`, refill **ungated** |
| **C** the theory | as B, refill gated `sourceReturnOver: 0` |
| **D** bound | as C with no refill at all — the pure deferral |

B is the arm the study lives or dies on: by §20.5 it should land on top of A, and if it does not,
the difference is plumbing rather than policy and C means nothing. Each arm runs under both
`WHITE_NOISE` and `MEAN_REVERTING`, paired on identical seeds.

**Scored**: after-tax terminal wealth as a PAIRED per-path difference (C−B, never a difference of
two medians), failure count with worlds rescued and worlds broken, cumulative loan interest paid
— the price, which is the half §19 never had — and the post-crash trough. Gross equity disposals
are reported as diagnostics, labelled as such.

### 20.4b A refill could never fill an offset pool at all — FOUND BY THE ARMS, FIXED

Building the arms found a third defect, and it is the one that would have made the whole study
report a null result about a policy that never ran.

`POOL_CAPACITY_MODE.OFFSET_CAP` was `min(balance, linked loan)` (§12.1). That expression is
never greater than the balance, so `headroom = max(0, capacity − balance)` was **identically
zero for every offset pool in every state** — and a flow's transfer is clamped by headroom. No
refill edge could put a dollar into an offset, least of all a drained one, which is the only
time a refill is wanted. In the first run of the arms the offset drained to zero in year one
and stayed there in all three of B, C and D, which were byte-identical as a result.

The failure was silent in the way this design keeps naming: a pool sitting exactly at its
stated capacity looks correct.

It is also the failure `pool-metrics.js` already carries a warning about, one branch further
up — *"BALANCE mode means this pool has no ceiling of its own, NOT that its ceiling is what it
currently holds. Conflating the two makes `headroom` identically zero and no refill can ever
fire"* — written by the same hand that then shipped the same conflation in `OFFSET_CAP`.

**The fix separates two things §12.1 had in one field.**

| field | meaning |
|---|---|
| `capacity` | the CEILING — the linked loan balance. The most that can usefully be parked. |
| `utilised` | `min(balance, capacity)` — how much of the pool is doing work. §12.1's figure, in the field that means it. Cash above the debt suppresses no interest, which is a statement about the balance being too big, not about the ceiling being small. |

`headroom` is now right in both regimes: zero when the offset already exceeds the debt (POOL-4's
case, unchanged), and `loan − balance` when it is drawn (POOL-4d, new). §12.1's prose above is
superseded on this point.

### 20.8 What closes this section

A statement of the form: *under this return process, at this reversion speed, deferring equity
sales into the offset is worth X per path, costs Y in interest, and rescues/breaks Z worlds* —
with the `WHITE_NOISE` column present, because a strategy that only works under an assumption
should be read next to the assumption.

### 20.9 The answer — MEASURED (30 Aug 2026)

`scripts/lab/sequence-risk/`, 300 paired paths per arm, equity vol 18 %, common random numbers
(asserted: every arm sees the same realized equity path on the same seed, or the report says so
and refuses to be read as paired). All figures are per-path differences in after-tax terminal
wealth, on the synthetic scenario of §20.6.

**First, the process. This is the finding everything else follows from.**
`probe-return-autocorrelation.mjs` measures the lag-1 autocorrelation of annual equity returns
in each world the engine can produce:

| process | measured ρ(1) | predicted |
|---|---|---|
| `WHITE_NOISE` | −0.001 | 0 |
| `MEAN_REVERTING`, k = 0.9 | **+0.409** | e^(−k) = 0.407 |
| `MEAN_REVERTING`, k = 0.5 | **+0.601** | 0.607 |
| `MEAN_REVERTING`, k = 0.15 | **+0.830** | 0.861 |

`EquityReturnTickHandler` reuses `FX_PROCESS_MODELS`, whose OU step is
`dev_t = dev_(t−1)·e^(−k·dt) + σ·√dt·z`. For FX that runs on a RATE — a level — and is genuinely
mean-reverting. For equity it runs on the deviation of a RETURN, which is already a rate of
change, so consecutive **returns** are correlated at e^(−k): positively. **What the enum calls
mean reversion is momentum**, and a lower k is *more* persistent, not less.

The generalizable statement, and the reason this is worth keeping: *an OU on a level
mean-reverts; the same OU on a rate of change is momentum.* One shared process library across
two quantities one derivative apart is what hides it.

That settles the requirement before the arms are read. "Do not sell in a down market, sell after
the recovery" is a bet on ρ(1) < 0. **The engine has no world with ρ(1) < 0.** IID offers
nothing to wait for; the OU makes the rule actively wrong, because a down year predicts another
down year and the household holds through a continuing decline.

**The gate itself — C − B, per path:**

| world | median | wins | p10 | rescued / broken |
|---|---|---|---|---|
| IID, no crash | +\$4.9k | 164/300 | −\$54k | 0 / 1 |
| IID, dated crash | +\$23.7k | 192/300 | −\$109k | 1 / 2 |
| momentum, no crash | \$0 | 66/300 | −\$260k | 0 / 2 |
| momentum, dated crash | −\$8.4k | 105/300 | −\$227k | 0 / 6 |

A coin flip where there is no information (164/300 is 55 %, on a median terminal wealth of
\$13m — 0.04 %), and a loser where the information points the other way (66/300). The one
column where it earns anything is the dated crash, and that world contains a rebound **by
construction**: a shock's recovery curve is declared in advance, not drawn. Even there it is
+0.29 % of median wealth, bought with a p10 of −\$109k and two worlds broken against one
rescued.

**What actually moves money in this arm set is the borrowing.** B − A is the carry of routing
spending through the facility at all, and its sign is the leverage's P&L rather than a fee:
+\$116k median with no crash, −\$46k with one, −\$437k under momentum-with-a-crash. D — draw
the facility and never repay it — has the best median of any arm under IID (+\$367k over B) and
the worst tail (p10 −\$381k, **9 worlds broken against 0 rescued**). That is the signature
§19.2(3) described from one path and one arm: *a leverage strategy wearing a protection
strategy's name*, and it prices like one.

**Three conclusions.**

1. **§19's economic verdict is confirmed by a completely independent route**, on a scenario
   built to remove every confound §19 tripped over, with a named harm and a priced cost. It is
   not that the mechanism could not intercept the sale (§19.2(2)) or that the volume was not a
   harm (§19.2c) — here the mechanism *does* intercept and the harm *is* named, and the policy
   still earns nothing.
2. **The requirement was never a liquidity question.** It is a question about the return
   process, and it was decided by ρ(1) before any pool was drawn. A liquidity feature cannot
   create a rebound to sell into.
3. **The one thing worth keeping from all of §19 and §20 is the instrument, not the policy.**
   Three engine defects surfaced only because something finally tried to use the gate for real
   (§20.2, §20.4b, and the unwired knob of §20.3), and each was silent and produced believable
   numbers. That is the return on building the arms.

### 20.10 What would have to exist for the answer to change

One thing, and it is not in this design's territory: **an equity return process with negative
lag-1 autocorrelation** — an OU on the price LEVEL relative to trend, so that a fall creates a
subsequent excess return, rather than an OU on the return, which creates persistence. That is a
design-74 change, it moves what every Monte Carlo in the repo means, and it should be taken
deliberately rather than as a side effect of a bucket study.

Two things to say honestly before anyone builds it. Annual equity ρ(1) measured on real data is
small and unstable in sign — which is why `WHITE_NOISE` is the default and why the bucket
literature's central claim is contested — so the likely outcome is a small effect with a wide
band around it. And the process would have to be calibrated and declared per scenario, because
the whole value of the policy is then a function of exactly that number: **the deliverable would
be the assumption becoming visible, not a feature.**

Until then, the honest summary for a household asking this question is that the offset is a
**leverage** decision priced against the loan rate, not a sequence-risk hedge — and that it
should be evaluated on the left tail, where D loses 9 worlds and rescues none.

### 20.11 The control surface, checked against a study that actually used it

§17's editor holds up: pools, claims and flows are all authorable, and arms A, B and D of §20.7
were reproducible in the app as authored. Three gaps showed up only because a study tried to
build a specific arm and then read what it did.

**Fixed here.**

1. **`cadence` was not authorable.** The C arm is `cadence: ANNUAL` (§12.6) and the flows table
   had no column for it, so the arm the study ran could not be written in the app. It happens
   not to change this scenario's numbers — the periods are annual anyway — which is exactly why
   it would have gone on being missing. Added as a column, written back only when it is not the
   default so no saved graph differs from itself on the next save.
2. **Two labels had become false**, and false in the direction that misleads the one person who
   reaches for them:
   - the gate options read *"source returning over X"*, which is the clairvoyant reading §20.2
     removed. They now read *"source returned over X **last year**"* — the difference between
     the two is a year of foresight, and only the second is a rule anyone can follow;
   - *"Equity Mean-Reversion Speed"* is a **momentum** knob (§20.9): returns end up correlated
     at +e^(−k), so a lower k is more persistent. It is now labelled *"Equity Return Persistence
     (OU pull-back speed k)"*, with the measured numbers in the description and a note that no
     setting of it makes a down year predict an up year. The FX and yield-curve reversion
     speeds keep their names: those run on levels and do mean-revert.

**Left for the next session, and it is the one worth doing.** *Nothing in the workbench reads
`state.liquidityPools`.* The graph can be authored and cannot be observed. The cube already
carries balance, target, capacity, `utilised`, cover, inflow, outflow, `marketReturn`,
`priorYearReturn` and `gatedFlows` — and `PoolFlowReducer`'s own docstring says why the last of
those matters: *"the interesting event is nearly always a flow that did NOT fire, and nothing
else in the journal records a non-event."* A Liquidity Pools panel, sibling to
`spending-plugin.js` and `allocation-plugin.js`, showing those per year with the gate's reason
next to the flow that did not fire.

The argument for it is this section's own history: §20.2's foresight, §20.4b's identically-zero
headroom and §20.3's unwired knob were all visible in that cube from the first period of the
first run, and each took a study to find instead.

---

## 21. The Liquidity Pools panel — BUILT (30 Aug 2026)

§20.11's open item, closed. `src/finance/pools/pool-history.js` (the replay + the pivot) and
`plugins/finance/liquidity-pools-plugin.js` (the panel), a sibling of `spending-plugin.js` and
`allocation-plugin.js` with the same skeleton: toolbar, provenance strip **above** the chart,
clickable legend below. Tests: `tests/unit/pool-history.test.mjs` (10),
`tests/viz/liquidity-pools-plugin.test.mjs` (17), `evt-liquidity-pools.test.mjs` POOL-5e/5f.

### 21.1 The source is the JOURNAL, not the run's sampler

The workbench's one sampler slot is occupied (design 82's allocation sampler, wrapped by
design 89's `withBalances`) and it fires at **year boundaries**. That is the wrong cadence for
this cube. `PoolFlowReducer` runs on both `US_PERIOD_ADVANCE` and `AU_PERIOD_ADVANCE` — six
months apart — and rewrites `gatedFlows` on each, so a year-boundary sample would silently
drop half of every non-event the panel exists to show.

It does not need one. `diffStates` walks nested objects, so every `liquidityPools.<id>.<field>`
movement is *already* a journal diff carrying `before`/`after`, and the cube's first write
lands as a single whole-object diff that seeds every pool. `buildPoolHistory` replays those
diffs and gets the cube at every period, for free, with no change to the shared sampler.

Two properties of that replay are worth stating because they are easy to get wrong:

- **A field with no diff this period keeps its value, and that IS the reading.** The reducer
  writes every field every period, so an absent diff means the period recomputed the same
  number — a gate still shut for the same reason. The one case it cannot see is a period in
  which the *entire* cube was unchanged, which emits no diff and so no record.
- **A replay is not a reading.** `tiePoolHistory` compares the last replayed period against
  live `state.liquidityPools` field for field, and the strip leads with the result. A drifted
  reconstruction draws a believable picture of a run that did not happen, which is the same
  failure shape as every defect §20 found. Measured on the §20.7 arm C run: 0 mismatches.

### 21.2 The graph comes off the live reducer

Labels, spend order, the flow list and `flowsEnabled` are read from the `PoolFlowReducer`
instance in the pipeline, never from `cfg.parameters`. A graph in the config that never
reached a reducer is precisely the failure this panel exists to make visible
(`config-field-in-state-is-not-read`), and a panel that drew it from config would report that
failure as working.

### 21.3 Four views, and the non-event is a first-class citizen in all of them

| view | what it answers |
|---|---|
| **Years of cover** | is the reserve actually there — unit-free, so pools of very different sizes sit on one axis |
| **Balance vs target vs capacity** | solid / dashed / dotted per pool. §20.4b in one picture: an offset sitting exactly at a capacity defined as its own balance *looks correct* and can never be refilled |
| **Flows in and out** | inflow above the line, outflow below, and the gated flows marked **on the zero line** — a gated flow moved nothing, and drawing it at its `wanted` height would put a bar-shaped claim on the chart for money that never left |
| **Flow log** | one row per evaluation: fired (marked *in-portfolio* when the rebalancer moved it), **gated** (with the gate's own reason string), or **veto** |

The log carries the rebalance veto beside the gated flow deliberately. A gate that stops the
explicit refill while the drift band keeps selling the same sleeve for the same reason has
changed nothing (§12.4's laundering), and only the two rows together say which happened.

The provenance strip separates the three states that all look like an empty flow log: **no
graph authored**, **`poolFlowsEnabled: false`** (§16.3's control arm, stated loudly because it
is indistinguishable from a working graph whose triggers never tripped), and **a graph whose
edges never fired or gated**.

### 21.4 `firedFlows` — the other half of the ledger (added on first use)

The panel's first run against a real plan reported `growth-to-buffer` as **gated 81, fired 0**.
It had in fact fired four times, moving \$25k / \$317k / \$337k / \$368k into the bond buffer.

`gatedFlows` made the non-event visible; nothing made the *event* visible on equal terms.
A firing was only countable through `POOL_FLOW_APPLY`, and **only executor 2 emits one**
(§12.4) — an in-portfolio edge is realized as a veto on a rebalance leg and emits nothing per
edge. So the visible half of the ledger was the cross-account edges alone, and an in-portfolio
edge that fired every year its gate was open read as one that never fired. That is the same
failure shape as §20.4b: a number that looks correct, on a policy that was working.

`PoolFlowReducer` now records `firedFlows: [{ id, from, to, amount, executor }]` on the cube
for **both** executors, on both endpoint pools, exactly parallel to `gatedFlows`. The panel
reads it in preference to the action stream and falls back to `POOL_FLOW_APPLY` only for a run
recorded before the field existed — where it says so rather than reporting a zero.

**It also closed a live defect.** `cadence: ANNUAL` is enforced by reading back
`prior[flow.to].lastFired[flow.id]`, and `lastFired` was stamped **only from the transfers**.
An ANNUAL *in-portfolio* edge was therefore free to fire again on the second advance of the
same year, re-deciding on an equity reading that only changes annually. Stamping it from every
firing fixes that; the §20.7 arms are unaffected (their `g2o` is cross-account, so it was
always stamped). On the plan that found it, the fix removed one duplicate firing and one gated
evaluation. Tests: POOL-5e, POOL-5f.

### 21.5 One more defect found while wiring it

`POOL_FLOW_APPLY` was never declared in any toolset's `types.actions` block, so
`TypeRegistry.pickPayload` fell to the heuristic — and **throws** in strict mode. Declared in
`economic-regimes-toolset.js` alongside the other behavioral apply types. It is the same shape
as `capital-gains-manifest-drift`: a payload nobody declared, working by fallback until
something reads it.

### 21.6 What it still does not do

The topology (§14's node/edge editor, and a sankey of realized volume) is not drawn. The
argument for deferring it is that neither shows a non-event, and the non-event is what the
three defects of §20 were.
