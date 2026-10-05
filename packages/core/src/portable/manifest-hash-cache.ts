import fsp from 'bare-fs/promises'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { writeFileAtomic } from './pathguard'
import { openFile, bytesReadOf } from './fs-handle'
import { isErrnoCode } from './errors'

const CACHE_VERSION = 1
const CACHE_MAX_ENTRIES = 781 // 256 shards, at most 199,936 persisted entries
const CACHE_MAX_BYTES = 1024 * 1024
// Persisted recency is refreshed at most once per shard per interval, so a hot
// entry keeps its place across restarts without turning a cache hit into a
// shard rewrite on every lookup.
const TOUCH_CHECKPOINT_MS = 15 * 60 * 1000
const HASH_RE = /^[0-9a-f]{64}$/i

export interface ManifestHashFingerprint {
  size: number
  mtimeMs: number
  ctimeMs: number
  dev: string
  ino: string
}

interface CacheEntry extends ManifestHashFingerprint {
  pathKey: string
  hash: string
  lastUsedMs: number
}

interface CacheFile {
  v: 1
  entries: CacheEntry[]
}

function normalizedPathKey(absPath: string): string {
  return absPath.replace(/\//g, '\\').toLowerCase()
}

function sameFingerprint(entry: CacheEntry, fp: ManifestHashFingerprint): boolean {
  return entry.size === fp.size &&
    entry.mtimeMs === fp.mtimeMs &&
    entry.ctimeMs === fp.ctimeMs &&
    entry.dev === fp.dev &&
    entry.ino === fp.ino
}

function validEntry(value: unknown): value is CacheEntry {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<CacheEntry>
  return typeof v.pathKey === 'string' && v.pathKey.length > 0 && v.pathKey.length <= 32768 &&
    typeof v.hash === 'string' && HASH_RE.test(v.hash) &&
    typeof v.size === 'number' && Number.isSafeInteger(v.size) && v.size >= 0 &&
    typeof v.mtimeMs === 'number' && Number.isFinite(v.mtimeMs) &&
    typeof v.ctimeMs === 'number' && Number.isFinite(v.ctimeMs) &&
    typeof v.dev === 'string' && v.dev.length > 0 && v.dev.length <= 64 &&
    typeof v.ino === 'string' && v.ino.length > 0 && v.ino.length <= 64 &&
    typeof v.lastUsedMs === 'number' && Number.isFinite(v.lastUsedMs)
}

/**
 * Best-effort persistent content hash cache. Correctness never depends on the
 * cache: callers only reuse a hash when a stable file identity + metadata
 * fingerprint matches, otherwise they rehash the file normally.
 */
class HashCacheShard {
  private readonly filePath: string | null
  private readonly entries = new Map<string, CacheEntry>()
  private loadPromise: Promise<void> | null = null
  private revision = 0
  private flushedRevision = 0
  private flushPromise: Promise<void> | null = null
  private dirty = new Map<string, CacheEntry | null>()
  private recencyDirty = false
  // Starts at construction: a short-lived process must never rewrite a shard
  // just because it read one entry.
  private lastTouchCheckpointMs = Date.now()

  constructor(filePath: string | null = null) {
    this.filePath = filePath
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loadPromise) return await this.loadPromise
    const load = this.loadInner()
    this.loadPromise = load
    await load
  }

  private async loadInner(): Promise<void> {
    if (!this.filePath) return
    try {
      const handle = await openFile(this.filePath, 'r')
      let text: string
      try {
        const size = Number((await handle.stat()).size)
        if (!Number.isSafeInteger(size) || size < 0 || size > CACHE_MAX_BYTES) return
        const bytes = new Uint8Array(size + 1)
        let read = 0
        while (read < bytes.byteLength) {
          const n = bytesReadOf(await handle.read(bytes, read, bytes.byteLength - read, read))
          if (!n) break
          read += n
        }
        if (read !== size) return
        text = b4a.toString(bytes.subarray(0, read), 'utf8')
      } finally {
        await handle.close()
      }
      const parsed = JSON.parse(String(text)) as Partial<CacheFile>
      if (parsed.v !== CACHE_VERSION || !Array.isArray(parsed.entries)) return
      const valid = parsed.entries.filter(validEntry)
        .sort((a, b) => a.lastUsedMs - b.lastUsedMs)
        .slice(-CACHE_MAX_ENTRIES)
      for (const entry of valid) {
        this.entries.set(entry.pathKey, { ...entry, hash: entry.hash.toLowerCase() })
      }
    } catch {
      // Missing/corrupt cache is equivalent to a cold cache. Never make a
      // manifest fail because an optimization file cannot be read.
    }
  }

  async lookup(absPath: string, fp: ManifestHashFingerprint): Promise<string | null> {
    await this.ensureLoaded()
    const key = normalizedPathKey(absPath)
    const entry = this.entries.get(key)
    if (!entry) return null
    if (!sameFingerprint(entry, fp)) {
      this.entries.delete(key)
      this.dirty.set(key, null)
      this.revision++
      return null
    }
    // Keep hot entries near the end for in-memory eviction, but do not dirty
    // the persistent cache on every cache hit. That would turn a no-rehash
    // preview back into a full cache-file rewrite. Persisted recency is
    // refreshed on a sampled interval instead, so a hot-but-unchanged entry is
    // not treated as cold data by another process's eviction.
    const now = Date.now()
    entry.lastUsedMs = now
    this.entries.delete(key)
    this.entries.set(key, entry)
    if (now - this.lastTouchCheckpointMs >= TOUCH_CHECKPOINT_MS) {
      this.lastTouchCheckpointMs = now
      this.recencyDirty = true
      this.revision++
    }
    return entry.hash
  }

  async remember(absPath: string, fp: ManifestHashFingerprint, hash: string): Promise<void> {
    if (!HASH_RE.test(hash)) return
    await this.ensureLoaded()
    const pathKey = normalizedPathKey(absPath)
    const previous = this.entries.get(pathKey)
    if (previous && sameFingerprint(previous, fp) && previous.hash === hash.toLowerCase()) return
    const entry: CacheEntry = { pathKey, ...fp, hash: hash.toLowerCase(), lastUsedMs: Date.now() }
    if (!validEntry(entry)) return
    this.entries.delete(pathKey)
    this.entries.set(pathKey, entry)
    this.dirty.set(pathKey, entry)
    while (this.entries.size > CACHE_MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value
      if (typeof oldest !== 'string') break
      this.entries.delete(oldest)
      this.dirty.delete(oldest)
    }
    this.revision++
  }

  async flush(): Promise<void> {
    await this.ensureLoaded()
    if (!this.filePath) return
    this.promoteRecencyCheckpoint()
    if (this.revision === this.flushedRevision) return
    if (this.flushPromise) {
      await this.flushPromise
      if (this.revision !== this.flushedRevision) await this.flush()
      return
    }
    const targetRevision = this.revision
    const changes = new Map(this.dirty)
    this.dirty.clear()
    let wrote = false
    const pending = this.persistMerged(changes)
      .then(() => {
        wrote = true
        this.flushedRevision = Math.max(this.flushedRevision, targetRevision)
      })
      .catch(() => {
        for (const [key, entry] of changes) if (!this.dirty.has(key)) this.dirty.set(key, entry)
        // Cache persistence is optional. Keep it dirty so a later flush can
        // retry, but never fail the user operation.
      })
    this.flushPromise = pending
    try {
      await pending
    } finally {
      if (this.flushPromise === pending) this.flushPromise = null
    }
    // A remember() may have raced with the write. Persist that newer revision
    // as a second atomic write instead of incorrectly marking it flushed.
    if (wrote && this.revision !== this.flushedRevision) await this.flush()
  }

  private promoteRecencyCheckpoint(): void {
    // Structural deltas always win: a recency checkpoint is only promoted into
    // its own flush so it can never displace a real entry change.
    if (!this.recencyDirty || this.dirty.size > 0) return
    for (const [key, entry] of this.entries) this.dirty.set(key, entry)
    this.recencyDirty = false
  }

  private async persistMerged(changes: Map<string, CacheEntry | null>): Promise<void> {
    const filename = this.filePath!
    const directory = filename.slice(0, filename.lastIndexOf('/'))
    await fsp.mkdir(directory, { recursive: true })
    const lock = `${filename}.lock`
    let acquired = false
    for (let attempt = 0; attempt < 20; attempt++) {
      try { await fsp.mkdir(lock); acquired = true; break } catch (err) {
        if (!isErrnoCode(err, 'EEXIST')) throw err
        await new Promise<void>((resolve) => setTimeout(resolve, 10))
      }
    }
    if (!acquired) throw new Error('cache shard busy')
    try {
      const disk = new HashCacheShard(filename)
      await disk.ensureLoaded()
      for (const [key, entry] of changes) {
        if (entry) disk.entries.set(key, entry)
        else disk.entries.delete(key)
      }
      let entries = [...disk.entries.values()].sort((a, b) => a.lastUsedMs - b.lastUsedMs).slice(-CACHE_MAX_ENTRIES)
      let text = JSON.stringify({ v: CACHE_VERSION, entries })
      while (b4a.byteLength(text, 'utf8') > CACHE_MAX_BYTES && entries.length) {
        entries = entries.slice(Math.max(1, Math.ceil(entries.length / 4)))
        text = JSON.stringify({ v: CACHE_VERSION, entries })
      }
      await writeFileAtomic(filename, text, { sync: false })
    } finally {
      await fsp.rmdir(lock)
    }
  }
}

