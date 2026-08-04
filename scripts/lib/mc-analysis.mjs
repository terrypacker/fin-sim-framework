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
 * mc-analysis.mjs — read Monte Carlo arm outputs and answer decision questions.
 *
 * Kept separate from ./mc.mjs so analysis can be re-run and rewritten without
 * re-running the arms: an arm is minutes of compute, a report is milliseconds, and
 * the report is what you iterate on.
 */

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
