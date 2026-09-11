/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

// Design 90 §7.4 — "dispersion is the point". The equity markets used to be one random
// variable scaled four ways (idio vol 0), so they could never cross: no harvestable loss
// in a portfolio that was not losing in aggregate. The sourced betas and idio vols make
// them genuinely different, and these pin that they reproduce the sources.

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { EquityReturnTickHandler } from '../../src/finance/economic-regimes/equity-return-tick-handler.js';
import { RATE_KEYS, EQUITY_SLEEVES, DEFAULT_EQUITY_BETA, DEFAULT_EQUITY_IDIO }
  from '../../src/finance/economic-regimes/rate-keys.js';

const FACTOR_VOL = 0.18;
// The sourced targets (docs/market-returns/SOURCES.md, "Volatility and correlation").
const SOURCED = {
  [RATE_KEYS.EQUITY_US]:         { sigma: 0.18,   rho: 1 },
  [RATE_KEYS.EQUITY_INTL_EX_US]: { sigma: 0.1760, rho: 0.8745 },
  [RATE_KEYS.EQUITY_AU]:         { sigma: 0.1507, rho: 0.5105 },
  [RATE_KEYS.EQUITY_INTL_EX_AU]: { sigma: 0.1472, rho: 0.9904 },
};
const mkRng = (seed = 1) => { let s = seed; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; };

test('DISP-1: each market\'s default β and idio vol reproduce its sourced σ and ρ with the US', () => {
  for (const k of EQUITY_SLEEVES) {
    const beta = DEFAULT_EQUITY_BETA[k], idio = DEFAULT_EQUITY_IDIO[k];
    const sigma = Math.sqrt((beta * FACTOR_VOL) ** 2 + idio ** 2);
    // Rounding the table to two places (β) and 0.1% (idio) moves σ and ρ by well under 0.005.
    assert.ok(Math.abs(sigma - SOURCED[k].sigma) < 0.005, `${k}: σ ${sigma.toFixed(4)} vs ${SOURCED[k].sigma}`);
    assert.ok(Math.abs(beta * FACTOR_VOL / sigma - SOURCED[k].rho) < 0.005, `${k}: ρ with US`);
  }
});

test('DISP-2: the US market IS the factor — idio 0, so its draw is skipped', () => {
  assert.equal(DEFAULT_EQUITY_BETA[RATE_KEYS.EQUITY_US], 1);
  assert.equal(DEFAULT_EQUITY_IDIO[RATE_KEYS.EQUITY_US], 0);
});

test('DISP-3: on defaults the markets can move in OPPOSITE directions', () => {
  // Before §7.4 every deviation was β × one draw with β > 0, so the signs always agreed.
  const h = new EquityReturnTickHandler({ vol: FACTOR_VOL });
  let crossed = 0;
  const N = 400;
  for (let i = 0; i < N; i++) {
    const { deviation } = h.call({ sim: { rng: mkRng(i + 1) }, state: {} })[0];
    if (Math.sign(deviation[RATE_KEYS.EQUITY_US]) !== Math.sign(deviation[RATE_KEYS.EQUITY_AU])) crossed++;
  }
  // ρ ≈ 0.51 ⇒ opposite signs about a third of the time (1/2 − arcsin(ρ)/π ≈ 0.33).
  assert.ok(crossed / N > 0.2 && crossed / N < 0.45, `US and AU crossed in ${crossed} of ${N} years`);
});

test('DISP-4: an explicit zero still turns a market\'s dispersion off', () => {
  const zeros = Object.fromEntries(EQUITY_SLEEVES.map(k => [k, 0]));
  const { marketDev, deviation } = new EquityReturnTickHandler({ vol: FACTOR_VOL, idioVol: zeros })
    .call({ sim: { rng: mkRng(3) }, state: {} })[0];
  for (const k of EQUITY_SLEEVES) {
    assert.ok(Math.abs(deviation[k] - DEFAULT_EQUITY_BETA[k] * marketDev) < 1e-12, `${k} is β × market`);
  }
});
