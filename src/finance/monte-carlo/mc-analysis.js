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
 * mc-analysis.js — read Monte Carlo results and answer decision questions.
 *
 * Shared by the app (the MC tab) and the lab (`scripts/montecarlo/mc-report.mjs`, which
 * re-exports this through `scripts/lib/mc-analysis.mjs`) — design 100 §2.1. A band or a
 * rescue count quoted from one must match the other, so there is exactly one copy.
 *
 * The functions work on ROWS: `{ seed, failed, oof, <explanatory fields> }`, the shape the
 * lab's arm files carry. The runner returns `runs` in a different shape (`scenarioFailed`,
 * `outOfFundsDate`, a nested `pathShape`); `runsToRows` maps one to the other so the
 * analysis stays single-shaped (design 100 §2.4).
 */

/**
 * Return bands for `failureByBand` on realized net-worth CAGR (design 100 §2.3).
 *
 * The first band is everything below 0%: a path whose net worth SHRANK over the plan is
 * exactly the path a failure table must count, and the lab's old edges started at 0, so
 * those paths fell into no band and dropped out of the table silently.
 */
export const RETURN_BAND_EDGES = Object.freeze([-1, 0, 0.04, 0.05, 0.06, 0.07, 0.08, 0.10, 0.12, 1]);

/**
 * Map the runner's `runs` to analysis rows.
 *
 * `oof` is an ISO date string, as in the arm files: consumers read the year with
 * `oof.slice(0, 4)`, and `String(date)` would put the weekday there instead.
 *
 * @param {Array} runs  `IntlRetirementMcRunner.run()` → `runs`
 */
export function runsToRows(runs) {
  return (runs ?? []).map(r => ({
    seed:         r.seed,
    failed:       !!r.scenarioFailed,
    oof:          r.outOfFundsDate ? new Date(r.outOfFundsDate).toISOString().slice(0, 10) : null,
    nw:           r.finalNetWorthUsd ?? null,
    afterTaxNW:   r.afterTaxNetWorthUsd ?? null,
    netWorthCagr: r.pathShape?.netWorthCagr ?? null,
    worst5yrCagr: r.pathShape?.worst5yrCagr ?? null,
    maxDrawdown:  r.pathShape?.maxDrawdown ?? null,
    troughRealNetLiq: r.pathShape?.troughRealNetLiquidity ?? null,
    repairSpend:  r.lifetimeRepairSpend ?? null,
  }));
}

/**
 * PAIRED comparison of two arms — the decision-relevant readout.
 *
 * Comparing headline failure RATES across arms conflates the lever's effect with
 * sampling noise. Because arms share the seed sequence, seed s is the same world in
 * both, so you can ask the sharper question directly: in how many individual worlds
 * does the change turn a failure into a success?
 *
 * `reverseRescues` is the number it made WORSE, and it matters more than its size
 * suggests. A lever with a good average effect that reverse-rescues a nonzero count
 * has state-dependent harm — a real risk to explain, not noise to average away. A
 * clean zero is strong evidence the lever weakly dominates.
 *
 * @param {Array} aRows  baseline arm rows
 * @param {Array} bRows  changed arm rows
 */
export function pairedRescues(aRows, bRows) {
  const byB = new Map(bRows.map(r => [r.seed, r]));
  let both = 0, onlyA = 0, onlyB = 0, neither = 0, unpaired = 0;

  for (const ra of aRows) {
    const rb = byB.get(ra.seed);
    if (!rb) { unpaired++; continue; }
    if (ra.failed && rb.failed) both++;
    else if (ra.failed) onlyA++;        // A fails, B survives ⇒ the change RESCUED this world
    else if (rb.failed) onlyB++;        // B fails, A survived ⇒ REVERSE rescue
    else neither++;
  }

  const n = both + onlyA + onlyB + neither;
  return {
    n, unpaired, both, neither,
    rescues: onlyA, reverseRescues: onlyB,
    rescueRate: n ? onlyA / n : 0,
    reverseRate: n ? onlyB / n : 0,
  };
}

