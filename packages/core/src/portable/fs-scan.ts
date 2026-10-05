// LIST paging + MANIFEST immutable scans.

import fsp from 'bare-fs/promises'
import { randomBytes } from 'hypercore-crypto'
import b4a from 'b4a'
import {
  LIST_PAGE_SIZE,
  LIST_SNAPSHOT_TTL_MS,
  LIST_MAX_ENTRIES,
  LIST_MAX_SNAPSHOTS,
  MANIFEST_HASH_CONCURRENCY,
  MANIFEST_PAGE_SIZE,
  MANIFEST_MAX_ENTRIES,
  SCAN_TTL_MS,
  WALK_MAX_DEPTH,
  REL_PATH_MAX_BYTES
} from './limits'
import { FileDigest, hashFile } from './hashing'
import { readDirEntries, readDirSeeds, hydrateDirSeeds, resolveAllowedPath, PathError, type DirectorySeed } from './pathguard'
import { ManifestHashCache, type ManifestHashFingerprint } from './manifest-hash-cache'

export interface ListEntry {
  relativePath: string
  name: string
  type: 'file' | 'dir' | 'link'
  size: number
  mtimeMs: number
  skipped?: 'link'
}

export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

export type ListSortColumn = 'name' | 'type' | 'size' | 'date'
export interface ListSortSpec {
  column: ListSortColumn
  desc: boolean
}
export interface ListPage extends Page<ListEntry> {
  previousCursor: string | null
  offset: number
  totalEntries: number
}

type LoadDirectorySeeds = (root: string, rel: string, cancelled?: () => boolean) => Promise<DirectorySeed[]>
type HydrateListPage = (
  root: string,
  rel: string,
  seeds: readonly DirectorySeed[],
  cancelled?: () => boolean
) => Promise<ListEntry[]>

export function samePortablePath(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

export function comparePortablePaths(a: string, b: string): number {
  const la = a.toLowerCase()
  const lb = b.toLowerCase()
  return la < lb ? -1 : la > lb ? 1 : a < b ? -1 : a > b ? 1 : 0
}

// LIST and MANIFEST must share exactly the same deterministic ordering.
// Sync performs linear merges over frozen manifests, so using JavaScript's raw
// `<` at merge time would disagree with this case-folded ordering.
const strcmp = comparePortablePaths

function compareListEntries(a: ListEntry, b: ListEntry, sort: ListSortSpec | null): number {
  if (!sort) {
    return a.type === b.type ? strcmp(a.name, b.name) : a.type === 'dir' ? -1 : b.type === 'dir' ? 1 : strcmp(a.name, b.name)
  }
  let cmp = 0
  if (sort.column === 'name') cmp = strcmp(a.name, b.name)
  else if (sort.column === 'type') {
    const rank: Record<ListEntry['type'], number> = { dir: 0, file: 1, link: 2 }
    cmp = rank[a.type] - rank[b.type] || strcmp(a.name, b.name)
  } else if (sort.column === 'size') {
    cmp = a.size - b.size || strcmp(a.name, b.name)
  } else {
    cmp = a.mtimeMs - b.mtimeMs || strcmp(a.name, b.name)
  }
  return sort.desc ? -cmp : cmp
}

function compareListSeeds(a: DirectorySeed, b: DirectorySeed, sort: ListSortSpec | null): number {
  if (!sort) return a.isDir === b.isDir ? strcmp(a.name, b.name) : a.isDir ? -1 : b.isDir ? 1 : strcmp(a.name, b.name)
  let cmp = 0
  if (sort.column === 'name') cmp = strcmp(a.name, b.name)
  else if (sort.column === 'type') {
    const rank = (entry: DirectorySeed) => entry.isDir ? 0 : entry.isLink ? 2 : 1
    cmp = rank(a) - rank(b) || strcmp(a.name, b.name)
  } else {
    // size/date callers materialize metadata before sorting.
    cmp = strcmp(a.name, b.name)
  }
  return sort.desc ? -cmp : cmp
}

function newId(len = 12): string {
  return b4a.toString(randomBytes(len), 'hex')
}

function encodeCursor(n: number): string {
  return `c:${n}`
}
function decodeCursor(c: unknown): number {
  if (typeof c !== 'string' || !c.startsWith('c:')) throw new PathError('INVALID_REQUEST', 'bad cursor')
  const raw = c.slice(2)
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new PathError('INVALID_REQUEST', 'bad cursor')
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n < 0) throw new PathError('INVALID_REQUEST', 'bad cursor')
  return n
}

