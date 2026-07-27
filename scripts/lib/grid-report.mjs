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
 * grid-report.mjs — turn a `{spec, results}` grid run into a RENDER-AGNOSTIC model.
 *
 * `variant-grid.mjs` used to own this logic inline, which was fine while the only
 * consumer was its own fixed-width table. It is not fine with two consumers: the
 * terminal report and the HTML study report would each have their own idea of what
 * "the frontier of this cell" means, and the first time one of them changed you
 * would have two documents quoting different numbers from the same raw results with
 * no way to tell which was right. This module is the single answer; both renderers
 * are dumb about the reduction and only decide how to draw it.
 *
 * The model deliberately carries `value` (numeric) ALONGSIDE `text` (display). A
 * heatmap needs to rank cells, and re-parsing "$10.5k" back into a number at render
 * time is how a report ends up ordering $9k above $10.5k.
 */

/**
 * Cell id: axis indices joined. Indices rather than labels so a label containing the
 * separator, or two axis values that stringify alike (0.1 vs "0.1"), cannot collide
 * into one cell.
 *
 * Exported because the RUNNER stamps these ids and the reader looks them up. Two
 * copies of this one-liner is a silent-empty-report bug waiting to happen: change the
 * separator on one side and every cell renders "?" with no error anywhere.
 */
export const makeIdOf = (axisNames) => (idx) => axisNames.map(n => `${n}=${idx[n]}`).join('|');

/** Display label for value j of an axis; falls back to the raw value. */
export const makeLabelOf = (spec) => (name, j) => {
  const ax = spec.axes[name];
  return String(ax.labels?.[j] ?? ax.values[j]);
};

/**
 * @param {object} o
 * @param {object} o.spec     the grid spec (axes, report, title, notes)
 * @param {Array}  o.results  `[{id, failed, oofDate, netWorth, netLiq, error}]` from the run
 * @returns {object} see below
 */
/**
 * Money-valued row fields a spec may name as `report.metric`. `afterTaxNW` is the
 * right one for any question about WHERE wealth sits — a wrapper swap, a conversion,
 * a decant — because nominal `netWorth` prices a pre-tax dollar at par with a Roth
 * dollar (design/40) and ranks those decisions on a scoreboard that cannot see them.
 */
const MONEY_METRICS = new Set(['netWorth', 'netLiq', 'afterTaxNW', 'taxPaid', 'deficit']);

