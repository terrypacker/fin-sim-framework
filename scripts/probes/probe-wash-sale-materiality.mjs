/**
 * R2 — wash-sale MATERIALITY (design 94 §12, the gate on step 7).
 *
 * R1 answered the rule and the window. What R2 has to answer is whether the exposure is
 * worth a large step: **how much loss is at stake, and how much of it lands in a sheltered
 * account**, where Rev. Rul. 2008-5 DESTROYS it rather than deferring it.
 *
 * §12 said this is "meaningful only after dispersion exists, since a model that cannot
 * produce a loss cannot produce a wash sale". That precondition is now met — not by design
 * 90 §7.4's sleeve dispersion, which is still unbuilt, but by design 94 step 4: a security
 * with idiosyncratic vol can fall in a year its market rose, which is the first thing in
 * this engine that can put ONE position under water while the rest of the book is fine.
 *
 * ── what it measures ─────────────────────────────────────────────────────────
 *
 * Per run, from the journal and from a reducer walk:
 *
 *   1. every REALISED LOSS (any disposal path, not only the harvester);
 *   2. every ACQUISITION of equity — detected as a UNIT increase, which is what design 94
 *      §9.4's valueKind discriminator makes distinguishable from a price move at all;
 *   3. the ±30-day match between them, under BOTH candidate identity relations, because
 *      §8.1c is explicit that the relation cannot be derived and must be declared:
 *        - STRICT: same `securityId`   — the relation Option C can state
 *        - LOOSE:  same `rateKey`      — the relation `resolveSubstitute` uses TODAY
 *      The two bracket the answer; nothing in the sources picks between them.
 *   4. the replacement account: TAXABLE (§1091(d) defers the loss into the new basis) vs
 *      SHELTERED (Rev. Rul. 2008-5: disallowed AND no basis increase — destroyed).
 *
 * ── arms ─────────────────────────────────────────────────────────────────────
 *
 *   base          stochastic equity, no authored security. Losses can only come from a
 *                 market-wide down year, which is design 90 §1.3's structural point.
 *   concentrated  + one security at β 1.35 / σ_idio 0.35, held in the taxable brokerage
 *                 AND the 401(k) — so a replacement of the SAME security inside a
 *                 sheltered wrapper is reachable. This is the Rev. Rul. 2008-5 fact
 *                 pattern, and it is the case §8.1b calls "the row with money in it".
 *
 * Run: node scripts/probes/probe-wash-sale-materiality.mjs [seeds]
 */

import { ServiceRegistry }        from '../../src/services/service-registry.js';
import { BaseScenario }           from '../../src/scenarios/base-scenario.js';
import { ScenarioLoader }         from '../../src/scenarios/scenario-loader.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { RATE_KEYS }              from '../../src/finance/economic-regimes/rate-keys.js';

const SEEDS   = Number(process.argv[2] ?? 25);
const SIM_END = Date.UTC(2050, 0, 1);
const DAY     = 24 * 60 * 60 * 1000;
const WINDOW  = 30 * DAY;               // §1.1091-1(a): 30 before + sale day + 30 after

/** Wrappers whose replacement purchase destroys the loss instead of deferring it. */
const SHELTERED = /^(k401|ira|roth|spouseK401|spouseIra|spouseRoth|super)/i;
const isSheltered = (stateKey) => SHELTERED.test(stateKey ?? '');

const BASE_PARAMS = {
  equityReturnStochastic: true,
  equityReturnVol:        0.18,
  fxProcessModel:         'NONE',
  behavioralStrategies:      ['TAX_LOSS_HARVEST', 'TARGET_ALLOCATION'],
  allocationStrategy:        'STATIC',
  allocationSchedule:        'STATIC',
  rebalanceTargetAllocation: { EQUITY: 0.7, BOND: 0.3, CASH: 0, GOLD: 0 },
};

/** The concentrated arm's registry + the two lots that name it. */
function concentrate(cfg, distinct = false) {
  cfg.securities = [{ id: 'sec-emp', symbol: 'EMP', rateKey: RATE_KEYS.EQUITY_US, beta: 1.35, idioVol: 0.35 }];
  const brokerage = cfg.accounts.find(a => a.stateKey === 'usStockAccount');
  brokerage.holdings.find(h => h.id === 'h-us-equity').securityId = 'sec-emp';
  cfg.accounts.find(a => a.stateKey === 'k401Account')
    .holdings.find(h => h.id === 'h-401k-equity').securityId = 'sec-emp';
  if (!distinct) return;
  // A second US-market security in the SAME account, in its own identity group, for the
  // harvester to rotate into (design 94 §8.1h step 2). The intl sleeve is re-pointed rather
  // than a lot being added, so total equity — and therefore the plan — is unchanged.
  cfg.securities.push({ id: 'sec-alt', symbol: 'ALT', rateKey: RATE_KEYS.EQUITY_US, beta: 1.0, idioVol: 0 });
  brokerage.holdings.find(h => h.id === 'h-intl-equity').securityId = 'sec-alt';
  brokerage.holdings.find(h => h.id === 'h-intl-equity').rateKey    = RATE_KEYS.EQUITY_US;
}

