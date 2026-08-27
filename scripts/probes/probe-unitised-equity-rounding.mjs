#!/usr/bin/env node
/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * probe-unitised-equity-rounding.mjs — design 94 §9.3's deciding measurement.
 *
 * Design 94 step 3 flips every equity sleeve from SCALAR (`marketValue` is the stored
 * primary) to UNITISED (`marketValue = units x pricePerUnit`, design 93 §5). Its first
 * pass claimed the flip is numerically byte-identical, on the grounds that unitisation is
 * value-preserving by construction. **It is not, and the gap is a rounding gap.**
 *
 * ─── where the cent comes from ──────────────────────────────────────────────────────
 *
 * The two modes round in different places:
 *
 *   SCALAR      grow:  mv  = round2(mv + round2(mv x rate))
 *               sell:  mv  = round2(mv x f)
 *               buy:   mv  = round2(mv + amount)
 *
 *   UNITISED    grow:  price = round8(target / units);  mv = round2(units x price)
 *               sell:  units = round8(units x f);       mv = round2(units x price)
 *               buy:   units = round8(units + amount / price)
 *
 * On a pure GROWTH path the two agree exactly — a repricing round-trips through 8-dp price
 * and back to 2-dp value without loss at any realistic position size. The moment UNITS
 * change, the rounding happens on a different quantity and the two representations can
 * land a cent apart.
 *
 * The error stays TINY in relative terms (~1e-7 over a 44-year horizon) because the
 * unitised value is re-derived from the unit count every period rather than carried
 * forward through successive multiplications — one of design 93 §9.5's arguments for the
 * representation, now measured. It is not, however, bounded: each unit-changing operation
 * is another sub-cent coin flip, so the absolute gap random-walks upward with the number
 * of operations. Run `--years 100` to see it. Report both columns.
 *
 * ─── why it matters ─────────────────────────────────────────────────────────────────
 *
 * The goldens are whole-state exact-match fixtures. A cent is a diff. So the migration
 * lands WITH a re-gold, and the re-gold is the deliverable of step 3 rather than an
 * accident of it — which is the opposite of the risk posture the first pass assumed.
 *
 * ⚠️ This is a standalone REPLICA of the four primitives' arithmetic (`reprice`, `resize`,
 * `addValue`, `syncHolding` in `holding-utils.js`), not the engine. It answers "can the
 * two representations disagree, by how much, and on which paths" — the definitive answer
 * is a real golden run under step 3, and the prediction this probe makes for it is:
 * cent-scale movement on accounts with equity FLOW, none on accounts without.
 *
 * Usage:
 *   node scripts/probes/probe-unitised-equity-rounding.mjs [--positions 20000] \
 *        [--years 44] [--seed 12345] [--par 100]
 */

const argv = process.argv.slice(2);
const at   = (flag, dflt) => { const i = argv.indexOf(flag); return i >= 0 ? Number(argv[i + 1]) : dflt; };

const POSITIONS = at('--positions', 20000);
const YEARS     = at('--years', 44);
const SEED      = at('--seed', 12345);
const PAR       = at('--par', 100);          // design 93 §5b's PAR_PER_UNIT convention

// The engine's rounding: money at 2dp, unit counts and per-unit prices at 8dp.
const r2 = x => +x.toFixed(2);
const r8 = x => +x.toFixed(8);

/** Deterministic LCG — this probe must reproduce exactly, like the engine it models. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
}

/**
 * Walk one position through `YEARS` under both representations.
 * @param {boolean} flow - false: growth only. true: grow, then sell a fraction, then buy.
 * @returns {{diverged: boolean, worst: number, worstRel: number, year: number|null}}
 */
function walk(rand, flow) {
  let mvS = r2(1000 + rand() * 2_000_000);
  let units = r8(mvS / PAR);
  let price = r8(mvS / units);
  let mvU = r2(units * price);

  let worst = 0, worstRel = 0, year = null;
  for (let y = 0; y < YEARS; y++) {
    const rate = -0.3 + rand() * 0.55;

    // grow — a PRICE move in both modes (design 93 §4 `reprice`)
    mvS = Math.max(0, r2(mvS + r2(mvS * rate)));
    const target = Math.max(0, mvU + r2(mvU * rate));
    price = r8(units > 0 ? target / units : 0);
    mvU   = r2(units * price);

    if (flow) {
      // sell a fraction — a UNIT move (`resize`)
      const f = 1 - rand() * 0.3;
      mvS   = r2(mvS * f);
      units = r8(units * f);
      mvU   = r2(units * price);

      // buy with new money — a UNIT move at the prevailing price (`addValue`)
      const amount = r2(rand() * 50_000);
      mvS   = r2(mvS + amount);
      units = r8(units + (price > 0 ? amount / price : 0));
      mvU   = r2(units * price);
    }

    const d = Math.abs(mvS - mvU);
    if (d > 0.005) {
      if (year == null) year = y;
      if (d > worst) worst = d;
      const rel = d / Math.max(mvS, 1);
      if (rel > worstRel) worstRel = rel;
    }
  }
  return { diverged: year != null, worst, worstRel, year, finalGap: Math.abs(mvS - mvU) };
}

function measure(label, flow) {
  const rand = lcg(SEED);
  let diverged = 0, worst = 0, worstRel = 0, finalSum = 0;
  for (let i = 0; i < POSITIONS; i++) {
    const r = walk(rand, flow);
    finalSum += r.finalGap;
    if (r.diverged) {
      diverged++;
      if (r.worst > worst) worst = r.worst;
      if (r.worstRel > worstRel) worstRel = r.worstRel;
    }
  }
  const pct = (diverged / POSITIONS * 100).toFixed(1);
  console.log(`  ${label.padEnd(34)} ${String(diverged).padStart(6)} / ${POSITIONS}  (${pct.padStart(5)}%)` +
              `   worst $${worst.toFixed(4)}   mean final gap $${(finalSum / POSITIONS).toFixed(4)}` +
              `   worst rel ${worstRel === 0 ? '0' : worstRel.toExponential(1)}`);
  return diverged;
}

console.log('');
console.log('design 94 §9.3 — does unitising an equity sleeve change the money?');
console.log('─'.repeat(78));
console.log(`${POSITIONS.toLocaleString()} positions ($1k–$2M) x ${YEARS} annual steps · par ${PAR} · seed ${SEED}`);
console.log('replica of holding-utils.js arithmetic — NOT the engine (see the file header)');
console.log('');
console.log('  path                               positions that ever diverged');
const growthOnly = measure('growth only (reprice)', false);
const lifecycle  = measure('grow + sell + buy (full lifecycle)', true);
console.log('');
if (growthOnly === 0 && lifecycle > 0) {
  console.log('As design 94 §9.3 predicts: EXACT on the growth path, sub-cent once units move.');
  console.log('The migration lands with a re-gold. "Byte-identical" is the wrong claim.');
} else if (growthOnly === 0 && lifecycle === 0) {
  console.log('No divergence on either path — design 94 §9.3 would be too pessimistic.');
} else {
  console.log('Growth path diverged: design 94 §9.3 is UNDERSTATED. Re-read before step 3.');
}
console.log('');
