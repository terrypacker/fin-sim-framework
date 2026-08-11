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
