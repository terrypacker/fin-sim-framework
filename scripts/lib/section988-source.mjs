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
 * section988-source.mjs — ingest and validate real foreign-currency account history,
 * ahead of any §988 arithmetic. Design 87 §12; the calculation itself is G5.
 *
 * This module deliberately stops **before** computing a single dollar of gain. Every
 * error that matters in a §988 calculation is an ingest error — a missing row, a rate
 * from the wrong date, a debit misread as a disposition — and each one is silent and
 * permanent once a path-dependent ledger has consumed it. So the ingest gets its own
 * pass, its own report, and its own hard gates.
 *
 * ─── the classification model: TWO axes, not one ────────────────────────────────────
 *
 * The tempting design is one column reading Personal / Business / Ignored. It cannot
 * express the data, because two independent statutory questions are being asked:
 *
 *   AXIS 1 — `kind`: does this row move the ledger, and how?
 *            Governed by `§1.988-2(a)(1)(iii)`, which is about **mechanics**.
 *            Money leaving an account is NOT the taxable event: a withdrawal, and a
 *            transfer to another account in the same currency, are non-recognition
 *            events with carryover basis. Realization waits for a disposition.
 *
 *   AXIS 2 — `businessFraction`: what was the currency used for?
 *            Governed by `§1.988-1(a)(9)` / `§988(e)(3)`, which is about **purpose**,
 *            and it is a fraction ("to the extent"), not a flag. It decides whether
 *            §988 applies at all, and therefore whether the gain is ordinary or capital.
 *
 * They are orthogonal. An ACQUIRE has no business fraction — nothing was used for
 * anything. A single DISPOSE can be 60% business. "Ignored" is an Axis-1 value while
 * "Personal" and "Business" are Axis-2 values, so a one-column scheme silently forces a
 * choice between them.
 *
 * ─── and you should not hand-label rows ─────────────────────────────────────────────
 *
 * Ten years of transactions is thousands of rows and a handful of *patterns*. Rules
 * classify by description; the CSV's optional `Kind` / `BusinessFraction` columns are an
 * **override channel** for genuine one-offs, not the primary input. Anything no rule
 * matches lands in a loud unclassified bucket, grouped and ranked by materiality, so the
 * work is "make twelve decisions" rather than "label four thousand rows".
 *
 * Rules live in an external JSON file because real descriptions carry payee names —
 * keep yours in gitignored `scenarios/`. See `--rules` and RULES_SCHEMA below.
 */

import { readFileSync } from 'node:fs';

/**
 * Axis 3. Where an ACQUIRE's basis came from.
 *
 * `observed` means the export shows the currency entering the pool on that date, so the
 * published rate for that date IS the basis. `assumed` means it did not — the currency
 * was already held, its real acquisition is outside anything we can see, and stamping the
 * date we first observe it is a decision rather than a measurement.
 *
 * This is a THIRD axis and not a `kind`, for the same reason `businessFraction` is not:
 * a seeded acquisition does exactly what an acquisition does to the ledger. What differs
 * is how much the number is worth trusting, and folding that into `kind` would repeat the
 * one-column mistake this module's header is about.
 *
 * It exists because the alternative is worse than being wrong — it is being wrong
 * INVISIBLY. Flipping an unmatched INTERNAL credit to ACQUIRE is the right move and the
 * conservative one, but the row then looks identical to a real acquisition, and a figure
 * that began life as "we had to assume something" becomes a fact nobody ever revisits.
 * Marked `assumed`, it stays on the report forever, with the rate it was stamped at, so a
 * later run with better records can go straight to what needs revising.
 */
export const BASIS = { OBSERVED: 'observed', ASSUMED: 'assumed' };

/**
 * ─── stating WHAT the assumption is ─────────────────────────────────────────────────
 *
 * `assumed` says a basis was decided rather than measured; it does not say what the
 * decision WAS. Left there, the only expressible assumption is "use the day the currency
 * first appears", which is the one case we know to be wrong — currency already held when
 * the window opens was, by definition, acquired earlier.
 *
 * Two optional columns say what to use instead, and they are separate from `Date` on
 * purpose. The transaction date is a FACT: it orders the ledger walk, drives footing, and
 * decides which lots FIFO consumes. Re-dating a row to reach a better rate corrupts all
 * three to fix one, and the corrupted version still looks perfectly plausible. "When the
 * money arrived" and "when its basis was established" are two facts and need two columns.
 *
 *   `BasisDate` — an ISO date, or a `from..to` window whose published rates are averaged.
 *                 The window is the honest form for salary accumulated across years: no
 *                 single day established that basis, and picking one implies a precision
 *                 the records do not have.
 *   `BasisRate` — an explicit USD per AUD. Wins over everything, for a blend computed
 *                 outside this tool or a deliberate what-if.
 *
 * Both are refused on anything but an ACQUIRE already marked `assumed`. An `observed`
 * acquisition means the export SHOWS the currency entering on that date, so the date's
 * rate is the basis by definition — a basis date on one is a contradiction, not an
 * override, and silently upgrading it to `assumed` would let the file's most consequential
 * flag get set as a side effect of filling in a different column.
 */
export const BASIS_FROM = {
  ROW_DATE: 'row-date',
  STATED_DATE: 'stated-date',
  AVERAGED: 'averaged-window',
  STATED_RATE: 'stated-rate',
};

/** `2008-01-01..2016-06-10` — a window to average, rather than a single day. */
const WINDOW_RE = /^(\d{4}-\d{2}-\d{2})\s*\.\.\s*(\d{4}-\d{2}-\d{2})$/;

/** Axis 1. What this row does to the ledger. */
export const KIND = {
  /** Currency enters the pool. Basis is stamped at the published rate for the date. */
  ACQUIRE: 'ACQUIRE',
  /** Currency is disposed of — converted, or exchanged for property or services. */
  DISPOSE: 'DISPOSE',
  /**
   * Same-currency movement between accounts inside the pool. `§1.988-2(a)(1)(iii)(E)`:
   * non-recognition, basis carries over. If BOTH accounts are ingested these net to
   * nothing; if only one is, this row marks currency crossing the boundary of what we
   * can see — which is why {@link reconcileInternal} exists.
   */
  INTERNAL: 'INTERNAL',
  /** No ledger effect at all: zero-amount noise, markers, headers. */
  IGNORE: 'IGNORE',
};

