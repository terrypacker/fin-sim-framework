/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { TaxDocumentRegistry } from './tax/tax-document-registry.js';
import { StateTaxDocumentReporter } from './tax/state/state-tax-document.js';

/**
 * JournalReportingService — dispatches journal entries to document reporters.
 *
 * Each reporter is registered against an action type.  When generate() is
 * called with a JournalEntry, the service looks up the reporter by
 * entry.action.type and delegates to reporter.generate(entry).
 *
 * Built-in registrations:
 *   US_TAX_SETTLE_APPLY → TaxDocumentRegistry
 *   AU_TAX_SETTLE_APPLY → TaxDocumentRegistry
 *
 * Additional reporters can be registered via register() for future
 * event types (rebalancing summaries, withdrawal reports, etc.).
 */
export class JournalReportingService {
  constructor() {
    /** @type {Map<string, { generate(entry): object|null }>} */
    this._reporters = new Map();
    const taxDocs = new TaxDocumentRegistry();
    this.register('US_TAX_SETTLE_APPLY', taxDocs);
    this.register('AU_TAX_SETTLE_APPLY', taxDocs);
    this.register('STATE_TAX_SETTLE_APPLY', new StateTaxDocumentReporter());
  }

  /**
   * Register a reporter for a specific action type.
   *
   * @param {string} actionType  e.g. 'US_TAX_SETTLE_APPLY'
   * @param {{ generate(entry): object|null }} reporter
   */
  register(actionType, reporter) {
    this._reporters.set(actionType, reporter);
  }

  /**
   * Generate a document for the given journal entry, or null if no reporter
   * is registered for the entry's action type.
   *
   * @param {object}   journalEntry
   * @param {object[]} [journal]     - Full journal array, used for multi-entry reporting (e.g. Form 8949).
   * @returns {object|null}
   */
  generate(journalEntry, journal) {
    const reporter = this._reporters.get(journalEntry.action?.type);
    return reporter ? reporter.generate(journalEntry, journal) : null;
  }
}
