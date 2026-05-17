import copy      from 'rollup-plugin-copy-watch';
import dev       from 'rollup-plugin-dev';
import livereload from 'rollup-plugin-livereload';
import watchAssets from 'rollup-plugin-watch-assets';

const isWatching = process.env.ROLLUP_WATCH === 'true';

export default {
  input: 'src/apps/workbench-demo.js',

  output: {
    file:      'dist-workbench/workbench-demo.bundle.js',
    format:    'iife',
    name:      'WorkbenchDemo',
    sourcemap: true,
  },

  plugins: [
    copy({
      targets: [
        { src: 'workbench-demo.html',  dest: 'dist-workbench' },
        { src: 'assets/**/*',          dest: 'dist-workbench/assets', flatten: false },
      ],
    }),

    isWatching && watchAssets({
      assets: ['assets', 'workbench-demo.html'],
    }),

    isWatching && dev({
      dirs: ['dist-workbench'],
      port: 10002,
    }),

    isWatching && livereload({
      watch: 'dist-workbench',
      delay: 500,
    }),
  ].filter(Boolean),
};
