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
**§22 (PROPOSED)** adds the accessibility axis: a pool that claims an age-gated wrapper spends
it correctly and *measures* it wrongly, and early access at a penalty is currently decided by a
constructor rather than authored.
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

### 12.2b Remainder targets — an aggregate held across several pools

§12.2's three modes all size a pool from its own spec. That is enough until a pool's
**capacity** moves on a schedule nobody authored, and one does: an offset, whose `OFFSET_CAP`
is `min(balance, linked loan)` and falls as the loan amortises. Nothing refills it, because it
is the ceiling that dropped and not the balance — so a plan holding "five years of reserve"
across cash, bonds and an offset watches that five years decay, and no per-node target can see
it happen. §6.3 called the amortising cap a reporting problem; it is also a sizing one.

`YEARS_OF_SPEND_REMAINDER` is the fourth mode:

```js
{ mode: 'YEARS_OF_SPEND_REMAINDER', value: 5, after: ['cash', 'offset'] }
⇒ max(0, 5 × spend − Σ contribution(after))
```

**An UNCAPPED pool contributes its `target` when it has one and its balance when it does not;
a CAPPED pool always contributes its `utilised` cover.**

The first half is the claim/cover distinction. A target is the pool's *claim* about what it
will hold and the refill flows are what keep that claim true, so a cash pool sitting under its
target between refills must not move this one — reacting would start a rebalance to fix
something an edge is already fixing, and the two would fight.

The second half is why a pool with a real ceiling is different, and it took the reference plan
to show it. Such a pool cannot promise its target, because the ceiling is not something a flow
can lift — and an offset that should hold "as much as possible" is nonetheless authored WITH a
target, since a `toTarget` edge into a pool with none is rejected at config time. Its target is
therefore a number far above what it can hold, and counting it would peg the remainder at zero
forever.

Its *capacity* is no better, which is the part that is not obvious. On the reference plan the
offset reached a year with balance 0 and roughly a year of capacity: the loan was outstanding
so the room was real, but the `growth → offset` refill was gated shut with the growth pool a
third below its high. Crediting that room as cover under-provisioned the remainder pool by the
full amount **precisely in a down market** — inverted from what a reserve is for. An empty pool
is not cover, however much room it has. So a capped pool counts `utilised` = min(balance,
capacity), the figure §12.1 already defines as the cover this feature reports.

**Chains throw.** A remainder that names another remainder would let the resolution order
decide the answer, and a graph is a set, not an ordered list. Naming yourself throws for the
same reason in miniature. With chains excluded, resolution is one pass over the per-pool pass
and the order cannot matter — which is why it lives in `allPoolMetrics` rather than as another
case in `resolveSize`, where the other pools' figures do not yet exist.

**The clamp is at zero.** An aggregate that is over-covered is not a reason to sell down to the
remainder; a negative target would read as "empty this sleeve", which nobody authored.

**In the editor** the mode adds one cell to the Pools table: `Remainder of`, a checkset of the
other pools. It is drawn only for this mode, and it offers only pools that are not themselves
remainders and not the row itself — the two config errors above are therefore not typable,
which is §17's whole reason for replacing the JSON textarea. `after` had been falling through
`extraKeys` as opaque carried data (round-tripped, but unauthorable), so drawing it also means
excluding it from that carried set or the sync writes it twice. Renaming a pool prunes the
reference and re-renders, because only live ids are drawn: left alone, a stale reference would
be invisible on screen and still throw at Rebuild.

