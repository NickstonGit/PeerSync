import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

function read(...parts: string[]): string {
  return readFileSync(join(here, ...parts), 'utf8')
}

const fsEngine = read('fs-engine.ts')

/**
 * The no-replace candidate loop previously computed the sibling suffix inline
 * as `${base} (${i + 1})` with `i` starting at 0, which skipped `target (1)` and
 * began at `target (2)`. Both writers now share one implementation; these guards
 * fail if either side grows its own arithmetic again.
 */
describe('portable publication naming stays on the shared implementation', () => {
  it('imports the shared claim loop instead of running its own', () => {
    expect(fsEngine).toMatch(/from '@peersync\/drive'/)
    expect(fsEngine).toContain('claimFreeName')
    expect(fsEngine).toContain('candidateParts')
    expect(fsEngine).not.toMatch(/for \(let n = 0; n < 1000; n\+\+\)/)
  })

  it('does not contain inline `i + 1` suffix arithmetic', () => {
    expect(fsEngine).not.toMatch(/\$\{base\}\s*\(\$\{\s*i\s*\+\s*1\s*\}\)/)
  })

  it('does not build a suffixed sibling name locally', () => {
    expect(fsEngine).not.toMatch(/`\$\{base\} \(/)
  })
})
