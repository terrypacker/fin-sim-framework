#!/usr/bin/env node
/**
 * check-requirements.js
 *
 * Scans test files for requirement IDs in test names and reports coverage
 * against the full list defined in docs/requirements.md.
 *
 * Usage:
 *   node scripts/check-requirements.js
 *   node scripts/check-requirements.js --missing        # only show uncovered IDs
 *   node scripts/check-requirements.js --category EVT  # filter to one category
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const TEST_DIRS = ['tests/unit', 'tests/viz'];

// All known requirement IDs — keep in sync with docs/requirements.md
const ALL_REQUIREMENTS = {
  EVT: [
    1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,
    21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,
    39,40,41,42,43,44,45,46,47,48,49,50,51,
  ],
  TE:   [1,2,3,4,5,6,7,8],
  AR:   [1,2,3,4,5,6,7,8,9,10,11],
  INFL: [1,2,3,4,5],
};

// Collect all test-file content
function collectTestContent() {
  let combined = '';
  for (const dir of TEST_DIRS) {
    const abs = join(ROOT, dir);
    let entries;
    try { entries = readdirSync(abs); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith('.test.mjs') && !f.endsWith('.test.js')) continue;
      const path = join(abs, f);
      if (statSync(path).isFile()) combined += readFileSync(path, 'utf8');
    }
  }
  return combined;
}

// Extract every requirement ID cited in a test() name
// Pattern:  test('EVT-3: ...')  or  test("AR-11: ...")
function extractCoveredIds(content) {
  const covered = new Map(); // "EVT-3" -> count
  const re = /test\s*\(\s*['"`](EVT|TE|AR|INFL)-(\d+)\s*:/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const key = `${m[1]}-${m[2]}`;
    covered.set(key, (covered.get(key) ?? 0) + 1);
  }
  return covered;
}

function main() {
  const args = process.argv.slice(2);
  const missingOnly = args.includes('--missing');
  const catFilter = (() => {
    const i = args.indexOf('--category');
    return i !== -1 ? args[i + 1]?.toUpperCase() : null;
  })();

  const content = collectTestContent();
  const covered = extractCoveredIds(content);

  let totalAll = 0, totalCovered = 0;

  for (const [cat, nums] of Object.entries(ALL_REQUIREMENTS)) {
    if (catFilter && cat !== catFilter) continue;

    const catTotal = nums.length;
    let catCovered = 0;
    const rows = [];

    for (const n of nums) {
      const id = `${cat}-${n}`;
      const count = covered.get(id) ?? 0;
      if (count > 0) catCovered++;
      if (!missingOnly || count === 0) {
        rows.push(`  ${count > 0 ? '✅' : '⬜'} ${id.padEnd(10)} (${count} test${count !== 1 ? 's' : ''})`);
      }
    }

    totalAll += catTotal;
    totalCovered += catCovered;

    const pct = Math.round((catCovered / catTotal) * 100);
    console.log(`\n${cat} — ${catCovered}/${catTotal} covered (${pct}%)`);
    for (const r of rows) console.log(r);
  }

  const pct = Math.round((totalCovered / totalAll) * 100);
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`TOTAL: ${totalCovered}/${totalAll} covered (${pct}%)\n`);
}

main();
