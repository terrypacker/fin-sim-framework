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
 * probe-spending-composition.mjs — design 89 §3, §4 and §10, reproducible.
 *
 * Design 89 asks "what fraction of the plan's outflow is actually spending?" and
 * answers it from a table of shares by action type. That table was taken once by a
 * throwaway script, and by the time the design was reviewed it had moved enough to
 * change the headline number (§14). Shares go stale; the classification does not.
 * So this is committed: §3 is a measurement anyone can re-run, not a quotation.
 *
 * It prints four things:
 *
 *   1. RAW      — every negative `.balance` delta by action type, summed at FACE
 *                 VALUE. This is the number §3 originally reported, and it is
 *                 denominated in nothing: the reference plan's debits are a mix of
 *                 USD and AUD accounts (see the currency split at the end).
 *   2. CONVERTED — the same cut run through the REAL report machinery
 *                 (`runReport` + `reportCurrency`), so every row is converted at
 *                 the run's own USD/AUD rate on the row's own date. This is design
 *                 89 §11.1 phase 0, and the delta column is the size of the defect.
 *   3. §4       — `LOAN_PAYMENT_APPLY` split by field, which is where the mortgage
 *                 double-count and design 86's interest offset both show up.
 *   4. §10      — the 3x trap: `EXPENSE_DEBIT` is journaled once per reducer, so
 *                 summing `action.data.amount` returns exactly 3x the truth.
 *
 * ─── why the converted pass uses the shipped reports ─────────────────────────
 *
 * The whole point of phase 0 is that design 89 §9.1's own FX proposal was obsolete:
 * `report-currency.js` (`JournalFxRates` + `ReportDefinition.reportCurrency`) already
 * converts per row at the row's own date. Re-implementing that here would measure a
 * private copy rather than the thing the report will actually use. So the converted
 * pass composes two SHIPPED definitions — `money-moved-by-action`'s group-by-actionType
 * query and `debits-from-account`'s `stateDelta < 0` filter — and runs them through
 * `runReport`. If this probe and the app ever disagree, that is a bug, not drift.
 *
 * That composition also makes the report's own scope visible: the shipped defs scope
 * to `api.accountBalanceKeys()`, which is whatever `StateSchemaRegistry` registered.
 * The RAW pass has no such scope, so comparing the two universes tells us which
 * balance-bearing state keys the report cannot see. That is reported as COVERAGE, and
 * it is a finding rather than a nuisance — a category the report structurally cannot
 * reach must not be drawn as zero.
 *
 * Usage:
 *   node scripts/probes/probe-spending-composition.mjs [--scenario <file.json>] [--index <n>]
 *
 *   --scenario <file>  workbench export to run; omitted => the synthetic default,
 *                      which is a smoke test and NOT a statement about a plan.
 */

import { openSim }                        from '../lib/run.mjs';
import { loadBaseConfig, parseSourceArgs, describeSource } from '../lib/scenario-source.mjs';
import { ServiceRegistry }                from '../../src/services/service-registry.js';
import { ReportDefinition, ReportDefinitionRegistry } from '../../src/finance/journal-reporting/report-definition-registry.js';
import { createReportApis, runReport }    from '../../src/finance/journal-reporting/run-report.js';

const BASE = 'USD';   // the currency the CONVERTED pass states its totals in

// ─── the probe's report: two shipped definitions, composed ───────────────────

/**
 * Debits only, grouped by action type, converted to one currency.
 *
 * `buildQuery` delegates to the registered `money-moved-by-action` definition and
 * appends the `stateDelta < 0` predicate `debits-from-account` uses. Nothing about
 * the query, the scoping or the conversion is written here.
 */
class DebitsByActionTypeDef extends ReportDefinition {
  constructor(moneyMovedDef) { super(); this._inner = moneyMovedDef; }

  get id()      { return 'probe-debits-by-action-type'; }
  get title()   { return 'Debits by Action Type'; }
  get perDiff() { return true; }

  reportCurrency(_params) { return BASE; }

