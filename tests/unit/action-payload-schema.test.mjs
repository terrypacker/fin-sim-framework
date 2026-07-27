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
 * action-payload-schema.test.mjs — drift detector for the TypeRegistry.
 *
 * A toolset's `types.actions` `fields:` block gates ONLY the journal payload
 * (`TypeRegistry.pickPayload`). Reducers receive the whole dispatched action, so
 * an undeclared field costs no arithmetic — it is invisible in the journal and in
 * the design 71 reports while the number it carries is perfectly correct. That is
 * precisely the kind of gap nobody trips over until a report is silently blank.
 *
 * Two passes, because neither alone is sufficient:
 *
 *   1. DYNAMIC — run IntlRetirementScenario and intercept every pickPayload()
 *      call. Sees actions however they were built (spreads, conditional keys,
 *      post-hoc assignment), but only for code paths the run reaches.
 *
 *   2. STATIC — parse every object literal under `src/` whose `type:` names a
 *      registered action type and compare its keys to that type's manifest.
 *      Blind to spread-built payloads, but run-independent.
 *
 * Pass 2 exists because pass 1 was passing vacuously over whole families. The
 * 2-year window sells nothing, so no disposal action ever reached the detector
 * and the entire CAPITAL_GAINS family went unchecked — five of its six types had
 * undeclared fields (`auDiscountableGain` on the AU brokerage disposal, the whole
 * design 83 G7 main-residence working on `AU_HOUSE_SALE_TAX`). Lengthening the
 * run would have bought coverage by luck; the static pass buys it by construction.
 *
 * Run with: node --test tests/unit/action-payload-schema.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';
import fs       from 'node:fs';
import path     from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

import { TypeRegistry }           from '../../src/simulation-framework/type-registry.js';
import { ServiceRegistry }        from '../../src/services/service-registry.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioLoader }         from '../../src/scenarios/scenario-loader.js';
import { ScenarioSerializer }     from '../../src/scenarios/scenario-serializer.js';

// ─── DriftDetectorRegistry ────────────────────────────────────────────────────

// Must mirror FRAMEWORK_FIELDS in type-registry.js.
const FRAMEWORK_FIELDS = new Set(['id', 'type', 'name', 'kind', 'layer', 'siblingIndex', 'data', 'meta']);

/**
 * TypeRegistry subclass that intercepts pickPayload() to detect two drift classes:
 *
 *   1. Registered types with live fields not declared in `entry.fields`.
 *      These fields are silently dropped from journal payloads.
 *
 *   2. Unregistered action types encountered during the run.
 *      These fall through to the heuristic fallback — fine today, but
 *      each one is a missing toolset declaration.
 */
class DriftDetectorRegistry extends TypeRegistry {
  constructor() {
    super();
    this._undeclaredFields  = new Map(); // actionType → Set<fieldName>
    this._unregisteredTypes = new Set(); // actionType strings with no registry entry
  }

  pickPayload(action) {
    const entry = this._actionTypes.get(action.type);
    if (entry) {
      const declared = new Set(Object.keys(entry.fields ?? {}));
      for (const k of Object.keys(action)) {
        if (FRAMEWORK_FIELDS.has(k)) continue;
        if (k.startsWith('_'))       continue;
        if (action[k] == null)       continue;
        if (!declared.has(k)) {
          if (!this._undeclaredFields.has(action.type)) {
            this._undeclaredFields.set(action.type, new Set());
          }
          this._undeclaredFields.get(action.type).add(k);
        }
      }
    }
    return super.pickPayload(action);
  }

  // Override fallback to track unregistered types without console warnings.
  _fallbackPayload(action) {
    this._unregisteredTypes.add(action.type);
    const out = {};
    for (const k of Object.keys(action)) {
      if (FRAMEWORK_FIELDS.has(k)) continue;
      if (k.startsWith('_'))       continue;
      if (action[k] != null)       out[k] = action[k];
    }
    return out;
  }

  /** { actionType: [fieldName, ...] } for all registered types with undeclared fields. */
  get fieldMismatches() {
    const out = {};
    for (const [type, fields] of this._undeclaredFields) {
      out[type] = [...fields].sort();
    }
    return out;
  }

  /** Sorted array of action type strings encountered but not registered. */
  get unregisteredTypes() {
    return [...this._unregisteredTypes].sort();
  }
}

// ─── Scenario setup ──────────────────────────────────────────────────────────

const SIM_START = new Date(Date.UTC(2026, 0, 1));
// 2 years covers all periodic action types: monthly wages/expenses/interest,
// quarterly dividends, annual period-advance/tax-settle, and RMD triggers.
const SIM_END   = new Date(Date.UTC(2028, 1, 1));