export const RULES_SCHEMA = `
{
  "poolCurrency": "AUD",
  "rules": [
    {
      "match": "substring, case-insensitive",        // or use "regex"
      "regex": "^Interest Charged",                  // optional, takes precedence
      "kind": "ACQUIRE | DISPOSE | INTERNAL | IGNORE",
      "businessFraction": 0.0,                       // DISPOSE only; 0..1
      "note": "why — this ends up in the audit trail"
    },

    // SIGN-AWARE form. Most payees run BOTH directions — an FX broker, a savings
    // sweep, a landlord who also refunds. One "kind" cannot describe them, and
    // hand-labelling every row is the wrong answer to a systematic problem.
    // Give the credit and debit sides their own treatment instead:
    {
      "match": "OzForex",
      "creditKind": "ACQUIRE",                       // amount > 0
      "debitKind": "DISPOSE",                        // amount < 0
      "debitBusinessFraction": 0.0,                  // needed on a DISPOSE side only
      "note": "FX broker: money in is a conversion INTO the pool, money out is a conversion OUT"
    }
  ]
}
Rules are tried in order; first match wins. Put specific rules above general ones.

A rule must give EITHER "kind" OR at least one of "creditKind"/"debitKind". If a
sign-aware rule omits the side a row lands on, the row stays unclassified rather than
falling through to a later rule — a partial rule is a statement that that side needs a
decision, not an invitation to guess.

Per-row CSV columns "Kind" and "BusinessFraction" override rules entirely. Use them for
genuine one-offs; use sign-aware rules for anything systematic.
`;

/* ────────────────────────────────── parsing ────────────────────────────────────── */

/** Strip a UTF-8 BOM. Bank and spreadsheet exports routinely carry one. */
export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Minimal RFC4180-ish splitter: handles quoted fields containing commas. */
export function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

