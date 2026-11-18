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
 * Which years the historical bootstrap draws from (design 133 §3).
 *
 * The ONE rule for the window, read by the toolset when it builds the equity handler and by
 * anything that has to say which window a run uses (the Monte Carlo panel's return-paths
 * line, design 133 phase 1). Before this module the rule lived inline in the toolset, so
 * nothing outside the compile could see that the default Monte Carlo samples 1951–2023.
 *
 * Today the window is automatic: POSTWAR when joint inflation is on (design 103 §5.1, so
 * equity, inflation and the 10-year yield share a monetary era), otherwise FULL.
 */

import { HISTORICAL_BOOTSTRAP_WINDOWS } from './equity-return-tick-handler.js';
import { HISTORICAL_EQUITY_RETURNS }    from './historical-equity-returns.js';
import { jointInflationActive }         from './inflation-tick-handler.js';

/** The last historical year in the bundled series (every window ends here). */
export const HISTORICAL_LAST_YEAR = HISTORICAL_EQUITY_RETURNS.firstYear + HISTORICAL_EQUITY_RETURNS.returns.length - 1;

/**
 * True when a run with these params replays the historical bootstrap at all.
 *
 * @param {object} p  resolved params (an MC path's after `applyMcPaths`)
 * @returns {boolean}
 */
export function bootstrapActive(p) {
  return !!p?.equityReturnStochastic && p.equityReturnModel === 'HISTORICAL_BOOTSTRAP';
}

/**
 * The window name the equity handler is built with: 'POSTWAR' under joint inflation, else
 * 'FULL'. Returned even when the bootstrap is off, because the handler takes a window either
 * way and only reads it under the bootstrap.
 *
 * @param {object} p  resolved params
 * @returns {'FULL'|'POSTWAR'}
 */
export function bootstrapWindowName(p) {
  return jointInflationActive(p) ? 'POSTWAR' : 'FULL';
}

/**
 * The window a run with these params samples, for display, or null when the bootstrap is
 * not the active process.
 *
 * @param {object} p  resolved params
 * @returns {{ name: 'FULL'|'POSTWAR', fromYear: number, toYear: number, automatic: true,
 *             reason: string }|null}
 */
export function describeBootstrapWindow(p) {
  if (!bootstrapActive(p)) return null;
  const name = bootstrapWindowName(p);
  const w    = HISTORICAL_BOOTSTRAP_WINDOWS[name];
  return {
    name,
    fromYear:  w.firstYear + w.start,
    toYear:    HISTORICAL_LAST_YEAR,
    automatic: true,
    reason:    name === 'POSTWAR' ? 'joint inflation' : 'no joint inflation',
  };
}
