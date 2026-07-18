/**
 * ScenarioParamGenerator (design 55 §5).
 *
 * Derives per-record schema entries from a cfg's live domain records, so the
 * exposed parameter surface is a *function of the configuration* rather than a
 * hand-maintained static list. One typed param is emitted per (record ×
 * template-field); the entries are concatenated into the combined schema handed
 * to `ScenarioLoader._mergeParamSchema` exactly like toolset param entries.
 *
 * Each generated entry carries a per-record `node`, so all existing cascade
 * machinery works unchanged: `_applyParamNode` fans the value onto the matching
 * cfg.accounts / cfg.persons / cfg.realProperties record by stateKey/id. Value
 * seeding = the record (`defaultValue = record[field]`), so a generated param
 * starts equal to its record and the cascade is a no-op until the user (or
 * MC/Opt) changes it — the round-trip-stable invariant.
 *
 * Key scheme (design 55 §3):
 *   acct.<stateKey>.<field>    person.<id>.<field>    prop.<stateKey>.<field>
 *   coll.<stateKey>.<field>    equity.<stateKey>.<field>
 */
import {
  ACCOUNT_PARAM_TEMPLATES,
  PERSON_PARAM_TEMPLATE,
  REAL_PROPERTY_PARAM_TEMPLATE,
  COLLECTIBLE_PARAM_TEMPLATE,
  COMPANY_EQUITY_PARAM_TEMPLATE,
  BEQUEST_PARAM_TEMPLATE,
  INHERITED_RA_PARAM_TEMPLATE,
  BALANCE_TARGET,
} from './record-param-templates.js';

/** Inherited-asset `__type`s that grow per-account SECURE-drawdown params (design
 *  63 §6.2). Super is excluded — it is a forced lump-sum, not an ongoing account.
 *  Retirement is the only asset class still inline in `bequest.assets`; brokerage /
 *  property / collectible are promoted to real records (design 63 §14) and generate
 *  their params via the standard acct./prop./coll. templates. */
const INHERITED_RA_TYPES = new Set(['TraditionalIRAAccount', 'FourOhOneKAccount', 'RothAccount']);

/** Namespaces the generator owns. A param key with one of these prefixes is
 *  generated (§6 harvest exception is scoped by this). */
export const GENERATED_KEY_PREFIXES = ['acct.', 'person.', 'prop.', 'coll.', 'equity.', 'bequest.', 'raAsset.'];

// Template lookup keys off `account.type` (ACCOUNT_TYPE). Records that never went
// through the account service — raw buildDefaultConfig output, legacy saves — carry
// the serialization class name (`__type`) and/or a semantic `role` but no `type`.
// Fall back to those so params still generate (design 55 §4 "role→type map").
const CLASS_TO_ACCOUNT_TYPE = {
  CheckingAccount: 'checking', SavingsAccount: 'savings', BrokerageAccount: 'brokerage',
  FourOhOneKAccount: '401k', RothAccount: 'roth', TraditionalIRAAccount: 'ira',
  SuperannuationAccount: 'super', LoanAccount: 'loan', OffsetAccount: 'offset',
};
const ROLE_TO_ACCOUNT_TYPE = {
  'us-savings': 'savings', 'au-savings': 'savings',
  'us-stock': 'brokerage', 'au-stock': 'brokerage',
  'fixed-income': 'brokerage', 'au-fixed-income': 'brokerage',
  'ira': 'ira', 'k401': '401k', 'roth-ira': 'roth', 'super': 'super',
};
function resolveAccountType(a) {
  return a.type ?? CLASS_TO_ACCOUNT_TYPE[a.__type] ?? ROLE_TO_ACCOUNT_TYPE[a.role] ?? null;
}

/** True when `key` is a generated per-record param key (by namespace). */
export function isGeneratedParamKey(key) {
  return typeof key === 'string' && GENERATED_KEY_PREFIXES.some(p => key.startsWith(p));
}

const PREFIX_TO_NODE_TYPE = {
  acct: 'account', person: 'person', prop: 'realProperty',
  coll: 'collectible', equity: 'companyEquity',
  bequest: 'bequest', raAsset: 'bequestAsset',
};

/**
 * Decode a generated key back into its cascade `node` (design 55 §3 "Decodable").
 * `acct.<stateKey>.<field>` → { type:'account', stateKey, field }; person keys use
 * `id`. stateKeys/ids are camelCase (no dots), so the field is the last segment and
 * the owner is everything between the prefix and it. Returns null for non-generated
 * or malformed keys.
 */
export function decodeGeneratedParamKey(key) {
  if (!isGeneratedParamKey(key)) return null;
  const firstDot = key.indexOf('.');
  const lastDot  = key.lastIndexOf('.');
  if (lastDot <= firstDot) return null;
  const type  = PREFIX_TO_NODE_TYPE[key.slice(0, firstDot)];
  const owner = key.slice(firstDot + 1, lastDot);
  const field = key.slice(lastDot + 1);
  if (!type || !owner || !field) return null;
  return type === 'person'
    ? { type, id: owner, field }
    : { type, stateKey: owner, field };
}