/**
 * PAIRED comparison of two arms on a MONEY metric — the sibling of `pairedRescues`
 * for decisions that are not about ruin (design 84 §6.4b).
 *
 * `pairedRescues` classifies each seed by the `failed` flag, which is exactly right
 * for "will this plan survive" and useless for "which wrapper should this money sit
 * in". A decant-vs-hold contrast runs on plans that mostly do not fail at all, so the
 * rescue counts come back near-empty and the reverse count says nothing. The sharp
 * question there is the same shape, asked of wealth: in how many individual worlds is
 * the treatment ahead, and — the one that matters — in how many is it BEHIND?
 *
 * Same pairing discipline as its sibling and as `paired-delta.mjs` on the grid side:
 * arms share the seed sequence, so seed s is the same world in both, and the reported
 * quantity is `treatment − control` WITHIN a world. Anything that moves both halves
 * equally cancels. That is what makes a 4%-effect visible inside a scenario where
 * sliding one date moves terminal wealth by tens of percent.
 *
 * **Never quote the mean of terminal wealth.** It is dominated by the right tail —
 * a handful of lucky paths — and it answers a question nobody asked. `winRate` and
 * `losses` are the readout; the percentiles are there to show the spread of the
 * DIFFERENCE, which is a different and more honest object than the spread of levels.
 *
 * @param {Array}  aRows   control arm rows
 * @param {Array}  bRows   treatment arm rows
 * @param {string} [metric='afterTaxNW']  row field to difference
 * @param {number} [tolerance=0]          |delta| at or below this counts as a tie
 */
export function pairedMetric(aRows, bRows, metric = 'afterTaxNW', tolerance = 0) {
  const byB = new Map(bRows.map(r => [r.seed, r]));
  const deltas = [];
  const relDeltas = [];
  let wins = 0, losses = 0, ties = 0, unpaired = 0, missing = 0;

  for (const ra of aRows) {
    const rb = byB.get(ra.seed);
    if (!rb) { unpaired++; continue; }
    const a = ra[metric], b = rb[metric];
    if (!Number.isFinite(a) || !Number.isFinite(b)) { missing++; continue; }
    const d = b - a;
    deltas.push(d);
    if (a !== 0) relDeltas.push(d / Math.abs(a));
    if (Math.abs(d) <= tolerance) ties++;
    else if (d > 0) wins++;
    else losses++;
  }

  const n = deltas.length;
  const sorted = [...deltas].sort((x, y) => x - y);
  const at = (q) => (n ? sorted[Math.min(n - 1, Math.max(0, Math.floor(q * n)))] : null);
  const relSorted = [...relDeltas].sort((x, y) => x - y);
  const relAt = (q) => (relSorted.length
    ? relSorted[Math.min(relSorted.length - 1, Math.max(0, Math.floor(q * relSorted.length)))]
    : null);

  return {
    metric, n, unpaired, missing,
    wins, losses, ties,
    winRate:  n ? wins / n : 0,
    lossRate: n ? losses / n : 0,
    // Percentiles of the paired DIFFERENCE, not of either arm's level.
    p10: at(0.10), p50: at(0.50), p90: at(0.90),
    worst: n ? sorted[0] : null,
    best:  n ? sorted[n - 1] : null,
    medianRel: relAt(0.50),
  };
}

/**
 * Why two batches are NOT paired, as a list of reasons — empty when they are.
 *
 * `pairedRescues` and `pairedMetric` match rows by seed and trust that seed s is the same
 * world in both arms. In the lab that holds by discipline (same flags, same n). In the app
 * the two batches are separated by arbitrary edits, so it is checked instead (design 100
 * §6): a paired count across two different random streams describes noise, and nothing in
 * the counts themselves would show it.
 *
 * Takes the runner's `summary.pairing` records:
 *   `{ n, seeds, sampled: [{ key, draws }], mcSequenceRisk }`.
 * `sampled` is compared in ORDER and by draw count, not as a key set — every variable
 * draws from one shared stream, so a reordering or a variable that now takes a different
 * number of random numbers (a zero spread, a type change) shifts every draw after it.
 *
 * @param {object|null} a  baseline pairing record
 * @param {object|null} b  this run's pairing record
 * @returns {string[]}
 */
