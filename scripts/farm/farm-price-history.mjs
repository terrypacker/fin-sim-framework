#!/usr/bin/env node
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
 * farm-price-history.mjs — write the farm charts' price history from USDA NASS (design 134
 * §17.5, step 8a).
 *
 * Usage:
 *   npm run farm:price-history                  # rewrite src/finance/farm/farm-price-history-data.js
 *   npm run farm:price-history -- --check       # say whether that file is current; write nothing
 *   npm run farm:price-history -- --from 1990
 *
 * Reads the newest docs/us-farm-markets/nass-qs-corn-soy-ne-us-*.tsv.gz (refresh it with
 * fetch-sources.sh there). The parsing and the file's format are
 * src/finance/farm/farm-price-history.js, which the test shares.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parseFlags } from '../lib/cli.mjs';
import { columns, heading, note } from '../lib/format.mjs';
import {
  parseNassMonthlyPrices, priceHistoryData, renderPriceHistoryModule, PRICE_HISTORY_CROPS,
} from '../../src/finance/farm/farm-price-history.js';

/** The first year written. 1975 is after the early-1970s break in grain prices, and keeps the file small. */
const PRICE_HISTORY_FROM = 1975;

const opts = parseFlags(process.argv.slice(2), {
  usage: 'npm run farm:price-history -- [--from YEAR] [--check]\n\n'
       + 'farm-price-history — Nebraska monthly prices received (USDA NASS) for the farm charts.',
  from:  { type: 'number', default: PRICE_HISTORY_FROM, help: 'first year written' },
  data:  { type: 'string', help: 'the NASS extract (default: newest in docs/us-farm-markets/)' },
  check: { type: 'flag', help: 'exit 1 if the data file is not what the extract gives; write nothing' },
});

const root = resolve(import.meta.dirname, '../..');
const dir = resolve(root, 'docs/us-farm-markets');
const file = opts.data ? resolve(opts.data)
  : resolve(dir, readdirSync(dir).filter(f => /^nass-qs-corn-soy-ne-us-\d+\.tsv\.gz$/.test(f)).sort().at(-1));
const out = resolve(root, 'src/finance/farm/farm-price-history-data.js');
const text = (file.endsWith('.gz') ? gunzipSync(readFileSync(file)) : readFileSync(file)).toString('utf8');

const prices = parseNassMonthlyPrices(text, { from: opts.from });
const data = priceHistoryData(prices, { source: relative(root, file), from: opts.from });
const module = renderPriceHistoryModule(data);

heading(`Farm price history — Nebraska monthly prices received, ${opts.from}–`);
columns({
  rows: PRICE_HISTORY_CROPS.map(c => {
    const s = data.crops[c];
    const months = s.values.length;
    return { c, start: s.start ?? '—', months, gaps: s.values.filter(v => v == null).length,
      last: [...prices[c].keys()].at(-1) ?? '—', lastPrice: [...prices[c].values()].at(-1) };
  }),
  columns: [
    { head: 'crop', align: 'left', width: 10, get: r => r.c },
    { head: 'first', get: r => r.start },
    { head: 'last', get: r => r.last },
    { head: 'months', get: r => String(r.months) },
    { head: 'gaps', get: r => String(r.gaps) },
    { head: 'last $/bu', get: r => (r.lastPrice == null ? '—' : r.lastPrice.toFixed(2)) },
  ],
});
note(`Source: ${relative(root, file)}`);

const current = existsSync(out) ? readFileSync(out, 'utf8') : null;
if (opts.check) {
  if (current === module) { note(`${relative(root, out)} is current.`); process.exit(0); }
  console.error(`${relative(root, out)} is not what the extract gives: run npm run farm:price-history.`);
  process.exit(1);
}
if (current === module) note(`${relative(root, out)} unchanged.`);
else { writeFileSync(out, module); note(`Wrote ${relative(root, out)}.`); }
