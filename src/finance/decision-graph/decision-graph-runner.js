/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ScenarioSerializer }         from '../../scenarios/scenario-serializer.js';
import { IntlRetirementMcRunner }     from '../monte-carlo/intl-retirement-mc-runner.js';
import { DEFAULT_MC_VARIABLE_CONFIGS } from '../monte-carlo/intl-retirement-mc-config.js';

/**
 * MC runner subclass that offsets the per-draw seed by a fixed amount.
 * This gives each decision-graph leaf its own reproducible seed space:
 *   seed for leaf L, draw D = mcSeed + L × n + D + 1
 */
class _OffsetSeedMcRunner extends IntlRetirementMcRunner {
  constructor(opts, seedOffset) {
    super(opts);
    this._seedOffset = seedOffset;
  }

  _perturb(baseParams, i, variables) {
    return super._perturb(baseParams, i + this._seedOffset, variables);
  }
}

/**
 * DecisionGraphRunner — Tier-4 analysis engine.
 *
 * Given a DecisionGraph, expands the cartesian product of DecisionPoint options
 * into leaves, runs MC for each leaf, and aggregates results.
 *
 * @param {object} opts
 * @param {object}   opts.scenarioRegistry — registry with a `.get(id)` method
 * @param {Function} [opts.mcRunnerFactory] — injectable factory for testing;
 *                   receives ({n, cfgTemplate, simStart, simEnd, variableConfigs})
 *                   and must return an object with `run(baseParams, onProgress)`.
 * @param {Array}    [opts.variableConfigs] — MC distribution configs; defaults to
 *                   DEFAULT_MC_VARIABLE_CONFIGS.
 */
export class DecisionGraphRunner {
  constructor({ scenarioRegistry, mcRunnerFactory = null, variableConfigs = DEFAULT_MC_VARIABLE_CONFIGS } = {}) {
    this._scenarioRegistry = scenarioRegistry;
    this._mcRunnerFactory  = mcRunnerFactory;
    this._variableConfigs  = variableConfigs;
  }

  /**
   * Run a full decision-graph analysis.
   *
   * @param {import('./decision-graph-models.js').DecisionGraph} dg
   * @param {Function} [onProgress] — (totalDone, totalDraws, leafDone, leafTotal)
   * @returns {Promise<DecisionGraphResult>}
   */
  async run(dg, onProgress) {
    const baseEntry = this._scenarioRegistry?.get(dg.baseScenarioId);
    if (!baseEntry) throw new Error(`Base scenario '${dg.baseScenarioId}' not found`);

    const leaves = this._expandLeaves(dg.decisionPoints ?? []);
    this._validateLeafCount(leaves.length);

    const simStart = new Date(baseEntry.simStart);
    const simEnd   = new Date(baseEntry.simEnd);
    const n        = dg.mcDrawsPerLeaf ?? 100;
    const results  = [];

    for (let i = 0; i < leaves.length; i++) {
      const leaf       = leaves[i];
      const seedOffset = (dg.mcSeed ?? 42) + i * n;
      const mcRunnerOpts = {
        n,
        cfgTemplate:    baseEntry,
        simStart,
        simEnd,
        variableConfigs: this._variableConfigs,
      };

      const mcRunner = this._mcRunnerFactory
        ? this._mcRunnerFactory(mcRunnerOpts)
        : new _OffsetSeedMcRunner(mcRunnerOpts, seedOffset);

      const { summary } = await mcRunner.run(leaf.params, (drawDone, drawTotal) => {
        if (onProgress) {
          onProgress(i * n + drawDone, leaves.length * n, i, leaves.length);
        }
      });

      // Guarantee at least one progress call per leaf even when the inner
      // per-draw callback is never invoked (e.g. mock runners).
      if (onProgress) onProgress((i + 1) * n, leaves.length * n, i + 1, leaves.length);

      results.push({
        id:           `dg-leaf:${i}`,
        label:        leaf.label,
        optionVector: leaf.optionVector,
        params:       leaf.params,
        entry:        this._makeLeafEntry(baseEntry, leaf, i),
        mcSummary:    summary,
      });
    }

    return {
      graphId:        dg.id,
      baseScenarioId: dg.baseScenarioId,
      objective:      dg.objective,
      decisionPoints: dg.decisionPoints,
      leaves:         results,
    };
  }