interface ListSnapshot {
  id: string
  key: string
  absDir: string
  rel: string
  /** Fully materialized only when sorting needs size/date metadata. */
  items: ListEntry[] | null
  /** Lightweight name/type snapshot for default/name/type sorting. */
  seeds: DirectorySeed[] | null
  metadata: Map<number, ListEntry>
  pageLoader: HydrateListPage | null
  expiresAtMs: number
}

function encodeListCursor(id: string, offset: number): string {
  return `l:${id}:${offset}`
}

function decodeListCursor(cursor: unknown): { id: string; offset: number } {
  if (typeof cursor !== 'string') throw new PathError('INVALID_REQUEST', 'bad list cursor')
  const m = /^l:([0-9a-f]{24}):(0|[1-9][0-9]*)$/i.exec(cursor)
  if (!m) throw new PathError('INVALID_REQUEST', 'bad list cursor')
  const offset = Number(m[2])
  if (!Number.isSafeInteger(offset) || offset < 0) throw new PathError('INVALID_REQUEST', 'bad list cursor')
  return { id: m[1].toLowerCase(), offset }
}

/**
 * Directory LIST snapshots. The first page performs one readdir/stat/sort pass;
 * subsequent pages slice the same immutable snapshot instead of rescanning the
 * whole directory for every 500 entries.
 */
export class ListRegistry {
  private _snapshots = new Map<string, ListSnapshot>()

  constructor(
    private readonly _loadAll?: (root: string, rel: string, sort?: ListSortSpec | null, cancelled?: () => boolean) => Promise<ListEntry[]>,
    private readonly _loadSeeds?: LoadDirectorySeeds,
    private readonly _hydratePage?: HydrateListPage
  ) {}

  private async _pageItems(snapshot: ListSnapshot, start: number, cancelled?: () => boolean): Promise<ListEntry[]> {
    if (snapshot.items) return snapshot.items.slice(start, start + LIST_PAGE_SIZE)
    const seeds = snapshot.seeds ?? []
    const end = Math.min(seeds.length, start + LIST_PAGE_SIZE)
    const missingIndices: number[] = []
    const missingSeeds: DirectorySeed[] = []
    for (let index = start; index < end; index++) {
      if (snapshot.metadata.has(index)) continue
      missingIndices.push(index)
      missingSeeds.push(seeds[index])
    }
    if (missingSeeds.length) {
      if (snapshot.pageLoader) {
        const hydrated = await snapshot.pageLoader(snapshot.absDir, snapshot.rel, missingSeeds, cancelled)
        if (cancelled?.()) throw new ScanError('STALE_SCAN', 'list cancelled')
        for (let i = 0; i < hydrated.length; i++) {
          snapshot.metadata.set(missingIndices[i], hydrated[i])
        }
      } else {
        const hydrated = await hydrateDirSeeds(snapshot.absDir, missingSeeds, cancelled)
        for (let i = 0; i < hydrated.length; i++) {
          const index = missingIndices[i]
          const e = hydrated[i]
          snapshot.metadata.set(index, {
            relativePath: snapshot.rel === '' ? e.name : `${snapshot.rel}/${e.name}`,
            name: e.name,
            type: (e.isLink ? 'link' : e.isDir ? 'dir' : 'file') as ListEntry['type'],
            size: e.size,
            mtimeMs: e.mtimeMs,
            skipped: e.isLink ? ('link' as const) : undefined
          })
        }
      }
    }
    const out: ListEntry[] = []
    for (let index = start; index < end; index++) {
      const entry = snapshot.metadata.get(index)
      if (entry) out.push(entry)
    }
    return out
  }

