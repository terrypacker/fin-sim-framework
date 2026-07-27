/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { buildAllocationCube } from './allocation-cube.js';
import { buildTargetCube }     from './target-cube.js';
import { computeNetWorth, computeNetWorthInclSpeculative }
  from '../derived-metrics/net-worth.js';

/**
 * allocation-sampler.js — the one record an allocation consumer collects per sample.
 *
 * Design 82 §4 commits the lab page, the workbench plugin and Monte Carlo to the same
 * sample INSTANT (`samplerCadence: 'year-boundary'`). This module commits them to the
 * same sample CONTENTS, for the same reason: if the page and the panel captured
 * different fields — or computed the tie-out against a differently-timed net worth —
 * they could disagree about a share with nothing to arbitrate between them.
 *
 * The record is plain data and retains NOTHING from `state`: cube rows are freshly
 * built objects of numbers and strings. That is a hard requirement of the sampler
 * contract (design 78 §4.5) — the sampler is handed LIVE state, so a retained
 * reference would silently alias a mutating object.
 *
 * ─── the tie-out travels WITH the sample ─────────────────────────────────────
 *
 * `cubeTotal` and `netWorth` are captured here, at the instant the rows are built,
 * because a tie-out computed later against a net worth read at a different instant is
 * not a check of anything. Design 82 §3's invariant is the whole reason any share on
 * any chart can be quoted, so it is measured at every sample rather than asserted once.
 *
 * Since design 88 there are TWO invariants, and both travel with the sample:
 *
 *     cubeTotal                  === netWorthInclSpeculative   (disclosure)
 *     cubeTotal − speculative    === netWorth                  (recognition)
 *
 * A single tie-out would have reported "does not tie out" on any plan holding a
 * speculative asset — a false alarm on the loudest warning this panel has, which is
 * the fastest way to teach a reader to ignore it. Checking both instead says something
 * strictly stronger: the cube and the metrics agree on the total AND on which rows are
 * recognised (design 88 §6).
 */

/**
 * Build the `(state, date) => record` sampler to hand to `buildSim({ sampler })`.
 *
 * @param {object} [opts]
 * @param {string} [opts.baseCurrency='USD'] - currency every figure is expressed in
 * @param {(stateKey: string) => string|null} [opts.displayNameFor]
 *        - human account labels (StateSchemaRegistry#displayNameFor). Injected, not
 *          imported, so a node script with no registry booted can still sample.
 * @param {object} [opts.cubeOpts]           - forwarded to buildAllocationCube
 * @returns {(state: object, date: Date) => object}
 */
export function createAllocationSampler({
  baseCurrency = 'USD', displayNameFor = null, cubeOpts = null,
} = {}) {
  return function sampleAllocation(state, date) {
    const at   = new Date(date);
    const rows = buildAllocationCube(state, {
      ...(cubeOpts ?? {}),
      date: at,
      baseCurrency,
      displayNameFor,
    });

    // The INTENDED mix at the same instant (design 82 §7). Sampled here rather than
    // derived later because `targetComposition` is state — it is gone by the time anyone
    // looks at a cube. Empty when no rebalancer is active, which the view reports as
    // "no target" rather than as zero drift.
    const targetRows = buildTargetCube(state, { date: at, baseCurrency, displayNameFor });

    const cubeTotal   = rows.reduce((sum, r) => sum + r.marketValue, 0);
    const speculative = rows.reduce(
      (sum, r) => sum + (r.speculative === true ? r.marketValue : 0), 0);
    const netWorth    = computeNetWorth(state, baseCurrency);
    const netWorthInclSpeculative = computeNetWorthInclSpeculative(state, baseCurrency);

    return {
      at,
      year:       at.getUTCFullYear(),
      rows,
      targetRows,
      cubeTotal,
      netWorth,
      netWorthInclSpeculative,
      // The disclosed amount, so a view can state what it left out of every share
      // rather than leaving the reader to infer it from a total that does not add up.
      speculative: +speculative.toFixed(2),
      // Disclosure invariant: every row, against the figure that recognises every row.
      delta:      +(cubeTotal - netWorthInclSpeculative).toFixed(2),
      // Recognition invariant: the rows that count, against the figure that counts them.
      deltaRecognised: +((cubeTotal - speculative) - netWorth).toFixed(2),
      inferred:   rows.filter(r => r.inferred).length,
      reconciled: rows.filter(r => r.source === 'reconciliation')
                      .reduce((sum, r) => sum + Math.abs(r.marketValue), 0),
    };
  };
}

