/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 */

/**
 * PROTOTYPE — design 61 OQ6: GLOBAL vs LOCAL allocation scope across a border.
 *
 * Standalone, DETERMINISTIC decision-support model (not wired into the sim). OQ6
 * asks whether the target mix should be one **GLOBAL** book across US+AU (located in
 * the tax-favored country) or a **per-country LOCAL** mix — and how it pairs with the
 * design-58 cross-border drawdown lever (AUTO/LOCAL_FIRST/GLOBAL).
 *
 * The mechanism isolated: a GLOBAL scope can satisfy the *same overall risk mix*
 * while placing each asset class where its gains are taxed least (an arbitrage LOCAL
 * forgoes), at the cost of a one-time FX friction to relocate. So:
 *
 *     GLOBAL advantage ≈ Δtax · (grown gains relocated)  −  f · (principal relocated)
 *
 * The tax saving accrues on gains that **compound over the horizon**; the FX cost is
 * paid **once**. So the advantage grows with horizon and with the cross-jurisdiction
 * tax spread, and there is a **break-even FX friction** below which GLOBAL wins.
 *
 * Illustrative effective terminal CGT rates (documented, not authoritative — the
 * STRUCTURE is the lesson). The driving real asymmetry is GOLD: US 28% collectibles
 * (no discount) vs AU ordinary CGT with the 50% long-term discount (~15%); equity is
 * ~symmetric (US 15% LTCG ≈ AU 30% marginal × 50% discount). See design 56/57.
 *
 * Run:  node scripts/prototype-crossborder-allocation-scope.mjs
 *       node scripts/prototype-crossborder-allocation-scope.mjs --years 30 --gold-au 0.15
 */

// ── args ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : Number(argv[i + 1]); };
const YEARS  = arg('years', 30);
const START  = 1_000_000;                     // total, split 50/50 US/AU at t0

// target overall mix (must sum to 1)
const TARGET = { EQUITY: 0.50, BOND: 0.30, GOLD: 0.20 };

// annual real growth per class (illustrative)
const GROWTH = { EQUITY: 0.06, BOND: 0.02, GOLD: 0.03 };

// effective terminal CGT rate per (country, class). GOLD is the asymmetry.
const CGT = {
  US: { EQUITY: 0.15, BOND: 0.15, GOLD: 0.28 },                         // US collectibles 28%
  AU: { EQUITY: 0.15, BOND: 0.15, GOLD: arg('gold-au', 0.15) },         // AU: 50% CGT discount
};

const CLASSES   = Object.keys(TARGET);
const COUNTRIES = ['US', 'AU'];

// ── helpers ─────────────────────────────────────────────────────────────────────
// A "book" = { US: {EQUITY,BOND,GOLD}, AU: {...} } of principal placed at t0 (basis).
// Grow each sleeve, then liquidate paying that country's CGT on the gain.
function afterTaxTerminal(book) {
  let total = 0;
  for (const c of COUNTRIES) {
    for (const k of CLASSES) {
      const principal = book[c][k];
      if (principal <= 0) continue;
      const mv   = principal * Math.pow(1 + GROWTH[k], YEARS);
      const gain = mv - principal;
      total += mv - gain * CGT[c][k];
    }
  }
  return total;
}

const emptyBook = () => ({ US: { EQUITY: 0, BOND: 0, GOLD: 0 }, AU: { EQUITY: 0, BOND: 0, GOLD: 0 } });

// LOCAL: each country independently holds the target mix over its own half.
function localBook() {
  const b = emptyBook();
  for (const c of COUNTRIES) for (const k of CLASSES) b[c][k] = (START / 2) * TARGET[k];
  return b;
}