  async page(root: string, rel: string, cursor: string | null, sort?: ListSortSpec | null, cancelled?: () => boolean): Promise<ListPage> {
    this.sweep()
    const sortKey = sort ? `${sort.column}:${sort.desc ? 'desc' : 'asc'}` : 'default'
    const key = `${root.toLowerCase()}\n${rel}\n${sortKey}`
    let snapshot: ListSnapshot
    let start = 0

    if (cursor) {
      const decoded = decodeListCursor(cursor)
      const found = this._snapshots.get(decoded.id)
      if (!found || found.expiresAtMs < Date.now()) {
        if (found) this._snapshots.delete(found.id)
        throw new ScanError('STALE_SCAN', 'list snapshot expired or unknown')
      }
      if (found.key !== key) throw new PathError('INVALID_REQUEST', 'list cursor belongs to another directory')
      found.expiresAtMs = Date.now() + LIST_SNAPSHOT_TTL_MS
      this._snapshots.delete(found.id)
      this._snapshots.set(found.id, found)
      snapshot = found
      start = decoded.offset
    } else {
      let items: ListEntry[] | null = null
      let seeds: DirectorySeed[] | null = null
      let abs: string
      let pageLoader: HydrateListPage | null = null
      const needsMetadata = sort?.column === 'size' || sort?.column === 'date'
      const seedLoader = needsMetadata ? undefined : this._loadSeeds
      const hydratePage = seedLoader ? this._hydratePage : undefined
      if (this._loadAll && (needsMetadata || !seedLoader || !hydratePage)) {
        items = await this._loadAll(root, rel, sort ?? null, cancelled)
        if (cancelled?.()) throw new ScanError('STALE_SCAN', 'list cancelled')
        if (items.length > LIST_MAX_ENTRIES) throw new ScanError('LIMIT_EXCEEDED', `directory contains more than ${LIST_MAX_ENTRIES} entries`)
        // The isolated loader already resolved and validated the directory.
        // absDir is unused when a snapshot is fully materialized.
        abs = root
      } else if (seedLoader && hydratePage) {
        abs = root
        seeds = await seedLoader(root, rel, cancelled)
        if (cancelled?.()) throw new ScanError('STALE_SCAN', 'list cancelled')
        if (seeds.length > LIST_MAX_ENTRIES) throw new ScanError('LIMIT_EXCEEDED', `directory contains more than ${LIST_MAX_ENTRIES} entries`)
        seeds.sort((a, b) => compareListSeeds(a, b, sort ?? null))
        pageLoader = hydratePage
      } else {
        abs = await resolveAllowedPath(root, rel, 'LIST')
        if (needsMetadata) {
          const all = await readDirEntries(abs, { sort: false, cancelled })
          if (all.length > LIST_MAX_ENTRIES) throw new ScanError('LIMIT_EXCEEDED', `directory contains more than ${LIST_MAX_ENTRIES} entries`)
          items = all.map((e) => ({
            relativePath: rel === '' ? e.name : `${rel}/${e.name}`,
            name: e.name,
            type: (e.isLink ? 'link' : e.isDir ? 'dir' : 'file') as ListEntry['type'],
            size: e.size,
            mtimeMs: e.mtimeMs,
            skipped: e.isLink ? ('link' as const) : undefined
          }))
          items.sort((a, b) => compareListEntries(a, b, sort ?? null))
        } else {
          seeds = await readDirSeeds(abs, cancelled)
          if (seeds.length > LIST_MAX_ENTRIES) throw new ScanError('LIMIT_EXCEEDED', `directory contains more than ${LIST_MAX_ENTRIES} entries`)
          seeds.sort((a, b) => compareListSeeds(a, b, sort ?? null))
        }
      }
      snapshot = {
        id: newId(12), key, absDir: abs, rel, items, seeds,
        metadata: new Map<number, ListEntry>(),
        pageLoader,
        expiresAtMs: Date.now() + LIST_SNAPSHOT_TTL_MS
      }
      const total = items?.length ?? seeds?.length ?? 0
      if (total > LIST_PAGE_SIZE) {
        while (this._snapshots.size >= LIST_MAX_SNAPSHOTS) {
          const oldest = this._snapshots.keys().next().value
          if (typeof oldest !== 'string') break
          this._snapshots.delete(oldest)
        }
        this._snapshots.set(snapshot.id, snapshot)
      }
    }

    const totalEntries = snapshot.items?.length ?? snapshot.seeds?.length ?? 0
    if (start > totalEntries || (start === totalEntries && totalEntries > 0)) {
      throw new PathError('INVALID_REQUEST', 'list cursor offset out of range')
    }
    const items = await this._pageItems(snapshot, start, cancelled)
    const nextOffset = start + items.length
    const previousOffset = Math.max(0, start - LIST_PAGE_SIZE)
    const hasSnapshot = totalEntries > LIST_PAGE_SIZE
    return {
      items,
      nextCursor: hasSnapshot && nextOffset < totalEntries ? encodeListCursor(snapshot.id, nextOffset) : null,
      previousCursor: hasSnapshot && start > 0 ? encodeListCursor(snapshot.id, previousOffset) : null,
      offset: start,
      totalEntries
    }
  }

  sweep(): void {
    const now = Date.now()
    for (const [id, snapshot] of this._snapshots) {
      if (snapshot.expiresAtMs < now) this._snapshots.delete(id)
    }
  }

