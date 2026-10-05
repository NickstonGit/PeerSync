// Sandbox path resolver. One resolver for all FS ops, both peers.
// Windows-safe: no absolute wire paths, no traversal, rejects reserved names,
// ADS, UNC, \?\ prefix, trailing dot/space; blocks symlink/junction/reparse
// escapes via per-segment lstat. Throws PathError with an fs.v1 error code.

import fs from 'bare-fs/promises'
import b4a from 'b4a'
import { DIRECTORY_METADATA_CONCURRENCY, REL_PATH_MAX_BYTES } from './limits'
import { openFile, bytesWrittenOf, type BareStats } from './fs-handle'
import { errorCode, errorMessage, isErrnoCode } from './errors'

export const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)
])

export type FsOpKind = 'LIST' | 'STAT' | 'GET' | 'MANIFEST' | 'MKDIR' | 'PUT'

/**
 * Portable v1 sandbox mode. Every remote path is relative to an allowlisted
 * root, validated segment-by-segment with lstat/reparse checks, and writes
 * revalidate created parents before use. This matches the documented v1 threat
 * model: remote traversal and existing symlink/junction/reparse escapes are
 * blocked; a malicious *local* process racing directory replacement is outside
 * the promised boundary until Bare exposes handle-relative no-follow I/O.
 */
export const REMOTE_ROOT_SANDBOX_MODE = 'segment-validated' as const

export class PathError extends Error {
  readonly code: 'INVALID_REQUEST' | 'NOT_ALLOWED' | 'NOT_FOUND' | 'IO' | 'CANCELLED'
  constructor(code: PathError['code'], message: string) {
    super(message)
    this.code = code
  }
}

function isReservedSegment(seg: string): boolean {
  const head = seg.split('.')[0].toUpperCase()
  return WINDOWS_RESERVED.has(head)
}