/**
 * Reduce a set of samples to the provenance a view must state BEFORE it draws
 * (design 82 §3): does the cube tie to net worth, and how much of the picture is
 * being assumed rather than read.
 *
 * `offBoundary` names any sample that is not a 31 December year boundary — i.e. the
 * terminal flush when a run's horizon falls mid-year. Such a sample covers a partial
 * year and sits on the far side of the 1 January period-advance cascade (§5.2), so the
 * step into it is not the year-over-year move every other step on the chart is. It is
 * kept, because the end of the plan is the most-quoted point there is — but it has to
 * be labelled, not silently drawn.
 *
 * @param {object[]} samples - records from the sampler above
 * @returns {{count, ties, worst, inferredAny, reconciledAny, offBoundary, first, last}}
 */
export function summarizeSamples(samples) {
  const list = Array.isArray(samples) ? samples.filter(s => s && s.at) : [];
  if (list.length === 0) {
    return {
      count: 0, ties: true, worst: null, inferredAny: false, reconciledAny: false,
      speculative: 0, offBoundary: [], first: null, last: null,
    };
  }

  // Worst across BOTH invariants (design 88 §6): a sample that ties on the total but
  // disagrees about which rows are recognised is still a broken denominator, and
  // reporting only the larger of the two would hide whichever one is failing.
  const _gap  = s => Math.max(Math.abs(s.delta ?? 0), Math.abs(s.deltaRecognised ?? 0));
  const worst = list.reduce((w, s) => (_gap(s) > _gap(w) ? s : w), list[0]);
  return {
    count:         list.length,
    ties:          _gap(worst) < 1,
    worst,
    /** Disclosed-but-unrecognised value at the latest sample (design 88 §6). */
    speculative:   list[list.length - 1]?.speculative ?? 0,
    inferredAny:   list.some(s => s.inferred > 0),
    reconciledAny: list.some(s => s.reconciled > 0.5),
    offBoundary:   list.filter(s => s.at.getUTCMonth() !== 11 || s.at.getUTCDate() !== 31),
    first:         list[0],
    last:          list[list.length - 1],
  };
}

/**
 * Index of the last 31 December in `dates`, falling back to the last date.
 *
 * This exists because of a trap in the target overlay (design 82 §7). The rebalance fires
 * on the **1 January** period advance, so the terminal sample of a run whose horizon is
 * 1 January is taken *immediately after* a rebalance — and reads drift of exactly 0.0%
 * for every class. Quoting that instant would tell the reader the book is perfectly on
 * policy at precisely the one moment it is guaranteed to be. Every 31 December sample, by
 * contrast, is read just BEFORE the correction, so it shows how far the band actually let
 * the book move over that year — which is the number worth reporting.
 *
 * @param {Date[]} dates
 * @returns {number} index, or -1 when there are no dates
 */
export function lastYearEndIndex(dates) {
  if (!Array.isArray(dates) || dates.length === 0) return -1;
  for (let i = dates.length - 1; i >= 0; i--) {
    const d = dates[i];
    if (d && d.getUTCMonth() === 11 && d.getUTCDate() === 31) return i;
  }
  return dates.length - 1;
}

/** Every sample's rows, concatenated — the fact table a pivot runs over. */
export function samplesToRows(samples) {
  const rows = [];
  for (const sample of samples ?? []) {
    if (Array.isArray(sample?.rows)) rows.push(...sample.rows);
  }
  return rows;
}

/** The same, for the target table (design 82 §7). Empty when nothing sets a target. */
export function samplesToTargetRows(samples) {
  const rows = [];
  for (const sample of samples ?? []) {
    if (Array.isArray(sample?.targetRows)) rows.push(...sample.targetRows);
  }
  return rows;
}