// GLOBAL: hit the overall class totals, but LOCATE each class in the cheaper-tax
// country up to that country's capacity (START/2 each). Greedy by tax spread.
function globalBook() {
  const b = emptyBook();
  const cap = { US: START / 2, AU: START / 2 };
  // order classes by |US−AU tax spread| desc, so the most tax-asymmetric class is
  // placed first while capacity remains.
  const order = [...CLASSES].sort((a, z) =>
    Math.abs(CGT.US[z] - CGT.AU[z]) - Math.abs(CGT.US[a] - CGT.AU[a]));
  for (const k of order) {
    let need = START * TARGET[k];
    const cheaper = CGT.US[k] <= CGT.AU[k] ? 'US' : 'AU';
    const other   = cheaper === 'US' ? 'AU' : 'US';
    const toCheaper = Math.min(need, cap[cheaper]);
    b[cheaper][k] += toCheaper; cap[cheaper] -= toCheaper; need -= toCheaper;
    b[other][k]   += need;      cap[other]   -= need;      // remainder overflows
  }
  return b;
}

// FX friction: the principal that GLOBAL moves across the border vs LOCAL, ×f, paid
// once at t0 (so it doesn't compound). Movement = Σ max(0, global−local) on one side.
function relocatedPrincipal(local, global) {
  let moved = 0;
  for (const k of CLASSES) moved += Math.max(0, global.US[k] - local.US[k]); // net into US == net out of AU
  return moved;
}

// ── report ──────────────────────────────────────────────────────────────────────
const fmt$ = (n) => '$' + Math.round(n).toLocaleString('en-US');
const fmtPct = (n) => (n * 100).toFixed(2) + '%';

const local  = localBook();
const global  = globalBook();
const localAT  = afterTaxTerminal(local);
const globalATgross = afterTaxTerminal(global);   // before FX friction
const moved = relocatedPrincipal(local, global);

console.log('═'.repeat(92));
console.log('  design 61 OQ6 prototype — GLOBAL vs LOCAL allocation scope across the US↔AU border');
console.log(`  ${YEARS}y · target ${CLASSES.map(k => `${k[0]}${(TARGET[k]*100)}`).join('/')} · ` +
            `US gold CGT ${fmtPct(CGT.US.GOLD)} vs AU gold CGT ${fmtPct(CGT.AU.GOLD)}`);
console.log('═'.repeat(92));

console.log('\n  Placement (principal at t0):');
console.log('  class     LOCAL  US / AU              GLOBAL US / AU        (GLOBAL locates gold in AU)');
for (const k of CLASSES) {
  console.log(`  ${k.padEnd(7)} ${fmt$(local.US[k]).padStart(10)} /${fmt$(local.AU[k]).padStart(10)}   ` +
              `${fmt$(global.US[k]).padStart(10)} /${fmt$(global.AU[k]).padStart(10)}`);
}
console.log(`  → GLOBAL relocates ${fmt$(moved)} across the border (gold US→AU, equity backfills US).`);

console.log(`\n  After-tax terminal (before FX friction):`);
console.log(`    LOCAL  : ${fmt$(localAT)}`);
console.log(`    GLOBAL : ${fmt$(globalATgross)}   (Δ +${fmt$(globalATgross - localAT)} from tax-location)`);

// ── FX-friction sweep: where does GLOBAL stop winning? ──────────────────────────
console.log('\n  FX-friction sweep (one-time cost on relocated principal):');
console.log('    f (FX)    GLOBAL after-tax net    vs LOCAL      verdict');
console.log('    ' + '-'.repeat(72));
let breakeven = null;
for (const f of [0.000, 0.0025, 0.005, 0.0075, 0.010, 0.015, 0.020]) {
  const net = globalATgross - moved * f;
  const d = net - localAT;
  if (breakeven === null && d < 0) breakeven = f;
  console.log(`    ${fmtPct(f).padStart(6)}   ${fmt$(net).padStart(18)}    ${(d >= 0 ? '+' : '') + fmt$(d)}` +
              `${(d >= 0 ? '   GLOBAL wins' : '   LOCAL wins')}`);
}
const beStr = breakeven === null ? '> 2.0% (GLOBAL wins across the sweep)'
  : `≈ ${fmtPct(breakeven)} (below this, GLOBAL wins)`;

