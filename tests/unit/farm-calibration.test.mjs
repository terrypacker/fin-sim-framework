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
 * farm-calibration.test.mjs — design 134 §13.8, the farm Monte Carlo's spreads from NASS.
 *
 * The arithmetic on series whose answer is known, then FARM_CALIBRATION re-derived from the
 * extract on disk: a constant can not drift from its source, and a re-fetch that moves one
 * fails here until the constant (and §13.8) is updated.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { ols, sd, skewness, trendDeviations, countyYieldStats, plantingToHarvestLogChange, annualizedVol,
  priceYieldBeta, quartiles, calibrateFromNass, FARM_CALIBRATION } from '../../src/finance/farm/farm-calibration.js';

const years = Array.from({ length: 30 }, (_, i) => 1990 + i);
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b}`);

describe('arithmetic', () => {
  test('ols recovers a line; sd is the sample sd', () => {
    const { a, b } = ols([1, 2, 3, 4], [3, 5, 7, 9]);
    close(a, 1, 1e-12); close(b, 2, 1e-12);
    close(sd([2, 4, 4, 4, 5, 5, 7, 9]), Math.sqrt(32 / 7), 1e-12);
  });

  test('a series on its trend times (1 + d) gives back d', () => {
    // Alternating ±0.1 around a rising trend: the fitted trend is close to the true one.
    const d = years.map((_, i) => (i % 2 ? 0.1 : -0.1));
    const dev = trendDeviations(new Map(years.map((y, i) => [y, (100 + 2 * (y - 1990)) * (1 + d[i])])));
    // The trend is fit on LEVELS, so a multiplicative swing on a rising trend leans it a
    // little (≈0.01 at the ends here): fine for a spread, and pinned so it stays that small.
    for (const [i, y] of years.entries()) close(dev.get(y), d[i], 0.015, String(y));
    close(sd([...dev.values()]), sd(d), 0.002, 'the spread is what matters');
  });

  test('irrigated = 0.3·dry + its own: β 0.3, and the residual is its own part', () => {
    const dry = years.map((_, i) => Math.sin(i * 1.7) * 0.2);
    const own = years.map((_, i) => Math.cos(i * 2.9) * 0.05);
    const series = (dev) => new Map(years.map((y, i) => [y, 150 * (1 + dev[i])]));
    const s = countyYieldStats(series(dry), series(years.map((_, i) => 0.3 * dry[i] + own[i])));
    close(s.irrigatedBeta, 0.3, 0.05);
    close(s.irrResidualSd, sd(own), 0.01);
    assert.equal(countyYieldStats(series(dry).set(2050, 1), new Map([[1990, 1]])), null, 'too few shared years');
  });

  test('January→harvest log change, its vol, and the price–yield link', () => {
    const monthly = new Map();
    const dev = new Map();
    for (const [i, y] of years.entries()) {
      const shock = (i % 3) - 1;               // −1, 0, 1
      dev.set(y, -0.1 * shock);                // a short crop when the price rises
      monthly.set(`${y}-01`, 4);
      monthly.set(`${y}-10`, 4 * Math.exp(0.05 * shock));
    }
    const ch = plantingToHarvestLogChange(monthly, 10);
    close(ch.get(1991), 0, 1e-12);
    close(annualizedVol([...ch.values()], 9), sd([...ch.values()]) / Math.sqrt(0.75), 1e-12);
    close(priceYieldBeta(ch, dev), 0.5, 1e-9, 'Δln p = −b·dev with b = 0.05/0.1');
  });

  test('quartiles', () => {
    assert.deepEqual(quartiles([4, 1, 3, 2, 5]), { n: 5, p25: 2, p50: 3, p75: 4 });
  });
});

describe('FARM_CALIBRATION comes from the extract on disk', () => {
  const file = resolve(import.meta.dirname, '../..', FARM_CALIBRATION.source);
  const res = calibrateFromNass(gunzipSync(readFileSync(file)).toString('utf8'), { from: FARM_CALIBRATION.from });
  const { CORN, SOYBEANS } = res.crops;

  test('every Nebraska county with enough years contributes', () => {
    assert.ok(CORN.counties >= 60, `${CORN.counties} counties`);
    assert.ok(CORN.priceVol.years >= 30);
  });

  test('yield shapes (rounded as shipped)', () => {
    close(FARM_CALIBRATION.yieldShockSd, CORN.sdDry.p50, 0.005, 'dryland sd');
    close(FARM_CALIBRATION.yieldShockSkew, CORN.skewDry.p50, 0.005, 'dryland skew');
    close(FARM_CALIBRATION.irrigatedYieldShockSkew, CORN.irrResidualSkew.p50, 0.005, 'irrigated skew');
    assert.ok(CORN.skewDry.p75 < 0, 'three counties in four have a longer drought tail');
    close(FARM_CALIBRATION.irrigatedYieldShockSd, CORN.irrResidualSd.p50, 0.0005, 'irrigated residual sd');
    close(FARM_CALIBRATION.irrigatedYieldBeta, CORN.irrigatedBeta.p50, 0.005, 'irrigated β');
    close(FARM_CALIBRATION.yieldShockScale.SOYBEANS, SOYBEANS.sdDry.p50 / CORN.sdDry.p50, 0.005, 'soybean scale');
  });

  test('price shapes (rounded as shipped)', () => {
    close(FARM_CALIBRATION.priceVol.CORN, CORN.priceVol.annualized, 0.005);
    close(FARM_CALIBRATION.priceVol.SOYBEANS, SOYBEANS.priceVol.annualized, 0.005);
    close(FARM_CALIBRATION.priceYieldBeta.CORN, CORN.priceYieldBeta.p50, 0.005);
    close(FARM_CALIBRATION.priceYieldBeta.SOYBEANS, SOYBEANS.priceYieldBeta.p50, 0.005);
  });

  test('one county reads its own figures; an unknown one is refused', () => {
    const one = calibrateFromNass(gunzipSync(readFileSync(file)).toString('utf8'), { county: 'hall' });
    assert.deepEqual(one.counties, ['HALL']);
    assert.throws(() => calibrateFromNass('commodity_desc\n', { county: 'Atlantis' }), /no Nebraska county/);
  });
});

describe('the skew-normal draw (design 134 §13.8)', () => {
  test('keeps the mean and sd, and has the asked-for skew and a drought tail', async () => {
    const { SkewNormalDistribution } = await import('../../src/simulation-framework/distributions.js');
    let seed = 7;
    const rng = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const d = new SkewNormalDistribution({ mean: 0, stdDev: 0.3, skew: FARM_CALIBRATION.yieldShockSkew });
    const x = Array.from({ length: 200_000 }, () => d.sample(rng));
    const m = x.reduce((a, b) => a + b, 0) / x.length;
    close(m, 0, 0.003, 'mean');
    close(sd(x), 0.3, 0.003, 'sd');
    close(skewness(x), FARM_CALIBRATION.yieldShockSkew, 0.03, 'skew');
    const below = x.filter(v => v < -0.6).length / x.length;
    const above = x.filter(v => v > 0.6).length / x.length;
    assert.ok(below > 0.035 && above < 0.006, `2-sd tails ${below} below, ${above} above (normal: 0.023 each)`);
    assert.equal(new SkewNormalDistribution({ mean: 1, stdDev: 0, skew: -0.5 }).sample(rng), 1);
  });
});
