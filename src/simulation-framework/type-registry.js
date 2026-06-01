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
 * Descriptor for a typed field on an action-type entry.
 * Toolsets use these to declare the payload fields they own.
 */
export class ValueType {
  constructor(kind, opts = {}) {
    this.kind = kind;
    this.opts = opts;
  }

  static currency(code) { return new ValueType('currency', { code }); }
  static text()          { return new ValueType('text'); }
  static number()        { return new ValueType('number'); }
  static boolean()       { return new ValueType('boolean'); }
  static any()           { return new ValueType('any'); }
}

// Fields that are always excluded by the fallback picker — durable framework names.
const FRAMEWORK_FIELDS = new Set(['id', 'type', 'name', 'kind', 'layer']);

/**
 * Registry of all handler / reducer / action-type metadata.
 *
 * Owned by ServiceRegistry and populated by ScenarioCompiler / ScenarioLoader
 * via registerToolset() (Phase 3). In Phase 1 it is present but empty —
 * no callers populate it yet.
 *
 * Instance-scoped so future multi-ServiceRegistry worlds (MC parallelism,
 * branching) get isolation for free without API churn.
 */
export class TypeRegistry {
  constructor() {
    this._classes     = new Map();  // typeName → ctor
    this._actionTypes = new Map();  // typeString → ActionTypeEntry
    this._families    = new Map();  // familyName → Set<typeString>
    this._byCategory  = new Map();  // category → Set<ctor>
    this._strict      = false;
    this._warnedTypes = new Set();
  }

  /**
   * Strict mode (default on): pickPayload throws for unregistered action types.
   * Permissive mode: warns once then falls back to the underscore-filter heuristic.
   * ServiceRegistry sets this based on opts.silent at sim construction time.
   */
  setStrict(strict) {
    this._strict = strict;
  }

  // ── Registration ────────────────────────────────────────────────────────────

  /**
   * Register a handler / reducer / action subclass.
   * Reads ctor.type (required) and ctor.category to bucket by kind.
   */
  registerClass(ctor) {
    if (!ctor.type) return;
    this._classes.set(ctor.type, ctor);
    if (ctor.category) {
      if (!this._byCategory.has(ctor.category)) {
        this._byCategory.set(ctor.category, new Set());
      }
      this._byCategory.get(ctor.category).add(ctor);
    }
  }

  /**
   * Register an action-type entry.
   * Entry shape: { type, fields?, family?, cc?, description? }
   */
  registerActionType(entry) {
    this._actionTypes.set(entry.type, entry);
    if (entry.family) {
      if (!this._families.has(entry.family)) {
        this._families.set(entry.family, new Set());
      }
      this._families.get(entry.family).add(entry.type);
    }
  }

  /**
   * Walk a toolset's types.{handlers,reducers,actions} and register everything.
   * Called by ScenarioCompiler.compile() and ScenarioLoader.load() (Phase 3).
   */
  registerToolset(toolset) {
    const types = toolset.types;
    if (!types) return;
    for (const ctor   of (types.handlers ?? [])) this.registerClass(ctor);
    for (const ctor   of (types.reducers ?? [])) this.registerClass(ctor);
    for (const entry  of (types.actions  ?? [])) this.registerActionType(entry);
  }

  // ── Lookup ──────────────────────────────────────────────────────────────────

  /** @returns {Function|null} constructor for the given type name, or null */
  get(typeName) {
    return this._classes.get(typeName) ?? null;
  }

  /** @returns {object|null} ActionTypeEntry for the given action type string, or null */
  getAction(typeString) {
    return this._actionTypes.get(typeString) ?? null;
  }

  /** @returns {Function[]} all registered constructors in the given category */
  byCategory(category) {
    const s = this._byCategory.get(category);
    return s ? [...s] : [];
  }

  /**
   * All ActionTypeEntries for a family, optionally filtered by cc.
   * @param {string} family
   * @param {{ cc?: string }} [opts]
   * @returns {object[]}
   */
  byFamily(family, { cc } = {}) {
    const types = this._families.get(family);
    if (!types) return [];
    const entries = [...types].map(t => this._actionTypes.get(t)).filter(Boolean);
    return cc ? entries.filter(e => e.cc === cc) : entries;
  }

  /**
   * Type-string list for a family — drop-in for op:'in' query values.
   * @param {string} family
   * @param {{ cc?: string }} [opts]
   * @returns {string[]}
   */
  familyTypes(family, { cc } = {}) {
    return this.byFamily(family, { cc }).map(e => e.type);
  }

  // ── Picker ──────────────────────────────────────────────────────────────────

  /**
   * Extract the serializable payload fields from a runtime action.
   *
   * If the action type is registered: returns only fields declared in
   * entry.fields (safe, stable, no accidental framework-field leakage).
   *
   * If unregistered and strict: throws to surface the missing declaration.
   * If unregistered and permissive: warns once, falls back to heuristic
   * (exclude FRAMEWORK_FIELDS + any underscore-prefixed field).
   */
  pickPayload(action) {
    const entry = this._actionTypes.get(action.type);
    if (entry) {
      const out = {};
      for (const k of Object.keys(entry.fields ?? {})) {
        if (action[k] != null) out[k] = action[k];
      }
      return out;
    }
    return this._fallbackPayload(action);
  }

  _fallbackPayload(action) {
    if (this._strict) {
      throw new Error(
        `TypeRegistry: action type '${action.type}' not registered — ` +
        `declare it in the owning toolset's types.actions block.`
      );
    }
    this._warnOnce(action.type);
    const out = {};
    for (const k of Object.keys(action)) {
      if (FRAMEWORK_FIELDS.has(k)) continue;
      if (k.startsWith('_'))       continue;
      if (action[k] != null)       out[k] = action[k];
    }
    return out;
  }

  _warnOnce(type) {
    if (!this._warnedTypes.has(type)) {
      this._warnedTypes.add(type);
      console.warn(
        `TypeRegistry: unknown action type '${type}' — using fallback payload extraction`
      );
    }
  }
}
