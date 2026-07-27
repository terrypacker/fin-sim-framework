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
 * CSV byte-order-mark helpers.
 *
 * Excel does NOT sniff UTF-8 in a `.csv`: absent a BOM it decodes the bytes with
 * the system legacy codepage (Windows-1252 / Mac Roman), so every non-ASCII
 * character in our reports arrives mangled — `§904` renders as `Â§904`, the FY
 * en dash in `FY 2025–26` as `â€"`, `≤` in the FITO de-minimis line as `â‰¤`.
 * A leading U+FEFF is the only signal Excel honours, and it costs nothing
 * elsewhere: every other consumer (LibreOffice, Numbers, pandas, `csv` in Node)
 * either strips it or is told to via `encoding='utf-8-sig'`.
 *
 * The BOM belongs on the **artifact**, not in the CSV builders: `toCsv` and
 * `rowsToCsv` return strings that get concatenated, compared in tests and
 * embedded in other documents, and a BOM in the middle of a file is garbage.
 * So every place that hands bytes to a user — writeFileSync, stdout, Blob —
 * wraps at the boundary with `withBom`, and nothing else does.
 */

/** U+FEFF, the UTF-8 byte-order mark Excel needs to decode a CSV as UTF-8. */
export const UTF8_BOM = '﻿';

/**
 * Prefix CSV text with the UTF-8 BOM, ready to be written to a file, a Blob or
 * stdout. Idempotent: text that already carries a BOM is returned unchanged, so
 * wrapping twice on a path that composes helpers is harmless.
 *
 * @param {string} csv
 * @returns {string}
 */
export function withBom(csv) {
  if (csv == null || csv === '') return csv ?? '';
  return csv.startsWith(UTF8_BOM) ? csv : UTF8_BOM + csv;
}

/**
 * Strip a leading UTF-8 BOM from text read back in.
 *
 * Needed wherever we PARSE a CSV: a BOM left on the front of the first header
 * cell turns `key` into `﻿key`, so a header lookup silently misses. That is
 * true both of files we exported ourselves (round-trip) and of any CSV the user
 * saved out of Excel, which always writes one.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripBom(text) {
  return typeof text === 'string' && text.startsWith(UTF8_BOM) ? text.slice(1) : text;
}
