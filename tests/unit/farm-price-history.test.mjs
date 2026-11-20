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
 * farm-price-history.test.mjs — design 134 §17.5, step 8a.
 *
 * The parser on rows whose answer is known (what it reads, what it skips, a withheld value),
 * then the generated FARM_PRICE_HISTORY re-derived from the NASS extract on disk, byte for
 * byte, so the file the browser imports cannot drift from its source.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  parseNassMonthlyPrices, priceHistoryData, renderPriceHistoryModule, priceHistory,
  priceHistoryBetween, latestPriceMonth, nextMonth, PRICE_HISTORY_LIMITS,
} from '../../src/finance/farm/farm-price-history.js';
import { FARM_PRICE_HISTORY } from '../../src/finance/farm/farm-price-history-data.js';

const ROOT = resolve(import.meta.dirname, '../..');
const HEAD = ['source_desc', 'commodity_desc', 'class_desc', 'prodn_practice_desc', 'util_practice_desc',
  'statisticcat_desc', 'unit_desc', 'agg_level_desc', 'state_alpha', 'asd_desc', 'county_name', 'county_ansi',
  'year', 'freq_desc', 'reference_period_desc', 'value', 'cv_%'];
const row = (o) => HEAD.map(h => o[h] ?? '').join('\t');
const price = (crop, year, month, value, extra = {}) => row({
  source_desc: 'SURVEY', commodity_desc: crop, statisticcat_desc: 'PRICE RECEIVED', unit_desc: '$ / BU',
  agg_level_desc: 'STATE', state_alpha: 'NE', year: String(year), freq_desc: 'MONTHLY',
  reference_period_desc: month, value, ...extra,
});

describe('parseNassMonthlyPrices', () => {
  const tsv = [HEAD.join('\t'),
    price('CORN', 2020, 'FEB', '3.80'),
    price('CORN', 2020, 'JAN', '3.75'),
    price('SOYBEANS', 2020, 'JAN', '8.60'),
    price('CORN', 2020, 'MAR', '(D)'),                                       // withheld
    price('CORN', 2020, 'MARKETING YEAR', '3.90', { freq_desc: 'ANNUAL' }),  // not a month
    price('CORN', 2020, 'APR', '3.10', { agg_level_desc: 'NATIONAL', state_alpha: 'US' }),
    price('CORN', 2020, 'MAY', '3.20', { state_alpha: 'IA' }),
    price('CORN', 1974, 'DEC', '3.00'),                                      // before `from`
    price('WHEAT', 2020, 'JAN', '5.00'),
    row({ commodity_desc: 'CORN', statisticcat_desc: 'YIELD', agg_level_desc: 'STATE', state_alpha: 'NE',
      year: '2020', freq_desc: 'MONTHLY', reference_period_desc: 'JUN', value: '180' }),
    price('SOYBEANS', 2020, 'FEB', '1,008.50'),                              // thousands separator
  ].join('\n');

  test('reads Nebraska STATE monthly prices only, in month order', () => {
    const p = parseNassMonthlyPrices(tsv, { from: 1975 });
    assert.deepEqual([...p.CORN], [['2020-01', 3.75], ['2020-02', 3.8]]);
    assert.deepEqual([...p.SOYBEANS], [['2020-01', 8.6], ['2020-02', 1008.5]]);
    assert.equal(p.WHEAT, undefined);
  });

  test('a withheld month is left out, never read as $0, and the data module keeps it as null', () => {
    const p = parseNassMonthlyPrices(tsv + '\n' + price('CORN', 2020, 'APR', '4.00'), { from: 1975 });
    assert.equal(p.CORN.has('2020-03'), false);
    const d = priceHistoryData(p, { source: 'x', from: 1975 });
    assert.deepEqual(d.crops.CORN, { start: '2020-01', values: [3.75, 3.8, null, 4] });
    assert.deepEqual([...priceHistory('CORN', d)], [['2020-01', 3.75], ['2020-02', 3.8], ['2020-04', 4]]);
  });

  test('a missing column is an error, not an empty history', () => {
    assert.throws(() => parseNassMonthlyPrices('commodity_desc\tvalue\nCORN\t1'), /no "statisticcat_desc" column/);
  });

  test('months roll over the year', () => {
    assert.equal(nextMonth('2026-12'), '2027-01');
    assert.equal(nextMonth('2026-09'), '2026-10');
  });
});

describe('FARM_PRICE_HISTORY comes from the extract on disk', () => {
  const file = resolve(ROOT, FARM_PRICE_HISTORY.source);
  const text = gunzipSync(readFileSync(file)).toString('utf8');
  const data = priceHistoryData(parseNassMonthlyPrices(text, { from: FARM_PRICE_HISTORY.from }),
    { source: FARM_PRICE_HISTORY.source, from: FARM_PRICE_HISTORY.from });

  test('the generated file is byte for byte what the script would write', () => {
    const onDisk = readFileSync(resolve(ROOT, 'src/finance/farm/farm-price-history-data.js'), 'utf8');
    assert.equal(onDisk, renderPriceHistoryModule(data), 'stale: run npm run farm:price-history');
  });

  test('both crops, from January of the first year, with every month present', () => {
    for (const crop of ['CORN', 'SOYBEANS']) {
      const s = FARM_PRICE_HISTORY.crops[crop];
      assert.equal(s.start, `${FARM_PRICE_HISTORY.from}-01`);
      assert.ok(s.values.length >= 12 * 50, `${crop}: ${s.values.length} months`);
      assert.ok(s.values.every(v => v == null || (v > 0 && v < 100)), `${crop}: a price out of range`);
    }
  });

  test('accessors read the module: a range, the latest month', () => {
    const latest = latestPriceMonth('CORN');
    assert.match(latest, /^\d{4}-\d{2}$/);
    const year = latest.slice(0, 4);
    const months = priceHistoryBetween('CORN', `${year}-01`, `${year}-12`);
    assert.equal(months[0][0], `${year}-01`);
    assert.equal(months.at(-1)[0], latest);
    assert.equal(priceHistoryBetween('CORN', '1900-01', '1900-12').length, 0);
  });

  test('every chart reading it has its limits to say', () => {
    assert.equal(PRICE_HISTORY_LIMITS.length, 3);
    assert.ok(PRICE_HISTORY_LIMITS.some(s => /monthly/.test(s)) && PRICE_HISTORY_LIMITS.some(s => /basis/.test(s)));
  });
});