export function parseNumber(raw) {
  const s = (raw ?? '').trim().replace(/[,$]/g, '');
  if (s === '') return null;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalise a bank date. Accepts ISO (`2016-06-09`) and US short (`6/30/16`), because
 * a single export routinely mixes them across columns.
 */
export function normalizeDate(raw) {
  const s = (raw ?? '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (m) {
    const [, mm, dd, yy] = m;
    const year = yy.length === 2 ? (Number(yy) >= 70 ? `19${yy}` : `20${yy}`) : yy;
    return `${year}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  return null;
}

/**
 * Parse a date that is REQUIRED to be readable, and throw with the offending text when
 * it is not.
 *
 * The soft {@link normalizeDate} returning `null` is the right answer for a genuinely
 * blank cell, but it fails open on a *mangled* one — and the round trip through Excel is
 * exactly where dates get mangled, because Excel rewrites `2016-05-04` in whatever the
 * machine's locale is on save. An unreadable date does not stop the run today: the row
 * still loads, still foots (footing is balance-driven), and then quietly drops out of the
 * FX gate and the turnover measurement, which both filter on `date`. That is a row
 * silently exempted from the only two checks that could catch it.
 */
export function requireDate(raw, where) {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const parsed = normalizeDate(s);
  if (!parsed) {
    throw new Error(
      `${where}: cannot read the date "${s}".\n`
      + '  Accepted: YYYY-MM-DD, or M/D/YY(YY). If this file came back from a spreadsheet,\n'
      + '  it rewrote the dates on save — format the Date column as text or as YYYY-MM-DD.\n'
      + '  This is fatal on purpose: an unreadable date loads fine and then silently skips\n'
      + '  the FX-rate gate and the turnover measurement.');
  }
  return parsed;
}

/**
 * Collapse a description to a pattern key: lowercase, digits stripped, whitespace
 * squeezed. Reference numbers and amounts embedded in descriptions would otherwise make
 * every row look unique and defeat the whole point of grouping the unclassified bucket.
 */
export function normalizeDescription(raw) {
  return (raw ?? '')
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/[^a-z#\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Locate the header row and build a column finder over it.
 *
 * The header is FOUND rather than assumed to be line 1, because bank exports come in two
 * shapes: a plain table, and a report that buries the table under a title and filter
 * criteria and closes it with totals. Both are the same data; only the packaging differs,
 * and requiring hand-editing before ingest would put a manual step in front of the one
 * tool whose job is to catch what hand-editing gets wrong.
 *
 * @returns {{ at: number, headers: string[], find: (...names: string[]) => number }}
 */
function findHeaderRow(file, lines, required, limit = 60) {
  for (let i = 0; i < Math.min(lines.length, limit); i++) {
    const headers = splitCsvLine(lines[i]).map((h) => h.trim());
    const find = (...names) => {
      for (const n of names) {
        const j = headers.findIndex((h) => h.toLowerCase() === n.toLowerCase());
        if (j >= 0) return j;
      }
      for (const n of names) {
        const j = headers.findIndex((h) => h.toLowerCase().includes(n.toLowerCase()));
        if (j >= 0) return j;
      }
      return -1;
    };
    if (required.every((names) => find(...names) >= 0)) return { at: i, headers, find };
  }
  throw new Error(
    `${file}: no header row carrying ${required.map((n) => n[0]).join(' and ')} in the first ${limit} lines`);
}

/**
 * Read one account CSV into rows. Column names are matched case-insensitively and
 * loosely, so an export that says `Transaction Date` or `Debit/Credit` still lands.
 *
 * Handles both export shapes (see {@link findHeaderRow}), returns rows in CHRONOLOGICAL
 * order whichever way the file was sorted, and composes a description from Payee and
 * Category when the export splits them instead of providing one — which is what makes
 * rules written against one account's descriptions match another's.
 *
 * @returns {{ account: string, rows: object[], headers: string[], skipped: number }}
 */
export function readAccountCsv(file, accountName) {
  const text = stripBom(readFileSync(file, 'utf8'));
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) throw new Error(`${file}: no data rows`);

  const { at: headerAt, headers, find } = findHeaderRow(file, lines, [['Date', 'Transaction Date'], ['Amount']]);

  const idx = {
    date: find('Date', 'Transaction Date'),
    description: find('Description', 'Narrative', 'Details'),
    amount: find('Amount'),
    balance: find('Balance'),
    kind: find('Kind'),
    businessFraction: find('BusinessFraction', 'Business Fraction'),
    // An emitted file carries every account in one sheet, which is what makes it
    // editable in one pass. The column is what lets it be read back apart again —
    // see the per-account footing note below.
    account: find('Account'),
    basisSource: find('BasisSource', 'Basis Source'),
    basisDate: find('BasisDate', 'Basis Date'),
    basisRate: find('BasisRate', 'Basis Rate'),
    // Split by some exports, pre-joined by others. See the composition below.
    payee: find('Payee', 'Merchant'),
    category: find('Category'),
  };

  const rows = [];
  let skipped = 0;
  for (let i = headerAt + 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const rawDate = (cells[idx.date] ?? '').trim();
    const amount = parseNumber(cells[idx.amount]);
    // A row with no date is furniture — export padding, or a report's `Balance:` and
    // `Total Outflows:` trailer. Tested BEFORE the date is demanded, so trailing blanks
    // are not fatal; a date that is present but UNREADABLE still is, which is the case
    // that matters after a spreadsheet round trip.
    if (!rawDate) { if (amount != null) skipped++; continue; }

    // Some exports give one Description; others split it into Payee and Category. Joining
    // them reproduces the pre-joined form exactly ("Transfer" + "Transfer:[Offset 8776…]"
    // → "Transfer Transfer:[Offset 8776…]"), so a rule written against one account's
    // descriptions matches the same transaction seen from the other side of it.
    const description = idx.description >= 0
      ? ((cells[idx.description] ?? '').trim())
      : [idx.payee, idx.category].filter((j) => j >= 0)
        .map((j) => (cells[j] ?? '').trim()).filter(Boolean).join(' ');

    const balance = idx.balance >= 0 ? parseNumber(cells[idx.balance]) : null;
    const date = requireDate(rawDate, `${file} line ${i + 1}`);
    rows.push({
      // A per-row Account column wins over the --csv label, so one edited sheet can
      // carry the whole pool. Without the column every row takes the label, which is
      // the single-account case and unchanged.
      account: (idx.account >= 0 ? (cells[idx.account] ?? '').trim() : '') || accountName,
      sourceLine: i + 1,
      date,
      description: description.trim(),
      normalized: normalizeDescription(description),
      amount,
      balance,
      overrideKind: idx.kind >= 0 ? (cells[idx.kind] ?? '').trim().toUpperCase() || null : null,
      overrideBusinessFraction:
        idx.businessFraction >= 0 ? parseNumber(cells[idx.businessFraction]) : null,
      overrideBasisSource:
        idx.basisSource >= 0 ? (cells[idx.basisSource] ?? '').trim().toLowerCase() || null : null,
      overrideBasisDate:
        idx.basisDate >= 0 ? (cells[idx.basisDate] ?? '').trim() || null : null,
      // Kept as the RAW text, not parsed here. `parseNumber` maps junk to null, which is
      // indistinguishable from an empty cell — and a typo silently becoming "no override"
      // is how a stated basis goes missing without anyone being told.
      overrideBasisRate:
        idx.basisRate >= 0 ? (cells[idx.basisRate] ?? '').trim() || null : null,
    });
  }
  if (rows.length === 0) throw new Error(`${file}: header found at line ${headerAt + 1} but no data rows below it`);

  // Chronological, whichever way the export was sorted. Footing walks the balance column
  // forwards, so a newest-first file read as-is reports a break on every single row.
  const ascending = rows[0].date <= rows[rows.length - 1].date;
  const ordered = ascending ? rows : rows.reverse();

  // `seq` is position in TRUE order; `sourceLine` is position in the file. They agree
  // only for an oldest-first export, and the difference is not cosmetic: two rows on one
  // date must stay in the order the balance column steps through them, and in a
  // newest-first file that is DESCENDING sourceLine. Sorting on sourceLine silently
  // reversed same-date pairs on the way out, and the next ingest read the balance moving
  // the wrong way — 72 phantom footing breaks, none of them a missing row.
  ordered.forEach((row, i) => { row.seq = i; });
  return { account: accountName, rows: ordered, headers, skipped };
}

/* ──────────────────────────────── classification ───────────────────────────────── */

/**
 * Validate one side of a rule (or a plain `kind` rule, where side is null).
 *
 * The line between a throw and a warning is whether a **decision is missing**. A DISPOSE
 * with no business fraction is missing the decision that picks ordinary vs capital, and
 * no default is safe, so it stops the run. A stray fraction on an ACQUIRE is redundant
 * rather than ambiguous — it signals a mental model worth correcting, but the run can
 * proceed, so it warns.
 */
function validateSide(file, i, side, kind, businessFraction, warnings) {
  const where = side ? `${side} side of rule ${i}` : `rule ${i}`;
  if (!KIND[kind]) throw new Error(`${file}: ${where} has invalid kind "${kind}"`);
  if (kind === KIND.DISPOSE && businessFraction == null) {
    throw new Error(
      `${file}: ${where} is a DISPOSE and must state businessFraction (0..1).\n` +
      '  A DISPOSE decides ordinary-vs-capital, so an unstated fraction is a missing\n' +
      '  decision, not a zero. §1.988-1(a)(9).');
  }
  if (businessFraction != null && kind !== KIND.DISPOSE) {
    warnings.push(
      `rule ${i}: businessFraction is set on a ${kind} and will be ignored. Only a `
      + 'DISPOSE has a use — nothing was used for anything on an acquisition or a transfer.');
  }
  if (businessFraction != null && (businessFraction < 0 || businessFraction > 1)) {
    throw new Error(`${file}: ${where} businessFraction must be 0..1`);
  }
}

/** @returns {{ rules: object[], warnings: string[], card: object|null }} */
export function loadRules(file) {
  const spec = JSON.parse(stripBom(readFileSync(file, 'utf8')));
  if (!Array.isArray(spec.rules)) throw new Error(`${file}: expected a "rules" array`);
  const warnings = [];
  const rules = spec.rules.map((r, i) => {
    // A `decide` rule matches deliberately WITHOUT classifying: it says "this pattern is
    // identified, and it needs a per-row answer a pattern cannot give". A mixed-use
    // credit-card payment is the canonical case — its §162/§212 share is whatever was
    // bought on the card that month, which no description can know. Better a red gate
    // than a plausible-looking fraction nobody revisits.
    if (r.decide) return { ...r, index: i, decideOnly: true, matcher: r.regex ? new RegExp(r.regex, 'i') : null };
    const signAware = r.creditKind != null || r.debitKind != null
      || r.creditDecide != null || r.debitDecide != null;
    if (!signAware && !r.kind) {
      throw new Error(`${file}: rule ${i} must give "kind", or "creditKind"/"debitKind"`);
    }
    if (signAware && r.kind) {
      throw new Error(`${file}: rule ${i} mixes "kind" with sign-aware keys — pick one form`);
    }
    if (signAware) {
      // A side may be decided (`creditKind`) or deferred (`creditDecide`), not both.
      // One direction is often certain while the other is not: an FX broker's credits
      // acquire currency and need no use test at all, while its debits dispose of it
      // and their §162/§212 share is a real question.
      for (const side of ['credit', 'debit']) {
        if (r[`${side}Kind`] && r[`${side}Decide`]) {
          throw new Error(`${file}: rule ${i} gives both ${side}Kind and ${side}Decide`);
        }
        if (r[`${side}Kind`]) {
          validateSide(file, i, side, r[`${side}Kind`], r[`${side}BusinessFraction`], warnings);
        }
      }
    } else {
      validateSide(file, i, null, r.kind, r.businessFraction, warnings);
    }
    return { ...r, index: i, signAware, matcher: r.regex ? new RegExp(r.regex, 'i') : null };
  });
  // The card block lives here rather than on the command line because it names your own
  // bookkeeping categories, and this file is already the gitignored one.
  return { rules, warnings, card: spec.card ?? null };
}

/**
 * Apply rules to a row. Per-row CSV overrides beat rules; rules beat nothing at all.
 *
 * A row that matches no rule is returned unclassified rather than defaulted, and an
 * override that is malformed is returned as an ERROR rather than coerced. Both are the
 * same principle: in a path-dependent ledger a silent default becomes permanent, and
 * nobody ever finds it again.
 */
/**
 * `assumed` is a claim about where an ACQUIRE's basis came from, so it has nowhere to
 * live on any other kind. On a DISPOSE it is meaningless — a disposal consumes basis, it
 * does not establish any. On an INTERNAL it is worse than meaningless: a same-currency
 * transfer carries basis over from the other leg (§1.988-2(a)(1)(iii)(E)), so the honest
 * move for a leg whose partner is invisible is to make it an ACQUIRE and say so, not to
 * leave it INTERNAL and quietly annotate it.
 */
function validateBasisSource(source, kind) {
  if (!source) return null;
  if (!Object.values(BASIS).includes(source)) {
    return `BasisSource must be ${Object.values(BASIS).join(' or ')}, got "${source}"`;
  }
  if (source === BASIS.ASSUMED && kind !== KIND.ACQUIRE) {
    return `BasisSource "assumed" is only meaningful on an ACQUIRE, not a ${kind}`;
  }
  return null;
}

/**
 * Validate `BasisDate` / `BasisRate` and say which mechanism the row is asking for.
 *
 * Errors rather than warnings throughout: every one of these is a stated intention that
 * could not be honoured, and the alternative to refusing is computing a basis the author
 * did not ask for while their column sits in the file looking like it took effect.
 *
 * @returns {{ error: string }|{ basisFrom: string, basisDate?, basisWindow?, basisRate? }}
 */
function validateBasisOverride(row, kind, source) {
  const date = row.overrideBasisDate;
  const rate = row.overrideBasisRate;
  if (!date && !rate) return { basisFrom: BASIS_FROM.ROW_DATE };

  const named = [date && 'BasisDate', rate && 'BasisRate'].filter(Boolean).join(' and ');
  if (kind !== KIND.ACQUIRE) {
    return { error: `${named} is only meaningful on an ACQUIRE, not a ${kind}` };
  }
  if (source !== BASIS.ASSUMED) {
    return {
      error: `${named} requires BasisSource "assumed" — an observed acquisition takes its `
        + 'basis from the date the export shows the currency entering, by definition',
    };
  }

  if (rate) {
    // Stated on BOTH: refused rather than ranked. A precedence rule is easy to write and
    // impossible to see in a spreadsheet, and the row would quietly ignore whichever
    // column lost — most likely the one just edited.
    if (date) return { error: 'BasisDate and BasisRate are both set — state one, not both' };
    const parsed = Number.parseFloat(rate.replace(/[,$]/g, ''));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return { error: `BasisRate must be a positive number, got "${rate}"` };
    }
    // `basisRateValue`, not `basisRate`: the latter is where {@link attachRates} puts the
    // RESOLVED rate object, and one field holding a bare number on some rows and an object
    // on others is the kind of thing that reads fine and crashes six callers later.
    return { basisFrom: BASIS_FROM.STATED_RATE, basisRateValue: parsed };
  }

  const window = WINDOW_RE.exec(date);
  if (window) {
    const [, from, to] = window;
    if (from > to) return { error: `BasisDate window runs backwards: "${date}"` };
    return { basisFrom: BASIS_FROM.AVERAGED, basisWindow: { from, to } };
  }
  const single = normalizeDate(date);
  if (!single) {
    return {
      error: `cannot read BasisDate "${date}" — want YYYY-MM-DD, or a window `
        + 'YYYY-MM-DD..YYYY-MM-DD to average across',
    };
  }
  return { basisFrom: BASIS_FROM.STATED_DATE, basisDate: single };
}

export function classifyRow(row, rules) {
  const classified = classifyKind(row, rules);
  // Layered on AFTER whichever path decided the kind, rather than inside each of them.
  // A row can reach a kind through a CSV override, a plain rule or either side of a
  // sign-aware rule, and a basis override stated on a rule-classified row has to be
  // honoured (or refused) exactly as it would be on a hand-labelled one. Validating at
  // each return point instead means the one path someone forgets is the path where a
  // filled-in column silently does nothing.
  if (!classified.kind) return classified;
  const basis = validateBasisOverride(row, classified.kind, classified.basisSource);
  if (basis.error) {
    return { ...classified, kind: null, via: classified.via, error: basis.error };
  }
  return { ...classified, ...basis };
}

function classifyKind(row, rules) {
  // ── per-row CSV override, validated exactly as strictly as a rule ──────────────
  if (row.overrideKind) {
    const kind = row.overrideKind;
    if (!KIND[kind]) {
      return { kind: null, via: 'csv-override', error: `invalid Kind "${kind}"` };
    }
    if (kind === KIND.DISPOSE && row.overrideBusinessFraction == null) {
      return { kind: null, via: 'csv-override', error: 'DISPOSE override needs BusinessFraction' };
    }
    if (row.overrideBusinessFraction != null && kind !== KIND.DISPOSE) {
      return { kind: null, via: 'csv-override', error: `BusinessFraction set on a ${kind}` };
    }
    if (row.overrideBusinessFraction != null
        && (row.overrideBusinessFraction < 0 || row.overrideBusinessFraction > 1)) {
      return { kind: null, via: 'csv-override', error: 'BusinessFraction must be 0..1' };
    }
    const basisError = validateBasisSource(row.overrideBasisSource, kind);
    if (basisError) return { kind: null, via: 'csv-override', error: basisError };
    return {
      kind,
      businessFraction: kind === KIND.DISPOSE ? row.overrideBusinessFraction : undefined,
      basisSource: row.overrideBasisSource ?? undefined,
      via: 'csv-override',
    };
  }

  // A zero-amount row cannot move basis whatever it is called.
  if (row.amount === 0) return { kind: KIND.IGNORE, businessFraction: undefined, via: 'zero-amount' };

  for (const rule of rules) {
    const hit = rule.matcher
      ? rule.matcher.test(row.description)
      : (rule.match && row.description.toLowerCase().includes(rule.match.toLowerCase()));
    if (!hit) continue;

    if (rule.decideOnly) {
      return { kind: null, via: `rule#${rule.index}`, needsDecision: true, error: rule.decide };
    }
    if (!rule.signAware) {
      return { kind: rule.kind, businessFraction: rule.businessFraction, basisSource: rule.basisSource, via: `rule#${rule.index}`, note: rule.note };
    }
    // Sign-aware: pick the side this row landed on.
    const credit = (row.amount ?? 0) > 0;
    const defer = credit ? rule.creditDecide : rule.debitDecide;
    if (defer) {
      return { kind: null, via: `rule#${rule.index}${credit ? '/credit' : '/debit'}`, needsDecision: true, error: defer };
    }
    const kind = credit ? rule.creditKind : rule.debitKind;
    const businessFraction = credit ? rule.creditBusinessFraction : rule.debitBusinessFraction;
    if (!kind) {
      // The rule matched but says nothing about this side. Stop here rather than
      // falling through: a partial rule means that side needs a decision.
      return {
        kind: null,
        via: `rule#${rule.index}`,
        error: `rule matched but has no ${credit ? 'creditKind' : 'debitKind'}`,
      };
    }
    const basisSource = credit ? rule.creditBasisSource : rule.debitBasisSource;
    return { kind, businessFraction, basisSource, via: `rule#${rule.index}${credit ? '/credit' : '/debit'}`, note: rule.note };
  }
  return { kind: null, businessFraction: null, via: 'unclassified' };
}

