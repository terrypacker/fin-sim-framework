/*
 * Probe: AU CGT per-person attribution + CGT Schedule contents for one FY.
 * Usage: node scripts/probes/probe-au-cgt-attribution.mjs --scenario scenarios/fin-sim-scenarios.json --fy 2031
 */
import { loadBaseConfig, parseSourceArgs } from '../lib/scenario-source.mjs';
import { openSim, quiet } from '../lib/run.mjs';
import { TaxDocumentRegistry } from '../../src/finance/tax/tax-document-registry.js';

const argv = process.argv.slice(2);
const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const fy = Number(at('--fy') ?? 2031);
const { cfg } = loadBaseConfig(parseSourceArgs(argv));

const sim = quiet(() => {
  const s = openSim(cfg, { telemetry: 'full' });
  s.stepTo(new Date(cfg.simEnd));
  return s;
});

const journal = sim.journal.journal;
console.log('journal entries:', journal.length);

const settles = journal.filter(e => e.action?.type === 'AU_TAX_SETTLE_APPLY');
console.log('AU settles:', settles.map(e => new Date(e.date).toISOString().slice(0, 10)).join(', '));

const target = settles.find(e => new Date(e.date).getUTCFullYear() === fy + 1
  && new Date(e.date).getUTCMonth() <= 6);
if (!target) { console.log('no settle found for FY', fy); process.exit(0); }

console.log('\n=== settle', new Date(target.date).toISOString().slice(0, 10), '===');
const ptd = target.action.data.personTaxDetails ?? [];
for (const p of ptd) {
  const i = p.taxDetail.inputs;
  console.log(`  ${p.personName} (${p.personKey}): ordinary=${i.ordinaryIncome?.toFixed(0)} capGains=${i.capitalGains?.toFixed(0)} discountable=${i.discountableGains?.toFixed?.(0)} net=${p.taxDetail.netLiability?.toFixed(0)}`);
}

// Which disposals fell in the FY window and what they carry
const idx = journal.indexOf(target);
let start = 0;
for (let i = idx - 1; i >= 0; i--) if (journal[i].action?.type === 'AU_TAX_SETTLE_APPLY') { start = i + 1; break; }
const seen = new Set();
console.log('\n=== disposal actions in window ===');
for (let i = start; i < idx; i++) {
  const e = journal[i];
  const d = e.action?.data;
  if (!d?.proceeds) continue;
  const id = e.action.instanceId;
  if (id != null) { if (seen.has(id)) continue; seen.add(id); }
  console.log(' ', new Date(e.date).toISOString().slice(0, 10), e.action.type,
    JSON.stringify({
      description: d.description, stateKey: d.stateKey, personKey: d.personKey,
      accountKey: d.accountKey, owner: d.owner, ownership: d.ownership,
      residency: d.residency, proceeds: Math.round(d.proceeds), gain: Math.round(d.gain ?? 0),
      auGain: d.auGain != null ? Math.round(d.auGain) : undefined,
    }));
}

// Expected AU attribution: auGain (USD for US accounts) → AUD → ownership split
console.log('\n=== expected attribution from auGain × ownership ===');
const { ownershipFractions } = await import('../../src/finance/ownership-utils.js');
// State AS OF the settle — ownership and the people map both change over a long run,
// so reading sim.state (simEnd) would score the split against the wrong household.
const st = quiet(() => {
  const s2 = openSim(cfg, { telemetry: 'off' });
  s2.stepTo(new Date(Date.UTC(fy + 1, 5, 29)));
  return s2.state;
});
const byAccount = {};
const seen2 = new Set();
for (let i = start; i < idx; i++) {
  const e = journal[i];
  const d = e.action?.data;
  if (!d?.proceeds || d.residency !== 'AU') continue;
  const id = e.action.instanceId;
  if (id != null) { if (seen2.has(id)) continue; seen2.add(id); }
  const k = d.stateKey ?? d.description;
  byAccount[k] = (byAccount[k] ?? 0) + (d.auGain ?? 0);
}
const fx = target.action.data.fxRate;
console.log('  settle fxRate:', fx);
const expect = {};
for (const [k, usd] of Object.entries(byAccount)) {
  const acct = st[k];
  const fr = acct ? ownershipFractions(acct, st.people) : [];
  console.log(`  ${k}: auGain(USD)=${usd.toFixed(2)} ownership=${JSON.stringify(fr)} ownershipType=${acct?.ownershipType} ownerId=${acct?.ownerId}`);
  for (const { personKey, fraction } of fr) expect[personKey] = (expect[personKey] ?? 0) + usd * fraction;
}
console.log('  expected per-person auGain (USD):', JSON.stringify(expect));
console.log('  people:', JSON.stringify(Object.fromEntries(Object.entries(st.people).map(([k, p]) => [k, p && { id: p.id, name: p.name }]))));

