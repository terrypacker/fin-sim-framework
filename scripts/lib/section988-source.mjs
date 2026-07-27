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
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Minimal RFC4180-ish splitter: handles quoted fields containing commas. */
function splitCsvLine(line) {
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

function parseNumber(raw) {
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
 * Read one account CSV into rows. Column names are matched case-insensitively and
 * loosely, so an export that says `Transaction Date` or `Debit/Credit` still lands.
 *
 * @returns {{ account: string, rows: object[], headers: string[] }}
 */
export function readAccountCsv(file, accountName) {
  const text = stripBom(readFileSync(file, 'utf8'));
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) throw new Error(`${file}: no data rows`);

  const headers = splitCsvLine(lines[0]).map((h) => h.trim());
  const find = (...names) => {
    for (const n of names) {
      const i = headers.findIndex((h) => h.toLowerCase() === n.toLowerCase());
      if (i >= 0) return i;
    }
    for (const n of names) {
      const i = headers.findIndex((h) => h.toLowerCase().includes(n.toLowerCase()));
      if (i >= 0) return i;
    }
    return -1;
  };

  const idx = {
    date: find('Date', 'Transaction Date'),
    description: find('Description', 'Narrative', 'Details'),
    amount: find('Amount'),
    balance: find('Balance'),
    kind: find('Kind'),
    businessFraction: find('BusinessFraction', 'Business Fraction'),
  };
  if (idx.date < 0 || idx.amount < 0) {
    throw new Error(`${file}: need at least Date and Amount columns; saw ${headers.join(', ')}`);
  }

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const date = normalizeDate(cells[idx.date]);
    const description = (idx.description >= 0 ? cells[idx.description] : '') ?? '';
    const amount = parseNumber(cells[idx.amount]);
    const balance = idx.balance >= 0 ? parseNumber(cells[idx.balance]) : null;
    // A row with no date and no amount is export padding, not data.
    if (!date && amount == null) continue;
    rows.push({
      account: accountName,
      sourceLine: i + 1,
      date,
      description: description.trim(),
      normalized: normalizeDescription(description),
      amount,
      balance,
      overrideKind: idx.kind >= 0 ? (cells[idx.kind] ?? '').trim().toUpperCase() || null : null,
      overrideBusinessFraction:
        idx.businessFraction >= 0 ? parseNumber(cells[idx.businessFraction]) : null,
    });
  }
  return { account: accountName, rows, headers };
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

/** @returns {{ rules: object[], warnings: string[] }} */
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
  return { rules, warnings };
}

/**
 * Apply rules to a row. Per-row CSV overrides beat rules; rules beat nothing at all.
 *
 * A row that matches no rule is returned unclassified rather than defaulted, and an
 * override that is malformed is returned as an ERROR rather than coerced. Both are the
 * same principle: in a path-dependent ledger a silent default becomes permanent, and
 * nobody ever finds it again.
 */
export function classifyRow(row, rules) {
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
    return {
      kind,
      businessFraction: kind === KIND.DISPOSE ? row.overrideBusinessFraction : undefined,
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
      return { kind: rule.kind, businessFraction: rule.businessFraction, via: `rule#${rule.index}`, note: rule.note };
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
    return { kind, businessFraction, via: `rule#${rule.index}${credit ? '/credit' : '/debit'}`, note: rule.note };
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

/**
 * Write the classified rows back out as a CSV carrying the two override columns,
 * pre-filled with whatever the rules inferred.
 *
 * This is the intended workflow for a large import: run once, open the emitted file,
 * correct the rows the rules got wrong, and feed *that* back in as the source. It turns
 * "label four thousand rows" into "fix the ones flagged", and every corrected row is an
 * override that no future rule change can silently undo.
 */
export function toClassifiedCsv(classified) {
  const esc = (s) => {
    const v = String(s ?? '');
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const lines = ['Date,Description,Amount,Balance,Kind,BusinessFraction,ClassifiedBy,Note'];
  for (const r of classified) {
    lines.push([
      r.date ?? '', esc(r.description), r.amount ?? '', r.balance ?? '',
      r.kind ?? '', r.businessFraction ?? '', r.via ?? '', esc(r.error ?? r.note ?? ''),
    ].join(','));
  }
  return `﻿${lines.join('\n')}\n`;
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
  const breaks = [];
  let prev = null;
  let prevRow = null;
  for (const row of rows) {
    if (row.balance == null) continue;
    if (prev != null) {
      const delta = row.balance - prev;
      const amount = row.amount ?? 0;
      const gap = delta - amount;
      if (Math.abs(gap) > tolerance) {
        breaks.push({
          date: row.date,
          sourceLine: row.sourceLine,
          description: row.description,
          previousBalance: prev,
          balance: row.balance,
          delta,
          amount,
          gap,
          afterDate: prevRow?.date ?? null,
        });
      }
    }
    prev = row.balance;
    prevRow = row;
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
export function reconcileInternal(classified, windowDays = 3) {
  const internals = classified.filter((r) => r.kind === KIND.INTERNAL && r.amount);
  const credits = internals.filter((r) => r.amount > 0);
  const debits = internals.filter((r) => r.amount < 0);
  const usedDebit = new Set();

  const dayDiff = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);
  const matched = [];
  for (const credit of credits) {
    const partner = debits.find(
      (d) =>
        !usedDebit.has(d) &&
        d.account !== credit.account &&
        Math.abs(Math.abs(d.amount) - credit.amount) < 0.005 &&
        dayDiff(d.date, credit.date) <= windowDays,
    );
    if (partner) { usedDebit.add(partner); matched.push({ credit, debit: partner }); }
  }
  return {
    matched,
    unmatchedCredits: credits.filter((c) => !matched.some((m) => m.credit === c)),
    unmatchedDebits: debits.filter((d) => !usedDebit.has(d)),
  };
}

/** Gate 4 — attach published rates, and separate "holiday" from "not published yet". */
export function attachRates(classified, rateTable) {
  const unresolved = [];
  const carried = [];
  for (const row of classified) {
    if (!row.date) continue;
    const r = rateTable.resolve(row.date);
    if (!r) {
      row.rate = null;
      const why = rateTable.lastDate && row.date > rateTable.lastDate ? 'not-yet-published' : 'outside-series';
      unresolved.push({ row, why });
      continue;
    }
    row.rate = r;
    if (r.carriedFrom) carried.push(row);
  }
  return { unresolved, carried };
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
    if (row.balance != null) y.balances.push(row.balance);
    if (row.date < y.first) y.first = row.date;
    if (row.date > y.last) y.last = row.date;
  }
  const years = [...byYear.values()].sort((a, b) => a.year.localeCompare(b.year));
  for (const y of years) {
    // Transaction-weighted, not time-weighted: good enough for a screen that only has
    // to distinguish "one lot held throughout" from "high churn", and it avoids
    // inventing a daily balance series the export does not contain.
    y.averageBalance = y.balances.length
      ? y.balances.reduce((s, b) => s + b, 0) / y.balances.length
      : null;

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
