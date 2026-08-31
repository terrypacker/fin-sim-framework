/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY } from '../../simulation-framework/reducers.js';
import { ageAsOf }           from '../behavioral/rebalance-to-target-reducer.js';
import { toBaseCurrency, currencyOf } from '../fx/to-base-currency.js';
import { FLOW_EXECUTOR, POOL_TARGET_MODE, POOL_SPEND_BASIS } from './liquidity-graph.js';
import { poolContext, allPoolMetrics } from './pool-metrics.js';

/**
 * DESIGN 97 §12.3/§12.6 — the REFILL RULE, which `FINDINGS.md` §6.4 called "probably 80 % of
 * the pools concept, and the one thing none of the current levers approximates".
 *
 * What actually governs a bucket strategy is not the draw order — §7 measured that and the
 * draw order alone already separates the arms — it is **whether the plan refills a drained
 * pool by selling the growth pool, and when**. Today that decision is implicit in the
 * design-61 drift band: spending drains BOND, the next rebalance restores the BOND target by
 * selling EQUITY, and net of the round trip the plan sold equity to fund spending, laundered
 * through the bond sleeve — invisible to a cover schedule, because bucket 2 looks refilled.
 *
 * This reducer makes that decision explicit and conditional:
 *
 *   - a **trigger** says when the destination wants money (`s` of an (s, S) band);
 *   - `amount.toTarget` says how far to fill it (`S`);
 *   - a **gate** says whether the SOURCE may be sold at all this period.
 *
 * `gate.sourceDrawdownUnder: 0` is §6.4's own proposal — "do not refill bucket 2 from bucket
 * 3 while bucket 3 is below its trailing high" — and `0.05` is the softer "harvest in up
 * markets" the bucket literature states. `gate.targetDrawdownOver` is the same machinery
 * pointing the other way and is how "buy the dip" is finally said (§7.0 recorded it as a
 * behaviour the engine did not have; it is a reverse edge).
 *
 * ── Ordering (§12.6) ────────────────────────────────────────────────────────────────
 * Runs at PRE_PROCESS on a period advance: AFTER inflation has moved `state.monthlyExpenses`
 * (a years-based trigger reads the live spend line) and the regime reducers have stamped
 * `state.activeRegimes` (gates read them), and BEFORE `RebalanceToTargetReducer`
 * (PRE_PROCESS + 4), which is executor 1. A period therefore reads:
 * **observe → refill → rebalance → spend.**
 *
 * ── What it writes ──────────────────────────────────────────────────────────────────
 *  - `state.liquidityPools[id]` — the per-pool cube: balance, capacity, target, cover, the
 *    persisted trailing `high`, the period's `marketReturn` (which the NEXT period's market
 *    gates read — see `_gateOpen`) and (for a TRAILING spend basis) `spendHistory`;
 *  - `state.poolRefillPlan` — what executor 1 must know: per-pool shortfall, and the set of
 *    source pools whose sale is VETOED this period;
 *  - one `POOL_FLOW_APPLY` per firing TRANSFER edge.
 *
 * `gatedFlows` on the cube is the field that makes the feature debuggable: the interesting
 * event is nearly always a flow that did NOT fire, and nothing else in the journal records
 * a non-event. `firedFlows` is its counterpart and is not redundant with the journal: only
 * a cross-account edge emits an action, so without it the ledger's visible half is the
 * TRANSFER edges alone and an in-portfolio edge reads as one that never fired.
 */
export class PoolFlowReducer extends Reducer {
  static type        = 'PoolFlowReducer';
  static description = 'Design 97 Part II: evaluates the liquidity graph\'s refill edges — (s,S) triggers and market-state gates — stamping per-pool metrics and emitting POOL_FLOW_APPLY for cross-account transfers.';

  /**
   * @param {object}  opts
   * @param {{pools:Array, flows:Array}} opts.graph       - a normalized liquidity graph
   * @param {boolean} [opts.flowsEnabled=true]            - false ⇒ topology + metrics, no firing
   * @param {string}  [opts.baseCurrency='USD']
   * @param {string}  [opts.expensesCurrency='RESIDENCE']
   */
  constructor({ graph, flowsEnabled = true, baseCurrency = 'USD', expensesCurrency = 'RESIDENCE' } = {}) {
    super('Pool Flows', PRIORITY.PRE_PROCESS + 3);   // before RebalanceToTarget (+4)
    this.graph              = graph;
    this.flowsEnabled       = flowsEnabled !== false;
    this.baseCurrency       = baseCurrency;
    this.expensesCurrency   = expensesCurrency;
    this.reducedActionTypes   = ['US_PERIOD_ADVANCE', 'AU_PERIOD_ADVANCE'];
    this.generatedActionTypes = ['POOL_FLOW_APPLY'];
  }

