/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * arms.mjs — design 97 §20.7, the four arms.
 *
 * The policy under test, stated as the author states it: *use the offset for spending while
 * the market is down, and top it back up by selling equities after the market has recovered.*
 *
 * §20.5's equivalence is what makes that expressible with no new engine code:
 *
 *   spend the offset FIRST, and refill it from equity under a market gate
 *     ≡ up year   — spend offset, refill from equity  ⇒ net identical to selling equity
 *       down year — spend offset, refill gate SHUT    ⇒ the offset carries the year
 *
 * A conditional draw ORDER and an unconditional draw order with a conditional REFILL are the
 * same policy, and only the second is sayable in the graph as it stands.
 *
 * ─── why four arms and not two ───────────────────────────────────────────────────────
 *
 * §19.6's third rule, learned the hard way: the veto's verdict was mis-attributed for three
 * rounds because the grid held no arm that changed the mechanism alone. So:
 *
 *   A  control    — spend equity. The offset is owned but never claimed by a pool, so §3.1
 *                   rule 3 leaves it after every pool and spending never reaches it.
 *   B  mechanism  — offset first, refill UNGATED. By the equivalence this must land on A.
 *                   If it does not, the difference is plumbing and C means nothing. B is the
 *                   arm the study lives or dies on and it is not optional.
 *   C  the theory — B plus `gate.sourceReturnOver: 0`: refill only after an up year.
 *   D  bound      — B's pools with no refill at all. The pure deferral, and the ceiling on
 *                   how much the policy could ever be worth before the refill claws back.
 *
 * Every arm owns the SAME balance sheet — same equity, same loan, same offset. Only the
 * graph differs. An arm set where one arm is richer at t0 measures the head start
 * (`offset-arms-not-wealth-matched`, which cost design 86 a whole study).
 */

import { GROWTH, OFFSET, DEFAULTS } from './scenario.mjs';

/** The growth pool: the taxable equity book, and the last stop in every arm's spend order. */
const growthPool = (order) => ({
  id: 'growth', label: 'growth — taxable equity',
  claims: [{ key: GROWTH, sleeves: ['EQUITY'] }],
  spendOrder: order,
});

/**
 * The offset pool.
 *
 * `capacity: OFFSET_CAP` is `min(balance, linked loan)` (§12.1) — the honest ceiling, and the
 * reason a refill cannot push cash past the debt it is suppressing. `target: AMOUNT` is the
 * full facility: the policy is "keep the backstop full", and a YEARS_OF_SPEND target would
 * make the facility's size a function of the spending line, which is a different lever.
 */
const offsetPool = (facility) => ({
  id: 'offset', label: 'the offset facility',
  claims: [{ key: OFFSET }],
  spendOrder: 1,
  target:   { mode: 'AMOUNT', value: facility },
  capacity: { mode: 'OFFSET_CAP' },
});

/**
 * The refill edge: sell equity, put the proceeds in the offset.
 *
 * Cross-account, so `PoolFlowApplyReducer` executes it through `replenishSavings` — the FIFO
 * consume, the disposal, the realized gain and the tax all fire exactly as they do for a
 * spending draw (§12.4). A refill that moved money without going through that seam would be
 * the fourth instance of a bug this repo has already found three times.
 *
 * `cadence: ANNUAL` because the signal is annual: the equity tick runs once a year, so an
 * edge allowed to fire on every advance would be re-deciding on an unchanged reading.
 */
const refillFlow = (gate) => ({
  id: 'g2o', from: 'growth', to: 'offset',
  amount: { toTarget: true }, cadence: 'ANNUAL',
  ...(gate ? { gate } : {}),
});

/**
 * Arms E and F — design 97 §20.13. The gate the STUDY used is `sourceReturnOver`, a reading of
 * the last completed year's return. `sourceDrawdownUnder` is the other market gate the graph
 * has always had, and it says something materially different: *refill only while the growth
 * pool is within x of its own trailing high* — a level, not a rate of change.
 *
 * §12.3 argues against it in a decumulation plan ("cannot tell a falling market from a pool
 * being spent down, and latches shut after the first crash"), and that argument is why arm C
 * uses the return gate. It is an argument, not a measurement, and the first hand-authored run
 * that tried it beat C — so it gets an arm rather than a footnote. Two thresholds, because
 * the whole question is whether the latch §12.3 predicts actually bites: at 1 % the pool must
 * be at a fresh peak, at 5 % it need only be near one.
 *
 * @param {number} [facility]  the offset/loan size — DEFAULTS.facility unless an arm sweeps it
 * @returns {Array<{key,label,graph,note}>}
 */
