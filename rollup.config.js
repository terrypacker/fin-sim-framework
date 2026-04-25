import terser from '@rollup/plugin-terser'
import copy from 'rollup-plugin-copy-watch';
import dev from 'rollup-plugin-dev'
import livereload from 'rollup-plugin-livereload';
import nodeResolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';

const isWatching = process.env.ROLLUP_WATCH === 'true';

// Chart.js and its plugins are bundled into the UMD browser build.
// For ESM/CJS library builds they are left as external peer dependencies.
const CHART_EXTERNALS = ['chart.js', 'chartjs-plugin-annotation', 'chartjs-plugin-zoom', 'hammerjs'];

export default [
  // ESM
  {
    input: 'src/index.js',
    external: CHART_EXTERNALS,
    output: {
      file: 'dist/index.esm.js',
      format: 'esm',
      sourcemap: true
    }
  },

  // CJS
  {
    input: 'src/index.js',
    external: CHART_EXTERNALS,
    output: {
      file: 'dist/index.cjs.js',
      format: 'cjs',
      sourcemap: true
    }
  },

  // UMD (browser) — Chart.js and plugins bundled in
  {
    input: 'src/index.js',
    output: {
      file: 'dist/index.umd.min.js',
      format: 'umd',
      name: 'FinSimLib',
      sourcemap: true
    },
    plugins: [
        nodeResolve({ browser: true }),
        commonjs(),
        copy({
          targets: [
            { src: 'assets/**/*', dest: 'dist/assets', flatten: false },
            { src: '*.html', dest: 'dist' }
          ]
        }),  //copy assets when not debugging
        isWatching && dev({
          dirs: ['dist'],
          port: 10001,
        }),
        isWatching && livereload({
          watch: 'dist',
          delay: 500
        }),
       !isWatching && terser() //minify when not debugging
    ].filter(Boolean)
  }
];