console.log('\n=== generated documents ===');
const docs = new TaxDocumentRegistry().generate(target, journal);
for (const d of [].concat(docs ?? [])) {
  console.log(' ', d.personName, '|', d.title);
  if (d.table) {
    console.log(`      (table: ${d.table.rows.length} rows, totals ${JSON.stringify(d.table.totals)})`);
  }
  for (const s of d.sections ?? []) {
    console.log('      ##', s.heading);
    for (const li of s.lineItems) {
      const amt = li.amount == null ? '' : li.amount.toFixed(2).padStart(12);
      console.log(`        ${li.sub ? '  · ' : '    '}${li.label.padEnd(52)}${amt}`);
    }
  }
}

// The per-person AUD booking the return actually assessed, recorded on the
// disposal's own journal entry as `auPersonCapitalGainsYTD.<personKey>`. This is
// the only per-person signal the CGT Schedule could read: the document registry
// sees the journal and nothing else, and live state is the WRONG source (ownership
// and the people map both move over a long run).
console.log('\n=== stateDiffs for a disposal with non-zero auGain ===');
let shown = 0;
for (let i = start; i < idx && shown < 6; i++) {
  const e = journal[i];
  const d = e.action?.data;
  if (!d?.proceeds || !(d.auGain > 0) || d.residency !== 'AU') continue;
  console.log(' ', new Date(e.date).toISOString().slice(0,10), e.action.type, e.reducer?.name,
    JSON.stringify((e.stateDiff ?? []).map(f => [f.field, f.delta ?? f.after])));
  shown++;
}

console.log('\n=== proceeds split: rows with vs without an AU gain ===');
let withGain = 0, withoutGain = 0, nRowsWith = 0, nRowsWithout = 0;
const seen3 = new Set();
for (let i = start; i < idx; i++) {
  const e = journal[i];
  const d = e.action?.data;
  if (!d?.proceeds) continue;
  const id = e.action.instanceId;
  if (id != null) { if (seen3.has(id)) continue; seen3.add(id); }
  const isAu = d.residency === 'AU' || e.action.type.startsWith('AU_');
  if (!isAu) continue;
  if ((d.auGain ?? 0) > 0) { withGain += d.proceeds; nRowsWith++; }
  else { withoutGain += d.proceeds; nRowsWithout++; }
}
console.log(`  auGain>0: ${nRowsWith} rows, proceeds ${withGain.toFixed(0)}`);
console.log(`  auGain=0: ${nRowsWithout} rows, proceeds ${withoutGain.toFixed(0)}`);

console.log('\n=== crossfoot: worksheet gain columns vs each return ===');
for (const d of [].concat(docs ?? [])) {
  if (!d.title.includes('CGT Worksheet')) continue;
  const t = d.table.totals;
  const gains = t[5] + t[6] - t[7];
  const ptdRow = ptd.find(p => p.personKey === d.personKey);
  const h = ptdRow?.taxDetail?.inputs?.capitalGains ?? 0;
  const ok = Math.abs(gains - h) < 0.01;
  console.log(`  ${d.personName}: worksheet ${gains.toFixed(2)}  vs  label H ${h.toFixed(2)}  ${ok ? 'TIE ✓' : 'MISMATCH ✗'}`);
  console.log(`     rows=${d.table.rows.length} proceeds=${t[3].toFixed(2)} costBase=${t[4].toFixed(2)}`);
  for (const n of d.notes ?? []) console.log(`     note: ${n}`);
}
