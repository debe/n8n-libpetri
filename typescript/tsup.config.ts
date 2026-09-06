import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'compiler/index': 'src/compiler/index.ts',
    'verify/index': 'src/verify/index.ts',
    'verify/cli': 'src/verify/cli.ts',
    'verify/main': 'src/verify/main.ts',
    'conformance/index': 'src/conformance/index.ts',
    codec: 'src/codec.ts',
    'n8n-vitest-setup': 'src/n8n-vitest-setup.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  splitting: true,
  external: ['libpetri', 'n8n-workflow', 'n8n-core'],
});
