/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Period, PeriodRelationship } from './period-service.js';

/**
 * period-builder.js — factory functions for standard calendar period sets.
 *
 * All functions return plain `{ periods, relationships }` objects.
 * Callers add them to a PeriodService via `applyTo()` or manually.
 *
 * Month IDs use the canonical format 'M-YYYY-MM', so the same month object is
 * shared when both US and AU hierarchies are merged into one PeriodService.
 * `addPeriod()` is idempotent for identical period ids — overlapping months
 * from different builders will not conflict.
 *
 * Usage:
 *   const svc = new PeriodService();
 *   applyTo(svc, buildUsCalendarYear(2024));
 *   applyTo(svc, buildAuFiscalYear(2023));  // shares M-2024-01..06
 */

/**
 * Build a single MONTH period.
 *
 * @param {number} year   - 4-digit year
 * @param {number} month  - 1-based month (1=Jan … 12=Dec)
 * @returns {Period}
 */
export function buildMonthPeriod(year, month) {
  const startMs = Date.UTC(year, month - 1, 1);
  const endMs   = Date.UTC(year, month, 1);      // first ms of next month (exclusive)

  const mm   = String(month).padStart(2, '0');
  const id   = `M-${year}-${mm}`;
  const name = `${_monthName(month)}/${year}`;

  return new Period({ id, type: 'MONTH', name, startMs, endMs });
}

/**
 * Build a US calendar year (Jan 1 – Dec 31) with its 12 constituent months.
 *
 * @param {number} year - e.g. 2024
 * @returns {{ periods: Period[], relationships: PeriodRelationship[] }}
 */
export function buildUsCalendarYear(year) {
  const yearStartMs = Date.UTC(year, 0, 1);
  const yearEndMs   = Date.UTC(year + 1, 0, 1);

  const yearPeriod = new Period({
    id:      `US-${year}`,
    type:    'YEAR_US',
    name:    String(year),
    startMs: yearStartMs,
    endMs:   yearEndMs,
  });

  const periods       = [yearPeriod];
  const relationships = [];

  for (let m = 1; m <= 12; m++) {
    const month = buildMonthPeriod(year, m);
    periods.push(month);
    relationships.push(new PeriodRelationship({
      parentId: yearPeriod.id,
      childId:  month.id,
      ordinal:  m,
    }));
  }

  return { periods, relationships };
}

/**
 * Build an AU fiscal year (Jul 1 startYear – Jun 30 startYear+1) with its
 * 12 constituent months.
 *
 * @param {number} startYear - The calendar year in which the fiscal year begins (e.g. 2023 for FY2023-24)
 * @returns {{ periods: Period[], relationships: PeriodRelationship[] }}
 */
export function buildAuFiscalYear(startYear) {
  const endYear     = startYear + 1;
  const yearStartMs = Date.UTC(startYear, 6, 1);  // Jul 1 startYear
  const yearEndMs   = Date.UTC(endYear,   6, 1);  // Jul 1 endYear (exclusive)

  const yearPeriod = new Period({
    id:      `AU-${startYear}-${endYear}`,
    type:    'YEAR_AU',
    name:    `${startYear}-${endYear}`,
    startMs: yearStartMs,
    endMs:   yearEndMs,
  });

  const periods       = [yearPeriod];
  const relationships = [];

  // Months: Jul..Dec of startYear (ordinals 1-6), Jan..Jun of endYear (ordinals 7-12)
  const monthSequence = [
    { year: startYear, month: 7  },
    { year: startYear, month: 8  },
    { year: startYear, month: 9  },
    { year: startYear, month: 10 },
    { year: startYear, month: 11 },
    { year: startYear, month: 12 },
    { year: endYear,   month: 1  },
    { year: endYear,   month: 2  },
    { year: endYear,   month: 3  },
    { year: endYear,   month: 4  },
    { year: endYear,   month: 5  },
    { year: endYear,   month: 6  },
  ];

  monthSequence.forEach(({ year, month }, i) => {
    const monthPeriod = buildMonthPeriod(year, month);
    periods.push(monthPeriod);
    relationships.push(new PeriodRelationship({
      parentId: yearPeriod.id,
      childId:  monthPeriod.id,
      ordinal:  i + 1,
    }));
  });

  return { periods, relationships };
}

/**
 * Apply a builder result to a PeriodService instance.
 * Adds all periods first (idempotent for duplicate month ids), then relationships.
 *
 * @param {import('./period-service.js').PeriodService} periodService
 * @param {{ periods: Period[], relationships: PeriodRelationship[] }} built
 */
export function applyTo(periodService, built) {
  periodService.addPeriods(built.periods);
  periodService.addRelationships(built.relationships);
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function _monthName(month) {
  return MONTH_NAMES[month - 1];
}
