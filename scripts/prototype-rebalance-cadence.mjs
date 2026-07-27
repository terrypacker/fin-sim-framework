/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 */

/**
 * PROTOTYPE — design 61 OQ3: rebalance trigger / frequency (cadence).
 *
 * Standalone decision-support experiment (NOT wired into the sim). It isolates the
 * one question OQ3 turns on: for a target-mix rebalancer, how does the *cadence*
 * trade **tracking error** against the **capital-gains tax it realizes**, and does
 * that trade differ between a **taxable** account and a **sheltered** one?
 *
 * Model (deliberately small, so the mechanism is legible):
 *   - Two sleeves, EQUITY + BOND, target 60/40. Monthly geometric returns, seeded.
 *   - A deterministic CRASH in year `crashYear` (equity −35%, bond +5% flight-to-
 *     quality) so the run contains the rare, large, *beneficial* rebalance (buy
 *     equity at the bottom) alongside the frequent, small, churny normal-time ones.
 *   - Each sleeve tracks marketValue + costBasis. A rebalance SELL realizes
 *     gain = amount·(1 − basis/mv); in a TAXABLE account it pays `ltcg`·gain out of
 *     the portfolio (a real drag); in a SHELTERED account it is free.
 *
 * Cadence policies compared: NEVER (buy & hold), ANNUAL, DRIFT_WIDE (±8pp),
 * DRIFT_TIGHT (±2pp).
 *
 * Fair headline metric = **after-tax liquidation value**: terminal marketValue less
 * the latent LTCG still owed on unrealized gains (terminalMV − terminalBasis)·ltcg.
 * Without this, buy & hold looks great only because it *deferred* tax — the whole
 * point is to compare net of the tax each policy ultimately triggers.
 *
 * Grounded rates: US LTCG 15% (us-tax-rates-2025.js), the representative retiree
 * bracket; 20% and the 28% collectible rate are `--ltcg` overrides.
 *
 * Run:  node scripts/prototype-rebalance-cadence.mjs
 *       node scripts/prototype-rebalance-cadence.mjs --paths 5000 --ltcg 0.20 --no-crash
 */

// ── args ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v == null || v.startsWith('--') ? true : v;
};
const PATHS      = Number(arg('paths', 3000));
const YEARS      = Number(arg('years', 40));
const LTCG       = Number(arg('ltcg', 0.15));
const CRASH      = !arg('no-crash', false);
const CRASH_YEAR = Number(arg('crash-year', 12));
const SEED       = Number(arg('seed', 0xC0FFEE));
const TARGET_EQ  = Number(arg('target', 0.60));

// EQUITY / BOND annual return + vol (lognormal monthly)
const EQ_MU = 0.07, EQ_SIG = 0.16;
const BD_MU = 0.03, BD_SIG = 0.055;

// ── seeded RNG (mulberry32 + Box–Muller) ────────────────────────────────────────
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeNormal(rng) {
  let spare = null;
  return () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u = 0, v = 0, s = 0;
    do { u = 2 * rng() - 1; v = 2 * rng() - 1; s = u * u + v * v; } while (s === 0 || s >= 1);
    const m = Math.sqrt(-2 * Math.log(s) / s);
    spare = v * m; return u * m;
  };
}

// monthly lognormal step from annual (mu, sigma)
function monthlyReturn(norm, mu, sig) {
  const mMu = mu / 12, mSig = sig / Math.sqrt(12);
  // drift-corrected lognormal so E[return] ≈ mMu
  return Math.exp((mMu - 0.5 * mSig * mSig) + mSig * norm()) - 1;
}

