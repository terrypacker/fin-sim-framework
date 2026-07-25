#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { parse } from '@babel/parser';

const SRC_DIR = path.resolve('./src');
const OUTPUT_FILE = path.join(SRC_DIR, 'index.js');

//
// =========================================================
// CONFIG
// =========================================================
//

/**
 * These names are promoted to the flat top-level `export { ... }` block
 * in addition to appearing in their namespace object.
 */
const TOP_LEVEL_EXPORT_NAMES = new Set([
  'Simulation',
  'Account',
  'InvestmentAccount',
  'Person',
  'BaseScenario',
]);

/**
 * Files whose paths (relative to src/) match any of these patterns are skipped entirely.
 * Checked before namespace assignment.
 */
const EXCLUDE_PATTERNS = [
  // Individual finance plugin shims — exposed via finance-plugin-package.js only
  /^visualization\/workbench\/plugins\/finance\/(?!finance-plugin-package\.js)/,
];

/**
 * Namespace assignments — ordered by specificity, first match wins.
 * Any file that doesn't match any entry is omitted from the output (no "Misc" bucket).
 */
const NAMESPACE_MAP = [
  // App-level classes (BaseApp, SimulationWorkbench, WorkbenchApp)
  { match: 'apps',                    name: 'Apps'           },
  // Finance workbench plugin package (must precede generic 'finance' and 'visualization' matches)
  { match: 'visualization/workbench/plugins/finance/finance-plugin-package', name: 'FinancePlugins' },
  // Workbench IDE framework (must precede generic 'visualization' match)
  { match: 'visualization/workbench', name: 'Workbench'      },
  // All other visualization components
  { match: 'visualization',           name: 'Visualization'  },
  // Simulation engine + support modules
  { match: 'simulation-framework',    name: 'Engine'         },
  { match: 'graph',                   name: 'Engine'         },
  { match: 'query',                   name: 'Engine'         },
  { match: 'storage',                 name: 'Engine'         },
  // Finance domain
  { match: 'finance',                 name: 'Finance'        },
  // Pre-built scenarios
  { match: 'scenarios',               name: 'Scenarios'      },
  // Application-level services
  { match: 'services',                name: 'Services'       },
];

//
// =========================================================
// HELPERS
// =========================================================
//

function walk(dir) {
  let results = [];
  for (const file of fs.readdirSync(dir)) {
    const full = path.join(dir, file);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      results = results.concat(walk(full));
    } else if (file.endsWith('.js') && file !== 'index.js') {
      results.push(full);
    }
  }
  return results;
}

function importPath(filePath) {
  return './' + filePath.replace(SRC_DIR + path.sep, '').replace(/\\/g, '/');
}

function relPath(filePath) {
  return filePath.replace(SRC_DIR + path.sep, '').replace(/\\/g, '/');
}

function isExcluded(rel) {
  return EXCLUDE_PATTERNS.some(p => p.test(rel));
}

function getNamespace(rel) {
  for (const ns of NAMESPACE_MAP) {
    if (rel.startsWith(ns.match)) return ns.name;
  }
  return null; // not assigned to any namespace — skip
}

//
// =========================================================
// PARSE EXPORTS
// =========================================================
//

function getExports(filePath) {
  const code = fs.readFileSync(filePath, 'utf-8');
  const ast = parse(code, { sourceType: 'module', plugins: ['classProperties'] });

  const exports = [];
  for (const node of ast.program.body) {
    if (node.type === 'ExportNamedDeclaration') {
      if (node.declaration) {
        if (node.declaration.id) {
          exports.push(node.declaration.id.name);
        }
        if (node.declaration.declarations) {
          for (const decl of node.declaration.declarations) {
            exports.push(decl.id.name);
          }
        }
      }
      if (node.specifiers) {
        for (const spec of node.specifiers) {
          exports.push(spec.exported.name);
        }
      }
    }
  }
  return exports;
}

//
// =========================================================
// BUILD
// =========================================================
//

const files = walk(SRC_DIR);

const imports = [];
const namespaces = {};
const topLevel = [];

for (const file of files) {
  const rel = relPath(file);
  if (isExcluded(rel)) continue;

  const namespace = getNamespace(rel);
  if (!namespace) continue; // no namespace match → skip

  const exports = getExports(file);
  if (exports.length === 0) continue;

  if (!namespaces[namespace]) namespaces[namespace] = [];

  imports.push(`import { ${exports.join(', ')} } from '${importPath(file)}';`);

  for (const exp of exports) {
    namespaces[namespace].push(exp);
    if (TOP_LEVEL_EXPORT_NAMES.has(exp)) topLevel.push(exp);
  }
}

// Deduplicate (a name may appear in multiple files within the same namespace)
for (const key in namespaces) {
  namespaces[key] = [...new Set(namespaces[key])];
}

//
// =========================================================
// OUTPUT
// =========================================================
//

let out = `/**
 * AUTO-GENERATED FILE - DO NOT EDIT
 * Run: npm run build:index
 */

`;

out += imports.join('\n') + '\n\n';

out += `// =========================================================\n`;
out += `// TOP-LEVEL EXPORTS\n`;
out += `// =========================================================\n\n`;
out += `export {\n  ${[...new Set(topLevel)].join(',\n  ')}\n};\n\n`;

out += `// =========================================================\n`;
out += `// NAMESPACES\n`;
out += `// =========================================================\n\n`;

for (const [ns, exports] of Object.entries(namespaces)) {
  out += `export const ${ns} = {\n`;
  for (const e of exports) {
    out += `  ${e},\n`;
  }
  out += `};\n\n`;
}

out += `// =========================================================\n`;
out += `// DEFAULT EXPORT\n`;
out += `// =========================================================\n\n`;

out += `export default {\n`;
for (const t of [...new Set(topLevel)]) out += `  ${t},\n`;
for (const ns of Object.keys(namespaces))  out += `  ${ns},\n`;
out += `};\n`;

fs.writeFileSync(OUTPUT_FILE, out);
console.log(`✅ index.js generated — ${Object.keys(namespaces).join(', ')}`);