/**
 * Find rules that classified BOTH credits and debits under a single non-sign-aware
 * `kind`. This is almost always wrong and is exactly the failure a bulk import runs
 * into: one payee that both pays you and gets paid, collapsed to one treatment.
 *
 * It is separate from {@link checkSigns}, which catches the *contradiction* (an
 * ACQUIRE with a negative amount). This catches the quieter case where the sign check
 * passes because the kind is INTERNAL or IGNORE — where no sign is "wrong" — and yet
 * the two directions plainly mean different things.
 */
export function findSignAmbiguousRules(classified, rules) {
  const byRule = new Map();
  for (const row of classified) {
    if (!row.via?.startsWith('rule#') || row.via.includes('/')) continue; // skip sign-aware
    // INTERNAL and IGNORE are direction-SYMMETRIC: a same-currency transfer is
    // non-recognition whichever way it runs, and noise is noise. Only ACQUIRE and
    // DISPOSE assert a direction, so only they can be caught facing the wrong way.
    // Flagging the symmetric kinds would make this gate cry wolf on every transfer
    // rule, and a gate that always fires is a gate nobody reads.
    if (row.kind !== KIND.ACQUIRE && row.kind !== KIND.DISPOSE) continue;
    const index = Number.parseInt(row.via.slice(5), 10);
    if (!byRule.has(index)) byRule.set(index, { index, credits: 0, debits: 0, creditGross: 0, debitGross: 0, kind: row.kind });
    const b = byRule.get(index);
    if ((row.amount ?? 0) > 0) { b.credits++; b.creditGross += row.amount; }
    else if ((row.amount ?? 0) < 0) { b.debits++; b.debitGross += Math.abs(row.amount); }
  }
  return [...byRule.values()]
    .filter((b) => b.credits > 0 && b.debits > 0)
    .map((b) => ({ ...b, rule: rules[b.index] }))
    .sort((a, b) => (b.creditGross + b.debitGross) - (a.creditGross + a.debitGross));
}

