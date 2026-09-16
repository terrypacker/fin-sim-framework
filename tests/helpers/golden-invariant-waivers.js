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
 * Known violations of the design 25 §4.4 invariant, waived per (golden × account).
 *
 * §4.4 is `account.balance === Σ account.holdings[i].marketValue`. The golden harness
 * checks it on every account of every golden's end state (`findOutOfSync`), and this
 * file is the list of places it does NOT hold today — each one a real defect, named,
 * sized, and with the design item that owns it.
 *
 * Waived rather than deleted, for the reason `golden-coverage-manifest.js` waives an
 * uncovered action type rather than dropping it: a violation nobody has written down is
 * indistinguishable from one nobody has noticed. The list is currently EMPTY — the two
 * entries it was born with (design 106 §4b) were both real defects and both were fixed,
 * which is the outcome a waiver list is supposed to drive toward rather than accumulate
 * away from.
 *
 * **Deleting an entry is how it gets fixed.** The companion test asserts this list holds
 * nothing that is already in sync, so a fix that lands without removing its waiver fails
 * just as loudly as a regression.
 *
 * Amounts are the drift measured when the entry was written; they are documentation, not
 * assertions, so a defect that grows or shrinks does not fail here — it fails when it is
 * fixed and nobody removed the line.
 */
export const KNOWN_DESYNCS = {
  // EMPTY, and that is the point of keeping the file: both entries this list was born
  // with were fixed rather than tolerated (design 106 §4b, F7a and F7b), and the gate
  // below is what will notice the next one. An empty list means every account in every
  // golden reconciles to its holdings, to within per-lot cent rounding.
  //
  // Shape for a future entry:
  //   'golden-name': { stateKey: 'what it is worth, and the design item that owns it' },
};

/** True when this (golden × account) pair is a known, written-down violation. */
export function isWaivedDesync(goldenName, stateKey) {
  return Object.prototype.hasOwnProperty.call(KNOWN_DESYNCS[goldenName] ?? {}, stateKey);
}

/** Every waiver as `golden:stateKey`, for the "nothing already in sync" gate. */
export function allWaivedDesyncs() {
  return Object.entries(KNOWN_DESYNCS).flatMap(
    ([golden, accounts]) => Object.keys(accounts).map(stateKey => ({ golden, stateKey })));
}
