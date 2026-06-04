/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

const esc = v => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const fmtNum = v => (v == null ? '' : Math.round(v).toString());
const fmtPct = v => (v == null ? '' : (v * 100).toFixed(1) + '%');

/**
 * Build RFC 4180 CSV from a ranked DecisionGraphResult.
 *
 * Columns: Rank, one column per DecisionPoint (using its label), P10, P50, P90, Success Rate.
 *
 * @param {object} result  — DecisionGraphResult (needs result.decisionPoints)
 * @param {Array}  ranked  — ranked leaves from DecisionGraphRunner.summarize()
 * @returns {string} CSV text, or '' if no leaves.
 */
export function buildDecisionGraphCsv(result, ranked) {
  if (!ranked || ranked.length === 0) return '';

  const dps = result?.decisionPoints ?? [];
  const dpHeaders = dps.map(dp => dp.label ?? dp.id ?? '');

  const headers = ['Rank', ...dpHeaders, 'P10', 'P50', 'P90', 'Success Rate'];

  const rows = ranked.map((leaf, i) => {
    const dpValues = dps.map(dp => {
      const val = leaf.optionVector?.[dp.id];
      if (val == null) return '';
      const opt = dp.options?.find(o => o.value === val);
      return opt?.label ?? String(val);
    });
    return [
      String(i + 1),
      ...dpValues,
      fmtNum(leaf.mcSummary?.p10),
      fmtNum(leaf.mcSummary?.p50),
      fmtNum(leaf.mcSummary?.p90),
      fmtPct(leaf.mcSummary?.successRate),
    ];
  });

  return [
    headers.map(esc).join(','),
    ...rows.map(r => r.map(esc).join(',')),
  ].join('\n');
}
