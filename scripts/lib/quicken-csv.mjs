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
 * quicken-csv.mjs — the PARSE half of the Quicken importer: CSV text → a plain tree.
 *
 * This module knows about Quicken's export format and nothing about this repo's
 * holdings, allocations or accounts. The split is deliberate: the export format is
 * the part that changes when Quicken changes, and keeping it behind a plain data
 * structure means the mapping layer (`quicken-import.mjs`) can be tested against a
 * literal object instead of a fixture file full of private balances.
 *
 * ### The format, as it actually is
 *
 * "Investing - Portfolio Value - By Account", exported WITH lots. Hierarchy is
 * encoded in the LEADING WHITESPACE of column 0, not in a column:
 *
 *   `Terry Brokerage 567`                    ← 0 spaces: an ACCOUNT
 *   `    SCHWAB U.S. BROAD MARKETETF`        ← 4 spaces: an INSTRUMENT position
 *   `        3/13/2026`                      ← 8 spaces: a LOT
 *   `    Cash`                               ← 4 spaces, reserved name: the cash row
 *
 * Four things about it are traps rather than details:
 *
 * **1. The BOM is on every line, not just the first.** Quicken writes `﻿` at the
 * start of each record. A parser that strips it once gets a first column of
 * `"﻿Terry Brokerage 567"` on every row but the header, and the indentation
 * depth then reads one higher than it is.
 *
 * **2. `Add` is not a number, and it is not zero.** Quicken writes the literal string
 * `Add` in the Cost Basis column for a position whose acquisition it never saw (a
 * "placeholder" entry), and pairs it with a lot whose date is the word `Placeholder`.
 * Coercing that to 0 fabricates a 100% unrealized gain on the position. It is parsed
 * here as `null` with `basisUnknown: true` so the caller has to make a decision.
 *
 * **3. A bond carries no symbol.** Its only identity is the name, which has the
 * maturity glued to the end: `US TREASURY BILL26U S T BILL DUE 12/24/26`. That date
 * is the one piece of instrument data the export supplies for a bond, and
 * `parseBondName` is the only place it is recovered.
 *
 * **4. Names are HTML-escaped.** `Ssga S&amp;P 500 Index Fund Cl M`.
 *
 * The header block above the column row carries `Price and Holdings as of: <date>`,
 * which is the snapshot date the whole file is stated at. It is returned as `asOf`
 * because a portfolio import is only meaningful against the date it was taken — see
 * the importer's `simStart` handling.
 */

/** Column indices in the data rows, per the `,Account,Symbol,…` header row. */
const COL = Object.freeze({
  LABEL: 0, ACCOUNT: 1, SYMBOL: 2, PRICE: 3, SHARES: 4,
  COST_BASIS: 5, MARKET_VALUE: 6, GAIN: 7, GAIN_PCT: 8, TERM: 9, TYPE: 10,
});

/** Indentation, in spaces, of each level of the hierarchy. */
const DEPTH = Object.freeze({ ACCOUNT: 0, INSTRUMENT: 4, LOT: 8 });

/** The reserved instrument-row name Quicken uses for an account's cash sleeve. */
const CASH_ROW = 'Cash';

/** The lot date Quicken writes for a placeholder (unknown-acquisition) entry. */
const PLACEHOLDER_DATE = 'Placeholder';

/** The literal Quicken writes in a money column it has no figure for. */
const UNKNOWN_MONEY = 'Add';

/**
 * The currency sign that prefixes every money cell: `$`, `A$`, `US$`, `€`, `£`, `¥`.
 *
 * Anchored at the start and bounded to three letters so it cannot eat a stray letter out
 * of the middle of a cell and turn a malformed value into a plausible number.
 */
const CURRENCY_SIGN = /^[A-Za-z]{0,3}[$€£¥]/;