export const STATUS = {
  OK: 'OK',
  DECIDE: 'DECIDE',
  UNMATCHED: 'UNMATCHED',
  REJECTED: 'REJECTED',
};

/**
 * One word for what a row needs from you, so the emitted sheet sorts and filters on a
 * single column.
 *
 * Blank-`Kind` already separates done from not-done, but it cannot tell the three
 * not-done cases apart, and they want opposite responses: UNMATCHED wants a new *rule*
 * (it is a pattern nobody has described yet), DECIDE wants a per-*row* answer that no
 * pattern could give, and REJECTED is your own edit coming back refused.
 */
export function classificationStatus(row) {
  if (row.kind) return STATUS.OK;
  if (row.needsDecision) return STATUS.DECIDE;
  if (row.error) return STATUS.REJECTED;
  return STATUS.UNMATCHED;
}

/**
 * Write the classified rows back out as a CSV carrying the two override columns,
 * pre-filled with whatever the rules inferred.
 *
 * This is the intended workflow for a large import: run once, open the emitted file,
 * correct the rows the rules got wrong, and feed *that* back in as the source. It turns
 * "label four thousand rows" into "fix the ones flagged", and every corrected row is an
 * override that no future rule change can silently undo.
 *
 * Columns are ordered for that job rather than for reading: Status, Kind and
 * BusinessFraction come first because they are the three you filter and type in.
 *
 * **A REJECTED row echoes back what you typed, not a blank.** `classifyRow` refuses a
 * malformed override and returns `kind: null`, so emitting `row.kind` would erase the
 * edit — the round trip would silently launder your typo into "never classified", and
 * the next sheet would look like you had not touched the row at all.
 */
