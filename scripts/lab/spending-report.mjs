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
 * spending-report.mjs — what the plan actually costs, as one HTML page.
 * Design 89 phase 3 (§9, §11).
 *
 *   node scripts/lab/spending-report.mjs [--scenario <file.json>] [options]
 *
 * The flow sibling of `allocation-report.mjs`, and deliberately built the same way:
 * every number is a group-by of one classified fact table, computed with the same
 * `src/finance/spending-reporting` modules the eventual workbench panel will use, so the
 * page and the app cannot disagree about a share.
 *
 * ─── the two places it must differ from the allocation page (§9) ─────────────
 *
 * **Bars, not areas.** A flow is a quantity per period. A stacked area asserts a
 * continuity between year-ends that a flow does not have, and invites reading a band's
 * slope as meaningful when only its height is.
 *
 * **Real terms by default, nominal as a toggle and never the default.** Design 82 could
 * defer real-vs-nominal because its headline is a share and shares are unitless. A
 * spending chart has no such escape: its entire subject is the level. The reference
 * plan's terminal price level is ~3.7x, so a nominal chart's last bar is nearly four
 * times its first for identical real spending — the chart's dominant visual signal
 * pointing the opposite way from the truth.
 *
 * ─── what it refuses to do ───────────────────────────────────────────────────
 *
 * It does not sum the two tiers. §8's tier 2 — internal transfers, principal, marks — is
 * not spending, and stacking it with tier 1 restates the 99% overstatement this design
 * exists to remove. It is drawn, in its own strip, because §7(a) is only checkable if
 * every debit is on the page somewhere.
 *
 * It does not render a total it cannot stand behind. The §7(a) tie-out runs first and
 * says so above the chart, and an unregistered state schema (which silently degrades
 * every currency conversion) stops the page rather than colouring it.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve, basename }                         from 'node:path';
import { execFileSync }                                       from 'node:child_process';
import { createRequire }                                      from 'node:module';

import { loadBaseConfig, parseSourceArgs, describeSource } from '../lib/scenario-source.mjs';
import { openSim }             from '../lib/run.mjs';
import { ServiceRegistry }     from '../../src/services/service-registry.js';
import { buildSpendingCube, checkClassificationTotal, spendingSummary, categoriesByValue }
  from '../../src/finance/spending-reporting/spending-cube.js';
import { buildSpendingSeries, bySpendingTier, intentVsRealized }
  from '../../src/finance/spending-reporting/spending-grouping.js';
import { REPORT_CATEGORY, SPEND_TIER }
  from '../../src/finance/spending-reporting/spending-classification.js';
import { createBalanceSampler, checkFlowInvariant }
  from '../../src/finance/spending-reporting/account-flow-tie.js';
import { CATEGORY_COLOR, PALETTE_CYCLE }
  from '../../src/finance/spending-reporting/spending-palette.js';

const USAGE = `
spending-report.mjs — what the plan actually costs, as one HTML page.

  node scripts/lab/spending-report.mjs [--scenario <file.json>] [options]

  --scenario <file> Workbench export to run (default: built-in synthetic scenario).
  --index <n>       Which scenario inside that file (default 0).
  --out <file>      Output path (default scenarios/spending-report.html).
  --csv             Also write the raw cube beside the page as .csv.
  --open            Open the result when done (macOS).
`;

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const has  = (n) => argv.includes(n);

if (has('-h') || has('--help')) { console.log(USAGE); process.exit(0); }

const { file: scenarioFile, index: scenarioIndex } = parseSourceArgs(argv);
const outFile = resolve(flag('--out') ?? 'scenarios/spending-report.html');
const BASE    = 'USD';

// ─── run + classify ──────────────────────────────────────────────────────────

const source = loadBaseConfig({ file: scenarioFile, index: scenarioIndex });
const cfg    = source.cfg;

// The balance sampler rides design 82's `year-boundary` cadence — the SAME seam and the
// same instants `createAllocationSampler` uses (82 §4), which is what makes §7(b) a
// cross-check between two reports rather than between two nearly-identical clocks.
const sim = openSim(cfg, {
  telemetry: 'full',
  sampler: createBalanceSampler(),
  samplerCadence: 'year-boundary',
});
sim.stepTo(new Date(cfg.simEnd));

const services = ServiceRegistry.getInstance();
const cube = buildSpendingCube({
  journal: sim.journal, state: sim.state, services, currency: BASE, priceLevelCc: 'US',
});

