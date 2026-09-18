import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve }         from 'node:path';

import { defineConfig } from 'vite';

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

export default defineConfig({
  root: '.',
  base: '/',
  publicDir: 'public',
  plugins: [helpTopicsWatcher()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 10001,
    open: false,
  },
});
