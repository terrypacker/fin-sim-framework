#!/usr/bin/env node
/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * probe-market-index-cost.mjs — what the market index costs a run (design 101 §6.2).
 *
 * The index runs in EVERY run, Monte Carlo included, because it is state. The per-step
 * work is tiny (5 markets + the registry's securities, one multiply each, once a year),
 * but §6.2 asked for it to be measured rather than assumed.
 *
 * Runs one golden with `MarketIndexReducer.reduce` stubbed to a no-op and live,
 * interleaved so drift and warm-up hit both equally, and reports the medians.
 *
 * Measured 12 Sep 2026, cross-border-reference (24 years, telemetry=journal), 6 runs each:
 * stubbed 257.9 ms, live 254.2 ms. The difference is inside run-to-run noise.
 *
 * Usage: node scripts/probes/probe-market-index-cost.mjs [goldenName] [runs]
 */

import { specByName }         from '../../tests/helpers/golden-specs.js';
import { runGolden }          from '../../tests/helpers/golden-harness.js';
import { MarketIndexReducer } from '../../src/finance/economic-regimes/market-index.js';

const name = process.argv[2] ?? 'cross-border-reference';
const runs = Number(process.argv[3] ?? 6);
const spec = specByName(name);

const live = MarketIndexReducer.prototype.reduce;
const stub = function (state) { return this.newState(state); };
const time = () => { const t = process.hrtime.bigint(); runGolden(spec); return Number(process.hrtime.bigint() - t) / 1e6; };

time(); time();   // warm up
const res = { stub: [], live: [] };
for (let i = 0; i < runs; i++) {
  MarketIndexReducer.prototype.reduce = stub; res.stub.push(time());
  MarketIndexReducer.prototype.reduce = live; res.live.push(time());
}
const median = a => [...a].sort((x, y) => x - y)[a.length >> 1];
console.log(`${name}, telemetry=journal, ${runs} interleaved runs each`);
console.log(`  index stubbed: median ${median(res.stub).toFixed(1)} ms   [${res.stub.map(x => x.toFixed(0)).join(' ')}]`);
console.log(`  index live:    median ${median(res.live).toFixed(1)} ms   [${res.live.map(x => x.toFixed(0)).join(' ')}]`);
const d = median(res.live) - median(res.stub);
console.log(`  delta: ${d.toFixed(1)} ms (${(d / median(res.stub) * 100).toFixed(2)}%)`);