const tie     = checkClassificationTotal(cube);
const summary = spendingSummary(cube);
const flowTie = checkFlowInvariant({ samples: sim.samples, journal: sim.journal });

// §9.1's stated limitation, checked rather than caveated: `buildAndCompile` registers no
// accounts, and on that path `stateDelta` has no currency, so every conversion silently
// degrades. A page that renders anyway is a page whose totals are in no unit.
const schemaBound = cube.coverage.registeredKeys > 0;

// ─── views ───────────────────────────────────────────────────────────────────

const tiers    = bySpendingTier(cube.rows, { value: 'amountReal' });
const tiersNom = bySpendingTier(cube.rows, { value: 'amount' });
const years    = tiers.years;

const views = {
  real:    { spending: tiers.spending,    notSpending: tiers.notSpending },
  nominal: { spending: tiersNom.spending, notSpending: tiersNom.notSpending },
  // The share view is unitless, so it is immune to the real/nominal question entirely —
  // the same reason design 82's 100% view leads its page. Here it answers "what fraction
  // of what I spent went to tax", which is the question after "how much".
  share: {
    spending: buildSpendingSeries(cube.rows, {
      value: 'amountReal', normalize: true, years,
      filter: r => r.tier === SPEND_TIER.SPENDING,
    }),
    notSpending: buildSpendingSeries(cube.rows, {
      value: 'amountReal', normalize: true, years,
      filter: r => r.tier === SPEND_TIER.NOT_SPENDING,
    }),
  },
};

const intent = {
  real:    intentVsRealized(cube.rows, { value: 'amountReal', years }),
  nominal: intentVsRealized(cube.rows, { value: 'amount',     years }),
};
const shortfallYears = intent.real.shortfall
  .map((v, i) => ({ year: years[i], amount: v }))
  .filter(s => s.amount > 1);

// The last bar of a run whose horizon is not a 31 December covers a partial year, so it
// is short for a reason that has nothing to do with the plan. Same disclosure design 82
// makes about its off-boundary sample, and for the same reason: it is the most-quoted
// point on the page.
const horizon      = new Date(cfg.simEnd);
const partialFinal = !(horizon.getUTCMonth() === 11 && horizon.getUTCDate() === 31);
const emptyFinal   = tiers.spending.totals.at(-1) === 0 && tiers.notSpending.totals.at(-1) === 0;

// ─── formatting ──────────────────────────────────────────────────────────────

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => (n == null ? '—' : (n < 0 ? '−' : '') + '$' + Math.abs(Math.round(n)).toLocaleString());
const pct   = (r, dp = 1) => (r == null ? '—' : `${(r * 100).toFixed(dp)}%`);
const when  = ms => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

const require   = createRequire(import.meta.url);
const echartsJs = readFileSync(require.resolve('echarts/dist/echarts.min.js'), 'utf8')
  .replace(/<\/script>/gi, '<\\/script>');   // never let the payload close its own tag

const payload = {
  years, views, intent,
  categoryColor: CATEGORY_COLOR,
  cycle: PALETTE_CYCLE,
  base: BASE,
};

const sections = [];

// ─── provenance: the tie-out, above the chart (82 §6.5) ──────────────────────