`shortfall` is recomputed in the same pass. It is what a `toTarget` refill moves, and it is
first computed while this target is still null — left stale, every refill into a remainder pool
would move zero.

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
| `drawdownBasis` | which series those two measure against — `BALANCE` (the peak balance, the default) or `INDEX` (the pool's compounded return, flow-neutral). **§20.14**, and it is the field that decides whether the household's own spending reads as a market signal. |
| `sourceReturnOver: x` / `targetReturnUnder: x` | the market pair, on the last COMPLETED year (§20.2). |
| `notInRegime: [TAG]` | reuse the existing regime tags (`ECONOMIC_STRESS`, `PANIC_SELL_TRIGGER`). |
| `notBefore` / `notAfter` / `ageOver` / `ageUnder` | the ordinary time gates. |
| `sustainedYears: n` | the DWELL — hold this node shut until its condition has held n consecutive years (**§20.15**). §20.13 measured duration as the lever the thresholds are not. |
| `anyOf` / `allOf` / `not` | composition; clauses on one node are an AND (**§20.15**). |
| absent | always. |

A trailing high is per-pool state (`state.liquidityPools[id].high`, monotone, updated once per
period). It has to be **state**, not a window recomputed from the journal, because it must
survive serialization and replay identically — and because a peak set before the run's start
date is not knowable from the run. The same is true of `returnIndex` / `returnIndexHigh`
(§20.14) and of the dwell's streak counters (§20.15).

> **Superseded on one point.** The prose below and in `poolMarketReturn` recommends the RETURN
> pair over the drawdown pair in a decumulation plan, because a trailing high cannot separate a
> falling market from a pool being spent down. That is a property of the SERIES, not of the
> gate: with `drawdownBasis: INDEX` the drawdown pair is flow-neutral, and §20.14 measures it as
> the best-performing gate in the study. Read the recommendation as "not the trailing BALANCE".

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

### 12.4b A gate belongs to its SOURCE POOL, not to its edge

The single most misleading thing about the authoring surface, found by a reader who set two
different thresholds on two edges out of one pool and could not work out why the looser one
never fired.

A gate is written on an edge and reads as a property of it. The **veto it produces names the
source pool** — `poolRefillPlan.vetoed` is a list of pool ids, and `_applyVeto` raises the
target of every ALLOCATION class that pool claims to at least what is currently held. That is
not an over-broad implementation of a per-edge rule. It is the rule. §12.4's opening paragraph
is the reason: the drift band will refill a bond target by selling equity, and the bond sleeve
then funds spending, so the plan sold equity in a downturn by a second route. If the veto
covered only the gated edge, gating `growth → offset` would leave the rebalancer free to sell
the same EQUITY to hit a BOND target and move the money out of `growth` anyway. The veto has to
cover **every route out of the pool** or the laundering hole reopens.

**Therefore the tightest gate on any edge out of a source pool is that source's effective gate,
and every looser one is unreachable.** Two different thresholds out of one source is not an
authorable policy, and writing one produces a plan that does not do what it says.

> **Narrowed by §12.4c (6 Sep 2026), on both halves.** *(a)* Only the **veto** is pool-wide;
> each edge's own firing is always governed by its own gate. "Unreachable" is exact for an
> in-portfolio REBALANCE edge, whose firing *is* a rebalance leg — and false for a
> cross-account TRANSFER edge, which still fires on its own looser gate (measured: \$7,919k
> against \$6,930k). *(b)* Two thresholds out of one source **is** now an authorable policy,
> via `gate.scope: EDGE`. Everything below describes `scope: SOURCE`, which remains the
> default and the stricter reading.

Two properties make this worth a warning rather than a docs line:

- **Nothing records the non-event.** `gatedFlows` attributes the veto to the edge whose gate
  shut. The edge it *also* suppressed is not mentioned, because from the reducer's side nothing
  happened to it.
- **The unvetoed classes go to ZERO, not to less.** `_applyVeto` floors each vetoed class at its
  held fraction; when the vetoed pool holds most of the book, `floorSum` reaches 1 and the
  function returns a mix of the vetoed classes alone. On the reference plan a source pool gated
  at 0.05 for one destination and 0.10 for another turned an authored multi-year bond reserve
  into a bond target of **zero**, for years, while the pool cube went on reporting the target it
  wanted — a believable wrong number of exactly the shape §12.7 exists to prevent.

`warnDivergentGatesFromOneSource` therefore warns at config time when two edges out of one
source carry gates that differ **in shape** — a gate is a composed tree (§20.15), so a
difference in clause kind, basis or dwell is as unreachable as one in threshold. Warned, not
thrown: the graph is legal and the behaviour is correct; it is the authoring that is not what it
looks like. The remedy is one gate for all edges out of a source, or separate source pools with
disjoint claims.

**What was tried and rejected.** Scoping the veto to `FLOW_EXECUTOR.REBALANCE` edges — on the
reading that §12.4's "a gated in-portfolio edge is a veto; a cross-account edge is a
transaction" scopes the veto rather than describing how each edge executes. It does not, and
POOL-6 already pinned the opposite on a cross-account edge: *"it VETOES the source's sale, so
the drift band cannot launder the same trade."* The change reopens the laundering hole for every
TRANSFER edge. Recorded because the reading is a natural one and the sentence invites it.

### 12.4c `gate.scope` — the veto is about the SOURCE or about the EDGE, and only the author knows which — BUILT (6 Sep 2026)

§12.4b is right that a gate's veto has to be pool-wide, and it states that as though it were
the only coherent reading. It is not. It is one of **two** author intents, and the vocabulary
had no way to say which was meant:

| intent | what it constrains | expressible before |
|---|---|---|
| *"do not **sell** this pool while it is down"* | the SOURCE's sleeves | yes — the only reading |
| *"do not **fill** that pool from this one while it is down"* | the DESTINATION's classes | no |

They are different trades, not two phrasings of one. `growth → buffer` is an allocation change
that stays inside the market book; `growth → offset` moves money *out* of it to retire debt.
"Keep rebalancing into bonds in a drawdown, but do not deleverage at the bottom" is a coherent
policy and the engine could not hold it.

`gate.scope` names the choice. `SOURCE` is the default and is byte-identical to everything
shipped before it; `EDGE` is the opt-in.

#### What EDGE actually does

`_applyVeto` floors every class the vetoed SOURCE claims at its held fraction — "you may not
reduce equity". The identical laundering trade can be blocked from the other end: **cap every
class the gated edge's DESTINATION claims at its held fraction** — "you may not grow bonds".
The drift band cannot make the trade either way; what differs is the collateral.

Measured on the reference plan (dated stagflation, −43% index drawdown), authoring
`growth→buffer` at 0.40 and `growth→offset` at 0.10 — the authoring §12.4b tells you not to
write:

| | terminal NW | buffer 2031 | 2033 | resolved mix 2031 |
|---|---|---|---|---|
| SOURCE, both 0.10 | \$6,930k | \$0k | \$0k | **C0 / B0** |
| SOURCE, buf 0.40 / off 0.10 | \$6,930k | \$0k | \$0k | C0 / B0 |
| EDGE, buf 0.40 / off 0.10 | \$6,400k | **\$583k** | **\$788k** | C7 / B24 |

The middle row is the defect: under SOURCE scoping that authoring is **byte-identical** to
both-at-0.10. The 0.40 is not "weaker than intended", it is unreachable. Under EDGE scoping the
buffer rebuilds while the offset edge stays shut, which is what was written down.

#### The second reason, which is the better one

Look at the mix column. SOURCE scoping resolves to **C0 / B0** — flooring the source's classes
drove CASH to zero as collateral damage, and no gate in that graph ever mentioned cash. That is
`pool-veto-floor-collapse`: once the reserve is spent, the vetoed pool holds ~100 % of the book,
`floorSum` reaches 1, and `_applyVeto` returns a mix of the vetoed classes alone — every other
target zeroed, for as long as the gate holds. Six consecutive years on this plan.

**EDGE scoping cannot produce it.** Capping is monotone downward on the named classes and
redistributes upward to the rest, so a class the author never gated can only ever gain weight.
Same arm, same crash: `C9 / B0` — BOND capped because its edge is gated, cash untouched because
it is not. The floor-collapse is a property of flooring, not of vetoing.

That makes EDGE the safer scope and SOURCE the stricter one, which is the opposite of how the
pair reads at first glance, and is the sentence to keep.

#### The limit, and why this is authored rather than the new default

**EDGE scoping only closes the routes the author drew.** An offset pool claims no ALLOCATION
class, so gating `growth → offset` under EDGE constrains the rebalancer not at all — equity may
still be sold into bonds that period. If the intent genuinely is "do not sell equity at any
price while down 30 %", SOURCE is the correct scope and must stay available. A reader who takes
EDGE as strictly better will author a plan that sells in exactly the market they were trying to
avoid selling into.

This is **not** the proposal §12.4b records as tried and rejected. That one scoped the veto by
EXECUTOR — only `FLOW_EXECUTOR.REBALANCE` edges veto at all — which deletes the veto outright
for every TRANSFER edge and reopens POOL-6's hole. Here every gated edge still vetoes; only the
target of the veto moves. The hole EDGE leaves is the narrower one named in the paragraph above,
and it is visible in the graph rather than implicit in the executor assignment.

#### What §12.4b got wrong, corrected here

`warnDivergentGatesFromOneSource` says the tightest gate "governs all of them and the others
never take effect". Only the second half of that is conditional, and measuring it is what
found this section:

- each edge's own **firing** is always governed by its own gate;
- only the **veto** is pool-wide.

For an in-portfolio REBALANCE edge, firing *is* a rebalance leg, so the veto overrides its gate
entirely and "never takes effect" is exact. For a cross-account TRANSFER edge, firing is a
separate transaction, so a looser gate still fires: `buf 0.10 / off 0.40` measured \$7,919k
against both-at-0.10's \$6,930k. The warning's wording was true of the case it was written from
and false in general.

The warning is therefore now raised **only when the divergent gates are all `SOURCE`-scoped**,
because that is exactly when one silently governs another. Two `EDGE`-scoped gates out of one
source are independent by construction and warning about them would train the author to ignore
the message that still matters.

#### Surface

**One new field, and the reason is the panel.** The logic alone needs none — `poolRefillPlan.gated`
already carries each gated edge's `to`, and the prototype that produced the table above read
nothing else. But `poolRefillPlan.vetoed` is what the flow log and the provenance strip count,
and an EDGE-scoped gate never enters it, so shipping the logic alone would make the panel report
an EDGE-scoped policy as **a rebalancer running unconstrained** — a believable wrong number, on
the one screen an author would check to see whether the scope they just set is running.

So `poolRefillPlan.capped` is stamped beside `vetoed`, by the same reducer in the same pass, and
BOTH `_applyEdgeVeto` and the panel read it. Two derivations of one decision is how they come to
disagree; that is the same argument `vetoed` itself is a list rather than a predicate.

- `capped` is spread, not defaulted to `[]` — a graph with no EDGE-scoped gate gains no state
  key at all, so no whole-state fixture grows a line to say nothing;
- `_cappable` mirrors `_vetoable`: a destination narrowing no sleeve names no class, so an
  EDGE-scoped gate into an offset or a savings pool caps nothing and **logs nothing**. That is
  the scope's honest limit, and logging it would be §20.18's phantom-veto rows again;
- recorded only for an edge whose `want > 0`, so a shut edge that wanted nothing caps nothing —
  correct (no demand, no trade to launder), and it makes an EDGE veto demand-driven where a
  SOURCE veto is not.

On the panel the two share `POOL_EVENT_KIND.VETOED`, because they are one event seen from
opposite ends, and the direction carries the meaning: **`from` names the pool that may not be
SOLD, `to` names the pool that may not be GROWN.** The provenance strip counts them apart
("N rebalance vetoes (source) · N fill caps (edge)") and the CSV keeps `vetoed` and `capped` as
separate flags — merging them would make the scope unreadable off the fact table.

In the editor: a `Vetoes` select on the gate clause table, labelled by what the gate DOES
("selling the source pool" / "filling the destination pool") rather than by the enum name, since
the difficulty this control exists for is that the two are different POLICIES over one topology.
The scope lives on the gate ROOT but the table is one row per CLAUSE, so an edit propagates to
every row of its flow (`syncGateScopes`, the same repair idiom as `renumberBranches`) — otherwise
a two-clause gate silently saves whichever row happened to say EDGE.

- `POOL_GATE_SCOPE = { SOURCE, EDGE }`, `gate.scope` normalized and defaulted at the config
  boundary, on the gate ROOT only — a scope on a nested `anyOf`/`allOf` clause would read as
  though branches could scope differently, which the single `vetoed` decision cannot express;
- `poolRefillPlan.vetoed` keeps its meaning (SOURCE-scoped pools) and `gated` gains nothing;
- `_applyVeto` gains the cap branch, applied after the floor branch so a graph mixing both
  scopes composes;
- one `Scope` select on the gate clause table, on the root row of each flow's gate.

Tests: POOL-27a–h (`tests/unit/evt-liquidity-pools.test.mjs`), RES-10/11
(`tests/unit/pool-history.test.mjs`), plus the editor and panel suites under `tests/viz/`.

### 12.4a The third shape: cash outside the book BUYING into it

§12.4's two executors between them could not say the thing an offset makes natural. **Cash held
outside the rebalanceable book buying into the book** is neither: executor 1 cannot see the
offset (the rebalancer's account list is tax-advantaged and taxable-brokerage roles only), and
executor 2 had nowhere to put the money, because its credit is a DEPOSIT and a sleeve is not an
account. So `offset → growth` — the exact mirror of the `growth → offset` harvest edge the same
graph already expresses, and the one every "buy the dip with the offset" reading wants — failed
validation instead of running.

A TRANSFER destination may therefore also be a **purchase target**: a pool that is *one*
brokerage account narrowed to *one* sleeve. Each half of that is load-bearing.

- **One claim, one sleeve.** Across two accounts or two classes there is no unique split for the
  money, which is the same reason a pool `target` and a `fractionOfSource` in-portfolio edge each
  demand a single class. An unnarrowed claim would have to mean "buy the account's current mix",
  a second policy wearing the same edge.
- **A brokerage, never a wrapper.** A deposit into an IRA / 401(k) / Roth / super is a
  CONTRIBUTION, with eligibility rules and a cap. That is not this feature's to invent.
- **The source side is unchanged.** The money is still raised by the scoped `replenishSavings`
  draw, so the disposal, its withdrawal tax and its §988 leg all fire exactly as they do for
  spending. §12.4's rule is untouched: the *credit* is what differs, not the draw.
- **The credit opens a dated lot.** `transaction()`'s pro-rata credit adds value and basis to the
  lots an account already holds, which blends the new money's acquisition date into positions
  bought decades earlier — and three separate disposal paths read that date (US §1222 short/long,
  the AU 12-month discount, AU CPI indexation). A purchase booked that way silently ages itself,
  so the credit routes through `distributeHoldingsCredit` — the seam reinvested dividends and
  wrapper deposits already use — which opens a vintage lot whose cost basis is the cash spent.
  Buying a sleeve the account does not yet hold OPENS it, with the rateKey its allocation
  resolves to; a lot whose rateKey does not match its class is invisible to the series meant to
  move it and would sit flat for the rest of the run.

The gate vocabulary needs nothing new: the dip is the DESTINATION's market state, so
`targetReturnUnder` / `targetDrawdownOver` (with `drawdownBasis: INDEX`) already say it, and
`sustainedYears` still says how long. Note only that the source-side clauses are inert on a cash
pool (§20.18) — measure the pool that has the market.

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

**Status**: **REOPENED and RE-ANSWERED** (30 Aug 2026, same day). §20.9's answer was measured on
a scenario that was not minimal — a company-equity sale landed in the spend account the year
after the crash and funded eleven years of spending, so every arm ran with the portfolio
untouched across the whole post-crash recovery window. **§20.12** has the defect, the fix and
the re-measured tables; **§20.13** and **§20.14** are the finding that came out of re-running
it. §§20.1–20.11 are left as written, because the sequence of measurements is the record; where
a conclusion in them is superseded the later section says so.

**The one-line answer, revised.** The *gate* is real and the *choice of gate* is most of it. A
refill gated on the source pool's **flow-neutral drawdown** — the trailing high measured on the
pool's compounded return rather than its balance (§20.14) — is worth **+\$175k median on 245 of
300 paths** in the IID-with-a-crash world, against **+\$29k on 215** for the return gate §20.9
scored, with a tighter left tail and ten worlds rescued against one broken. What has NOT
changed: ρ(1) ≥ 0 in every world the engine can produce (§20.9), so none of this is the
"sell into the recovery" bet the requirement was written as; and the pure deferral (arm D)
remains leverage that breaks nine worlds and rescues none.

The engine work is built (§20.2, §20.3, §20.4b, §20.14, §20.15, all with tests), the scenario
and arms are in `scripts/lab/sequence-risk/`, and four probes are in source control as the
record of the measurements: `probe-pool-gate-foresight.mjs`, `probe-offset-payment-drain.mjs`,
`probe-return-autocorrelation.mjs`.

**The old one-line answer**, kept because §20.9's numbers are still what that scenario said:
*the policy is not a liquidity strategy in this engine; it is leverage plus a bet on a number
the engine cannot produce.* Deferring equity sales into the offset earned nothing under IID
returns (a coin flip: 164/300 paths, +\$4.9k median on \$13m) and LOST under momentum
(66/300 paths). §20.12 measures how much of that was the windfall.

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

### 20.9 The answer — MEASURED (30 Aug 2026), and SUPERSEDED by §20.12–§20.14

> Every number in this section is correct for the scenario as it stood, and that scenario was
> not minimal: §20.12 found a company-equity windfall landing the year after the crash, which
> switched the mechanism off for eleven of the run's thirty-five years. The process finding
> below (ρ(1)) is independent of it and stands. The arm tables do not — read §20.12's
> re-measured versions next to them.

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

### 20.12 The minimal scenario was not minimal — the study's own numbers, re-measured (30 Aug 2026)

**Found by reading the exported arm in the app**, which is the thing §20.11 built the export
for. The C arm's JSON carries a company-equity sale landing the year after the crash, and a
household with that much cash arriving does not draw on an offset — so the arm was not
exercising the policy at the one moment the policy exists for.

`scenario.mjs` zeroes `cfg.accounts` and `cfg.realProperties`. `buildDefaultConfig` also ships
three collections that are **not accounts** and that the loop therefore never reached:
`companyEquities`, `collectibles`, `bequests`. The bequest is inert by default. The gold is
dilution. The company equity is neither:

| | |
|---|---|
| grant at t0 | \$500,000, appreciating at 8 % |
| `INTL_RETIREMENT_DEFAULTS.companySaleYear` | **2033** — one year after the dated crash |
| value when it sells | ~\$793,000, ~\$680,000 after tax, into `usSavingsAccount` |
| what that buys | ~11 years of spending, 2033–2043 |

Measured on the deterministic arm set: **every arm sells zero equity from 2033 to 2043**, and
the offset sits full in A, B and C throughout. The post-crash recovery window — the only window
the policy is about — ran with the portfolio untouched in every arm, and the four arms
therefore differed over 7 of 35 years rather than 35.

**The scenario's own contract is what makes this a defect rather than a caveat.** §20.6 says
the confounds are removed *by construction*; the construction reached the collections it
authored and not the ones `buildDefaultConfig` did. The generalizable rule, and it is the same
shape as §20.4b and §20.2: *a scenario that claims minimality has to assert it, not perform
it.* `buildScenario` now empties all three and then **throws** if any of the four value-bearing
non-account collections is non-empty, so a future `buildDefaultConfig` addition trips in the
builder rather than in a study's numbers a month later. `plan.windfall` / `SEQRISK_KEEP_WINDFALL=1`
reproduces the pre-fix world, and does so to the dollar — which is how the table below is known
to isolate one variable.

**C − B, the gate's own effect, 300 paired paths, everything else identical:**

| world | §20.9 as published | windfall removed |
|---|---|---|
| IID, no crash | +\$4.9k, 164/300, p10 −\$54k, 0 resc / 1 brk | +\$19.7k, **194/300**, p10 −\$30k, 3 / 0 |
| IID, dated crash | +\$23.7k, 192/300, p10 −\$109k, 1 / 2 | +\$28.8k, **215/300**, p10 −\$53k, 3 / 3 |
| momentum, no crash | \$0, 66/300, −\$260k, 0 / 2 | −\$23.3k, 53/300, −\$171k, 0 / 4 |
| momentum, dated crash | −\$8.4k, 105/300, −\$227k, 0 / 6 | −\$18.2k, 84/300, −\$152k, 0 / 2 |

**B − A, the carry of routing spending through the facility — this one changes sign:**

| world | as published | windfall removed |
|---|---|---|
| IID, no crash | +\$116k, 256/300, 7 resc / 0 brk | +\$297k, 239/300, 11 / 0 |
| IID, dated crash | **−\$46k**, 125/300, 6 / 0 | **+\$164k**, 158/300, **21 / 0** |
| momentum, dated crash | −\$437k, 106/300 | −\$551k, 131/300, 7 / 0 |

**What survives.** §20.9's ρ(1) finding is untouched — it is a property of the return process,
measured by a probe that never loads this scenario, and no liquidity feature can create a
rebound to sell into. The gate is still small money in absolute terms (+0.2 % and +0.67 % of
median wealth). Momentum still beats the policy, harder than before. D is still leverage that
breaks 9–10 worlds and rescues nearly none.

**What does not.** Two things, and both were load-bearing conclusions.

1. *"A coin flip: 164/300."* At 194/300 and 215/300 it is not one, and the left tail **halves**
   in both IID worlds. The gate was being scored across a horizon on which it was switched off
   for eleven years; most of what that added was noise in the paired difference.
2. *"It should be evaluated on the left tail, where D loses 9 worlds and rescues none."* True of
   D, and now false of B and C: in the IID crash world the facility **rescues 21 worlds and
   breaks 0**. The old scenario could not show a liquidity rescue because the windfall was
   preventing the failures it would have rescued.

**A caveat that has to be recorded next to the new numbers.** Arm A's failure count went 24→66
(IID, no crash) and 69→149 (IID, crash) of 300. §20.6 chose 3.6 % of the book as "a plan that
survives centrally" — but that calibration was itself made with ~\$680k of windfall in the plan.
With 22–50 % of paths insolvent, `run.mjs`'s contract bites (terminal wealth after an
out-of-funds event compares two insolvencies, not two policies) and **rescued/broken is the
primary reading, not the median**. `run-mc.mjs --spend` exists so the calibration can be
re-taken; re-taking it is open work.

### 20.13 The gate the design argued against is the one that works (30 Aug 2026)

§12.3 and `poolMarketReturn`'s docstring both argue *against* `sourceDrawdownUnder` in a
decumulation plan — it cannot separate a falling market from a pool being spent down, and
latches shut after the first crash — and that argument is why arm C uses the return gate. It
was an argument, not a measurement. The first hand-authored arm to try the other gate beat C,
so it got arms rather than a footnote: **E, F, G** are C with `sourceDrawdownUnder` at 1 %, 5 %
and 10 %, one field changed and nothing else.

**IID with the dated crash — the world the policy is for:**

| pair | median | wins | p10 | rescued / broken |
|---|---|---|---|---|
| C−B return gate | +\$28.7k | 215/300 | −\$52.9k | 3 / 3 |
| E−B drawdown 1 % | +\$123.3k | 215/300 | −\$58.3k | 6 / 2 |
| F−B drawdown 5 % | +\$132.0k | 221/300 | −\$50.3k | 8 / 2 |
| G−B drawdown 10 % | **+\$136.3k** | **226/300** | **−\$45.4k** | 8 / 1 |
| D−B never refill | −\$55.9k | 121/300 | −\$204.9k | 2 / 10 |

G−A is +\$316.6k with **28 worlds rescued and 0 broken**. Under momentum the drawdown gates go
to a \$0 median where the return gate loses \$18k and D loses \$73k — they are not merely better,
they are less sensitive to the process assumption the whole of §20.1 turns on.

**Two readings of that, and the second is the one worth keeping.**

*The threshold is nearly inert.* 1 %, 5 % and 10 % land within \$13k of each other on a \$5m
plan. A control that does not change the answer is not the lever, whatever its name suggests.

*The DURATION is a lever* — and §20.16 measures it directly, isolates it, and finds it
inert-to-harmful past the point the shipped rules already reach, so read this paragraph with
that one. What separates C from E/F/G is not precision, it is **how long the gate stays shut**: the return gate re-opens after any up year and keeps the offset full, the
drawdown gate stays shut for years. And D — shut forever — is worse than all of them. So the
policy has an **interior optimum in deferral length**, and neither of the two gates the design
shipped can express one directly; each produces a duration as a side effect of a threshold.
That is what §20.15's grammar is for, and this measurement is the reason it exists.

**The honest caveat, which §20.14 then measures rather than argues.** Part of why the drawdown
gate defers so long is the confound §12.3 named: spending contaminates the trailing high, the
gate latches, and a longer deferral is a longer levered position. On the deterministic path
arm E drains the facility to zero by 2037 and never refills, which is arm D with a slow fuse —
and D prices like leverage. So E/F/G's advantage cannot be attributed to the gate until the
contamination is removed and the arms re-run, which is exactly what the next section does.

### 20.14 The drawdown gate's confound is fixable, and fixing it wins — BUILT and MEASURED (30 Aug 2026)

§12.3 treats "a trailing-high gate cannot tell a falling market from a pool being spent down"
as a property of the gate, and answers it by recommending a different gate. It is a property of
the **series**, not of the gate, and the series is replaceable.

`gate.drawdownBasis` (`liquidity-graph.js`, `POOL_DRAWDOWN_BASIS`) chooses what
`sourceDrawdownUnder` / `targetDrawdownOver` measure against:

| basis | the series | what "20 % down" means |
|---|---|---|
| `BALANCE` (default) | the peak BALANCE | the pool is a fifth smaller than it has ever been — spending included |
| `INDEX` | the pool's compounded RETURN, from 1.0 | the market this pool is invested in is a fifth off its peak |

`INDEX` is the ordinary time-weighted definition of a drawdown, and it is flow-neutral by
construction: a withdrawal, a refill and a rebalance all leave it alone. It is preferred to a
flow-adjusted balance ("high less debits, low less credits") for two reasons — a flow-adjusted
balance is path-dependent, so two pools with identical returns and different flow timing
disagree; and one index serves BOTH directions, where a flow-adjusted balance needs a separate
rule for the high and the low.

**The index inherits §20.2 by construction, which is the part to get right.** It compounds one
factor per **completed** calendar year, taken from the same cube stamp `_priorYearReturns`
reads. An index built off the live rate table would compound the year it is deciding in and
hand every drawdown gate the foresight §20.2 removed from the return gates — the same defect,
one derivative up, and just as silent. POOL-12f is the regression; POOL-12e is the pair that
shows BALANCE and INDEX disagreeing on one state, from both sides.

**Measured.** Arms **H, I, J** are E, F, G with the one field changed. 300 paired paths.

*IID, dated crash:*

| pair | median | wins | p10 | rescued / broken | median interest |
|---|---|---|---|---|---|
| C−B return gate | +\$28.8k | 215/300 | −\$52.9k | 3 / 3 | \$137k |
| G−B balance 10 % | +\$136.3k | 226/300 | −\$45.4k | 8 / 1 | \$385k |
| **J−B index 10 %** | **+\$174.8k** | **245/300** | **−\$33.7k** | **10 / 1** | **\$229k** |

*IID, no crash:* H−B +\$49.1k on 202/300 with p10 −\$67.9k and 3 worlds broken, against E−B's
+\$52.7k on 191/300 with p10 −\$102.1k and 5 broken.

**Two findings, and the first is the one that was at risk.**

1. **The contamination was worth almost nothing on the median.** H−E is −\$988 (no crash) and
   \$0 (crash). §20.13's fear was that E/F/G were measuring the latch-as-leverage rather than
   the gate — a longer deferral is a longer levered position — and that is now measured and
   rejected. E/F/G's advantage over C was the gate.
2. **What the flow-neutral basis buys is the TAIL.** Every p10 improves, every broken count
   falls or holds, the win rate rises to 82 % in the crash world, and the interest bill falls
   by a third to a half — because the facility is no longer held drawn for years by a gate
   reading the household's own spending as a market signal. A rule that earns the same median
   with a tighter tail and a smaller loan bill is strictly better, and that is the shape of
   the improvement rather than a bigger number.

`BALANCE` stays the default. The two genuinely answer different questions, and for a pool with
a spending floor "is this pool smaller than it has ever been" is the one you want. But for the
market gate on a growth pool in a plan being spent down, `INDEX` is what the author means every
time, and the app's control now says so in the option label rather than in a design document.

### 20.15 The gate becomes a composed condition with a dwell — BUILT (30 Aug 2026)

§20.13's measurement is the argument for this section: across 1 %, 5 % and 10 % the threshold
moved the answer by \$13k, while the same gate family differing only in **how long it stays
shut** moved it by \$460k. (§20.16 then used this grammar to isolate duration on its own and
found it inert-to-harmful beyond J's own rule — which is the grammar earning its keep by
falsifying the reading that motivated it, not an argument against having built it.) The design shipped two gates that each produce a duration as a *side
effect* of a threshold, and no way to state a duration directly. So the gate grows the two
things that were missing — composition, and dwell.

**The grammar.** A gate is a tree of nodes; a node carries clauses, children and a dwell:

```
{ sourceDrawdownUnder: 0.05, drawdownBasis: 'INDEX', sustainedYears: 2 }
{ anyOf: [ … ] }        OR
{ allOf: [ … ] }   [ … ]  AND (an array is sugar for allOf)
{ not: { … } }          negation
```

A node is open when its own clauses all pass, every `allOf` child is open, at least one `anyOf`
child is open, and any `not` child is shut. **Clauses on one node are an AND** — which is what a
flat gate has always meant, so every gate authored before this section normalizes to exactly
what it did, and no golden moves. The shape deliberately mirrors `visibleWhen`'s DSL: two
composable predicate languages in one codebase that disagreed about whether an array is an AND
would be a coin flip at every call site.

The rule this was asked for reads:

```
gate: { anyOf: [
  { sourceDrawdownUnder: 0.05, drawdownBasis: 'INDEX', sustainedYears: 1 },
  { sourceDrawdownUnder: 0.01, drawdownBasis: 'INDEX', sustainedYears: 2 },
] }
```

**The dwell is stateful, and its unit is the YEAR.** `sustainedYears: n` holds a node shut until
its condition has held on n consecutive years, this one included. Not periods: this reducer
fires on both `US_PERIOD_ADVANCE` and `AU_PERIOD_ADVANCE`, so a dwell counted in evaluations
would mean one year in a US-only plan and half a year in a cross-border one **from the same
authored number** — and it is the same trap POOL-12d exists for, one layer up. It is also the
grain at which anything changes: the equity tick is annual, so every gate reading is constant
within a year.

Three properties the implementation has to have, each with a test:

- **the streak advances at most once per year** and on EVERY evaluation, not only the ones
  whose flow then moves money — a dwell that counted the periods somebody asked about would be
  measuring the household's demand rather than the market's behaviour (POOL-13d);
- **`anyOf` never short-circuits.** Each branch carries its own streak, so a branch skipped
  because an earlier one opened would have counted something other than the years its own
  condition held (POOL-13e);
- **a branch that decides nothing is a config error.** An empty `anyOf` branch is always open,
  and one always-open branch makes the whole gate always open — silently, on a run that still
  looks plausible. It throws (POOL-13g).

**Where the state lives.** `state.liquidityPools[to].gateStreaks[flowId][path]`, on the
DESTINATION pool's cube entry: a flow has exactly one `to`, so the counters need no new state
key and travel with the rest of the pool state through serialization and replay (POOL-13f).
`path` is the node's position in the tree (`gate.anyOf[1]`), recomputed at evaluation time
rather than stamped on the graph, so a saved graph carries no editor bookkeeping. A streak for
a flow that was NOT evaluated this period is carried forward, because `cadence: ANNUAL` skips
an edge that already fired and dropping the streak would restart a multi-year dwell every time
the edge fired.

**The control surface** (§17.1's rule, applied unchanged). A flow holds a LIST of clauses, and a
list of lists becomes a flat table keyed by the id above it — so the gate leaves the flows row
and becomes a **fourth table**, keyed by flow id and an OR number. Rows sharing an OR number
are ANDed; each OR number is an alternative. The author's rule above is two rows. Each row also
carries the basis (§20.14) and the dwell, because both are per-clause.

A gate outside disjunctive normal form (an OR inside an AND) cannot be drawn as
rows, and the editor does not try: it round-trips the authored gate verbatim the way it already
round-trips `ui`, and shows no clause rows for it. Flattening half a composed gate would leave
a graph that still loads and still runs — the failure mode this design has now named five times.

### 20.16 The dwell sweep — the lever measured directly, and it is a NEGATIVE result (30 Aug 2026)

§20.15 built `sustainedYears` on §20.13's reading that *duration*, not threshold, is what moves
the answer. §20.13 inferred that from arms that differ in several things at once (C's signal is
a return, J's is an index level, D has no refill at all). This is the first arm set that moves
duration and **nothing else**: arms **K, L, M, N** are arm J's gate at `sustainedYears` 2, 3, 4
and 5, paired against J, which is the same gate at n = 1.

**IID, dated crash — K−J … N−J, the dwell alone:**

| dwell | median | wins | p10 | broken | median interest |
|---|---|---|---|---|---|
| n = 2 | \$0 | 138/300 | −\$138.9k | 1 | \$301k |
| n = 3 | \$0 | 138/300 | −\$173.1k | 3 | \$359k |
| n = 4 | \$0 | 135/300 | −\$246.8k | 5 | \$432k |
| n = 5 | −\$3.8k | 133/300 | −\$263.3k | 5 | \$468k |

Four coin flips, a left tail that roughly doubles, and an interest bill that doubles (J itself
pays \$229k). IID no-crash is the same shape with the medians pointing the other way: +\$6.0k,
+\$14.5k, +\$14.2k for n = 3, 4, 5 — bought with p10 falling \$3,400,198 → \$3,347,621 and broken
worlds going 2 → 5.

**The finding: the dwell is a LEVERAGE control, not a protection control.** A better median with
a fatter left tail and more ruin is §20.9's own description of arm D, and lengthening the dwell
walks J toward D — which is exactly what the arm comment predicted it would do if duration were
the lever, and the prediction being right does not make the lever a good one.

**What this does and does not do to §20.13.** It does NOT show duration is irrelevant: C (a
short deferral) and D (an unbounded one) are both worse than J, so an interior optimum is still
the best reading of the family. It shows **J is already at or past that optimum**, and the sweep
only probes the LONGER side — `sustainedYears` can lengthen a deferral and cannot shorten one.
§20.13's sentence "the DURATION is the lever" should be read as "the duration is *a* lever, and
the shipped rules are already near its useful end", which is a weaker and better-supported
claim.

**What would test the other side**, and it is a different control rather than another sweep: a
**cooldown** (do not re-evaluate for n years after a refill) shortens the effective deferral
from the other end, and a **forced refill after n consecutive shut years** bounds it. Neither is
built. Both are one clause in §20.15's grammar if they are ever wanted.

**The methodological point, which is the durable part.** §20.13 read a lever off arms that
differed in more than one thing, and §20.15 was built on that reading. The lever turned out to
be inert-to-harmful when isolated. The grammar is still the right thing to have — it is what
made this measurement *sayable*, and a control that can state a hypothesis directly is how the
hypothesis gets falsified — but the ordering is the lesson: **§19.6's "one variable per arm"
applies to reading a lever out of a table just as much as to running one.**

---

### 20.17 What the clause table could not say, and three things it silently dropped — BUILT (31 Aug 2026)

Authoring the §20 pool system through the app rather than through a script found five defects
in the clause table, four of them the same shape: a field on screen that does not mean what it
looks like it means.

**`not` is a row, not an escape hatch.** The four clause kinds all state a condition in one
direction, and the direction they cannot state is the one a decumulation plan is actually
about: *fire only while the source is NOT within x of its high* — a down-market rule. The
engine has had `not` since §20.15; the table did not offer it, so the rule fell out of DNF and
into `rawGate`, where it could be run but not edited. The row now carries a **sense** —
`when` / `when NOT` — and the negation wraps the CLAUSE, so the dwell rides on the negation:
"has NOT been within 5 % of its high for two years". A saved gate that puts the dwell the other
side of the `not` (`{ not: { X, sustainedYears: 2 } }`, i.e. "X has not held for two years")
says a different thing and is left to `rawGate` rather than re-read as this one.

**The OR # is a position, not a label.** `rowsToGate` emits one `anyOf` branch per distinct
number in ascending order, so a 3 typed beside a 1 saves as branch 2, and a lone branch
collapses to a bare node with no number at all. That is correct, and it was invisible: the
author discovered the renumbering on the next load. The table now renumbers on the spot, so
what is on screen is what will reload.

**A flow whose gate the table cannot draw is no longer selectable in it.** `buildFlow` lets an
undrawable `rawGate` win over the clause rows, so a row typed against such a flow was on
screen, saved nowhere, and left the flow running a gate the author could not see.

**An AMOUNT or YEARS_OF_SPEND capacity had no size cell**, so selecting either wrote
`{ mode: 'AMOUNT' }` with no value — a mode offered on screen that `sizeSpec` rejects at
Rebuild. It has a size cell now.

**`floor`, a target's `spendBasis`/`trailingYears`, a trigger's `spendBasis` and `amount.max` /
`amount.min` are carried, not drawn.** No column showed them, and nothing preserved them
either: any keystroke anywhere in the three tables rewrote the graph without them. They now
round-trip verbatim the way `ui` and `rawGate` do. Drawing them is a column each, later; the
point of this fix is that a policy the author wrote is not deleted by an edit somewhere else.

**Asked and not built: a dwell counted in PERIODS.** The flows table offers a cadence, so the
dwell looks like it should too. It should not, and the reducer is the argument: `sustainedYears`
is the only unit whose meaning does not depend on how many countries the plan files in, and
every series the gate reads is annual — `_returnIndices` compounds nothing on a second advance
within one year, and `_priorYearReturns` carries the same reading forward, *deliberately*, so
the two advances of a cross-border year agree. A PERIODS dwell would therefore be a duplicate
reading of an unchanged signal in a US-only plan, and exactly half the authored duration in a
cross-border one — POOL-12d's trap with a nicer label. The one basis where a sub-year reading
changes at all is the peak BALANCE, which changes because the household SPENT the pool, which
is the confound §20.14 exists to remove.

### 20.18 A market clause on a pool that has no market — BUILT (31 Aug 2026)

Authoring the §20 system by hand found the failure this section is named for, and it is the
most expensive shape in the feature: **a gate that validates, loads, runs, reports itself as
working, and decides nothing.**

The rule the author wanted was "refill cash from the offset when equities are down". The
offset is `o2c`'s SOURCE, so it was written as `not { sourceDrawdownUnder: 0.1, INDEX }` — and
the offset holds no lots. `poolMarketReturn` returns null, the return index never compounds
off 1.0, its high stays 1.0, its drawdown is 0.0 in every period of the run, the clause is
permanently satisfied, and the `not` makes the edge permanently SHUT. Measured on the plan:
**`o2c` fired 0 times in 35 years.** Deleting the gate entirely — priority alone already says
the rule, because `g2c` is tried first and is shut when growth is down — fired it in 28 of
them, moving \$26–75k a year into cash through the crash.

Nothing was broken. Each clause has a documented default for an absent reading ("no signal is
not bad signal", POOL-12b), and each behaved exactly as documented. What was missing is that
the default is a CONSTANT, and a constant clause is indistinguishable, in the panel and in the
journal, from a gate that is doing its job — the shut edge dutifully logged a gated event in
every period.

So `normalizeLiquidityGraph` now **warns** when a clause reads a market signal on a pool whose
claims are all cash-like, naming the flow, the clause's path in the gate tree, the pool, and —
counting the `not`s above it — whether the clause is always TRUE or always FALSE. A warning
and not an error, for §12.2's reason: the same clause on the default `BALANCE` basis measures
a series a cash pool really has, so it is a legitimate authoring, just almost never the
intended one.

**And the veto stops crying wolf.** A closed gate vetoes its source's rebalance sale (§12.4),
but `_applyVeto` works by pinning the target of the vetoed pool's ALLOCATION classes — so a
pool that narrows no sleeves names no class and cannot be vetoed at all. The reducer logged
one anyway, which put a "rebalance veto" row in the panel for a decision that was never taken,
in **900 of 1,093 periods** of the run above. It is now recorded only for a source the
rebalancer could actually sell; on that plan the survivors are `growth`, in 2033–2039, which
are the real ones. This mattered more than a tidy log: the phantom vetoes are what sent the
author looking at the veto for a swing the veto had nothing to do with.

**What the swing actually was**, for the record, because none of it was the veto: the gate is
measured against a MONOTONE all-time index high, so after a 48 % crash nothing refilled until
the index recovered past 90 % of the OLD peak — six years, over which the offset drained
\$400k → \$0 — and then `g2o` refilled the whole \$400k in one January. After that the
annual saw-tooth is `cadence: ANNUAL` doing what it says: cash is filled to its \$100k target
once a year, annual spend is ~\$120k, so cash empties around October and the last two months
come out of the offset (spend order 1) until the next January refill.


**What is NOT built.** No optimizer/MPC surface over dwell (§14's territory), and no arm set
sweeping it: §20.13 says duration is the lever, and the obvious next measurement is
`sustainedYears` swept 1…5 on the J arm, which is the first study this grammar makes sayable.


### 20.19 Refilling an in-portfolio pool — three reasons it is inert, and the setting nobody could find (31 Aug 2026)

An author adding a fourth pool — a quarterly Treasury ladder between cash and the offset —
could not make it refill, and the reasons are worth writing down because none of them
announces itself. A `growth → bonds` edge classifies as `executor: REBALANCE`, validates,
saves, and then does nothing at all unless **three** separate settings line up.

1. **`fixed-income` is not in `TAXABLE_ROLES`.** The rebalancer's account list is
   tax-advantaged ∪ taxable, and that set is `{us-stock, au-stock}`. An account in the
   `fixed-income` role is therefore outside the rebalanceable book entirely: the rebalancer
   can neither buy nor sell in it, so a refill edge pointed at it can never execute no matter
   what else is configured. `DEFAULT_LOCATION_POLICY` agrees by omission — its BOND
   preference list is `[IRA, K401, SUPER, US_STOCK, AU_STOCK]`, and `fixed-income` is not on
   it, so even under LOCATED the class would be routed somewhere else. The fix for the plan
   was to put the ladder in the taxable brokerage's BOND sleeve — **two pools over two sleeves
   of one account**, which is the shape §3.1 and §12.4 are built for. Whether the role
   *should* be rebalanceable is a real question and not a silent change: every scenario with a
   funded fixed-income account would move.
2. **`allocationLocation: PER_ACCOUNT` drives every account to the uniform mix.** A book whose
   pools are sleeves wants LOCATED, which assigns each account a composition summing to its
   own total.
3. **The drift band is in PERCENTAGE POINTS**, and the shipped taxable default is 0.10. A
   one-year ladder is ~3.6 % of a \$2m book, so the drift between "full ladder" and "ladder
   completely spent" is 3.6 points — it can never exceed a 10-point band, and the refill can
   never fire. This is the same class of defect as §20.18: a control that is on screen, is
   valid, and cannot reach the thing it governs.

**The setting the author was looking for already exists: it is the pool's own `target`.**
The question was "can TARGET_ALLOCATION re-up only my bonds and leave the other classes
alone?", and `_resolvePoolTarget` is the answer — a class claimed by a pool carrying a target
is sized by the GRAPH, and *classes no pool targets keep their scheduled weights,
renormalised into whatever room is left*. Giving only the bond pool a target pins BOND at one
year of spend and leaves everything else on its authored mix. The honest limit: a target mix
is total by construction, so pinning one class does determine what the rest sums to; the
residual is split among the unclaimed classes by their authored RELATIVE weights, not frozen
at what is currently held.

**And the gate is why the edge exists at all.** With the target alone, the drift band would
rebuild the ladder by selling equity in the crash — §12.4's laundering, arriving from the
third direction. The gated edge closes, the source pool is vetoed, and the rebalancer may not
sell EQUITY that period either. Measured on the plan: the ladder is held at four rungs
through 2026–2032, spent down over 2033–2034 while the gate is shut and `growth` is vetoed
every period, the offset carries 2035–2039, and the whole structure — cash, ladder, offset —
is rebuilt in the single January the drawdown falls back under the threshold.

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

### 20.20 `fixed-income` stays out of `TAXABLE_ROLES`, and the two guards that say why — BUILT (31 Aug 2026)

§20.19 left one question open: `fixed-income` is not a rebalanceable role, and that looks like
an oversight. It is not, and the reason is a three-way coupling that only holds while the
account holds fixed income.

**The role is the key to the earnings handler as well as to the rebalancer.**
`FixedIncomeInterestHandler` (US) / `AuFixedIncomeInterestMonthlyHandler` (AU) is the account's
ONLY earnings stream — `IntlUsStockEarningsHandler`, `DividendScheduledHandler` and
`BondCouponScheduledHandler` are all scoped to `US_STOCK`, and the sleeve handlers to
us-stock/401k/IRA/Roth. It prices every holding out of `state.effectiveInterestRates`, which
carries `SAVINGS_*`, `FIXED_INCOME_*` and `PRIME_*` — **no `EQUITY_US`, no `GOLD`** (checked on
a live run). And `computeHoldingsGrowth`'s BOND/CASH skip is `!useCoupon && …`, so on the
interest path nothing is skipped: a holding whose rate key is absent is processed and falls
through to the account's fallback, the fixed-income rate.

So an equity lot in such an account would (1) grow at ~4 % instead of ~7 % and (2) have that
growth emitted as `FIXED_INCOME_EARNINGS_APPLY`, which chains `FIXED_INCOME_EARNINGS_TAX` —
ordinary income taxed annually, where equity appreciation is unrealised until disposal. Two
wrong numbers, both believable.

**Measured, not argued.** Adding the role to `TAXABLE_ROLES` and running the plan: the account
went from **\$73,843 of BOND to \$91,041 of EQUITY** by 2031. `DEFAULT_LOCATION_POLICY` names
`fixed-income` for no class at all, and preference is soft-with-spill, so a role nobody prefers
becomes the spill destination for whatever is left over — BOND goes to its preferred wrappers
and EQUITY lands in the bond account. The ladder is destroyed and the bond pool holds equity
earning the interest rate.

A correct change is therefore three changes, not one: the role into `TAXABLE_ROLES`, the role
into `DEFAULT_LOCATION_POLICY[BOND]` ahead of the wrappers, and the earnings coupling broken
(scope the interest handler to BOND/CASH and wire the equity/dividend/gold streams onto the
role — i.e. make `fixed-income` a full brokerage). **Not made.** The need it was raised for is
already met by the shape §20.19 recommends: two pools over two sleeves of one taxable
brokerage, where design 59's `INTL_BOND_COUPON` stream serves the bonds properly.

**Two guards instead**, both of which would have ended the search in seconds:

- `normalizeLiquidityGraph` **warns** when a REBALANCE edge's source or destination pool
  claims an account in a role the rebalancer does not trade. A REBALANCE edge emits no action
  of its own (§12.4), so an edge that never moves anything leaves no failed firing to look at
  — it is invisible by construction. Skipped when the caller supplied no roles: an absent role
  is not evidence of an untradeable one.
- `assertInterestBearingHoldings` **throws** at config time, from the two toolsets that wire
  the interest handler, when such an account holds anything but BOND or CASH. The list is
  derived from `RATE_KEY_BY_COUNTRY_ALLOCATION` and stated beside it, so it cannot drift from
  the series it describes. Config time and not runtime because no engine path can reach the
  state today — `TAXABLE_ROLES` excludes both roles, so the rebalancer cannot place anything
  there — and the author who hand-edits or imports an account is exactly who this catches.

Tests: POOL-16/16b/16c (the warning, its control, and the no-roles case), POOL-17 (the throw,
both directions).

### 20.21 A dated holding crashed the Monte Carlo and not the run — FIXED (31 Aug 2026)

Importing §20.19's ladder scenario ran deterministically and then failed on the first Monte
Carlo iteration with `this.purchaseDate.toISOString is not a function`.

JSON has no Date. A holding that has been through a file — an import, a downloaded scenario, a
template — carries ISO **strings**, and `ScenarioSerializer._serializeAccount` revives such a
record with `new Holding(h)`, not `Holding.fromJSON`. `fromJSON` parses its dates; the
constructor stored them raw. So `toJSON` called `.toISOString()` on a string.

The split is what made it look like a Monte Carlo bug: the deterministic run loads through
`ScenarioLoader` → `fromJSON` and is fine, while `IntlRetirementMcRunner` puts the active
scenario record through `serializeScenario` to get a JSON-safe per-iteration template, and
dies there. Nothing about the MC was wrong.

It had been half-found before: `toJSON`'s `maturityDate` line already carried an
`instanceof Date ? … : …` guard while `purchaseDate` two lines up did not — a patch at the
crash site rather than at the cause. The fix is in the CONSTRUCTOR, which is the one place
both `fromJSON` and `new Holding(plain)` pass through, so every reader gets a Date and not
just the one that crashed. An unparseable value throws rather than nulling: a dropped
acquisition date silently changes cost-base indexation and the long/short CGT split, which is
a wrong number rather than a missing one.

Why it had never fired: every holding in the affected plan carried `purchaseDate: null`. The
first dated holdings in it were §20.19's ladder rungs. Tests in `holding.test.mjs`.

## 21. The Liquidity Pools panel — BUILT (30 Aug 2026)

§20.11's open item, closed. `src/finance/pools/pool-history.js` (the replay + the pivot) and
`plugins/finance/liquidity-pools-plugin.js` (the panel), a sibling of `spending-plugin.js` and
`allocation-plugin.js` with the same skeleton: toolbar, provenance strip **above** the chart,
clickable legend below. Tests: `tests/unit/pool-history.test.mjs` (10),
`tests/viz/liquidity-pools-plugin.test.mjs` (17), `evt-liquidity-pools.test.mjs` POOL-5e/5f.


---

## 22. The age-gated wrappers in a pool — the accessibility axis (5 Sep 2026)

**Status**: PROPOSED, except §22.8–§22.9 which are **BUILT**. §22.2 is CONFIG-ONLY and
works today; §§22.3–22.5 are the remaining code; §22.10 is a filed follow-up.

§18.6 rule 4 established that a wrapper the graph does not claim is not "spent last", it is
usually **never spent**, and gave the placement a name (`POOL_KIND.WRAPPERS`) in the study
generator. This section asks the question that rule leaves open: what happens when a pool
claims one — and the answer is that the **spend** side is already correct and the
**measurement** side is silently wrong, in the same direction and for the same reason §9.3(a)
measured as a cover figure of *0.0 years, in every year*.

The requirement, stated in the author's terms: a pool must be able to hold retirement equity
and know the difference between **equity available now** and **equity available once the age
gate opens**, with early access **at a penalty** as a separately authored option.

### 22.1 What is already true, and is easy to mistake for a gap

Three things work today and need no code. They are recorded first because each of them looks
like a missing feature until you follow the draw.

**(a) A pool may claim a wrapper.** `normalizeClaims` validates a claim against the account
list and nothing else — the IRA / 401(k) / Roth / super types are as claimable as a brokerage.

**(b) The age gate is already enforced on the spend side.** The compiled `drawdownSequence`
governs the *order* of the penalty-free Phase 1 walk only. `_penaltyFreeAvailable`
(`account-service.js`) returns **0** for an under-age wrapper — except a Roth, which returns
its `contributionBasis` — so a claimed wrapper sitting anywhere in the order is simply skipped
until its gate opens, and the walk moves to the next entry. Placing the pool FIRST therefore
means *"spend it as soon as it is accessible"*, never *"withdraw it early"*. This is §3.1
rule 5 restated, and it is the half of the requirement that is already built.

**(c) The remainder rule keeps an unclaimed wrapper reachable.** `_applyDrawdownSequence`
appends everything the sequence did not claim in ordinary `drawdownPriority` order, so
declining to claim the wrappers does not strand them — it places them, badly and invisibly,
which is §18.6 rule 4's point.

### 22.2 The config-only shape: a wrappers pool of its own, NOT wrappers inside `growth`

The intuitive authoring — add the wrapper accounts to the existing `growth` pool, because
that is where the equity is — **does not load**. `assignExecutors` stamps `REBALANCE` only
when `isPortfolioPool` holds at *both* ends, and that predicate is `type === BROKERAGE` for
every claim. Adding one wrapper to `growth` reclassifies every edge out of it to `TRANSFER`,
and a `TRANSFER` needs a destination that is either cash-like or a single brokerage account
narrowed to a single sleeve. A bond-reserve pool spanning several brokerages is neither, so
the harvest edge fails validation:

> flow 'growth-to-buffer' has to move CASH into 'buffer', and that pool is neither of the two
> things a transfer can land in […]

That is the *good* failure. The bad one is the sibling edge that does **not** throw: an edge
from `growth` into a pool holding an offset or savings account stays legal after the
reclassification, and once the age gate opens it starts selling wrapper equity and routing it
into cash — an ordinary-income distribution taken to top up a facility, authored by nobody,
produced by adding an account to a pool.

**So the wrappers get a node of their own, with a `spendOrder` and nothing else** — no
`target`, no `capacity`, no flows in or out. Claimed WHOLE (see §22.6). This changes the draw
order and nothing else, which is what makes it a clean axis, and it is exactly what
`POOL_KIND.WRAPPERS` builds in `scripts/lib/pool-graph.mjs`.

Placement is the real decision, and §18.6's corollary decides it: a pool placed **after** a
pool that never runs dry is not a low-priority pool, it is an unclaimed one. `growth` is the
residual pool on most plans, so `spendOrder` *after* growth reproduces today's behaviour and
is worth authoring only as a control arm. The position that says something is **before**
growth: take the wrappers once they are accessible, in preference to realising gains on the
taxable book.

**The consequence to author deliberately, not discover**: before the gate opens, a wrappers
pool placed ahead of `growth` is not inert. Phase 1 finds the Roth `contributionBasis` — the
one wrapper slice with no age gate at all — and will spend it ahead of taxable equity, years
early. If that is not the intent, the Roths belong in a **second** pool placed after `growth`.
Two pools, four claims each, is the whole fix; that this is expressible at all is the pools
concept working.

### 22.3 The gap: `pool-metrics.js` has no concept of accessibility

`poolMetrics` sums `claimValueNative` over the claims with no age test anywhere. The moment a
pool claims a wrapper, four figures start counting money that cannot fund a dollar of spending
for as long as the gate holds — a decade or more on a plan that retires early, which is
precisely the plan that authors buckets:

| figure | what it does now | why it matters |
|---|---|---|
| `balance` / `yearsOfCover` | counts locked balances | the cover schedule — the feature's headline number — overstates by the whole wrapper book. §9.3(a) measured the mirror image of this defect at **0.0 years in every year**, and it was invisible until plotted |
| `available` (`balance − floor`) | sizes a flow's `givable` | an edge sourced from a wrapper pool is sized against money Phase 1 cannot reach |
| `headroom` / `_bookBase` | PERCENT targets and ceilings | same blindness, one level up |
| the scoped draw's `shortfall` | **discarded** by `PoolFlowApplyReducer` | the resulting under-fill is recorded nowhere, so the symptom is a refill that quietly does less than it says |

The under-fill is *safe* — the scoped draw is Phase-1-only by construction (§12.4), so it can
never pay a penalty to hide a shortfall — but safe and silent is this design's named failure
mode, not its defence.

**The fix reuses an authority that already exists.** `isAccessible` /
`isDrawdownAccessible` in `src/finance/derived-metrics/net-liquidity.js` answers exactly this
question and is already the single source of truth for "is this account lever-reachable right
now" (design 88 §5). Export the age predicate and have `poolMetrics` return, alongside the
untouched `balance`:

- **`accessible`** — Σ of what a Phase 1 draw would really find in this pool now;
- **`locked`** — the remainder;
- **`unlocksAt`** — the earliest date any locked claim opens (owner birth date + `minimumAge`).

Then `yearsOfCover` and `available` read `accessible`. `balance` keeps meaning what it has
always meant — what the pool holds — so nothing already reading the cube changes meaning, and
the panel can show the pair. A pool with no wrapper claim is byte-identical.

**The one trap in building it**: accessibility is not a boolean per account. An under-age Roth
yields its `contributionBasis`, so the answer is an **amount**. Mirror `_penaltyFreeAvailable`
rather than re-deriving the rule beside it — a metrics copy that says "a Roth is locked" would
report cover the draw does produce, which is the same class of defect pointing the other way.

### 22.4 The penalty gate: it exists, it is always on, and it is not authorable

Phase 2 draws with a 10 % penalty when `account.allowsEarlyWithdrawal` is true, computing the
penalty, the basis split and the tax actions correctly. What it lacks is any way to say *no*:

- `allowsEarlyWithdrawal` is **neither written by `_serializeAccount` nor read back by the
  revive path**. It is therefore always the class default — `true` for 401(k), Roth and IRA,
  `false` for super — and cannot be authored, edited or round-tripped. A saved plan and a
  rebuilt one agree only because neither can differ.
- So on any plan that exhausts its pools before the gate opens, the engine takes the Roth
  contribution basis clean and then pays 10 % penalties on 401(k) / IRA / Roth earnings, and
  the pool panel says nothing about it.

Two additions, in this order:

1. **Round-trip `allowsEarlyWithdrawal`** through `_serializeAccount` and the revive opts —
   defaulting to the class value when absent so every saved scenario is unchanged. Without
   this, anything built on top of it is decided by a constructor. See §22.8 for the
   provenance of the omission and for why the round-trip is **not** symmetric across the
   four wrapper types.
2. **`access` on the pool**, because the policy is a property of *how this pool is being used*,
   not of the account:

   ```
   { id: 'wrappers', spendOrder: 35,
     access: { mode: 'PENALTY_FREE' },        // the default
     claims: [...] }
   ```

   `ALLOW_PENALTY` is the opt-in. It decides two things and they must be the same switch:
   whether `accessible` (§22.3) includes the penalised slice, and whether this pool's claims
   may be drawn in Phase 2. Splitting them is how a pool comes to report cover it will not
   deliver.

Authoring it on the pool also gets the composition right for free: the same 401(k) can be
`PENALTY_FREE` while it sits in a reserve node and `ALLOW_PENALTY` in a last-resort node, which
an account-level flag cannot say.

### 22.5 The editor — what exists, and the two traps that read as "there is no input"

The control surface is `buildLiquidityGraphEditor` (`structured-param-editors.js`), and it
**can** author a wrappers pool today: `+ Add Pool` for the node, `+ Add Claim` for each
account, and `accountsProvider` supplies every account unfiltered, so the wrappers are in the
Account dropdown. Reported as unauthorable in practice, and the reason is that the two
defaults conspire to make the successful path look like a failed one:

1. **`+ Add Pool` defaults `spendOrder` to `(pools.length + 1) * 10`** — i.e. *after* every
   existing pool. On a four-pool graph the new node lands at 50, behind `growth`, which is
   §18.6's corollary exactly: the arm that is indistinguishable from not having authored it.
   The author adds the pool, rebuilds, sees no change, and concludes the input is missing.
   **Fix**: default a new pool's `spendOrder` to blank (`never`, which the placeholder already
   says) so the position is a decision, not an accident.
2. **`+ Add Claim` defaults its `pool` cell to `pools[0]`**, not to the pool just added, so the
   first claim silently lands in bucket 1. **Fix**: default to the last pool in the table.

Neither is the real absence, which is this: **nothing in the editor says anything about
accessibility**, because §§22.3–22.4 do not exist yet. The columns that close it are one
`access` select on the Pools table, and — read-only, on the panel rather than the editor — the
`accessible` / `locked` / `unlocksAt` triple from §22.3. A pool editor that can name a
retirement account but cannot say *when* the money in it arrives is a vocabulary with a hole
in it, and that is what the author actually hit.

### 22.6 What NOT to do — sleeve-narrowing a wrapper

The natural request is "claim the EQUITY sleeve of the 401(k)", and `normalizeClaims` refuses
it. The refusal is correct and should stay: `_drawPenaltyFree` calls `consumeHoldings` only
for `type === BROKERAGE`, and a wrapper draw debits the balance and lets `transaction()` spread
the debit pro-rata across the lots. A sleeve narrowing there would enforce nothing while
reading, in the config, exactly like a pool boundary — and `sleeveOptionsFor` already keeps it
off the screen rather than leaving it to be typed and discovered at Rebuild.

The cost is small and worth stating: a whole-account claim on a Roth that also holds a cash or
gold sleeve puts those in the pool too. Making it exact is not a claims-syntax change, it is
routing the wrapper draw through `consumeHoldings` — a much larger change with a CGT-free
wrapper on the other side of it, and it is not required by anything here.

### 22.7 Phasing

1. **§22.2, config only.** The wrappers pool, placed on purpose. Zero code, and it makes the
   placement explicit instead of an artefact of `drawdownPriority`.
2. **§22.3.** `accessible` / `locked` / `unlocksAt`, off the `net-liquidity.js` authority, plus
   the panel showing the pair. Until the cover figure is honest, every conclusion drawn from a
   wrapper-claiming pool is measured against money that is not there.
3. **§22.5's two editor defaults.** Cheap, and they are what makes step 1 land.
4. **§22.4.** The serializer round-trip, then `access`. Smallest behavioural change of the
   four, and approximable meanwhile by placing the wrappers last.

### 22.8 Why `allowsEarlyWithdrawal` was not on the export — an omission, and the asymmetry that had to survive fixing it — BUILT (5 Sep 2026)

Asked directly, and worth the answer in full because the naive fix has a failure mode.

**It is not a decision. No commit ever considered it.** `git log -S allowsEarlyWithdrawal --
src/scenarios/scenario-serializer.js` is empty: the field was never added and never removed.
The provenance is design 53 Phase 2 step 4, which planned the serializer work as *"the
`in account` guards already degrade gracefully; **confirm** the retirement classes still
hydrate the fields"*. The confirmation step was satisfied by the fields that were already in
the block. `minimumAge` was; `allowsEarlyWithdrawal`, defined two lines below it in the same
constructor, was not, and a confirm-only step cannot find a field nobody wrote.

The natural home already exists and already writes the sibling half of the same gate: the
`'contributionBasis' in account` block in `_serializeAccount` emits `minimumAge`.
`minimumAge` says *when the door opens*; `allowsEarlyWithdrawal` says *whether there is a door
before then*. Splitting one gate across "serialized" and "constructor-derived" is the whole
defect.

**A live inconsistency proves nobody noticed.** `scenario-loader.js` authors
`allowsEarlyWithdrawal: true` explicitly on every promoted inherited-retirement record
(design 63 §15). `_makeAccount` never reads it into `opts`. The value survives only because
`TraditionalIRAAccount`'s class default happens to be `true` as well. Code that authors a
value its reader ignores is the signature of an omission, not of a policy.

**Measured** — serialize → revive, per type:

| authored | in the export? | after reload |
|---|---|---|
| 401(k) default `true` | no | `true` |
| 401(k) `false` | no | **`true`** |
| Roth `false` | no | **`true`** |
| IRA `false` | no | **`true`** |
| super `true` | no | **`false`** |

Every non-default value reverts to the class default, silently, on one save/load cycle. So
"never take an early withdrawal from the 401(k)" — a reasonable and, for an early retiree, a
large modelling choice — is not merely un-editable, it is **unsayable**.

#### The asymmetry: export it for the three US wrappers, NOT for super

The tempting fix is to write and read the field for all four types, symmetrically with
`minimumAge`. That would create a way to author a believable wrong number, and the mechanism
is worth stating precisely because it is invisible:

- **Phase 2 cannot draw super at any flag value.** After the `allowsEarlyWithdrawal` test it
  looks up `earlyWithdrawalRulesFn(account.type)`, and `US_EARLY_WITHDRAWAL_RULES` has entries
  for Roth / IRA / 401(k) only. A super account reaches `if (!rules) continue`.
- **But `net-liquidity.js` believes the flag unconditionally.** `isAccessible` returns true on
  `account.allowsEarlyWithdrawal` before it ever looks at the type or the age.

So an authored `super: allowsEarlyWithdrawal = true` would move `computeNetLiquidity` — which
is **the control metric** (design 88 §5), the pool the MPC and the optimizer believe they can
steer — while moving no dollar in any drawdown path. A lever that changes the metric and not
the money, in the one metric whose scope is hardest to check, is the §20.18 failure class with
a bigger blast radius.

The author's instinct ("it should be for non-super accounts") is therefore right, and this is
the mechanism behind it. Super's `false` is **structural, not authored**: it is a statement
about which rules table has an entry, and it belongs in the class where it is.

Nor is the real-world case an argument against this. Early release of Australian super does
exist — severe financial hardship, compassionate grounds, and the departing-Australia
superannuation payment, which a US/AU household will ask about — but none of them is a 10 %
penalty. DASP is a punitive flat withholding. Modelling any of them means a **rules entry**
with its own rate, not this boolean, and the boolean would quietly produce the wrong tax if
pointed at it.

#### The change — BUILT (5 Sep 2026)

1. **`supportsEarlyWithdrawal(type)`**, exported from `us-early-withdrawal-rules.js` beside
   the table it reads. One predicate, because the whole defect is two readers disagreeing
   about what the flag means, and a second copy of "which types have a rule" would be a third.
2. **`_serializeAccount`** emits the flag in the existing retirement block beside
   `minimumAge` — for the three types that have a rule.
3. **`_makeAccount`** reads it into `opts` **only when present**, so every scenario saved
   before this change keeps its class default and no existing plan moves by a cent. An
   authored `true` on a type with no rule is dropped with a `console.warn` rather than
   honoured — warned and not thrown because this runs at LOAD, and refusing to open a
   scenario over a flag that decides nothing is the worse failure.
   **Revised the same day** — the write side persists only the DEVIATION; see §22.9.
4. **`net-liquidity.js#isAccessible`** now requires `supportsEarlyWithdrawal(account.type)`
   alongside the flag. This is the guard that actually closes the hazard, and it is separate
   from (3) on the `cash-sleeve-has-no-capital-gain` lesson: **a config boundary is not a
   choke point.** State entries are also built as plain objects — `_accountToStatePlain`, the
   bequest seeds — and never pass through the serializer at all, so a serializer-only guard
   protects the one path that was already hardest to get wrong. Inert today: every account
   carrying the flag either has a rule, or has no `minimumAge` and returned on the line above.

Tests: `tests/unit/early-withdrawal.test.mjs` EW-13 (round trip: an authored `false`
survives; the class default is unchanged; a pre-change save keeps its default) and three new
EW-9 cases (super is absent from the export; a hand-edited `true` is dropped *audibly*; the
metric and `replenishSavings` now agree on a hand-built state). 6134 unit + 1351 viz green.

**Still open**: the account editor (`account-editor.js`) exposes neither `minimumAge` nor this
flag, so the value is authorable in an export and not yet in the UI. That is the same gap as
§22.5's, one level down, and it is the next thing to close.

### 22.9 Regulation is not configuration — `minimumAge` withdrawn from the export, `allowsEarlyWithdrawal` narrowed to the opt-out — BUILT (5 Sep 2026)

§22.8 fixed a round trip and, in doing so, walked into the question behind it, raised by the
author on reading the result: *what would anyone ever set these to?*

The answer sorts the two fields onto opposite sides of a line this design had not drawn:

> **A statutory rule belongs to the rules module. A household's decision belongs to the
> config. A field that persists the first is duplication waiting to go stale; a field that
> cannot express the second is a missing lever.**

`minimumAge` is the first. `allowsEarlyWithdrawal` is *both*, which is why it was confusing.

#### `minimumAge` — the statute was living in the file

Written on every save and read back over the class default, so a saved scenario carried its
own copy of the law. Measured before touching it: **341 scenario files, 784 wrapper accounts,
zero deviations** from the class default. Every authored `minimumAge` in source
(`intl-retirement-scenario.js`, `au-single-homeowner-scenario.js`, `account-builder.js`)
likewise equals it — so the same four numbers live in three places in code and a fourth in
every export.

That is not merely redundant, it is the `param-node-cascade-drift` shape: the day the age
changes in the rules, every saved scenario silently keeps the old gate and looks entirely
correct, because a wrapper unlocking on the wrong date produces a perfectly believable plan.

**Withdrawn from both sides of the serializer.** The class is the authority. A file that
still carries the age (every file written before this) loads to the identical gate, so nothing
on disk moves; a file that *disagrees* loses to the statute and says so with a `console.warn`,
because the two ways to get there — a save from a build with a different age, or a hand edit —
are both things the author needs told rather than left to discover as a date that came out
wrong. The **constructor** `opts.minimumAge` path is deliberately untouched: a genuine
exception has to be expressible somewhere in code (§22.10).

#### `allowsEarlyWithdrawal` — three jobs, one name

1. *"This type legally permits early access, with a penalty"* — a **legal fact**. The class
   default already states it correctly per type, and for these four types the default is
   exactly `supportsEarlyWithdrawal(type)`. Not a setting.
2. *"This household will take that penalty on this account"* — a **policy**, and the only
   thing worth authoring. It has one meaningful value: `false`, ring-fencing an account.
3. A **workaround** — see §22.10.

§22.8 shipped (1) and (2) together by exporting whatever the account held. Exporting `true`
is persisting the regulation as config: the same mistake as `minimumAge`, one field over.

**Narrowed to deviation-only.** The write side emits the flag only when it is `false` on a
type that supports early withdrawal. Absent therefore means *"the law applies"*, which is what
an unauthored account should say, and the only value that ever appears in a file is a decision
somebody actually made. The read side is unchanged — it still accepts what it finds and still
drops a `true` on an unsupported type — because a read side has to cope with files the write
side did not produce.

Tests: `early-withdrawal.test.mjs` EW-13 (revised: the default is *not* written; the opt-out
survives) and EW-14 (four cases: the age is never exported; an older file loads to the same
gate; a disagreeing file loses audibly; the constructor exception still builds). 6138 unit +
1351 viz green.

### 22.10 Follow-up — the inherited wrapper's age gate, and the shape a real exception needs

**Not built. Filed here because §22.9 makes it visible rather than because it is new.**

An inherited IRA has no owner age gate — distributions are penalty-free at any age, which is
why `scenario-loader.js` sets `allowsEarlyWithdrawal: true` on every promoted
inherited-retirement record (design 63 §15). But the record revives through
`TraditionalIRAAccount`, whose constructor is written for a *living owner*, so:

```
inherited IRA →  minimumAge = 60   allowsEarlyWithdrawal = true
```

The 60 is wrong, and the flag is there to punch through it. So job (3) of §22.9's list: the
policy field is being used to correct a statutory one. Both halves are then saying something
false, and they cancel — which is why nothing has ever misbehaved, and why it would not stay
that way. `drawdownPriority: null` keeps these accounts out of the discretionary walk today
(they drain on the SECURE 10-year stream), so the cancellation is currently unobservable; it
stops being unobservable the moment an inherited wrapper is claimed by a pool (§22.2) or
reached by any path that consults the gate directly.

**The honest values are `minimumAge: null` and no flag** — an account with no gate needs
nothing to bypass. That is a design-63 change (the promoted-record shape, its revive, and the
`inherited-*` roles) and does not belong in a serializer pass.

#### And the shape a real exception needs

Withdrawing the free number raises the fair question of what happens when a per-account age
genuinely differs. Candidates exist — separation from service for that employer's plan, a
lower age for some public-safety employment, an AU preservation age that is a function of
birth year rather than a flat 60, and the inherited case above.

**None of them is a number in a box.** Each is a *named statutory exception that resolves to
an age*, usually from facts the model already holds (an employment end date, a birth date).
So the successor to the deleted field is not an editable age, it is a rule selector in
`us-early-withdrawal-rules.js` and its AU sibling — and until one is written, none of these is
modellable, which is the correct state for a rule nobody has yet transcribed from a primary
source. Per this repo's standing rule, that transcription comes from the authority into
`docs/`, not from memory.

## 23. Turning the pools OFF — `liquidityGraphEnabled` (6 Sep 2026)

### The defect

The graph has **three** consumers, and `behavioralStrategies` gates exactly one of them:

| Consumer | Site | Gated by `LIQUIDITY_POOLS`? |
| --- | --- | --- |
| The spend order — the graph compiles to `state.drawdownSequence` (§12) | the toolset's state projection | **no** |
| The rebalancer — a pool `target` sizes the classes its pools claim; a gate vetoes the refill sale (§12.2, §12.4 executor 1) | `TARGET_ALLOCATION`'s reducers | **no** |
| The refill flows — the (s, S) triggers, the market gates, the transfers | `LIQUIDITY_POOLS`'s reducers | yes |

So deselecting the strategy stops the refills and leaves the household still walking the
buckets on a book the pool targets are still sizing. §12.2's error text already said this
out loud — it had to, because the same asymmetry made the "two authorities" throw fire on a
config whose second authority nothing read — but saying it in an error message is not the
same as offering a way out. The only actual off switch was clearing the `liquidityGraph`
param, which means **deleting the structure you want back** the moment the control arm is
finished.

Worse, `liquidityGraph`'s `visibleWhen` was gated on the strategy. Uncheck it and the graph
editor disappears *while the graph keeps driving the run* — the panel refuses to show you
the thing that is still deciding your draw order.

### The switch

`liquidityGraphEnabled` (Boolean, default true), checked in **`resolveLiquidityGraph`** —
the one function all three consumers already share, and the reason §12 insisted on a single
normalization site in the first place. `false` returns `null` before the normalizer runs, so
every design-97 line goes inert at once: the spend order falls back to `drawdownPriority`,
the rebalancer's `poolGraph` is null, and `LIQUIDITY_POOLS` contributes no reducers.

Three properties that are the whole design:

1. **Absent is ON.** Only the exact `false` switches off, so every existing scenario is
   byte-identical. POOL-20b pins `undefined`, `true` and `null` as live.
2. **The graph is KEPT.** That is the point — this is the pools-off control arm without
   losing the structure. `scripts/lib/pool-arms.mjs`'s `POOL_LESS` shape (an empty pool
   order) remains the right tool for a generated study; this is the switch for a hand-authored
   scenario you want to run both ways.
3. **A switched-off graph still validates.** `collectAuthoredGraphProblems` deliberately
   calls the un-gated `_normalizeFromParams`, not `resolveLiquidityGraph`. The switch is a
   run-time "ignore this", not an authoring-time "this is fine" — if it silenced the
   validator, flipping it back on would surface an error the editor never showed.

One consequence worth stating: with the graph off, an authored `drawdownSequence` **stops
being a rival authority** and becomes live (POOL-20c). It has to — a config that turns the
pools off and hand-writes the order instead is exactly the config someone reaches for, and
refusing to load it would make the switch useless.

### Visibility

- `liquidityGraphEnabled` is `visibleWhen: { param: 'liquidityGraph', exists: true }` — shown
  whenever a graph is authored, **never** gated on the strategy selection. Gating it on the
  checkbox would reproduce the exact trap it closes: you would deselect the strategy, lose the
  switch from the panel, and the pools would still be driving the run.
- `liquidityGraph` is now `anyOf: [strategy selected, graph exists]`, so an authored graph is
  always editable regardless of the strategy.
- `poolFlowsEnabled` gains an AND on `liquidityGraphEnabled notEquals false` — the refill
  switch says nothing once the whole graph is off.

`poolFlowsEnabled` and `liquidityGraphEnabled` are **not** the same axis and both are worth
having: the first is §16.3's arm-vs-control switch for a study *of the refill rule* (pools,
targets and spend order stay live, no edge fires); the second is the whole feature off.

### Tests

`POOL-20a-d` in `tests/unit/evt-liquidity-pools.test.mjs`. POOL-20a is the load-bearing one:
it runs three years with the switch off and asserts the whole `sim.state` is byte-identical
to the same scenario with no graph at all — which is how the rebalancer consumer gets tested
without reaching into its internals. If pool targets had still sized the book, three years of
rebalancing would have moved balances and the compare would fail.

### The second half: a saved scenario ignored the switch

The switch worked on a freshly-built scenario and did **nothing** on a saved one — which is
every real scenario. The mechanism:

1. `BaseScenario.buildSim()` seeds `sim.state` from the saved `cfg.initialState`, which on a
   scenario saved while the pools were on already carries `liquidityGraph` and the compiled
   `drawdownSequence`.
2. `ScenarioLoader` then compiles the toolsets, and `ScenarioCompiler` merges its patches with
   `Object.assign` — which **adds** a key and can never remove one.
3. So the projection correctly emitted neither key, and the stale copies simply stayed.

The observable result was the worst of the three states: the flow reducers and the rebalancer
went dark (both read *params*, so the switch reached them) while the draw order kept walking
the buckets off a *state* key nobody had re-derived. A half-off run is harder to reason about
than either end, and nothing in the output says which half you got.

Fixed with `ScenarioLoader._evictStaleDerivedState`: after the compile, any key in
`TOOLSET_DERIVED_STATE_KEYS` that the projection did **not** emit is deleted from `sim.state`.
The list is `['liquidityGraph', 'drawdownSequence']` and is deliberately narrow — only keys
the projection owns outright, where a copy in a saved snapshot is a cache and never an
authority. POOL-20e pins the eviction; POOL-20f pins the other direction, that a key the
projection *did* emit is left alone (otherwise re-opening a pooled scenario would lose its
draw order entirely).

This is the same shape as every other stale-persisted-node bug in this codebase, and worth
generalising the next time one appears: `Object.assign` semantics mean **a projection can
only ever add to a saved snapshot**, so any field that stops being emitted needs an explicit
eviction or it lives forever.