  /**
   * The book the PERCENT target modes read: Σ market value of every claimed account,
   * FX-normalised. Deliberately the pools' own book rather than the rebalancer's account
   * list — a percentage of "the book" has to mean a percentage of something the graph names.
   */
  _bookBase(state) {
    const seen = new Set();
    let total  = 0;
    for (const pool of this.graph.pools) {
      for (const { key } of pool.claims) {
        if (seen.has(key)) continue;
        seen.add(key);
        const a = state?.[key];
        if (!a || typeof a !== 'object') continue;
        const native = Array.isArray(a.holdings) && a.holdings.length
          ? a.holdings.reduce((s, h) => s + (h?.marketValue ?? 0), 0)
          : Math.max(0, a.balance ?? 0);
        total += toBaseCurrency(native, currencyOf(a, this.baseCurrency), this.baseCurrency, state);
      }
    }
    return total;
  }

  /**
   * Is a flow's gate open this period?
   *
   * Returns `{ open, reason }` — the reason is carried into the cube so a closed gate is a
   * recorded event rather than an absence.
   */
  _gateOpen(flow, { metrics, highs, state, asOfMs, priorYearReturns }) {
    const g = flow.gate;
    if (!g) return { open: true, reason: null };

    // Drawdown from the trailing high. `high` is persisted pool state, not a journal window:
    // a peak set before the run's start date is not knowable from the journal, and the value
    // has to survive serialization identically or a replay diverges.
    const drawdownOf = (poolId) => {
      const high = highs[poolId] ?? 0;
      if (!(high > 0)) return 0;
      return Math.max(0, 1 - (metrics[poolId]?.balance ?? 0) / high);
    };

    if (g.sourceDrawdownUnder != null && drawdownOf(flow.from) > g.sourceDrawdownUnder + 1e-12) {
      return { open: false, reason: `source ${flow.from} is ${(drawdownOf(flow.from) * 100).toFixed(1)}% below its high` };
    }
    if (g.targetDrawdownOver != null && drawdownOf(flow.to) < g.targetDrawdownOver - 1e-12) {
      return { open: false, reason: `destination ${flow.to} is not ${(g.targetDrawdownOver * 100).toFixed(0)}% below its high` };
    }
    // Market state — the last COMPLETED calendar year's reading, never this period's.
    //
    // `metrics[poolId].marketReturn` reads `state.effectiveGrowthRates`, and design 97 §20
    // measured what that means at this point in the period: `EquityReturnReducer` folds the
    // year's draw on at PRE_PROCESS + 1.5, this reducer runs at PRE_PROCESS + 3, and the
    // holdings grow later in the same period. A gate reading it live therefore knows the
    // return of the year it is deciding in — corr(reading_t, realized_t) = 1.0000 over 15
    // years, against 0.07 for the prior year (`probe-pool-gate-foresight.mjs`).
    //
    // That is clairvoyance, and it is worth a fortune for reasons that have nothing to do
    // with liquidity: a gate that pauses equity sales in the year the market is ABOUT to
    // fall makes every bucket arm look brilliant, believably, and silently. No household can
    // do it, so no gate may. Reading the previous period's stamped value makes the rule
    // implementable — "do not sell after a down year" — and turns the gate into a bet on
    // year-to-year predictability, which is a property of the RETURN PROCESS
    // (`equityReturnModel`) and therefore something a study can vary rather than assume.
    //
    // The unit is the calendar YEAR, not the period, and that is not a simplification. This
    // reducer fires on BOTH `US_PERIOD_ADVANCE` and `AU_PERIOD_ADVANCE`, six months apart, so
    // "the previous period's stamp" means last December on the January advance and THIS
    // JANUARY on the July one — half a year of foresight, surviving in exactly half the
    // evaluations. `_priorYearReturns` carries the last stamp from an EARLIER year across
    // every advance within a year, which is also the right unit on its own terms: the equity
    // tick is annual (`dt = 1`), so a year is the finest grain at which the signal changes.
    //
    // Null on the first year, and for a pool with no rated lots (POOL-12b): "no signal" is
    // not "bad signal", so `sourceReturnOver` stays OPEN and `targetReturnUnder` stays SHUT,
    // matching each gate's own absent-reading default.
    const ret = (poolId) => priorYearReturns?.[poolId] ?? null;
    if (g.sourceReturnOver != null) {
      const r = ret(flow.from);
      if (r != null && r < g.sourceReturnOver) {
        return { open: false, reason: `source ${flow.from} is returning ${(r * 100).toFixed(1)}%` };
      }
    }
    if (g.targetReturnUnder != null) {
      const r = ret(flow.to);
      if (r == null || r >= g.targetReturnUnder) {
        return { open: false, reason: `destination ${flow.to} is not returning below ${(g.targetReturnUnder * 100).toFixed(0)}%` };
      }
    }
    if (g.notInRegime) {
      const tags = new Set((state.activeRegimes ?? []).flatMap(r => r?.tags ?? []));
      const hit  = g.notInRegime.find(t => tags.has(t));
      if (hit) return { open: false, reason: `regime ${hit} is active` };
    }
    if (g.notBefore && asOfMs < Date.parse(g.notBefore)) return { open: false, reason: `before ${g.notBefore}` };
    if (g.notAfter  && asOfMs > Date.parse(g.notAfter))  return { open: false, reason: `after ${g.notAfter}` };
    if (g.ageOver != null || g.ageUnder != null) {
      const primaryKey = Object.keys(state.people ?? {})[0];
      const age = ageAsOf(state.people?.[primaryKey]?.birthDate, asOfMs);
      if (age == null) return { open: true, reason: null };   // no birth date ⇒ the age gate cannot bind
      if (g.ageOver  != null && age < g.ageOver)  return { open: false, reason: `age ${age.toFixed(1)} < ${g.ageOver}` };
      if (g.ageUnder != null && age > g.ageUnder) return { open: false, reason: `age ${age.toFixed(1)} > ${g.ageUnder}` };
    }
    return { open: true, reason: null };
  }

