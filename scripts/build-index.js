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

const TOP_LEVEL_EXPORT_NAMES = new Set([
  'Simulation',
  'Account',
  'InvestmentAccount',
  'Person',
  'BaseScenario'
]);

const NAMESPACE_MAP = [
  { match: 'simulation-framework', name: 'Core' },
  { match: 'finance', name: 'Finance' },
  { match: 'scenarios', name: 'Scenarios' },
  { match: 'visualization', name: 'Visualization' }
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
  return './' + filePath.replace(SRC_DIR + '/', '').replace(/\\/g, '/');
}

function getNamespace(filePath) {
  const rel = filePath.replace(SRC_DIR + '/', '');
  for (const ns of NAMESPACE_MAP) {
    if (rel.startsWith(ns.match)) return ns.name;
  }
  return 'Misc';
}

//
// =========================================================
// PARSE EXPORTS (THIS IS THE KEY UPGRADE)
// =========================================================
//

function getExports(filePath) {
  const code = fs.readFileSync(filePath, 'utf-8');

  const ast = parse(code, {
    sourceType: 'module',
    plugins: ['classProperties']
  });

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

let imports = [];
let namespaces = {};
let topLevel = [];

for (const file of files) {
  const relPath = importPath(file);
  const exports = getExports(file);

  if (exports.length === 0) continue;

  const namespace = getNamespace(file);
  if (!namespaces[namespace]) namespaces[namespace] = [];

  imports.push(`import { ${exports.join(', ')} } from '${relPath}';`);

  for (const exp of exports) {
    namespaces[namespace].push(exp);

    if (TOP_LEVEL_EXPORT_NAMES.has(exp)) {
      topLevel.push(exp);
    }
  }
}

//
// Deduplicate
//
for (const key in namespaces) {
  namespaces[key] = [...new Set(namespaces[key])];
}
topLevel = [...new Set(topLevel)];

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

//
// Imports
//
out += imports.join('\n') + '\n\n';

//
// Top-level
//
out += `// =========================================================\n`;
out += `// TOP-LEVEL EXPORTS\n`;
out += `// =========================================================\n\n`;

out += `export {\n  ${topLevel.join(',\n  ')}\n};\n\n`;

//
// Namespaces
//
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

//
// Default export
//
out += `// =========================================================\n`;
out += `// DEFAULT EXPORT\n`;
out += `// =========================================================\n\n`;

out += `export default {\n`;

for (const t of topLevel) {
  out += `  ${t},\n`;
}

for (const ns of Object.keys(namespaces)) {
  out += `  ${ns},\n`;
}

out += `};\n`;

//
// Write
//
fs.writeFileSync(OUTPUT_FILE, out);
console.log('✅ index.js generated with flattened exports');