  get defaultGroupBy()    { return ['actionType']; }
  get defaultAggregates() {
    return {
      count: { fn: 'count'                       },
      debit: { fn: 'sum', field: 'absStateDelta' },
    };
  }

  buildQuery(params, api) {
    return {
      op: 'and',
      conditions: [
        this._inner.buildQuery(params, api),
        { op: 'lt', field: 'stateDelta', value: 0 },
      ],
    };
  }
}

// ─── run ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help')) {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL(import.meta.url), 'utf8');
  // The file's own doc comment is the usage text — one copy, never out of date.
  // Search for the close AFTER the open: the license header above closes first.
  const from = src.indexOf('/**');
  console.log(src.slice(from, src.indexOf('*/', from) + 2));
  process.exit(0);
}

const source = loadBaseConfig(parseSourceArgs(argv));
const cfg    = source.cfg;

const sim = openSim(cfg, { telemetry: 'full' });
sim.stepTo(new Date(cfg.simEnd));

const services = ServiceRegistry.getInstance();
const journal  = sim.journal;
const entries  = journal.journal ?? [];

console.log('design 89 §3/§4/§10 — spending composition');
console.log(describeSource(source));
console.log(`journal: ${entries.length} entries\n`);

// ─── pass 1: RAW, face value ─────────────────────────────────────────────────

const rawByType = new Map();      // actionType -> face-value debit total
const rawByField = new Map();     // `${type}|${field}` -> face-value debit total
const rawKeys   = new Set();      // every state key that carried a debit
const byCurrency = new Map();     // account currency code -> face-value debit total
let rawTotal = 0;

for (const e of entries) {
  const type = e.action?.type ?? '(none)';
  for (const d of (e.stateDiff ?? [])) {
    const field = d.field ?? '';
    if (!field.endsWith('.balance')) continue;
    const delta = d.delta ?? 0;
    if (!(delta < 0)) continue;

    const amount = -delta;
    rawTotal += amount;
    rawByType.set(type, (rawByType.get(type) ?? 0) + amount);
    rawByField.set(`${type}|${field}`, (rawByField.get(`${type}|${field}`) ?? 0) + amount);
    rawKeys.add(field);

    const code = sim.state?.[field.slice(0, -'.balance'.length)]?.currency?.code ?? '(undeclared)';
    byCurrency.set(code, (byCurrency.get(code) ?? 0) + amount);
  }
}

// ─── pass 2: CONVERTED, through the shipped report machinery ─────────────────

const registry = new ReportDefinitionRegistry();
const def      = new DebitsByActionTypeDef(registry.get('money-moved-by-action'));
const apis     = createReportApis(journal, services);
const report   = await runReport(def, {}, apis);

const convByType = new Map();
let convTotal = 0;
for (const g of report.groups) {
  // `key` is an object keyed by the groupBy fields (see _labelAccountGroups).
  const type   = g.key?.actionType ?? '(none)';
  const amount = Math.abs(g.debit ?? 0);
  convByType.set(String(type), amount);
  convTotal += amount;
}

// ─── the table ───────────────────────────────────────────────────────────────

const pct  = (v, t) => t > 0 ? `${(100 * v / t).toFixed(2)}%` : '—';
const types = [...new Set([...rawByType.keys(), ...convByType.keys()])]
  .sort((a, b) => (convByType.get(b) ?? 0) - (convByType.get(a) ?? 0)
               || (rawByType.get(b)  ?? 0) - (rawByType.get(a)  ?? 0));

console.log(`§3 — every negative .balance delta, by action type`);
console.log(`     RAW total is a face-value sum across currencies; CONVERTED is ${BASE}` +
            ` at the run's own rate, per row, on the row's own date.\n`);
