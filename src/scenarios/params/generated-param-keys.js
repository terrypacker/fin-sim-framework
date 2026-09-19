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
 * The generated per-record param namespaces (design 55), with no dependencies.
 *
 * Split out of `scenario-param-generator.js` (which re-exports both names) so that
 * `mc-param-paths` — a pure path util the chart and state panel load as well as the
 * MC/Opt/MPC engines — can recognise a generated key without pulling in the record
 * templates and the account model behind them (design 98 W0).
 */

/** Namespaces the generator owns. A param key with one of these prefixes is
 *  generated (§6 harvest exception is scoped by this). */
export const GENERATED_KEY_PREFIXES = ['acct.', 'person.', 'prop.', 'coll.', 'equity.', 'bequest.',
  'raAsset.',
  // Design 110 §6.2 — `pool.<poolId>.targetScale`, the liquidity-pool size axis. The only
  // namespace here whose owner is NOT a cfg record: a pool is authored inside the
  // `liquidityGraph` param, so this key has no cascade `node` and is applied where the graph
  // is resolved (`pool-target-scale.js`). It is in this list for the reason every other
  // prefix is — `set()` in `mc-param-paths` writes a dotted key FLAT only for a generated
  // namespace, and a lever outside the list is inert in a real solve while passing every
  // hand-written flat-bag test (design 98 W0 / `optimizer-param-key-dot-collision`).
  'pool.',
  // Design 110 §6.3 — `gate.<clauseId>.threshold` / `.dwell`, the addressable gate clause. Same
  // shape as `pool.` above and here for the same reason: no cascade node, applied at the graph
  // resolver, and dead on arrival in a real solve if `set()` cannot write it flat.
  'gate.',
  // Design 110 §6.4 / design 109 Q1 — `shape.<shapeId>.yearShift`, the switch-year axis. Q1
  // named this trap itself: `liquidityGraphSchedule[i].year` is a nested path, a dotted key is
  // dropped by `set()`, and the answer is a flat scalar companion in a generated namespace.
  'shape.'];

/** True when `key` is a generated per-record param key (by namespace). */
export function isGeneratedParamKey(key) {
  return typeof key === 'string' && GENERATED_KEY_PREFIXES.some(p => key.startsWith(p));
}