  clear(): void {
    this._snapshots.clear()
  }
}

/** Compatibility helper for callers that need only one page. */
export async function listPage(root: string, rel: string, cursor: string | null, sort?: ListSortSpec | null): Promise<ListPage> {
  const registry = new ListRegistry()
  return await registry.page(root, rel, cursor, sort)
}

export async function statPath(root: string, rel: string): Promise<ListEntry | null> {
  let abs: string
  try {
    abs = await resolveAllowedPath(root, rel, 'STAT')
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === 'NOT_FOUND') return null
    throw err
  }
  try {
    const st = await fsp.lstat(abs)
    if (st?.isSymbolicLink?.()) return { relativePath: rel, name: basename(rel), type: 'link', size: 0, mtimeMs: 0, skipped: 'link' }
    const isDir = !!st.isDirectory()
    return { relativePath: rel, name: basename(rel), type: isDir ? 'dir' : 'file', size: Number(st.size ?? 0), mtimeMs: Number(st.mtimeMs ?? 0) }
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === 'ENOENT' || (err as { code?: string })?.code === 'ENOTDIR') return null
    throw err
  }
}

/**
 * Fully materialize one directory under the same pathguard used by LIST.
 * Production callers may execute this function inside an isolated worker so a
 * wedged UNC readdir/lstat cannot pin the main Core process. The returned
 * array is immutable input for ListRegistry paging in Core.
 */
export async function listAllEntries(root: string, rel: string, sort?: ListSortSpec | null): Promise<ListEntry[]> {
  const abs = await resolveAllowedPath(root, rel, 'LIST')
  const all = await readDirEntries(abs, { sort: false })
  if (all.length > LIST_MAX_ENTRIES) throw new ScanError('LIMIT_EXCEEDED', `directory contains more than ${LIST_MAX_ENTRIES} entries`)
  const items = all.map((e) => ({
    relativePath: rel === '' ? e.name : `${rel}/${e.name}`,
    name: e.name,
    type: (e.isLink ? 'link' : e.isDir ? 'dir' : 'file') as ListEntry['type'],
    size: e.size,
    mtimeMs: e.mtimeMs,
    skipped: e.isLink ? ('link' as const) : undefined
  }))
  items.sort((a, b) => compareListEntries(a, b, sort ?? null))
  return items
}

function basename(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i < 0 ? rel : rel.slice(i + 1)
}

export function joinRel(base: string, tail: string): string {
  base = (base || '').replace(/^\/+|\/+$/g, '')
  tail = (tail || '').replace(/^\/+|\/+$/g, '')
  if (!base) return tail
  if (!tail) return base
  return `${base}/${tail}`
}