/**
 * Build and run the full IntlRetirementScenario with a DriftDetectorRegistry
 * wired in place of the normal TypeRegistry.  Journal entries are discarded
 * (we only need the detector's pickPayload interceptions).
 *
 * Returns the detector after the run completes.
 */
let _detector = null;
function getDetector() {
  if (_detector) return _detector;

  const registry = new ServiceRegistry();

  // Replace before loading so ScenarioCompiler registers toolsets on the detector.
  const detector = new DriftDetectorRegistry();
  registry.typeRegistry                  = detector;
  registry.simulationContext.typeRegistry = detector;

  // Build the Simulation object (registers it as 'primary' in simulationRegistry).
  const scenario = new IntlRetirementScenario({
    context:  registry.simulationContext,
    params:   {},
    simStart: SIM_START,
    simEnd:   SIM_END,
  });
  scenario.buildSim();

  // Compile: registers all toolset declarations on the detector then wires
  // handlers / reducers / schedules into the simulation.
  const rawCfg = IntlRetirementScenario.buildDefaultConfig({}, SIM_START, SIM_END);
  const cfg    = ScenarioSerializer.serializeScenario(rawCfg);
  new ScenarioLoader().load(cfg, registry);

  const sim = registry.simulationRegistry.get('primary');

  // Enable journal so _pickPayload is called for every reducer execution;
  // discard the entries themselves — we only care about the detector's findings.
  sim.journal.enabled  = true;
  sim.journal.addEntry = () => {};

  sim.stepTo(SIM_END);

  _detector = detector;
  return detector;
}

// ─── Static emitter scan ─────────────────────────────────────────────────────

const ROOT        = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC_DIR     = path.join(ROOT, 'src');
const TOOLSET_DIR = path.join(SRC_DIR, 'scenarios/toolsets');

/**
 * type → Set(declared field names), read from every `*-toolset.js` in the toolset
 * directory rather than a hard-coded list, so a new toolset file is covered the
 * moment it lands. Types declared by two toolsets (the idempotent shared actions,
 * e.g. LOAN_PAYMENT_APPLY) union their field sets. That union is safe only while
 * the duplicate declarations agree — registerActionType is last-writer-wins, so a
 * field declared in one toolset and omitted in the other survives or vanishes
 * depending on registration order. The agreement test below enforces that.
 */
async function declaredFieldsByType() {
  const out    = new Map();  // type → Set(field)
  const byFile = new Map();  // type → Map(toolset file → Set(field))
  for (const file of fs.readdirSync(TOOLSET_DIR)) {
    if (!file.endsWith('-toolset.js')) continue;
    const mod = await import(path.join(TOOLSET_DIR, file));
    for (const exported of Object.values(mod)) {
      for (const entry of exported?.types?.actions ?? []) {
        if (!out.has(entry.type))    out.set(entry.type, new Set());
        if (!byFile.has(entry.type)) byFile.set(entry.type, new Map());
        byFile.get(entry.type).set(file, new Set(Object.keys(entry.fields ?? {})));
        for (const field of Object.keys(entry.fields ?? {})) out.get(entry.type).add(field);
      }
    }
  }
  return { byType: out, byFile };
}

function jsFilesUnder(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory())          jsFilesUnder(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** Depth-first walk over a Babel AST, invoking cb on every node. */
function walkAst(node, cb) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) walkAst(n, cb); return; }
  if (typeof node.type === 'string') cb(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
    const v = node[key];
    if (v && typeof v === 'object') walkAst(v, cb);
  }
}

/**
 * Scan `src/` for action-shaped object literals and report keys the owning
 * toolset never declared.
 *
 * An object literal counts as an emission when its `type` is a string literal
 * naming a REGISTERED action type — that test alone rules out the false positives
 * (`{ type: 'CASH', … }` and friends never match). Manifest entries are excluded
 * by their own `fields:` key, which no emitted action carries.
 *
 * @returns {Map<string, Map<string, string[]>>} type → field → ['file:line', …]
 */
function scanEmitters(declared) {
  const found = new Map();
  for (const file of jsFilesUnder(SRC_DIR)) {
    const ast = parse(fs.readFileSync(file, 'utf8'), { sourceType: 'module', plugins: ['classProperties'] });
    walkAst(ast.program, (node) => {
      if (node.type !== 'ObjectExpression') return;
      const props = node.properties.filter(p => p.type === 'ObjectProperty' && !p.computed);
      const keyOf = (p) => p.key?.name ?? p.key?.value;
      const typeProp = props.find(p => keyOf(p) === 'type' && p.value?.type === 'StringLiteral');
      if (!typeProp) return;
      const type = typeProp.value.value;
      if (!declared.has(type)) return;
      if (props.some(p => keyOf(p) === 'fields')) return;  // a manifest entry, not an emission

      for (const p of props) {
        const field = keyOf(p);
        if (field == null || FRAMEWORK_FIELDS.has(field) || String(field).startsWith('_')) continue;
        if (declared.get(type).has(field)) continue;
        if (!found.has(type)) found.set(type, new Map());
        if (!found.get(type).has(field)) found.get(type).set(field, []);
        found.get(type).get(field).push(`${path.relative(ROOT, file)}:${p.loc.start.line}`);
      }
    });
  }
  return found;
}

