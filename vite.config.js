import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve }                       from 'node:path';

import { defineConfig } from 'vite';

import { SW_FILENAME, precacheManifest, readTree, renderServiceWorker }
  from './scripts/lib/pwa-precache.mjs';

/**
 * Regenerate the help index when a tier-2 topic changes (design 108 §8).
 *
 * `public/help/help-index.json` is a gitignored build artifact, written by `prebuild` and
 * by `npm run help:build`. Neither runs during `vite dev`, so without this, editing a
 * topic changed nothing in the app until the dev server was restarted — which is exactly
 * how a documentation surface stops being edited.
 *
 * Only the JSON is rewritten here. `help/REFERENCE.md` is COMMITTED and its diff is the
 * review signal (design 108 §4); regenerating it on every keystroke-save would put the
 * dev server in the business of editing tracked files.
 */
function helpTopicsWatcher() {
  const root = import.meta.dirname;
  return {
    name: 'finsim-help-topics',
    apply: 'serve',
    configureServer(server) {
      server.watcher.add(resolve(root, 'help'));
    },
    async handleHotUpdate({ file, server }) {
      if (!file.startsWith(resolve(root, 'help')) || !file.endsWith('.md')) return;
      if (file.endsWith('REFERENCE.md')) return;

      const { buildHelpIndex } = await import('./scripts/lib/help-index.mjs');
      const out = resolve(root, 'public/help/help-index.json');
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify(await buildHelpIndex(), null, 2)}\n`);

      server.ws.send({ type: 'full-reload' });
      return [];
    },
  };
}

/**
 * Write dist/sw.js once the build is on disk (src/pwa/service-worker.js).
 *
 * Runs in closeBundle and reads the finished dist/ tree rather than the rollup bundle,
 * because the precache list must include what rollup never sees: index.html as finally
 * emitted, the two worker bundles from their own sub-builds, and everything copied from
 * public/.
 */
function serviceWorkerPlugin() {
  let outDir, base;
  return {
    name: 'finsim-service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
      base   = config.base;
    },
    closeBundle() {
      const manifest = precacheManifest(readTree(outDir), base);
      const source   = readFileSync(resolve(import.meta.dirname, 'src/pwa/service-worker.js'), 'utf8');
      writeFileSync(resolve(outDir, SW_FILENAME), renderServiceWorker(source, manifest));
    },
  };
}

export default defineConfig({
  root: '.',
  base: '/',
  publicDir: 'public',
  plugins: [helpTopicsWatcher(), serviceWorkerPlugin()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 10001,
    open: false,
  },
});
