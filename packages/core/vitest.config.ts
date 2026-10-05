import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      'bare-fs': 'node:fs',
      'bare-fs/promises': 'node:fs/promises',
      'bare-path': 'node:path',
      'bare-os': 'node:os',
      'bare-process': 'node:process',
      'bare-crypto': 'node:crypto',
      // Node/Vitest cannot load Bare native addons (bare-subprocess -> bare-pipe).
      // Production still uses the real bare-subprocess module; this alias is test-only.
      'bare-subprocess': 'node:child_process'
    }
  }
})