export function pairingMismatches(a, b) {
  if (!a || !b) {
    return [`${a ? 'this run' : 'the baseline'} has no pairing record (a result from before pairing was recorded)`];
  }
  const out = [];
  if (a.n !== b.n) out.push(`path count ${a.n} vs ${b.n}`);
  else if (a.seeds?.length !== b.seeds?.length || a.seeds.some((s, i) => s !== b.seeds[i])) out.push('seed lists differ');

  if (a.mcSequenceRisk !== b.mcSequenceRisk) {
    const on = (x) => (x ? 'on' : 'off');
    out.push(`sequence risk ${on(a.mcSequenceRisk)} vs ${on(b.mcSequenceRisk)}`);
  }

  const aKeys = (a.sampled ?? []).map(s => s.key);
  const bKeys = (b.sampled ?? []).map(s => s.key);
  const onlyA = aKeys.filter(k => !bKeys.includes(k));
  const onlyB = bKeys.filter(k => !aKeys.includes(k));
  if (onlyA.length || onlyB.length) {
    const parts = [];
    if (onlyA.length) parts.push(`only in the baseline: ${onlyA.join(', ')}`);
    if (onlyB.length) parts.push(`only in this run: ${onlyB.join(', ')}`);
    out.push(`sampled variables differ (${parts.join('; ')})`);
  } else if (aKeys.some((k, i) => k !== bKeys[i])) {
    out.push('sampled variables are drawn in a different order');
  } else {
    for (let i = 0; i < aKeys.length; i++) {
      const da = a.sampled[i].draws, db = b.sampled[i].draws;
      if (da !== db) {
        out.push(`${aKeys[i]} takes ${da} random number(s) vs ${db} (a zero spread or a distribution change), `
          + 'so every variable after it draws differently');
      }
    }
  }
  return out;
}

/** Failure rate of an arm. */
export const failureRate = (rows) => (rows.length ? rows.filter(r => r.failed).length / rows.length : null);

/**
 * Failure rate bucketed by a continuous explanatory variable.
 *
 * This is what turns "12% of paths fail" into "it fails below ~6% returns and
 * essentially never above 8%" — a threshold you can hold an opinion about, rather
 * than a probability you can only accept.
 *
 * @param {Array}    rows
 * @param {string}   key    row field to bucket on (e.g. 'growth', 'netWorthCagr')
 * @param {number[]} edges  bucket boundaries, ascending
 */
export function failureByBand(rows, key, edges) {
  const bands = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i], hi = edges[i + 1];
    const inBand = rows.filter(r => typeof r[key] === 'number' && r[key] >= lo && r[key] < hi);
    bands.push({
      lo, hi, n: inBand.length,
      rate: inBand.length ? inBand.filter(r => r.failed).length / inBand.length : null,
    });
  }
  return bands;
}

/**
 * Contrast failed vs surviving paths on each explanatory field.
 *
 * Answers "what distinguishes a failure" — whether failures are driven by a poor
 * long-run mean (`growth`), by bad ORDERING at an acceptable mean (`worst5yrCagr`,
 * `maxDrawdown`), or by a lumpy cost (`repairSpend`). Those imply different
 * remedies, and the headline failure rate cannot tell them apart.
 */
export function failureDrivers(rows, keys) {
  const failed = rows.filter(r => r.failed);
  const survived = rows.filter(r => !r.failed);
  const avg = (rs, k) => {
    const v = rs.map(r => r[k]).filter(x => typeof x === 'number');
    return v.length ? v.reduce((t, x) => t + x, 0) / v.length : null;
  };
  return {
    nFailed: failed.length,
    nSurvived: survived.length,
    fields: keys.map(k => ({ key: k, failed: avg(failed, k), survived: avg(survived, k) })),
    oofYears: failed.map(r => Number(r.oof?.slice(0, 4))).filter(Boolean).sort((a, b) => a - b),
  };
}
