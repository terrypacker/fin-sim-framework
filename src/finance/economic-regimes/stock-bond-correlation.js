/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { jointInflationActive } from './inflation-tick-handler.js';

/**
 * Stock–bond correlation (design 129, step 0) — the one place that says what ρ is and whether
 * it is in play, so the compile (stamp, event order, handler) and the loader's warning cannot
 * disagree.
 *
 * ρ is the correlation between the RANDOM parts of the stock and bond returns. A bond's return
 * is ≈ −D·Δy, so the yield tick puts −ρ on the equity market shock (§3.1).
 */

/** The authored base ρ, clipped to [−1, 1]. A missing or non-finite value is 0. */
export function stockBondCorrelationOf(p) {
  const rho = Number(p?.stockBondCorrelation ?? 0);
  return Number.isFinite(rho) ? Math.max(-1, Math.min(1, rho)) : 0;
}

/**
 * Whether the correlation is in play (§3.3): both stochastic paths run, joint mode is off (it
 * takes its yields from history, §3.4), and ρ is not 0. A plan not in play keeps its exact event
 * order and state keys.
 */
export function stockBondCorrelationActive(p) {
  return !!p?.yieldCurveStochastic && !!p?.equityReturnStochastic && !jointInflationActive(p)
    && stockBondCorrelationOf(p) !== 0;
}

/**
 * Why an authored ρ does nothing on this plan, or [] when it is in play or unset (§3.3, §3.4).
 * The lever-hygiene rule: a lever that cannot move the run says so.
 *
 * `mc` checks the params a Monte Carlo PATH runs (the runner passes them after `applyMcPaths`),
 * where joint mode usually comes from `mcInflationModel: AUTO` rather than the plan, so the
 * advice names the MC setting. `sampled` says the MC row samples ρ, so a 0 centre still warns.
 */
export function stockBondCorrelationWarnings(p, { mc = false, sampled = false } = {}) {
  const rho = stockBondCorrelationOf(p);
  if (rho === 0 && !sampled) return [];
  const what = sampled ? 'Stock–Bond Correlation is sampled' : `Stock–Bond Correlation is ${rho}`;
  if (!p?.yieldCurveStochastic || !p?.equityReturnStochastic) {
    const off = [!p?.yieldCurveStochastic && 'Stochastic Yield Curve', !p?.equityReturnStochastic && 'Stochastic Equity Returns']
      .filter(Boolean).join(' and ');
    return [`${what} but ${off} ${off.includes(' and ') ? 'are' : 'is'} off, `
      + 'so it has no noise to correlate and does nothing (design 129 §3.3).'];
  }
  if (jointInflationActive(p)) {
    return [mc
      ? `${what} but Monte Carlo runs inflation in HISTORICAL_JOINT mode (MC Inflation Process AUTO `
        + 'with the bootstrap), whose yields replay the historical year and already carry that era\'s '
        + 'correlation. It is ignored on every path. Set the MC Inflation Process to GAUSSIAN to sweep '
        + 'it (design 129 §3.4).'
      : `${what} but inflation runs in HISTORICAL_JOINT mode, whose yields `
        + 'come from the replayed historical year and already carry that era\'s correlation. It is '
        + 'ignored (design 129 §3.4).'];
  }
  return [];
}
