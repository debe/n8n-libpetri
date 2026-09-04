import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'compiler/index': 'src/compiler/index.ts',
    'verify/index': 'src/verify/index.ts',
    'conformance/index': 'src/conformance/index.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  splitting: true,
  external: ['libpetri', 'n8n-workflow', 'n8n-core'],
});