console.log(`${'action type'.padEnd(34)} ${'RAW'.padStart(8)} ${'CONV'.padStart(8)} ${'shift'.padStart(8)}`);
console.log('-'.repeat(62));
for (const t of types) {
  const raw  = rawByType.get(t)  ?? 0;
  const conv = convByType.get(t);
  const rawS  = 100 * raw / rawTotal;
  const convS = conv == null ? null : 100 * conv / convTotal;
  const shift = convS == null ? 'not seen' : `${(convS - rawS >= 0 ? '+' : '')}${(convS - rawS).toFixed(2)}`;
  console.log(`${t.padEnd(34)} ${pct(raw, rawTotal).padStart(8)} ` +
              `${(convS == null ? '—' : `${convS.toFixed(2)}%`).padStart(8)} ${shift.padStart(8)}`);
}
console.log('-'.repeat(62));
console.log(`${'(state keys / groups)'.padEnd(34)} ${String(rawKeys.size).padStart(8)} ` +
            `${String(report.groups.length).padStart(8)}`);
console.log('     `shift` is in PERCENTAGE POINTS of each column\'s own total, and the two');
console.log('     totals are not the same universe — see COVERAGE below. Dropping keys from');
console.log('     the CONVERTED denominator pushes every surviving share UP, so a share that');
console.log('     falls anyway (EXPENSE_DEBIT) is an FX effect larger than the number shown.\n');

// ─── currency mix: why the RAW column is denominated in nothing ──────────────

// ─── §3's headline: how much of the total is genuine household outflow ───────
//
// The allowlist is INLINE and deliberately minimal — this is §3's arithmetic, not
// design 89 §8's classification module. It carries only the types that are wholly
// spending; LOAN_PAYMENT_APPLY is partial (§4) and added as its interest share.
// Anything not named here is not spending, and anything UNKNOWN is called out, which
// is §7(a)'s rule in miniature.
const SPENDING = new Set([
  'EXPENSE_DEBIT', 'AU_TAX_PAYMENT_DEBIT', 'US_TAX_PAYMENT_DEBIT', 'STATE_TAX_PAYMENT_DEBIT',
]);
const NOT_SPENDING = new Set([
  'HOLDING_TRANSACT', 'REPLENISH_SAVINGS', 'REVALUE_ASSET_APPLY', 'IRA_RMD_APPLY',
  'K401_TO_IRA_CONVERSION_APPLY', 'ROTH_CONVERSION_APPLY', 'REBALANCE_TO_TARGET_APPLY',
  'US_HOUSE_SALE_APPLY', 'AU_HOUSE_SALE_APPLY', 'LOAN_PAYMENT_APPLY',
]);

// §4: only the interest portion of a loan payment is spending. Measured, not assumed.
let loanInterest = 0, loanPayment = 0;
for (const e of entries) {
  if (e.action?.type !== 'LOAN_PAYMENT_APPLY') continue;
  const d = e.action.data ?? e.action;
  loanInterest += d.interest ?? 0;
  loanPayment  += d.payment  ?? 0;
}
const interestShare = loanPayment > 0 ? loanInterest / loanPayment : 0;

const headline = (byType, total, label) => {
  let spend = 0; const unknown = [];
  for (const [t, v] of byType) {
    if (SPENDING.has(t)) spend += v;
    else if (!NOT_SPENDING.has(t)) unknown.push(t);
  }
  const loan = byType.get('LOAN_PAYMENT_APPLY') ?? 0;
  const withLoan = spend + loan * interestShare;
  console.log(`     ${label.padEnd(11)} genuine outflow ${pct(withLoan, total).padStart(8)}` +
              `  ⇒ the naive total overstates spending by ` +
              `${withLoan > 0 ? `${(100 * (total - withLoan) / withLoan).toFixed(0)}%` : '—'}`);
  if (loan > 0) {
    console.log(`     ${''.padEnd(11)} (of which loan interest ${pct(loan * interestShare, total)};` +
                ` the other ${pct(loan * (1 - interestShare), total)} of LOAN_PAYMENT_APPLY is principal)`);
  }
  if (unknown.length) console.log(`     ${''.padEnd(11)} UNCLASSIFIED: ${unknown.join(', ')}`);
};

console.log('§3 — headline (the allowlist here is inline; §8 is the real classification):');
headline(rawByType,  rawTotal,  'RAW');
headline(convByType, convTotal, 'CONVERTED');
console.log();

