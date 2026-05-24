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
 * BaseTaxDocumentModule — abstract base for country+year tax document formatters.
 *
 * Each concrete subclass converts a TaxComputationResult (from computeTax()) into
 * a structured TaxDocument suitable for display in the Journal Reporting UI.
 *
 * These modules are registered in TaxDocumentRegistry using the same
 * countryCode+year keying and highest-year-<= fallback as TaxEngine.
 */
export class BaseTaxDocumentModule {
  /** @returns {string}  e.g. 'US' or 'AU' */
  get countryCode() {
    throw new Error(`${this.constructor.name}: countryCode not implemented`);
  }

  /** @returns {number}  e.g. 2024 or 2026 */
  get year() {
    throw new Error(`${this.constructor.name}: year not implemented`);
  }

  /**
   * Convert a TaxComputationResult into a structured TaxDocument.
   *
   * @param {object} taxDetail  TaxComputationResult from computeTax()
   * @param {number} taxYear    The resolved tax year (e.g. 2025 for FY2025-26)
   * @returns {TaxDocument}
   */
  generate(taxDetail, taxYear) {
    throw new Error(`${this.constructor.name}: generate() not implemented`);
  }
}
