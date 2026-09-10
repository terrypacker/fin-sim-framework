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
export const GENERATED_KEY_PREFIXES = ['acct.', 'person.', 'prop.', 'coll.', 'equity.', 'bequest.', 'raAsset.'];

/** True when `key` is a generated per-record param key (by namespace). */
export function isGeneratedParamKey(key) {
  return typeof key === 'string' && GENERATED_KEY_PREFIXES.some(p => key.startsWith(p));
}
