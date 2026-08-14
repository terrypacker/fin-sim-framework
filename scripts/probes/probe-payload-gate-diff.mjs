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
 * probe-payload-gate-diff.mjs — what wiring the manifest gate would change.
 *
 * Design 91 §2: Simulation._pickPayload resolves its TypeRegistry through the sim's
 * own bus, which BaseScenario never stamps, so journal payloads come from the
 * heuristic (every non-null field survives) rather than the toolset manifest.
 * Wiring the gate makes the manifest authoritative — which DROPS every emitted field
 * no toolset declares.
 *
 * This probe measures that drop before it happens. It runs the full reference
 * scenario with the journal on and, for every entry, compares the heuristic payload
 * against the manifest payload, reporting per action type:
 *
 *   DROPPED  — emitted, undeclared: present today, gone after the flip.
 *   PHANTOM  — declared, never emitted: named in the manifest, never filled.
 *
 * DROPPED is the risk list. Cross-check it against KNOWN_GAPS: anything there is a
 * decision already taken (routing keys), anything NOT there is drift the detector
 * missed and a reason to stop.
 *
 * Usage: node scripts/probes/probe-payload-gate-diff.mjs [years]
 */

import { ServiceRegistry }        from '../../src/services/service-registry.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioLoader }         from '../../src/scenarios/scenario-loader.js';
import { ScenarioSerializer }     from '../../src/scenarios/scenario-serializer.js';

const YEARS     = Number(process.argv[2] ?? 44);
const SIM_START = new Date(Date.UTC(2026, 0, 1));
const SIM_END   = new Date(Date.UTC(2026 + YEARS, 0, 1));

// Mirrors Simulation._FRAMEWORK_FIELDS ∪ TypeRegistry.FRAMEWORK_FIELDS, plus the two
// instance fields every SimGraphNode-derived action class carries.
const FRAMEWORK_FIELDS = new Set(['id', 'type', 'name', 'kind', 'layer', 'siblingIndex', 'data', 'meta',
                                  'definitionId', 'timestamp']);

const registry = new ServiceRegistry();
const scenario = new IntlRetirementScenario({
  context: registry.simulationContext, params: {}, simStart: SIM_START, simEnd: SIM_END,
});
scenario.buildSim();
const rawCfg = IntlRetirementScenario.buildDefaultConfig({}, SIM_START, SIM_END);
new ScenarioLoader().load(ScenarioSerializer.serializeScenario(rawCfg), registry);

const sim   = registry.simulationRegistry.get('primary');
const types = registry.typeRegistry;

// Intercept every action as it is journaled, without keeping the entries.
const dropped      = new Map();  // actionType → Map(field → count)   (registered types)
const unregistered = new Map();  // actionType → count                (no manifest entry at all)
const seen         = new Map();  // actionType → count
const declaredSeen = new Map();  // actionType → Set(field) actually emitted

sim.journal.enabled  = true;
sim.journal.addEntry = (entry) => {
  const action = entry?._action;
  if (!action) return;
};

// The journal only receives the PICKED payload, so hook the picker instead.
const origPick = sim._pickPayload.bind(sim);
sim._pickPayload = (action) => {
  seen.set(action.type, (seen.get(action.type) ?? 0) + 1);
  const entry = types._actionTypes.get(action.type);
  if (!entry) {
    // Unregistered: the gate does not drop these fields, it takes a different branch
    // entirely — _fallbackPayload, which keeps everything in permissive mode and
    // THROWS in strict mode. Counted apart from the drop list for that reason.
    unregistered.set(action.type, (unregistered.get(action.type) ?? 0) + 1);
    return origPick(action);
  }
  const declared = new Set(Object.keys(entry.fields ?? {}));
  for (const k of Object.keys(action)) {
    if (FRAMEWORK_FIELDS.has(k) || k.startsWith('_')) continue;
    if (action[k] == null) continue;
    if (!declaredSeen.has(action.type)) declaredSeen.set(action.type, new Set());
    declaredSeen.get(action.type).add(k);
    if (declared.has(k)) continue;
    if (!dropped.has(action.type)) dropped.set(action.type, new Map());
    const m = dropped.get(action.type);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return origPick(action);
};

sim.stepTo(SIM_END);

// ─── Report ───────────────────────────────────────────────────────────────────

const totalActions = [...seen.values()].reduce((a, b) => a + b, 0);
console.log(`\nReference scenario, ${YEARS}y — ${totalActions.toLocaleString()} journaled actions `
          + `across ${seen.size} action types.\n`);

console.log('═══ UNREGISTERED action types (no manifest entry in any toolset) ═══');
if (unregistered.size === 0) {
  console.log('  (none)');
} else {
  for (const [type, n] of [...unregistered].sort()) console.log(`  ${type} ×${n}`);
  console.log('\n  These do NOT lose fields to the gate — they take _fallbackPayload, which keeps\n'
            + '  everything permissively and THROWS under setStrict(true). Declare them before\n'
            + '  wiring the gate, or a strict run dies the first time one fires.');
}

console.log('\n═══ DROPPED by the gate (registered, emitted, undeclared) ═══');
if (dropped.size === 0) {
  console.log('  (none — the manifest already covers every emitted field)');
} else {
  for (const [type, fields] of [...dropped].sort()) {
    const parts = [...fields].sort().map(([f, n]) => `${f}×${n}`);
    console.log(`  ${type}: ${parts.join(', ')}`);
  }
}

console.log('\n═══ PHANTOM (declared, never emitted in this run) ═══');
const phantoms = [];
for (const [type, n] of [...seen].sort()) {
  const entry = types._actionTypes.get(type);
  if (!entry?.fields) continue;
  const emitted = declaredSeen.get(type) ?? new Set();
  const missing = Object.keys(entry.fields).filter(f => !emitted.has(f));
  if (missing.length) phantoms.push(`  ${type} (${n}×): [${missing.sort().join(', ')}]`);
}
console.log(phantoms.length ? phantoms.join('\n') : '  (none)');
