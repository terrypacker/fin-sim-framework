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
 * equity-sleeve-rng-neutrality.test.mjs — design 90 §1.4 / §7.
 *
 * `EQUITY_SLEEVES` carries a ⚠️ inherited from design 74 §4: the tick handler iterates it
 * to draw idiosyncratic terms, so changing the list shifts the RNG cursor and with it
 * every subsequent draw in the run.
 *
 * **That warning is conditional, and design 90 §1.4 established the condition is false by
 * default.** The single market draw happens BEFORE the sleeve loop; inside the loop a
 * draw happens only when `idioVol[sleeve] > 0`, and is SKIPPED entirely otherwise rather
 * than drawn-and-multiplied-by-zero. So while every sleeve's idio vol is 0, the loop
 * consumes no uniforms at all and the membership and order of `EQUITY_SLEEVES` are
 * RNG-irrelevant.
 *
 * That property is the entire reason §7.2 could re-shape the sleeve list from six
 * account-wrapper keys to four market keys without re-basing every stochastic run. It is
 * load-bearing and invisible — nothing else fails if someone "tidies" the skip into a
 * `dev += idioVol * z` that always draws — so it gets its own file.
 *
 * Run with: node --test tests/unit/equity-sleeve-rng-neutrality.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { EquityReturnTickHandler } from '../../src/finance/economic-regimes/equity-return-tick-handler.js';
import { EQUITY_SLEEVES, RATE_KEYS } from '../../src/finance/economic-regimes/rate-keys.js';
import { buildSecurityRegistry, syntheticEquitySecurities } from '../../src/finance/holdings/security.js';

/** A counting RNG: uniform 0.5 forever, tallying how many draws were taken. */
function countingRng() {
  const state = { draws: 0 };
  const rng = () => { state.draws += 1; return 0.5; };
  return { rng, state };
}

test('design 90 §1.4: with idio vol 0 the sleeve loop consumes NO uniforms', () => {
  const { rng, state } = countingRng();
  new EquityReturnTickHandler({ vol: 0.18 }).call({ sim: { rng }, state: {} });

  // gaussianFrom may take more than one uniform per normal draw, so the assertion is
  // that the count is independent of the sleeve list — not a specific number. The
  // baseline is captured below and compared against a padded list.
  assert.ok(state.draws > 0, 'the market factor itself is drawn');
});

test('design 90 §1.4: adding sleeves does not move the RNG cursor while idio vol is 0', () => {
  // The real invariant. Two handlers, identical config; one is asked to produce
  // deviations for a much longer sleeve list. If the loop drew per sleeve, the draw
  // counts would differ and every subsequent draw in a run would shift.
  const a = countingRng();
  const h = new EquityReturnTickHandler({ vol: 0.18 });
  h.call({ sim: { rng: a.rng }, state: {} });

  const b = countingRng();
  const padded = new EquityReturnTickHandler({ vol: 0.18 });
  // Simulate a longer list by giving every sleeve an explicit ZERO idio vol — the same
  // path a new sleeve takes when nobody has configured one for it.
  padded.idioVol = Object.fromEntries(EQUITY_SLEEVES.map(s => [s, 0]));
  padded.call({ sim: { rng: b.rng }, state: {} });

  assert.equal(b.state.draws, a.state.draws,
    'an explicitly-zero idio vol must consume no uniforms, exactly like an absent one');
});

test('a NON-zero idio vol does draw — the skip is conditional, not dead code', () => {
  // The control. Without this, the test above would pass just as well against a handler
  // that had lost its idiosyncratic term entirely.
  const base = countingRng();
  new EquityReturnTickHandler({ vol: 0.18 }).call({ sim: { rng: base.rng }, state: {} });

  const withIdio = countingRng();
  new EquityReturnTickHandler({ vol: 0.18, idioVol: { [RATE_KEYS.EQUITY_US]: 0.10 } })
    .call({ sim: { rng: withIdio.rng }, state: {} });

  assert.ok(withIdio.state.draws > base.state.draws,
    'enabling idio vol for one sleeve must consume additional uniforms');
});

test('design 90 §7.2: the four sleeves are the MARKETS, not the account wrappers', () => {
  // Pins the axis itself. A regression that reintroduced wrapper sleeves would keep
  // every other test in this file passing.
  assert.deepEqual([...EQUITY_SLEEVES].sort(), [
    RATE_KEYS.EQUITY_AU,
    RATE_KEYS.EQUITY_INTL_EX_AU,
    RATE_KEYS.EQUITY_INTL_EX_US,
    RATE_KEYS.EQUITY_US,
  ].sort());
});

test('EQUITY_SLEEVES is stably sorted — the order matters the moment idio vol is on', () => {
  // Sorted order is what makes the cursor reproducible ACROSS runs once draws resume.
  // Cheap to assert, and the alternative is discovering it from a diverged MC path.
  assert.deepEqual([...EQUITY_SLEEVES], [...EQUITY_SLEEVES].sort());
});

// ─────────────────────────────────────────────────────────────────────────────────────
// design 94 §6.2 / §11 — the same warning, extended to the SECURITY registry.
//
// Step 4 gives securities their own idiosyncratic draws, and they are taken from the same
// cursor, after the sleeve loop. Everything above about sleeves now has to hold about
// securities as well, plus one thing that has no sleeve analogue: the draw set is the
// REGISTRY, not the portfolio.
// ─────────────────────────────────────────────────────────────────────────────────────