  /**
   * Per pool, the market return of the last COMPLETED calendar year — what the gates act on.
   *
   * `marketReturnYear` is the year a cube entry's `marketReturn` was observed in. On the first
   * advance of a year the prior entry is necessarily from an earlier year, so its
   * `marketReturn` IS last year's; on any later advance within the same year the earlier
   * advance has already overwritten it with this year's, so the value it resolved is carried
   * forward instead. A year with no advance at all simply leaves the most recent completed
   * year standing, which is what "the last thing that finished" means.
   */
  _priorYearReturns(prior, yearOf) {
    const out = {};
    for (const pool of this.graph.pools) {
      const p = prior?.[pool.id] ?? {};
      out[pool.id] = (p.marketReturnYear != null && p.marketReturnYear >= yearOf)
        ? (p.priorYearReturn ?? null)
        : (p.marketReturn ?? null);
    }
    return out;
  }

  /** How much the destination is asking for, or 0 when the trigger has not tripped. */
  _demand(flow, pool, m, ctx, poolState) {
    const t = flow.trigger;
    if (t?.below) {
      const level = t.below.mode === POOL_TARGET_MODE.YEARS_OF_SPEND
        ? t.below.value * (t.below.spendBasis === POOL_SPEND_BASIS.TRAILING ? (ctx.trailingSpend ?? ctx.annualSpend) : ctx.annualSpend)
        : t.below.mode === POOL_TARGET_MODE.PERCENT ? t.below.value * ctx.bookBase
        : t.below.value;
      if (m.balance >= level) return 0;                     // still inside the band — do nothing
    } else if (t?.belowTargetFraction != null) {
      if (m.target == null || m.balance >= m.target * t.belowTargetFraction) return 0;
    }
    // The band's UPPER edge: `toTarget` fills to S, not back to s. That separation is the
    // whole point — refilling only to the trigger level makes the edge fire every period.
    return flow.amount.toTarget ? m.shortfall : Infinity;
  }