export function validateRelativePath(input: unknown, { allowEmpty = false, field = 'relativePath' } = {}): string {
  if (typeof input !== 'string') throw new PathError('INVALID_REQUEST', `${field} must be a string`)
  if (b4a.byteLength(input, 'utf8') > REL_PATH_MAX_BYTES) {
    throw new PathError('INVALID_REQUEST', `${field} too long`)
  }
  // separators normalized to '/' on the wire; reject anything windows-ish first
  if (input.includes('\\')) throw new PathError('INVALID_REQUEST', `${field}: backslash not allowed`)
  if (input.includes(':')) throw new PathError('INVALID_REQUEST', `${field}: drive/ADS not allowed`)
  if (input.startsWith('/')) throw new PathError('INVALID_REQUEST', `${field}: absolute not allowed`)
  const raw = input.replace(/^\/+|\/+$/g, '')
  if (raw === '') {
    if (allowEmpty) return ''
    throw new PathError('INVALID_REQUEST', `${field}: empty`)
  }
  const out: string[] = []
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') throw new PathError('INVALID_REQUEST', `${field}: empty/dot segment`)
    if (seg === '..') throw new PathError('INVALID_REQUEST', `${field}: parent traversal`)
    if (/[\x00-\x1f<>|"*?]/.test(seg)) throw new PathError('INVALID_REQUEST', `${field}: illegal chars`)
    if (/[. ]$/.test(seg)) throw new PathError('INVALID_REQUEST', `${field}: trailing dot/space`)
    if (isReservedSegment(seg)) throw new PathError('INVALID_REQUEST', `${field}: reserved name ${seg}`)
    out.push(seg)
  }
  return out.join('/')
}

export function isForbiddenLeaf(name: string): boolean {
  return isReservedSegment(name) || /[\x00-\x1f<>|"*?]/.test(name) || /[. ]$/.test(name) || name.includes(':')
}

export function joinNative(root: string, rel: string): string {
  const tail = rel.split('/').join('\\')
  const base = root.replace(/[/\\]+$/, '')
  return tail === '' ? base : `${base}\\${tail}`
}

export function splitSegments(rel: string): string[] {
  return rel === '' ? [] : rel.split('/')
}

/** bare-fs on win32 may expose raw attributes under either name. */
type NativeStats = BareStats & { fileAttributes?: number; attributes?: number }

/** lstat that could not be trusted (bare/win32 reports reparse oddities as UNKNOWN). */
interface UnverifiableStat {
  __unknown: true
}

type LstatResult = NativeStats | UnverifiableStat

function isUnverifiable(st: LstatResult): st is UnverifiableStat {
  return '__unknown' in st
}

async function lstatSafe(path: string): Promise<LstatResult | null> {
  try {
    return await fs.lstat(path)
  } catch (err: unknown) {
    if (isErrnoCode(err, 'ENOENT', 'ENOTDIR')) return null
    // treat missing-or-blocked; callers fail closed on it
    if (errorCode(err) === 'UNKNOWN') return { __unknown: true }
    throw new PathError('IO', `lstat ${path}: ${errorMessage(err)}`)
  }
}

const FILE_ATTRIBUTE_REPARSE_POINT = 0x400

function blockedKind(st: LstatResult | null): boolean {
  if (!st || isUnverifiable(st)) return true
  if (st.isSymbolicLink()) return true
  if (st.isBlockDevice() || st.isCharacterDevice() || st.isFIFO() || st.isSocket()) return true
  const attr = Number(st.fileAttributes ?? st.attributes ?? 0)
  if ((attr & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) return true
  return false
}

async function isReparsePoint(abs: string, st: LstatResult | null): Promise<boolean> {
  if (blockedKind(st)) return true
  // On Windows Bare exposes file attributes from lstat. Once that attribute is
  // known and REPARSE_POINT is clear, an additional readlink() probe for every
  // directory entry is redundant and very expensive on large folders. Keep the
  // readlink fallback for runtimes/platforms that do not expose the attribute.
  if (st && !isUnverifiable(st) && (st.fileAttributes !== undefined || st.attributes !== undefined)) return false
  try {
    await fs.readlink(abs)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve `rel` under `root`, refusing link/UNC-ish escapes.
 * - mode 'exact': target must exist and be appropriate for the operation
 *   (dir ops: LIST/MANIFEST target a directory that must exist).
 * - mode 'create-chain': parents of `rel` must be dirs (real, not links);
 *   missing trailing dirs allowed (PUT/MKDIR will create them).
 * Returns the native absolute path.
 */
export async function resolveAllowedPath(
  root: string,
  rel: string,
  operation: FsOpKind,
  mode: 'exact' | 'create-chain' = 'exact'
): Promise<string> {
  const clean = validateRelativePath(rel, { allowEmpty: true, field: operation })
  // LIST/MANIFEST/STAT may intentionally address the shared root itself. File
  // transfer operations may not: treating an empty PUT as a file target lets
  // callers derive sibling temporary paths outside the sandbox root.
  if (clean === '' && (operation === 'GET' || operation === 'PUT' || operation === 'MKDIR')) {
    throw new PathError('INVALID_REQUEST', `${operation}: root is not a file target`)
  }
  const isWrite = operation === 'PUT' || operation === 'MKDIR'
  const rootStat = await lstatSafe(root)
  if (!rootStat || isUnverifiable(rootStat)) throw new PathError('NOT_FOUND', `root ${root} missing`)
  if (await isReparsePoint(root, rootStat)) throw new PathError('NOT_ALLOWED', 'root is a link')
  if (!rootStat.isDirectory()) throw new PathError('IO', 'root is not a directory')

  const segments = splitSegments(clean)
  let current = root
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (isForbiddenLeaf(seg)) throw new PathError('INVALID_REQUEST', `illegal name ${seg}`)
    current = `${current}\\${seg}`
    const isTail = i === segments.length - 1
    const st = await lstatSafe(current)
    if (st === null) {
      if (isTail && (mode === 'create-chain' || isWrite)) {
        const parentAbs = current.replace(/\\[^\\]*$/, '')
        const parentSt = await lstatSafe(parentAbs)
        if (!parentSt || isUnverifiable(parentSt) || (await isReparsePoint(parentAbs, parentSt)) || !parentSt.isDirectory()) {
          throw new PathError(mode === 'exact' ? 'NOT_FOUND' : 'NOT_ALLOWED', 'missing parent is not a real directory')
        }
        return current
      }
      throw new PathError('NOT_FOUND', `${operation}: path component ${seg} missing`)
    }
    if (isUnverifiable(st) || (await isReparsePoint(current, st))) {
      throw new PathError('NOT_ALLOWED', `${operation}: ${seg} is a link/reparse point`)
    }
    if (!isTail && !st.isDirectory()) throw new PathError('NOT_ALLOWED', `${operation}: ${seg} not a directory while descending`)
    if (isTail && (operation === 'LIST' || operation === 'MANIFEST' || operation === 'MKDIR') && !st.isDirectory()) {
      throw new PathError('INVALID_REQUEST', `${operation}: target is not a directory`)
    }
    if (isTail && operation === 'GET' && !st.isFile()) throw new PathError('INVALID_REQUEST', 'GET: target is not a regular file')
  }
  return current
}

/** Enumerate directory entries without following links; links are reported and skipped. */
export interface DirectorySeed {
  name: string
  isDir: boolean
  isLink: boolean
}

// `bare-fs` does not expose a stable named `Dirent` type in the typings used by
// the portable build. Keep this structural type local to the only API surface
// we consume instead of coupling typecheck to the vendor declaration shape.
interface DirentLike {
  name: string
  isFile(): boolean
  isDirectory(): boolean
  isBlockDevice(): boolean
  isCharacterDevice(): boolean
  isFIFO(): boolean
  isSocket(): boolean
  isSymbolicLink(): boolean
}

function seedFromDirent(entry: DirentLike): DirectorySeed {
  const special = entry.isBlockDevice() || entry.isCharacterDevice() || entry.isFIFO() || entry.isSocket()
  const isLink = entry.isSymbolicLink() || special || (!entry.isDirectory() && !entry.isFile())
  return { name: String(entry.name), isDir: !isLink && entry.isDirectory(), isLink }
}

/**
 * Cheap directory membership/type pass. `withFileTypes` lets LIST sort by
 * name/type without issuing one lstat per entry. Metadata for the visible page
 * is hydrated separately below; size/date sorting deliberately uses the full
 * metadata path because those columns cannot be ordered without it.
 */
export async function readDirSeeds(
  absDir: string,
  cancelled?: () => boolean
): Promise<DirectorySeed[]> {
  const entries = await fs.readdir(absDir, { withFileTypes: true }) as unknown as DirentLike[]
  if (cancelled?.()) throw new PathError('CANCELLED', 'directory scan cancelled')
  return entries.map(seedFromDirent)
}

async function hydrateDirSeed(
  absDir: string,
  seed: DirectorySeed,
  cancelled?: () => boolean
): Promise<{ name: string; isDir: boolean; isLink: boolean; size: number; mtimeMs: number }> {
  if (cancelled?.()) throw new PathError('CANCELLED', 'directory scan cancelled')
  if (seed.isLink) return { name: seed.name, isDir: false, isLink: true, size: 0, mtimeMs: 0 }
  const abs = `${absDir}\\${seed.name}`
  const st = await lstatSafe(abs)
  // Keep snapshot offsets stable even when an entry disappears or becomes
  // unverifiable between readdir and the page request. Expose it as a blocked
  // link-like row; every operation still re-validates the path fail-closed.
  if (!st || isUnverifiable(st)) return { name: seed.name, isDir: false, isLink: true, size: 0, mtimeMs: 0 }
  if (await isReparsePoint(abs, st)) return { name: seed.name, isDir: false, isLink: true, size: 0, mtimeMs: 0 }
  if (st.isDirectory()) return { name: seed.name, isDir: true, isLink: false, size: 0, mtimeMs: Number(st.mtimeMs ?? 0) }
  if (st.isFile()) return { name: seed.name, isDir: false, isLink: false, size: Number(st.size ?? 0), mtimeMs: Number(st.mtimeMs ?? 0) }
  return { name: seed.name, isDir: false, isLink: true, size: 0, mtimeMs: 0 }
}

export async function hydrateDirSeeds(
  absDir: string,
  seeds: readonly DirectorySeed[],
  cancelled?: () => boolean
): Promise<Array<{ name: string; isDir: boolean; isLink: boolean; size: number; mtimeMs: number }>> {
  return await mapLimit(seeds, DIRECTORY_METADATA_CONCURRENCY, async (seed) => {
    return await hydrateDirSeed(absDir, seed, cancelled)
  })
}

export async function readDirEntries(
  absDir: string,
  opts: { sort?: boolean; cancelled?: () => boolean } = {}
): Promise<Array<{ name: string; isDir: boolean; isLink: boolean; size: number; mtimeMs: number }>> {
  const seeds = await readDirSeeds(absDir, opts.cancelled)
  const present = await hydrateDirSeeds(absDir, seeds, opts.cancelled)
  if (opts.cancelled?.()) throw new PathError('CANCELLED', 'directory scan cancelled')
  if (opts.sort !== false) {
    present.sort((a, b) => (a.isDir === b.isDir ? String(a.name).localeCompare(String(b.name)) : a.isDir ? -1 : 1))
  }
  return present
}

async function mapLimit<T, R>(items: readonly T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * Metadata for a verified regular file.
 *
 * `dev`/`ino` are stringified here, at the boundary where the values are read.
 * Inode numbers exceed the JS safe-integer range on several filesystems, and
 * every consumer of this shape is a JSON journal, so a number would be silently
 * corrupted before it could be compared after a restart.
 */
export interface FileStat {
  size: number
  mtimeMs: number
  dev: string
  ino: string
  birthtimeMs: number
  mode: number
}

function stringifyStatPart(value: unknown): string {
  return typeof value === 'bigint' ? value.toString() : String(value ?? '')
}

export async function statFile(absPath: string): Promise<FileStat | null> {
  const st = await lstatSafe(absPath)
  if (!st || isUnverifiable(st) || blockedKind(st)) return null
  if (!st.isFile()) return null
  return {
    size: Number(st.size ?? 0),
    mtimeMs: Number(st.mtimeMs ?? 0),
    dev: stringifyStatPart(st.dev),
    ino: stringifyStatPart(st.ino),
    birthtimeMs: Number(st.birthtimeMs ?? 0),
    mode: Number(st.mode ?? 0)
  }
}

export async function fileExistsRegular(absPath: string): Promise<boolean> {
  return (await statFile(absPath)) !== null
}

export async function ensureRealDirs(absDir: string, root: string): Promise<void> {
  if (absDir === root) return
  const relPart = absDir.slice(root.length).replace(/^\\+/, '')
  const segs = relPart === '' ? [] : relPart.split('\\').filter(Boolean)
  let current = root
  for (const seg of segs) {
    current = `${current}\\${seg}`
    let st = await lstatSafe(current)
    if (!st) {
      if (!current.toLowerCase().startsWith(root.toLowerCase())) throw new PathError('NOT_ALLOWED', 'outside root while creating')
      try {
        await fs.mkdir(current)
      } catch (err: unknown) {
        // race with a concurrent copy creating the same dir: tolerate, then re-check
        if (!isErrnoCode(err, 'EEXIST', 'EPERM')) throw new PathError('IO', `mkdir ${current}: ${errorMessage(err)}`)
      }
      st = await lstatSafe(current)
    }
    // An unverifiable component (UNKNOWN lstat) fails closed: never descend
    // into something that cannot be proven to be a real directory.
    if (!st || isUnverifiable(st)) throw new PathError('NOT_ALLOWED', `cannot verify directory component: ${seg}`)
    if (await isReparsePoint(current, st)) throw new PathError('NOT_ALLOWED', `component is a link: ${seg}`)
    if (!st.isDirectory()) throw new PathError('NOT_ALLOWED', `component exists and is not a real directory: ${seg}`)
  }
}

/** Atomic text write (unique tmp + rename) used for roots/chat/journal files.
 *  Unique temp names matter: concurrent flushes of the same target must not
 *  race on one shared `.tmp` (the earlier rename left losers with ENOENT and
 *  stale content). */
let tmpSeq = 0
export async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  opts?: { sync?: boolean }
): Promise<void> {
  const tmp = `${path}.tmp-${(typeof Bare !== 'undefined' ? Bare.pid : 0).toString(16)}-${(++tmpSeq).toString(36)}`
  const handle = await openFile(tmp, 'w')
  try {
    const bytes: Uint8Array = typeof data === 'string' ? b4a.from(data, 'utf8') : data
    let written = 0
    while (written < bytes.byteLength) {
      const n = bytesWrittenOf(await handle.write(bytes, written, bytes.byteLength - written, null))
      if (n <= 0) throw new Error('write stalled')
      written += n
    }
    // Journals keep fsync on by default. Chat may skip it so the unread badge
    // is not blocked on Windows volume flush / AV.
    if (opts?.sync !== false) {
      await handle.sync()
    }
  } catch (err) {
    try {
      await handle.close()
    } catch {}
    try {
      await fs.unlink(tmp)
    } catch {}
    throw err
  }
  await handle.close()
  try {
    await fs.rename(tmp, path)
  } catch (err) {
    try {
      await fs.unlink(tmp)
    } catch {}
    throw err
  }
}
