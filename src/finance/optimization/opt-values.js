
/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { OPT_PARAM_TYPES } from './optimization-objectives.js';

/**
 * Expand a single optimization config into the concrete values it covers.
 * Shared by OptimizationProblem (candidateCount) and GridSearchSolver
 * (exhaustive enumeration). ENUM returns a copy of its value set; INTEGER /
 * CONTINUOUS discretise [min, max] by step.
 */
export function valuesForConfig(cfg) {
  if (cfg.type === OPT_PARAM_TYPES.ENUM) return cfg.values.slice();
  const min  = Number(cfg.min);
  const max  = Number(cfg.max);
  const step = Number(cfg.step);
  if (!isFinite(min) || !isFinite(max) || !isFinite(step) || step <= 0) return [];
  const vals = [];
  for (let v = min; v <= max + 1e-9; v += step) {
    vals.push(cfg.type === OPT_PARAM_TYPES.INTEGER ? Math.round(v) : v);
  }
  return vals;
}

/** Cartesian product of an array of value arrays. [] → [[]]. */
export function cartesianProduct(arrays) {
  if (arrays.length === 0) return [[]];
  return arrays.reduce(
    (acc, arr) => acc.flatMap(a => arr.map(b => [...a, b])),
    [[]]
  );
}