console.log('§3 — the RAW column, grouped by the DEBITED ACCOUNT\'s currency:');
for (const [code, v] of [...byCurrency.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`     ${code.padEnd(14)} ${pct(v, rawTotal).padStart(8)}`);
}
console.log();

// ─── COVERAGE: what the shipped report cannot see ────────────────────────────

const scoped = new Set(apis.diff.accountBalanceKeys() ?? []);
const unseen = [...rawKeys].filter(k => !scoped.has(k)).sort();
console.log(`COVERAGE — state keys carrying a debit: ${rawKeys.size};` +
            ` registered as account balances: ${scoped.size}`);
if (unseen.length === 0) {
  console.log('     every debited key is in scope.\n');
} else {
  let unseenTotal = 0;
  const byUnseenKey = new Map();   // key -> [ [type, amount], ... ]
  for (const [k, v] of rawByField.entries()) {
    const [type, field] = k.split('|');
    if (!unseen.includes(field)) continue;
    unseenTotal += v;
    if (!byUnseenKey.has(field)) byUnseenKey.set(field, []);
    byUnseenKey.get(field).push([type, v]);
  }
  console.log(`     ${unseen.length} debited key(s) are OUT of the report's scope,` +
              ` carrying ${pct(unseenTotal, rawTotal)} of the raw total:`);
  for (const k of unseen) {
    const debitors = (byUnseenKey.get(k) ?? []).sort((a, b) => b[1] - a[1])
      .map(([t, v]) => `${t} ${pct(v, rawTotal)}`).join(', ');
    console.log(`       ${k.padEnd(32)} debited by: ${debitors}`);
  }
  console.log('     A category the report structurally cannot reach must not be drawn as zero.');
  console.log('     Note which types those are before concluding the scope is harmless.\n');
}

// ─── §4: the mortgage double-count and the interest offset ───────────────────

const loanTotal = rawByType.get('LOAN_PAYMENT_APPLY') ?? 0;
if (loanTotal > 0) {
  console.log('§4 — LOAN_PAYMENT_APPLY by field (face value):');
  for (const [k, v] of [...rawByField.entries()]
        .filter(([k]) => k.startsWith('LOAN_PAYMENT_APPLY|'))
        .sort((a, b) => b[1] - a[1])) {
    console.log(`     ${k.split('|')[1].padEnd(34)} ${pct(v, loanTotal).padStart(8)} of the type`);
  }

  console.log(`     interest is ${pct(loanInterest, loanPayment)} of the cash leg,` +
              ` ${pct(loanInterest, loanTotal)} of the type's debits.`);
  console.log('     Everything else on this type is principal: a balance-sheet transfer,');
  console.log('     counted twice because the loan account\'s own leg is negative too.\n');
}

// ─── §10: the 3x trap ────────────────────────────────────────────────────────

let intentSum = 0, realizedSum = 0, expenseEntries = 0;
const dispatches = new Set();
for (const e of entries) {
  if (e.action?.type !== 'EXPENSE_DEBIT') continue;
  expenseEntries++;
  const d = e.action.data ?? e.action;
  intentSum += d.amount ?? 0;
  dispatches.add(`${e.date}|${d.targetKey}|${d.amount}`);
  for (const diff of (e.stateDiff ?? [])) {
    if (!(diff.field ?? '').endsWith('.balance')) continue;
    if ((diff.delta ?? 0) < 0) realizedSum += -(diff.delta);
  }
}
console.log('§10 — the EXPENSE_DEBIT multiplier:');
console.log(`     journal entries          ${expenseEntries}`);
console.log(`     distinct dispatches      ${dispatches.size}`);
console.log(`     Σ action.data.amount ÷ Σ realized delta = ` +
            `${realizedSum > 0 ? (intentSum / realizedSum).toFixed(4) : '—'}`);
console.log('     One entry per reducer, only the first moves money. Do NOT fix this by');
console.log('     dividing by a constant: a fourth reducer would silently make it 4x.\n');
