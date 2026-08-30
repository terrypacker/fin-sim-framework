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