/** Every currency sign seen in a money cell, so the parse can report what it dropped. */
const currencySignOf = (raw) => CURRENCY_SIGN.exec(String(raw ?? '').trim().replace(/^-|^\(/, ''))?.[0] ?? null;

/**
 * Split one CSV line on commas, honouring `"…"` quoting and `""` escapes.
 *
 * Hand-rolled rather than pulled from a dependency because the money columns are
 * quoted precisely BECAUSE they contain commas (`"$1,267,004.52"`), so naive
 * splitting does not merely lose fidelity — it shifts every subsequent column.
 *
 * @param {string} line
 * @returns {string[]}
 */
export function splitCsvLine(line) {
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
      else quoted = !quoted;
    } else if (c === ',' && !quoted) {
      out.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

/** Decode the handful of HTML entities Quicken emits in security names. */
const unescapeHtml = (s) => String(s ?? '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/**
 * `"$1,267,004.52"` → `1267004.52`; `"-$135,930.10"` → `-135930.1`; `"Add"` → `null`.
 *
 * The currency sign is stripped rather than matched on `$`, because a Quicken file whose
 * home currency is not USD writes `A$320,952.90` — and a `$`-only strip leaves the `A`,
 * so `Number()` returns NaN and every money column in an AU export silently becomes
 * `null`. That is the worst failure available here: the importer reads a null basis as
 * "unknown", applies the unknown-basis policy, and writes a zero-value account with no
 * error. The CSV carries no currency column, so the sign is dropped, not interpreted —
 * `parseQuickenPortfolio` reports which signs it saw as `currencySigns` and the account's
 * currency stays the scenario's to declare.
 *
 * Returns `null` for anything that is not a number, which is the whole point — see
 * trap 2 in the header. A caller that wants a number must decide what an absent one
 * means rather than receiving a plausible zero.
 *
 * @param {string} raw
 * @returns {number|null}
 */
export function parseMoney(raw) {
  const s = String(raw ?? '').trim();
  if (s === '' || s === UNKNOWN_MONEY) return null;
  const neg = s.startsWith('-') || /^\(.*\)$/.test(s);
  const n = Number(s.replace(/[()\-,\s]/g, '').replace(CURRENCY_SIGN, ''));
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

/** `"14,747.483"` → `14747.483`; blank → `null`. Share counts carry no currency. */
export function parseUnits(raw) {
  const s = String(raw ?? '').trim().replace(/,/g, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * `"3/13/2026"` → `"2026-03-13"`; `"Placeholder"` and blanks → `null`.
 *
 * US M/D/YYYY, because the export is a US Quicken file and the header says so. Emitted
 * as a bare ISO DATE with no time and no zone: a holding's `purchaseDate` is compared
 * against period boundaries, and stamping a local-midnight `Date` here is how a lot
 * acquired on the 1st lands in the previous month for anyone west of UTC.
 *
 * @param {string} raw
 * @returns {string|null} `YYYY-MM-DD`
 */
export function parseUsDate(raw) {
  const s = String(raw ?? '').trim();
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (!m) return null;
  const [, mo, d, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/**
 * Recover a bond's maturity from its name — the export's only bond instrument data.
 *
 * `US TREASURY BILL26U S T BILL DUE 12/24/26` → `{ maturityDate: '2026-12-24' }`.
 *
 * The two-digit year is windowed to 2000-2099 rather than pivoted around 50: these are
 * live positions in a plan that starts in the 2020s, and a bond maturing in 1974 is not
 * a case worth handling correctly at the cost of a rule nobody can predict.
 *
 * Returns `null` when the name carries no `DUE` clause, which the importer treats as a
 * hard error for a BOND — a bond with no maturity cannot be unitised (see
 * `promoteToUnitised`, which requires BOTH `maturityDate` and `faceValue`) and would
 * silently stay a scalar lump that never redeems.
 *
 * @param {string} name
 * @returns {{ maturityDate: string }|null}
 */
export function parseBondName(name) {
  const m = /DUE\s+(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})/i.exec(String(name ?? ''));
  if (!m) return null;
  const [, mo, d, y] = m;
  const year = y.length === 2 ? `20${y}` : y;
  return { maturityDate: `${year}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}` };
}

/**
 * Parse a Quicken "Portfolio Value - By Account" export (with lots).
 *
 * @param {string} text - the raw file contents
 * @returns {{ asOf: string|null, createdOn: string|null, currencySigns: string[],
 *   accounts: Array<object> }}
 *   `currencySigns` is every distinct sign the money columns carried (`$`, `A$`, …).
 *   The export has no currency column, so this is the only evidence of which currency
 *   the figures are in — more than one sign in one file means the report mixes them and
 *   the totals cannot be summed.
 *   Each account is `{ name, cash, cashRaw, marketValue, costBasis, positions[] }`;
 *   each position `{ name, symbol, type, price, shares, costBasis, basisUnknown,
 *   marketValue, lots[] }`; each lot `{ purchaseDate, placeholder, shares, costBasis,
 *   basisUnknown, marketValue, term }`.
 * @throws when the column header row is absent — i.e. this is not that report.
 */
export function parseQuickenPortfolio(text) {
  // Strip the BOM everywhere, not once. See trap 1 in the header.
  const lines = String(text ?? '').replace(/﻿/g, '').split(/\r?\n/);

  const asOf = (() => {
    const hit = lines.find(l => /Price and Holdings as of:/i.test(l));
    return hit ? parseUsDate(hit.split(':').slice(1).join(':').trim())
              ?? (/(\d{4}-\d{2}-\d{2})/.exec(hit)?.[1] ?? null)
      : null;
  })();
  const createdOn = (() => {
    const hit = lines.find(l => /^\s*Created:/i.test(l));
    if (!hit) return null;
    const v = hit.split(':').slice(1).join(':').trim().replace(/,+$/, '');
    return parseUsDate(v) ?? (/(\d{4}-\d{2}-\d{2})/.exec(v)?.[1] ?? null);
  })();

  const headerIdx = lines.findIndex(l => /^,Account,Symbol,/.test(l));
  if (headerIdx === -1) {
    throw new Error(
      'quicken-csv: no `,Account,Symbol,…` header row found. This does not look like a '
      + 'Quicken "Investing - Portfolio Value - By Account" export.');
  }

  const accounts = [];
  const currencySigns = new Set();
  let account = null, position = null;

  for (const line of lines.slice(headerIdx + 1)) {
    if (line.trim() === '') continue;
    const fields = splitCsvLine(line);
    const label = fields[COL.LABEL] ?? '';
    const name = unescapeHtml(label.trim());
    if (name === '' ) continue;
    if (/^Totals$/i.test(name)) break;   // the grand-total footer closes the data

    for (const col of [COL.MARKET_VALUE, COL.COST_BASIS]) {
      const sign = currencySignOf(fields[col]);
      if (sign) currencySigns.add(sign);
    }

    const depth = label.length - label.trimStart().length;

    if (depth === DEPTH.ACCOUNT) {
      account = {
        name,
        cash: null,      // filled in by this account's `Cash` row, if it has one
        cashRaw: null,
        marketValue: parseMoney(fields[COL.MARKET_VALUE]),
        costBasis: parseMoney(fields[COL.COST_BASIS]),
        positions: [],
      };
      accounts.push(account);
      position = null;
      continue;
    }

    if (depth === DEPTH.INSTRUMENT) {
      if (!account) throw new Error(`quicken-csv: instrument row "${name}" before any account row.`);
      if (name === CASH_ROW) {
        account.cash = parseMoney(fields[COL.MARKET_VALUE]);
        account.cashRaw = (fields[COL.MARKET_VALUE] ?? '').trim();
        position = null;
        continue;
      }
      position = {
        name,
        symbol: unescapeHtml((fields[COL.SYMBOL] ?? '').trim()) || null,
        type: unescapeHtml((fields[COL.TYPE] ?? '').trim()) || null,
        price: parseUnits(fields[COL.PRICE]),
        shares: parseUnits(fields[COL.SHARES]),
        costBasis: parseMoney(fields[COL.COST_BASIS]),
        basisUnknown: (fields[COL.COST_BASIS] ?? '').trim() === UNKNOWN_MONEY,
        marketValue: parseMoney(fields[COL.MARKET_VALUE]),
        lots: [],
      };
      account.positions.push(position);
      continue;
    }

    if (depth === DEPTH.LOT) {
      if (!position) throw new Error(`quicken-csv: lot row "${name}" before any instrument row.`);
      position.lots.push({
        purchaseDate: parseUsDate(name),
        placeholder: name === PLACEHOLDER_DATE,
        shares: parseUnits(fields[COL.SHARES]),
        costBasis: parseMoney(fields[COL.COST_BASIS]),
        basisUnknown: (fields[COL.COST_BASIS] ?? '').trim() === UNKNOWN_MONEY,
        marketValue: parseMoney(fields[COL.MARKET_VALUE]),
        term: unescapeHtml((fields[COL.TERM] ?? '').trim()) || null,
      });
      continue;
    }

    throw new Error(`quicken-csv: unexpected indentation depth ${depth} on row "${name}".`);
  }

  return { asOf, createdOn, currencySigns: [...currencySigns], accounts };
}
