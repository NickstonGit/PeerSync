import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { ManifestHashCache, clearHashCacheLocks } from './manifest-hash-cache'

const temporary: string[] = []
const fp = { size: 3, mtimeMs: 1, ctimeMs: 2, dev: '1', ino: '1' }
const hash = 'ab'.repeat(32)
function bucket(key: string) { return crypto.hash(b4a.from(key.replace(/\//g, '\\').toLowerCase()))[0].toString(16).padStart(2, '0') }
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'psn-cache-'))
  temporary.push(directory)
  return path.join(directory, 'hashes.json')
}
afterEach(async () => { for (const directory of temporary.splice(0)) await fs.rm(directory, { recursive: true, force: true }) })

describe('bounded shared hash cache', () => {
  it('does not dirty or rewrite an unchanged cache hit', async () => {
    const file = await fixture()
    const name = 'D:/shared/a.txt'
    const first = new ManifestHashCache(file)
    await first.remember(name, fp, hash)
    await first.flush()
    const shard = `${file}.v2/${bucket(name)}.json`
    const before = await fs.readFile(shard, 'utf8')
    const second = new ManifestHashCache(file)
    expect(await second.lookup(name, fp)).toBe(hash)
    await second.remember(name, fp, hash)
    await second.flush()
    expect(await fs.readFile(shard, 'utf8')).toBe(before)
  })

  it('merges concurrent writers in the same shard without dropping either delta', async () => {
    const file = await fixture()
    const a = 'D:/shared/a.txt'
    let b = ''
    for (let i = 0; !b; i++) { const candidate = `D:/shared/b-${i}.txt`; if (bucket(candidate) === bucket(a)) b = candidate }
    const first = new ManifestHashCache(file)
    const second = new ManifestHashCache(file)
    await first.remember(a, fp, hash)
    await second.remember(b, fp, 'cd'.repeat(32))
    await Promise.all([first.flush(), second.flush()])
    const reader = new ManifestHashCache(file)
    expect(await reader.lookup(a, fp)).toBe(hash)
    expect(await reader.lookup(b, fp)).toBe('cd'.repeat(32))
  })

  it('checkpoints refreshed recency so a hot entry is not evicted as cold data', async () => {
    const file = await fixture()
    const name = 'D:/shared/a.txt'
    const shard = `${file}.v2/${bucket(name)}.json`
    const seed = new ManifestHashCache(file)
    await seed.remember(name, fp, hash)
    await seed.flush()
    const stale = JSON.parse(await fs.readFile(shard, 'utf8')).entries[0].lastUsedMs
    expect(stale).toBeGreaterThan(0)

    // A fresh process observes the entry as a pure hit. Inside the checkpoint
    // interval that stays memory-only; past it the refreshed recency is persisted
    // so another process's eviction cannot treat a hot entry as cold data.
    const base = Date.now()
    let clock = base
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock)
    try {
      const warm = new ManifestHashCache(file)
      expect(await warm.lookup(name, fp)).toBe(hash)
      await warm.flush()
      const early = await fs.readFile(shard, 'utf8')
      expect(JSON.parse(early).entries[0].lastUsedMs).toBe(stale)

      clock = base + 20 * 60 * 1000
      expect(await warm.lookup(name, fp)).toBe(hash)
      await warm.flush()
      const checkpointed = JSON.parse(await fs.readFile(shard, 'utf8'))
      expect(checkpointed.entries[0].lastUsedMs).toBeGreaterThanOrEqual(stale)

      // Further hits inside the next checkpoint interval do not rewrite the shard.
      const after = await fs.readFile(shard, 'utf8')
      clock = base + 21 * 60 * 1000
      expect(await warm.lookup(name, fp)).toBe(hash)
      await warm.flush()
      expect(await fs.readFile(shard, 'utf8')).toBe(after)
    } finally {
      now.mockRestore()
    }
  })

  it('rejects oversized/corrupt shards and never loads the legacy whole-tree file', async () => {
    const file = await fixture()
    const name = 'D:/shared/a.txt'
    await fs.writeFile(file, 'legacy '.repeat(1000000))
    await fs.mkdir(`${file}.v2`)
    await fs.writeFile(`${file}.v2/${bucket(name)}.json`, Buffer.alloc(1024 * 1024 + 1))
    const cache = new ManifestHashCache(file)
    expect(await cache.lookup(name, fp)).toBeNull()
    await cache.remember(name, fp, hash)
    await cache.flush()
    expect(await new ManifestHashCache(file).lookup(name, fp)).toBe(hash)
    expect((await fs.stat(`${file}.v2/${bucket(name)}.json`)).size).toBeLessThanOrEqual(1024 * 1024)
  })

  it('invalidates a changed fingerprint and clears only owned empty lock names at startup', async () => {
    const file = await fixture()
    const name = 'D:/shared/a.txt'
    const cache = new ManifestHashCache(file)
    await cache.remember(name, fp, hash)
    await cache.flush()
    expect(await cache.lookup(name, { ...fp, ctimeMs: 3 })).toBeNull()
    await cache.flush()
    expect(await new ManifestHashCache(file).lookup(name, fp)).toBeNull()
    await fs.mkdir(`${file}.v2/00.json.lock`)
    await fs.mkdir(`${file}.v2/foreign.lock`)
    await clearHashCacheLocks(file)
    expect(await fs.readdir(`${file}.v2`)).not.toContain('00.json.lock')
    expect(await fs.readdir(`${file}.v2`)).toContain('foreign.lock')
  })
})
