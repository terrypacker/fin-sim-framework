import terser from '@rollup/plugin-terser'
import copy from 'rollup-plugin-copy-watch';
import serve from 'rollup-plugin-serve'
import livereload from 'rollup-plugin-livereload';

const isWatching = process.env.ROLLUP_WATCH === 'true';

export default [
  // ESM
  {
    input: 'src/index.js',
    output: {
      file: 'dist/index.esm.js',
      format: 'esm',
      sourcemap: true
    }
  },

  // CJS
  {
    input: 'src/index.js',
    output: {
      file: 'dist/index.cjs.js',
      format: 'cjs',
      sourcemap: true
    }
  },

  // UMD (browser)
  {
    input: 'src/index.js',
    output: {
      file: 'dist/index.umd.min.js',
      format: 'umd',
      name: 'FinSimLib',
      sourcemap: true
    },
    plugins: [
        !isWatching && terser(),
        !isWatching && copy({
          targets: [
            { src: 'assets/**/*', dest: 'dist/assets', flatten: false },
            { src: '*.html', dest: 'dist' }
          ]
        }),
        isWatching && serve({
          contentBase: ['.', 'dist']
        }),
        isWatching && livereload({
        })
    ].filter(Boolean)
  }
];