  reduce(state, action, date) {
    const asOfMs = action?.date != null ? new Date(action.date).getTime()
                 : (state.currentPeriods?.[action?.type === 'AU_PERIOD_ADVANCE' ? 'AU' : 'US']?.startMs
                    ?? (date ? new Date(date).getTime() : Date.now()));

    const ctx = poolContext(state, {
      expensesCurrency: this.expensesCurrency,
      baseCurrency:     this.baseCurrency,
      bookBase:         this._bookBase(state),
    });

    const prior   = state.liquidityPools ?? {};
    const metrics = allPoolMetrics(state, this.graph, ctx);
    const yearOf  = new Date(asOfMs).getUTCFullYear();
    const priorYearReturns = this._priorYearReturns(prior, yearOf);

    // The trailing high, monotone, updated BEFORE the gates read it so a pool at a fresh peak
    // this period reads as 0% below its high rather than as one period stale.
    const highs = {};
    for (const pool of this.graph.pools) {
      highs[pool.id] = Math.max(prior[pool.id]?.high ?? 0, metrics[pool.id].balance);
    }

    const gatedFlows = [];
    const inflow     = {};
    const outflow    = {};
    const vetoed     = new Set();
    const transfers  = [];
    const fired      = [];
    const adjust     = {};

    if (this.flowsEnabled) {
      // Deterministic evaluation order (§12.5): destination spend order, then edge priority,
      // then id. A period must be replayable, and two edges into one pool must not race.
      const orderOf = new Map(this.graph.pools.map(p => [p.id, p.spendOrder ?? Number.MAX_SAFE_INTEGER]));
      const flows = [...this.graph.flows].sort((a, b) =>
        (orderOf.get(a.to) - orderOf.get(b.to)) || (a.priority - b.priority) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

      for (const flow of flows) {
        if (flow.cadence === 'ANNUAL' && prior[flow.to]?.lastFired?.[flow.id] === yearOf) continue;

        const gate = this._gateOpen(flow, { metrics, highs, state, asOfMs, priorYearReturns });
        const dest = metrics[flow.to];
        const src  = metrics[flow.from];
        // Recompute the destination's shortfall against what earlier edges already promised
        // it: two sources into one pool must SHARE the shortfall, not each fill it.
        const promised = inflow[flow.to] ?? 0;
        const destNow  = { ...dest, balance: dest.balance + promised, shortfall: Math.max(0, dest.shortfall - promised) };
        const want     = this._demand(flow, this.graph.pools.find(p => p.id === flow.to), destNow, ctx, prior[flow.to]);

        if (!gate.open) {
          // Record the non-event, and veto the SOURCE's rebalance sale: a gate that stops the
          // explicit refill but leaves the drift band selling the same sleeve for the same
          // reason has changed nothing (`FINDINGS.md` §6.4's laundering, exactly).
          if (want > 0) {
            gatedFlows.push({ id: flow.id, from: flow.from, to: flow.to, reason: gate.reason, wanted: +want.toFixed(2) });
            vetoed.add(flow.from);
          }
          continue;
        }
        if (!(want > 0)) continue;

        const givable = Math.max(0, (src.available ?? 0) - (outflow[flow.from] ?? 0));
        let amount = Math.min(
          want,
          givable,
          flow.amount.fractionOfSource != null ? src.balance * flow.amount.fractionOfSource : Infinity,
          // Never past the destination's ceiling — the offset's amortising cap is the reason
          // capacity exists at all (§12.1), and pushing cash past it buys nothing.
          Math.max(0, destNow.headroom),
          flow.amount.max ?? Infinity,
        );
        if (!Number.isFinite(amount) || amount <= 0) continue;
        if (flow.amount.min != null && amount < flow.amount.min) continue;

        inflow[flow.to]    = (inflow[flow.to] ?? 0) + amount;
        outflow[flow.from] = (outflow[flow.from] ?? 0) + amount;
        // The firing, recorded for BOTH executors and before the executor split below.
        // `gatedFlows` made the non-event visible; without its counterpart the visible half
        // of the ledger is only the cross-account edges, because those are the only ones that
        // emit an action. An in-portfolio edge is realized as a veto on a rebalance leg and
        // emits nothing per-edge, so a reader counting `POOL_FLOW_APPLY` sees "this edge never
        // fired" for an edge that fired every year its gate was open. Measured on a real plan:
        // an edge with 81 gated evaluations and 4 firings read as 81 and 0.
        fired.push({ id: flow.id, from: flow.from, to: flow.to,
                     amount: +amount.toFixed(2), executor: flow.executor });
        if (flow.executor === FLOW_EXECUTOR.TRANSFER) {
          transfers.push({ type: 'POOL_FLOW_APPLY', flowId: flow.id, from: flow.from, to: flow.to, amountBase: +amount.toFixed(2), year: yearOf });
        } else if (flow.amount.fractionOfSource != null) {
          // An IN-PORTFOLIO edge is executed by the rebalancer, and the two `amount` forms
          // mean different things there:
          //   · `toTarget` — the destination's own target already says how big it should be,
          //     so the edge adds nothing but its GATE. Recording an adjustment too would
          //     fill the pool twice.
          //   · `fractionOfSource` — this is the case the target cannot express ("on a 20 %
          //     drawdown, rotate a quarter of the reserve into equity"), so it is stamped as
          //     a shift in the target mix. It lasts while the gate is open and unwinds when
          //     it closes, which is what a dip-buy is: a temporary overweight.
          adjust[flow.to]   = (adjust[flow.to]   ?? 0) + amount;
          adjust[flow.from] = (adjust[flow.from] ?? 0) - amount;
        }
      }
    }

    // ── the cube ────────────────────────────────────────────────────────────────────
    const liquidityPools = {};
    for (const pool of this.graph.pools) {
      const m = metrics[pool.id];
      const p = prior[pool.id] ?? {};
      const entry = {
        balance:      +m.balance.toFixed(2),
        capacity:     +m.capacity.toFixed(2),
        utilised:     +m.utilised.toFixed(2),
        target:       m.target != null ? +m.target.toFixed(2) : null,
        yearsOfCover: m.yearsOfCover != null ? +m.yearsOfCover.toFixed(3) : null,
        high:         +highs[pool.id].toFixed(2),
        // This period's observation and the year it was taken in — read by a LATER year's
        // gates (see `_priorYearReturns`). Also the only record of what a pool's market was
        // doing in a period: the journal carries the rate table, not the pool's weighted view
        // of it.
        marketReturn:     m.marketReturn != null ? +m.marketReturn.toFixed(6) : null,
        marketReturnYear: yearOf,
        // What the gates ACTED on this period. Persisted rather than re-derived because a
        // second advance in the same year must reach the same conclusion as the first, and
        // because a closed gate is only debuggable next to the number that closed it.
        priorYearReturn:  priorYearReturns[pool.id] != null ? +priorYearReturns[pool.id].toFixed(6) : null,
        inflow:       +(inflow[pool.id] ?? 0).toFixed(2),
        outflow:      +(outflow[pool.id] ?? 0).toFixed(2),
        gatedFlows:   gatedFlows.filter(g => g.to === pool.id || g.from === pool.id),
        // The other half of the ledger, on the same terms as `gatedFlows`: recorded on both
        // endpoints, so a reader looking at one pool sees everything that touched it.
        firedFlows:   fired.filter(f => f.to === pool.id || f.from === pool.id),
        lastFired:    { ...(p.lastFired ?? {}) },
      };
      // Stamped from every firing, not just the transfers. `cadence: ANNUAL` reads this back
      // (`prior[flow.to]?.lastFired?.[flow.id]`), so stamping only the TRANSFER half left an
      // ANNUAL in-portfolio edge free to fire again on the second advance of the same year —
      // re-deciding on an equity reading that only changes annually.
      for (const f of fired) {
        if (f.to === pool.id || f.from === pool.id) entry.lastFired[f.id] = yearOf;
      }
      // The TRAILING spend basis needs a series, and it has to be state: a window that
      // predates the run's start date is not recoverable from the journal.
      if (pool.target?.spendBasis === POOL_SPEND_BASIS.TRAILING
          || pool.capacity?.spendBasis === POOL_SPEND_BASIS.TRAILING) {
        const hist = Array.isArray(p.spendHistory) ? p.spendHistory : [];
        const keep = Math.max(pool.target?.trailingYears ?? 0, pool.capacity?.trailingYears ?? 0, 1);
        entry.spendHistory = [...hist, +ctx.annualSpend.toFixed(2)].slice(-keep);
      }
      liquidityPools[pool.id] = entry;
    }

    return this.newState(state, {
      liquidityPools,
      // What executor 1 reads. `shortfall` is what the rebalancer should still try to fill;
      // `vetoed` is the set of source pools whose sale it must NOT make this period.
      poolRefillPlan: {
        shortfall: Object.fromEntries(this.graph.pools.map(p => [p.id, +(metrics[p.id].shortfall ?? 0).toFixed(2)])),
        vetoed:    [...vetoed],
        gated:     gatedFlows,
        // Per-pool target shifts for executor 1 (in-portfolio `fractionOfSource` edges).
        adjust:    Object.fromEntries(Object.entries(adjust).map(([k, v]) => [k, +v.toFixed(2)])),
      },
    }, transfers);
  }

  toJSON() {
    return { ...super.toJSON(), graph: this.graph, flowsEnabled: this.flowsEnabled,
             baseCurrency: this.baseCurrency, expensesCurrency: this.expensesCurrency };
  }

  static fromJSON(d) {
    const r = new this(d);
    r.id = d.id;
    return r;
  }
}
