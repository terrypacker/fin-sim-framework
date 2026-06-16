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
 * ParamFieldLinks — the inverse of the scenario panel's `nodeLookup` (param →
 * live node). Given the active scenario's params, indexes those that carry a
 * `node` declaration so an editor can ask, for any domain-object field, "is this
 * field backed by a scenario param?" (design/32).
 *
 * A node-linked param (e.g. `{ key:'usStockBalance',
 * node:{ type:'account', stateKey:'usStockAccount', field:'balance' } }`) owns
 * its target field: the editor reads/writes the param's value rather than the
 * domain object, so the two never diverge and the param→node cascade no longer
 * silently overwrites a form edit on Rebuild.
 *
 * Pure and DOM-free — built once per editor open from `scenario.params`.
 */
export class ParamFieldLinks {
  /** @param {Array<object>} params  the active scenario's params (with optional `.node`) */
  constructor(params = []) {
    /** @type {Map<string, object>} `${type}:${id|stateKey}:${field}` → param */
    this._byField = new Map();
    for (const p of (Array.isArray(params) ? params : [])) {
      const n = p?.node;
      if (!n?.type || !n?.field) continue;
      const owner = n.id ?? n.stateKey;
      if (owner == null) continue;
      this._byField.set(_key(n.type, owner, n.field), p);
    }
  }

  /**
   * The param backing a domain-object field, or null when the field is free.
   *
   * @param {string} type          'account' | 'person' | 'realProperty' | ...
   * @param {string} idOrStateKey  person id, or account/asset stateKey
   * @param {string} field         domain field name (e.g. 'balance', 'monthlyWage')
   * @returns {object|null}
   */
  getParamFor(type, idOrStateKey, field) {
    if (idOrStateKey == null) return null;
    return this._byField.get(_key(type, idOrStateKey, field)) ?? null;
  }

  /** True when at least one param links to a field (cheap guard for editors). */
  get hasLinks() { return this._byField.size > 0; }
}

function _key(type, owner, field) {
  return `${type}:${owner}:${field}`;
}
