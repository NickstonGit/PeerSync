import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    'portable/spike-entry': 'src/portable/spike-entry.ts',
    'portable/entry': 'src/portable/entry.ts'
  },
  format: ['esm'],
  dts: true,
  target: 'esnext',
  outDir: 'dist',
  clean: true,
  bundle: true,
  splitting: true,
  sourcemap: false,
  esbuildOptions(options) {
    options.packages = 'external'
  }
})