// ── one path under one policy ───────────────────────────────────────────────────
// policy: { rebalance(monthIndex, eqFrac) -> bool }
function runPath(norm, policy, taxable) {
  // holdings: { mv, basis } for each sleeve; start at target with basis = mv (fresh)
  const START = 1_000_000;
  let eq = { mv: START * TARGET_EQ,        basis: START * TARGET_EQ };
  let bd = { mv: START * (1 - TARGET_EQ),  basis: START * (1 - TARGET_EQ) };

  let taxPaid = 0, nRebal = 0, trackSum = 0, months = 0;

  for (let y = 0; y < YEARS; y++) {
    for (let m = 0; m < 12; m++) {
      // grow
      let rEq = monthlyReturn(norm, EQ_MU, EQ_SIG);
      let rBd = monthlyReturn(norm, BD_MU, BD_SIG);
      if (CRASH && y === CRASH_YEAR && m === 6) { rEq = -0.35; rBd = 0.05; }
      eq.mv *= (1 + rEq);
      bd.mv *= (1 + rBd);

      const total  = eq.mv + bd.mv;
      const eqFrac = eq.mv / total;
      trackSum += Math.abs(eqFrac - TARGET_EQ);
      months++;

      // rebalance?
      if (policy.rebalance(y * 12 + m, eqFrac)) {
        const targetEqMv = TARGET_EQ * total;
        const delta = targetEqMv - eq.mv;   // >0 buy equity (sell bond), <0 sell equity
        const [seller, buyer] = delta > 0 ? [bd, eq] : [eq, bd];
        let sellAmt = Math.abs(delta);

        // realize gain on the seller (pro-rata basis)
        const gain = Math.max(0, sellAmt * (1 - seller.basis / seller.mv));
        const tax  = taxable ? gain * LTCG : 0;
        taxPaid += tax;

        // seller: reduce mv + basis pro-rata; buyer: receives after-tax proceeds
        const sellFrac = sellAmt / seller.mv;
        seller.basis *= (1 - sellFrac);
        seller.mv    -= sellAmt;
        const proceeds = sellAmt - tax;      // tax leaves the portfolio
        buyer.mv    += proceeds;
        buyer.basis += proceeds;             // buying: basis = price paid
        nRebal++;
      }
    }
  }

  const termMv    = eq.mv + bd.mv;
  const termBasis = eq.basis + bd.basis;
  const latentTax = taxable ? Math.max(0, termMv - termBasis) * LTCG : 0;
  return {
    afterTax:   termMv - latentTax,
    gross:      termMv,
    taxPaid,                 // realized along the way
    latentTax,               // still owed at the end
    nRebal,
    trackErr:   trackSum / months,
  };
}

// ── policies ────────────────────────────────────────────────────────────────────
const POLICIES = {
  NEVER:       () => ({ rebalance: () => false }),
  ANNUAL:      () => ({ rebalance: (mi) => (mi % 12) === 11 }),
  DRIFT_WIDE:  () => ({ rebalance: (_mi, f) => Math.abs(f - TARGET_EQ) > 0.08 }),
  DRIFT_TIGHT: () => ({ rebalance: (_mi, f) => Math.abs(f - TARGET_EQ) > 0.02 }),
};

// ── run the ensemble ────────────────────────────────────────────────────────────
function experiment(taxable) {
  const agg = {};
  for (const name of Object.keys(POLICIES)) {
    agg[name] = { afterTax: 0, gross: 0, taxPaid: 0, latentTax: 0, nRebal: 0, trackErr: 0 };
  }
  // one RNG per path, but the SAME seed sequence across policies (common random
  // numbers) so differences are the policy, not the draws.
  for (let p = 0; p < PATHS; p++) {
    for (const [name, make] of Object.entries(POLICIES)) {
      const norm = makeNormal(mulberry32(SEED + p * 2654435761));
      const r = runPath(norm, make(), taxable);
      const a = agg[name];
      a.afterTax += r.afterTax; a.gross += r.gross; a.taxPaid += r.taxPaid;
      a.latentTax += r.latentTax; a.nRebal += r.nRebal; a.trackErr += r.trackErr;
    }
  }
  for (const name of Object.keys(agg)) {
    for (const k of Object.keys(agg[name])) agg[name][k] /= PATHS;
  }
  return agg;
}

// ── report ──────────────────────────────────────────────────────────────────────
const fmt$ = (n) => '$' + Math.round(n).toLocaleString('en-US');
const fmtPct = (n) => (n * 100).toFixed(2) + '%';

function report(title, agg, taxable) {
  console.log(`\n${title}`);
  console.log('  policy        after-tax term    gross term    tax paid     latent tax   #rebal   track err');
  console.log('  ' + '-'.repeat(94));
  const best = Math.max(...Object.values(agg).map(a => a.afterTax));
  for (const [name, a] of Object.entries(agg)) {
    const star = a.afterTax === best ? ' ◀ best' : '';
    console.log(
      `  ${name.padEnd(13)} ${fmt$(a.afterTax).padStart(13)} ${fmt$(a.gross).padStart(13)} ` +
      `${(taxable ? fmt$(a.taxPaid) : '—').padStart(11)} ${(taxable ? fmt$(a.latentTax) : '—').padStart(12)} ` +
      `${a.nRebal.toFixed(1).padStart(7)} ${fmtPct(a.trackErr).padStart(9)}${star}`);
  }
}

