# 124 — What a pool gate measures, and protects, once its pool is empty

**Status:** BUILT (15 Oct 2026), rev 2. Raised by a study flag: "the gate veto does not cover
equity outside the gated pool". The trace in §2 shows the flag's premise is not what happened,
and finds a different defect underneath it. Rev 2 (§8) checks the proposal against the code and
records the author's choices: option A for **every** empty sleeve pool, household
value-weighted in the base currency (§6 Q1), and an empty pool's BALANCE drawdown read as no
signal (§6 Q3).

**Related:** design 97 (liquidity pools: §12.4 the gate as a veto, §12.4c SOURCE/EDGE scope,
§20 the return index, §20.14 `drawdownBasis: INDEX`, POOL-12b the "no signal" rule), the pool
target `maxFraction` cap (the commit that fixed the ratchet this trace was chasing).

## 1. The question as raised

On one traced Monte Carlo path, a plan with pools sold equity into bonds almost every year for
three decades, ending all bonds. The growth→buffer refill carried a drawdown gate
(`sourceDrawdownUnder: 0.2`, `drawdownBasis: INDEX`), yet nearly all of the selling was done by
the rebalancer, and late in the run it was selling equity inside the Roths and super, which no
gated pool claims. The flag asked whether the household-level bond weight should respect the
source gate wherever the equity sits.

## 2. What the trace actually shows

### 2.1 The veto already covers the class household-wide

`RebalanceToTargetReducer._applySourceVeto` floors each class a vetoed pool claims at its
**household** fraction (`actualFractions`, summed over every account the rebalancer manages,
Roths and super included). So a shut gate on a growth pool claiming taxable EQUITY pins the
household's whole equity weight, not just the taxable sleeve. The trace shows it working: the
gate shut once, after a down year, and the next year's rebalance sold roughly a tenth of the
equity of the years either side.

The veto is recorded whenever the destination still wants a refill (`want > 0`), whatever the
source holds, so an EMPTY source with a shut gate still floors its class household-wide — the
fact §2.3 turns on.

So the flag's premise is wrong. The selling did not get past a shut gate. The gate was
**open**, and the rebalancer was doing what it is meant to do with an open gate: moving the mix
to target. The target was the problem: a years-of-spend buffer that outgrew a shrinking book
(now capped by `maxFraction`).

### 2.2 The defect underneath: an empty pool's gate freezes

The growth pool claims only the taxable accounts' EQUITY sleeves. Spending drains them first,
and part-way through the run the pool holds nothing. From then on:

- `poolMarketReturn` returns null (no rated lots), so `_returnIndices` stops compounding the
  pool's return index;
- the index and its high are frozen for the rest of the run, at whatever drawdown they had when
  the pool emptied (here about 6%, below the 20% threshold);
- so the gate can never shut again, whatever the market does, while most of the household's
  equity (in the Roths) is still invested and still being sold by the rebalancer.