export function dirnameRel(p: string): string {
  const n = (p || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const i = n.lastIndexOf('/')
  return i < 0 ? '' : n.slice(0, i)
}

/** Paths stored in a MANIFEST are relative to the scan root, not the FS root. */
export function toScanRel(full: string, scanRoot: string): string {
  const f = (full || '').replace(/^\/+|\/+$/g, '')
  const s = (scanRoot || '').replace(/^\/+|\/+$/g, '')
  if (!s) return f
  if (f === s) return basename(f)
  if (f.startsWith(s + '/')) return f.slice(s.length + 1)
  return f
}

/**
 * Copy destination mapping (two-panel):
 * - file → destFolder/filename
 * - directory → destFolder/<selected-name>/…rest
 */
export function destRelOf(destFolder: string, selected: string, srcRel: string): string {
  const sel = (selected || '').replace(/^\/+|\/+$/g, '')
  const src = (srcRel || '').replace(/^\/+|\/+$/g, '')
  if (!sel) return joinRel(destFolder, src)
  if (src === sel) return joinRel(destFolder, basename(src))
  if (src.startsWith(sel + '/')) {
    return joinRel(destFolder, joinRel(basename(sel), src.slice(sel.length + 1)))
  }
  return joinRel(destFolder, basename(src))
}

// ---- filters: *.zip = any level, /*.zip = scan root only ----
export interface FilterSpec {
  include?: string[]
  exclude?: string[]
}

function globSrc(p: string): string {
  let out = ''
  for (const ch of p) {
    if (ch === '*') out += '[^/]*'
    else if (ch === '?') out += '[^/]'
    else if ('.+^${}()|[]\\'.includes(ch)) out += '\\' + ch
    else out += ch
  }
  return out
}
interface CompiledGlob {
  regex: RegExp
  basenameOnly: boolean
  includePrefix: string
}

function compileGlob(pattern: string): CompiledGlob | null {
  const anchored = pattern.startsWith('/')
  const pat = (anchored ? pattern.slice(1) : pattern).replace(/\\/g, '/')
  if (!pat) return null
  const basenameOnly = !anchored && !pat.includes('/')
  const regex = anchored
    ? new RegExp(`^${globSrc(pat)}$`)
    : basenameOnly
      ? new RegExp(`^${globSrc(pat)}$`)
      : new RegExp(`(^|/)${globSrc(pat)}$`)
  return { regex, basenameOnly, includePrefix: trimTrailingSlash(pattern) }
}

function compileFilter(filter?: FilterSpec | null): (relPath: string, type: 'file' | 'dir') => 'keep' | 'drop' {
  if (!filter) return () => 'keep'
  const includes = (filter.include ?? []).filter(Boolean).map(compileGlob).filter((g): g is CompiledGlob => g !== null)
  const excludes = (filter.exclude ?? []).filter(Boolean).map(compileGlob).filter((g): g is CompiledGlob => g !== null)
  const matches = (glob: CompiledGlob, relPath: string) => {
    const target = glob.basenameOnly ? (relPath.split('/').pop() ?? relPath) : relPath
    return glob.regex.test(target)
  }
  return (relPath, type) => {
    if (type === 'dir') return 'keep'
    if (includes.length && !includes.some((g) => matches(g, relPath) || (g.includePrefix && relPath.startsWith(g.includePrefix + '/')))) {
      return 'drop'
    }
    if (excludes.some((g) => matches(g, relPath))) return 'drop'
    return 'keep'
  }
}

export function filterDecision(relPath: string, type: 'file' | 'dir', filter?: FilterSpec | null): 'keep' | 'drop' {
  return compileFilter(filter)(relPath, type)
}
function trimTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '')
}

// ---- immutable manifest snapshot ----
export interface ManifestItem {
  relativePath: string
  size: number
  mtimeMs: number
  contentHash: string
}

export interface ScanSnapshot {
  scanId: string
  relativePath: string
  items: ManifestItem[]
  fileCount: number
  totalBytes: number
  entriesDigest: string
  /** scan start; diagnostic only */
  createdAtMs: number
  /** idle expiry, extended while the snapshot is actively paged */
  expiresAtMs: number
  /** absolute cap so a client cannot pin a manifest forever */
  hardExpiresAtMs: number
}

export class ScanError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export class ScanRegistry {
  private _scans = new Map<string, ScanSnapshot>()
  private _sweeper: ReturnType<typeof setInterval> | null = null

  start(): void {
    if (this._sweeper) return
    this._sweeper = setInterval(() => this.sweep(), 30_000)
    const anyT = this._sweeper as unknown as { unref?: () => void }
    if (typeof anyT.unref === 'function') anyT.unref()
  }
  stopSweeper(): void {
    if (this._sweeper) clearInterval(this._sweeper)
    this._sweeper = null
  }
  sweep(): void {
    const t = Date.now()
    for (const [id, s] of [...this._scans]) if (s.expiresAtMs < t || s.hardExpiresAtMs < t) this._scans.delete(id)
  }
  add(s: ScanSnapshot): ScanSnapshot {
    this._scans.set(s.scanId, s)
    return s
  }
  get(scanId: string): ScanSnapshot | null {
    const s = this._scans.get(scanId) ?? null
    const t = Date.now()
    if (s && (s.expiresAtMs < t || s.hardExpiresAtMs < t)) {
      this._scans.delete(scanId)
      return null
    }
    return s
  }
  page(scanId: string, cursor: string | null): { items: ManifestItem[]; nextCursor: string | null } {
    const s = this.get(scanId)
    if (!s) throw new ScanError('STALE_SCAN', 'scan expired or unknown')
    const start = cursor ? decodeCursor(cursor) : 0
    const items = s.items.slice(start, start + MANIFEST_PAGE_SIZE)
    // Treat TTL as idle time. Active consumers may page a 100k-item manifest
    // without it expiring mid-stream, while hardExpiresAtMs bounds retention.
    s.expiresAtMs = Math.min(s.hardExpiresAtMs, Date.now() + SCAN_TTL_MS)
    return { items, nextCursor: start + items.length < s.items.length ? encodeCursor(start + items.length) : null }
  }
  cancel(scanId: string): boolean {
    return this._scans.delete(scanId)
  }
  byPath(): ScanSnapshot[] {
    return [...this._scans.values()]
  }
}