export function toClassifiedCsv(classified) {
  const esc = (s) => {
    const v = String(s ?? '');
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const lines = [
    'Status,Kind,BusinessFraction,BasisSource,BasisDate,BasisRate,Date,Account,Description,Amount,Balance,ClassifiedBy,Note,SourceLine',
  ];
  for (const r of classified) {
    const status = classificationStatus(r);
    const rejected = status === STATUS.REJECTED;
    const kind = r.kind ?? (rejected ? r.overrideKind : null);
    const fraction = r.businessFraction ?? (rejected ? r.overrideBusinessFraction : null);
    // Echoed from the RAW override text, exactly as Kind and BusinessFraction are. These
    // two round-trip as what was typed rather than as what was parsed, so a rejected
    // window or a slipped decimal comes back visible next to its refusal instead of being
    // laundered into an empty cell that looks like it was never filled in.
    lines.push([
      status, kind ?? '', fraction ?? '',
      r.basisSource ?? (rejected ? r.overrideBasisSource : null) ?? '',
      esc(r.overrideBasisDate ?? ''), esc(r.overrideBasisRate ?? ''),
      r.date ?? '', esc(r.account), esc(r.description), r.amount ?? '', r.balance ?? '',
      r.via ?? '', esc(r.error ?? r.note ?? ''), r.sourceLine ?? '',
    ].join(','));
  }
  return `﻿${lines.join('\n')}\n`;
}

/**
 * Split rows into their accounts, preserving relative order within each.
 *
 * Footing is the reason this exists. `balance` is a per-account running total, so
 * `footLedger` is only meaningful over one account's rows in their own order — run it
 * across a merged sheet and every switch between accounts manufactures a break that is
 * not there. The emitted CSV deliberately merges accounts into one editable sheet, so
 * the split has to happen on the way back in.
 */
/**
 * Every row whose basis was assumed rather than observed, with what it was stamped at.
 *
 * Reported unconditionally and forever — not as an open item, because it is a decision
 * already taken, but as a standing disclosure. The figure it produces is the one most
 * likely to be quietly promoted to fact: it looks like any other acquisition in every
 * downstream total, and nothing else would ever mention that it began as a guess.
 *
 * `usdBasis` is what the assumption actually buys, so a later run with real records can
 * be diffed against it directly rather than re-derived.
 */
export function seededBasis(classified) {
  const entries = classified
    .filter((r) => r.basisSource === BASIS.ASSUMED && r.kind === KIND.ACQUIRE)
    .map((r) => {
      // The rate that will actually BE the basis — a stated one where the row states one,
      // the row's own date otherwise. Reporting `row.rate` here regardless would show the
      // market rate on the day the money appeared while the ledger quietly used something
      // else, which is the one discrepancy this section exists to make impossible.
      const used = r.basisRate ?? r.rate ?? null;
      return {
        date: r.date,
        account: r.account,
        description: r.description,
        aud: r.amount,
        usdPerAud: used?.usdPerAud ?? null,
        usdBasis: used?.usdPerAud != null ? r.amount * used.usdPerAud : null,
        basisFrom: r.basisFrom ?? BASIS_FROM.ROW_DATE,
        // What the row would have been stamped at with no override, so the report can
        // show the cost of the assumption rather than just its result.
        rowDateRate: r.rate?.usdPerAud ?? null,
        stated: r.overrideBasisRate ?? r.overrideBasisDate ?? null,
        observations: used?.observations ?? null,
      };
    })
    .sort((a, b) => b.aud - a.aud);
  const aud = entries.reduce((s, e) => s + e.aud, 0);
  const usd = entries.reduce((s, e) => s + (e.usdBasis ?? 0), 0);
  return { entries, aud, usd, rows: entries.length };
}

export function groupByAccount(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.account ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()].map(([account, accountRows]) => ({ account, rows: accountRows }));
}

/* ───────────────────────────────── validation ──────────────────────────────────── */

/**
 * Gate 1 — does the ledger foot?
 *
 * `balance[i] - balance[i-1]` must equal `amount[i]`. A break means a row is missing,
 * and a missing row is unrecoverable later: a missing credit is a missing lot, a missing
 * debit means lots that were never consumed, and both propagate through every subsequent
 * disposition because the ledger is path-dependent.
 *
 * Note this catches rows whose `Amount` is *stated* as zero while the balance moved —
 * a naive reader loses those silently.
 */
export function footLedger(rows, tolerance = 0.005) {
  const dated = rows.filter((r) => r.balance != null);

  // A SPLIT transaction — one payment divided across several categories — is exported as
  // several rows that all carry the SAME closing balance, because the balance only moved
  // once. Compared row by row those produce a pair of equal-and-opposite breaks that net
  // to zero, which reads exactly like a missing row and is not one. Group consecutive
  // rows sharing a balance and test the group's total against the single step it made.
  //
  // Grouping on the balance alone is safe: two genuinely separate movements can only
  // leave the balance unchanged if one of them is zero, and a zero-amount row cannot move
  // basis whatever it is called.
  const groups = [];
  for (const row of dated) {
    const last = groups[groups.length - 1];
    if (last && last.balance === row.balance) last.rows.push(row);
    else groups.push({ balance: row.balance, rows: [row] });
  }

  const breaks = [];
  for (let i = 1; i < groups.length; i++) {
    const g = groups[i];
    const prev = groups[i - 1];
    const delta = g.balance - prev.balance;
    const amount = g.rows.reduce((s, r) => s + (r.amount ?? 0), 0);
    const gap = delta - amount;
    if (Math.abs(gap) <= tolerance) continue;
    const row = g.rows[0];
    breaks.push({
      date: row.date,
      sourceLine: row.sourceLine,
      description: row.description,
      previousBalance: prev.balance,
      balance: g.balance,
      delta,
      amount,
      gap,
      split: g.rows.length > 1 ? g.rows.length : undefined,
      afterDate: prev.rows[prev.rows.length - 1].date ?? null,
    });
  }
  return breaks;
}

/** Gate 2 — signs must agree with the classification. */
export function checkSigns(classified) {
  const problems = [];
  for (const row of classified) {
    const { kind, amount } = row;
    if (amount == null || amount === 0) continue;
    if (kind === KIND.ACQUIRE && amount < 0) problems.push({ row, expected: 'credit', saw: amount });
    if (kind === KIND.DISPOSE && amount > 0) problems.push({ row, expected: 'debit', saw: amount });
  }
  return problems;
}

/**
 * Gate 3 — do internal transfers reconcile?
 *
 * An INTERNAL debit from an ingested account should meet an INTERNAL credit in another
 * ingested account on or near the same date. One that does not means currency crossed
 * into or out of an account we cannot see — and since basis carries over on these,
 * an unmatched INTERNAL credit is **currency of unknown basis entering the pool**. That
 * is the single most damaging gap in the whole exercise, so it is reported separately
 * from every other kind of complaint.
 */
/**
 * The counter-account a row names, if it names one: `Transfer:[ISaver 870697593]`.
 *
 * This is the only evidence in the file about WHERE a transfer went, and ignoring it is
 * what let the matcher pair the wrong legs.
 */
function namedCounterAccount(row) {
  const m = /Transfer:\[([^\]]+)\]/i.exec(row.description ?? '');
  return m ? m[1].trim().toLowerCase() : null;
}

