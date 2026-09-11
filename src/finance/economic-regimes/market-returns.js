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
 * market-returns.js — the four equity markets' TOTAL returns and the dividend yield inside
 * each (design 99 §2).
 *
 * The ONE table every reader shares: ECONOMIC_REGIMES seeds its rate maps and declares its
 * params from it, the retirement toolsets take their handlers' last-resort rate from it,
 * the loader measures a retired rate against it, and the account editor derives its
 * expected return from it. A module of its own, with no dependency beyond the rate keys,
 * so a UI editor can read it without importing the regimes toolset and its reducers.
 *
 * The ORDER is load-bearing: it is the key order of `baseGrowthRates`, and whole-state
 * fixtures compare that JSON exactly. The keys keep their design 98 W1 names
 * (`*GrowthRate`) so saved values carry over.
 */

import { RATE_KEYS } from './rate-keys.js';

//
// The DEFAULTS are sourced (design 99 P5b): each total is the mean of three forward-looking
// capital-market-assumption providers (Vanguard, BlackRock, J.P. Morgan; 10-year,
// geometric, nominal), each yield is MSCI's for the matching index. The files, the figures
// taken from them and the arithmetic are in docs/market-returns/SOURCES.md — change a
// default there first. "International ex-US" is DEVELOPED ex-US (MSCI World ex USA).
export const MARKET_GROWTH_PARAMS = Object.freeze([
  { key: 'usEquityGrowthRate',       rateKey: RATE_KEYS.EQUITY_US,         defaultValue: 0.070,
    label: 'US Equity Total Return',
    yieldKey: 'usEquityDividendYield',       yieldDefault: 0.0110, yieldLabel: 'US Equity Dividend Yield' },
  { key: 'auEquityGrowthRate',       rateKey: RATE_KEYS.EQUITY_AU,         defaultValue: 0.067,
    label: 'AU Equity Total Return',
    yieldKey: 'auEquityDividendYield',       yieldDefault: 0.0343, yieldLabel: 'AU Equity Dividend Yield' },
  { key: 'intlExUsEquityGrowthRate', rateKey: RATE_KEYS.EQUITY_INTL_EX_US, defaultValue: 0.069,
    label: 'International ex-US Equity Total Return',
    yieldKey: 'intlExUsEquityDividendYield', yieldDefault: 0.0253, yieldLabel: 'International ex-US Equity Dividend Yield' },
  { key: 'intlExAuEquityGrowthRate', rateKey: RATE_KEYS.EQUITY_INTL_EX_AU, defaultValue: 0.075,
    label: 'International ex-AU Equity Total Return',
    yieldKey: 'intlExAuEquityDividendYield', yieldDefault: 0.0147, yieldLabel: 'International ex-AU Equity Dividend Yield' },
].map(Object.freeze));

/**
 * One market's `{ total, yield }` from scenario params, falling back to the table's
 * defaults.
 *
 * @param {object} p        - scenario parameters (a flat `key → value` bag)
 * @param {string} rateKey  - an equity market key (RATE_KEYS.EQUITY_*)
 * @returns {{ total: number, yield: number }}
 */
export function marketReturnFor(p, rateKey) {
  const m = MARKET_GROWTH_PARAMS.find(x => x.rateKey === rateKey);
  if (!m) throw new Error(`marketReturnFor: '${rateKey}' is not an equity market`);
  return { total: p?.[m.key] ?? m.defaultValue, yield: p?.[m.yieldKey] ?? m.yieldDefault };
}