// ── horizon compounding: the tax saving grows, FX cost is fixed ─────────────────
console.log('\n  Horizon effect (tax-location Δ compounds; FX cost is one-time):');
console.log('    years     tax-location Δ    (@ f=0.5%) GLOBAL net vs LOCAL');
console.log('    ' + '-'.repeat(60));
for (const y of [10, 20, 30, 40]) {
  const grow = (book) => {
    let t = 0;
    for (const c of COUNTRIES) for (const k of CLASSES) {
      const p = book[c][k]; if (p <= 0) continue;
      const mv = p * Math.pow(1 + GROWTH[k], y), gain = mv - p;
      t += mv - gain * CGT[c][k];
    }
    return t;
  };
  const dTax = grow(global) - grow(local);
  const net  = (grow(global) - moved * 0.005) - grow(local);
  console.log(`    ${String(y).padStart(4)}     ${fmt$(dTax).padStart(14)}    ${(net >= 0 ? '+' : '') + fmt$(net)}`);
}

// ── sensitivity to the BIG sleeve: AU equity CGT (franking / 50% discount) ──────
// Gold is a small, slow sleeve, so its asymmetry alone is a modest edge. The real
// prize is when a LARGE sleeve (equity) is also cheaper in one country — e.g. AU's
// franking credits + 50% CGT discount. Sweep AU equity CGT and watch the edge scale.
console.log('\n  Sensitivity — GLOBAL edge vs AU equity CGT rate (equity is the big sleeve):');
console.log('    AU equity CGT   equity spread   GLOBAL edge (@ f=0.5%, 30y)');
console.log('    ' + '-'.repeat(62));
const baseUSeq = CGT.US.EQUITY;
for (const auEq of [0.15, 0.125, 0.10, 0.075, 0.05]) {
  const cgt2 = { US: { ...CGT.US }, AU: { ...CGT.AU, EQUITY: auEq } };
  const at = (book) => {
    let t = 0;
    for (const c of COUNTRIES) for (const k of CLASSES) {
      const p = book[c][k]; if (p <= 0) continue;
      const mv = p * Math.pow(1 + GROWTH[k], 30), gain = mv - p;
      t += mv - gain * cgt2[c][k];
    }
    return t;
  };
  // re-locate greedily under the new rates
  const g = emptyBook(); const cap = { US: START / 2, AU: START / 2 };
  const order = [...CLASSES].sort((a, z) =>
    Math.abs(cgt2.US[z] - cgt2.AU[z]) - Math.abs(cgt2.US[a] - cgt2.AU[a]));
  for (const k of order) {
    let need = START * TARGET[k];
    const cheaper = cgt2.US[k] <= cgt2.AU[k] ? 'US' : 'AU';
    const other = cheaper === 'US' ? 'AU' : 'US';
    const toCheaper = Math.min(need, cap[cheaper]);
    g[cheaper][k] += toCheaper; cap[cheaper] -= toCheaper; need -= toCheaper;
    g[other][k] += need; cap[other] -= need;
  }
  const mv2 = relocatedPrincipal(local, g);
  const edge = (at(g) - mv2 * 0.005) - at(local);
  console.log(`    ${fmtPct(auEq).padStart(8)}       ${(baseUSeq - auEq >= 0 ? '+' : '') + fmtPct(baseUSeq - auEq).padStart(6)}         ${(edge >= 0 ? '+' : '') + fmt$(edge)}`);
}

console.log('\n' + '═'.repeat(92));
console.log('  READOUT');
console.log(`  · GLOBAL scope enables cross-border asset location: gold → AU (dodges US 28%),`);
console.log(`    equity backfills the US side to hold the SAME overall ${fmtPct(TARGET.EQUITY)}/${fmtPct(TARGET.BOND)}/${fmtPct(TARGET.GOLD)} mix.`);
console.log(`  · Tax-location gain (before FX): +${fmt$(globalATgross - localAT)} on ${fmt$(moved)} relocated.`);
console.log(`  · FX-friction break-even: ${beStr}`);
console.log(`  · The edge COMPOUNDS with horizon (tax saving grows on grown gains; FX cost is one-time),`);
console.log(`    and scales with the US↔AU tax spread — shrinks toward 0 as jurisdictions converge.`);
console.log(`  · Pairs with design-58 Lever A: use GLOBAL allocation WITH GLOBAL drawdown, else a`);
console.log(`    LOCAL_FIRST drawdown re-sells the located gold and undoes the arbitrage.`);
console.log('═'.repeat(92));