export function reconcileInternal(classified, windowDays = 3) {
  const internals = classified.filter((r) => r.kind === KIND.INTERNAL && r.amount);
  const credits = internals.filter((r) => r.amount > 0);
  const debits = internals.filter((r) => r.amount < 0);
  const usedDebit = new Set();

  const dayDiff = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);

  const canPair = (credit, debit) =>
    debit.account !== credit.account
    && Math.abs(Math.abs(debit.amount) - credit.amount) < 0.005
    && dayDiff(debit.date, credit.date) <= windowDays
    // Two legs of ONE transfer name EACH OTHER's accounts, so they can never name the
    // SAME third account. Safe as a hard filter rather than a preference: for a true pair
    // the credit names the debit's account and vice versa, so their names differ whenever
    // the accounts do — which is already required above. It can only reject wrong pairs.
    && !(namedCounterAccount(credit) && namedCounterAccount(debit) === namedCounterAccount(credit));

  // Nearest in time first, so a same-day leg is tried before one three days out.
  const options = credits.map((credit) => debits
    .filter((d) => canPair(credit, d))
    .sort((a, b) => dayDiff(a.date, credit.date) - dayDiff(b.date, credit.date)));

  // MAXIMUM matching, not greedy. Taking the first free partner for each credit in turn
  // can strand a later credit whose only remaining option was already consumed — and the
  // report then calls that credit currency of unknown basis, which is the most serious
  // thing this tool says. Real days do this routinely: three separate transfers of one
  // amount between four accounts on one date, where a perfect assignment exists and
  // greedy finds two of three. Kuhn's augmenting path re-seats earlier credits to make
  // room, so a credit is reported unmatched only when NO assignment could have paired it.
  //
  // Note what this does and does not claim. It proves a partner EXISTS; where several
  // identical transfers share a date it does not prove this particular partner is the
  // true one. That is the right guarantee here — the gate asks whether basis is knowable.
  const partnerOf = new Map();                       // debit -> index of the credit holding it
  const augment = (creditIndex, seen) => {
    for (const debit of options[creditIndex]) {
      if (seen.has(debit)) continue;
      seen.add(debit);
      const held = partnerOf.get(debit);
      if (held === undefined || augment(held, seen)) {
        partnerOf.set(debit, creditIndex);
        return true;
      }
    }
    return false;
  };
  for (let i = 0; i < credits.length; i++) augment(i, new Set());

  const matched = [];
  for (const [debit, creditIndex] of partnerOf) {
    usedDebit.add(debit);
    matched.push({ credit: credits[creditIndex], debit });
  }
  matched.sort((a, b) => (a.credit.date ?? '').localeCompare(b.credit.date ?? ''));
  return {
    matched,
    unmatchedCredits: credits.filter((c) => !matched.some((m) => m.credit === c)),
    unmatchedDebits: debits.filter((d) => !usedDebit.has(d)),
  };
}

/**
 * The mean published rate across a window, and how many observations backed it.
 *
 * The COUNT is returned, not just the mean, because a window landing on a stretch the
 * series does not cover averages whatever few points it found and reports a confident
 * number from them. A one-observation "average" and a two-thousand-observation one are
 * not the same claim, and only one of them should survive review.
 */
export function averageRate(rateTable, from, to) {
  let sum = 0;
  let n = 0;
  for (const d of rateTable._dates) {
    if (d < from) continue;
    if (d > to) break;
    const v = rateTable._obs.get(d);
    if (v != null) { sum += v; n++; }
  }
  return n ? { usdPerAud: sum / n, observations: n } : null;
}

/**
 * Gate 4 — attach published rates, and separate "holiday" from "not published yet".
 *
 * Also resolves the SEPARATE basis rate an assumed ACQUIRE may state (see {@link
 * BASIS_FROM}). It is attached as `row.basisRate` and never written over `row.rate`: the
 * two answer different questions, both belong in the audit trail, and a row that quietly
 * re-used one field for both would make a stated basis indistinguishable from a market
 * rate the moment it left this function.
 */
export function attachRates(classified, rateTable) {
  const unresolved = [];
  const carried = [];
  const basisIssues = [];

  // A stated rate outside everything the series has ever printed is far more likely a
  // decimal-point slip than a discovery. 0.87 typed as 87 multiplies basis by a hundred
  // and produces a loss so large it looks like a different exercise.
  let lo = Infinity;
  let hi = -Infinity;
  for (const d of rateTable._dates) {
    const v = rateTable._obs.get(d);
    if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; }
  }

  for (const row of classified) {
    if (!row.date) continue;
    const r = rateTable.resolve(row.date);
    if (!r) {
      row.rate = null;
      const why = rateTable.lastDate && row.date > rateTable.lastDate ? 'not-yet-published' : 'outside-series';
      unresolved.push({ row, why });
    } else {
      row.rate = r;
      if (r.carriedFrom) carried.push(row);
    }

    if (!row.basisFrom || row.basisFrom === BASIS_FROM.ROW_DATE) continue;

    if (row.basisFrom === BASIS_FROM.STATED_RATE) {
      if (row.basisRateValue < lo || row.basisRateValue > hi) {
        basisIssues.push({
          row,
          why: `BasisRate ${row.basisRateValue} is outside everything the series has ever `
            + `printed (${lo.toFixed(4)}–${hi.toFixed(4)}) — check the decimal point`,
        });
        continue;
      }
      row.basisRate = { usdPerAud: row.basisRateValue, quotedDate: null, carriedFrom: null };
      continue;
    }

    if (row.basisFrom === BASIS_FROM.STATED_DATE) {
      const b = rateTable.resolve(row.basisDate);
      if (!b) { basisIssues.push({ row, why: `no published rate for BasisDate ${row.basisDate}` }); continue; }
      row.basisRate = b;
      continue;
    }

    const { from, to } = row.basisWindow;
    const avg = averageRate(rateTable, from, to);
    if (!avg) { basisIssues.push({ row, why: `no published rates in the window ${from}..${to}` }); continue; }
    row.basisRate = { usdPerAud: avg.usdPerAud, quotedDate: null, carriedFrom: null, observations: avg.observations, window: { from, to } };
  }
  return { unresolved, carried, basisIssues };
}

/* ─────────────────────────── the two design-87 G6 measurements ─────────────────── */

/**
 * G6 measurement 1 — pool structure.
 *
 * FIFO and pro-rata converge when the pool is effectively one lot held throughout, and
 * diverge as turnover rises. Turnover is annual disposals over average balance: near 0
 * means a fill-once/drain-slowly pool where the convention hardly matters; the higher it
 * goes, the more the choice is worth arguing about — and the shorter FIFO's lot ages
 * become, which is what decides whether the capital branch (G10) is long-term.
 */
