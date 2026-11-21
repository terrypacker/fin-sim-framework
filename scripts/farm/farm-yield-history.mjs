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
 * farm-yield-history.mjs — write the farm Monte Carlo's historical yield years from USDA NASS
 * (design 134 §17.13).
 *
 * Usage:
 *   npm run farm:yield-history                  # rewrite src/finance/farm/farm-yield-history-data.js
 *   npm run farm:yield-history -- --check       # say whether that file is current; write nothing
 *
 * Reads the newest docs/us-farm-markets/nass-qs-corn-soy-ne-us-*.tsv.gz. The parsing and the
 * file's format are src/finance/farm/farm-yield-history.js, which the test shares. β is the
 * calibrated `irrigatedYieldBeta` (FARM_CALIBRATION), the one the model applies.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parseFlags } from '../lib/cli.mjs';
import { heading, note } from '../lib/format.mjs';
import { parseNassCountyCornYields, yieldHistoryData, renderYieldHistoryModule }
  from '../../src/finance/farm/farm-yield-history.js';
import { FARM_CALIBRATION } from '../../src/finance/farm/farm-calibration.js';

const opts = parseFlags(process.argv.slice(2), {
  usage: 'npm run farm:yield-history -- [--check]\n\n'
       + 'farm-yield-history — Nebraska county corn yield years (USDA NASS) for the farm Monte Carlo.',
  data:  { type: 'string', help: 'the NASS extract (default: newest in docs/us-farm-markets/)' },
  check: { type: 'flag', help: 'exit 1 if the data file is not what the extract gives; write nothing' },
});

const root = resolve(import.meta.dirname, '../..');
const dir = resolve(root, 'docs/us-farm-markets');
const file = opts.data ? resolve(opts.data)
  : resolve(dir, readdirSync(dir).filter(f => /^nass-qs-corn-soy-ne-us-\d+\.tsv\.gz$/.test(f)).sort().at(-1));
const out = resolve(root, 'src/finance/farm/farm-yield-history-data.js');
const text = (file.endsWith('.gz') ? gunzipSync(readFileSync(file)) : readFileSync(file)).toString('utf8');

const from = FARM_CALIBRATION.from;
const data = yieldHistoryData(parseNassCountyCornYields(text, { from }),
  { source: relative(root, file), from, beta: FARM_CALIBRATION.irrigatedYieldBeta });
const module = renderYieldHistoryModule(data);

const rows = Object.values(data.counties).flat();
const years = rows.map(r => r[0]);
const ys = rows.map(r => r[1]).sort((a, b) => a - b);
heading(`Farm yield history — Nebraska county corn, ${from}–`);
note(`${Object.keys(data.counties).length} counties, ${rows.length} county-years, ${Math.min(...years)}–${Math.max(...years)}.`);
note(`Dryland deviation: worst ${(100 * ys[0]).toFixed(1)}%, 1st percentile ${(100 * ys[Math.floor(0.01 * (ys.length - 1))]).toFixed(1)}%, best ${(100 * ys.at(-1)).toFixed(1)}%.`);
note(`Source: ${relative(root, file)}`);

const current = existsSync(out) ? readFileSync(out, 'utf8') : null;
if (opts.check) {
  if (current === module) { note(`${relative(root, out)} is current.`); process.exit(0); }
  console.error(`${relative(root, out)} is not what the extract gives: run npm run farm:yield-history.`);
  process.exit(1);
}
if (current === module) note(`${relative(root, out)} unchanged.`);
else { writeFileSync(out, module); note(`Wrote ${relative(root, out)}.`); }
