import { defineConfig } from 'vite';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  build: {
    outDir: 'dist-lib',
    lib: {
      entry: resolve(__dirname, 'src/index.js'),
      name: 'FinSimLib',
      formats: ['es'],
      fileName: () => 'index.esm.js',
    },
    rollupOptions: {
      external: ['echarts'],
    },
  },
});