/**
 * The pool's average balance per year: each account's own average, SUMMED.
 *
 * `balance` is a per-account running total, so pooling every row's balance and taking one
 * mean answers a question nobody asked — and gets the direction wrong. Adding five small
 * savings accounts to one large offset account dragged the reported balance DOWN, because
 * their few hundred dollars entered the average as equal-weighted samples. Turnover is
 * disposals ÷ this number, and turnover is what decides how far FIFO and pro-rata can
 * diverge, so the error propagates straight into the convention choice.
 *
 * An account with no rows in a year still holds money, so its last known balance is
 * carried forward. Before an account's first row it contributes nothing, which is right:
 * it did not exist yet.
 */
function averagePoolBalanceByYear(classified, years) {
  const byAccount = new Map();
  for (const row of classified) {
    if (!row.date || row.balance == null) continue;
    const key = row.account ?? '';
    if (!byAccount.has(key)) byAccount.set(key, new Map());
    const perYear = byAccount.get(key);
    const year = row.date.slice(0, 4);
    if (!perYear.has(year)) perYear.set(year, []);
    perYear.get(year).push(row.balance);
  }

  const totals = new Map(years.map((y) => [y, 0]));
  for (const perYear of byAccount.values()) {
    let carried = null;                       // last balance this account was seen at
    for (const year of years) {
      const seen = perYear.get(year);
      if (seen && seen.length) {
        // Transaction-weighted, not time-weighted: enough to tell "one lot held
        // throughout" from "high churn" without inventing a daily balance series the
        // export does not contain.
        carried = seen.reduce((s, b) => s + b, 0) / seen.length;
      }
      if (carried != null) totals.set(year, totals.get(year) + carried);
    }
  }
  return totals;
}

export function measurePoolStructure(classified) {
  const byYear = new Map();
  for (const row of classified) {
    if (!row.date || row.amount == null) continue;
    const year = row.date.slice(0, 4);
    if (!byYear.has(year)) {
      byYear.set(year, {
        year, disposed: 0, acquired: 0, balances: [], first: row.date, last: row.date,
        unclassifiedGross: 0, unclassifiedRows: 0,
      });
    }
    const y = byYear.get(year);
    if (row.kind === KIND.DISPOSE) y.disposed += Math.abs(row.amount);
    if (row.kind === KIND.ACQUIRE) y.acquired += row.amount;
    // Track what this year's figures are BLIND to. An unclassified row contributes to
    // neither total, so a year that is mostly unclassified reports a turnover near zero
    // and looks like a dormant pool — the exact opposite of the truth. Without this the
    // measurement silently reports the backlog rather than the account.
    if (row.kind == null) { y.unclassifiedGross += Math.abs(row.amount); y.unclassifiedRows++; }
    if (row.date < y.first) y.first = row.date;
    if (row.date > y.last) y.last = row.date;
  }
  const years = [...byYear.values()].sort((a, b) => a.year.localeCompare(b.year));
  const poolBalances = averagePoolBalanceByYear(classified, years.map((y) => y.year));
  for (const y of years) {
    y.averageBalance = poolBalances.get(y.year) ?? null;

    // ANNUALISE. A partial year — the first and last years of any export, and the
    // current one — otherwise reports a fraction of a year's disposals against a full
    // year's balance and understates turnover badly. Left raw, the first run of this
    // tool reported a 47-year implied lot age from two months of 2016.
    y.coverageDays = Math.max(1, Math.round((Date.parse(y.last) - Date.parse(y.first)) / 86400000) + 1);
    y.partial = y.coverageDays < 350;
    const annualFactor = 365 / y.coverageDays;
    y.turnover = y.averageBalance > 0 ? (y.disposed / y.averageBalance) * annualFactor : null;
    // How much of the year's activity this row cannot see. Above ~20% the turnover
    // figure describes the backlog, not the account.
    const known = y.acquired + y.disposed;
    y.blindFraction = (known + y.unclassifiedGross) > 0
      ? y.unclassifiedGross / (known + y.unclassifiedGross)
      : 0;
    y.unreliable = y.blindFraction > 0.2;
    // Under FIFO, 1/turnover is roughly how long a lot survives before it is consumed —
    // the number that decides long- vs short-term on the capital branch (G10).
    y.impliedLotAgeYears = y.turnover > 0 ? 1 / y.turnover : null;
  }
  return years;
}

/**
 * G6 measurement 2 — does the personal branch have survivors?
 *
 * §988(e)(2) excludes personal gains of \$200 or less per transaction, so if no personal
 * disposition can realistically clear \$200 then FIFO's only advantage over pro-rata —
 * supplying a holding period for the capital branch — is worth nothing.
 *
 * **This is a screen, not a calculation.** True gain needs the lot ledger. What is
 * computable now is the rate move a disposition would *need*: gain in USD is
 * `D × (q_disp − q_acq)` with `q` in USD per AUD, so clearing \$200 needs
 *
 *     |Δq| > 200 / D
 *
 * Comparing that threshold against how far the AUD actually moves over a plausible
 * holding period tells you whether survivors are common, rare, or impossible — without
 * pretending to know which lots were consumed.
 */
export function screenPersonalSurvivors(classified, rateTable, horizonYears = 2) {
  const personal = classified.filter(
    (r) => r.kind === KIND.DISPOSE && r.amount && (r.businessFraction ?? 0) < 1,
  );

  // Empirical: how far does USD-per-AUD move across `horizonYears`, historically?
  const dates = rateTable._dates;
  const moves = [];
  const step = Math.round(252 * horizonYears);
  for (let i = step; i < dates.length; i += 21) {
    const a = rateTable.resolve(dates[i - step]);
    const b = rateTable.resolve(dates[i]);
    if (a && b) moves.push(Math.abs(b.usdPerAud - a.usdPerAud));
  }
  moves.sort((a, b) => a - b);
  const pct = (p) => (moves.length ? moves[Math.min(moves.length - 1, Math.floor(moves.length * p))] : null);
  const median = pct(0.5);

  const scored = personal.map((row) => {
    const personalUnits = Math.abs(row.amount) * (1 - (row.businessFraction ?? 0));
    const requiredMove = personalUnits > 0 ? 200 / personalUnits : Infinity;
    return { row, personalUnits, requiredMove, likelyClears: median != null && requiredMove < median };
  });

  return {
    horizonYears,
    moveDistribution: { p25: pct(0.25), median, p75: pct(0.75), p90: pct(0.9), samples: moves.length },
    dispositions: scored,
    count: scored.length,
    likelyClearing: scored.filter((s) => s.likelyClears).length,
  };
}
