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
 * csv-bom.test.mjs — the UTF-8 BOM contract for exported CSVs.
 *
 * Excel decodes a `.csv` with the system legacy codepage unless a BOM says
 * otherwise, so every non-ASCII character our tax reports emit (`§`, the FY en
 * dash, `≤`) arrives mangled without one. These tests pin three things:
 *
 *   1. the helpers themselves (prefix, idempotence, strip);
 *   2. that the CSV *builders* stay BOM-free — they return strings that get
 *      concatenated and compared, and a BOM mid-file is garbage;
 *   3. that the param CSV still round-trips once a BOM is on the front, which is
 *      the one place we both write and read our own CSV.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { UTF8_BOM, withBom, stripBom } from '../../src/utils/csv.js';
import { toCsv, WORKSHEET_COLUMNS }    from '../../src/finance/tax/tax-worksheet-export.js';
import { rowsToCsv }                   from '../../src/finance/journal-reporting/report-csv.js';
import { paramsToCsv, csvToParamUpdates } from '../../src/visualization/scenario/param-csv.js';

test('BOM-1: withBom prefixes U+FEFF and is idempotent', () => {
  assert.equal(UTF8_BOM, '﻿');
  assert.equal(withBom('a,b'), '﻿a,b');
  // Idempotent so a path that composes helpers cannot double-prefix.
  assert.equal(withBom(withBom('a,b')), '﻿a,b');
  // Nothing to mark up in an empty export — a lone BOM is not a valid CSV.
  assert.equal(withBom(''), '');
  assert.equal(withBom(null), '');
});

test('BOM-2: stripBom removes only a LEADING mark, and tolerates non-strings', () => {
  assert.equal(stripBom('﻿key,value'), 'key,value');
  assert.equal(stripBom('key,value'),       'key,value');
  // A U+FEFF inside a cell is data, not an encoding marker.
  assert.equal(stripBom('key,﻿value'), 'key,﻿value');
  assert.equal(stripBom(undefined), undefined);
});

test('BOM-3: the CSV builders emit no BOM — it belongs on the artifact', () => {
  // toCsv/rowsToCsv output gets concatenated, embedded and string-compared in
  // tests; the BOM is applied once at the file/Blob/stdout boundary instead.
  const row = Object.fromEntries(WORKSHEET_COLUMNS.map(c => [c, null]));
  assert.ok(!toCsv([{ ...row, label: 'x' }]).startsWith(UTF8_BOM));
  assert.ok(!rowsToCsv([{ a: 1 }]).startsWith(UTF8_BOM));
});

test('BOM-4: a BOM-prefixed CSV survives the header lookup that reads it back', () => {
  // Without stripBom the first header cell is `﻿key`, so the required-column
  // check rejects a file that is in fact perfectly well formed — both our own
  // exports and anything the user saved out of Excel.
  const csv = withBom(paramsToCsv([
    { name: 'monthlyExpenses', type: 'Money', value: 8000, currency: 'USD' },
  ]));
  assert.ok(csv.startsWith(UTF8_BOM));

  const [update] = csvToParamUpdates(csv);
  assert.equal(update.key, 'monthlyExpenses', 'the BOM did not fuse onto the key column');
  assert.equal(update.rawValue, '8000');
});

test('BOM-5: a non-ASCII label survives the BOM round-trip byte for byte', () => {
  // The § and the FY en dash are the characters that motivated the change; the
  // BOM must not disturb them.
  const csv = withBom('label\nFTC — §904 limit (FY 2025–26)');
  assert.equal(stripBom(csv).split('\n')[1], 'FTC — §904 limit (FY 2025–26)');
});
