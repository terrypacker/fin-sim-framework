/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ScenarioSerializer } from '../../scenarios/scenario-serializer.js';

/**
 * Build the plain-object "leaf entry" for one decision-graph leaf — a full
 * serialized scenario, compatible with ScenarioCompareRunner.run().
 *
 * This is a PURE function of (baseEntry, leaf, leafId): the same three inputs
 * always produce the same entry. That property is what lets
 * DecisionGraphResultStorage drop `entry` from every persisted leaf and rebuild
 * it on demand — a leaf entry is a ~350 KB serialized scenario, so a 50-leaf
 * result persists ~17 MB of near-identical config that is 100% derivable from
 * the base scenario id already stored on the result.
 *
 * @param {object} baseEntry — the base scenario registry entry
 * @param {object} leaf      — { label, params } for this leaf
 * @param {string} leafId    — the leaf's id, e.g. 'dg-leaf:3'
 * @returns {object} a serialized scenario entry with the leaf's param overrides
 */
export function makeLeafEntry(baseEntry, leaf, leafId) {
  const entry = ScenarioSerializer.serializeScenario(baseEntry);
  entry.id    = leafId;
  entry.name  = leaf.label;
  entry.layer = 'analysis-leaf';

  // serializeScenario returns params as a direct reference (not a clone), so
  // we must clone before mutating to avoid corrupting baseEntry.params in place.
  entry.params = (entry.params ?? []).map(p => ({ ...p }));

  const leafParams = leaf.params ?? {};
  for (const p of entry.params) {
    if (p.name in leafParams) p.value = leafParams[p.name];
  }
  const existingNames = new Set(entry.params.map(p => p.name));
  for (const [name, value] of Object.entries(leafParams)) {
    if (!existingNames.has(name)) entry.params.push({ name, value });
  }

  return entry;
}

/**
 * The leaf entry for `leaf`, rebuilt from `baseEntry` if it was stripped.
 *
 * Fresh run results carry `leaf.entry` inline; results reloaded from storage do
 * not (see makeLeafEntry above). Every consumer that needs a leaf entry should
 * go through here rather than reading `leaf.entry` directly, so the two shapes
 * are indistinguishable at the point of use.
 *
 * @param {object}      leaf      — a result leaf, with or without `.entry`
 * @param {object|null} baseEntry — the base scenario entry; required to rebuild
 * @returns {object|null} the leaf entry, or null when it is absent and cannot
 *          be rebuilt (no baseEntry available)
 */
export function resolveLeafEntry(leaf, baseEntry) {
  if (!leaf) return null;
  if (leaf.entry) return leaf.entry;
  if (!baseEntry) return null;
  return makeLeafEntry(baseEntry, leaf, leaf.id);
}
