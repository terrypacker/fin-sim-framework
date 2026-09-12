/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { IntlRetirementMcRunner } from './intl-retirement-mc-runner.js';
import { buildIterationRunner, runGridTask, samplingSignature, gridCellParams } from './parallel/mc-worker-core.js';
import { cartesianProduct } from '../optimization/opt-values.js';
import { get } from './mc-param-paths.js';
import { GRID_MODES, referenceCellOf, summarizeGridCell } from './mc-grid.js';

/**
 * A grid cell's paths as the Runs panel's run records, params included (design 100 §7).
 *
 * The worker drops each path's params to keep a grid small. They are fully determined
 * by the base world, the cell's lever values and the seed, so they are rebuilt here
 * exactly, with the same `gridCellParams` the worker ran. Replay on one of these runs
 * therefore reproduces that grid path. Path i runs at seed i + 1 (mc-worker-core).
 *
 * @param {object} grid  `McGridRunner.run()` result
 * @param {number} cell  cell index
 */
export function gridCellRuns(grid, cell) {
  const ctx = grid.paramsCtx;
  return grid.cells[cell].rows.map(r => ({
    seed:                r.seed,
    params:              ctx ? gridCellParams(ctx, cell, r.seed - 1) : null,
    finalNetWorthUsd:    r.nw,
    afterTaxNetWorthUsd: r.afterTaxNW,
    finalNetLiquidity:   null,
    scenarioFailed:      r.failed,
    outOfFundsDate:      r.oof ? new Date(`${r.oof}T00:00:00Z`) : null,
    timeSeries:          [],
  }));
}

/**
 * McGridRunner — one or two levers crossed, every cell run on the MC engine (design
 * 100 §7).
 *
 * One engine for both modes:
 *   - **MC cells** run paths `0…n−1` with the batch's variable list. Every cell draws
 *     the same worlds, so any two cells are paired by construction (common random
 *     numbers), and the paired readout of step 3 applies cell to cell.
 *   - **A deterministic cell** is the same run with nothing sampled, one path, and
 *     `mcSequenceRisk: false`: the plan's own single run. It is not a second engine, so a
 *     deterministic cell and an MC cell cannot disagree about how a lever is applied.
 *
 * The world is the batch's: `_prepare` is inherited, so a cell at the plan's own values
 * reproduces the MC tab's batch (or the single run) exactly.
 *
 * An axis that is also an enabled MC variable is removed from sampling for the whole
 * grid. Left in, its draw would overwrite the value the cell sets and the axis would do
 * nothing. It is removed in every cell alike, so pairing holds, and the result names it.
 *
 * The whole grid is one broadcast context and cells × paths small tasks, so it shards
 * across the worker pool in one pass rather than one pool round per cell.
 */
export class McGridRunner extends IntlRetirementMcRunner {
  /**
   * @param {object} opts  everything `IntlRetirementMcRunner` takes, plus:
   * @param {Array<{paramKey: string, label?: string, values: Array}>} opts.axes  one or two
   * @param {'mc'|'deterministic'} [opts.mode='mc']
   */
  constructor({ axes, mode = GRID_MODES.MC, ...opts } = {}) {
    // Never mix or spending in a grid: cells × paths of either is the memory problem
    // design 100 §4 measured, and the heatmap reads neither.
    super({ ...opts, mix: false, spending: false });
    if (!Array.isArray(axes) || axes.length < 1 || axes.length > 2) {
      throw new Error('McGridRunner: one or two axes');
    }
    for (const a of axes) {
      if (!a?.paramKey || !a.values?.length) throw new Error(`McGridRunner: axis ${a?.paramKey} has no values`);
    }
    if (axes.length === 2 && axes[0].paramKey === axes[1].paramKey) {
      throw new Error('McGridRunner: the two axes must be different levers');
    }
    if (!Object.values(GRID_MODES).includes(mode)) throw new Error(`McGridRunner: unknown mode ${mode}`);
    this.axes = axes;
    this.mode = mode;
  }

  /** Paths per cell: one for a deterministic grid. */
  get pathsPerCell() { return this.mode === GRID_MODES.DETERMINISTIC ? 1 : this.n; }