/**
 * The drift that existed when the static pass was written, pinned exactly so the
 * set can only shrink. Not a list of 31 bugs: many are routing keys (`cashKey`,
 * `iraKey`, `dstKey`) that a reducer consumes and no report wants, and leaving
 * those undeclared is a legitimate choice — pickPayload drops them either way.
 * The point of pinning is that the NEXT undeclared field is a deliberate decision
 * rather than an accident nobody sees.
 *
 * To burn one down: declare the field in the owning toolset and delete the entry
 * here (an entry that no longer drifts fails this test too, so the list cannot go
 * stale). CAPITAL_GAINS is deliberately absent — see the family test below.
 */
const KNOWN_GAPS = {
  AU_FIXED_INCOME_EARNINGS_APPLY:          ['stateKey'],
  AU_HOUSE_SALE_APPLY:                     ['destinationKey', 'mortgageBalance', 'ownerId', 'owners', 'ownershipType', 'residency'],
  AU_RENTAL_INCOME_APPLY:                  ['cashKey'],
  AU_RENTAL_INCOME_TAX:                    ['ownerId', 'owners', 'ownershipType'],
  AU_WAGES_INCOME_TAX:                     ['workCountry'],
  COLLECTIBLE_SALE_APPLY:                  ['destinationKey', 'residency', 'stateKey'],
  COLLECTIBLE_VALUE_CHANGE_APPLY:          ['change', 'stateKey'],
  EXPENSE_EVENT_APPLY:                     ['personId'],
  FX_TRANSFER_APPLY:                       ['dstKey', 'srcKey'],
  INHERIT_APPLY:                           ['inheritanceDateMs'],
  INTL_TRANSFER_APPLY:                     ['direction', 'dstKey'],
  IRA_RMD_APPLY:                           ['residency', 'stateKey'],
  IRA_ROLLOVER_WITHDRAWAL_APPLY:           ['residency'],
  IRA_WITHDRAWAL_CONTRIB_APPLY:            ['penaltyAmount'],
  IRA_WITHDRAWAL_EARNINGS_APPLY:           ['penaltyAmount', 'residency'],
  K401_RMD_APPLY:                          ['residency', 'stateKey'],
  K401_TO_IRA_CONVERSION_APPLY:            ['iraKey', 'k401Key'],
  K401_WITHDRAWAL_APPLY:                   ['penaltyAmount'],
  LOAN_PAYMENT_APPLY:                      ['cashDue', 'cashKey', 'fx'],
  PROPERTY_PURCHASE_APPLY:                 ['cashKey', 'fx', 'purchaseMs'],
  ROTH_CONVERSION_APPLY:                   ['iraKey', 'residency', 'rothKey'],
  ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_APPLY: ['residency'],
  ROTH_WITHDRAWAL_EARNINGS_APPLY:          ['penaltyAmount', 'residency'],
  SCHEDULED_EARLY_WITHDRAWAL_APPLY:        ['destinationKey', 'iraKey', 'k401Key', 'rothKey'],
  SECTION_988_GAIN:                        ['holdingId'],
  STOCK_DIVIDEND_APPLY:                    ['residency'],
  SUPER_WITHDRAWAL_CONTRIB_APPLY:          ['blocked'],
  SUPER_WITHDRAWAL_EARNINGS_APPLY:         ['blocked'],
  US_HOUSE_SALE_APPLY:                     ['destinationKey', 'mortgageBalance', 'residency'],
  US_RENTAL_INCOME_APPLY:                  ['cashKey'],
  // The AUD restatement of US tax paid on US-source income — the design 83 FTC
  // input. Undeclared, an FTC reconciliation cannot be drilled from the journal.
  US_TAX_SETTLE_APPLY:                     ['usTaxPaidOnUsSourceAud'],
};