/** Fund the IRA and point it at the concentrated security — the Rev. Rul. 2008-5 case. */
function fundIra(cfg) {
  const iraAcct = cfg.accounts.find(a => a.stateKey === 'iraAccount');
  iraAcct.balance  = 300_000;
  iraAcct.holdings = [{
    id: 'h-ira-equity', label: 'IRA Equity', allocation: 'EQUITY',
    rateKey: RATE_KEYS.EQUITY_US, securityId: 'sec-emp',
    marketValue: 300_000, costBasis: 300_000,
  }];
}

/** Every equity lot in a state as `stateKey.lotId → { units, securityId, rateKey }`. */
function equityLots(state) {
  const out = new Map();
  for (const [k, a] of Object.entries(state ?? {})) {
    if (!a || typeof a !== 'object' || !Array.isArray(a.holdings)) continue;
    for (const h of a.holdings) {
      if (h?.allocation !== 'EQUITY' || h.units == null) continue;
      out.set(`${k}.${h.id}`, { stateKey: k, units: h.units, mv: h.marketValue ?? 0,
                                basis: h.costBasis ?? 0,
                                securityId: h.securityId ?? null, rateKey: h.rateKey ?? null });
    }
  }
  return out;
}

function runOne({ seed, concentrated, capped, distinct, ira }) {
  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();
  const cfg = IntlRetirementScenario.buildDefaultConfig(
    { ...BASE_PARAMS, randomSeed: seed, ...(capped ? { taxLossHarvestCap: 3000 } : {}) },
    new Date(Date.UTC(2026, 0, 1)), new Date(SIM_END));
  if (concentrated) concentrate(cfg, distinct);
  if (ira) fundIra(cfg);

  const scenario = new BaseScenario({
    context: services.simulationContext, initialState: cfg.initialState ?? {},
    simStart: new Date(cfg.simStart), simEnd: new Date(cfg.simEnd),
  });
  scenario.buildSim({ telemetry: 'journal' });
  new ScenarioLoader().load(cfg, services);

  // ── the acquisition walk ────────────────────────────────────────────────────
  // A UNIT increase is a purchase; a value increase with the unit count unchanged is a
  // price move. Only the discriminator makes the two separable (design 94 §9.4), and only
  // the walk sees every path — contributions, reinvestment, the rebalancer and the
  // harvester's own rebuy all reach a lot by different action types.
  const buys = [];
  const sells = [];
  for (const r of services.reducerService.getAll()) {
    const orig = r.reduce.bind(r);
    r.reduce = (state, action, date) => {
      const before = equityLots(state);
      const out    = orig(state, action, date);
      const after  = equityLots(out?.state ?? out);
      const ms     = date instanceof Date ? date.getTime() : new Date(date ?? 0).getTime();
      if (!Number.isFinite(ms)) return out;
      for (const [key, a] of after) {
        const b = before.get(key);
        const du = a.units - (b?.units ?? 0);
        if (du > 1e-9) buys.push({ ms, ...a, dollars: du * (a.mv / Math.max(a.units, 1e-9)) });
      }
      for (const [key, b] of before) {
        const a = after.get(key);
        const du = (a?.units ?? 0) - b.units;
        // The loss the position CARRIED, pro-rated to the units that left. §1091 nets some
        // of it away before it reaches the return, so this is the only place the gross
        // figure is visible at all.
        if (du < -1e-9) sells.push({ ms, ...b, soldFrac: Math.min(1, -du / Math.max(b.units, 1e-9)) });
      }
      return out;
    };
  }

  // The harvester WARNS and skips when `resolveSubstitute` finds no partner. Counted,
  // because it turned out to bound realised losses harder than the cap does — see the
  // `uncapped` arm.
  let skipped = 0;
  const { log, warn } = console;
  console.log = () => {};
  console.warn = (msg) => { if (typeof msg === 'string' && msg.includes('no substitute')) skipped++; };
  try { scenario.sim.stepTo(new Date(SIM_END)); }
  finally { console.log = log; console.warn = warn; }

  // ── realised losses, from the journal ───────────────────────────────────────
  // Deduped by instanceId: one action is journalled once per reducer that saw it.
  const seen = new Set();
  const amendedSeen = new Set();
  const losses = [];
  let usTaxPaid = 0;
  // What the harvester actually SOLD at a loss, before §1091 nets any of it away. The
  // harvest action carries the position; the tax action carries what survived the rule.
  let immediate = 0;
  for (const e of scenario.sim.journal.journal) {
    const a = e.action;
    const d = a?.data ?? a;
    if (!a?.type || (a.instanceId && seen.has(a.instanceId))) continue;
    if (a.instanceId) seen.add(a.instanceId);
    if (a.type === 'US_TAX_PAYMENT_DEBIT') usTaxPaid += Math.abs(d.amount ?? 0);
    // Stamped by the disposal itself (§8.1j), so this is the exact figure rather than a
    // difference between two aggregates that count different things.
    immediate += d?.washDisallowed ?? 0;

    const gain = d?.gain;
    if (typeof gain === 'number' && gain < 0) {
      losses.push({ ms: new Date(e.date).getTime(), amount: -gain,
                    stateKey: d.stateKey ?? a.stateKey ?? null, type: a.type });
    }
  }

  // ── the ±30-day match ───────────────────────────────────────────────────────
  // The sold lot's identity is read off the unit-DECREASE the walk recorded on the same
  // day in the same account: the tax action names the money, the walk names the security.
  const tally = { loss: 0, strict: 0, loose: 0, strictSheltered: 0, looseSheltered: 0 };
  for (const L of losses) {
    tally.loss += L.amount;
    const sold = sells.filter(s => Math.abs(s.ms - L.ms) <= DAY && (!L.stateKey || s.stateKey === L.stateKey));
    if (!sold.length) {
      if (process.env.WASH_DEBUG) console.error(`  [no sold lot] ${new Date(L.ms).toISOString().slice(0,10)} ${L.type} ${L.stateKey} $${L.amount} | sells near: ${sells.filter(s=>Math.abs(s.ms-L.ms)<=DAY).map(s=>s.stateKey).join(',')||'(none)'}`);
      continue;
    }
    const ids   = new Set(sold.map(s => s.securityId).filter(Boolean));
    const keys  = new Set(sold.map(s => s.rateKey).filter(Boolean));
    const near  = buys.filter(b => Math.abs(b.ms - L.ms) <= WINDOW);
    const mStrict = near.filter(b => ids.has(b.securityId));
    const mLoose  = near.filter(b => keys.has(b.rateKey));
    if (process.env.WASH_DEBUG && !mLoose.length) console.error(`  [no window buy] ${new Date(L.ms).toISOString().slice(0,10)} ${L.stateKey} $${L.amount} soldKeys=${[...keys]} soldIds=${[...ids]} | buys near: ${near.map(b=>b.stateKey+':'+b.rateKey).join(', ')||'(none)'}`);
    if (mStrict.length) {
      tally.strict += L.amount;
      if (mStrict.some(b => isSheltered(b.stateKey))) tally.strictSheltered += L.amount;
    }
    if (mLoose.length) {
      tally.loose += L.amount;
      if (mLoose.some(b => isSheltered(b.stateKey))) tally.looseSheltered += L.amount;
    }
  }
  // What the model now actually DISALLOWS (design 94 §8.1i), as opposed to what the ±30-day
  // scan above says is exposed. The two differ on purpose: the reducer implements only the
  // wrappers the sources on disk name (IRA / Roth IRA), so it under-disallows relative to
  // this probe's upper bound, and the gap is the honest measure of what 7b would add.
  const st = scenario.sim.state;
  // §8.1l — the balance due on the amended returns, which is the disallowance's actual
  // money effect now that it lands on the return it belongs to.
  let amended = 0;
  for (const e of scenario.sim.journal.journal) {
    const d = e.action?.data ?? e.action;
    if (e.action?.type === 'US_TAX_FILE_APPLY' && !amendedSeen.has(e.action.instanceId)) {
      amendedSeen.add(e.action.instanceId);
      amended += d?.delta ?? 0;
    }
  }
  const modelled = (st.washSaleLedger ?? [])
    .reduce((s, e) => s + (e.disallowedShort ?? 0) + (e.disallowedLong ?? 0), 0);
  return { ...tally, usTaxPaid, lossEvents: losses.length, skipped,
           modelled, immediate, amended };
}

