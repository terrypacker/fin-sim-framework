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
 * A single discrete decision with a fixed set of options.
 *
 * paramKey maps to a scenario param name (e.g. 'primarySsClaimAge').
 * options is an array of { value, label } describing each alternative.
 * weights is optional: per-option probability weights for weighted-expectation mode.
 */
export class DecisionPoint {
  constructor({ id, label, paramKey, options = [], weights = null }) {
    this.id       = id;
    this.label    = label;
    this.paramKey = paramKey;
    this.options  = options;
    this.weights  = weights;
  }
}

/**
 * A named combinatorial analysis over a set of DecisionPoints.
 *
 * baseScenarioId — graph node id of the base scenario to derive all leaves from.
 * objective — determines sort order in ranked mode and the score used in
 *             weighted-expectation mode:
 *   'finalBalance'       → p50 of final net worth (default)
 *   'successRate'        → fraction of MC draws that did not run out of funds
 *   'cumulativeDeficit'  → negative of median deficit (higher is better)
 * mcDrawsPerLeaf — MC iterations per leaf (default 100).
 * mcSeed — base seed; per-leaf seed offset = mcSeed + leafIndex × mcDrawsPerLeaf.
 */
export class DecisionGraph {
  constructor({
    id,
    name              = 'Unnamed Analysis',
    baseScenarioId,
    decisionPoints    = [],
    objective         = 'finalBalance',
    mcDrawsPerLeaf    = 100,
    mcSeed            = 42,
    persistLeaves     = false,
  }) {
    this.id             = id;
    this.name           = name;
    this.baseScenarioId = baseScenarioId;
    this.decisionPoints = decisionPoints;
    this.objective      = objective;
    this.mcDrawsPerLeaf = mcDrawsPerLeaf;
    this.mcSeed         = mcSeed;
    this.persistLeaves  = persistLeaves;
  }

  leafCount() {
    if (!this.decisionPoints.length) return 1;
    return this.decisionPoints.reduce((p, dp) => p * (dp.options?.length ?? 0), 1);
  }
}