export class ScenarioParamGenerator {
  /**
   * Derive per-record schema entries from a cfg's domain records.
   * @param {object} cfg - the scenario config (accounts/persons/realProperties/…)
   * @returns {Array<object>} schema entries ({ key, label, type, group, defaultValue, node, … })
   */
  static generate(cfg) {
    const out = [];
    const seen = new Set();
    const add = (entries) => {
      for (const e of entries) {
        if (seen.has(e.key)) {
          // Two records sharing an identity (stateKey/id) collide on key — a latent
          // uniqueness bug (design 55 §13). Warn and skip rather than silently
          // overwrite the first record's param.
          console.warn(
            `[ScenarioParamGenerator] Duplicate param key "${e.key}" — two records ` +
            `share the same stateKey/id. Skipping the duplicate; stateKeys must be unique.`);
          continue;
        }
        seen.add(e.key);
        out.push(e);
      }
    };
    for (const a of cfg.accounts ?? [])
      add(this._expand('acct', 'account', a, a.stateKey, ACCOUNT_PARAM_TEMPLATES[resolveAccountType(a)] ?? []));
    for (const p of cfg.persons ?? [])
      add(this._expand('person', 'person', p, p.id, PERSON_PARAM_TEMPLATE));
    for (const r of cfg.realProperties ?? [])
      add(this._expand('prop', 'realProperty', r, r.stateKey, REAL_PROPERTY_PARAM_TEMPLATE));
    for (const c of cfg.collectibles ?? [])
      add(this._expand('coll', 'collectible', c, c.stateKey, COLLECTIBLE_PARAM_TEMPLATE));
    for (const e of cfg.companyEquities ?? [])
      add(this._expand('equity', 'companyEquity', e, e.stateKey, COMPANY_EQUITY_PARAM_TEMPLATE));
    // Design 63: per-Bequest activation year + per-inherited-RA-asset drawdown knobs.
    // Only retirement assets remain inline in `bequest.assets` (design 63 §14);
    // promoted brokerage/property/collectible generate acct./prop./coll. params via
    // the loops above, keyed by their real record.
    for (const b of cfg.bequests ?? []) {
      add(this._expand('bequest', 'bequest', b, b.stateKey, BEQUEST_PARAM_TEMPLATE));
      for (const a of (b.assets ?? [])) {
        if (INHERITED_RA_TYPES.has(a.__type))
          add(this._expand('raAsset', 'bequestAsset', a, a.stateKey, INHERITED_RA_PARAM_TEMPLATE));
      }
    }
    return out;
  }

  /**
   * Build the schema entries for one record from its template.
   * @private
   */
  static _expand(prefix, nodeType, record, identity, template) {
    if (!template || template.length === 0) return [];
    if (identity == null) {
      // No stateKey/id → the param can't be keyed and the cascade can't find the
      // record. Phase-1 prebuilt records always carry one; editor/Config-List
      // records without one are covered by the design 55 §3.1 stateKey-assignment
      // prerequisite (a later phase). Warn so the gap is visible, then skip.
      console.warn(
        `[ScenarioParamGenerator] ${nodeType} record "${record?.name ?? '?'}" has no ` +
        `${prefix === 'person' ? 'id' : 'stateKey'}; skipping ${template.length} generated param(s).`);
      return [];
    }
    const recordName = record.name || identity;
    const group = record.country ? `${record.country} · ${recordName}` : recordName;
    // A holdings-bearing account's balance is DERIVED from Σ holdings.marketValue (the
    // account editor disables the balance field and refuses to param-link it), and
    // holdings/basis are explicitly out of the param surface (design 55 §13). So a plain
    // scalar `balance` param would let a stale value rescale the holdings on Rebuild.
    // When the account has holdings we therefore SWAP the `balance` template field for a
    // hidden, compile-only `balanceTarget` MC/Opt lever (BALANCE_TARGET) that the loader
    // cascade honors non-destructively; a holdings-free account keeps its scalar `balance`.
    const hasHoldings = Array.isArray(record.holdings) && record.holdings.length > 0;
    return template.map((t) => (t.field === 'balance' && hasHoldings) ? BALANCE_TARGET : t).map((t) => {
      const node = nodeType === 'person'
        ? { type: 'person', id: identity, field: t.field }
        : { type: nodeType, stateKey: identity, field: t.field };
      const entry = {
        key:          `${prefix}.${identity}.${t.field}`,
        label:        `${recordName} — ${t.label}`,
        type:         t.money ? 'Money' : t.type,
        group,
        defaultValue: record[t.deriveDefaultFrom ?? t.field],
        node,
        mc:           t.mc  ?? false,
        opt:          t.opt ?? false,
      };
      if (t.hidden)  entry.hidden  = t.hidden;
      if (t.options) entry.options = t.options;
      // Field-level description (design 55 §4) → the param's hover tooltip in the
      // Scenario panel. Without it the tooltip falls back to the generated key
      // (`acct.<stateKey>.<field>`), which surfaced the raw stateKey on hover.
      if (t.description) entry.description = t.description;
      // design-10 Money seeding (§4). Deferred in Phase 1 (all templates Number),
      // but supported so a later phase flips `money: true` on a template field.
      if (t.money) {
        entry.defaultCurrency   = record.currency?.code ?? record.currency ?? 'USD';
        entry.currencyStateKeys = [`${identity}.${t.field}`];
      }
      return entry;
    });
  }
}
