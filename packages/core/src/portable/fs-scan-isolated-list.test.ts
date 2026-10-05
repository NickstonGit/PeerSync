import { describe, expect, it } from 'vitest'
import { ListRegistry, type ListEntry } from './fs-scan'
import type { DirectorySeed } from './pathguard'

function seedName(index: number): string {
  return `file-${String(index).padStart(4, '0')}.txt`
}

function entry(name: string, size = 1): ListEntry {
  return {
    relativePath: name,
    name,
    type: 'file',
    size,
    mtimeMs: 1
  }
}

describe('ListRegistry isolated paging', () => {
  it('loads cheap seeds once and hydrates only the visible page for name sorting', async () => {
    const seeds: DirectorySeed[] = Array.from({ length: 300 }, (_, index) => ({
      name: seedName(index),
      isDir: false,
      isLink: false
    }))
    let fullLoads = 0
    let seedLoads = 0
    const hydratedPageSizes: number[] = []
    const registry = new ListRegistry(
      async () => {
        fullLoads++
        return []
      },
      async () => {
        seedLoads++
        return seeds
      },
      async (_root, rel, page) => {
        hydratedPageSizes.push(page.length)
        return page.map((seed) => ({ ...entry(seed.name), relativePath: rel ? `${rel}/${seed.name}` : seed.name }))
      }
    )

    const first = await registry.page('C:\\root', '', null, { column: 'name', desc: false })
    expect(fullLoads).toBe(0)
    expect(seedLoads).toBe(1)
    expect(hydratedPageSizes).toEqual([128])
    expect(first.items).toHaveLength(128)
    expect(first.nextCursor).not.toBeNull()

    const second = await registry.page('C:\\root', '', first.nextCursor, { column: 'name', desc: false })
    expect(fullLoads).toBe(0)
    expect(seedLoads).toBe(1)
    expect(hydratedPageSizes).toEqual([128, 128])
    expect(second.items).toHaveLength(128)
  })

  it('materializes the directory when sorting requires size metadata', async () => {
    let fullLoads = 0
    let seedLoads = 0
    let hydrateLoads = 0
    const registry = new ListRegistry(
      async () => {
        fullLoads++
        return [entry('small.txt', 1), entry('large.txt', 10)]
      },
      async () => {
        seedLoads++
        return []
      },
      async () => {
        hydrateLoads++
        return []
      }
    )

    const page = await registry.page('C:\\root', '', null, { column: 'size', desc: false })
    expect(page.items).toHaveLength(2)
    expect(fullLoads).toBe(1)
    expect(seedLoads).toBe(0)
    expect(hydrateLoads).toBe(0)
  })
})