// ── run both arms over the seed set ───────────────────────────────────────────
const fmt = (n) => '$' + Math.round(n).toLocaleString('en-US');
const pct = (a, b) => (b > 0 ? (100 * a / b).toFixed(1) + '%' : '—');

console.log(`R2 — wash-sale materiality. ${SEEDS} seeds x 2 arms, 2026-2050, TLH + TARGET_ALLOCATION on.\n`);

const ARMS = [
  { name: 'base',                  concentrated: false, capped: false },
  { name: 'concentrated',          concentrated: true,  capped: false },
  // The pre-7a default, kept as the contrast: `taxLossHarvestCap` used to default to
  // \$3,000/yr, capping the HARVEST rather than the §1211(b) deduction the figure comes
  // from. §8.1h removed that default; this arm re-imposes it to show what it was doing.
  { name: 'concentrated, capped at $3k (the old default)', concentrated: true, capped: true },
  // 7a's substitute fix, made reachable: a SECOND, declared-distinct security in the same
  // market for the harvester to rotate into. Nothing here is a wash.
  { name: 'concentrated + a distinct substitute', concentrated: true, capped: false, distinct: true },
  // The Rev. Rul. 2008-5 fact pattern itself. The reference plan's sheltered equity lives in
  // a 401(k), which no source on disk reaches (§8.1i), so the modelled disallowance on it is
  // near zero however large the ±30-day exposure looks. This arm funds the IRA and points it
  // at the same security, which is the case the ruling is actually about.
  { name: 'concentrated + the SAME security in an IRA', concentrated: true, capped: false, ira: true },
];