export function buildGridModel({ spec, results }) {
  const axisNames = Object.keys(spec.axes ?? {});
  if (!axisNames.length) throw new Error('grid spec has no axes');

  const labelOf = makeLabelOf(spec);
  const idOf = makeIdOf(axisNames);
  const byId = new Map(results.map(r => [r.id, r]));

  const rep = spec.report ?? {};
  const rowAxis = rep.rows ?? axisNames[0];
  const colAxis = rep.cols ?? axisNames[1] ?? null;
  const reduceAxis = rep.reduce?.axis ?? null;
  const panelAxes = (rep.panels ?? []).length
    ? rep.panels
    : axisNames.filter(n => n !== rowAxis && n !== colAxis && n !== reduceAxis);

  for (const name of [rowAxis, colAxis, reduceAxis, ...panelAxes]) {
    if (name && !axisNames.includes(name)) throw new Error(`report references unknown axis "${name}"`);
  }

  /**
   * Scan the reduce axis at fixed other-axis indices and report the frontier.
   *
   * `flips` counts pass→fail transitions: more than one means the frontier is not a
   * single boundary, and the "last passing" value has a FAILING region below it. That
   * is a real property of these scenarios (tax-year, residency and age-gate
   * interactions), not a bug, which is why it is surfaced rather than smoothed.
   */
  function reduceCell(fixed) {
    const ax = spec.axes[reduceAxis];
    let lastPassing = -1, flips = 0, prev = null, missing = false;
    for (let j = 0; j < ax.values.length; j++) {
      const r = byId.get(idOf({ ...fixed, [reduceAxis]: j }));
      if (!r || r.error) { missing = true; continue; }
      if (!r.failed) lastPassing = j;
      if (prev !== null && r.failed !== prev) flips++;
      prev = r.failed;
    }
    if (missing && lastPassing < 0) return { text: '?', value: null, flips, missing: true };
    if (lastPassing < 0) {
      return { text: `<${labelOf(reduceAxis, 0)}`, value: null, flips, offGridLow: true };
    }
    const atEnd = lastPassing === ax.values.length - 1;
    return {
      text: labelOf(reduceAxis, lastPassing) + (atEnd ? '+' : ''),
      value: typeof ax.values[lastPassing] === 'number' ? ax.values[lastPassing] : null,
      flips, offGridHigh: atEnd,
    };
  }

  /** Direct cell metric when there is no reduce axis. */
  function directCell(fixed) {
    const r = byId.get(idOf(fixed));
    if (!r || r.error) return { text: '?', value: null, missing: true };
    if (rep.metric != null) {
      // Allowlisted rather than free field access: a typo would otherwise fall through
      // to pass/fail and render a perfectly plausible table of the wrong measurement.
      if (!MONEY_METRICS.has(rep.metric)) {
        throw new Error(`grid report: unknown metric "${rep.metric}" `
          + `(have: ${[...MONEY_METRICS].join(', ')}, or omit for pass/fail)`);
      }
      return { text: fmtMoney(r[rep.metric]), value: r[rep.metric] ?? null };
    }
    return {
      text: r.failed ? `FAIL ${r.oofDate?.slice(0, 4) ?? ''}`.trim() : 'ok',
      value: r.failed ? 0 : 1, failed: r.failed,
    };
  }

  const cellAt = (fixed) => (reduceAxis ? reduceCell(fixed) : directCell(fixed));

  // ─── panels ────────────────────────────────────────────────────────────────
  let panelCombos = [{}];
  for (const name of panelAxes) {
    const next = [];
    for (const c of panelCombos) spec.axes[name].values.forEach((_, j) => next.push({ ...c, [name]: j }));
    panelCombos = next;
  }

  const warnings = [];
  const panels = panelCombos.map(panel => {
    const label = panelAxes.map(n => `${n} ${labelOf(n, panel[n])}`).join(', ');
    const rows = spec.axes[rowAxis].values.map((_, j) => labelOf(rowAxis, j));
    const cols = colAxis ? spec.axes[colAxis].values.map((_, j) => labelOf(colAxis, j)) : ['value'];

    const cells = rows.map((rowLabel, ri) => cols.map((colLabel, ci) => {
      const fixed = { ...panel, [rowAxis]: ri };
      if (colAxis) fixed[colAxis] = ci;
      const c = cellAt(fixed);
      if (c.flips > 1) {
        warnings.push(`${label ? label + ' / ' : ''}${rowAxis} ${rowLabel}`
          + `${colAxis ? ` / ${colAxis} ${colLabel}` : ''}: ${c.flips} pass↔fail flips along ${reduceAxis}`);
      }
      return c;
    }));

    return {
      label,
      dims: panelAxes.map(n => ({ axis: n, label: labelOf(n, panel[n]) })),
      rows, cols, cells,
    };
  });

  const values = panels.flatMap(p => p.cells.flat().map(c => c.value)).filter(v => v != null);

  return {
    title: spec.title ?? null,
    notes: spec.notes ?? null,
    axisNames, rowAxis, colAxis, reduceAxis, panelAxes,
    metric: reduceAxis ? `frontier along ${reduceAxis}` : (rep.metric ?? 'pass/fail'),
    panels,
    warnings: [...new Set(warnings)],
    errors: results.filter(r => r.error).length,
    firstError: results.find(r => r.error)?.error ?? null,
    total: results.length,
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    offGridLow:  panels.some(p => p.cells.flat().some(c => c.offGridLow)),
    offGridHigh: panels.some(p => p.cells.flat().some(c => c.offGridHigh)),
    labelOf, idOf, byId, cellAt,
    leverValues: leverValues({ spec, axisNames, reduceAxis, labelOf, idOf, byId, cellAt }),
  };
}

/**
 * Marginal value of each axis, in units of the reduce axis.
 *
 * For every axis except the reduce axis, hold nothing fixed: take the MEDIAN frontier
 * across all cells at each level of that axis, and report the spread between the best
 * and worst level. That is a marginal effect, and marginalising rather than reading
 * one slice is the point — a single row can put an axis's whole apparent value on an
 * interaction with whatever the other axes happened to be pinned to.
 *
 * It is only a headline. A large spread says "this axis moves the answer", not "this
 * axis moves the answer independently of the others"; the panels are where you check
 * whether the ordering within an axis is stable. Axes whose levels are not numeric on
 * the reduce scale (or grids with no reduce axis) return nothing.
 */
function leverValues({ spec, axisNames, reduceAxis, labelOf, idOf, byId, cellAt }) {
  if (!reduceAxis) return [];
  const swept = axisNames.filter(n => n !== reduceAxis);
  if (!swept.length) return [];

  // Every combination of the swept axes' indices.
  let combos = [{}];
  for (const name of swept) {
    const next = [];
    for (const c of combos) spec.axes[name].values.forEach((_, j) => next.push({ ...c, [name]: j }));
    combos = next;
  }
  const frontier = new Map(combos.map(c => [idOf({ ...c, [reduceAxis]: 0 }), cellAt(c).value]));
  const valueOf = (c) => frontier.get(idOf({ ...c, [reduceAxis]: 0 }));

  const out = [];
  for (const name of swept) {
    const levels = spec.axes[name].values.map((_, j) => {
      const vals = combos.filter(c => c[name] === j).map(valueOf).filter(v => v != null);
      return { label: labelOf(name, j), median: median(vals), n: vals.length };
    });
    const withData = levels.filter(l => l.median != null);
    if (withData.length < 2) continue;
    const meds = withData.map(l => l.median);
    const hi = Math.max(...meds), lo = Math.min(...meds);
    out.push({
      axis: name, levels, spread: hi - lo,
      best:  withData.find(l => l.median === hi).label,
      worst: withData.find(l => l.median === lo).label,
    });
  }
  return out.sort((a, b) => b.spread - a.spread);
}

function median(vals) {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const fmtMoney = (n) => (n == null ? '—' : (n < 0 ? '-' : '') + '$' + Math.abs(Math.round(n)).toLocaleString());