export class ScanCancelled extends Error {}

export interface StableFileHash {
  relativePath: string
  size: number
  mtimeMs: number
  contentHash: string
}

/**
 * Hash one regular file only if metadata + filesystem identity remain stable
 * across the complete read. This is the single-file equivalent of the frozen
 * manifest invariant and is shared by fs.hash / copy preflight / x-init.
 */
export async function hashStableFile(
  rootPhysical: string,
  rel: string,
  opts: {
    cancelled?: () => boolean
    hashCache?: ManifestHashCache
    onIoProgress?: (bytes: number) => void
  } = {}
): Promise<StableFileHash> {
  const throwIfCancelled = () => {
    if (opts.cancelled?.()) throw new ScanError('STALE_SCAN', 'file hash cancelled')
  }
  const abs = await resolveAllowedPath(rootPhysical, rel, 'GET', 'exact')
  opts.onIoProgress?.(0)
  const before = await statReal(rootPhysical, rel)
  opts.onIoProgress?.(0)
  if (!before) throw new ScanError('NOT_FOUND', 'hash target is not a regular file')
  throwIfCancelled()

  let hex = before.fingerprint ? await opts.hashCache?.lookup(abs, before.fingerprint) ?? null : null
  let hashedSize = before.size
  if (!hex) {
    const hashed = await hashFile(abs, opts.cancelled, opts.onIoProgress)
    hex = hashed.hex
    hashedSize = hashed.size
  }
  throwIfCancelled()
  const after = await statReal(rootPhysical, rel)
  opts.onIoProgress?.(hashedSize)
  if (hashedSize !== before.size || !after || !sameFileVersion(before, after)) {
    throw new ScanError('STALE_SCAN', `file changed during hash: ${rel}`)
  }
  if (after.fingerprint) await opts.hashCache?.remember(abs, after.fingerprint, hex)
  return { relativePath: rel, size: before.size, mtimeMs: before.mtimeMs, contentHash: hex }
}

interface Candidate {
  childRel: string
  scanRel: string
  size: number
  mtimeMs: number
}

/**
 * Freeze walk: collect a stable metadata candidate set, hash with
 * bounded concurrency, then freeze. For each file: metadata-before → hash →
 * stat-after; mismatch ⇒ STALE_SCAN. Bounded hashing avoids serial I/O without
 * exploding disk queue depth on HDDs/network shares.
 */