export function arms(facility = DEFAULTS.facility) {
  return [
    {
      key: 'A', label: 'control — spend equity, offset untouched',
      note: 'the offset is owned but claimed by no pool, so the spend walk never reaches it',
      graph: { pools: [growthPool(1)], flows: [] },
    },
    {
      key: 'B', label: 'mechanism — offset first, refill UNGATED',
      note: 'must land on A; if it does not, C measures plumbing',
      graph: { pools: [offsetPool(facility), growthPool(2)], flows: [refillFlow(null)] },
    },
    {
      key: 'C', label: 'the theory — offset first, refill only AFTER an up year',
      note: 'gate.sourceReturnOver: 0 on the last COMPLETED year (design 97 §20.2)',
      graph: { pools: [offsetPool(facility), growthPool(2)], flows: [refillFlow({ sourceReturnOver: 0 })] },
    },
    {
      key: 'D', label: 'bound — offset first, never refilled',
      note: 'the pure deferral: the ceiling on what the policy could be worth',
      graph: { pools: [offsetPool(facility), growthPool(2)], flows: [] },
    },
    {
      key: 'E', label: 'trailing high — refill only within 1% of the growth pool\'s peak',
      note: 'gate.sourceDrawdownUnder: 0.01 — a LEVEL gate, the §12.3 latch is the thing under test',
      graph: { pools: [offsetPool(facility), growthPool(2)],
               flows: [refillFlow({ sourceDrawdownUnder: 0.01 })] },
    },
    {
      key: 'F', label: 'trailing high — refill only within 5% of the growth pool\'s peak',
      note: 'gate.sourceDrawdownUnder: 0.05 — the softer band; E and F bracket the latch',
      graph: { pools: [offsetPool(facility), growthPool(2)],
               flows: [refillFlow({ sourceDrawdownUnder: 0.05 })] },
    },
    {
      key: 'G', label: 'trailing high — refill only within 10% of the growth pool\'s peak',
      note: 'gate.sourceDrawdownUnder: 0.10 — the hand-authored arm; wide enough that the latch releases',
      graph: { pools: [offsetPool(facility), growthPool(2)],
               flows: [refillFlow({ sourceDrawdownUnder: 0.10 })] },
    },
    // ── the flow-neutral basis (design 97 §20.14) ──────────────────────────────────
    // H/I/J are E/F/G with one field changed. The trailing high in E–G is a peak BALANCE, so
    // spending the pool down reads as drawdown and the gate stays shut for reasons that have
    // nothing to do with the market — which LENGTHENS the deferral, and a longer deferral is
    // a longer levered position. E–G may therefore be measuring leverage that the gate's name
    // does not admit to. INDEX puts the same threshold on a series no withdrawal can move, so
    // H−E is exactly "what was the contamination worth", and it is a number rather than an
    // argument. Paired against E/F/G, never read alone.
    {
      key: 'H', label: 'flow-neutral 1% — the return index, not the balance',
      note: 'E with drawdownBasis: INDEX; H−E prices the spend-down contamination',
      graph: { pools: [offsetPool(facility), growthPool(2)],
               flows: [refillFlow({ sourceDrawdownUnder: 0.01, drawdownBasis: 'INDEX' })] },
    },
    {
      key: 'I', label: 'flow-neutral 5% — the return index, not the balance',
      note: 'F with drawdownBasis: INDEX',
      graph: { pools: [offsetPool(facility), growthPool(2)],
               flows: [refillFlow({ sourceDrawdownUnder: 0.05, drawdownBasis: 'INDEX' })] },
    },
    {
      key: 'J', label: 'flow-neutral 10% — the return index, not the balance',
      note: 'G with drawdownBasis: INDEX — the hand-authored arm, decontaminated',
      graph: { pools: [offsetPool(facility), growthPool(2)],
               flows: [refillFlow({ sourceDrawdownUnder: 0.10, drawdownBasis: 'INDEX' })] },
    },
    // ── the DWELL sweep (design 97 §20.16) ────────────────────────────────────────
    // Every arm above produces a deferral DURATION as a side effect of a threshold, and
    // §20.13 measured duration as the lever the threshold is not: 1/5/10 % landed within
    // \$13k of each other while C-vs-E-vs-D — the same family differing only in how long the
    // gate stays shut — spread by \$460k. `sustainedYears` (§20.15) is the first control that
    // states duration directly, so this is the first arm set that moves the lever and nothing
    // else: J's gate, n = 2…5, paired against J itself (n = 1).
    //
    // The expected shape, worth writing down before reading the numbers: J is one end and D
    // (never refill) is the other, so if duration is genuinely the lever the sweep should walk
    // from J toward D — a rising median with a widening left tail and more broken worlds —
    // and turn over somewhere in between. A flat sweep says duration was a proxy for something
    // else and §20.13's reading of it is wrong.
    ...[2, 3, 4, 5].map((years, i) => ({
      key: 'KLMN'[i],
      label: `flow-neutral 10% held for ${years} years — the dwell sweep`,
      note: `J plus sustainedYears: ${years}; paired against J, which is the same gate at n = 1`,
      graph: { pools: [offsetPool(facility), growthPool(2)],
               flows: [refillFlow({ sourceDrawdownUnder: 0.10, drawdownBasis: 'INDEX',
                                    sustainedYears: years })] },
    })),
  ];
}

/**
 * The two return processes the whole question turns on (design 97 §20.1) — and the labels
 * are the MEASURED behaviour, not the enum's name.
 *
 * "Sell after the recovery" is a bet on the lag-1 autocorrelation of annual returns being
 * NEGATIVE. `probe-return-autocorrelation.mjs` measures what the engine actually produces:
 * WHITE_NOISE is ρ ≈ 0, and MEAN_REVERTING is ρ ≈ +e^(−k) — the OU step is applied to the
 * deviation of a RETURN rather than of a level, so what the enum calls mean reversion is
 * momentum. Neither is the world the theory needs, and that is a finding rather than a
 * limitation of the arm set (design 97 §20.9).
 */
export const PROCESSES = Object.freeze([
  { key: 'WHITE_NOISE',    label: 'IID, ρ≈0 — a down year says nothing about the next',
    params: { equityReturnModel: 'WHITE_NOISE' } },
  { key: 'MEAN_REVERTING', label: 'OU on the return, ρ≈+0.61 — a down year predicts ANOTHER down year',
    params: { equityReturnModel: 'MEAN_REVERTING', equityReturnReversionSpeed: 0.5 } },
]);