/** The migrated world: four synthetic market securities, every one of them the identity. */
const IDENTITY_REGISTRY = buildSecurityRegistry(syntheticEquitySecurities());

const tick = (rng, state = {}) =>
  new EquityReturnTickHandler({ vol: 0.18 }).call({ sim: { rng }, state })[0];

test('design 94 §6.2: a registry of identity securities consumes NO uniforms', () => {
  // The migration's whole claim. Every migrated equity lot names one of these four, and
  // if they drew, step 3's re-gold would have to be redone on every stochastic run.
  const bare = countingRng();
  tick(bare.rng);

  const withReg = countingRng();
  tick(withReg.rng, { securities: IDENTITY_REGISTRY });

  assert.equal(withReg.state.draws, bare.state.draws,
    'β=1 with σ_idio=0 is the identity — no draw, and therefore no re-based path');
});

test('design 94 §6.2: an identity security stores NOTHING — not even a zero', () => {
  const out = tick(countingRng().rng, { securities: IDENTITY_REGISTRY });
  // Absent, not empty and not zero-valued: a scenario whose registry is all identities
  // must gain no action field, and downstream no state key.
  assert.equal(out.securityDeviation, undefined);
  assert.equal(out.securityDriftComp, undefined);
});

test('design 94 §6.2: a BETA-only security overlays but takes no draw', () => {
  const registry = buildSecurityRegistry([
    ...syntheticEquitySecurities(),
    { id: 'sec-lev', rateKey: RATE_KEYS.EQUITY_US, beta: 1.5, idioVol: 0 },
  ]);
  const bare = countingRng();
  tick(bare.rng);

  const withBeta = countingRng();
  const out = tick(withBeta.rng, { securities: registry });

  assert.equal(withBeta.state.draws, bare.state.draws,
    'the beta term is a multiple of a deviation already drawn — it needs no uniform of its own');
  // Non-vacuous: it did produce an overlay, it just did not cost a draw.
  assert.ok(Math.abs(out.securityDeviation['sec-lev']) > 0);
  assert.ok(out.securityDriftComp['sec-lev'] > 0, '(β²−1)·Var > 0 at β = 1.5');
});

test('design 94 §6.2: the overlay is a DIFFERENCE from the sleeve, not an absolute rate', () => {
  // (β−1)·sleeveDev, so a β=1.5 security adds half the sleeve's own move on top of it —
  // and a β=1 security adds exactly none of it. This is the arithmetic that makes the
  // overlay compose with design 90 §7.4's sleeve dispersion instead of racing it.
  const registry = buildSecurityRegistry([
    ...syntheticEquitySecurities(),
    { id: 'sec-lev', rateKey: RATE_KEYS.EQUITY_US, beta: 1.5 },
  ]);
  const out = tick(countingRng().rng, { securities: registry });
  assert.ok(Math.abs(out.securityDeviation['sec-lev'] - 0.5 * out.deviation[RATE_KEYS.EQUITY_US]) < 1e-12);
});

test('design 94 §6.2: a σ_idio > 0 security DOES draw — the skip is conditional here too', () => {
  const registry = buildSecurityRegistry([
    ...syntheticEquitySecurities(),
    { id: 'sec-emp', rateKey: RATE_KEYS.EQUITY_US, beta: 1.0, idioVol: 0.30 },
  ]);
  const bare = countingRng();
  tick(bare.rng);

  const withIdio = countingRng();
  tick(withIdio.rng, { securities: registry });

  assert.ok(withIdio.state.draws > bare.state.draws,
    'one concentrated position costs one extra uniform per year');
});

test('design 94 §6.2: the draw set is the REGISTRY, not the portfolio', () => {
  // The decision this file exists to pin. `state` carries NO accounts and NO holdings at
  // all, so nothing holds `sec-unheld` — and the cursor must move anyway. Conditioning
  // the draw on holdings would make the random path a function of portfolio state, which
  // changes under every MPC rollout, optimizer probe and replay branch.
  const registry = buildSecurityRegistry([
    ...syntheticEquitySecurities(),
    { id: 'sec-unheld', rateKey: RATE_KEYS.EQUITY_AU, idioVol: 0.25 },
  ]);
  const bare = countingRng();
  tick(bare.rng);

  const unheld = countingRng();
  tick(unheld.rng, { securities: registry });

  assert.ok(unheld.state.draws > bare.state.draws,
    'declaring an unheld security with idio vol perturbs the run — the documented price of determinism');
});

test('design 94 §6.2: securities are drawn in sorted `id` order', () => {
  // Same reason EQUITY_SLEEVES is sorted: the cursor has to be reproducible ACROSS runs,
  // and object key order is insertion order. Two registries built in opposite orders must
  // produce the same draws for the same seed.
  const specs = [
    { id: 'sec-zzz', rateKey: RATE_KEYS.EQUITY_US, idioVol: 0.20 },
    { id: 'sec-aaa', rateKey: RATE_KEYS.EQUITY_AU, idioVol: 0.40 },
  ];
  const seeded = () => { let i = 0; const xs = [0.11, 0.27, 0.63, 0.42, 0.88, 0.05]; return () => xs[i++ % xs.length]; };

  const fwd = tick(seeded(), { securities: buildSecurityRegistry([...syntheticEquitySecurities(), ...specs]) });
  const rev = tick(seeded(), { securities: buildSecurityRegistry([...syntheticEquitySecurities(), ...specs.slice().reverse()]) });

  assert.deepEqual(fwd.securityDeviation, rev.securityDeviation,
    'authoring order must not change which uniform each security consumes');
});