export async function createManifest(
  rootPhysical: string,
  rel: string,
  filter: FilterSpec | undefined | null,
  opts: {
    cancelToken?: { cancelled: boolean }
    onProgress?: (filesDone: number, bytesDone: number) => void
    maxEntries?: number
    scanId?: string
    hashConcurrency?: number
    hashCache?: ManifestHashCache
    onIoProgress?: (bytes: number) => void
  } = {}
): Promise<ScanSnapshot> {
  const cancelToken = opts.cancelToken ?? { cancelled: false }
  const maxEntries = Math.min(
    MANIFEST_MAX_ENTRIES,
    Number.isSafeInteger(opts.maxEntries) && Number(opts.maxEntries) > 0
      ? Number(opts.maxEntries)
      : MANIFEST_MAX_ENTRIES
  )
  const hashConcurrency = Math.min(16, Math.max(1, Number(opts.hashConcurrency ?? MANIFEST_HASH_CONCURRENCY)))
  // Compile include/exclude globs once per manifest instead of rebuilding
  // RegExp objects for every directory entry.
  const decideFilter = compileFilter(filter)
  const t0 = Date.now()
  const items: ManifestItem[] = []
  let totalBytes = 0
  let filesDone = 0

  const throwIfCancelled = () => {
    if (cancelToken.cancelled) throw new ScanError('STALE_SCAN', 'manifest cancelled')
  }

  const rootAbs = await resolveAllowedPath(rootPhysical, rel, 'STAT')
  opts.onIoProgress?.(0)
  const rootStat = await fsp.lstat(rootAbs)
  opts.onIoProgress?.(0)
  if (!rootStat.isDirectory()) {
    const stable = await hashStableFile(rootPhysical, rel, {
      cancelled: () => cancelToken.cancelled,
      hashCache: opts.hashCache,
      onIoProgress: opts.onIoProgress
    })
    const name = basename(rel)
    items.push({ relativePath: name, size: stable.size, mtimeMs: stable.mtimeMs, contentHash: stable.contentHash })
    totalBytes = stable.size
    opts.onProgress?.(1, totalBytes)
  } else {
    // Freeze directory membership/metadata first, then hash. Keeping this
    // two-phase model is intentional: it detects mutations against one stable
    // candidate snapshot instead of allowing later directory traversal to race
    // earlier hashing.
    const candidates: Candidate[] = []
    await collectDir(rel, 0, candidates)
    throwIfCancelled()
    const candidateCount = candidates.length
    // Freeze is complete before hashing starts. Process and discard metadata in
    // bounded chunks so the peak does not retain a full Candidate[] alongside a
    // nearly-full ManifestItem[] for 100k-file trees.
    while (candidates.length) {
      const batch = candidates.splice(Math.max(0, candidates.length - 512), 512)
      await mapLimit(
        batch,
        hashConcurrency,
        async (candidate) => {
          throwIfCancelled()
          const abs = joinAbs(rootPhysical, candidate.childRel)
          const before = await statReal(rootPhysical, candidate.childRel)
          opts.onIoProgress?.(totalBytes)
          if (!before || before.size !== candidate.size || Math.round(before.mtimeMs) !== Math.round(candidate.mtimeMs)) {
            throw new ScanError('STALE_SCAN', `source changed before hash: ${candidate.childRel}`)
          }
          let hex = before.fingerprint ? await opts.hashCache?.lookup(abs, before.fingerprint) ?? null : null
          let size = before.size
          if (!hex) {
            const hashed = await hashFile(abs, () => cancelToken.cancelled, opts.onIoProgress)
            hex = hashed.hex
            size = hashed.size
          }
          throwIfCancelled()
          if (size !== candidate.size) throw new ScanError('STALE_SCAN', `size changed before hash: ${candidate.childRel}`)
          const after = await statReal(rootPhysical, candidate.childRel)
          opts.onIoProgress?.(totalBytes + candidate.size)
          if (!after || !sameFileVersion(before, after)) {
            throw new ScanError('STALE_SCAN', `source changed during hash: ${candidate.childRel}`)
          }
          if (after.fingerprint) await opts.hashCache?.remember(abs, after.fingerprint, hex)
          items.push({ relativePath: candidate.scanRel, size: candidate.size, mtimeMs: candidate.mtimeMs, contentHash: hex })
          totalBytes += candidate.size
          filesDone += 1
          if ((filesDone & 7) === 0 || filesDone === candidateCount) {
            opts.onProgress?.(filesDone, totalBytes)
            await tick()
          }
        },
        () => { cancelToken.cancelled = true }
      )
    }
  }
  throwIfCancelled()
  if (items.length > maxEntries) throw new ScanError('LIMIT_EXCEEDED', 'manifest entry limit')
  items.sort((a, b) => comparePortablePaths(a.relativePath, b.relativePath))
  await opts.hashCache?.flush()
  const readyAt = Date.now()
  const snapshot: ScanSnapshot = {
    scanId: opts.scanId ?? newId(12),
    relativePath: rel,
    items,
    fileCount: items.length,
    totalBytes,
    entriesDigest: manifestDigestHex(items),
    createdAtMs: t0,
    expiresAtMs: readyAt + SCAN_TTL_MS,
    hardExpiresAtMs: readyAt + Math.max(SCAN_TTL_MS * 6, 60 * 60 * 1000)
  }
  opts.onProgress?.(items.length, totalBytes)
  return snapshot

  async function collectDir(dirRel: string, depth: number, out: Candidate[]): Promise<void> {
    if (depth > WALK_MAX_DEPTH) throw new ScanError('LIMIT_EXCEEDED', 'max depth exceeded')
    if (b4a.byteLength(dirRel, 'utf8') > REL_PATH_MAX_BYTES) {
      throw new ScanError('LIMIT_EXCEEDED', 'relative path limit exceeded')
    }
    throwIfCancelled()
    const entries = await listAll(dirRel)
    opts.onIoProgress?.(totalBytes)
    for (const e of entries) {
      throwIfCancelled()
      if (e.link) continue
      const childRel = dirRel === '' ? e.name : `${dirRel}/${e.name}`
      if (b4a.byteLength(childRel, 'utf8') > REL_PATH_MAX_BYTES) {
        throw new ScanError('LIMIT_EXCEEDED', 'relative path limit exceeded')
      }
      if (e.dir) {
        await collectDir(childRel, depth + 1, out)
        continue
      }
      const scanRel = toScanRel(childRel, rel)
      if (out.length >= maxEntries) throw new ScanError('LIMIT_EXCEEDED', 'manifest entry limit')
      out.push({ childRel, scanRel, size: e.size, mtimeMs: e.mtimeMs })
      if ((out.length & 255) === 0) await tick()
    }
  }

  async function listAll(dirRel: string): Promise<Array<{ name: string; dir: boolean; link: boolean; size: number; mtimeMs: number }>> {
    const abs = await resolveAllowedPath(rootPhysical, dirRel, 'LIST')
    const raw = await readDirEntries(abs, { sort: false })
    return raw
      .filter((e) => {
        const full = dirRel === '' ? e.name : `${dirRel}/${e.name}`
        const scanRel = toScanRel(full, rel)
        return decideFilter(scanRel, e.isDir ? 'dir' : 'file') !== 'drop'
      })
      .map((e) => ({ name: e.name, dir: e.isDir, link: e.isLink, size: e.size, mtimeMs: e.mtimeMs }))
  }
}