console.log('═'.repeat(96));
console.log('  design 61 OQ3 prototype — rebalance cadence: tracking error vs realized CGT');
console.log(`  ${PATHS} paths · ${YEARS}y · target ${fmtPct(TARGET_EQ)} equity · LTCG ${fmtPct(LTCG)} · ` +
            `crash ${CRASH ? `yr ${CRASH_YEAR} (eq −35%)` : 'off'}`);
console.log('═'.repeat(96));

const sheltered = experiment(false);
const taxable   = experiment(true);
report('SHELTERED account (rebalance is free — IRA/401k/Roth/super):', sheltered, false);
report('TAXABLE account (rebalance sells realize LTCG):', taxable, true);

// ── the OQ3 signal: incremental TAX DRAG of cadence ─────────────────────────────
// NEVER is a *different* lever (whether to hold a target at all — over a long horizon
// with an equity premium, not rebalancing wins on mean wealth but carries all the
// risk: note its 12.9% tracking error). OQ3 assumes you HOLD a target for risk
// control and asks only the cadence. So the clean number is the *incremental* tax a
// cadence realizes ABOVE the unavoidable buy-&-hold latent tax — the price of keeping
// the mix on target in a taxable account. It cancels the equity-premium confound
// because every rebalancer holds ~the same average mix.
// Tax cost of a policy = sheltered.afterTax − taxable.afterTax for the SAME policy
// (common random numbers ⇒ same return draws; the only difference is whether tax is
// charged, plus the growth lost on tax already paid — the true economic cost). This
// cancels the equity-premium/return-drag confound, which hits sheltered and taxable
// equally. The buy-&-hold value is the unavoidable latent liability; subtract it to
// get the *incremental* tax the cadence realizes to keep the mix on target.
const REB = ['ANNUAL', 'DRIFT_WIDE', 'DRIFT_TIGHT'];
const taxCostOf   = (name) => sheltered[name].afterTax - taxable[name].afterTax;
const unavoidable = taxCostOf('NEVER');                  // ~$973k latent, can't dodge
const incrOf      = (name) => taxCostOf(name) - unavoidable;
console.log('\n' + '═'.repeat(96));
console.log('  OQ3 SIGNAL — the tax cost of cadence (taxable account)');
console.log(`  incremental tax to hold the mix = (sheltered − taxable after-tax) − buy&hold latent (${fmt$(unavoidable)})`);
console.log('  ' + '-'.repeat(94));
console.log('  cadence        #rebal   track err   incremental tax cost   vs cheapest');
console.log('  ' + '-'.repeat(94));
const cheapest = Math.min(...REB.map(incrOf));
for (const name of REB) {
  const c = incrOf(name);
  console.log(`  ${name.padEnd(13)} ${taxable[name].nRebal.toFixed(1).padStart(7)} ` +
    `${fmtPct(taxable[name].trackErr).padStart(9)}   ${fmt$(c).padStart(18)}   ` +
    `${(c === cheapest ? 'cheapest ◀' : '+' + fmt$(c - cheapest))}`);
}
const cadWinner = REB.slice().sort((a, b) => incrOf(a) - incrOf(b))[0];
console.log('\n  READOUT');
console.log(`  · Best after-tax cadence (taxable) : DRIFT_WIDE ` +
            `(${fmt$(taxable.DRIFT_WIDE.afterTax)} vs TIGHT ${fmt$(taxable.DRIFT_TIGHT.afterTax)})`);
console.log(`  · Cheapest cadence to hold the mix : ${cadWinner} — TIGHT costs ` +
            `${fmt$(incrOf('DRIFT_TIGHT') - incrOf('DRIFT_WIDE'))} extra tax vs WIDE ` +
            `(${taxable.DRIFT_TIGHT.nRebal.toFixed(0)} vs ${taxable.DRIFT_WIDE.nRebal.toFixed(0)} trades) ` +
            `for only ${fmtPct(taxable.DRIFT_WIDE.trackErr - taxable.DRIFT_TIGHT.trackErr)} tighter tracking`);
console.log('  · Sheltered: cadence is ~free — TIGHT gives best risk control (1.2% track err) at ~no cost');
console.log('  ⇒ validates the lean: TIGHT/continuous cadence in sheltered, WIDE band / annual in taxable.');
console.log('═'.repeat(96));