/** Lazily load bounded shards rather than parsing a whole-tree cache for each
 * disposable per-file worker. v1 single-file caches become a harmless cold cache.
 * Per-shard locks merge independent worker deltas; locks are never stolen from
 * a potentially live writer and are cleared only at Core startup.
 */
export class ManifestHashCache {
  private readonly shards = new Map<number, HashCacheShard>()
  constructor(private readonly filePath: string | null = null) {}

  private shard(absPath: string): HashCacheShard {
    const bucket = crypto.hash(b4a.from(normalizedPathKey(absPath), 'utf8'))[0]
    let shard = this.shards.get(bucket)
    if (!shard) {
      const filename = this.filePath ? `${this.filePath}.v2/${bucket.toString(16).padStart(2, '0')}.json` : null
      shard = new HashCacheShard(filename)
      this.shards.set(bucket, shard)
    }
    return shard
  }

  async lookup(absPath: string, fp: ManifestHashFingerprint): Promise<string | null> {
    return await this.shard(absPath).lookup(absPath, fp)
  }
  async remember(absPath: string, fp: ManifestHashFingerprint, hash: string): Promise<void> {
    await this.shard(absPath).remember(absPath, fp, hash)
  }
  async flush(): Promise<void> {
    // Bound disk pressure while allowing independent shards to make progress.
    const shards = [...this.shards.values()]
    for (let i = 0; i < shards.length; i += 4) await Promise.all(shards.slice(i, i + 4).map((shard) => shard.flush()))
  }
}

/** Called before any workers start, after the previous Core Job has retired. */
export async function clearHashCacheLocks(filePath: string): Promise<void> {
  const directory = `${filePath}.v2`
  try {
    for (const name of await fsp.readdir(directory)) {
      if (/^[0-9a-f]{2}\.json\.lock$/.test(name)) await fsp.rmdir(`${directory}/${name}`).catch(() => {})
    }
  } catch {}
}