  /** The batch world, re-cut for the grid. Split out so tests can read what a cell runs. */
  _gridContext(baseParams = {}) {
    const { ctx, provenance } = this._prepare(baseParams);
    const det      = this.mode === GRID_MODES.DETERMINISTIC;
    const axisKeys = this.axes.map(a => a.paramKey);

    const removedFromSampling = det ? []
      : ctx.variables.filter(v => v.enabled && axisKeys.includes(v.paramKey)).map(v => v.paramKey);
    const variables = ctx.variables.map(v =>
      (v.enabled && (det || axisKeys.includes(v.paramKey))) ? { ...v, enabled: false } : v);
    const base = det ? { ...ctx.base, mcSequenceRisk: false } : ctx.base;

    const cells = cartesianProduct(this.axes.map(a => a.values)).map(values => ({
      values,
      overrides: Object.fromEntries(axisKeys.map((k, j) => [k, values[j]])),
    }));

    return {
      gctx: { ...ctx, base, variables, cells: cells.map(c => ({ overrides: c.overrides })) },
      cells,
      provenance,
      removedFromSampling,
      planValues: axisKeys.map(k => get(base, k)),
    };
  }

  /**
   * @param {object}   [baseParams={}]
   * @param {Function} [onProgress]  (completed, total) over cells × paths
   * @returns {Promise<object>} `{ mode, n, axes, planValues, referenceCell,
   *          removedFromSampling, cells: [{ values, rows, summary }], provenance }`
   */
  async run(baseParams = {}, onProgress) {
    const { gctx, cells, provenance, removedFromSampling, planValues } = this._gridContext(baseParams);
    const n     = this.pathsPerCell;
    const tasks = cells.flatMap((_, cell) => Array.from({ length: n }, (__, i) => ({ cell, i })));
    const rows  = await this._runTasks(gctx, tasks, onProgress);

    const pairingFacts = {
      sampled:        samplingSignature(gctx.variables),
      mcSequenceRisk: gctx.base.mcSequenceRisk !== false,
    };
    return {
      mode: this.mode,
      n,
      axes: this.axes.map(a => ({ paramKey: a.paramKey, label: a.label ?? a.paramKey, values: a.values })),
      planValues,
      referenceCell: referenceCellOf(this.axes, planValues),
      removedFromSampling,
      // Tasks are cell-major and `mapTasks` returns input order, so cell k is one slice.
      // A path that threw is excluded from its cell's rows and listed on `errored` (see
      // `IntlRetirementMcRunner.run`), so one bad path cannot abort the whole grid.
      cells: cells.map((c, k) => {
        const slice    = rows.slice(k * n, (k + 1) * n);
        const errored  = slice.filter(r => r.error);
        const cellRows = slice.filter(r => !r.error);
        for (const r of errored) {
          console.error(`[McGridRunner] cell ${k} path seed=${r.seed} threw and is excluded: ${r.error}`);
        }
        return { values: c.values, rows: cellRows, errored,
                 summary: summarizeGridCell(cellRows, pairingFacts) };
      }),
      provenance,
      // What `gridCellRuns` needs to rebuild any path's params: one copy of the base
      // world, not a param bag per path.
      paramsCtx: { base: gctx.base, variables: gctx.variables, cells: gctx.cells },
    };
  }

  /** The grid's tasks on the pool when there is one, serially otherwise. Same code either way. */
  async _runTasks(ctx, tasks, onProgress) {
    const pool = this._poolFor(this._resolvePool());
    if (pool) {
      try {
        pool.setContext(ctx);
        return await pool.mapTasks(tasks, 'grid', { onSettled: onProgress });
      } finally {
        if (this._ownsPool) { pool.terminate(); this._pool = null; this._ownsPool = false; }
      }
    }
    const iter = buildIterationRunner(ctx);
    const rows = [];
    for (let k = 0; k < tasks.length; k++) {
      rows.push(runGridTask(iter, ctx, tasks[k]));
      onProgress?.(k + 1, tasks.length);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return rows;
  }
}