  /**
   * Produce a ranked or weighted-expectation view of a DecisionGraphResult.
   *
   * @param {DecisionGraphResult} result
   * @param {'ranked'|'weightedExpectation'} [mode='ranked']
   * @returns {Array|{expectedValue, leaves}}
   */
  summarize(result, mode = 'ranked') {
    const { leaves = [], objective, decisionPoints = [] } = result;

    const score = leaf => {
      switch (objective) {
        case 'successRate':       return leaf.mcSummary?.successRate ?? 0;
        case 'cumulativeDeficit': return -(leaf.mcSummary?.p50Deficit ?? 0);
        case 'finalBalance':
        default:                  return leaf.mcSummary?.p50 ?? 0;
      }
    };

    if (mode === 'ranked') {
      return [...leaves].sort((a, b) => score(b) - score(a));
    }

    if (mode === 'weightedExpectation') {
      const leafWeights = leaves.map(leaf => {
        let w = 1;
        for (const dp of decisionPoints) {
          const chosenValue = leaf.optionVector?.[dp.id];
          const optIdx = dp.options?.findIndex(o => o.value === chosenValue) ?? -1;
          if (dp.weights && optIdx >= 0) {
            w *= dp.weights[optIdx];
          } else {
            w *= 1 / Math.max(1, dp.options?.length ?? 1);
          }
        }
        return w;
      });

      const totalWeight = leafWeights.reduce((s, w) => s + w, 0);
      const norm = leafWeights.map(w => totalWeight > 0 ? w / totalWeight : 1 / Math.max(1, leaves.length));
      const expectedValue = leaves.reduce((sum, leaf, i) => sum + score(leaf) * norm[i], 0);

      return {
        expectedValue,
        leaves: leaves.map((leaf, i) => ({ ...leaf, weight: norm[i] })),
      };
    }

    return leaves;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Recursively expand the cartesian product of decision-point options.
   * Returns an array of { optionVector, label, params } leaf descriptors.
   */
  _expandLeaves(decisionPoints) {
    if (!decisionPoints || decisionPoints.length === 0) {
      return [{ optionVector: {}, label: 'Base', params: {} }];
    }

    const [first, ...rest] = decisionPoints;
    const subLeaves = this._expandLeaves(rest);
    const result    = [];

    for (const opt of (first.options ?? [])) {
      for (const sub of subLeaves) {
        const subLabel = sub.label !== 'Base' ? ` / ${sub.label}` : '';
        result.push({
          optionVector: { [first.id]: opt.value, ...sub.optionVector },
          label:        `${first.label}=${opt.label}${subLabel}`,
          params:       { [first.paramKey]: opt.value, ...sub.params },
        });
      }
    }
    return result;
  }

  /**
   * Emit a warning for > 100 leaves; throw for > 1000 (unless allowLargeGraph).
   */
  _validateLeafCount(count, allowLargeGraph = false) {
    if (count > 1000 && !allowLargeGraph) {
      throw new Error(`Leaf count ${count} exceeds maximum 1000. Set allowLargeGraph:true to override.`);
    }
    if (count > 100) {
      console.warn(`[DecisionGraphRunner] Large decision graph: ${count} leaves. Consider reducing options.`);
    }
  }

  /**
   * Create a plain-object "leaf entry" compatible with ScenarioCompareRunner.run().
   * Uses ScenarioSerializer to strip live class refs from the base entry.
   */
  _makeLeafEntry(baseEntry, leaf, leafIndex) {
    const entry = ScenarioSerializer.serializeScenario(baseEntry);
    entry.id    = `dg-leaf:${leafIndex}`;
    entry.name  = leaf.label;
    entry.layer = 'analysis-leaf';

    // serializeScenario returns params as a direct reference (not a clone), so
    // we must clone before mutating to avoid corrupting baseEntry.params in place.
    entry.params = (entry.params ?? []).map(p => ({ ...p }));

    if (Array.isArray(entry.params)) {
      for (const p of entry.params) {
        if (p.name in leaf.params) p.value = leaf.params[p.name];
      }
      const existingNames = new Set(entry.params.map(p => p.name));
      for (const [name, value] of Object.entries(leaf.params)) {
        if (!existingNames.has(name)) entry.params.push({ name, value });
      }
    }

    return entry;
  }
}
