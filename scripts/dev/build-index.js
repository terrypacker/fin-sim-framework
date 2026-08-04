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

  // Names this file IMPORTS. A name that is imported and then exported again is a
  // pass-through re-export, not this file's own export — see `reExported` below.
  const importedHere = new Set();
  for (const node of ast.program.body) {
    if (node.type !== 'ImportDeclaration') continue;
    for (const spec of node.specifiers ?? []) importedHere.add(spec.local.name);
  }

  const exports = [];
  const reExported = new Set();
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
          const name = spec.exported.name;
          exports.push(name);
          // `export { X } from './y.js'` (node.source) is definitionally a re-export.
          // `import { X } ...; export { X };` is the same thing spelled in two
          // statements — indistinguishable from a local declaration by syntax alone,
          // which is why the imported-name check above exists.
          if (node.source != null || importedHere.has(spec.local?.name ?? name)) {
            reExported.add(name);
          }
        }
      }
    }
  }
  return { exports, reExported };
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

// Every exported name must be imported EXACTLY ONCE. Two modules offering the same
// name — almost always because one re-exports the other's — used to emit two imports
// of the same identifier, which is a duplicate binding: a hard SyntaxError that fails
// every module load in the suite, from a file nobody edits by hand. Attribute each
// name to a single origin first, preferring the module that actually declares it over
// any module that merely passes it through.
const originOf = new Map();   // exported name → { file, isReExport }
for (const file of files) {
  const rel = relPath(file);
  if (isExcluded(rel) || !getNamespace(rel)) continue;
  const { exports, reExported } = getExports(file);
  for (const name of exports) {
    const isReExport = reExported.has(name);
    const prev = originOf.get(name);
    if (!prev) { originOf.set(name, { file, isReExport }); continue; }
    if (prev.isReExport && !isReExport) { originOf.set(name, { file, isReExport }); continue; }
    if (!prev.isReExport && !isReExport) {
      console.warn(`⚠️  '${name}' is declared by two modules — ${relPath(prev.file)} and ${rel}. `
        + `Keeping the first; rename one, or the namespace objects will disagree about which it means.`);
    }
  }
}

for (const file of files) {
  const rel = relPath(file);
  if (isExcluded(rel)) continue;

  const namespace = getNamespace(rel);
  if (!namespace) continue; // no namespace match → skip

  const { exports } = getExports(file);
  if (exports.length === 0) continue;

  if (!namespaces[namespace]) namespaces[namespace] = [];

  // Import only the names this file OWNS. A name it re-exports is imported from its
  // origin instead; the namespace object below still lists it either way, since one
  // import can be referenced from as many namespaces as claim it.
  const owned = exports.filter(name => originOf.get(name)?.file === file);
  if (owned.length > 0) {
    imports.push(`import { ${owned.join(', ')} } from '${importPath(file)}';`);
  }

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