sections.push(`<section id="provenance"><h2>Provenance</h2>
  <p class="lede">Every figure below is a group-by of one classified fact table: each negative
  balance movement in the journal, converted to ${esc(BASE)} at that row's own date, deflated by
  the run's own US price level, and assigned to exactly one category. A classification that
  loses a debit understates the cost of the plan without leaving a mark, so that check runs
  first.</p>
  ${!schemaBound
    ? `<div class="alert crit"><strong>No account schema is registered.</strong> Currency
       conversion has nothing to read a unit from, so every total on this page would be a sum
       across currencies. Do not quote anything here.</div>` : ''}
  ${tie.ok
    ? `<div class="alert ok"><strong>Classification is total.</strong> Every category sums back
       to the whole debit total across ${cube.rows.length.toLocaleString()} rows
       (drift ${tie.drift.toExponential(1)}).</div>`
    : `<div class="alert crit"><strong>Classification is not total.</strong> Categories sum to
       ${money(tie.sum)} against ${money(tie.total)} of debits. A debit is being dropped or
       double-counted; do not quote any band on this page until it is found.</div>`}
  ${flowTie.tie.unchecked
    ? `<div class="alert warn"><strong>The flow was not tied to the stock.</strong> This run
       produced no year-boundary samples, so §7(b) could not be checked at all — which is not
       the same as passing.</div>`
    : flowTie.ok
      ? `<div class="alert ok"><strong>The flow ties to the stock.</strong>
         <code>opening + credits − debits = closing</code> holds for every account in every
         year (${flowTie.tie.checked.toLocaleString()} account-years,
         ${flowTie.continuity.diffCount.toLocaleString()} balance movements, none unjournalled).
         This page and the allocation chart are the same run described twice.</div>`
      : `<div class="alert crit"><strong>The flow does not tie to the stock.</strong>
         ${esc(flowTie.summary)}. Either a balance moved without the journal recording it — in
         which case this page cannot see that money at all — or the two readings disagree.
         The identity names the account and the year; start there.</div>`}
  ${tie.unclassified > 0
    ? `<div class="alert warn"><strong>${money(tie.unclassified)} is UNCLASSIFIED</strong>
       (${pct(tie.unclassified / cube.total, 2)} of debits). Drawn rather than hidden, and drawn
       loud on purpose — an action type nobody classified is a decision waiting to be made, not
       a rounding error. Action types:
       ${esc([...new Set(cube.rows.filter(r => r.category === REPORT_CATEGORY.UNCLASSIFIED)
              .map(r => r.actionType))].join(', '))}.</div>` : ''}
  ${cube.unconverted > 0
    ? `<div class="alert warn"><strong>${money(cube.unconverted)} could not be converted</strong>
       — no USD/AUD rate is recorded at those rows' dates. Counted at face value so the total
       still ties, but it is a number in the wrong unit by that much.</div>` : ''}
  ${cube.undeflated > 0
    ? `<div class="alert warn"><strong>${money(cube.undeflated)} could not be deflated</strong>
       — no price level recorded at those rows' dates. Carried nominally into the real view.</div>` : ''}
  ${cube.coverage.outOfScope.length > 0
    ? `<div class="alert warn"><strong>${cube.coverage.outOfScope.length} debited state key(s) are
       outside the shipped reports' scope</strong>
       (${esc(cube.coverage.outOfScope.map(o => o.stateKey).join(', '))}, ${money(cube.coverage.outOfScope.reduce((a, o) => a + o.amount, 0))}).
       This page includes them deliberately: they are the loan accounts, and the built-in
       per-account reports drop the mortgage double-count by accident because they cannot see
       them. Register one for any unrelated reason and the double-count returns there — it does
       not return here, because <code>DEBT_PRINCIPAL</code> is asserted rather than scoped away.</div>` : ''}
  ${partialFinal || emptyFinal
    ? `<div class="alert warn"><strong>The final bar covers a partial year.</strong> The run's
       horizon is ${esc(horizon.toISOString().slice(0, 10))}, so ${years.at(-1)} is short for a
       reason that has nothing to do with the plan. Read the second-to-last bar as the last full
       year.</div>` : ''}
</section>`);

// ─── headlines ───────────────────────────────────────────────────────────────

const byValue   = categoriesByValue(cube);
const tier1Only = byValue.filter(c => c.tier === SPEND_TIER.SPENDING);
const biggest   = tier1Only[0];
const taxTotal  = tier1Only
  .filter(c => c.category.startsWith('TAX_'))
  .reduce((a, c) => a + c.amountReal, 0);

// Both heroes are the SAME quantity in two units. An earlier draft paired nominal
// spending against real all-debits, which on this plan happen to land 3% apart — so the
// card read "inflation barely matters" while the like-for-like ratio was 2.3x.
sections.push(`<section id="headlines"><h2>Headlines</h2>
  <p class="lede">All figures ${esc(BASE)}. The first two cards are one number in two units;
  the gap between them is what a nominal chart would hide. The first card's rows are the whole
  argument for this page: what left an account, and what of that was actually a cost.</p>
  <div class="cards">
    <div class="card">
      <p class="card-kicker">Cost of the plan · real</p>
      <p class="hero">${money(summary.spendingReal)}</p>
      <p class="card-sub">base-year dollars, over ${years.length} years</p>
      <dl class="card-facts">
        <div><dt>every debit</dt><dd>${money(cube.totalReal)}</dd></div>
        <div><dt>not spending</dt><dd>${money(summary.notSpendingReal)}</dd></div>
        <div><dt>&ldquo;all debits&rdquo; overstates by</dt><dd>${pct(summary.overstatement, 0)}</dd></div>
      </dl>
    </div>
    <div class="card">
      <p class="card-kicker">The same spending · nominal</p>
      <p class="hero">${money(summary.spending)}</p>
      <p class="card-sub">${summary.inflationFactor?.toFixed(2) ?? '—'}× the real figure &mdash; inflation, not spending</p>
      <dl class="card-facts">
        <div><dt>every debit, nominal</dt><dd>${money(cube.total)}</dd></div>
        <div><dt>terminal price level</dt><dd>${cube.terminalPriceLevel?.toFixed(2) ?? '—'}×</dd></div>
        <div><dt>a final-year dollar buys</dt><dd>${cube.terminalPriceLevel ? pct(1 / cube.terminalPriceLevel, 0) : '—'}</dd></div>
      </dl>
    </div>
    <div class="card">
      <p class="card-kicker">Largest cost · real</p>
      <p class="hero">${esc(biggest?.category ?? '—')}</p>
      <p class="card-sub">${money(biggest?.amountReal)} · ${pct(biggest ? biggest.amountReal / summary.spendingReal : null, 0)} of spending</p>
      <dl class="card-facts">
        <div><dt>tax, all jurisdictions</dt><dd>${money(taxTotal)}</dd></div>
        <div><dt>tax as a share of spending</dt><dd>${pct(summary.spendingReal > 0 ? taxTotal / summary.spendingReal : null, 0)}</dd></div>
      </dl>
    </div>
    <div class="card">
      <p class="card-kicker">Did the plan get what it asked for?</p>
      <p class="hero">${shortfallYears.length === 0 ? 'Yes' : `${shortfallYears.length} yr`}</p>
      <p class="card-sub">${shortfallYears.length === 0
        ? 'no debit was ever capped by an empty account'
        : `shortfall in ${esc(shortfallYears.map(s => s.year).join(', '))}`}</p>
      <dl class="card-facts">
        <div><dt>total shortfall</dt><dd>${money(intent.real.shortfall.reduce((a, v) => a + v, 0))}</dd></div>
      </dl>
    </div>
  </div>
  <p class="notes">A capped debit is the failure mode the realized bands alone cannot show: when
  an account runs dry the debit shrinks, so the chart draws <em>spent less</em> where the truth is
  <em>went short</em>. The intent line over the spending chart is the difference.</p>
</section>`);

// ─── the chart ───────────────────────────────────────────────────────────────

sections.push(`<section id="spending"><h2>What the plan cost</h2>
  <p class="lede">Stacked bars, one per calendar year, in <strong>base-year real dollars</strong>.
  Bars rather than an area because a flow is a quantity per period — a stacked area asserts a
  continuity between year-ends that a flow does not have. Real rather than nominal because a
  spending chart's whole subject is the level: drawn nominally, inflation alone lifts every band
  and the chart tells a story that is the opposite of true. The dashed line is what the plan
  <em>intended</em> to spend; it is absent from the share view, where a fraction of realized
  spending cannot be compared with an intention.</p>
  <div class="chart-head">
    <span class="chart-cap">Spending by category</span>
    <span class="seg" data-seg="chart-spending">
      <button class="on" data-mode="real">real</button><button data-mode="nominal">nominal</button><button data-mode="share">share</button>
    </span>
  </div>
  <div class="chart" id="chart-spending"></div>
</section>`);

sections.push(`<section id="moved"><h2>What the plan merely moved</h2>
  <p class="lede">The audit strip, and it is not spending. Money between the household's own
  pockets, principal repaid, assets bought or improved, and marks to market — every one of them a
  negative balance movement, and none of them a cost. Drawn in its own strip rather than stacked
  with the chart above, because adding the two is exactly the overstatement this page exists to
  remove; and drawn at all rather than hidden, because a total nobody can audit is a total nobody
  should quote.</p>
  <div class="chart-head">
    <span class="chart-cap">Non-spending movements by category</span>
    <span class="seg" data-seg="chart-moved">
      <button class="on" data-mode="real">real</button><button data-mode="nominal">nominal</button><button data-mode="share">share</button>
    </span>
  </div>
  <div class="chart" id="chart-moved"></div>
</section>`);

// ─── the table ───────────────────────────────────────────────────────────────

const table = views.real.spending;
sections.push(`<section id="table"><h2>Year by year</h2>
  <p class="lede">The spending chart as figures, in base-year real ${esc(BASE)}. <code>intent</code>
  is what was asked for; it equals the total in every year no account ran dry.</p>
  <div class="scroll"><table class="plain">
    <thead><tr><th>year</th>${table.keys.map(k => `<th class="num">${esc(k)}</th>`).join('')}
      <th class="num">spending</th><th class="num">intent</th><th class="num">not spending</th></tr></thead>
    <tbody>${years.map((y, i) => `<tr>
      <th>${y}</th>
      ${table.keys.map(k => `<td class="num">${money(table.series[k][i])}</td>`).join('')}
      <td class="num">${money(table.totals[i])}</td>
      <td class="num${intent.real.shortfall[i] > 1 ? ' short' : ''}">${money(intent.real.intent[i])}</td>
      <td class="num muted">${money(views.real.notSpending.totals[i])}</td>
    </tr>`).join('')}</tbody>
  </table></div>
</section>`);

// ─── the classification, stated ──────────────────────────────────────────────

sections.push(`<section id="categories"><h2>Where every dollar went</h2>
  <p class="lede">The classification itself, so the bands above can be checked rather than
  trusted. Emitted, never inferred: the four expense categories are stamped by the handler that
  knows the answer, because nothing else on the payload can tell a month's groceries from a
  home's rates.</p>
  <div class="scroll"><table class="plain">
    <thead><tr><th>category</th><th>tier</th><th class="num">real ${esc(BASE)}</th>
      <th class="num muted">nominal ${esc(BASE)}</th>
      <th class="num">of all debits</th><th class="num">of spending</th></tr></thead>
    <tbody>${byValue.map(c => `<tr class="${c.category === REPORT_CATEGORY.UNCLASSIFIED ? 'row-alert' : ''}">
      <th>${esc(c.category)}</th>
      <td class="${c.tier === SPEND_TIER.SPENDING ? '' : 'muted'}">${c.tier === SPEND_TIER.SPENDING ? 'spending' : 'not spending'}</td>
      <td class="num">${money(c.amountReal)}</td>
      <td class="num muted">${money(c.amount)}</td>
      <td class="num">${pct(c.amountReal / cube.totalReal)}</td>
      <td class="num">${c.tier === SPEND_TIER.SPENDING ? pct(c.amountReal / summary.spendingReal) : '—'}</td>
    </tr>`).join('')}</tbody>
  </table></div>
  <p class="notes"><strong>What this page does not show.</strong> Tax withheld at source is never
  received, so it is not a debit and the tax bands understate lifetime tax by that much. The AU
  super fund tax is withheld in-fund and never touches a member's account, so it is a real cost
  that is structurally absent here. <code>DEBT_PRINCIPAL</code> is deliberately double-counted:
  a loan payment debits the cash pool <em>and</em> the loan's own balance, and both are real
  movements — which is why it sits below, where it cannot inflate a cost.</p>
</section>`);

// ─── §7(b), shown rather than asserted ───────────────────────────────────────

// Worst residual per account across every year, so a 20-account 45-year grid becomes a
// table you can actually read. The per-year detail is in the CSV; what belongs here is
// "which account, and how badly".
const byAccount = new Map();
for (const cell of flowTie.tie.cells) {
  const seen = byAccount.get(cell.stateKey);
  const size = Math.abs(cell.residual);
  const flow = cell.credits + cell.debits;
  if (!seen) byAccount.set(cell.stateKey, { stateKey: cell.stateKey, years: 1, flow, worst: cell });
  else {
    seen.years++;
    seen.flow += flow;
    if (size > Math.abs(seen.worst.residual)) seen.worst = cell;
  }
}
const accountRows = [...byAccount.values()]
  .sort((a, b) => Math.abs(b.worst.residual) - Math.abs(a.worst.residual) || b.flow - a.flow);

sections.push(`<section id="tie"><h2>Does the flow tie to the stock?</h2>
  <p class="lede">Design 89 §7(b), and the invariant worth the most on this page. For every
  account in every year, <code>opening + credits − debits</code> must equal the closing
  balance — where the flows are read from the journal and the balances are sampled from live
  state at the same year boundaries design 82's allocation chart samples at. Two independent
  readings of one quantity: if they agree, this page and that one are the same run described
  twice; if they disagree, the identity says which account and which year.</p>
  <p class="lede"><strong>Continuity</strong> is the second, weaker-looking check that is
  actually the one protecting this page's totals: consecutive journal entries on one balance
  must chain, <code>after</code> to <code>before</code>. A break means money moved without the
  journal saying so — money no band above could ever contain.</p>
  <div class="scroll"><table class="plain">
    <thead><tr><th>account</th><th class="num">years</th><th class="num">flow through</th>
      <th class="num">worst residual</th><th class="num">in</th></tr></thead>
    <tbody>${accountRows.map(a => `<tr class="${Math.abs(a.worst.residual) > 0.01 ? 'row-alert' : ''}">
      <th class="mono">${esc(a.stateKey)}</th>
      <td class="num">${a.years}</td>
      <td class="num">${money(a.flow)}</td>
      <td class="num">${Math.abs(a.worst.residual) > 0.01 ? money(a.worst.residual) : '$0'}</td>
      <td class="num muted">${Math.abs(a.worst.residual) > 0.01 ? a.worst.year : '—'}</td>
    </tr>`).join('')}</tbody>
  </table></div>
  <p class="notes">Balances are each account's own currency, unconverted — the identity is an
  accounting statement within one account, and converting it would introduce an FX error into a
  check whose whole value is being exact. The tolerance is one cent, absolute: a relative band
  would hide a large break on a large account, which is the account it matters on.</p>
</section>`);

const nav = [
  { id: 'provenance', label: 'Provenance' },
  { id: 'headlines',  label: 'Headlines' },
  { id: 'spending',   label: 'What it cost' },
  { id: 'moved',      label: 'What it moved' },
  { id: 'table',      label: 'Year by year' },
  { id: 'categories', label: 'Categories' },
  { id: 'tie',        label: 'Flow ties to stock' },
];

const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(basename(describeSource(source)))} — spending over time</title>
<style>
:root{
  color-scheme: light dark;
  --surface:#fcfcfb; --plane:#f9f9f7; --ink:#0b0b0b; --ink2:#52514e; --muted:#898781;
  --grid:#e1e0d9; --rule:#c3c2b7; --border:rgba(11,11,11,.10);
  --good:#0ca30c; --warn:#fab219; --crit:#d03b3b;
}
@media (prefers-color-scheme: dark){ :root:where(:not([data-theme="light"])){
  --surface:#1a1a19; --plane:#0d0d0d; --ink:#fff; --ink2:#c3c2b7; --muted:#898781;
  --grid:#2c2c2a; --rule:#383835; --border:rgba(255,255,255,.10);
}}
:root[data-theme="dark"]{
  --surface:#1a1a19; --plane:#0d0d0d; --ink:#fff; --ink2:#c3c2b7; --muted:#898781;
  --grid:#2c2c2a; --rule:#383835; --border:rgba(255,255,255,.10);
}
*{box-sizing:border-box}
body{margin:0;background:var(--plane);color:var(--ink);
  font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:1180px;margin:0 auto;padding:0 20px 96px}
header.top{padding:40px 0 8px}
h1{font-size:28px;line-height:1.2;margin:0 0 4px;font-weight:650;letter-spacing:-.01em}
.sub{color:var(--ink2);margin:0 0 20px}
.sub code{font-size:13px}
nav.toc{position:sticky;top:0;z-index:5;background:var(--plane);
  border-bottom:1px solid var(--border);padding:10px 0;margin-bottom:8px;
  display:flex;gap:6px;flex-wrap:wrap}
nav.toc a{font-size:12.5px;color:var(--ink2);text-decoration:none;
  padding:4px 9px;border:1px solid var(--border);border-radius:999px;white-space:nowrap}
nav.toc a:hover{color:var(--ink);border-color:var(--rule)}
section{background:var(--surface);border:1px solid var(--border);border-radius:12px;
  padding:22px 24px;margin:20px 0}
h2{font-size:19px;margin:0 0 6px;font-weight:620;letter-spacing:-.005em}
.lede{color:var(--ink2);font-size:13.5px;margin:0 0 14px;max-width:82ch}
.notes{color:var(--ink2);font-size:13.5px;margin:14px 0 0;max-width:82ch;
  border-left:2px solid var(--rule);padding-left:12px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em;
  background:var(--plane);padding:1px 4px;border-radius:3px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
.muted{color:var(--muted)}
.scroll{overflow-x:auto;max-width:100%}
.alert{font-size:13.5px;padding:10px 13px;border-radius:8px;margin:0 0 12px;
  border:1px solid var(--border);border-left-width:3px}
.alert.crit{border-left-color:var(--crit);background:color-mix(in srgb,var(--crit) 7%,transparent)}
.alert.warn{border-left-color:var(--warn);background:color-mix(in srgb,var(--warn) 9%,transparent)}
.alert.ok{border-left-color:var(--good);background:color-mix(in srgb,var(--good) 7%,transparent)}
.alert.crit::before{content:"⛔ ";} .alert.warn::before{content:"⚠ ";} .alert.ok::before{content:"✓ ";}
.cards{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(215px,1fr))}
.card{border:1px solid var(--border);border-radius:10px;padding:14px 15px;background:var(--plane)}
.card-kicker{margin:0;font-size:11.5px;text-transform:uppercase;letter-spacing:.07em;
  color:var(--muted);font-weight:600}
.hero{margin:6px 0 2px;font-size:32px;line-height:1.05;font-weight:640;letter-spacing:-.02em}
.card-sub{margin:0 0 4px;font-size:12px;color:var(--ink2)}
.card-facts{margin:8px 0 0;display:grid;gap:3px}
.card-facts div{display:flex;justify-content:space-between;gap:8px;font-size:12.5px}
.card-facts dt{color:var(--muted)} .card-facts dd{margin:0;font-variant-numeric:tabular-nums}
table{border-collapse:separate;border-spacing:0;font-size:13px}
table.plain{width:100%}
table.plain th,table.plain td{text-align:left;padding:6px 10px;
  border-bottom:1px solid var(--grid);white-space:nowrap}
table.plain thead th{color:var(--muted);font-weight:600;font-size:11.5px;
  text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid var(--rule)}
table.plain tbody th{font-weight:550}
table.plain th.num,table.plain td.num{text-align:right;font-variant-numeric:tabular-nums}
td.short{color:var(--crit);font-weight:600}
tr.row-alert th{color:var(--crit)}
.chart{height:420px;width:100%}
.chart-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 6px}
.chart-cap{font-size:12px;color:var(--ink2);font-weight:600;margin-right:auto}
.seg{display:inline-flex;border:1px solid var(--border);border-radius:999px;overflow:hidden}
.seg button{font:inherit;font-size:12px;padding:3px 11px;border:0;cursor:pointer;
  background:transparent;color:var(--ink2)}
.seg button.on{background:var(--ink);color:var(--surface)}
@media print{nav.toc{display:none}section{break-inside:avoid;border:none;padding:0}}
</style>
</head><body>
<div class="wrap">
<header class="top">
  <h1>What the plan costs</h1>
  <p class="sub"><code>${esc(describeSource(source))}</code> · ${years[0]}–${years.at(-1)}
    · base-year real ${esc(BASE)} · rendered ${esc(when(Date.now()))} UTC</p>
</header>
<nav class="toc">${nav.map(n => `<a href="#${esc(n.id)}">${esc(n.label)}</a>`).join('')}</nav>
${sections.join('\n')}
</div>
<script>${echartsJs}</script>
<script>
const DATA = ${JSON.stringify(payload)};

const dark = () => (document.documentElement.dataset.theme === 'dark') ||
  (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
const ink  = () => (dark() ? '#c3c2b7' : '#52514e');
const line = () => (dark() ? '#2c2c2a' : '#e1e0d9');

const money = n => (n < 0 ? '−' : '') + '$' + Math.abs(Math.round(n)).toLocaleString();
const compact = n => {
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(1) + 'm';
  if (a >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(Math.round(n));
};

/** Fixed colour per category, so a band never changes colour between charts or modes. */
function colorFor(key, index) {
  if (DATA.categoryColor[key]) return DATA.categoryColor[key];
  const tail = String(key).split(' · ').pop();
  if (DATA.categoryColor[tail]) return DATA.categoryColor[tail];
  return DATA.cycle[index % DATA.cycle.length];
}

/**
 * Stacked bars for one strip.
 *
 * \`withIntent\` draws the line from §5 across the tops. It is a line and not a band
 * because it is a claim about the same quantity as the stack, not another component of
 * it — drawing it as another band would say the plan spent MORE than it did.
 */
function optionFor(view, mode, withIntent) {
  const share = mode === 'share';
  const series = view.keys.map((key, i) => ({
    name: key, type: 'bar', stack: 'all',
    itemStyle: { color: colorFor(key, i) },
    emphasis: { focus: 'series' },
    barMaxWidth: 34,
    data: view.series[key],
  }));

  if (withIntent && !share) {
    const src = DATA.intent[mode === 'nominal' ? 'nominal' : 'real'];
    series.push({
      name: 'intended', type: 'line', z: 5,
      showSymbol: false, smooth: false, step: 'middle',
      lineStyle: { width: 1.6, type: 'dashed', color: dark() ? '#fff' : '#0b0b0b' },
      itemStyle: { color: dark() ? '#fff' : '#0b0b0b' },
      data: src.intent,
    });
  }

  return {
    animation: false,
    backgroundColor: 'transparent',
    textStyle: { color: ink(), fontFamily: 'system-ui,-apple-system,sans-serif' },
    grid: { left: 62, right: 18, top: 12, bottom: 68 },
    legend: { type: 'scroll', bottom: 0, itemHeight: 9, itemWidth: 12,
              textStyle: { color: ink(), fontSize: 11 } },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter(params) {
        if (!params.length) return '';
        const i = params[0].dataIndex;
        const total = view.totals[i];
        const head = '<strong>' + params[0].axisValue + '</strong>' +
          (share ? '' : ' <span style="opacity:.6">' + money(total) + '</span>');
        // Descending, zero series dropped: a 14-line tooltip where 8 read $0 is how a
        // reader stops opening the tooltip at all.
        const lines = params
          .filter(p => Math.abs(p.value) > (share ? 0.0005 : 0.5))
          .sort((a, b) => (a.seriesType === 'line') - (b.seriesType === 'line') ||
                          Math.abs(b.value) - Math.abs(a.value))
          .map(p => p.marker + ' ' + p.seriesName +
            ' <strong>' + (share ? (p.value * 100).toFixed(1) + '%' : money(p.value)) + '</strong>');
        return head + '<br>' + lines.join('<br>');
      },
    },
    xAxis: {
      type: 'category', data: DATA.years.map(String),
      axisLine: { lineStyle: { color: line() } },
      axisLabel: { color: ink(), fontSize: 11, hideOverlap: true },
    },
    yAxis: {
      type: 'value', max: share ? 1 : null,
      splitLine: { lineStyle: { color: line() } },
      axisLabel: { color: ink(), fontSize: 11,
                   formatter: v => (share ? Math.round(v * 100) + '%' : compact(v)) },
    },
    series,
  };
}

const charts = {};
const state  = {
  'chart-spending': { mode: 'real', strip: 'spending',    intent: true  },
  'chart-moved':    { mode: 'real', strip: 'notSpending', intent: false },
};

function draw(id) {
  const s = state[id];
  const view = DATA.views[s.mode === 'share' ? 'share' : s.mode][s.strip];
  const el = document.getElementById(id);
  if (!charts[id]) charts[id] = echarts.init(el);
  charts[id].setOption(optionFor(view, s.mode, s.intent), true);
}

for (const id of Object.keys(state)) draw(id);

document.querySelectorAll('[data-seg]').forEach(seg => {
  const id = seg.dataset.seg;
  seg.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
    seg.querySelectorAll('button').forEach(b => b.classList.remove('on'));
    btn.classList.add('on');
    state[id].mode = btn.dataset.mode;
    draw(id);
  }));
});

addEventListener('resize', () => { for (const c of Object.values(charts)) c.resize(); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  for (const id of Object.keys(charts)) draw(id);
});
</script>
</body></html>`;

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, html);
console.log(`wrote ${outFile}  (${(html.length / 1024 / 1024).toFixed(2)} MB, ${cube.rows.length} cube rows)`);