async function mapLimit<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
  onFirstError?: (err: unknown) => void
): Promise<void> {
  let next = 0
  let failed = false
  let firstError: unknown
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) }, async () => {
    for (;;) {
      if (failed) return
      const index = next++
      if (index >= items.length) return
      try {
        await fn(items[index], index)
      } catch (err) {
        if (!failed) {
          failed = true
          firstError = err
          onFirstError?.(err)
        }
        return
      }
    }
  })
  // Wait for already-running hashes to finish before returning. Otherwise the
  // caller can start a new scan while old workers are still hammering the disk.
  await Promise.all(workers)
  if (failed) throw firstError
}

interface RealFileStat {
  size: number
  mtimeMs: number
  fingerprint: ManifestHashFingerprint | null
}

function statIdentityPart(value: unknown): string | null {
  if (typeof value === 'bigint') return value.toString(10)
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return String(value)
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return value
  return null
}

function sameFileVersion(a: RealFileStat, b: RealFileStat): boolean {
  if (a.size !== b.size || Math.round(a.mtimeMs) !== Math.round(b.mtimeMs)) return false
  if (!a.fingerprint || !b.fingerprint) return true
  return a.fingerprint.size === b.fingerprint.size &&
    a.fingerprint.mtimeMs === b.fingerprint.mtimeMs &&
    a.fingerprint.ctimeMs === b.fingerprint.ctimeMs &&
    a.fingerprint.dev === b.fingerprint.dev &&
    a.fingerprint.ino === b.fingerprint.ino
}

async function statReal(rootPhysical: string, rel: string): Promise<RealFileStat | null> {
  try {
    const abs = joinAbs(rootPhysical, rel)
    const st = await fsp.lstat(abs)
    if (st.isSymbolicLink?.() || !st.isFile()) return null
    const size = Number(st.size ?? 0)
    const mtimeMs = Number(st.mtimeMs ?? 0)
    const raw = st as unknown as { ctimeMs?: unknown; dev?: unknown; ino?: unknown }
    const ctimeMs = Number(raw.ctimeMs)
    const dev = statIdentityPart(raw.dev)
    const ino = statIdentityPart(raw.ino)
    // Reuse is fail-safe: if the runtime cannot provide a stable identity and
    // change timestamp, no cache fingerprint is produced and the file is
    // hashed normally.
    const fingerprint = Number.isFinite(ctimeMs) && dev !== null && ino !== null && ino !== '0'
      ? { size, mtimeMs, ctimeMs, dev, ino }
      : null
    return { size, mtimeMs, fingerprint }
  } catch {
    return null
  }
}

function joinAbs(root: string, rel: string): string {
  const base = root.replace(/[\\]+$/, '')
  return rel ? `${base}\\${rel.split('/').join('\\')}` : base
}

function tick(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(() => resolve(), 0))
}

export function canonicalManifestJson(items: ManifestItem[]): string {
  return JSON.stringify(items.map((i) => [i.relativePath, i.size, Math.round(i.mtimeMs), i.contentHash.toLowerCase()]))
}

export function manifestDigestHex(items: ManifestItem[]): string {
  const digest = new FileDigest()
  digest.update(b4a.from('[', 'utf8'))
  for (let i = 0; i < items.length; i++) {
    if (i) digest.update(b4a.from(',', 'utf8'))
    const item = items[i]
    const row = JSON.stringify([item.relativePath, item.size, Math.round(item.mtimeMs), item.contentHash.toLowerCase()])
    digest.update(b4a.from(row, 'utf8'))
  }
  digest.update(b4a.from(']', 'utf8'))
  return digest.digestHex()
}