let _staticScan = null;
async function getStaticScan() {
  if (!_staticScan) {
    const { byType, byFile } = await declaredFieldsByType();
    _staticScan = { declared: byType, declaredByFile: byFile, found: scanEmitters(byType) };
  }
  return _staticScan;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test('no undeclared fields on registered action types (2-year IntlRetirementScenario)', () => {
  const detector   = getDetector();
  const mismatches = detector.fieldMismatches;
  const types      = Object.keys(mismatches);

  if (types.length === 0) return;

  const lines = types.map(t =>
    `  ${t}: undeclared fields [${mismatches[t].join(', ')}]`
  ).join('\n');
  assert.fail(
    `${types.length} action type(s) have live fields not declared in their toolset manifest:\n` +
    `${lines}\n\n` +
    `Fix: add each missing field to the types.actions entry in the owning toolset's types block.`
  );
});

test('all emitted action types are registered in a toolset manifest (2-year IntlRetirementScenario)', () => {
  const detector    = getDetector();
  const unregistered = detector.unregisteredTypes;

  if (unregistered.length === 0) return;

  assert.fail(
    `${unregistered.length} action type(s) were emitted but not registered in any toolset manifest:\n` +
    unregistered.map(t => `  ${t}`).join('\n') + '\n\n' +
    `Fix: add each type to the types.actions block of the owning toolset.`
  );
});

test('static scan: manifest drift matches the pinned baseline exactly', async () => {
  const { found } = await getStaticScan();

  const actual = {};
  for (const [type, fields] of found) actual[type] = [...fields.keys()].sort();

  const types = new Set([...Object.keys(actual), ...Object.keys(KNOWN_GAPS)]);
  const newDrift = [], staleBaseline = [];
  for (const type of [...types].sort()) {
    const now  = new Set(actual[type]     ?? []);
    const then = new Set(KNOWN_GAPS[type] ?? []);
    for (const f of now)  if (!then.has(f)) newDrift.push(`  ${type}.${f}  ← ${found.get(type).get(f).join(', ')}`);
    for (const f of then) if (!now.has(f))  staleBaseline.push(`  ${type}.${f}`);
  }

  const problems = [];
  if (newDrift.length) {
    problems.push(
      `${newDrift.length} action field(s) are emitted but not declared in the owning toolset:\n` +
      newDrift.join('\n') + '\n\n' +
      `A field missing from types.actions is dropped from the journal payload, so it is\n` +
      `invisible to every design 71 report even though reducers still receive it.\n` +
      `Fix: declare the field (preferred), or add it to KNOWN_GAPS with a reason if it is\n` +
      `reducer plumbing no report should carry.`
    );
  }
  if (staleBaseline.length) {
    problems.push(
      `${staleBaseline.length} KNOWN_GAPS entr(ies) no longer drift — delete them so the\n` +
      `baseline keeps ratcheting down:\n` + staleBaseline.join('\n')
    );
  }
  if (problems.length) assert.fail(problems.join('\n\n'));
});

test('static scan: shared action types declare identical fields in every toolset', async () => {
  const { declaredByFile } = await getStaticScan();

  // registerActionType is idempotent by design (LOAN_PAYMENT_APPLY, PROPERTY_PURCHASE_APPLY
  // and SECTION_988_GAIN are each declared by both real-property toolsets), but it is
  // last-writer-wins over the whole entry. Two declarations that disagree therefore make
  // a field's visibility depend on toolset registration order — a bug that would surface
  // as "the report works in one scenario and not another".
  const conflicts = [];
  for (const [type, byFile] of declaredByFile) {
    if (byFile.size < 2) continue;
    const [[firstFile, firstFields], ...rest] = [...byFile];
    for (const [file, fields] of rest) {
      const missing = [...firstFields].filter(f => !fields.has(f));
      const extra   = [...fields].filter(f => !firstFields.has(f));
      if (missing.length || extra.length) {
        conflicts.push(`  ${type}: ${file} vs ${firstFile} — ` +
          `${extra.length ? `only in ${file}: [${extra.join(', ')}] ` : ''}` +
          `${missing.length ? `only in ${firstFile}: [${missing.join(', ')}]` : ''}`);
      }
    }
  }

  assert.equal(conflicts.length, 0,
    `Action types declared by more than one toolset must declare the same fields:\n${conflicts.join('\n')}`);
});

test('static scan: the CAPITAL_GAINS family declares every field it emits', async () => {
  const { declared, found } = await getStaticScan();

  // Every disposal in the model lands here, and this family is exactly where the
  // dynamic pass is weakest: a 2-year run sells nothing. Zero tolerance, no
  // baseline — a disposal field that cannot be reported is a defect by definition.
  const familyTypes = ['STOCK_WITHDRAWAL_TAX', 'AU_STOCK_WITHDRAWAL_TAX', 'COLLECTIBLE_SALE_TAX',
                       'US_HOUSE_SALE_TAX', 'AU_HOUSE_SALE_TAX', 'COMPANY_SALE_TAX'];

  for (const type of familyTypes) {
    assert.ok(declared.has(type), `${type} must be declared in a toolset manifest`);
  }
  const offenders = familyTypes
    .filter(t => found.has(t))
    .map(t => `  ${t}: [${[...found.get(t).keys()].sort().join(', ')}]`);

  assert.equal(offenders.length, 0,
    `CAPITAL_GAINS types emitting undeclared fields:\n${offenders.join('\n')}`);
});