if (has('--csv')) {
  const csvPath = outFile.replace(/\.html?$/i, '') + '.csv';
  const cols = ['date', 'year', 'actionType', 'stateKey', 'currency', 'category', 'tier',
    'amountLocal', 'amount', 'amountReal', 'intent', 'intentReal', 'instanceId'];
  const cell = v => {
    if (v == null) return '';
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // UTF-8 BOM so Excel opens it as UTF-8 rather than mangling the category names.
  writeFileSync(csvPath, '﻿' + [cols.join(','),
    ...cube.rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\n'));
  console.log(`wrote ${csvPath}`);
}

// Non-zero-ish signals on the terminal too, so a scripted run does not need the page open.
if (!tie.ok) console.error(`** classification is NOT total: ${money(tie.sum)} vs ${money(tie.total)}`);
if (tie.unclassified > 0) console.error(`** ${money(tie.unclassified)} UNCLASSIFIED`);
if (!schemaBound) console.error('** no account schema registered — totals are in no currency');
if (!flowTie.ok) console.error(`** §7(b) flow does not tie to stock: ${flowTie.summary}`);
else console.log(`§7(b) ${flowTie.summary}`);
console.log(`spending ${money(summary.spendingReal)} real / ${money(summary.spending)} nominal ` +
            `of ${money(cube.total)} nominal debits (${pct(summary.spendingShare)}); ` +
            `"all debits" overstates by ${pct(summary.overstatement, 0)}, ` +
            `nominal overstates the same spending by ${summary.inflationFactor?.toFixed(2) ?? '—'}×`);

if (has('--open') && existsSync(outFile)) {
  try { execFileSync('open', [outFile]); } catch { /* not macOS, or no opener */ }
}