for (const { name: arm, concentrated, capped, distinct, ira } of ARMS) {
  const rows = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = runOne({ seed, concentrated, capped, distinct, ira });
    if (process.env.WASH_DEBUG) console.error(`  [${arm} seed ${seed}] loss=$${Math.round(r.loss)} events=${r.lossEvents} loose=$${Math.round(r.loose)} sheltered=$${Math.round(r.looseSheltered)}`);
    rows.push(r);
  }
  const sum = (f) => rows.reduce((s, r) => s + f(r), 0);
  const withLoss = rows.filter(r => r.loss > 0).length;
  const loss = sum(r => r.loss);
  console.log(`── ${arm}`);
  console.log(`   paths realising ANY loss ....... ${withLoss}/${rows.length}`);
  console.log(`   loss events per path (mean) .... ${(sum(r => r.lossEvents) / rows.length).toFixed(1)}`);
  console.log(`   harvests SKIPPED, no substitute . ${(sum(r => r.skipped) / rows.length).toFixed(1)}/path`);
  console.log(`   realised loss, total ........... ${fmt(loss)}  (${fmt(loss / rows.length)}/path)`);
  console.log(`   lifetime US tax, total ......... ${fmt(sum(r => r.usTaxPaid))}`);
  console.log(`   inside a 61-day window:`);
  console.log(`     LOOSE  (same rateKey) ........ ${fmt(sum(r => r.loose))}  ${pct(sum(r => r.loose), loss)} of loss`);
  console.log(`       ... of which SHELTERED ..... ${fmt(sum(r => r.looseSheltered))}  ${pct(sum(r => r.looseSheltered), loss)} of loss  ← destroyed, not deferred`);
  console.log(`     STRICT (same securityId) ..... ${fmt(sum(r => r.strict))}  ${pct(sum(r => r.strict), loss)} of loss`);
  console.log(`       ... of which SHELTERED ..... ${fmt(sum(r => r.strictSheltered))}  ${pct(sum(r => r.strictSheltered), loss)} of loss`);
  // The only PERMANENT number in the exercise. A wash into a taxable replacement moves the
  // loss into the new basis (§1091(d)) and costs timing; a wash into a sheltered wrapper
  // destroys it (Rev. Rul. 2008-5), and that is a rate x dollars answer.
  const destroyedLo = sum(r => r.strictSheltered), destroyedHi = sum(r => r.looseSheltered);
  const tax = sum(r => r.usTaxPaid);
  console.log(`   DISALLOWED — §1091(a)/(d) on the spot (§8.1j) . ${fmt(sum(r => r.immediate) / rows.length)}/path`);
  console.log(`   DISALLOWED — Rev. Rul. 2008-5, lagged (§8.1i) . ${fmt(sum(r => r.modelled) / rows.length)}/path`);
  console.log(`     TAX actually paid on the amended returns .... ${fmt(sum(r => r.amended) / rows.length)}/path`);
  console.log(`   PERMANENT cost of the destroyed share, per path:`);
  console.log(`     at 15%  LTCG ................. ${fmt(0.15  * destroyedLo / rows.length)} – ${fmt(0.15  * destroyedHi / rows.length)}`);
  console.log(`     at 23.8% (LTCG + NIIT) ....... ${fmt(0.238 * destroyedLo / rows.length)} – ${fmt(0.238 * destroyedHi / rows.length)}`);
  console.log(`     as a share of lifetime US tax  ${pct(0.238 * destroyedLo, tax)} – ${pct(0.238 * destroyedHi, tax)}`);
  console.log('');
}