The rule this follows (POOL-12b, `_returnIndices`' docstring) says "no signal leaves the index
where it is, so the drawdown reads 0 and the gate stays OPEN". The second half is only true if
the pool emptied at its high. In general the drawdown is frozen at its last value, so an empty
pool's gate is stuck **open or shut** for the rest of the run, depending on the year it emptied.
A pool that empties during a crash keeps its SOURCE veto, and with it the household floor on
its class, for good.

~~The one exception is a gate with `highHalfLifeYears`: its high decays toward the frozen index.~~
Rev 2: there is no exception. The decaying high decays on the same "completed year with a
return" test as the index (`done` requires `marketReturn != null`), so it freezes too. Every
INDEX gate on an empty pool was stuck.

### 2.3 Why it matters even though an empty pool cannot be sold

The gate's own edge moves nothing from an empty pool, so for the refill the frozen gate is
harmless. But the gate also drives the rebalancer's veto (§2.1), and that veto is household-wide.
So the frozen state of a pool that holds nothing decides whether the household's remaining
equity may be sold after a crash, for the rest of the plan.

## 3. What the gate means

Two readings of "do not sell growth while it is down", and the code is currently half of each:

- **Pool-scoped:** the gate guards the pool's own lots. It measures the pool's market and
  vetoes the pool's sleeves. Once the pool is empty there is nothing to guard.
- **Class-scoped:** the gate guards the asset class. It measures that class's market and
  vetoes selling that class anywhere in the household.

Today the **measurement** is pool-scoped (the pool's lots) and the **veto** is class-scoped
(the household fraction). They agree while the pool holds the household's equity, and drift
apart as spending moves the household's equity into accounts the pool does not claim.

## 4. Options

**A. Measure an empty pool on its sleeves household-wide.** When a pool has no rated lots,
`poolMarketReturn` falls back to the value-weighted return of the same sleeves across every
account (for a growth pool: the household's equity). The index keeps tracking the market the
pool was in, and the gate keeps working. Smallest change; it only alters runs in which a gated
pool empties. It leaves the pool/class split of §3 in place while the pool holds anything.

**B. Measure every sleeve-claimed pool class-wide.** Always compute a sleeve pool's market
return over the household's holdings of those sleeves. Measurement and veto then mean the same
thing at all times. It moves every run with an INDEX gate whose pool is not the whole household
class (most real plans), so goldens and earlier pool studies move.

**C. Freeze explicitly, and say so.** Keep the pool-scoped meaning; when a gated pool empties,
treat its gate as having no signal: drawdown 0, open, which is what POOL-12b already claims. Fix
the docstring, and report "gate has no market: pool empty since <year>" on the pool panel. The
household's other equity is then unguarded after the pool empties, but visibly so.

**D. Leave gates alone and give the rebalancer its own market rule.** A rebalancer option like
"do not sell a class after a year it fell more than X", independent of any pool. That separates
"liquidity buckets" from "do not sell after a crash", but it is a second mechanism doing the
gate's job, which design 97 §12.4 deliberately avoided.

## 5. Proposal — BUILT

**A, plus C's reporting.** An empty pool's gate measures the household holdings of its sleeves,
so it never freezes, and the pool panel says when a gate is measuring household-wide because its
own pool is empty. Reasons:

- It fixes the defect (§2.2) without changing any run where gated pools stay non-empty.
- It matches the veto, which is already class-wide: if the gate protects the household's
  equity, it should look at the household's equity once the pool itself has none.
- B is the cleaner semantics, but it changes every INDEX-gated run for a disagreement that only
  bites once the pool has emptied. Revisit if a study shows the split matters while pools still
  hold the class.

Also: correct the POOL-12b docstring in `_returnIndices` (the drawdown is frozen at its last
value, not 0) whichever option is chosen.

### 5.1 As built

- **Measurement** (`pool-metrics.js`): `poolMetrics` reads `poolMarketReturn` as before; when it
  is null and the pool's claims narrow to sleeves, it falls back to `householdSleeveReturn` —
  Σ(mv × rate) / Σ mv over every lot in those sleeves across the **book** (every account the
  graph claims, the set `PoolFlowReducer._bookBase` sums), converted to the base currency — and
  marks the metrics `marketBasis: 'HOUSEHOLD'`. "Household" is the book rather than the
  rebalancer's managed accounts because the pool reducer cannot see the latter; in a pooled
  plan the two are the same accounts.
- **Every empty sleeve pool**, gated or not (author's choice): the stamped `marketReturn` and
  index always mean "this pool's market", whoever reads them.
- **Return gates follow too.** `sourceReturnOver` / `targetReturnUnder` read the same
  `marketReturn`, so an empty pool's return gates now watch the household's holdings of its
  sleeves as well. The draft did not say so; it is the same argument.
- **Stamp** (`pool-flow-reducer.js`): the cube entry carries `marketBasis` and
  `marketBasisSince` (the year it began) only while the fallback is in force; absent otherwise,
  so a pool that never empties stamps exactly what it did.
- **BALANCE basis** (§6 Q3, author's choice): an empty pool (balance ≤ half a cent) reads a 0
  drawdown — no signal, gate open — instead of 100%.
- **Panel**: the pool chip shows "household market since <year>" with a tooltip.
- **Goldens**: none moved — no golden fixture has a sleeve pool that empties or an empty
  BALANCE-gated pool. Every pool study run before this whose growth pool emptied is affected.

## 6. Open questions

1. ~~**The fallback's weights.**~~ Household value-weighted over the pool's sleeves, in the base
   currency. Built.
2. ~~**Whole-account claims.**~~ Unchanged (no signal). Built; a pool mixing whole-account and
   sleeve claims falls back on its sleeve claims' classes.
3. ~~**BALANCE-basis gates.**~~ An empty pool's BALANCE drawdown is no signal (0, open). Built.
4. **Does the veto belong class-wide at all?** §12.4 made it class-wide to stop the drift band
   laundering the same trade. If B or A is rejected, should the veto narrow to the pool's own
   accounts instead?

## 7. Tests

Built as `tests/unit/pool-empty-gate.test.mjs` (EPG-1…6; EPG-1, 4, 5 and 6 fail on the
pre-124 code) and a panel case in `tests/viz/liquidity-pools-plugin.test.mjs`. The plan:

- A gated growth pool that empties: the index keeps compounding at the household equity return;
  a later crash shuts the gate and the source veto floors household equity.
- A pool that never empties: byte-identical index, gate and veto (goldens unchanged).
- A pool that empties during a drawdown: the gate reopens when the household equity recovers
  (today it stays shut).
- Whole-account empty pool: null market return, as today.
- Panel: the "measuring household-wide" note appears only for an empty gated pool.

## 8. Rev 2 — review against the code (15 Oct 2026)

| § | Draft | Code / rev 2 |
|---|---|---|
| 2.2 | `highHalfLifeYears` decays toward the frozen index and eventually opens | no: the decaying high freezes with the index; there was no exception |
| 4 A | "only alters runs in which a gated pool empties" | behaviour yes; the stamped `marketReturn`/index change for any sleeve pool that empties |
| 4 A | fallback for the INDEX gate | it is `marketReturn`, so the RETURN gates follow it too |
| 4 A | "every account" | the graph's book: the pool reducer cannot see the rebalancer's account list |
| 4 A | value-weighted | must be in the BASE currency; `poolMarketReturn` itself weights native amounts across currencies (flagged, unchanged) |

Flag, not fixed here: `poolMarketReturn` weights a pool's lots by NATIVE market value, so a pool
claiming both a USD and an AUD account over-weights the AUD lots by the exchange rate. The
household fallback converts; the pool's own reading is unchanged to keep every golden still.
