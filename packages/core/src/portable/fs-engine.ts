// fs.v1 engine. Operation = ONE FILE (descriptor shape).
// Directory copy fans out into per-file operations (independent cancel/resume).
//
// Machine (PUT and GET are the same flow with endpoints swapped; initiator can
// be either side):
//   x-init   -> SOURCE owner: validate read access + fingerprint, journalize
//               sender row.
//   x-open   -> DEST owner (== bytes receiver): validate write perms + dest
//               containment + overwrite-fingerprint hint, journalize receiver
//               row, open drive receiveFile session (resume bitmap if journal
//               says so).
//   x-ready  -> SOURCE owner: re-verify stat, start serving via drive channel.
//   x-result <- receiver -> source: ok/digestOk/savedTo (journal settles).
//   x-resume -> initiated by receiver after reconnect; source
//               re-hashes source file against its journal (STALE_SOURCE).
//   x-cancel -> user cancel on either side; discard rules; transport loss
//               never cancels, it parks journals waiting-peer.
// descriptorHash binds {operationId, source, destination, collision, size}
// (canonical encoding) so operationId identity cannot be hijacked;
// content hashes live in journals and drive verification and resume handling.

import fsp from 'bare-fs/promises'
import path from 'bare-path'
import b4a from 'b4a'
import { randomBytes } from 'hypercore-crypto'

import { SenderSession, ReceiverSession, selectChunkSize, chunkCount, MAX_TRANSFER_SIZE_BYTES, type Bitmap, type ChunkReader, type ChunkWriter, candidateParts, claimFreeName, NameCollisionExhaustedError, statIdentity } from '@peersync/drive'
import { ID_MAX_LEN, NAME_MAX_LEN, REL_PATH_MAX_BYTES, SAFE_ID_RE, HEX64_RE, CONCURRENT_TRANSFERS_PER_PEER, REMOTE_INITIATED_JOURNAL_MAX_PER_PEER, FILTER_MAX_PATTERNS, FILTER_PATTERN_MAX_BYTES, FILTER_TOTAL_MAX_BYTES, LIST_PAGE_SIZE, LIST_MAX_ENTRIES, MANIFEST_MAX_ENTRIES, MANIFEST_PAGE_SIZE, SCAN_TTL_MS, PUT_FILES_MAX, STAT_BATCH_WIRE_TARGETS } from './limits'
import { blake2b256, hashFile } from './hashing'
import {
  REMOTE_ROOT_SANDBOX_MODE,
  PathError,
  resolveAllowedPath,
  statFile,
  validateRelativePath,
  type FileStat
} from './pathguard'
import { allocatePartFile } from './partfile'
import { canonicalEncoding, uuidv4 } from './encoding'
import { ListRegistry, manifestDigestHex, comparePortablePaths, samePortablePath, destRelOf, joinRel, type ScanSnapshot, type ManifestItem, type FilterSpec, type ListEntry, type ListSortSpec } from './fs-scan'
import { ManifestHashCache } from './manifest-hash-cache'
import { openFile, bytesReadOf, bytesWrittenOf, type FileHandle } from './fs-handle'
import { errorCode, errorMessage, isErrnoCode, EngineError } from './errors'
import { joinNativePart } from './native-path'
import { createDiskAdapter, type DiskAdapter } from './disk-adapter'
import { asParams, isRecord, type Params } from './params'
import type { RootsManager, RootInfo } from './roots'
import type { JournalStore, JournalRow, FileJournal, OperationDescriptor } from './journal'
import type { PeerManager, PeerSession } from './peers'
import { dbg } from './log'
import { IsolatedIoWorker, canUseIsolatedIoWorker } from './io-worker-client'

export { EngineError }

function isEngineError(err: unknown): err is EngineError {
  return err instanceof EngineError
}

// Resume checkpoints are time/volume based. A fixed every-16-chunks policy
// caused hundreds of FlushFileBuffers calls on multi-GB files.
const CHUNK_CHECKPOINT_MIN_BYTES = 64 * 1024 * 1024
const CHUNK_CHECKPOINT_MAX_MS = 5_000
const CANCEL_TOMBSTONE_TTL_MS = 10 * 60_000
const CANCEL_TOMBSTONE_MAX = 4096
const MANIFEST_CACHE_MAX_SNAPSHOTS = 8
const MANIFEST_CACHE_MAX_ITEMS = 200_000
const MANIFEST_CACHE_REMOTE_MAX_SNAPSHOTS_PER_PEER = 2
const MANIFEST_CACHE_REMOTE_MAX_ITEMS_PER_PEER = MANIFEST_MAX_ENTRIES
const PREVIEW_CACHE_MAX = 1
const COPY_INLINE_OPERATION_IDS_MAX = 256

export interface FsRef {
  /** lowercase device pubkey hex; '' or self == local */
  deviceId: string
  rootId: string
  relativePath: string
}

export interface EndpointRef {
  peerId: string | null // null => local device
  rootId: string
  relativePath: string
}

export interface CopyItemInput {
  source: EndpointRef
  /** Exact destination path relative to destination.rootId (used by atomic sync). */
  destinationRelativePath?: string
  /** Per-item policy lets one durable sync batch mix new and overwrite rows. */
  collision?: 'rename' | 'overwrite'
  /** One-shot frozen manifest prepared by the UI for a directory source. */
  preScanId?: string
}

export interface CopyResult {
  batchId: string | null
  acceptedCount: number
  /** Kept inline only for small batches so one IPC frame is always bounded. */
  operationIds: string[]
}

export interface CopyRequest {
  destination: EndpointRef
  items: CopyItemInput[]
  collision?: 'rename' | 'overwrite'
  /** when items reference a remote source but the request came from UI,
   *  the leaf sizes/hashes come from an already-computed manifest */
  preFlashed?: Array<{ relativePath: string; size: number; mtimeMs?: number; contentHash: string; destFingerprint?: DestFingerprint | null }>
}

export interface RequestCancelToken {
  cancelled: boolean
}

/** Background source re-verification behind `x-resume.prepare` / `x-resume.status`. */
interface ResumeVerification {
  state: 'VERIFYING' | 'READY' | 'FAILED'
  error: { code: string; message: string } | null
  promise: Promise<void>
}

function throwIfRequestCancelled(token?: RequestCancelToken): void {
  if (token?.cancelled) throw new EngineError('CANCELLED', 'request cancelled')
}

export interface ResumeResult {
  ok: boolean
  peerOnline: boolean
  note?: string
}

export interface StoredSnapshot extends ScanSnapshot {
  kind: 'local' | 'remote'
  peerId: string | null
  rootId: string
  cancelToken?: { cancelled: boolean }
}

// ---------------- canonical / small utils ----------------
export function operationCore(descriptor: OperationDescriptorLike): string {
  // Fingerprints are protocol identity, not arbitrary metadata bags. Build the
  // canonical nested objects explicitly so a future optimisation hint (mtime,
  // inode, etc.) can never silently change descriptorHash again.
  const fingerprint = (value: DestFingerprint | null | undefined): DestFingerprint | null =>
    value ? { size: value.size, blake2b256: value.blake2b256 ?? null } : null
  return canonicalEncoding({
    operationId: descriptor.operationId,
    source: descriptor.source,
    destination: descriptor.destination,
    collision: descriptor.collision,
    size: descriptor.size,
    chunkSize: descriptor.chunkSize ?? null,
    sourceFingerprint: fingerprint(descriptor.sourceFingerprint),
    destFingerprint: fingerprint(descriptor.destFingerprint),
    createdAtMs: descriptor.createdAtMs ?? null
  })
}

export type DestFingerprint = {
  size: number
  blake2b256: string | null
}

export interface OperationDescriptorLike {
  operationId: string
  source: { deviceId: string; rootId: string; relativePath: string }
  destination: { deviceId: string; rootId: string; relativePath: string }
  collision: string
  size: number
  chunkSize?: number | null
  sourceFingerprint?: DestFingerprint | null
  destFingerprint?: DestFingerprint | null
  createdAtMs?: number | null
}

export function coreHashOf(descriptor: OperationDescriptorLike): string {
  return b4a.toString(blake2b256(b4a.from(operationCore(descriptor), 'utf8')), 'hex')
}

function newTransferId(): string {
  return b4a.toString(randomBytes(12), 'hex')
}
function fileName(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i < 0 ? rel : rel.slice(i + 1)
}

/**
 * Cancellation must remain possible even for a partially malformed/legacy
 * journal row. Journal recovery intentionally validates only the outer row
 * shape, so telemetry must not turn cleanup into a TypeError.
 */
function journalRelativePath(row: JournalRow): string {
  const descriptor = row.descriptor as unknown as { source?: { relativePath?: unknown } }
  const relativePath = descriptor?.source?.relativePath
  if (typeof relativePath === 'string') return relativePath
  return row.files[0]?.relativePath ?? ''
}

/**
 * Batch cancellation selects either a single row or the whole directory branch
 * below it. Comparison is case-folded because Windows treats the two spellings
 * of the same relative path as one identity.
 */
function pathInBranch(relativePath: string, branch: string): boolean {
  const candidate = (relativePath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase()
  const selected = branch.toLowerCase()
  return candidate === selected || candidate.startsWith(selected + '/')
}
function encodeCursor(n: number): string {
  return `c:${n}`
}
function decodeCursor(c: unknown): number {
  if (typeof c !== 'string' || !c.startsWith('c:')) throw new EngineError('INVALID_REQUEST', 'bad cursor')
  const raw = c.slice(2)
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new EngineError('INVALID_REQUEST', 'bad cursor')
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n < 0) throw new EngineError('INVALID_REQUEST', 'bad cursor')
  return n
}
/** wire `cursor` slot: absent → first page; non-string is rejected like a malformed cursor. */
function cursorParam(c: unknown): string | null {
  if (c === undefined || c === null) return null
  if (typeof c !== 'string') throw new EngineError('INVALID_REQUEST', 'bad cursor')
  return c
}
function filterParam(value: unknown): FilterSpec | null {
  if (value === undefined || value === null) return null
  if (!isRecord(value)) throw new EngineError('INVALID_REQUEST', 'filter must be an object')
  const out: FilterSpec = {}
  let patternCount = 0
  let totalBytes = 0
  for (const key of ['include', 'exclude'] as const) {
    const raw = value[key]
    if (raw === undefined) continue
    if (!Array.isArray(raw)) throw new EngineError('INVALID_REQUEST', `filter.${key} must be an array`)
    patternCount += raw.length
    if (patternCount > FILTER_MAX_PATTERNS) {
      throw new EngineError('LIMIT_EXCEEDED', `filter has more than ${FILTER_MAX_PATTERNS} patterns`)
    }
    const list: string[] = []
    for (const item of raw) {
      if (typeof item !== 'string') throw new EngineError('INVALID_REQUEST', `filter.${key} entries must be strings`)
      const bytes = b4a.byteLength(item, 'utf8')
      if (bytes > FILTER_PATTERN_MAX_BYTES) {
        throw new EngineError('LIMIT_EXCEEDED', `filter.${key} pattern exceeds ${FILTER_PATTERN_MAX_BYTES} bytes`)
      }
      totalBytes += bytes
      if (totalBytes > FILTER_TOTAL_MAX_BYTES) {
        throw new EngineError('LIMIT_EXCEEDED', `filter patterns exceed ${FILTER_TOTAL_MAX_BYTES} bytes total`)
      }
      list.push(item)
    }
    out[key] = list
  }
  return out
}

function listSortParam(value: unknown): ListSortSpec | null {
  if (value === undefined || value === null) return null
  if (!isRecord(value)) throw new EngineError('INVALID_REQUEST', 'sort must be an object')
  const column = String(value.column ?? '')
  if (!['name', 'type', 'size', 'date'].includes(column)) throw new EngineError('INVALID_REQUEST', 'sort.column')
  return { column: column as ListSortSpec['column'], desc: value.desc === true }
}

function parseRemoteListEntry(value: unknown, field = 'entry'): ListEntry {
  if (!isRecord(value)) throw new EngineError('INVALID_REQUEST', `invalid remote ${field}`)
  const relativePath = validateRelativePath(value.relativePath, { allowEmpty: false, field: `${field}.relativePath` })
  const name = typeof value.name === 'string' ? value.name : ''
  if (!name || name.length > NAME_MAX_LEN || name.includes('/') || name.includes('\\')) {
    throw new EngineError('INVALID_REQUEST', `invalid remote ${field}.name`)
  }
  const type = value.type
  if (type !== 'file' && type !== 'dir' && type !== 'link') throw new EngineError('INVALID_REQUEST', `invalid remote ${field}.type`)
  const size = Number(value.size)
  const mtimeMs = Number(value.mtimeMs)
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_TRANSFER_SIZE_BYTES) {
    throw new EngineError('INVALID_REQUEST', `invalid remote ${field}.size`)
  }
  if (!Number.isFinite(mtimeMs) || mtimeMs < 0) throw new EngineError('INVALID_REQUEST', `invalid remote ${field}.mtimeMs`)
  const out: ListEntry = { relativePath, name, type, size, mtimeMs }
  if (type === 'link') out.skipped = 'link'
  return out
}

function parseRemoteListResponse(value: unknown): {
  entries: ListEntry[]
  nextCursor: string | null
  previousCursor: string | null
  offset: number
  totalEntries: number
} {
  if (!isRecord(value) || !Array.isArray(value.entries)) throw new EngineError('INVALID_REQUEST', 'invalid remote list response')
  if (value.entries.length > LIST_PAGE_SIZE) throw new EngineError('LIMIT_EXCEEDED', 'remote list page too large')
  const cursor = (raw: unknown, field: string): string | null => {
    if (raw === null || raw === undefined) return null
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > ID_MAX_LEN) throw new EngineError('INVALID_REQUEST', `invalid remote ${field}`)
    return raw
  }
  const offset = Number(value.offset)
  const totalEntries = Number(value.totalEntries)
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(totalEntries) || totalEntries < 0 || totalEntries > LIST_MAX_ENTRIES) {
    throw new EngineError('INVALID_REQUEST', 'invalid remote list bounds')
  }
  const entries = value.entries.map((entry, index) => parseRemoteListEntry(entry, `entries[${index}]`))
  if (offset + entries.length > totalEntries) throw new EngineError('INVALID_REQUEST', 'remote list page exceeds total')
  return {
    entries,
    nextCursor: cursor(value.nextCursor, 'nextCursor'),
    previousCursor: cursor(value.previousCursor, 'previousCursor'),
    offset,
    totalEntries
  }
}

function parseRemoteStatResponse(value: unknown): { entry: ListEntry } {
  if (!isRecord(value)) throw new EngineError('INVALID_REQUEST', 'invalid remote stat response')
  return { entry: parseRemoteListEntry(value.entry, 'stat.entry') }
}

function parseRemoteStatBatchResponse(
  value: unknown
): Array<{ entry?: ListEntry; error?: { code: string; message: string } }> {
  const rec = asParams(value)
  const raw = Array.isArray(rec.results) ? rec.results : []
  if (raw.length > STAT_BATCH_WIRE_TARGETS) {
    throw new EngineError('LIMIT_EXCEEDED', 'remote stat batch too large')
  }
  return raw.map((item) => {
    try {
      const record = asParams(item)
      if (record.entry) return parseRemoteStatResponse({ entry: record.entry })
      const err = asParams(record.error)
      return { error: { code: String(err.code ?? 'IO'), message: String(err.message ?? 'stat failed') } }
    } catch (err) {
      return { error: { code: 'IO', message: errorMessage(err) } }
    }
  })
}

function parseRemoteHashResponse(value: unknown): { relativePath: string; size: number; mtimeMs: number; contentHash: string } {
  if (!isRecord(value)) throw new EngineError('INVALID_REQUEST', 'invalid remote hash response')
  const relativePath = validateRelativePath(value.relativePath, { allowEmpty: false, field: 'hash.relativePath' })
  const size = Number(value.size)
  const mtimeMs = Number(value.mtimeMs)
  const contentHash = typeof value.contentHash === 'string' ? value.contentHash.toLowerCase() : ''
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_TRANSFER_SIZE_BYTES) throw new EngineError('INVALID_REQUEST', 'invalid remote hash size')
  if (!Number.isFinite(mtimeMs) || mtimeMs < 0) throw new EngineError('INVALID_REQUEST', 'invalid remote hash mtimeMs')
  if (!HEX64_RE.test(contentHash)) throw new EngineError('INVALID_REQUEST', 'invalid remote hash digest')
  return { relativePath, size, mtimeMs, contentHash }
}
/** x-open may carry a fresher destination fingerprint than the descriptor. */
function destFingerprintHintOf(value: unknown): DestFingerprint | null {
  if (!isRecord(value) || typeof value.size !== 'number') return null
  return { size: value.size, blake2b256: typeof value.blake2b256 === 'string' ? value.blake2b256 : null }
}
function popcountByte(x: number): number {
  let n = 0
  while (x) {
    x &= x - 1
    n++
  }
  return n
}
function countBits(hex: string): number {
  const bytes = b4a.from(hex, 'hex')
  let n = 0
  for (const byte of bytes) n += popcountByte(byte)
  return n
}
function requireStr(obj: unknown, key: string, max = 4096): string {
  const v = isRecord(obj) ? obj[key] : undefined
  if (typeof v !== 'string') throw new EngineError('INVALID_REQUEST', `${key} must be a string`)
  if (v.length === 0 || v.length > max) throw new EngineError('INVALID_REQUEST', `${key} bad length`)
  return v
}

const REMOTE_ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/
function remoteErrorCode(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const code = value.trim().toUpperCase()
  return REMOTE_ERROR_CODE_RE.test(code) ? code : fallback
}

function remoteSavedToBase(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.slice(0, NAME_MAX_LEN).replace(/\\/g, '/')
  const base = text.slice(text.lastIndexOf('/') + 1)
  return base.length > 0 ? base : null
}
function normalizeDeviceHex(hex: unknown): string {
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hex)) throw new EngineError('INVALID_REQUEST', 'deviceId must be 64-hex')
  return hex.toLowerCase()
}

// ---------------- drive adapters ----------------
class SourceReader implements ChunkReader {
  private _handle: FileHandle | null = null
  private _worker: IsolatedIoWorker | null = null
  private _opening: Promise<number> | null = null
  private _closed = false

  constructor(private _root: string, private _rel: string, private _size: number) {}

  async size(): Promise<number> {
    if (this._closed) throw new EngineError('CANCELLED', 'source reader is closed')
    if (this._opening) return await this._opening
    const opening = this._openAndStat()
    this._opening = opening
    try {
      return await opening
    } finally {
      if (this._opening === opening) this._opening = null
    }
  }

  private async _openAndStat(): Promise<number> {
    if (canUseIsolatedIoWorker()) {
      const worker = new IsolatedIoWorker()
      this._worker = worker
      try {
        const opened = await worker.openReadRoot(this._root, this._rel)
        const size = opened.size
        if (this._closed) throw new EngineError('CANCELLED', 'source reader was closed while opening')
        if (size !== this._size) {
          throw new EngineError('STALE_SOURCE', `source size ${size} != descriptor ${this._size}`)
        }
        return size
      } catch (err) {
        if (this._worker === worker) this._worker = null
        await worker.terminate('source open failed')
        throw err
      }
    }

    // Node/test and non-standalone Bare fallback. Keep the acquired handle local
    // until the post-await closed check so close() racing openFile() cannot leak
    // a descriptor that was published after cleanup already ran.
    const pathname = await resolveAllowedPath(this._root, this._rel, 'GET', 'exact')
    const handle = await openFile(pathname, 'r')
    try {
      const st = await handle.stat()
      if (this._closed) throw new EngineError('CANCELLED', 'source reader was closed while opening')
      if (st.size !== this._size) {
        throw new EngineError('STALE_SOURCE', `source size ${st.size} != descriptor ${this._size}`)
      }
      this._handle = handle
      return st.size
    } catch (err) {
      try { await handle.close() } catch {}
      throw err
    }
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (this._closed) throw new EngineError('CANCELLED', 'source reader is closed')
    const worker = this._worker
    if (worker) {
      const data = await worker.read(offset, length)
      if (data.length !== length) throw new EngineError('STALE_SOURCE', 'short read (source shrank?)')
      return data
    }
    if (!this._handle) throw new EngineError('IO', 'source file is not open')
    const buf = b4a.allocUnsafe(length)
    const bytesRead = bytesReadOf(await this._handle.read(buf, 0, length, offset))
    if (bytesRead !== length) throw new EngineError('STALE_SOURCE', 'short read (source shrank?)')
    return buf.subarray(0, length)
  }

  async close(): Promise<void> {
    if (!this._closed) this._closed = true

    // Kill the isolated worker before waiting for any in-flight startup/read.
    // On Windows this terminates the process that owns the pending SMB/UNC
    // syscall, so sender lifecycle does not depend on that syscall returning.
    const worker = this._worker
    this._worker = null
    if (worker) await worker.terminate('source reader closed')

    const handle = this._handle
    this._handle = null
    if (handle) {
      try { await handle.close() } catch {}
    }

    const opening = this._opening
    if (opening) await opening.catch(() => {})
  }
}

type ReceiverCancellationClaim = 'cancel-owned' | 'commit-owned'

interface ReceiverFinalizeHooks {
  phase: (
    phase: 'prepared' | 'backup-created' | 'target-replaced',
    targetPath: string,
    backupPath: string | null,
    publishMode: 'link' | 'copy-exclusive',
    destinationIdentity?: string | null
  ) => Promise<void>
  reset: () => Promise<void>
  /** Synchronous authorization at the irreversible namespace boundary. */
  authorizeCommit: () => void
}

function partPathFor(target: string): string {
  return `${target}.peersync-part-${uuidv4()}.part`
}

/** Pre-rename part files still referenced by journals written by older builds. */
function legacyPartPathFor(target: string, operationId: string): string {
  return `${target}.altersend-${operationId}.part`
}

function backupPathFor(target: string): string {
  return `${target}.peersync-prev-${uuidv4()}`
}

function staleDestError(message: string): EngineError {
  const e = new EngineError('STALE_DEST', message)
  e.staleDest = true
  return e
}

class ReceiverWriter implements ChunkWriter {
  readonly partPath: string
  private _handle: FileHandle | null = null
  private _worker: IsolatedIoWorker | null = null
  private _cancelled = false
  private _preparing: Promise<void> | null = null
  private _committing: Promise<string> | null = null
  private _committedPath: string | null = null
  private _backupPath: string | null = null
  private _publishMode: 'link' | 'copy-exclusive' = 'link'
  private _copyInFlightTarget: string | null = null
  /** Destination opened by `_claimExclusiveCopy` and awaiting payload bytes. */
  private _exclusiveCopyHandle: FileHandle | null = null

  constructor(
    private readonly _target: string,
    partPath: string,
    private readonly _size: number,
    private readonly _resumeExisting: boolean,
    private readonly _overwrite: boolean,
    private readonly _contentHash: string,
    private readonly _destFingerprint: DestFingerprint | null,
    private readonly _hooks: ReceiverFinalizeHooks,
    private readonly _disk: DiskAdapter
  ) {
    this.partPath = partPath
  }

  private _cancelError(): EngineError {
    return new EngineError('CANCELLED', 'transfer cancelled')
  }

  private _throwIfCancelled(): void {
    if (this._cancelled) throw this._cancelError()
  }

  private _ensureWorker(): IsolatedIoWorker | null {
    if (!canUseIsolatedIoWorker()) return null
    if (!this._worker) this._worker = new IsolatedIoWorker()
    return this._worker
  }

  async allocate(): Promise<void> {
    this._throwIfCancelled()
    const worker = this._ensureWorker()
    if (worker) {
      await worker.openWrite(this.partPath, this._size, { exclusive: !this._resumeExisting })
      this._throwIfCancelled()
      return
    }
    await allocatePartFile(this.partPath, this._size, { exclusive: !this._resumeExisting })
    await this._closeHandle()
    const handle = await openFile(this.partPath, 'r+')
    if (this._cancelled) {
      try { await handle.close() } catch {}
      throw this._cancelError()
    }
    this._handle = handle
  }

  async write(offset: number, data: Uint8Array): Promise<void> {
    this._throwIfCancelled()
    if (offset + data.byteLength > this._size) throw new EngineError('INVALID_REQUEST', 'chunk beyond end')
    const worker = this._worker
    if (worker) {
      await worker.write(offset, data)
      this._throwIfCancelled()
      return
    }
    const h = this._handle
    if (!h) throw new EngineError('IO', 'receiver file is not allocated')
    let wrote = 0
    while (wrote < data.byteLength) {
      this._throwIfCancelled()
      const n = bytesWrittenOf(await h.write(data, wrote, data.byteLength - wrote, offset + wrote))
      if (!n) throw new EngineError('IO', 'write stalled')
      wrote += n
    }
    this._throwIfCancelled()
  }

  /** Flush written bytes before a durable bitmap checkpoint. */
  async sync(): Promise<void> {
    this._throwIfCancelled()
    const worker = this._worker
    if (worker) {
      await worker.sync()
      this._throwIfCancelled()
      return
    }
    if (!this._handle) return
    await this._handle.sync()
    this._throwIfCancelled()
  }

  private async _closeHandle(): Promise<void> {
    const worker = this._worker
    if (worker) {
      await worker.closeHandle()
      return
    }
    const h = this._handle
    this._handle = null
    if (!h) return
    await h.close()
  }

  private async _stopWorker(reason: string): Promise<void> {
    const worker = this._worker
    this._worker = null
    if (worker) await worker.terminate(reason)
  }

  private async _hash(pathname: string): Promise<{ hex: string; size: number }> {
    this._throwIfCancelled()
    const worker = this._worker
    if (worker) {
      const result = await worker.hash(pathname)
      this._throwIfCancelled()
      return result
    }
    return await hashFile(pathname, () => this._cancelled)
  }

  private async _stat(pathname: string): Promise<FileStat | null> {
    const worker = this._ensureWorker()
    if (worker) return await worker.statFile(pathname)
    return await statFile(pathname)
  }

  private async _exists(pathname: string): Promise<boolean> {
    return (await this._stat(pathname)) !== null
  }

  private async _unlink(pathname: string, ignoreMissing = true): Promise<void> {
    const worker = this._ensureWorker()
    if (worker) {
      await worker.unlink(pathname, ignoreMissing)
      return
    }
    try { await fsp.unlink(pathname) } catch (err) {
      if (!ignoreMissing || !isErrnoCode(err, 'ENOENT')) throw err
    }
  }

  private async _rename(from: string, to: string): Promise<void> {
    const worker = this._ensureWorker()
    if (worker) {
      await worker.rename(from, to)
      return
    }
    await fsp.rename(from, to)
  }

  private async _link(from: string, to: string): Promise<void> {
    const worker = this._ensureWorker()
    if (worker) {
      await worker.link(from, to)
      return
    }
    await fsp.link(from, to)
  }

  private async _copyExclusive(from: string, to: string, honorCancellation = true): Promise<void> {
    if (honorCancellation && this._cancelled) throw this._cancelError()
    return await this._disk.copyExclusive(from, to)
  }

  /**
   * Claim the final name with an exclusive create and return the identity of
   * the file object that create produced. The destination stays open, so the
   * caller can journal the identity before any payload byte is written.
   */
  private async _claimExclusiveCopy(target: string): Promise<string> {
    return await this._disk.claimExclusiveCopy(target)
  }

  /** Copy the partial into the destination claimed by `_claimExclusiveCopy`. */
  private async _copyIntoExclusiveClaim(): Promise<void> {
    if (this._cancelled) throw this._cancelError()
    return await this._disk.copyIntoClaim(this.partPath)
  }

  private async _publishNoReplaceForRollback(from: string, to: string): Promise<void> {
    try {
      await this._link(from, to)
      return
    } catch (err) {
      if (isErrnoCode(err, 'EEXIST')) throw err
    }
    await this._copyExclusive(from, to, false)
  }

  /**
   * Atomically claim the terminal outcome for cancellation.
   *
   * JavaScript cannot interleave between this check and setting `_cancelled`,
   * so either cancellation owns the outcome before commitFinalize crosses its
   * synchronous boundary, or the already-started commit keeps ownership.  The
   * caller must never persist `cancel-pending` when this returns commit-owned.
   */
  claimCancellation(): ReceiverCancellationClaim {
    if (this._committing || this._committedPath) return 'commit-owned'
    this._cancelled = true
    return 'cancel-owned'
  }

  /** Prevent a user/stale cancellation from committing a final file. */
  async cancel(): Promise<void> {
    // Commit owns the terminal transition once it starts. Waiting for it is
    // intentional: killing its worker here could leave a published file while
    // the protocol reports cancellation.
    const claim = this.claimCancellation()
    const committing = this._committing
    if (claim === 'commit-owned') {
      if (committing) {
        try { await committing } catch {}
      }
      return
    }

    // Preparation is still cancellable. Terminate first so a blocked local
    // write/sync/hash does not make cancellation depend on that syscall.
    await this._stopWorker('receiver cancelled')
    await this._closeHandle().catch(() => {})
    const preparing = this._preparing
    if (preparing) {
      try { await preparing } catch {}
    }
    const reset = await this._rollbackCommitted()
    if (!reset) throw new EngineError('FINALIZE_UNCERTAIN', 'receiver finalization requires journal recovery')
  }

  /**
   * The backup is retained through the local commit boundary. Once the durable
   * receiver journal says the target was replaced, cleanup is local and may run
   * independently of x-result delivery. The journal still carries enough state
   * for deterministic crash recovery while the finalize transaction is active.
   */
  async commit(): Promise<void> {
    if (this._cancelled) {
      await this._rollbackCommitted()
      throw this._cancelError()
    }
  }

  private async _chooseBackupPath(): Promise<string> {
    // Backup names are local capabilities, never derived from peer-controlled
    // operation identifiers. Randomized siblings also avoid deleting a
    // pre-existing user file merely because its name matches a convention.
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = backupPathFor(this._target)
      if (!(await this._exists(candidate))) return candidate
    }
    throw new EngineError('CONFLICT', 'could not allocate finalize backup path')
  }

  /** Cancellable durability/integrity preparation. No final pathname changes. */
  async prepareFinalize(): Promise<void> {
    if (!this._preparing) this._preparing = this._prepareFinalizeInner()
    await this._preparing
  }

  private async _prepareFinalizeInner(): Promise<void> {
    this._throwIfCancelled()
    await this.sync()
    await this._closeHandle()
    const { hex, size } = await this._hash(this.partPath)
    this._throwIfCancelled()
    if (size !== this._size || hex.toLowerCase() !== this._contentHash.toLowerCase()) {
      const e = new EngineError('INTEGRITY', 'final blake2b-256 mismatch')
      e.digestMismatch = true
      throw e
    }

    // Admission-only preflight. The authoritative overwrite identity check is
    // repeated inside commitFinalize immediately before the namespace change.
    if (this._overwrite) {
      const st = await this._stat(this._target)
      if (this._destFingerprint) {
        if (!st || st.size !== this._destFingerprint.size) {
          throw staleDestError('destination changed after preview')
        }
      } else if (st) {
        throw staleDestError('destination exists but overwrite had no target')
      }
    }
    this._throwIfCancelled()
  }

  /** Irreversible publication phase. Cancellation no longer owns the outcome. */
  async commitFinalize(): Promise<string> {
    if (this._committedPath) return this._committedPath
    await this.prepareFinalize()
    this._throwIfCancelled()
    if (!this._committing) {
      // Authorization is repeated at the last synchronous point before commit
      // ownership becomes irreversible. This closes ACL/root-removal races that
      // occur after the transfer was admitted but before namespace publication.
      this._hooks.authorizeCommit()
      this._committing = this._commitFinalizeInner()
    }
    return await this._committing
  }

  /** Backward-compatible one-shot API used by older callers. */
  async finalize(): Promise<string> {
    await this.prepareFinalize()
    return await this.commitFinalize()
  }

  private async _commitFinalizeInner(): Promise<string> {
    if (this._overwrite) {
      const st = await this._stat(this._target)
      if (this._destFingerprint) {
        if (!st || st.size !== this._destFingerprint.size) {
          throw staleDestError('destination changed before commit')
        }
      } else if (st) {
        throw staleDestError('destination exists but overwrite had no target')
      }

      this._backupPath = st ? await this._chooseBackupPath() : null
      this._publishMode = 'link'
      await this._hooks.phase('prepared', this._target, this._backupPath, this._publishMode)

      if (st && this._backupPath) {
        // rename() captures whichever object is actually at target at the
        // irreversible boundary. Verify that captured object, not a stale stat.
        await this._rename(this._target, this._backupPath)
        try {
          await this._hooks.phase('backup-created', this._target, this._backupPath, this._publishMode)
        } catch (err) {
          const reset = await this._rollbackCommitted()
          if (!reset) throw new EngineError('FINALIZE_UNCERTAIN', 'could not restore overwrite backup after journal failure')
          throw err
        }

        try {
          const backupStat = await this._stat(this._backupPath)
          if (!backupStat || !this._destFingerprint || backupStat.size !== this._destFingerprint.size) {
            throw staleDestError('destination changed at overwrite commit boundary')
          }
          if (this._destFingerprint.blake2b256) {
            const { hex: backupHex } = await this._hash(this._backupPath)
            if (backupHex.toLowerCase() !== this._destFingerprint.blake2b256.toLowerCase()) {
              throw staleDestError('destination content changed at overwrite commit boundary')
            }
          }
        } catch (err) {
          const reset = await this._rollbackCommitted()
          if (!reset) {
            throw new EngineError('FINALIZE_UNCERTAIN', 'destination changed and overwrite backup could not be restored safely')
          }
          throw err
        }
      }

      try {
        return await this._commitPartNoReplace(
          this._target,
          this._backupPath ? 'backup-created' : 'prepared'
        )
      } catch (err) {
        if (isErrnoCode(err, 'FINALIZE_UNCERTAIN')) throw err
        const reset = await this._rollbackCommitted()
        if (!reset) {
          throw new EngineError('FINALIZE_UNCERTAIN', 'a new destination appeared while overwrite commit was in progress')
        }
        if (isErrnoCode(err, 'EEXIST')) throw staleDestError('destination recreated during overwrite commit')
        throw err
      }
    }

    // overwrite=false must claim a name without replacing a concurrent local
    // file. Hard-link is the atomic fast path; exclusive-create copy is the
    // portable fallback for filesystems (for example FAT/exFAT) without links.
    const dir = path.dirname(this._target)
    const ext = path.extname(this._target)
    const base = path.basename(this._target, ext)
    const parts = candidateParts(dir, base, ext)
    try {
      const claimed = await claimFreeName(
        this._target,
        parts,
        path.join,
        async (candidate) => {
          this._publishMode = 'link'
          await this._hooks.phase('prepared', candidate, null, this._publishMode)
          await this._commitPartNoReplace(candidate, 'prepared')
        },
        (err) => isErrnoCode(err, 'EEXIST')
      )
      return claimed.candidate
    } catch (err) {
      if (err instanceof NameCollisionExhaustedError) {
        throw new EngineError('CONFLICT', 'name collision exhausted')
      }
      throw err
    }
  }

  /**
   * Identity of the private partial. A hard link makes the target name the very
   * same file object, so this string proves the final pathname is ours even
   * after a crash. Captured before the link so recovery never has to guess.
   */
  private async _partIdentity(): Promise<string | null> {
    const st = await this._stat(this.partPath)
    if (!st) return null
    return statIdentity(st)
  }

  private async _commitPartNoReplace(
    target: string,
    preCommitPhase: 'prepared' | 'backup-created'
  ): Promise<string> {
    let destinationIdentity: string | null = null
    try {
      // A hard link is the atomic fast path: the target names the same file
      // object as the partial, so the partial's identity is also the
      // destination identity. Record it before the namespace changes.
      destinationIdentity = await this._partIdentity()
      await this._link(this.partPath, target)
      this._publishMode = 'link'
    } catch (err) {
      if (isErrnoCode(err, 'EEXIST')) throw err

      // Portable no-clobber fallback for filesystems without hard links. The
      // destination identity is only knowable after the exclusive create, so
      // the create and the copy are split: claim the name, journal the
      // identity, and only then write the first byte.
      this._publishMode = 'copy-exclusive'
      await this._hooks.phase(preCommitPhase, target, this._backupPath, this._publishMode, null)
      this._copyInFlightTarget = target
      try {
        const claimed = await this._claimExclusiveCopy(target)
        destinationIdentity = claimed
        // Persist ownership before any payload byte reaches the final name.
        await this._hooks.phase(preCommitPhase, target, this._backupPath, this._publishMode, destinationIdentity)
        await this._copyIntoExclusiveClaim()
        this._copyInFlightTarget = null
      } catch (copyErr) {
        if (isErrnoCode(copyErr, 'EEXIST')) {
          this._copyInFlightTarget = null
          throw copyErr
        }
        if (isErrnoCode(copyErr, 'IO_WORKER_EXIT', 'IO_TIMEOUT', 'CANCELLED', 'IO_WORKER')) {
          throw new EngineError(
            'FINALIZE_UNCERTAIN',
            'exclusive publication was interrupted; journal recovery must determine target ownership'
          )
        }
        // A live worker/local copy removes a destination it created before
        // reporting an ordinary error, so retry/resume is safe.
        this._copyInFlightTarget = null
        throw copyErr
      }
    }

    this._committedPath = target
    try {
      await this._hooks.phase('target-replaced', target, this._backupPath, this._publishMode, destinationIdentity)
    } catch (err) {
      const reset = await this._rollbackCommitted()
      if (!reset) {
        throw new EngineError('FINALIZE_UNCERTAIN', 'published target could not be rolled back after journal failure')
      }
      throw err
    }

    // Keep the source partial until target-replaced is durable. With hard-link
    // both names reference the same inode; with copy fallback the private part
    // is the recovery source until this checkpoint has committed.
    await this._unlink(this.partPath, true).catch(() => {})
    await this._stopWorker('receiver finalize committed')
    return target
  }

  private async _rollbackCommitted(): Promise<boolean> {
    // A killed worker may have created and partially populated this pathname.
    // Do not guess whether it belongs to us; leave the durable journal for
    // startup recovery to hash and reconcile it.
    if (this._copyInFlightTarget) return false

    let safeToReset = true
    const committed = this._committedPath
    this._committedPath = null
    if (committed && await this._exists(committed)) {
      try {
        if (await this._exists(this.partPath)) {
          await this._unlink(committed, false)
        } else {
          await this._publishNoReplaceForRollback(committed, this.partPath)
          await this._unlink(committed, false)
        }
      } catch {
        safeToReset = false
      }
    }

    const backup = this._backupPath
    if (backup && await this._exists(backup)) {
      try {
        // No-clobber restore: if any local process recreated target, do not
        // destroy it. Preserve backup + journal for explicit recovery.
        await this._publishNoReplaceForRollback(backup, this._target)
        await this._unlink(backup, false)
        this._backupPath = null
      } catch {
        safeToReset = false
      }
    } else if (backup) {
      this._backupPath = null
    }

    if (safeToReset) await this._hooks.reset().catch(() => {})
    return safeToReset
  }

  /** Transport failure: keep `.part` (section 8 preserve). */
  async abort(): Promise<void> {
    await this._stopWorker('receiver aborted')
    await this._closeHandle().catch(() => {})
  }
}

// ---------------- engine ----------------
interface GateWaiter {
  resolve: () => void
  reject: (err: Error) => void
}

interface Preview {
  expiresAtMs: number
  source: EndpointRef & { deviceIdN: string }
  destination: EndpointRef & { deviceIdN: string }
  sourceScanId: string | null
  items: Array<{
    relativePath: string
    status: 'new' | 'changed' | 'skipped' | 'remote-only' | 'conflict' | 'error'
    sourceSize: number | null
    sourceHash: string | null
    destFingerprint?: DestFingerprint | null
  }>
}

export class FsEngine {
  myId: string
  private _snapshots = new Map<string, StoredSnapshot>()
  private _activeScans = new Map<string, {
    cancelToken: { cancelled: boolean }
    rootId: string
    /** Authenticated requester for wire-owned local scans; null means local UI/client ownership. */
    peerId: string | null
    remote?: { session: PeerSession; scanId: string }
  }>()
  private _lists: ListRegistry
  private _manifestHashCache: ManifestHashCache
  private _disk: DiskAdapter
  private _previews = new Map<string, Preview>()
  private _previewBuildInProgress = false
  private _transientSnapshotPins = new Set<string>()
  private _receive = new Map<string, { session: ReceiverSession; writer: ReceiverWriter; done: Promise<string> }>()
  private _serving = new Map<string, { session: SenderSession; done: Promise<string> }>()
  /** Serialize wire-side operation creation before a durable journal row exists. */
  private _openingOperations = new Set<string>()
  private _openingOperationRoots = new Map<string, Set<string>>()
  private _quiescedRoots = new Map<string, number>()
  private _peerTransferGates = new Map<string, { active: number; waiters: GateWaiter[] }>()
  private _destinationLocks = new Map<string, { active: boolean; waiters: GateWaiter[] }>()
  private _drivingOperations = new Set<string>()
  private _launchQueues = new Map<string, { ids: string[]; head: number }>()
  private _launchQueued = new Set<string>()
  private _launchActiveByPeer = new Map<string, number>()
  /** Short backoff for transient peer-side admission races (for example the
   *  next file arriving just before the previous transfer releases its slot). */
  private _launchRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private _launchRetryAttempts = new Map<string, number>()
  private _serveLocks = new Map<string, Promise<void>>()
  private _resultDeliveries = new Map<string, Promise<boolean>>()
  /** Single-flight terminal settlement: Drive ACK and x-result may race. */
  private _senderSuccessSettles = new Map<string, Promise<void>>()
  private _resultRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private _peerReplacementRecoveries = new Map<string, Promise<void>>()
  private _cancelledOperations = new Map<string, { peerId: string; expiresAtMs: number }>()
  /** In-flight `x-resume.prepare` source re-verifications, keyed by operationId. */
  private _resumeVerifications = new Map<string, ResumeVerification>()
  private _cacheSweeper: ReturnType<typeof setTimeout> | null = null
  private _destroyed = false
  private _sessionOf: (peerId: string) => PeerSession | null
  private _emit: (event: string, payload: unknown) => void

  constructor(
    private deps: {
      getMyId: () => string
      roots: RootsManager
      journals: JournalStore
      peers: PeerManager
      emit: (event: string, payload: unknown) => void
      hashCachePath?: string | null
    }
  ) {
    this.myId = deps.getMyId().toLowerCase()
    this._emit = (event: string, payload: unknown) => {
      if ((event === 'operation.state' || event === 'operation.progress') && isRecord(payload)) {
        const operationId = typeof payload.operationId === 'string' ? payload.operationId : ''
        const batchId = operationId ? deps.journals.batchIdForOperation(operationId) : null
        if (batchId) {
          deps.emit(event, { ...payload, batchId })
          return
        }
      }
      deps.emit(event, payload)
    }
    this._sessionOf = (id: string) => deps.peers.session(id)
    const hashCachePath = deps.hashCachePath ?? null
    const disk = createDiskAdapter(hashCachePath)
    this._disk = disk.adapter
    this._manifestHashCache = disk.hashCache
    this._lists = new ListRegistry(
      async (root, rel, sort) => await this._disk.listAll(root, rel, sort ?? null)
    )
    this._scheduleCacheSweep()
  }

  private async _rootStatPath(root: string, rel: string, cancelled?: () => boolean): Promise<ListEntry | null> {
    return await this._disk.statPath(root, rel, cancelled)
  }

  private async _rootStatPaths(
    root: string,
    rels: string[],
    cancelled?: () => boolean
  ): Promise<Array<{ entry?: ListEntry; error?: { code: string; message: string } }>> {
    return await this._disk.statPaths(root, rels, cancelled)
  }

  private async _rootStableHash(root: string, rel: string, cancelled?: () => boolean) {
    return await this._disk.stableHash(root, rel, cancelled)
  }

  private async _rootManifest(
    root: string,
    rel: string,
    filter: FilterSpec | null,
    scanId: string,
    cancelToken: { cancelled: boolean },
    onProgress?: (filesDone: number, bytesDone: number) => void,
    maxEntries: number = MANIFEST_MAX_ENTRIES
  ): Promise<ScanSnapshot> {
    return await this._disk.manifest(root, rel, filter, scanId, cancelToken, onProgress, maxEntries)
  }

  private async _rootStatFile(pathname: string, cancelled?: () => boolean): Promise<FileStat | null> {
    return await this._disk.statFile(pathname, cancelled)
  }

  private async _rootPreparePut(root: string, rel: string, cancelled?: () => boolean): Promise<string> {
    return await this._disk.preparePut(root, rel, cancelled)
  }

  private async _rootHashAbsolute(pathname: string, cancelled?: () => boolean): Promise<{ hex: string; size: number }> {
    return await this._disk.hashAbsolute(pathname, cancelled)
  }

  private async _rootUnlink(pathname: string, ignoreMissing = true): Promise<void> {
    return await this._disk.unlink(pathname, ignoreMissing)
  }

  private async _rootRename(from: string, to: string): Promise<void> {
    return await this._disk.rename(from, to)
  }

  private async _rootLink(from: string, to: string): Promise<void> {
    return await this._disk.link(from, to)
  }

  private async _rootCopyExclusive(from: string, to: string): Promise<void> {
    return await this._disk.copyExclusive(from, to)
  }

  private async _rootPublishNoReplace(from: string, to: string): Promise<void> {
    try {
      await this._rootLink(from, to)
      return
    } catch (err) {
      if (isErrnoCode(err, 'EEXIST')) throw err
    }
    await this._rootCopyExclusive(from, to)
  }

  private async _rootChmod(pathname: string, mode: number): Promise<void> {
    return await this._disk.chmod(pathname, mode)
  }

  private async _withServeLock<T>(operationId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this._serveLocks.get(operationId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => current)
    this._serveLocks.set(operationId, tail)
    await previous
    try {
      return await fn()
    } finally {
      release()
      if (this._serveLocks.get(operationId) === tail) this._serveLocks.delete(operationId)
    }
  }

  private _snapshotPinned(scanId: string): boolean {
    if (this._transientSnapshotPins.has(scanId)) return true
    for (const preview of this._previews.values()) {
      if (preview.sourceScanId === scanId) return true
    }
    return false
  }

  private _dropPreview(previewId: string): void {
    const preview = this._previews.get(previewId)
    if (!preview) return
    this._previews.delete(previewId)
    if (preview.sourceScanId) this.manifestCancel(preview.sourceScanId)
  }

  private _storeSnapshot(snapshot: StoredSnapshot): void {
    const incomingItems = snapshot.items.length
    let totalItems = incomingItems
    for (const existing of this._snapshots.values()) totalItems += existing.items.length

    const remoteOwner = snapshot.kind === 'local' && snapshot.peerId
      ? snapshot.peerId.toLowerCase()
      : null

    const sameRemoteOwner = (existing: StoredSnapshot): boolean =>
      remoteOwner !== null &&
      existing.kind === 'local' &&
      existing.peerId?.toLowerCase() === remoteOwner

    const evictOne = (sameOwnerOnly = false): boolean => {
      for (const [id, existing] of this._snapshots) {
        if (this._snapshotPinned(id)) continue
        if (sameOwnerOnly && !sameRemoteOwner(existing)) continue
        this._snapshots.delete(id)
        if (existing.cancelToken) existing.cancelToken.cancelled = true
        totalItems -= existing.items.length
        return true
      }
      return false
    }

    if (remoteOwner) {
      const ownerUsage = () => {
        let snapshots = 0
        let items = incomingItems
        for (const existing of this._snapshots.values()) {
          if (!sameRemoteOwner(existing)) continue
          snapshots++
          items += existing.items.length
        }
        return { snapshots, items }
      }
      for (;;) {
        const usage = ownerUsage()
        if (
          usage.snapshots < MANIFEST_CACHE_REMOTE_MAX_SNAPSHOTS_PER_PEER &&
          usage.items <= MANIFEST_CACHE_REMOTE_MAX_ITEMS_PER_PEER
        ) break
        if (!evictOne(true)) {
          throw new EngineError('LIMIT_EXCEEDED', 'peer manifest cache quota is full')
        }
      }
    }

    while (this._snapshots.size >= MANIFEST_CACHE_MAX_SNAPSHOTS || totalItems > MANIFEST_CACHE_MAX_ITEMS) {
      // A wire peer may replace only its own snapshots. It must never evict
      // another peer's or the local UI's state from the shared cache.
      if (!evictOne(remoteOwner !== null)) {
        throw new EngineError('LIMIT_EXCEEDED', 'manifest cache is full; finish or cancel an existing preview')
      }
    }
    this._snapshots.set(snapshot.scanId, snapshot)
  }

  private _storePreview(previewId: string, preview: Preview): void {
    while (this._previews.size >= PREVIEW_CACHE_MAX) {
      const oldest = this._previews.keys().next().value
      if (typeof oldest !== 'string') break
      this._dropPreview(oldest)
    }
    this._previews.set(previewId, preview)
  }

  private _scheduleCacheSweep(): void {
    if (this._destroyed || this._cacheSweeper) return
    this._cacheSweeper = setTimeout(() => {
      this._cacheSweeper = null
      if (this._destroyed) return
      this._sweepCaches()
      this._scheduleCacheSweep()
    }, 30_000)
    const anyT = this._cacheSweeper as unknown as { unref?: () => void }
    if (typeof anyT.unref === 'function') anyT.unref()
  }

  private _sweepCaches(): void {
    const t = Date.now()
    this._lists.sweep()
    void this.deps.journals.pruneStale().catch(() => {})
    for (const [id, snap] of this._snapshots) {
      if (snap.expiresAtMs < t || snap.hardExpiresAtMs < t) this.manifestCancel(id)
    }
    for (const [id, preview] of this._previews) {
      if (preview.expiresAtMs < t) this._dropPreview(id)
    }
    for (const [operationId, tombstone] of this._cancelledOperations) {
      if (tombstone.expiresAtMs <= t) this._cancelledOperations.delete(operationId)
    }
  }

  private _rememberCancelled(operationId: string, peerId: string): void {
    const key = operationId
    this._cancelledOperations.delete(key)
    this._cancelledOperations.set(key, {
      peerId: peerId.toLowerCase(),
      expiresAtMs: Date.now() + CANCEL_TOMBSTONE_TTL_MS
    })
    while (this._cancelledOperations.size > CANCEL_TOMBSTONE_MAX) {
      const oldest = this._cancelledOperations.keys().next().value
      if (typeof oldest !== 'string') break
      this._cancelledOperations.delete(oldest)
    }
  }

  private _forgetCancelled(operationId: string): void {
    this._cancelledOperations.delete(operationId)
  }

  /**
   * A receiver that has entered commit owns the terminal outcome.  When a
   * pending sender-side cancellation learns that fact, restore the sender
   * journal to a success-capable state and treat remote commit ownership as
   * proof that the receiver already consumed the complete byte stream.
   */
  private async _markRemoteCommitOwned(operationId: string): Promise<void> {
    this._forgetCancelled(operationId)
    await this.deps.journals.update(operationId, (r) => {
      if (r.role !== 'sender') return
      const f = r.files[0]
      if (r.state !== 'stale' && r.state !== 'done') r.state = 'active'
      if (f.state !== 'stale' && f.state !== 'done') f.state = 'active'
      f.senderTransferComplete = true
      f.error = null
      r.error = null
    }, true)
    const current = this.deps.journals.get(operationId)
    const pending = current?.role === 'sender' ? current.files[0]?.pendingSuccessResult : null
    if (pending) await this._settleSenderSuccess(operationId, pending.savedToBase)
  }

  private _operationIsCancelled(operationId: string, peerId?: string): boolean {
    const tombstone = this._cancelledOperations.get(operationId)
    if (!tombstone) return false
    if (tombstone.expiresAtMs <= Date.now()) {
      this._cancelledOperations.delete(operationId)
      return false
    }
    return !peerId || tombstone.peerId === peerId.toLowerCase()
  }

  private _throwIfOperationCancelled(operationId: string, peerId: string): void {
    if (this._destroyed) throw new EngineError('CANCELLED', 'engine destroyed')
    if (this._operationIsCancelled(operationId, peerId)) throw new EngineError('CANCELLED', 'operation cancelled')
    const row = this.deps.journals.get(operationId)
    if (row?.state === 'cancel-pending') throw new EngineError('CANCELLED', 'operation cancelled')
  }

  async destroy(): Promise<void> {
    if (this._destroyed) return
    this._destroyed = true
    if (this._cacheSweeper) clearTimeout(this._cacheSweeper)
    this._cacheSweeper = null
    for (const timer of this._resultRetryTimers.values()) clearTimeout(timer)
    this._resultRetryTimers.clear()
    for (const timer of this._launchRetryTimers.values()) clearTimeout(timer)
    this._launchRetryTimers.clear()
    this._launchRetryAttempts.clear()
    this._cancelledOperations.clear()
    this._resumeVerifications.clear()
    for (const id of [...this._activeScans.keys()]) this.manifestCancel(id)
    for (const id of [...this._snapshots.keys()]) this.manifestCancel(id)

    const stopped = new Set([...this._receive.keys(), ...this._serving.keys()])
    await Promise.allSettled([...stopped].map((id) => this._stopLiveOperation(id, 'Engine shutdown')))

    const shutdownError = new EngineError('CANCELLED', 'engine destroyed')
    for (const gate of this._destinationLocks.values()) {
      for (const waiter of gate.waiters.splice(0)) waiter.reject(shutdownError)
    }
    this._destinationLocks.clear()
    for (const gate of this._peerTransferGates.values()) {
      for (const waiter of gate.waiters.splice(0)) waiter.reject(shutdownError)
    }
    this._peerTransferGates.clear()
    this._openingOperations.clear()
    this._openingOperationRoots.clear()
    this._quiescedRoots.clear()
    this._launchQueues.clear()
    this._launchQueued.clear()
    this._launchActiveByPeer.clear()

    this._lists.clear()
    await this._disk.dispose().catch(() => {})
    this._previews.clear()
    this._transientSnapshotPins.clear()
    await this._manifestHashCache.flush()
  }

  private _dropReceiver(operationId: string, expected?: ReceiverSession): void {
    const live = this._receive.get(operationId)
    if (!live) return
    if (!expected || live.session === expected) this._receive.delete(operationId)
  }

  private _dropServing(operationId: string, expected?: SenderSession): void {
    const live = this._serving.get(operationId)
    if (!live) return
    if (!expected || live.session === expected) this._serving.delete(operationId)
  }

  private async _stopLiveOperation(operationId: string, reason: string): Promise<void> {
    const receive = this._receive.get(operationId)
    const serving = this._serving.get(operationId)
    try {
      if (receive) {
        receive.session.cancel(reason)
        await receive.writer.cancel()
        await receive.done.catch(() => {})
      }
      if (serving) {
        serving.session.cancel(reason)
        await serving.done.catch(() => {})
        await serving.session.close().catch(() => {})
      }
    } finally {
      // Ownership ends only after the corresponding live resource has stopped.
      // Identity-aware drops cannot delete a replacement session installed by a
      // concurrent reconnect/resume.
      if (receive) this._dropReceiver(operationId, receive.session)
      if (serving) this._dropServing(operationId, serving.session)
    }
  }

  private _cancelRootManifests(rootId: string, peerId: string | null = null): void {
    const owner = peerId ? peerId.toLowerCase() : null
    for (const [scanId, active] of [...this._activeScans]) {
      if (active.rootId !== rootId) continue
      if (owner && active.peerId !== owner) continue
      this.manifestCancel(scanId)
    }
    for (const [scanId, snap] of [...this._snapshots]) {
      if (snap.rootId !== rootId) continue
      if (owner && !(snap.kind === 'local' && snap.peerId === owner)) continue
      this.manifestCancel(scanId)
    }
  }

  /**
   * Stop data-plane ownership that was admitted under an older root ACL.
   * The ACL mutation must be durable before this is called, so commit-time
   * authorization sees the new policy while this barrier waits for any commit
   * that crossed the irreversible boundary immediately before the mutation.
   */
  async revokeRootAccess(
    rootId: string,
    options: { peerId?: string | null; read?: boolean; write?: boolean; removed?: boolean }
  ): Promise<void> {
    const peerId = options.peerId ? options.peerId.toLowerCase() : null
    if (options.removed || options.read) this._cancelRootManifests(rootId, peerId)

    const liveIds = new Set([...this._receive.keys(), ...this._serving.keys()])
    const stop: string[] = []
    for (const operationId of liveIds) {
      const row = this.deps.journals.get(operationId)
      if (!row) continue
      if (peerId && row.peerId.toLowerCase() !== peerId) continue
      const descriptor = row.descriptor as OperationDescriptor
      const sourceMatch = descriptor?.source?.rootId === rootId
      const destinationMatch = descriptor?.destination?.rootId === rootId
      const affected = options.removed ||
        (options.read === true && sourceMatch) ||
        (options.write === true && destinationMatch)
      if (affected) stop.push(operationId)
    }
    await Promise.all(stop.map((operationId) =>
      this._stopLiveOperation(operationId, options.removed ? 'Root removed' : 'Root permission revoked')
    ))
  }

  /** Prevent new root users, drain setup code, then stop all live owners. */
  async quiesceRoot(rootId: string): Promise<void> {
    this._quiescedRoots.set(rootId, (this._quiescedRoots.get(rootId) ?? 0) + 1)
    try {
      const deadline = Date.now() + 30_000
      for (;;) {
        let opening = false
        for (const roots of this._openingOperationRoots.values()) {
          if (roots.has(rootId)) {
            opening = true
            break
          }
        }
        if (!opening) break
        if (Date.now() >= deadline) throw new EngineError('BUSY', 'root operations did not quiesce')
        await new Promise<void>((resolve) => setTimeout(resolve, 25))
      }
      this._cancelRootManifests(rootId)
      await this.revokeRootAccess(rootId, { removed: true })
    } catch (err) {
      this.releaseRootQuiesce(rootId)
      throw err
    }
  }

  releaseRootQuiesce(rootId: string): void {
    const count = this._quiescedRoots.get(rootId) ?? 0
    if (count <= 1) this._quiescedRoots.delete(rootId)
    else this._quiescedRoots.set(rootId, count - 1)
  }

  /**
   * A replacement peer socket is published before the old socket is destroyed
   * so presence never flickers offline. That means the normal online edge can
   * occur while old Receiver/SenderSession objects are still registered. Run a
   * second, serialized recovery edge after transport teardown: settle any live
   * machines for this peer, remove their live-map entries, then resume from the
   * durable journal against the replacement session.
   */
  async recoverAfterPeerSessionReplacement(peerId: string): Promise<void> {
    const id = peerId.toLowerCase()
    const previous = this._peerReplacementRecoveries.get(id) ?? Promise.resolve()
    const run = previous.catch(() => {}).then(async () => {
      if (this._destroyed) return
      const live = new Set<string>()
      for (const operationId of this._receive.keys()) {
        if (this.deps.journals.get(operationId)?.peerId === id) live.add(operationId)
      }
      for (const operationId of this._serving.keys()) {
        if (this.deps.journals.get(operationId)?.peerId === id) live.add(operationId)
      }
      await Promise.allSettled([...live].map((operationId) =>
        this._stopLiveOperation(operationId, 'Peer session replaced')
      ))
      for (const operationId of live) {
        this._dropReceiver(operationId)
        this._dropServing(operationId)
      }
      if (!this._destroyed && this._sessionOf(id)) await this.resumeAll(id)
    })
    this._peerReplacementRecoveries.set(id, run)
    try {
      await run
    } finally {
      if (this._peerReplacementRecoveries.get(id) === run) this._peerReplacementRecoveries.delete(id)
    }
  }

  async browseRoots(peerId: string | null): Promise<{ roots: Array<{ rootId: string; name: string; perms: { read: boolean; write: boolean } }> }> {
    if (!peerId) return { roots: [] }
    const result = await this._req<{ roots?: Array<{ rootId: string; name: string; perms: { read: boolean; write: boolean } }> }>(
      this._session(peerId),
      'roots',
      {},
      30_000
    )
    return { roots: Array.isArray(result.roots) ? result.roots : [] }
  }

  // ---------- root helpers ----------
  private _rootOrThrow(rootId: string, perm: 'read' | 'write', remotePeerId: string | null = null): RootInfo {
    if (this._quiescedRoots.has(rootId)) throw new EngineError('NOT_ALLOWED', 'root is being removed')
    const r = this.deps.roots.get(rootId)
    if (!r) throw new EngineError('NOT_ALLOWED', 'root not registered')
    if (remotePeerId) {
      if (!this.deps.roots.canPeer(rootId, remotePeerId, perm)) {
        throw new EngineError('NOT_ALLOWED', `root ${perm} denied`)
      }
    } else if (perm === 'read' && !r.perms.read) {
      throw new EngineError('NOT_ALLOWED', 'root read denied')
    }
    // Local-owner writes are authorized by the shell action + registered root;
    // the per-peer ACL is only for requests arriving from the wire.
    return r
  }

  private _session(peerId: string): PeerSession {
    const s = peerId ? this._sessionOf(peerId) : null
    if (!s) throw new EngineError('OFFLINE', 'peer offline')
    return s
  }

  private async _req<T = unknown>(session: PeerSession, method: string, payload: unknown, timeout = 300_000): Promise<T> {
    const res = await session.fs.request(method, payload, timeout)
    if (!res.ok) {
      // Operation-level timeout must not tear down the whole peer transport.
      // Recovery failures are handled by the transfer state machine; the peer
      // session remains usable for other operations and later retries. The
      // scope tag is what the recovery classifier reads to keep the socket.
      const err = new EngineError(res.error ?? 'IO', res.message ?? '')
      err.scope = 'OPERATION'
      throw err
    }
    return res.result as T
  }

  // ---------- reads (local + remote through one abstraction) ----------
  async list(ref: EndpointRef & { deviceId?: string }, cursor: string | null, sort?: ListSortSpec | null, requestCancelToken?: RequestCancelToken): Promise<{
    entries: unknown[]
    nextCursor: string | null
    previousCursor: string | null
    offset: number
    totalEntries: number
  }> {
    if (!ref.peerId) return this._listLocal(ref.rootId, ref.relativePath, cursor, null, sort, requestCancelToken)
    const result = await this._req<unknown>(this._session(ref.peerId), 'fs.list', {
      rootId: ref.rootId,
      relativePath: ref.relativePath ?? '',
      cursor,
      sort: sort ?? null
    })
    return parseRemoteListResponse(result)
  }
  async _listLocal(
    rootId: string,
    rel: string,
    cursor: string | null,
    remotePeerId: string | null = null,
    sort?: ListSortSpec | null,
    requestCancelToken?: RequestCancelToken
  ) {
    const root = this._rootOrThrow(rootId, 'read', remotePeerId)
    const page = await this._lists.page(root.physicalPath, rel ?? '', cursor, sort, () => requestCancelToken?.cancelled === true)
    return {
      entries: page.items,
      nextCursor: page.nextCursor,
      previousCursor: page.previousCursor,
      offset: page.offset,
      totalEntries: page.totalEntries
    }
  }
  async stat(ref: EndpointRef): Promise<{ entry: ListEntry }> {
    if (!ref.peerId) {
      const root = this._rootOrThrow(ref.rootId, 'read')
      const e = await this._rootStatPath(root.physicalPath, ref.relativePath ?? '')
      if (!e) throw new EngineError('NOT_FOUND', 'stat: missing')
      return { entry: e }
    }
    const result = await this._req<unknown>(this._session(ref.peerId), 'fs.stat', { rootId: ref.rootId, relativePath: ref.relativePath ?? '' })
    return parseRemoteStatResponse(result)
  }

  async statBatch(refs: EndpointRef[]): Promise<{ results: Array<{ entry?: ListEntry; error?: { code: string; message: string } }> }> {
    if (!Array.isArray(refs) || refs.length > 512) throw new EngineError('INVALID_REQUEST', 'fs.statBatch supports at most 512 targets')
    if (refs.length === 0) return { results: [] }
    const first = refs[0]
    const homogeneous = refs.every((ref) => ref.peerId === first.peerId && ref.rootId === first.rootId)
    if (!homogeneous) {
      const results: Array<{ entry?: ListEntry; error?: { code: string; message: string } }> = []
      for (const ref of refs) {
        try {
          results.push(await this.stat(ref))
        } catch (err) {
          results.push({ error: { code: errorCode(err) ?? 'IO', message: errorMessage(err) } })
        }
      }
      return { results }
    }

    if (!first.peerId) {
      const root = this._rootOrThrow(first.rootId, 'read')
      return {
        results: await this._rootStatPaths(
          root.physicalPath,
          refs.map((ref) => ref.relativePath ?? '')
        )
      }
    }

    const session = this._session(first.peerId)
    const results: Array<{ entry?: ListEntry; error?: { code: string; message: string } }> = []
    // The public API still accepts 512 targets, but one worst-case 512-path JSON
    // frame can exceed fs.v1's 900 KiB transport cap. Split only at the wire
    // boundary so callers keep the same API and ordering semantics.
    for (let offset = 0; offset < refs.length; offset += STAT_BATCH_WIRE_TARGETS) {
      const slice = refs.slice(offset, offset + STAT_BATCH_WIRE_TARGETS)
      const result = await this._req<unknown>(session, 'fs.statBatch', {
        rootId: first.rootId,
        relativePaths: slice.map((ref) => ref.relativePath ?? '')
      })
      const parsed = parseRemoteStatBatchResponse(result)
      if (parsed.length !== slice.length) {
        throw new EngineError('INVALID_REQUEST', 'remote stat batch result count mismatch')
      }
      results.push(...parsed)
    }
    return { results }
  }

  async manifestStart(
    ref: EndpointRef & { peerId?: string | null },
    filter?: FilterSpec | null,
    remotePeerId: string | null = null,
    onProgress?: (filesDone: number, bytesDone: number) => void,
    scanIdHint?: string,
    requestCancelToken?: RequestCancelToken,
    maxEntries: number = MANIFEST_MAX_ENTRIES
  ): Promise<StoredSnapshot> {
    const localScanId = scanIdHint && scanIdHint.length <= ID_MAX_LEN ? scanIdHint : uuidv4()
    if (this._activeScans.has(localScanId) || this._snapshots.has(localScanId)) {
      throw new EngineError('CONFLICT', 'manifest scanId is already in use')
    }
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MANIFEST_MAX_ENTRIES) {
      throw new EngineError('INVALID_REQUEST', 'invalid manifest maxEntries')
    }
    // Scan lifecycle and outer RPC cancellation have different owners. The
    // manifest may be discarded after a successful scan without cancelling the
    // copy/sync request that asked for it.
    const scanCancelToken = { cancelled: false }
    const cancelToken: { cancelled: boolean } = {
      get cancelled() {
        return scanCancelToken.cancelled || requestCancelToken?.cancelled === true
      },
      set cancelled(value: boolean) {
        scanCancelToken.cancelled = value
      }
    }

    if (!ref.peerId) {
      const root = this._rootOrThrow(ref.rootId, 'read', remotePeerId)
      const ownerPeerId = remotePeerId ? remotePeerId.toLowerCase() : null
      this._activeScans.set(localScanId, { cancelToken, rootId: ref.rootId, peerId: ownerPeerId })
      try {
        const snap = await this._rootManifest(
          root.physicalPath,
          ref.relativePath ?? '',
          filter ?? null,
          localScanId,
          cancelToken,
          onProgress,
          maxEntries
        )
        if (cancelToken.cancelled) throw new EngineError('STALE_SCAN', 'manifest cancelled')
        this._rootOrThrow(ref.rootId, 'read', remotePeerId)
        const stored: StoredSnapshot = { ...snap, kind: 'local', peerId: ownerPeerId, rootId: ref.rootId, cancelToken }
        this._storeSnapshot(stored)
        return stored
      } finally {
        this._activeScans.delete(localScanId)
      }
    }

    const session = this._session(ref.peerId)
    const remoteScanId = uuidv4()
    this._activeScans.set(localScanId, {
      cancelToken,
      rootId: ref.rootId,
      peerId: null,
      remote: { session, scanId: remoteScanId }
    })
    try {
      const begin = await this._req<{
        scanId: string
        fileCount: number
        totalBytes: number
        entriesDigest: string
        expiresAtMs: number
      }>(session, 'fs.manifest', {
        action: 'start',
        scanId: remoteScanId,
        rootId: ref.rootId,
        relativePath: ref.relativePath ?? '',
        filter: filter ?? null,
        maxEntries
      }, SCAN_TTL_MS + 60_000)
      if (cancelToken.cancelled) throw new EngineError('STALE_SCAN', 'manifest cancelled')
      if (typeof begin.scanId !== 'string' || begin.scanId.length === 0 || begin.scanId.length > ID_MAX_LEN) {
        throw new EngineError('INVALID_REQUEST', 'invalid remote manifest id')
      }
      if (!Number.isSafeInteger(begin.fileCount) || begin.fileCount < 0 || begin.fileCount > maxEntries) {
        throw new EngineError('INVALID_REQUEST', 'invalid remote manifest fileCount')
      }
      if (!Number.isSafeInteger(begin.totalBytes) || begin.totalBytes < 0) {
        throw new EngineError('INVALID_REQUEST', 'invalid remote manifest totalBytes')
      }
      if (typeof begin.entriesDigest !== 'string' || !HEX64_RE.test(begin.entriesDigest)) {
        throw new EngineError('INVALID_REQUEST', 'invalid remote manifest digest')
      }
      const items: ManifestItem[] = []
      const seenPathKeys = new Set<string>()
      let cursor: string | null = null
      const seenCursors = new Set<string>()
      let pageCount = 0
      const maxPageCount = Math.ceil(maxEntries / MANIFEST_PAGE_SIZE) + 1
      let bytesDone = 0
      let previousPath: string | null = null
      for (;;) {
        if (cancelToken.cancelled) throw new EngineError('STALE_SCAN', 'manifest cancelled')
        const rawPage: unknown = await this._req<unknown>(
          session, 'fs.manifest', { action: 'page', scanId: begin.scanId, cursor }, 120_000
        )
        if (!isRecord(rawPage) || !Array.isArray(rawPage.items)) {
          throw new EngineError('INVALID_REQUEST', 'invalid remote manifest page')
        }
        const pageItems: ManifestItem[] = rawPage.items.map((candidate: unknown) => {
          if (!isRecord(candidate)) throw new EngineError('INVALID_REQUEST', 'invalid remote manifest item')
          const relativePath = validateRelativePath(candidate.relativePath, { allowEmpty: false, field: 'manifest.relativePath' })
          const size = Number(candidate.size)
          const mtimeMs = Number(candidate.mtimeMs)
          const contentHash = typeof candidate.contentHash === 'string' ? candidate.contentHash.toLowerCase() : ''
          if (!Number.isSafeInteger(size) || size < 0 || size > MAX_TRANSFER_SIZE_BYTES) {
            throw new EngineError('INVALID_REQUEST', 'invalid remote manifest item size')
          }
          if (!Number.isFinite(mtimeMs) || mtimeMs < 0 || !HEX64_RE.test(contentHash)) {
            throw new EngineError('INVALID_REQUEST', 'invalid remote manifest item metadata')
          }
          const pathKey = relativePath.toLowerCase()
          if (seenPathKeys.has(pathKey)) {
            throw new EngineError('INVALID_REQUEST', 'duplicate or case-colliding remote manifest path')
          }
          seenPathKeys.add(pathKey)
          return { relativePath, size, mtimeMs, contentHash }
        })
        for (const item of pageItems) {
          if (previousPath !== null && comparePortablePaths(previousPath, item.relativePath) >= 0) {
            throw new EngineError('INVALID_REQUEST', 'remote manifest is not canonically sorted')
          }
          previousPath = item.relativePath
        }
        pageCount++
        if (pageItems.length > MANIFEST_PAGE_SIZE || pageCount > maxPageCount) {
          throw new EngineError('LIMIT_EXCEEDED', 'remote manifest pagination exceeded protocol limits')
        }
        const rawNext: unknown = rawPage.nextCursor
        if (rawNext !== null && rawNext !== undefined && (typeof rawNext !== 'string' || rawNext.length === 0 || rawNext.length > ID_MAX_LEN)) {
          throw new EngineError('INVALID_REQUEST', 'invalid remote manifest cursor')
        }
        const nextCursor: string | null = typeof rawNext === 'string' ? rawNext : null
        if (nextCursor && pageItems.length === 0) throw new EngineError('STALE_SCAN', 'remote manifest page made no progress')
        items.push(...pageItems)
        bytesDone += pageItems.reduce((sum, item) => sum + (item.size || 0), 0)
        if (items.length > maxEntries) throw new EngineError('LIMIT_EXCEEDED', 'manifest too large')
        onProgress?.(items.length, bytesDone)
        if (!nextCursor) break
        if (seenCursors.has(nextCursor)) throw new EngineError('STALE_SCAN', 'remote manifest cursor did not advance')
        seenCursors.add(nextCursor)
        cursor = nextCursor
      }
      const digest = manifestDigestHex(items)
      if (items.length !== begin.fileCount || bytesDone !== begin.totalBytes || digest.toLowerCase() !== begin.entriesDigest.toLowerCase()) {
        throw new EngineError('CONFLICT', 'remote manifest summary/digest mismatch')
      }
      const readyAt = Date.now()
      const stored: StoredSnapshot = {
        scanId: localScanId,
        relativePath: (ref.relativePath ?? '').replace(/^\/+|\/+$/g, ''),
        items,
        fileCount: items.length,
        totalBytes: bytesDone,
        entriesDigest: digest,
        createdAtMs: readyAt,
        expiresAtMs: readyAt + SCAN_TTL_MS,
        hardExpiresAtMs: readyAt + Math.max(SCAN_TTL_MS * 6, 60 * 60 * 1000),
        kind: 'remote',
        peerId: ref.peerId,
        rootId: ref.rootId,
        cancelToken
      }
      this._storeSnapshot(stored)
      return stored
    } finally {
      session.fs.notify('fs.manifest', { action: 'cancel', scanId: remoteScanId })
      this._activeScans.delete(localScanId)
    }
  }

  manifestPage(scanId: string, cursor: string | null, requesterPeerId: string | null = null) {
    const snap = this._snapshotOrThrow(scanId)
    if (requesterPeerId) {
      const owner = requesterPeerId.toLowerCase()
      if (snap.kind !== 'local' || snap.peerId?.toLowerCase() !== owner) {
        throw new EngineError('NOT_ALLOWED', 'manifest belongs to another requester')
      }
      this._rootOrThrow(snap.rootId, 'read', owner)
    }
    const start = cursor ? decodeCursor(cursor) : 0
    const items = snap.items.slice(start, start + MANIFEST_PAGE_SIZE)
    return { items, nextCursor: start + items.length < snap.items.length ? encodeCursor(start + items.length) : null }
  }

  manifestCancel(scanId: string, requesterPeerId: string | null = null): { ok: boolean } {
    const owner = requesterPeerId ? requesterPeerId.toLowerCase() : null
    const active = this._activeScans.get(scanId)
    if (active) {
      if (owner && active.peerId !== owner) {
        throw new EngineError('NOT_ALLOWED', 'manifest belongs to another requester')
      }
      active.cancelToken.cancelled = true
      active.remote?.session.fs.notify('fs.manifest', { action: 'cancel', scanId: active.remote.scanId })
    }
    const snap = this._snapshots.get(scanId)
    if (snap) {
      if (owner && (snap.kind !== 'local' || snap.peerId?.toLowerCase() !== owner)) {
        throw new EngineError('NOT_ALLOWED', 'manifest belongs to another requester')
      }
      if (snap.cancelToken) snap.cancelToken.cancelled = true
      this._snapshots.delete(scanId)
    }
    return { ok: true }
  }

  private _snapshotOrThrow(scanId: string): StoredSnapshot {
    const snap = this._snapshots.get(scanId)
    if (!snap) throw new EngineError('STALE_SCAN', 'scan unknown/expired')
    const t = Date.now()
    if (snap.expiresAtMs < t || snap.hardExpiresAtMs < t) {
      this.manifestCancel(scanId)
      throw new EngineError('STALE_SCAN', 'scan expired')
    }
    snap.expiresAtMs = Math.min(snap.hardExpiresAtMs, t + SCAN_TTL_MS)
    // Touch insertion order so cache quota behaves as LRU for active scans.
    this._snapshots.delete(scanId)
    this._snapshots.set(scanId, snap)
    return snap
  }

  // ---------- wire server ----------
  async onWire(
    session: PeerSession,
    method: string,
    payload: unknown,
    requestCancelToken?: RequestCancelToken
  ): Promise<unknown> {
    if (!session.fs.open) throw new EngineError('OFFLINE', 'fs channel not open')
    throwIfRequestCancelled(requestCancelToken)
    const p = asParams(payload)
    switch (method) {
      case 'fs.list':
        return await this._listLocal(
          String(p.rootId ?? ''),
          String(p.relativePath ?? ''),
          cursorParam(p.cursor),
          session.peerId,
          listSortParam(p.sort),
          requestCancelToken
        )
      case 'fs.stat': {
        const root = this._rootOrThrow(String(p.rootId ?? ''), 'read', session.peerId)
        const entry = await this._rootStatPath(
          root.physicalPath,
          String(p.relativePath ?? ''),
          () => requestCancelToken?.cancelled === true
        )
        if (!entry) throw new EngineError('NOT_FOUND', 'missing')
        return { entry }
      }
      case 'fs.statBatch': {
        const paths = Array.isArray(p.relativePaths) ? p.relativePaths : []
        if (paths.length > STAT_BATCH_WIRE_TARGETS) throw new EngineError('INVALID_REQUEST', 'too many stat targets for one wire frame')
        const root = this._rootOrThrow(String(p.rootId ?? ''), 'read', session.peerId)
        throwIfRequestCancelled(requestCancelToken)
        const results = await this._rootStatPaths(
          root.physicalPath,
          paths.map((rawPath) => String(rawPath ?? '')),
          () => requestCancelToken?.cancelled === true
        )
        throwIfRequestCancelled(requestCancelToken)
        return { results }
      }
      case 'fs.hash': {
        const root = this._rootOrThrow(String(p.rootId ?? ''), 'read', session.peerId)
        const rel = String(p.relativePath ?? '')
        const entry = await this._rootStatPath(
          root.physicalPath,
          rel,
          () => requestCancelToken?.cancelled === true
        )
        if (!entry || entry.type !== 'file') throw new EngineError('NOT_FOUND', 'hash target is not a file')
        const stable = await this._rootStableHash(
          root.physicalPath,
          entry.relativePath,
          () => requestCancelToken?.cancelled === true
        )
        return stable
      }
      case 'fs.manifest': {
        const action = String(p.action ?? 'start')
        if (action === 'start') {
          const snap = await this.manifestStart(
            { peerId: null, rootId: String(p.rootId ?? ''), relativePath: String(p.relativePath ?? '') },
            filterParam(p.filter),
            session.peerId,
            undefined,
            typeof p.scanId === 'string' ? p.scanId : undefined,
            requestCancelToken
          )
          return { scanId: snap.scanId, fileCount: snap.fileCount, totalBytes: snap.totalBytes, entriesDigest: snap.entriesDigest, expiresAtMs: snap.expiresAtMs }
        }
        if (action === 'page') return this.manifestPage(String(p.scanId ?? ''), cursorParam(p.cursor), session.peerId)
        if (action === 'cancel') return this.manifestCancel(String(p.scanId ?? ''), session.peerId)
        throw new EngineError('INVALID_REQUEST', 'bad manifest action')
      }
      case 'x-init':
        return await this._xinit(session, p, requestCancelToken)
      case 'x-open':
        return await this._xopen(session, p, undefined, true, requestCancelToken)
      case 'x-ready':
        return await this._xready(session, p, undefined, true, requestCancelToken)
      case 'x-result':
        return await this._xresult(session, p, requestCancelToken)
      case 'x-cancel':
        return await this._xcancelInbound(session, p, requestCancelToken)
      case 'x-resume':
        return await this._xresumeInbound(session, p, requestCancelToken)
      case 'x-resume.prepare':
        return await this._xresumePrepareInbound(session, p, requestCancelToken)
      case 'x-resume.status':
        return this._xresumeStatusInbound(session, p)
      case 'x-stale':
        return await this._xstaleInbound(session, p, requestCancelToken)
      case 'fs.ready-notify':
        return { ok: true }
      case 'capabilities':
        return {
          fs: ['v1'],
          chat: ['v1'],
          limits: { pageSize: LIST_PAGE_SIZE, maxManifest: MANIFEST_MAX_ENTRIES, concurrent: CONCURRENT_TRANSFERS_PER_PEER },
          concurrent: CONCURRENT_TRANSFERS_PER_PEER,
          rootIdStyle: 'uuid',
          remoteRootSandbox: REMOTE_ROOT_SANDBOX_MODE
        }
      case 'roots':
        return { roots: this.deps.roots.forPeer(session.peerId) }
      default:
        throw new EngineError('UNSUPPORTED', `unknown fs.v1 method ${method}`)
    }
  }

  // ---------- x-init ----------
  private async _xinit(session: PeerSession, p: Params, requestCancelToken?: RequestCancelToken) {
    const descriptor = parseDescriptor(p)
    const operationId = descriptor.operationId
    if (this._openingOperations.has(operationId)) {
      throw new EngineError('BUSY', 'operation setup already in progress')
    }
    this._openingOperations.add(operationId)
    this._openingOperationRoots.set(operationId, new Set([descriptor.source.rootId]))
    try {
      return await this._xinitInner(session, p, descriptor, requestCancelToken)
    } finally {
      this._openingOperationRoots.delete(operationId)
      this._openingOperations.delete(operationId)
    }
  }

  private async _xinitInner(session: PeerSession, p: Params, descriptor: OperationDescriptor, requestCancelToken?: RequestCancelToken) {
    throwIfRequestCancelled(requestCancelToken)
    const hash = requireStr(p, 'descriptorHash', 64)
    if (coreHashOf(descriptor) !== hash) throw new EngineError('CONFLICT', 'descriptorHash mismatch')
    // A wire operation always has exactly one local endpoint and the remote
    // endpoint must be the authenticated peer on this session. The public
    // copy API does not support third-device routing, so accepting any other
    // topology here would let a peer manufacture a descriptor whose later
    // result-routing decisions disagree with the transport that created it.
    if (descriptor.source.deviceId !== this.myId) throw new EngineError('NOT_ALLOWED', 'not source owner')
    if (descriptor.destination.deviceId === this.myId) throw new EngineError('NOT_ALLOWED', 'destination cannot be local for x-init')
    if (descriptor.destination.deviceId !== session.peerId) throw new EngineError('NOT_ALLOWED', 'destination is not the authenticated peer')
    this._throwIfOperationCancelled(descriptor.operationId, session.peerId)
    const root = this._rootOrThrow(descriptor.source.rootId, 'read', session.peerId)
    const entry = await this._rootStatPath(
      root.physicalPath,
      descriptor.source.relativePath,
      () => requestCancelToken?.cancelled === true || this._operationIsCancelled(descriptor.operationId, session.peerId)
    )
    if (!entry || entry.type !== 'file') throw new EngineError('NOT_FOUND', 'source file missing')
    if (entry.size !== descriptor.size) throw new EngineError('STALE_SOURCE', 'size changed')
    // Admission/idempotency checks must happen before hashing the source. A
    // paired but malicious reader must not be able to bypass the remote
    // journal quota (or retry one operation) and force an unbounded sequence
    // of full-file hashes.
    const existing = this.deps.journals.get(descriptor.operationId)
    if (existing) {
      if (existing.peerId !== session.peerId) throw new EngineError('NOT_ALLOWED', 'operation belongs to another peer')
      if (existing.descriptorHash !== hash) throw new EngineError('CONFLICT', 'operationId reused')
      if (existing.role !== 'sender') throw new EngineError('CONFLICT', 'role mismatch')
    } else {
      const remoteRows = this.deps.journals.list({ peerId: session.peerId })
        .filter((remoteRow) => remoteRow.initiatedLocally !== true)
      if (remoteRows.length >= REMOTE_INITIATED_JOURNAL_MAX_PER_PEER) {
        throw new EngineError(
          'LIMIT_EXCEEDED',
          `peer has too many unfinished remote-initiated operations (${REMOTE_INITIATED_JOURNAL_MAX_PER_PEER})`
        )
      }
    }

    const descriptorContentHash = descriptor.sourceFingerprint.blake2b256
    if (!descriptorContentHash || descriptor.sourceFingerprint.size !== descriptor.size) {
      throw new EngineError('INVALID_REQUEST', 'sourceFingerprint must bind descriptor size and content hash')
    }
    let stableSource
    try {
      stableSource = await this._rootStableHash(
        root.physicalPath,
        descriptor.source.relativePath,
        () => requestCancelToken?.cancelled === true || this._operationIsCancelled(descriptor.operationId, session.peerId)
      )
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code
      if (code === 'STALE_SCAN' || code === 'NOT_FOUND') throw new EngineError('STALE_SOURCE', 'source changed during fingerprint verification')
      throw err
    }
    const contentHash = stableSource.contentHash.toLowerCase()
    if (stableSource.size !== descriptor.size || contentHash !== descriptorContentHash.toLowerCase()) {
      throw new EngineError('STALE_SOURCE', 'source content changed after preflight')
    }
    this._throwIfOperationCancelled(descriptor.operationId, session.peerId)
    throwIfRequestCancelled(requestCancelToken)
    this._rootOrThrow(descriptor.source.rootId, 'read', session.peerId)

    if (existing) {
      await this.deps.journals.update(descriptor.operationId, (r) => {
        const ff = r.files[0]
        ff.contentHash = contentHash
        ff.sourceFingerprint = { size: stableSource.size, mtimeMs: stableSource.mtimeMs, blake2b256: descriptorContentHash.toLowerCase() }
      }, true)
      return { ok: true, resume: null }
    }
    await this.deps.journals.put({
      operationId: descriptor.operationId,
      descriptor,
      descriptorHash: hash,
      role: 'sender',
      peerId: session.peerId,
      state: 'waiting-peer',
      initiatedLocally: false,
      peerPrepared: true,
      files: [{
        relativePath: fileName(descriptor.source.relativePath),
        size: descriptor.size,
        chunkSize: selectChunkSize(descriptor.size),
        chunkCount: chunkCount(descriptor.size, selectChunkSize(descriptor.size)),
        contentHash,
        sourceFingerprint: { size: stableSource.size, mtimeMs: stableSource.mtimeMs, blake2b256: descriptorContentHash.toLowerCase() },
        destFingerprint: null,
        bitmapHex: null,
        bytesDone: 0,
        partPath: null,
        savedTo: null,
        fileId: null,
        state: 'queued',
        error: null
      }]
    }, true)
    return { ok: true, resume: null }
  }

  // ---------- x-open (receiver) ----------
  private async _xopen(session: PeerSession, p: Params, onStarted?: (done: Promise<string>) => void, authorizeRemote = true, requestCancelToken?: RequestCancelToken) {
    const descriptor = parseDescriptor(p)
    const operationId = descriptor.operationId
    if (this._openingOperations.has(operationId)) {
      throw new EngineError('BUSY', 'operation setup already in progress')
    }
    this._openingOperations.add(operationId)
    this._openingOperationRoots.set(operationId, new Set([descriptor.destination.rootId]))
    try {
      return await this._xopenInner(session, p, descriptor, onStarted, authorizeRemote, requestCancelToken)
    } finally {
      this._openingOperationRoots.delete(operationId)
      this._openingOperations.delete(operationId)
    }
  }

  private async _xopenInner(
    session: PeerSession,
    p: Params,
    descriptor: OperationDescriptor,
    onStarted?: (done: Promise<string>) => void,
    authorizeRemote = true,
    requestCancelToken?: RequestCancelToken
  ) {
    throwIfRequestCancelled(requestCancelToken)
    const hash = requireStr(p, 'descriptorHash', 64)
    if (coreHashOf(descriptor) !== hash) throw new EngineError('CONFLICT', 'descriptorHash mismatch')
    if (descriptor.destination.deviceId !== this.myId) throw new EngineError('NOT_ALLOWED', 'not destination owner')
    if (descriptor.source.deviceId === this.myId) throw new EngineError('NOT_ALLOWED', 'source cannot be local for x-open')
    if (descriptor.source.deviceId !== session.peerId) throw new EngineError('NOT_ALLOWED', 'source is not the authenticated peer')
    const transferId = requireStr(p, 'transferId', 64)
    const contentHash = requireStr(p, 'contentHash', 64).toLowerCase()
    if (!/^[0-9a-fA-F]{64}$/.test(contentHash)) throw new EngineError('INVALID_REQUEST', 'contentHash must be hex64')
    const descriptorContentHash = descriptor.sourceFingerprint.blake2b256
    if (!descriptorContentHash || descriptor.sourceFingerprint.size !== descriptor.size) {
      throw new EngineError('INVALID_REQUEST', 'sourceFingerprint must bind descriptor size and content hash')
    }
    if (contentHash !== descriptorContentHash.toLowerCase()) {
      throw new EngineError('CONFLICT', 'contentHash does not match descriptor sourceFingerprint')
    }
    this._throwIfOperationCancelled(descriptor.operationId, session.peerId)
    throwIfRequestCancelled(requestCancelToken)
    if (this.deps.journals.wasRecentlyCompleted(descriptor.operationId)) {
      throw new EngineError('CONFLICT', 'operation already completed')
    }
    const destRoot = this._rootOrThrow(descriptor.destination.rootId, 'write', authorizeRemote ? session.peerId : null)
    let row: JournalRow | null = this.deps.journals.get(descriptor.operationId)
    if (row && (row.state === 'finalizing' || row.state === 'done')) {
      throw new EngineError('CONFLICT', 'operation already finalizing/completed')
    }
    if (row && row.role === 'receiver' && this._receive.has(descriptor.operationId) && (row.state === 'active' || row.state === 'queued')) {
      if (row.peerId !== session.peerId) throw new EngineError('NOT_ALLOWED', 'operation belongs to another peer')
      const fjNow = row.files[0]
      if (fjNow?.fileId && fjNow.fileId !== transferId) {
        throw new EngineError('CONFLICT', 'operation already has a different live transferId')
      }
      return { ok: true, resume: fjNow?.bitmapHex ? { bitmapHex: fjNow.bitmapHex } : null }
    }
    if (!row && authorizeRemote) {
      const remoteRows = this.deps.journals.list({ peerId: session.peerId })
        .filter((existing) => existing.initiatedLocally !== true)
      if (remoteRows.length >= REMOTE_INITIATED_JOURNAL_MAX_PER_PEER) {
        throw new EngineError(
          'LIMIT_EXCEEDED',
          `peer has too many unfinished remote-initiated operations (${REMOTE_INITIATED_JOURNAL_MAX_PER_PEER})`
        )
      }
    }

    const destRel = descriptor.destination.relativePath
    const leaf = fileName(destRel)
    let releaseInboundTransfer: (() => void) | null = null
    if (authorizeRemote) {
      releaseInboundTransfer = this._tryAcquirePeerTransfer(session.peerId)
      if (!releaseInboundTransfer) {
        throw new EngineError('LIMIT_EXCEEDED', `peer already has ${CONCURRENT_TRANSFERS_PER_PEER} active transfers`)
      }
    }

    let releaseDestination: (() => void) | null = null
    let handedToReceive = false
    let closeTransferChannel: (() => void) | null = null
    try {
      // Admission comes before the first filesystem side effect. A peer that has
      // exhausted its transfer window cannot create directories or trigger path
      // resolution/hashing work with requests we already know we will reject.
      const targetAbs = await this._rootPreparePut(
        destRoot.physicalPath,
        destRel,
        () => requestCancelToken?.cancelled === true || this._operationIsCancelled(descriptor.operationId, session.peerId)
      )
      releaseDestination = await this._acquireDestinationLock(targetAbs, descriptor.operationId)
      this._throwIfOperationCancelled(descriptor.operationId, session.peerId)
      throwIfRequestCancelled(requestCancelToken)
      const destFingerprintHint = destFingerprintHintOf(p.destFingerprint) ?? descriptor.destFingerprint ?? null
      const existingDest = await this._rootStatFile(targetAbs, () => requestCancelToken?.cancelled === true || this._operationIsCancelled(descriptor.operationId, session.peerId))
      let destFp: DestFingerprint | null = null
      if (descriptor.collision === 'overwrite') {
        if (destFingerprintHint) {
          if (!existingDest) throw new EngineError('STALE_DEST', 'destination vanished after preview')
          if (Number(destFingerprintHint.size) !== existingDest.size) throw new EngineError('STALE_DEST', 'destination changed after preview')
          const wantHex = typeof destFingerprintHint.blake2b256 === 'string' ? destFingerprintHint.blake2b256.toLowerCase() : ''
          if (wantHex) {
            const { hex } = await this._rootHashAbsolute(targetAbs, () => requestCancelToken?.cancelled === true || this._operationIsCancelled(descriptor.operationId, session.peerId))
            if (hex.toLowerCase() !== wantHex) throw new EngineError('STALE_DEST', 'destination content changed after preview')
            destFp = { size: existingDest.size, blake2b256: wantHex }
          } else {
            destFp = { size: existingDest.size, blake2b256: null }
          }
        } else if (existingDest) {
          destFp = { size: existingDest.size, blake2b256: null }
        }
      }

      let resumeBits: Uint8Array | null = null
      const uniquePartPath = partPathFor(targetAbs)
      const legacyPartPath = legacyPartPathFor(targetAbs, descriptor.operationId)
      row = this.deps.journals.get(descriptor.operationId)
      this._throwIfOperationCancelled(descriptor.operationId, session.peerId)
      throwIfRequestCancelled(requestCancelToken)
      if (row) {
        if (row.peerId !== session.peerId) throw new EngineError('NOT_ALLOWED', 'operation belongs to another peer')
        if (row.descriptorHash !== hash) throw new EngineError('CONFLICT', 'operationId reused with different identity')
        if (row.role !== 'receiver') throw new EngineError('CONFLICT', 'wrong role')
        const fj = row.files[0]
        const journalPartPath = fj?.partPath || null
        const legacyUnownedPath = journalPartPath === legacyPartPath
        const partPath = !journalPartPath || legacyUnownedPath ? uniquePartPath : journalPartPath
        // Pre-patch operation-id-derived paths are not trusted for resume or
        // deletion: a peer could have caused the journal to point at an
        // existing sibling. Migrate to a fresh locally generated capability.
        const partSt = legacyUnownedPath ? null : (partPath ? await this._rootStatFile(partPath) : null)
        const journalContentHash = typeof fj?.contentHash === 'string' ? fj.contentHash.toLowerCase() : null
        const sameContentIdentity = journalContentHash === descriptorContentHash.toLowerCase()
        if (fj && !legacyUnownedPath && sameContentIdentity && fj.bitmapHex && partSt && fj.size === descriptor.size && partSt.size === fj.size) {
          resumeBits = b4a.from(fj.bitmapHex, 'hex')
        }
        if (!resumeBits && partSt) await this._rootUnlink(partPath, true).catch(() => {})
        await this.deps.journals.update(descriptor.operationId, (r) => {
          const f = r.files[0]
          f.partPath = partPath
          f.contentHash = descriptorContentHash.toLowerCase()
          f.destFingerprint = destFp ? { size: destFp.size, blake2b256: destFp.blake2b256 } : f.destFingerprint ?? null
          f.fileId = transferId
          if (!resumeBits) {
            f.state = 'queued'
            f.bitmapHex = null
            f.bytesDone = 0
            f.savedTo = null
            f.finalize = null
            if (r.state !== 'cancel-pending' && r.state !== 'stale') r.state = 'queued'
          }
        }, true)
        this._throwIfOperationCancelled(descriptor.operationId, session.peerId)
        throwIfRequestCancelled(requestCancelToken)
      } else {
        this._throwIfOperationCancelled(descriptor.operationId, session.peerId)
        throwIfRequestCancelled(requestCancelToken)
        row = await this.deps.journals.put({
          operationId: descriptor.operationId,
          descriptor,
          descriptorHash: hash,
          role: 'receiver',
          peerId: session.peerId,
          state: 'queued',
          initiatedLocally: false,
          peerPrepared: true,
          files: [{
            relativePath: leaf,
            size: descriptor.size,
            chunkSize: selectChunkSize(descriptor.size),
            chunkCount: chunkCount(descriptor.size, selectChunkSize(descriptor.size)),
            contentHash: descriptorContentHash.toLowerCase(),
            sourceFingerprint: null,
            destFingerprint: destFp ? { size: destFp.size, blake2b256: destFp.blake2b256 } : null,
            bitmapHex: null,
            bytesDone: 0,
            partPath: uniquePartPath,
            savedTo: null,
            finalize: null,
            fileId: transferId,
            state: 'queued',
            error: null
          }]
        }, true)
        this._throwIfOperationCancelled(descriptor.operationId, session.peerId)
        throwIfRequestCancelled(requestCancelToken)
      }

      this._throwIfOperationCancelled(descriptor.operationId, session.peerId)
      throwIfRequestCancelled(requestCancelToken)
      dbg('x-open accepted', descriptor.operationId, 'transfer', transferId, 'size', descriptor.size)
      let checkpointBytes = 0
      let checkpointAt = Date.now()
      const ch = session.drive.session(transferId)
      if (!ch) throw new EngineError('IO', 'drive channel unavailable')
      closeTransferChannel = () => ch.close()
      const partPath = row.files[0]?.partPath || uniquePartPath
      const sessionJournal = this.deps.journals
      const writer = new ReceiverWriter(
        targetAbs,
        partPath,
        descriptor.size,
        resumeBits !== null,
        descriptor.collision === 'overwrite',
        descriptorContentHash.toLowerCase(),
        destFp,
        {
          phase: async (phase, targetPath, backupPath, publishMode, destinationIdentity) => {
            let cancellationOwnsOutcome = false
            await sessionJournal.update(descriptor.operationId, (r) => {
              // A cancellation that claimed ownership before commit must never
              // be overwritten by a late finalize checkpoint.  In particular,
              // `prepared` is still before target->backup / publish, so aborting
              // here is safe and leaves the cancel journal authoritative.
              if (r.state === 'cancel-pending' || r.state === 'stale') {
                cancellationOwnsOutcome = true
                return
              }
              const f = r.files[0]
              // Ownership proof is only ever strengthened, never cleared, so a
              // later checkpoint that omits it cannot erase an earlier record.
              const previousIdentity = f.finalize?.destinationIdentity ?? null
              f.finalize = {
                phase,
                targetPath,
                backupPath,
                publishMode,
                destinationIdentity: destinationIdentity ?? previousIdentity
              }
              f.state = 'finalizing'
              if (phase === 'target-replaced') f.savedTo = targetPath
              r.state = 'finalizing'
              r.error = null
            }, true)
            if (cancellationOwnsOutcome) {
              throw new EngineError('CANCELLED', 'cancellation already owns terminal outcome')
            }
          },
          reset: async () => {
            await sessionJournal.update(descriptor.operationId, (r) => {
              const f = r.files[0]
              f.finalize = null
              f.savedTo = null
              if (r.state !== 'cancel-pending' && r.state !== 'stale') r.state = 'waiting-peer'
              if (f.state !== 'cancel-pending' && f.state !== 'stale') f.state = 'waiting-peer'
            }, true)
          },
          authorizeCommit: () => {
            this._rootOrThrow(
              descriptor.destination.rootId,
              'write',
              authorizeRemote ? session.peerId : null
            )
          }
        },
        this._disk
      )
      const receive = new ReceiverSession(writer, ch, {
        transferId,
        expectedSize: descriptor.size,
        resumeBits: resumeBits ?? undefined,
        onChunkWritten: async (bm: Bitmap) => {
          checkpointBytes += selectChunkSize(descriptor.size)
          const now = Date.now()
          if (
            checkpointBytes < CHUNK_CHECKPOINT_MIN_BYTES &&
            now - checkpointAt < CHUNK_CHECKPOINT_MAX_MS &&
            !bm.allSet()
          ) return
          await writer.sync()
          await sessionJournal.update(descriptor.operationId, (r) => {
            const f = r.files[0]
            f.bitmapHex = b4a.toString(bm.serialize(), 'hex')
            f.bytesDone = Math.min(f.size, bm.count() * f.chunkSize)
            if (f.state === 'queued') f.state = 'active'
            if (r.state !== 'cancel-pending' && r.state !== 'stale') r.state = 'active'
          }, true)
          checkpointBytes = 0
          checkpointAt = now
        },
        onProgress: (received: number, total: number) => {
          this._emit('operation.progress', {
            operationId: descriptor.operationId,
            peerId: session.peerId,
            direction: (descriptor.source.deviceId === this.myId ? 'out' : 'in') as 'in' | 'out',
            relativePath: descriptor.source.relativePath,
            state: 'active',
            bytesDone: received,
            bytesTotal: total || descriptor.size
          })
        }
      })
      throwIfRequestCancelled(requestCancelToken)
      this._rootOrThrow(
        descriptor.destination.rootId,
        'write',
        authorizeRemote ? session.peerId : null
      )
      const receiveDone = receive.receive()
      this._receive.set(descriptor.operationId, { session: receive, writer, done: receiveDone })
      // The transfer slot protects live data-plane work, not the terminal
      // journal/x-result bookkeeping that follows a committed ReceiverSession.
      // Release it as soon as receiveDone settles so the next queued file cannot
      // race the old cleanup and get a transient LIMIT_EXCEEDED.
      const releaseInboundNow = () => {
        releaseInboundTransfer?.()
        releaseInboundTransfer = null
      }
      void receiveDone.then(
        async (savedToRel: string) => {
          releaseInboundNow()
          const savedTo = String(savedToRel)
          const rowNow = sessionJournal.get(descriptor.operationId)
          if (!rowNow || rowNow.state === 'stale' || rowNow.state === 'cancel-pending') {
            await writer.cancel().catch(() => {})
            return
          }
          let finalizeAccepted = false
          try {
            await sessionJournal.update(descriptor.operationId, (r) => {
              if (r.state === 'stale' || r.state === 'cancel-pending') return
              const f = r.files[0]
              f.state = 'done'
              f.savedTo = savedTo
              f.error = null
              if (!f.finalize) f.finalize = { phase: 'target-replaced', targetPath: savedTo, backupPath: null }
              r.state = 'finalizing'
              r.error = null
              finalizeAccepted = true
            }, true)
          } catch (err) {
            await writer.cancel().catch(() => {})
            await sessionJournal.update(descriptor.operationId, (r) => {
              if (r.state === 'stale' || r.state === 'cancel-pending') return
              const f = r.files[0]
              f.state = 'waiting-peer'
              f.savedTo = null
              f.finalize = null
              r.state = 'waiting-peer'
              r.error = String((err as { message?: string })?.message ?? err)
            }, false).catch(() => {})
            throw err
          }
          if (!finalizeAccepted) return
          await writer.commit()
          const delivered = await this._deliverPendingResult(descriptor.operationId)
          if (!delivered) {
            this._emit('operation.state', {
              operationId: descriptor.operationId,
              state: 'finalizing',
              peerId: session.peerId,
              direction: descriptor.source.deviceId === this.myId ? 'out' : 'in',
              relativePath: descriptor.source.relativePath,
              savedTo
            })
            this._schedulePendingResultRetry(descriptor.operationId)
          }
        },
        async (err: unknown) => {
          releaseInboundNow()
          let rowNow = sessionJournal.get(descriptor.operationId)
          const errObj = err as { digestMismatch?: boolean; staleDest?: boolean; code?: string; message?: string }

          // A killed/timeout copy worker can fail after O_EXCL created the
          // destination but before the parent saw completion. Reconcile the
          // durable finalize journal before telling the sender success/failure.
          // This prevents a retry from racing a file that was actually fully
          // published just before the worker disappeared.
          if (errObj?.code === 'FINALIZE_UNCERTAIN' && rowNow?.role === 'receiver' && rowNow.files[0]?.finalize) {
            try {
              await this._recoverReceiverFinalize(rowNow)
              rowNow = sessionJournal.get(descriptor.operationId)
              const recoveredFile = rowNow?.files[0]
              if (rowNow?.state === 'finalizing' && recoveredFile?.state === 'done' && recoveredFile.savedTo) {
                const delivered = await this._deliverPendingResult(descriptor.operationId)
                if (!delivered) this._schedulePendingResultRetry(descriptor.operationId)
                return
              }
              if (rowNow?.state === 'stale' && rowNow.error === 'FINALIZE_RECOVERY_CONFLICT') {
                this._emit('operation.state', {
                  operationId: descriptor.operationId,
                  state: 'stale',
                  reason: 'FINALIZE_RECOVERY_CONFLICT',
                  error: 'finalize ownership is ambiguous; local recovery is required',
                  peerId: session.peerId,
                  relativePath: descriptor.source.relativePath,
                  direction: descriptor.source.deviceId === this.myId ? 'out' : 'in'
                })
                return
              }
            } catch (recoveryErr) {
              await this._parkAsStale(descriptor.operationId, 'FINALIZE_RECOVERY_CONFLICT').catch(() => {})
              this._emit('operation.state', {
                operationId: descriptor.operationId,
                state: 'stale',
                reason: 'FINALIZE_RECOVERY_CONFLICT',
                error: `finalize recovery failed: ${errorMessage(recoveryErr)}`,
                peerId: session.peerId,
                relativePath: descriptor.source.relativePath,
                direction: descriptor.source.deviceId === this.myId ? 'out' : 'in'
              })
              return
            }
          }

          const fj = rowNow?.files[0]
          const userCancelled = rowNow?.state === 'cancel-pending'
          const parkedStale = rowNow?.state === 'stale'
          const parkedStaleCode = parkedStale && (rowNow?.error === 'STALE_DEST' || rowNow?.error === 'STALE_SOURCE')
            ? rowNow.error
            : 'STALE_SOURCE'
          const code =
            userCancelled ? 'CANCELLED'
              : parkedStale ? parkedStaleCode
                : errObj?.digestMismatch ? 'INTEGRITY'
                  : errObj?.staleDest ? 'STALE_DEST'
                    : errObj?.code === 'STALE_SOURCE' ? 'STALE_SOURCE'
                      : 'IO'
          if (errObj?.digestMismatch && fj?.partPath) {
            await this._rootUnlink(fj.partPath, true).catch(() => {})
            await sessionJournal.update(descriptor.operationId, (r) => {
              const f = r.files[0]
              f.state = 'failed'
              f.error = 'INTEGRITY'
              f.bitmapHex = null
              f.bytesDone = 0
              f.finalize = null
              r.state = 'waiting-peer'
            }, true)
          } else if (code === 'STALE_DEST') {
            if (fj?.partPath) await this._rootUnlink(fj.partPath, true).catch(() => {})
            await sessionJournal.update(descriptor.operationId, (r) => {
              r.state = 'stale'
              r.error = 'STALE_DEST'
              r.files[0].state = 'stale'
            }, true)
          } else if (code === 'CANCELLED') {
            await writer.cancel().catch(() => {})
          } else if (rowNow && rowNow.role === 'receiver') {
            await sessionJournal.update(descriptor.operationId, (r) => {
              if (r.state === 'cancel-pending' || r.state === 'stale' || r.state === 'finalizing') return
              r.state = 'waiting-peer'
              const f = r.files[0]
              f.state = 'waiting-peer'
              f.error = String(errObj?.message ?? err)
            }, true)
          }
          this._emit('operation.state', {
            operationId: descriptor.operationId,
            state: code === 'CANCELLED' ? 'cancel-pending' : code,
            error: String(errObj?.message ?? err),
            peerId: session.peerId,
            relativePath: descriptor.source.relativePath,
            direction: descriptor.source.deviceId === this.myId ? 'out' : 'in'
          })
          const srcSession = this._sessionOf(descriptor.source.deviceId === this.myId ? '' : descriptor.source.deviceId)
          if (!userCancelled && !parkedStale) {
            if (descriptor.source.deviceId === this.myId) {
              await this._xresultLocal(descriptor.operationId, false, false, null, code)
            } else if (srcSession) {
              await this._req(srcSession, 'x-result', {
                operationId: descriptor.operationId,
                ok: false,
                digestOk: code === 'STALE_SOURCE' ? false : true,
                error: code
              }, 15_000).catch(() => {})
            }
          }
        }
      ).catch(() => {}).finally(() => {
        try { closeTransferChannel?.() } catch {}
        closeTransferChannel = null
        this._dropReceiver(descriptor.operationId, receive)
        releaseDestination?.()
        releaseDestination = null
        releaseInboundNow()
      })
      handedToReceive = true
      onStarted?.(receiveDone)
      return { ok: true, resume: resumeBits ? { bitmapHex: b4a.toString(resumeBits, 'hex') } : null }
    } catch (err) {
      if (!handedToReceive) {
        try { closeTransferChannel?.() } catch {}
        closeTransferChannel = null
        releaseDestination?.()
        releaseDestination = null
        releaseInboundTransfer?.()
        releaseInboundTransfer = null
      }
      throw err
    }
  }

  // ---------- x-ready (source serves) ----------
  private async _xready(session: PeerSession, p: Params, onStarted?: (done: Promise<string>) => void, authorizeRemote = true, requestCancelToken?: RequestCancelToken) {
    const operationId = requireStr(p, 'operationId', ID_MAX_LEN)
    return await this._withServeLock(operationId, () => this._xreadyLocked(session, p, onStarted, authorizeRemote, requestCancelToken))
  }

  private async _xreadyLocked(session: PeerSession, p: Params, onStarted?: (done: Promise<string>) => void, authorizeRemote = true, requestCancelToken?: RequestCancelToken) {
    throwIfRequestCancelled(requestCancelToken)
    const operationId = requireStr(p, 'operationId', ID_MAX_LEN)
    const transferId = requireStr(p, 'transferId', 64)
    const hash = requireStr(p, 'descriptorHash', 64)
    const row = this.deps.journals.get(operationId)
    if (!row) throw new EngineError('NOT_FOUND', 'no sender journal — re-init')
    if (row.role !== 'sender') throw new EngineError('CONFLICT', 'role')
    if (row.peerId !== session.peerId) throw new EngineError('NOT_ALLOWED', 'operation belongs to another peer')
    if (row.descriptorHash !== hash) throw new EngineError('CONFLICT', 'descriptorHash')
    this._throwIfOperationCancelled(operationId, session.peerId)
    if (this._serving.has(operationId) && row.state === 'active') {
      const liveTransferId = row.files[0]?.fileId
      if (liveTransferId && liveTransferId !== transferId) {
        throw new EngineError('CONFLICT', 'operation already has a different live transferId')
      }
      return { ok: true }
    }
    const descriptor = parseDescriptor({ descriptor: row.descriptor })
    const root = this._rootOrThrow(descriptor.source.rootId, 'read', authorizeRemote ? session.peerId : null)
    const entry = await this._rootStatPath(
      root.physicalPath,
      descriptor.source.relativePath,
      () => requestCancelToken?.cancelled === true || this._operationIsCancelled(operationId, session.peerId)
    )
    if (!entry || entry.type !== 'file') throw new EngineError('NOT_FOUND', 'source missing')
    const f = row.files[0]
    // mtime drift alone is tolerated when the size matches; content is re-verified on resume.
    if (f.sourceFingerprint && entry.size !== f.sourceFingerprint.size) throw new EngineError('STALE_SOURCE', 'size changed')

    // Build and register the live sender before the durable state says active.
    // If any part of activation fails, cancel the live machine and keep the
    // journal resumable instead of leaving an orphaned active row. Remote
    // activation is admitted non-blockingly so a peer cannot create an
    // unbounded number of long-lived sender sessions.
    let releaseInboundTransfer: (() => void) | null = null
    if (authorizeRemote) {
      releaseInboundTransfer = this._tryAcquirePeerTransfer(session.peerId)
      if (!releaseInboundTransfer) {
        throw new EngineError('LIMIT_EXCEEDED', `peer already has ${CONCURRENT_TRANSFERS_PER_PEER} active transfers`)
      }
    }
    let handedToServe = false
    let ch: ReturnType<PeerSession['drive']['session']> | null = null
    try {
      throwIfRequestCancelled(requestCancelToken)
      ch = session.drive.session(transferId)
      if (!ch) throw new EngineError('IO', 'drive channel unavailable')
      const reader = new SourceReader(root.physicalPath, descriptor.source.relativePath, entry.size)
      const serve = new SenderSession(reader, ch, {
        transferId,
        name: fileName(descriptor.source.relativePath),
        onProgress: (sent: number, total: number) => {
          this._emit('operation.progress', {
            operationId,
            peerId: session.peerId,
            direction: 'out',
            relativePath: descriptor.source.relativePath,
            state: 'active',
            bytesDone: sent,
            bytesTotal: total || entry.size
          })
        }
      })
      throwIfRequestCancelled(requestCancelToken)
      this._rootOrThrow(
        descriptor.source.rootId,
        'read',
        authorizeRemote ? session.peerId : null
      )
      const done = serve.start()
      this._serving.set(operationId, { session: serve, done })
      // SenderSession.done means the remote receiver has acknowledged a
      // committed transfer (or the session failed). Do not keep the peer slot
      // occupied while journal/result cleanup runs after that terminal signal.
      const releaseInboundNow = () => {
        releaseInboundTransfer?.()
        releaseInboundTransfer = null
      }
      try {
        await this.deps.journals.update(operationId, (r) => {
          r.state = 'active'
          r.files[0].state = 'active'
          r.files[0].fileId = transferId
          r.files[0].senderTransferComplete = false
        }, true)
      } catch (err) {
        serve.cancel('Sender activation failed', { notifyPeer: false })
        await serve.close().catch(() => {})
        try { ch.close() } catch {}
        this._dropServing(operationId, serve)
        await this.deps.journals.update(operationId, (r) => {
          if (r.state === 'active') r.state = 'waiting-peer'
          const file = r.files[0]
          if (file.state === 'active') file.state = 'waiting-peer'
        }, true).catch(() => {})
        throw err
      }
      void done.then(
        (savedTo) => {
          releaseInboundNow()
          return this._serveOk(operationId, session.peerId, savedTo)
        },
        async (err: unknown) => {
          releaseInboundNow()
          const current = this.deps.journals.get(operationId)
          if (!current || current.state === 'cancel-pending') return
          const stale = errorCode(err) === 'STALE_SOURCE' || (isEngineError(err) && err.digestMismatch === true)
          await this.deps.journals.update(operationId, (r) => {
            if (r.state === 'stale' || r.state === 'cancel-pending') return
            const f = r.files[0]
            if (stale) {
              r.state = 'stale'
              r.error = 'STALE_SOURCE'
              f.state = 'stale'
            } else {
              r.state = 'waiting-peer'
              f.state = 'waiting-peer'
              f.error = errorMessage(err)
            }
          }, true)
          if (stale) {
            // State-changing peer notifications use request/response so the
            // receiver's WireChannel inbound-concurrency bound applies.
            await this._req(session, 'x-stale', { operationId, code: 'STALE_SOURCE' }, 30_000).catch(() => {})
          }
          this._emit('operation.state', { operationId, state: 'waiting-peer', phase: 'serve', error: errorMessage(err), peerId: session.peerId })
        }
      ).catch(() => {}).finally(async () => {
        await serve.close().catch(() => {})
        try { ch?.close() } catch {}
        this._dropServing(operationId, serve)
        releaseInboundNow()
      })
      handedToServe = true
      onStarted?.(done)
      return { ok: true }
    } catch (err) {
      if (!handedToServe) {
        try { ch?.close() } catch {}
        releaseInboundTransfer?.()
        releaseInboundTransfer = null
      }
      throw err
    }
  }

  private async _serveOk(operationId: string, _peerId: string, savedTo: string): Promise<void> {
    let row = this.deps.journals.get(operationId)
    if (!row || row.role !== 'sender' || row.state === 'done' || row.state === 'stale') return

    // ReceiverSession emits Drive ACK only after prepareFinalize() verified the
    // complete payload and commitFinalize() published it. That ACK is therefore
    // a terminal filesystem-commit proof, not merely transport progress. Older
    // peers may never send x-result, so waiting for both leaves a committed file
    // permanently parked in the sender journal (for example 2/3 = 67%).
    if (row.state === 'cancel-pending') {
      await this._markRemoteCommitOwned(operationId)
      row = this.deps.journals.get(operationId)
      if (!row || row.role !== 'sender' || row.state === 'done' || row.state === 'stale') return
    }

    await this.deps.journals.update(operationId, (r) => {
      if (r.state === 'done' || r.state === 'stale') return
      const f = r.files[0]
      f.bytesDone = f.size
      f.state = 'active'
      f.senderTransferComplete = true
    }, true)
    await this._settleSenderSuccess(operationId, remoteSavedToBase(savedTo))
  }

  private async _xresult(session: PeerSession, p: Params, requestCancelToken?: RequestCancelToken) {
    throwIfRequestCancelled(requestCancelToken)
    const operationId = requireStr(p, 'operationId', ID_MAX_LEN)
    const row = this.deps.journals.get(operationId)
    if (!row || row.role !== 'sender') return { ok: true }
    if (row.peerId !== session.peerId) throw new EngineError('NOT_ALLOWED', 'operation belongs to another peer')
    if (typeof p.ok !== 'boolean') throw new EngineError('INVALID_REQUEST', 'x-result.ok must be a boolean')
    throwIfRequestCancelled(requestCancelToken)
    if (p.ok === true) {
      if (p.digestOk !== true) throw new EngineError('INVALID_REQUEST', 'successful x-result requires digestOk=true')
      // A successful x-result is definitive proof that the receiver's commit
      // won.  It must override only an *unconfirmed* local cancellation; the
      // journal is still present precisely because remote cleanup was pending.
      if (row.state === 'cancel-pending') await this._markRemoteCommitOwned(operationId)
      await this._bufferOrSettleSenderSuccess(operationId, remoteSavedToBase(p.savedToBase))
    } else {
      if (row.state === 'cancel-pending') return { ok: true }
      if (p.digestOk !== undefined && typeof p.digestOk !== 'boolean') {
        throw new EngineError('INVALID_REQUEST', 'x-result.digestOk must be a boolean')
      }
      const batchId = this.deps.journals.batchIdForOperation(operationId)
      const code = remoteErrorCode(p.error, 'IO')
      await this.deps.journals.update(operationId, (r) => {
        const f = r.files[0]
        f.pendingSuccessResult = null
        if (code === 'STALE_SOURCE') {
          r.state = 'stale'; f.state = 'stale'
        } else if (code === 'STALE_DEST') {
          r.state = 'stale'; r.error = 'STALE_DEST'; f.state = 'stale'
        } else if (code === 'CANCELLED') {
          r.state = 'cancel-pending'; f.state = 'cancel-pending'
        } else {
          r.state = 'waiting-peer'; f.state = 'waiting-peer'; f.error = code
        }
      }, true)
      // Durable state changes first; live ownership is released only after the
      // data-plane resource has actually been cancelled/closed. For terminal
      // cancellation remove the journal only after stop succeeds so a crash or
      // stuck close still leaves a recoverable cancel-pending record.
      await this._stopLiveOperation(operationId, `Receiver reported ${code}`)
      if (code === 'CANCELLED') await this.deps.journals.remove(operationId)
      this._emit('operation.state', { operationId, state: code === 'CANCELLED' ? 'cancelled' : 'waiting-peer', peerId: session.peerId, relativePath: row.descriptor.source.relativePath, error: code, ...(batchId ? { batchId } : {}) })
    }
    return { ok: true }
  }

  private async _bufferOrSettleSenderSuccess(operationId: string, savedToBase: string | null): Promise<void> {
    const row = this.deps.journals.get(operationId)
    if (!row || row.role !== 'sender' || row.state === 'cancel-pending' || row.state === 'stale') return
    // x-result is sent only after the receiver verified the complete payload and
    // crossed its durable filesystem commit boundary. Persist that terminal
    // proof before replying so a crash cannot fall back to waiting for the
    // redundant Drive ACK that may already have been lost.
    await this.deps.journals.update(operationId, (r) => {
      const f = r.files[0]
      f.pendingSuccessResult = { savedToBase }
    }, true)
    await this._settleSenderSuccess(operationId, savedToBase)
  }

  private async _settleSenderSuccess(operationId: string, savedToBase: string | null): Promise<void> {
    const existing = this._senderSuccessSettles.get(operationId)
    if (existing) {
      await existing
      return
    }
    const run = this._settleSenderSuccessOnce(operationId, savedToBase)
    this._senderSuccessSettles.set(operationId, run)
    try {
      await run
    } finally {
      if (this._senderSuccessSettles.get(operationId) === run) this._senderSuccessSettles.delete(operationId)
    }
  }

  private async _settleSenderSuccessOnce(operationId: string, savedToBase: string | null): Promise<void> {
    const row = this.deps.journals.get(operationId)
    if (!row || row.role !== 'sender') return
    const batchId = this.deps.journals.batchIdForOperation(operationId)
    await this.deps.journals.update(operationId, (r) => {
      const file = r.files[0]
      file.bytesDone = file.size
      file.state = 'done'
      file.error = null
      // Both a successful x-result and a valid Drive ACK are emitted only after
      // the receiver verified and published the expected content. Either proof
      // is sufficient; the single-flight wrapper makes their race idempotent.
      file.senderTransferComplete = true
      file.pendingSuccessResult = null
      r.state = 'done'
      r.error = null
    }, true)
    // Durable batch completion comes before releasing the live sender. If Core
    // dies after this remove(), recovery cannot resurrect an already-committed
    // member from the shared .batch acceptance record.
    await this.deps.journals.remove(operationId)

    const serving = this._serving.get(operationId)
    if (serving) {
      serving.session.confirmRemoteCommit(savedToBase ?? '')
      await serving.done.catch(() => {})
      // The serving lifecycle registered when the session was created owns the
      // SourceReader close. Do not race a second close here; dropping the map
      // entry only prevents a late transport callback from reviving the row.
      this._dropServing(operationId, serving.session)
    } else {
      this._dropServing(operationId)
    }
    this._emit('operation.state', {
      operationId,
      state: 'done',
      peerId: row.peerId,
      relativePath: row.descriptor.source.relativePath,
      savedToBase,
      ...(batchId ? { batchId } : {})
    })
  }

  private async _xresultLocal(operationId: string, ok: boolean, digestOk: boolean, savedToBase: string | null, error?: string): Promise<void> {
    const row = this.deps.journals.get(operationId)
    if (!row || row.role !== 'sender') return
    if (row.state === 'cancel-pending') return
    if (ok) {
      if (digestOk !== true) throw new EngineError('INVALID_REQUEST', 'successful local x-result requires digestOk=true')
      await this._bufferOrSettleSenderSuccess(operationId, savedToBase)
    } else {
      await this.deps.journals.update(operationId, (r) => {
        r.files[0].pendingSuccessResult = null
        r.state = error === 'STALE_SOURCE' || error === 'STALE_DEST' ? 'stale' : 'waiting-peer'
        r.error = error ?? null
      }, true)
      await this._stopLiveOperation(operationId, `Local receiver reported ${error ?? 'IO'}`)
    }
  }

  /** Replay a receiver's durable terminal result until the source ACKs it.
   *  Calls are single-flight per operation; x-result itself is idempotent. */
  private async _deliverPendingResult(operationId: string): Promise<boolean> {
    const inFlight = this._resultDeliveries.get(operationId)
    if (inFlight) return await inFlight
    const run = this._deliverPendingResultOnce(operationId).finally(() => {
      if (this._resultDeliveries.get(operationId) === run) this._resultDeliveries.delete(operationId)
    })
    this._resultDeliveries.set(operationId, run)
    return await run
  }

  private async _deliverPendingResultOnce(operationId: string): Promise<boolean> {
    let row = this.deps.journals.get(operationId)
    if (!row || row.role !== 'receiver' || row.state !== 'finalizing') {
      this._clearPendingResultRetry(operationId)
      return true
    }
    const descriptor = parseDescriptor({ descriptor: row.descriptor })
    const savedTo = row.files[0]?.savedTo ?? ''
    if (!savedTo) throw new EngineError('IO', 'finalizing receiver journal has no saved path')
    const resultBody = {
      operationId,
      ok: true,
      digestOk: true,
      error: null,
      savedToBase: path.basename(savedTo)
    }

    // The filesystem transaction is already durably committed before we get
    // here. The old destination is no longer needed for rollback, so cleanup
    // must not depend on the remote peer staying online long enough to ACK
    // x-result. In particular, the source can process x-result (and show the
    // operation as done) while the response packet is lost; keeping the backup
    // until a later reconnect would leak .peersync-prev-* files indefinitely.
    //
    // Cleanup is best-effort here: a transient Windows file lock must not block
    // delivery of the successful result. After resultAcked is persisted, the
    // same cleanup path below keeps retrying locally until it succeeds.
    await this._cleanupFinalizeArtifacts(row, row.files[0]?.finalize?.resultAcked === true)
    row = this.deps.journals.get(operationId) ?? row

    // Once x-result has been ACKed, backup cleanup is purely local. Persist
    // that boundary so a transient Windows unlink failure or a peer disconnect
    // cannot leave .peersync-prev-* waiting for another network round-trip.
    if (row.files[0]?.finalize?.resultAcked !== true) {
      try {
        if (descriptor.source.deviceId === this.myId) {
          await this._xresultLocal(operationId, true, true, resultBody.savedToBase)
        } else {
          const srcSession = this._sessionOf(descriptor.source.deviceId)
          if (!srcSession) return false
          await this._req(srcSession, 'x-result', resultBody, 30_000)
        }
      } catch {
        return false
      }
      try {
        await this.deps.journals.update(operationId, (r) => {
          const finalize = r.files[0]?.finalize
          if (finalize) finalize.resultAcked = true
          r.error = null
        }, true)
      } catch {
        return false
      }
      row = this.deps.journals.get(operationId) ?? row
    }

    if (!(await this._cleanupFinalizeArtifacts(row, true))) return false
    const batchId = this.deps.journals.batchIdForOperation(operationId)
    await this.deps.journals.remove(operationId)
    this._clearPendingResultRetry(operationId)
    this._emit('operation.state', {
      operationId,
      state: 'done',
      ...(batchId ? { batchId } : {}),
      peerId: row.peerId,
      direction: descriptor.source.deviceId === this.myId ? 'out' : 'in',
      relativePath: descriptor.source.relativePath,
      savedTo
    })
    return true
  }

  private async _cleanupFinalizeArtifacts(row: JournalRow, resultAcked: boolean): Promise<boolean> {
    const finalize = row.files[0]?.finalize
    const backupPath = finalize?.backupPath ?? null
    if (!backupPath) return true

    let lastErr: unknown = null
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        await this._rootUnlink(backupPath, false)
        await this.deps.journals.update(row.operationId, (r) => {
          const current = r.files[0]?.finalize
          if (current?.backupPath === backupPath) current.backupPath = null
          if (r.error?.startsWith('finalize local cleanup pending:') || r.error?.startsWith('finalize cleanup pending:')) {
            r.error = null
          }
        }, true).catch(() => {})
        return true
      } catch (err: unknown) {
        if ((err as { code?: string })?.code === 'ENOENT') {
          await this.deps.journals.update(row.operationId, (r) => {
            const current = r.files[0]?.finalize
            if (current?.backupPath === backupPath) current.backupPath = null
            if (r.error?.startsWith('finalize local cleanup pending:') || r.error?.startsWith('finalize cleanup pending:')) {
              r.error = null
            }
          }, true).catch(() => {})
          return true
        }
        lastErr = err
        if (!isErrnoCode(err, 'EPERM', 'EACCES', 'EBUSY') || attempt === 5) break
        // On Windows a renamed read-only target can be renamed successfully but
        // still reject unlink with EPERM/EACCES. The backup is disposable now.
        if (isErrnoCode(err, 'EPERM', 'EACCES')) await this._rootChmod(backupPath, 0o666).catch(() => {})
        await new Promise<void>((resolve) => setTimeout(() => resolve(), 120 * (attempt + 1)))
      }
    }

    await this.deps.journals.update(row.operationId, (r) => {
      // Older releases used `finalize cleanup pending:` only after x-result was
      // ACKed, and JournalStore recovery uses that prefix as a compatibility
      // signal. Do not write that legacy prefix before the ACK or recovery
      // could incorrectly synthesize resultAcked=true.
      const prefix = resultAcked ? 'finalize cleanup pending:' : 'finalize local cleanup pending:'
      r.error = `${prefix} ${String((lastErr as { message?: string })?.message ?? lastErr)}`
    }, true).catch(() => {})
    return false
  }

  private _schedulePendingResultRetry(operationId: string, attempt = 0): void {
    if (this._destroyed || this._resultRetryTimers.has(operationId)) return
    const delay = Math.min(30_000, 1_000 * (2 ** Math.min(attempt, 5)))
    const timer = setTimeout(() => {
      this._resultRetryTimers.delete(operationId)
      if (this._destroyed) return
      const row = this.deps.journals.get(operationId)
      if (!row || row.role !== 'receiver' || row.state !== 'finalizing') return
      // Before x-result is ACKed we normally need the source online. Backup
      // cleanup is receiver-local though, so keep retrying while an artifact is
      // still pending even if the peer has disconnected.
      const finalize = row.files[0]?.finalize
      const cleanupPending = !!finalize?.backupPath
      if (finalize?.resultAcked !== true && !cleanupPending && !this._sessionOf(row.peerId)) return
      void this._deliverPendingResult(operationId)
        .then((delivered) => {
          if (!delivered) this._schedulePendingResultRetry(operationId, attempt + 1)
        })
        .catch(() => this._schedulePendingResultRetry(operationId, attempt + 1))
    }, delay)
    const anyT = timer as unknown as { unref?: () => void }
    if (typeof anyT.unref === 'function') anyT.unref()
    this._resultRetryTimers.set(operationId, timer)
  }

  private _clearPendingResultRetry(operationId: string): void {
    const timer = this._resultRetryTimers.get(operationId)
    if (timer) clearTimeout(timer)
    this._resultRetryTimers.delete(operationId)
  }

  // ---------- explicit finalize-conflict recovery ----------
  async finalizeRecoveryInfo(operationId: string): Promise<Record<string, unknown>> {
    const row = this.deps.journals.get(operationId)
    if (!row) throw new EngineError('NOT_FOUND', 'operation not found')
    const file = row.files[0]
    const finalize = file?.finalize
    if (row.role !== 'receiver' || row.state !== 'stale' || row.error !== 'FINALIZE_RECOVERY_CONFLICT' || !finalize?.backupPath) {
      throw new EngineError('CONFLICT', 'operation has no finalize recovery conflict')
    }
    const targetExists = Boolean(await this._rootStatFile(finalize.targetPath))
    const backupExists = Boolean(await this._rootStatFile(finalize.backupPath))
    return {
      operationId,
      targetPath: finalize.targetPath,
      backupPath: finalize.backupPath,
      targetExists,
      backupExists,
      expectedSize: file.size,
      expectedHash: file.contentHash ?? null
    }
  }

  async resolveFinalizeConflict(
    operationId: string,
    action: 'keep-new' | 'restore-backup' | 'save-both'
  ): Promise<Record<string, unknown>> {
    const row = this.deps.journals.get(operationId)
    if (!row) throw new EngineError('NOT_FOUND', 'operation not found')
    const file = row.files[0]
    const finalize = file?.finalize
    if (row.role !== 'receiver' || row.state !== 'stale' || row.error !== 'FINALIZE_RECOVERY_CONFLICT' || !finalize?.backupPath) {
      throw new EngineError('CONFLICT', 'operation has no finalize recovery conflict')
    }
    if (!['keep-new', 'restore-backup', 'save-both'].includes(action)) {
      throw new EngineError('INVALID_REQUEST', 'invalid recovery action')
    }

    const target = finalize.targetPath
    const backup = finalize.backupPath
    const backupExists = Boolean(await this._rootStatFile(backup))
    if (!backupExists) throw new EngineError('NOT_FOUND', 'recovery backup is missing')
    let preservedPath: string | null = null

    if (action === 'keep-new') {
      // Explicit user choice: the current target wins, old destination is no
      // longer required. Never delete the backup when the supposed winner is
      // missing: in that state the backup may be the only surviving copy.
      if (!(await this._rootStatFile(target))) throw new EngineError('CONFLICT', 'current target is missing; backup was preserved')
      await this._rootUnlink(backup, false)
    } else if (action === 'restore-backup') {
      // Never destroy a file that appeared after the crash. Preserve it beside
      // the target before restoring the old destination.
      if (await this._rootStatFile(target)) {
        preservedPath = await this._moveToUniqueRecoveryPath(
          target,
          `${target}.peersync-conflict-${operationId}`
        )
      }
      if (!(await this._restoreBackupNoReplace(backup, target))) {
        throw new EngineError('CONFLICT', 'target was recreated during recovery; backup was preserved')
      }
    } else {
      // Keep current target and expose the pre-overwrite file under an explicit
      // recovered sibling name. As with keep-new, refuse the action when the
      // supposed current copy is absent: otherwise "save both" could silently
      // move the only surviving file away from its expected destination.
      if (!(await this._rootStatFile(target))) throw new EngineError('CONFLICT', 'current target is missing; backup was preserved')
      preservedPath = await this._moveToUniqueRecoveryPath(
        backup,
        `${target}.peersync-recovered-${operationId}`
      )
    }

    await this.deps.journals.update(operationId, (r) => {
      const f = r.files[0]
      f.finalize = null
      f.savedTo = null
      r.state = 'stale'
      r.error = 'FINALIZE_RECOVERY_RESOLVED'
      f.state = 'stale'
    }, true)
    const cancel = await this.cancelOperation(operationId)
    return { ok: true, action, preservedPath, pendingPeerCleanup: cancel.pending }
  }

  private async _moveToUniqueRecoveryPath(from: string, base: string): Promise<string> {
    for (let i = 1; i < 10_000; i++) {
      const candidate = i === 1 ? base : `${base}-${i}`
      try {
        // Publish with a no-clobber primitive. Hard-link is preferred, with an
        // exclusive-create copy fallback on filesystems that do not support it.
        await this._rootPublishNoReplace(from, candidate)
      } catch (err) {
        if (isErrnoCode(err, 'EEXIST')) continue
        throw err
      }
      try {
        await this._rootUnlink(from, false)
      } catch (err) {
        await this._rootUnlink(candidate, true).catch(() => {})
        throw err
      }
      return candidate
    }
    throw new EngineError('IO', 'unable to allocate recovery filename')
  }

  private async _restoreBackupNoReplace(backup: string, target: string): Promise<boolean> {
    try {
      await this._rootPublishNoReplace(backup, target)
    } catch (err) {
      if (isErrnoCode(err, 'EEXIST')) return false
      throw err
    }
    try {
      await this._rootUnlink(backup, false)
      return true
    } catch (err) {
      // Keep the journal and backup when namespace cleanup is incomplete. The
      // restored target is valid, but declaring recovery complete here would
      // lose the only durable record of the leftover artifact.
      throw new EngineError('IO', `restored backup but could not remove recovery artifact: ${errorMessage(err)}`)
    }
  }

  // ---------- user cancel ----------
  async cancelOperation(operationId: string): Promise<{ ok: true; pending: boolean }> {
    const row = this.deps.journals.get(operationId)
    if (!row) throw new EngineError('NOT_FOUND', 'operation not found')
    const batchId = this.deps.journals.batchIdForOperation(operationId)
    if (row.state === 'done' || row.state === 'finalizing') throw new EngineError('CONFLICT', 'operation already committed')

    // Receiver publication has an explicit point of no return.  Claim
    // cancellation synchronously before writing cancel-pending so the journal
    // can never say "cancelled" while the writer already owns commit.
    if (row.role === 'receiver') {
      const live = this._receive.get(operationId)
      if (live && live.writer.claimCancellation() === 'commit-owned') {
        throw new EngineError('CONFLICT', 'operation commit already owns terminal outcome')
      }
    }

    const persistCancel = async () => {
      const pending = this.deps.journals.update(operationId, (r) => {
        r.state = 'cancel-pending'
        r.files[0].state = 'cancel-pending'
      }, true)
      this._rememberCancelled(operationId, row.peerId)
      await pending
    }

    // A locally staged job that the peer never prepared has no remote commit
    // to race.  Cancel it durably and remove it immediately.
    if (row.initiatedLocally && !row.peerPrepared && !this._drivingOperations.has(operationId)) {
      await persistCancel()
      await this._stopLiveOperation(operationId, 'Transfer cancelled by user')
      const partPath = row.role === 'receiver' ? row.files[0]?.partPath ?? null : null
      if (partPath) await this._rootUnlink(partPath, true).catch(() => {})
      await this.deps.journals.remove(operationId)
      this._emit('operation.state', { operationId, state: 'cancelled', relativePath: journalRelativePath(row), ...(batchId ? { batchId } : {}) })
      return { ok: true, pending: false }
    }

    const session = this._sessionOf(row.peerId)

    // Sender-side cancellation has a remote commit boundary.  Do not persist
    // cancel-pending before the receiver has accepted x-cancel: it may already
    // have entered commit.  Stop the local data plane first, then let the
    // receiver declare which terminal owner won.
    if (row.role === 'sender' && session) {
      await this._stopLiveOperation(operationId, 'Transfer cancelled by user')
      let reply: unknown
      try {
        reply = await this._req<unknown>(session, 'x-cancel', { operationId }, 30_000)
      } catch {
        await persistCancel()
        this._emit('operation.state', { operationId, state: 'cancel-pending', note: 'peer cleanup queued' })
        return { ok: true, pending: true }
      }
      const commitOwned = !!reply && typeof reply === 'object' && (reply as { terminalOwner?: unknown }).terminalOwner === 'commit'
      if (commitOwned) {
        await this._markRemoteCommitOwned(operationId)
        throw new EngineError('CONFLICT', 'receiver commit already owns terminal outcome')
      }
      const cancelAccepted = !!reply && typeof reply === 'object' && (reply as { cancelAccepted?: unknown }).cancelAccepted === true
      if (!cancelAccepted) {
        // A legacy peer's bare {ok:true} cannot prove that cancellation beat
        // receiver commit: older receivers could acknowledge x-cancel after a
        // commit had already published.  Keep the durable cancellation pending
        // and allow a later successful x-result to prove commit ownership.
        await persistCancel()
        this._emit('operation.state', { operationId, state: 'cancel-pending', note: 'peer cancellation outcome is ambiguous' })
        return { ok: true, pending: true }
      }
      await persistCancel()
      await this.deps.journals.remove(operationId)
      this._dropReceiver(operationId)
      this._dropServing(operationId)
      this._emit('operation.state', { operationId, state: 'cancelled', relativePath: journalRelativePath(row), ...(batchId ? { batchId } : {}) })
      return { ok: true, pending: false }
    }

    // Receiver-side cancellation (or an offline sender) has already won any
    // local commit race above.  Persist that ownership before tearing down the
    // data plane so a crash cannot resurrect the accepted cancellation.
    await persistCancel()
    await this._stopLiveOperation(operationId, 'Transfer cancelled by user')

    const afterStop = this.deps.journals.get(operationId)
    if (afterStop && (afterStop.state === 'done' || afterStop.state === 'finalizing')) {
      this._forgetCancelled(operationId)
      throw new EngineError('CONFLICT', 'operation commit already owns terminal outcome')
    }

    if (!session) {
      this._emit('operation.state', { operationId, state: 'cancel-pending', note: 'queued until reconnect' })
      return { ok: true, pending: true }
    }
    try {
      const reply = await this._req<unknown>(session, 'x-cancel', { operationId }, 30_000)
      const commitOwned = !!reply && typeof reply === 'object' && (reply as { terminalOwner?: unknown }).terminalOwner === 'commit'
      if (commitOwned) {
        // This should not normally occur for a local receiver (the remote side
        // is the sender), but fail closed instead of deleting an ambiguous row.
        this._forgetCancelled(operationId)
        throw new EngineError('CONFLICT', 'peer reports commit-owned terminal outcome')
      }
    } catch (err) {
      if (err instanceof EngineError && err.code === 'CONFLICT') throw err
      this._emit('operation.state', { operationId, state: 'cancel-pending', note: 'peer cleanup queued' })
      return { ok: true, pending: true }
    }
    const leftoverPart = this.deps.journals.get(operationId)?.files[0]?.partPath
    if (leftoverPart) await this._rootUnlink(leftoverPart, true).catch(() => {})
    await this.deps.journals.remove(operationId)
    this._dropReceiver(operationId)
    this._dropServing(operationId)
    this._emit('operation.state', { operationId, state: 'cancelled', relativePath: journalRelativePath(row), ...(batchId ? { batchId } : {}) })
    return { ok: true, pending: false }
  }

  /**
   * UI batch stop: cancel every not-yet-terminal operation of a UI batch.
   * `relativePath` narrows the request to one selected row or directory branch.
   * A batch can hold thousands of rows, so each operation settles on its own and
   * the aggregate tells the shell how many were cancelled outright, parked until
   * the peer acks, or left alone because a commit already won the race.
   */
  async cancelBatch(
    batchId: string,
    relativePath?: string | null
  ): Promise<{ ok: true; cancelled: number; pending: number; skipped: number }> {
    if (!SAFE_ID_RE.test(batchId)) throw new EngineError('INVALID_REQUEST', 'invalid batchId')
    const branch = relativePath === undefined || relativePath === null
      ? null
      : String(relativePath).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (branch !== null && branch.length > REL_PATH_MAX_BYTES) {
      throw new EngineError('INVALID_REQUEST', 'relativePath is too long')
    }

    let cancelled = 0
    let pending = 0
    let skipped = 0
    for (const row of this.deps.journals.list()) {
      if (this.deps.journals.batchIdForOperation(row.operationId) !== batchId) continue
      if (branch !== null && branch !== '' && !pathInBranch(journalRelativePath(row), branch)) continue
      if (row.state === 'done' || row.state === 'finalizing') {
        // A committed transfer owns its terminal outcome; leaving it alone is
        // the correct outcome, not a failure of this request.
        skipped += 1
        continue
      }
      try {
        const result = await this.cancelOperation(row.operationId)
        if (result.pending) pending += 1
        else cancelled += 1
      } catch (err) {
        // One row losing the commit race must not abandon the rest of the batch.
        if (isEngineError(err) && (err.code === 'CONFLICT' || err.code === 'NOT_FOUND')) {
          skipped += 1
          continue
        }
        throw err
      }
    }
    return { ok: true, cancelled, pending, skipped }
  }

  private async _xstaleInbound(session: PeerSession, p: Params, requestCancelToken?: RequestCancelToken) {
    throwIfRequestCancelled(requestCancelToken)
    const operationId = requireStr(p, 'operationId', ID_MAX_LEN)
    const code = remoteErrorCode(p.code ?? p.why, 'STALE_SOURCE')
    const row = this.deps.journals.get(operationId)
    if (!row) return { ok: true }
    if (row.peerId !== session.peerId) throw new EngineError('NOT_ALLOWED', 'operation belongs to another peer')
    throwIfRequestCancelled(requestCancelToken)
    await this.deps.journals.update(operationId, (r) => {
      r.state = 'stale'
      r.error = code
      r.files[0].state = 'stale'
    }, true)
    await this._stopLiveOperation(operationId, code)
    const f = this.deps.journals.get(operationId)?.files[0]
    if (row.role === 'receiver' && f?.partPath && f.state !== 'done') {
      await this._rootUnlink(f.partPath, true).catch(() => {})
    }
    this._emit('operation.state', { operationId, state: 'stale', reason: code, peerId: session.peerId, relativePath: row.descriptor.source.relativePath })
    this._dropReceiver(operationId)
    this._dropServing(operationId)
    return { ok: true }
  }

  private async _xcancelInbound(session: PeerSession, p: Params, requestCancelToken?: RequestCancelToken) {
    throwIfRequestCancelled(requestCancelToken)
    const operationId = requireStr(p, 'operationId', ID_MAX_LEN)
    const row = this.deps.journals.get(operationId)
    if (row && row.peerId !== session.peerId) throw new EngineError('NOT_ALLOWED', 'operation belongs to another peer')

    // x-cancel may race ahead of x-init/x-open.  Only create the tombstone
    // after proving cancellation owns the terminal outcome; otherwise a late
    // cancel could suppress the x-result of a commit already in progress.
    throwIfRequestCancelled(requestCancelToken)
    if (!row) {
      this._rememberCancelled(operationId, session.peerId)
      return { ok: true, cancelAccepted: true }
    }
    if (row.state === 'done' || row.state === 'finalizing') {
      return { ok: true, terminalOwner: 'commit' }
    }
    if (row.role === 'receiver') {
      const live = this._receive.get(operationId)
      if (live && live.writer.claimCancellation() === 'commit-owned') {
        return { ok: true, terminalOwner: 'commit' }
      }
    }

    this._rememberCancelled(operationId, session.peerId)
    const persistCancel = this.deps.journals.update(operationId, (r) => {
      r.state = 'cancel-pending'
      r.files[0].state = 'cancel-pending'
    }, true)
    await this._stopLiveOperation(operationId, 'Transfer cancelled by peer')
    await persistCancel

    const current = this.deps.journals.get(operationId)
    if (current && (current.state === 'done' || current.state === 'finalizing')) {
      this._forgetCancelled(operationId)
      return { ok: true, terminalOwner: 'commit' }
    }

    const partPath = current?.files[0]?.partPath
    if (partPath) await this._rootUnlink(partPath, true).catch(() => {})
    const batchId = this.deps.journals.batchIdForOperation(operationId)
    await this.deps.journals.remove(operationId)
    this._dropReceiver(operationId)
    this._dropServing(operationId)
    this._emit('operation.state', { operationId, state: 'cancelled', peerId: session.peerId, relativePath: journalRelativePath(row), ...(batchId ? { batchId } : {}) })
    return { ok: true, cancelAccepted: true }
  }

  // ---------- resume ----------
  /**
   * Full source re-verification for a resume. Shared by the blocking `x-resume`
   * handler and by the non-blocking `x-resume.prepare` job, so both paths apply
   * exactly the same staleness rules before a resume bitmap is trusted.
   */
  private async _verifyResumeSource(operationId: string, peerId: string): Promise<void> {
    const row = this.deps.journals.get(operationId)
    if (!row) throw new EngineError('NOT_FOUND', 'no sender journal')
    const descriptor = parseDescriptor({ descriptor: row.descriptor })
    const root = this._rootOrThrow(descriptor.source.rootId, 'read', peerId)
    const cancelled = () => this._operationIsCancelled(operationId, peerId)
    const entry = await this._rootStatPath(root.physicalPath, descriptor.source.relativePath, cancelled)
    if (!entry || entry.type !== 'file') throw new EngineError('STALE_SOURCE', 'source gone')
    const f = row.files[0]
    if (entry.size !== f.size) {
      await this._parkAsStale(operationId, 'STALE_SOURCE')
      throw new EngineError('STALE_SOURCE', 'size changed — bitmap invalid')
    }
    const contentHash = descriptor.sourceFingerprint.blake2b256
    if (!contentHash || descriptor.sourceFingerprint.size !== descriptor.size) {
      await this._parkAsStale(operationId, 'STALE_SOURCE')
      throw new EngineError('STALE_SOURCE', 'canonical source fingerprint missing — bitmap invalid')
    }
    let stableSource
    try {
      stableSource = await this._rootStableHash(root.physicalPath, descriptor.source.relativePath, cancelled)
    } catch (err: unknown) {
      if (errorCode(err) === 'CANCELLED') throw err
      await this._parkAsStale(operationId, 'STALE_SOURCE')
      throw new EngineError('STALE_SOURCE', `source changed during resume verification: ${errorMessage(err)}`)
    }
    if (stableSource.size !== descriptor.size || stableSource.contentHash.toLowerCase() !== contentHash.toLowerCase()) {
      await this._parkAsStale(operationId, 'STALE_SOURCE')
      throw new EngineError('STALE_SOURCE', 'content changed — bitmap invalid')
    }
    // restore source fingerprint into journal for x-ready validation
    await this.deps.journals.update(operationId, (r) => {
      r.state = 'waiting-peer'
      const ff = r.files[0]
      ff.sourceFingerprint = { size: stableSource.size, mtimeMs: stableSource.mtimeMs, blake2b256: contentHash.toLowerCase() }
      ff.contentHash = contentHash.toLowerCase()
    }, true)
  }

  private _xresumeValidate(session: PeerSession, p: Params): { operationId: string; hash: string } {
    // receiver-initiated: we are the SOURCE; re-verify before resume
    const operationId = requireStr(p, 'operationId', ID_MAX_LEN)
    const hash = requireStr(p, 'descriptorHash', 64)
    const row = this.deps.journals.get(operationId)
    if (!row) throw new EngineError('NOT_FOUND', 'no sender journal')
    if (row.peerId !== session.peerId) throw new EngineError('NOT_ALLOWED', 'operation belongs to another peer')
    if (row.role !== 'sender') throw new EngineError('CONFLICT', 'wrong role — we are receiver')
    if (row.descriptorHash !== hash) throw new EngineError('CONFLICT', 'descriptorHash mismatch')
    this._throwIfOperationCancelled(operationId, session.peerId)
    // A resume queued against an older recovery generation lost the race with a
    // newer attempt. Reject it as an operation error and keep the transport up.
    const requested = p.recoveryGeneration
    if (requested !== undefined && requested !== null) {
      if (!Number.isSafeInteger(requested) || Number(requested) < 0) {
        throw new EngineError('INVALID_REQUEST', 'recoveryGeneration must be a non-negative integer')
      }
      if (Number(requested) < this.deps.journals.recoveryState(operationId).generation) {
        throw new EngineError('STALE_GENERATION', 'resume belongs to an older recovery attempt')
      }
    }
    return { operationId, hash }
  }

  private async _xresumeInbound(session: PeerSession, p: Params, requestCancelToken?: RequestCancelToken) {
    throwIfRequestCancelled(requestCancelToken)
    const { operationId } = this._xresumeValidate(session, p)
    try {
      await this._verifyResumeSource(operationId, session.peerId)
    } catch (err: unknown) {
      if (requestCancelToken?.cancelled === true) throwIfRequestCancelled(requestCancelToken)
      throw err
    }
    return { ok: true }
  }

  /**
   * `x-resume.prepare` — re-hashing a large source can outlast the peer's
   * request deadline, so it runs as a background job instead of holding the wire
   * RPC open. The peer polls `x-resume.status`; a job failure surfaces there as
   * an operation error and never tears down the peer socket.
   */
  private async _xresumePrepareInbound(session: PeerSession, p: Params, requestCancelToken?: RequestCancelToken) {
    throwIfRequestCancelled(requestCancelToken)
    const { operationId } = this._xresumeValidate(session, p)
    const running = this._resumeVerifications.get(operationId)
    if (running && running.state === 'VERIFYING') return { ok: true, state: 'VERIFYING' }
    const job: ResumeVerification = { state: 'VERIFYING', error: null, promise: Promise.resolve() }
    this._resumeVerifications.set(operationId, job)
    job.promise = this._verifyResumeSource(operationId, session.peerId).then(
      () => {
        job.state = 'READY'
      },
      (err: unknown) => {
        job.state = 'FAILED'
        job.error = { code: errorCode(err) ?? 'IO', message: errorMessage(err) }
      }
    )
    return { ok: true, state: job.state }
  }

  private _xresumeStatusInbound(session: PeerSession, p: Params) {
    const operationId = requireStr(p, 'operationId', ID_MAX_LEN)
    const job = this._resumeVerifications.get(operationId)
    if (!job) throw new EngineError('NOT_FOUND', 'no resume verification in flight')
    if (job.state === 'FAILED') {
      const err = new EngineError(job.error?.code ?? 'IO', job.error?.message ?? 'resume verification failed')
      this._resumeVerifications.delete(operationId)
      throw err
    }
    // A settled job is reported once; the peer then starts the transfer.
    if (job.state === 'READY') this._resumeVerifications.delete(operationId)
    return { ok: true, state: job.state }
  }

  private async _matchesFinalPayload(pathAbs: string, size: number, contentHash: string): Promise<boolean> {
    const st = await this._rootStatFile(pathAbs)
    if (!st || st.size !== size || !/^[0-9a-fA-F]{64}$/.test(contentHash)) return false
    const { hex } = await this._rootHashAbsolute(pathAbs)
    return hex.toLowerCase() === contentHash.toLowerCase()
  }

  /**
   * Does the final pathname still name the exact file object this writer
   * created? A journalled identity answers this from one stat instead of
   * reading the whole file, and it is the only proof that survives a crash
   * during an exclusive copy, where the payload is still incomplete.
   */
  private async _targetIsOurs(target: string, expected: string | null | undefined): Promise<boolean> {
    if (!expected) return false
    const st = await this._rootStatFile(target)
    if (!st) return false
    return statIdentity(st) === expected
  }

  /**
   * Reconcile a receiver journal that crashed in the same-directory finalize
   * transaction. No path is guessed: target/backup/part all come from the
   * protected journal created from an allowlisted root.
   */
  private async _recoverReceiverFinalize(row: JournalRow): Promise<void> {
    if (row.role !== 'receiver') return
    const file = row.files[0]
    const finalize = file?.finalize
    if (!finalize) return
    const target = finalize.targetPath
    const backup = finalize.backupPath ?? null
    const part = file.partPath ?? null
    const contentHash = String(file.contentHash ?? '')
    const publishMode = finalize.publishMode ?? 'link'
    const targetStat = await this._rootStatFile(target)
    const targetExists = !!targetStat
    const partExists = !!part && !!(await this._rootStatFile(part))
    const backupExists = !!backup && !!(await this._rootStatFile(backup))

    // Identity and completeness are different questions. The recorded identity
    // proves the final pathname is the file object this writer created; it says
    // nothing about whether the payload finished arriving. Promotion therefore
    // still requires a completed copy: either the journal already recorded the
    // `target-replaced` checkpoint, or the target holds the expected bytes.
    const targetIsOurs = await this._targetIsOurs(target, finalize.destinationIdentity)
    const targetMatches = targetIsOurs && finalize.phase === 'target-replaced'
      ? true
      : targetStat !== null && targetStat.size === file.size &&
        await this._matchesFinalPayload(target, file.size, contentHash)

    const promoteCommitted = async () => {
      await this.deps.journals.update(row.operationId, (r) => {
        const f = r.files[0]
        f.finalize = { ...finalize, phase: 'target-replaced' }
        f.savedTo = target
        f.state = 'done'
        r.state = 'finalizing'
        r.error = null
      }, true)
      // Publication deliberately keeps the verified part until the
      // target-replaced checkpoint is durable. With hard links both names may
      // reference one inode; with copy fallback the part remains the trusted
      // recovery source until the journal is promoted.
      if (part && partExists) await this._rootUnlink(part, true).catch(() => {})
    }

    const resetForResume = async () => {
      await this.deps.journals.update(row.operationId, (r) => {
        const f = r.files[0]
        f.finalize = null
        f.savedTo = null
        f.bitmapHex = partExists ? f.bitmapHex : null
        f.bytesDone = partExists ? (f.bytesDone ?? 0) : 0
        f.state = 'waiting-peer'
        r.state = 'waiting-peer'
        r.error = null
      }, true)
    }

    if (finalize.phase === 'target-replaced') {
      if (targetMatches) {
        await promoteCommitted()
        return
      }
      if (backupExists && !(await this._rootStatFile(target))) {
        if (await this._restoreBackupNoReplace(backup!, target)) {
          await resetForResume()
          return
        }
      }
      await this._parkAsStale(row.operationId, 'FINALIZE_RECOVERY_CONFLICT')
      return
    }

    if (finalize.phase === 'backup-created') {
      // Crash may have happened after publishing the target but before the
      // durable target-replaced checkpoint. The part is intentionally still
      // present at that boundary, so payload identity proves commit.
      if (targetMatches) {
        await promoteCommitted()
        return
      }
      if (backupExists) {
        const currentTarget = await this._rootStatFile(target)
        if (!currentTarget) {
          if (await this._restoreBackupNoReplace(backup!, target)) {
            await resetForResume()
            return
          }
        }
        // A different file appeared while we were down: never overwrite it.
        await this._parkAsStale(row.operationId, 'FINALIZE_RECOVERY_CONFLICT')
        return
      }
      if (publishMode === 'copy-exclusive' && targetExists) {
        // A worker/process may have died after O_EXCL created the final name
        // but before the copy completed. The journalled identity proves that
        // name is still the short copy this writer created, so the transfer can
        // resume instead of asking the user to resolve a conflict. Without a
        // recorded identity ownership is genuinely unprovable, so park.
        if (targetIsOurs) {
          await resetForResume()
          return
        }
        await this._parkAsStale(row.operationId, 'FINALIZE_RECOVERY_CONFLICT')
        return
      }
      await resetForResume()
      return
    }

    // prepared: crash can occur immediately after target->backup and before
    // the backup-created checkpoint. The backup path was already journaled in
    // `prepared`, so restore it before returning to resume.
    if (targetMatches) {
      await promoteCommitted()
      return
    }
    if (backupExists) {
      const currentTarget = await this._rootStatFile(target)
      if (!currentTarget) {
        if (await this._restoreBackupNoReplace(backup!, target)) {
          await resetForResume()
          return
        }
      }
      // Both paths exist but target is not our committed payload: do not guess.
      await this._parkAsStale(row.operationId, 'FINALIZE_RECOVERY_CONFLICT')
      return
    }
    if (publishMode === 'copy-exclusive' && targetExists) {
      if (targetIsOurs) {
        await resetForResume()
        return
      }
      await this._parkAsStale(row.operationId, 'FINALIZE_RECOVERY_CONFLICT')
      return
    }
    await resetForResume()
  }

  /** UI/shell: re-drive waiting operations (receiver side initiates). */
  private _resuming = new Set<string>()
  async resumeOperation(operationId: string): Promise<ResumeResult> {
    if (this._resuming.has(operationId)) return { ok: true, peerOnline: true, note: 'resume already in flight' }
    this._resuming.add(operationId)
    try {
      return await this._resumeOperationInner(operationId)
    } finally {
      this._resuming.delete(operationId)
    }
  }

  private async _resumeOperationInner(operationId: string): Promise<ResumeResult> {
    // one live machine per operation: existing receive or serve wins
    if (this._receive.has(operationId) || this._serving.has(operationId) || this._drivingOperations.has(operationId)) {
      return { ok: true, peerOnline: true, note: 'session live' }
    }
    let row = this.deps.journals.get(operationId)
    if (!row) throw new EngineError('NOT_FOUND', 'operation')

    // Complete/rollback any interrupted local rename transaction before we
    // attempt network recovery. This works even while the peer is offline.
    if (row.role === 'receiver' && row.files[0]?.finalize) {
      await this._recoverReceiverFinalize(row)
      row = this.deps.journals.get(operationId)
      if (!row) return { ok: true, peerOnline: false }
    }

    if (row.role === 'receiver' && row.state === 'finalizing' && row.files[0]?.finalize?.resultAcked === true) {
      const delivered = await this._deliverPendingResult(operationId)
      if (!delivered) this._schedulePendingResultRetry(operationId)
      return {
        ok: delivered,
        peerOnline: this._sessionOf(row.peerId) !== null,
        note: delivered ? 'finalize cleanup completed' : 'finalize cleanup pending'
      }
    }

    const session = this._sessionOf(row.peerId)
    if (!session) return { ok: false, peerOnline: false }
    if (row.state === 'done') return { ok: true, peerOnline: true, note: 'already done' }

    // Locally accepted jobs whose complementary peer journal was never
    // prepared are durable queue entries, not normal resume sessions. Replay
    // their initial handshake from the cryptographic peerId stored in journal.
    if (row.initiatedLocally && !row.peerPrepared) {
      this._launchInitialFromJournal(session, row)
      return { ok: true, peerOnline: true, note: 'initial handshake restarted' }
    }

    if (row.role === 'receiver' && row.state === 'finalizing') {
      const delivered = await this._deliverPendingResult(operationId)
      if (!delivered) this._schedulePendingResultRetry(operationId)
      return { ok: delivered, peerOnline: true, note: delivered ? 'result delivered' : 'result pending' }
    }
    if (row.state === 'active' || row.state === 'queued') {
      // active/queued is valid only while a live transfer machine exists. If
      // it disappeared during crash/partial activation, durable state returns
      // to the normal reconnect path.
      await this.deps.journals.update(operationId, (r) => {
        r.state = 'waiting-peer'
        const file = r.files[0]
        if (file && (file.state === 'active' || file.state === 'queued')) file.state = 'waiting-peer'
      }, true)
      row = this.deps.journals.get(operationId) ?? row
    }
    const descriptor = parseDescriptor({ descriptor: row.descriptor })
    const file = row.files[0]
    const leafRel = file?.relativePath ?? fileName(descriptor.source.relativePath)
    const storedFileId = file?.fileId ?? null
    const contentHash = descriptor.sourceFingerprint.blake2b256 ?? ''
    const bitmapHex = file?.bitmapHex ?? null
    const transferId = newTransferId()
    dbg('resume', operationId, 'old fileId', storedFileId, 'new', transferId, 'map', (bitmapHex ? bitmapHex.length / 2 : 0))

    let releaseResumeTransfer: (() => void) | null = null
    let resumeTransferHandedOff = false
    try {
      // Resumed operations are live transfers too. Keep the same per-peer
      // concurrency invariant as initial chains and remote-initiated x-open.
      // The permit is handed to the data-plane promise and released only when
      // that sender/receiver actually settles, not merely after the handshake.
      releaseResumeTransfer = await this._acquirePeerTransfer(row.peerId)
      if (!/^[0-9a-fA-F]{64}$/.test(contentHash) || descriptor.sourceFingerprint.size !== descriptor.size) {
        throw new EngineError('STALE_SOURCE', 'canonical source fingerprint missing — bitmap invalid')
      }
      if (row.role === 'receiver') {
        await this._req(session, 'x-resume', { operationId, descriptorHash: row.descriptorHash }, 120_000)
        const receiverHandle: { done?: Promise<string> } = {}
        await this._xopenLocal(
          session,
          descriptor,
          row.descriptorHash,
          transferId,
          contentHash,
          (descriptor.destFingerprint as DestFingerprint | null) ?? null,
          (done) => { receiverHandle.done = done }
        )
        const receiverDone = receiverHandle.done
        if (!receiverDone) throw new EngineError('IO', 'receiver resume session did not start')
        const release = releaseResumeTransfer
        resumeTransferHandedOff = true
        releaseResumeTransfer = null
        void receiverDone.finally(() => release?.())
        await this._req(session, 'x-ready', { operationId, transferId, relativePath: leafRel, descriptorHash: row.descriptorHash }, 120_000)
        return { ok: true, peerOnline: true }
      }
      const srcRoot = this._rootOrThrow(descriptor.source.rootId, 'read')
      const hashNow = contentHash
      let stableSource
      try {
        stableSource = await this._rootStableHash(srcRoot.physicalPath, descriptor.source.relativePath)
      } catch (err: unknown) {
        throw new EngineError('STALE_SOURCE', `source changed during resume verification: ${errorMessage(err)}`)
      }
      if (stableSource.size !== descriptor.size || stableSource.contentHash.toLowerCase() !== hashNow.toLowerCase()) throw new EngineError('STALE_SOURCE', 'content changed')
      await this.deps.journals.update(operationId, (r) => {
        const f = r.files[0]
        if (!f) return
        f.sourceFingerprint = { size: stableSource.size, mtimeMs: stableSource.mtimeMs, blake2b256: hashNow.toLowerCase() }
        f.contentHash = hashNow.toLowerCase()
      }, true)
      await this._req(session, 'x-open', {
        descriptor,
        descriptorHash: row.descriptorHash,
        transferId,
        contentHash: hashNow,
        destFingerprint: (descriptor.destFingerprint as DestFingerprint | null) ?? null
      }, 120_000)
      const senderHandle: { done?: Promise<string> } = {}
      await this._xready(
        session,
        { operationId, transferId, relativePath: leafRel, descriptorHash: row.descriptorHash },
        (done) => { senderHandle.done = done },
        false
      )
      const senderDone = senderHandle.done
      if (!senderDone) throw new EngineError('IO', 'sender resume session did not start')
      const release = releaseResumeTransfer
      resumeTransferHandedOff = true
      releaseResumeTransfer = null
      void senderDone.finally(() => release?.())
      return { ok: true, peerOnline: true }
    } catch (err: unknown) {
      await this._stopLiveOperation(operationId, 'Resume chain interrupted').catch(() => {})
      this._dropReceiver(operationId)
      this._dropServing(operationId)
      const code = (err as { code?: string })?.code
      if (code === 'STALE_SOURCE' || code === 'STALE_DEST' || code === 'CONFLICT') {
        await this._parkAsStale(operationId, String(code)).catch(() => {})
      }
      throw err
    } finally {
      if (!resumeTransferHandedOff) releaseResumeTransfer?.()
    }
  }

  private _launchInitialFromJournal(_session: PeerSession, row: JournalRow): void {
    this._queueInitialLaunch(row)
  }

  private _queueInitialLaunch(row: JournalRow): void {
    if (this._destroyed || this._drivingOperations.has(row.operationId)) return
    if (this._launchQueued.has(row.operationId)) {
      this._pumpLaunchQueue(row.peerId)
      return
    }
    const queue = this._launchQueues.get(row.peerId) ?? { ids: [], head: 0 }
    queue.ids.push(row.operationId)
    this._launchQueues.set(row.peerId, queue)
    this._launchQueued.add(row.operationId)
    this._pumpLaunchQueue(row.peerId)
  }

  private _clearLaunchRetry(operationId: string): void {
    const timer = this._launchRetryTimers.get(operationId)
    if (timer) clearTimeout(timer)
    this._launchRetryTimers.delete(operationId)
    this._launchRetryAttempts.delete(operationId)
  }

  private _scheduleLaunchRetry(operationId: string, peerId: string): void {
    if (this._destroyed || this._launchRetryTimers.has(operationId)) return
    const attempt = this._launchRetryAttempts.get(operationId) ?? 0
    // Finite budget: a peer that keeps refusing the same operation must not
    // keep this timer alive forever. The journal row stays in waiting-peer, so
    // an explicit resume or a later reconnect still retries it.
    if (attempt >= 12) {
      this._clearLaunchRetry(operationId)
      return
    }
    this._launchRetryAttempts.set(operationId, attempt + 1)
    const delay = Math.min(4000, 150 * (2 ** Math.min(attempt, 5)))
    const timer = setTimeout(() => {
      this._launchRetryTimers.delete(operationId)
      if (this._destroyed) return
      const row = this.deps.journals.get(operationId)
      if (!row || row.state === 'stale' || row.state === 'cancel-pending' || row.state === 'done') {
        this._clearLaunchRetry(operationId)
        return
      }
      if (!this._sessionOf(peerId)) {
        // Reconnect invokes resumeAll(peerId); do not spin while offline.
        this._launchRetryAttempts.delete(operationId)
        return
      }
      if (row.initiatedLocally && !row.peerPrepared) {
        this._queueInitialLaunch(row)
        return
      }
      if (row.role === 'receiver') {
        void this.resumeOperation(operationId).then(
          () => this._clearLaunchRetry(operationId),
          (err: unknown) => {
            const code = errorCode(err)
            if (code === 'LIMIT_EXCEEDED' || code === 'BUSY') this._scheduleLaunchRetry(operationId, peerId)
            else this._clearLaunchRetry(operationId)
          }
        )
        return
      }
      // A prepared sender is resumed by the receiver side. Reconnect recovery
      // owns that path; there is nothing useful to poll locally here.
      this._launchRetryAttempts.delete(operationId)
    }, delay)
    const anyT = timer as unknown as { unref?: () => void }
    if (typeof anyT.unref === 'function') anyT.unref()
    this._launchRetryTimers.set(operationId, timer)
  }

  private _pumpLaunchQueue(peerId: string): void {
    if (this._destroyed) return
    const session = this._sessionOf(peerId)
    if (!session) return
    const queue = this._launchQueues.get(peerId)
    if (!queue || queue.head >= queue.ids.length) return
    let active = this._launchActiveByPeer.get(peerId) ?? 0
    while (active < CONCURRENT_TRANSFERS_PER_PEER && queue.head < queue.ids.length) {
      const operationId = queue.ids[queue.head++]
      this._launchQueued.delete(operationId)
      const row = this.deps.journals.get(operationId)
      if (!row || row.peerId !== peerId || !row.initiatedLocally || row.peerPrepared || row.state === 'cancel-pending' || row.state === 'stale') continue
      let descriptor: OperationDescriptor
      let leaf: ManifestItem & { destFingerprint?: DestFingerprint | null }
      try {
        descriptor = parseDescriptor({ descriptor: row.descriptor })
        const f = row.files[0]
        const contentHash = f?.contentHash ?? descriptor.sourceFingerprint?.blake2b256 ?? ''
        if (!HEX64_RE.test(contentHash)) throw new EngineError('STALE_SOURCE', 'source hash missing')
        leaf = {
          relativePath: descriptor.source.relativePath,
          size: descriptor.size,
          mtimeMs: f?.sourceFingerprint?.mtimeMs ?? 0,
          contentHash: contentHash.toLowerCase(),
          destFingerprint: (descriptor.destFingerprint as DestFingerprint | null) ?? null
        }
      } catch {
        void this._parkAsStale(operationId, 'STALE_SOURCE')
        continue
      }
      if (this._drivingOperations.has(operationId)) continue
      this._drivingOperations.add(operationId)
      active += 1
      this._launchActiveByPeer.set(peerId, active)
      void this._runChain(session, descriptor, row.descriptorHash, leaf).finally(() => {
        this._drivingOperations.delete(operationId)
        const nextActive = Math.max(0, (this._launchActiveByPeer.get(peerId) ?? 1) - 1)
        if (nextActive) this._launchActiveByPeer.set(peerId, nextActive)
        else this._launchActiveByPeer.delete(peerId)
        this._pumpLaunchQueue(peerId)
      })
    }
    if (queue.head >= queue.ids.length) {
      this._launchQueues.delete(peerId)
    } else if (queue.head > 4096 && queue.head * 2 > queue.ids.length) {
      queue.ids = queue.ids.slice(queue.head)
      queue.head = 0
    }
  }

  /** local apply for our own receiver row during resume */
  private async _xopenLocal(
    session: PeerSession,
    descriptor: OperationDescriptor,
    hash: string,
    transferId: string,
    contentHash: string,
    destFingerprint: DestFingerprint | null,
    onStarted?: (done: Promise<string>) => void
  ) {
    return await this._xopen(
      session,
      { descriptor, descriptorHash: hash, transferId, contentHash, destFingerprint },
      onStarted,
      false
    )
  }

  async resumeAll(peerId?: string): Promise<{ started: string[]; waiting: string[] }> {
    const started: string[] = []
    const waiting: string[] = []
    const peerFilter = peerId ? peerId.toLowerCase() : undefined
    const rows = this.deps.journals.list({ peerId: peerFilter, state: ['queued', 'waiting-peer', 'finalizing', 'active', 'cancel-pending'] })

    // Recovery is per-operation ordered but not globally serialized. One dead
    // UNC root must not hold every unrelated journal row behind it.
    const recoveryFailed = new Set<string>()
    const recoveryRows = rows.filter((row) => row.role === 'receiver' && row.files[0]?.finalize)
    let recoveryIndex = 0
    const recoveryWorkers = Array.from({ length: Math.min(4, recoveryRows.length) }, async () => {
      for (;;) {
        const index = recoveryIndex++
        if (index >= recoveryRows.length) return
        const initial = recoveryRows[index]
        const current = this.deps.journals.get(initial.operationId)
        if (!current || current.role !== 'receiver' || !current.files[0]?.finalize) continue
        try {
          await this._recoverReceiverFinalize(current)
        } catch (err: unknown) {
          const code = errorCode(err) ?? 'IO'
          if (code === 'STALE_SOURCE' || code === 'STALE_DEST' || code === 'CONFLICT' || code === 'NOT_FOUND') {
            await this._parkAsStale(initial.operationId, code).catch(() => {})
          } else {
            recoveryFailed.add(initial.operationId)
          }
        }
      }
    })
    await Promise.all(recoveryWorkers)

    for (const initial of rows) {
      if (recoveryFailed.has(initial.operationId)) {
        waiting.push(initial.operationId)
        continue
      }
      let row = this.deps.journals.get(initial.operationId)
      if (!row) continue
      try {
        // Older builds could durably receive x-result, then park forever if the
        // independent Drive ACK was lost. pendingSuccessResult is itself proof
        // that the receiver reported a verified committed target, so finish it
        // locally even when that peer is currently offline.
        const pendingCommit = row.role === 'sender' ? row.files[0]?.pendingSuccessResult : null
        if (pendingCommit) {
          await this._settleSenderSuccess(row.operationId, pendingCommit.savedToBase)
          started.push(row.operationId)
          continue
        }

        if (row.state === 'active' && !this._receive.has(row.operationId) && !this._serving.has(row.operationId)) {
          await this.deps.journals.update(row.operationId, (r) => {
            r.state = 'waiting-peer'
            const file = r.files[0]
            if (file?.state === 'active') file.state = 'waiting-peer'
          }, true)
          row = this.deps.journals.get(row.operationId) ?? row
        }

        if (row.role === 'receiver' && row.state === 'finalizing' && row.files[0]?.finalize?.resultAcked === true) {
          if (await this._deliverPendingResult(row.operationId)) started.push(row.operationId)
          else {
            waiting.push(row.operationId)
            this._schedulePendingResultRetry(row.operationId)
          }
          continue
        }

        const session = this._sessionOf(row.peerId)
        if (!session) { waiting.push(row.operationId); continue }

        if (row.state === 'cancel-pending') {
          try {
            const reply = await this._req<unknown>(session, 'x-cancel', { operationId: row.operationId }, 30_000)
            const commitOwned = !!reply && typeof reply === 'object' && (reply as { terminalOwner?: unknown }).terminalOwner === 'commit'
            if (commitOwned) {
              if (row.role === 'sender') {
                await this._markRemoteCommitOwned(row.operationId)
                const current = this.deps.journals.get(row.operationId)
                if (current) waiting.push(row.operationId)
                else started.push(row.operationId)
              } else {
                // A receiver should not normally hear commit-owned from its
                // source.  Preserve the journal instead of deleting an
                // ambiguous terminal record.
                this._forgetCancelled(row.operationId)
                waiting.push(row.operationId)
              }
              continue
            }
            const cancelAccepted = !!reply && typeof reply === 'object' && (reply as { cancelAccepted?: unknown }).cancelAccepted === true
            if (row.role === 'sender' && !cancelAccepted) {
              // For sender rows the remote peer is the receiver, and only an
              // explicit marker from the fixed protocol proves cancellation
              // won before the receiver's commit boundary.
              waiting.push(row.operationId)
              continue
            }
            const leftoverPart = this.deps.journals.get(row.operationId)?.files[0]?.partPath
            if (leftoverPart) await this._rootUnlink(leftoverPart, true).catch(() => {})
            const batchId = this.deps.journals.batchIdForOperation(row.operationId)
            await this.deps.journals.remove(row.operationId)
            this._dropReceiver(row.operationId)
            this._dropServing(row.operationId)
            this._emit('operation.state', { operationId: row.operationId, state: 'cancelled', relativePath: journalRelativePath(row), ...(batchId ? { batchId } : {}) })
            started.push(row.operationId)
          } catch {
            waiting.push(row.operationId)
          }
          continue
        }

        if (row.initiatedLocally) {
          // A job we staged ourselves is a durable queue entry until the peer's
          // side exists. Replaying the initial handshake is its only recovery.
          if (!row.peerPrepared) {
            this._launchInitialFromJournal(session, row)
            started.push(row.operationId)
            continue
          }
        }

        if (row.role === 'receiver' && row.state === 'finalizing') {
          if (await this._deliverPendingResult(row.operationId)) started.push(row.operationId)
          else {
            waiting.push(row.operationId)
            this._schedulePendingResultRetry(row.operationId)
          }
          continue
        }

        // Once both journals exist, the bytes-receiver owns reconnect resume.
        // A sender waits for x-resume/x-open/x-ready from the peer.
        if (row.role !== 'receiver') continue
        const res = await this.resumeOperation(row.operationId)
        if (res.ok) started.push(row.operationId)
        else waiting.push(row.operationId)
      } catch (err: unknown) {
        const code = errorCode(err) ?? 'IO'
        if (code === 'STALE_SOURCE' || code === 'STALE_DEST' || code === 'CONFLICT' || code === 'NOT_FOUND') {
          await this._parkAsStale(initial.operationId, code).catch(() => {})
        } else {
          waiting.push(initial.operationId)
        }
      }
    }
    return { started, waiting }
  }

  async listResumable(
    cursor: string | null = null,
    limit = 128,
    peerId?: string | null
  ): Promise<{ operations: Array<Record<string, unknown>>; nextCursor: string | null }> {
    if (cursor && !SAFE_ID_RE.test(cursor)) throw new EngineError('INVALID_REQUEST', 'invalid operation cursor')
    const pageSize = Math.max(1, Math.min(128, Number.isSafeInteger(limit) ? limit : 128))
    const peerFilter = peerId ? peerId.toLowerCase() : undefined
    const page = this.deps.journals.listPage(
      { peerId: peerFilter, state: ['waiting-peer', 'queued', 'cancel-pending', 'stale', 'active', 'finalizing'] },
      cursor,
      pageSize
    )
    const operations = page.rows.map((r) => {
      const f: Partial<FileJournal> = r.files[0] ?? {}
      return {
        operationId: r.operationId,
        batchId: this.deps.journals.batchIdForOperation(r.operationId),
        peerId: r.peerId,
        role: r.role,
        state: r.state,
        // Keep this recovery/status RPC deliberately compact. Full endpoint and
        // part paths are available through the operation-specific recovery API;
        // returning them for every row can exceed the 1 MiB shell IPC frame on
        // deep paths even with count-based pagination.
        error: r.error ? String(r.error).slice(0, 512) : null,
        direction: this._directionOf(r),
        relativePath: f.relativePath ? String(f.relativePath).slice(0, 1024) : null,
        size: f.size ?? 0,
        bytesDone: f.bytesDone ?? 0,
        chunksDone: f.bitmapHex ? countBits(f.bitmapHex) : 0,
        chunksTotal: f.chunkCount ?? 0,
        initiatedLocally: r.initiatedLocally ?? false,
        peerPrepared: r.peerPrepared ?? false,
        finalizePhase: f.finalize?.phase ?? null,
        recoveryConflict: r.error === 'FINALIZE_RECOVERY_CONFLICT' && Boolean(f.finalize?.backupPath)
      }
    })
    return { operations, nextCursor: page.nextCursor }
  }

  batchStatus(batchId: string): { batchId: string; total: number; completed: number; remaining: number; done: boolean } {
    if (!SAFE_ID_RE.test(batchId)) throw new EngineError('INVALID_REQUEST', 'invalid batchId')
    const status = this.deps.journals.batchStatus(batchId)
    if (!status) throw new EngineError('NOT_FOUND', 'batch unknown')
    return status
  }

  private _directionOf(row: JournalRow): 'in' | 'out' {
    const d = row.descriptor
    if (row.role === 'receiver') return d.destination.deviceId === this.myId ? 'in' : 'out'
    return d.source.deviceId === this.myId ? 'out' : 'in'
  }

  private async _parkAsStale(operationId: string, reason: string): Promise<void> {
    const current = this.deps.journals.get(operationId)
    const partPath = current?.role === 'receiver' ? current.files[0]?.partPath ?? null : null
    await this.deps.journals.update(operationId, (r) => {
      r.state = 'stale'
      r.error = reason
      const f = r.files[0]
      if (f) f.state = 'stale'
    }, true)
    // File deletion is deliberately outside the journal mutation callback: no
    // detached async side effects can race with the durable stale checkpoint.
    if (partPath) await this._rootUnlink(partPath, true).catch(() => {})
    this._emit('operation.state', { operationId, state: 'stale', reason, relativePath: current?.descriptor.source.relativePath ?? null })
  }

  // ---------- copy orchestration (initiator) ----------
  async copy(req: CopyRequest, requestCancelToken?: RequestCancelToken): Promise<CopyResult> {
    const trackingKey = `copy:${uuidv4()}`
    const localRoots = new Set<string>()
    if (!req.destination?.peerId && req.destination?.rootId) localRoots.add(req.destination.rootId)
    for (const item of Array.isArray(req.items) ? req.items : []) {
      if (!item?.source?.peerId && item?.source?.rootId) localRoots.add(item.source.rootId)
    }
    this._openingOperationRoots.set(trackingKey, localRoots)
    try {
      // Register ownership before checking the gate. If removal wins first the
      // check fails; if copy wins first removal waits until durable acceptance
      // is complete and then invalidates the resulting rows.
      if (!req.destination?.peerId && req.destination?.rootId) {
        this._rootOrThrow(req.destination.rootId, 'write')
      }
      for (const item of Array.isArray(req.items) ? req.items : []) {
        if (!item?.source?.peerId && item?.source?.rootId) {
          this._rootOrThrow(item.source.rootId, 'read')
        }
      }
      return await this._copyTracked(req, requestCancelToken)
    } finally {
      this._openingOperationRoots.delete(trackingKey)
      for (const item of Array.isArray(req.items) ? req.items : []) {
        if (item?.preScanId) this.manifestCancel(item.preScanId)
      }
    }
  }

  private async _copyTracked(req: CopyRequest, requestCancelToken?: RequestCancelToken): Promise<CopyResult> {
    throwIfRequestCancelled(requestCancelToken)
    if (!Array.isArray(req.items) || req.items.length === 0) throw new EngineError('INVALID_REQUEST', 'items must not be empty')
    const collision: 'overwrite' | 'rename' = req.collision === 'overwrite' ? 'overwrite' : 'rename'
    const journalRows: Array<Omit<JournalRow, 'v' | 'createdAtMs' | 'updatedAtMs'>> = []
    const sessions = new Map<string, PeerSession>()

    // Full preflight first. Nothing is launched until every requested item has
    // been resolved and validated; a late error can therefore never leave an
    // earlier detached transfer running behind a failed fs.copy RPC.  Keep one
    // representation per file (the journal row) instead of manifest + plan +
    // journal copies, which materially reduces peak RAM on 100k-file batches.
    for (const item of req.items) {
      throwIfRequestCancelled(requestCancelToken)
      if (!item?.source) throw new EngineError('INVALID_REQUEST', 'item.source missing')
      const dest = req.destination
      const isLocalSource = !item.source.peerId
      const isLocalDest = !dest.peerId
      if (isLocalSource === isLocalDest) {
        throw new EngineError('INVALID_REQUEST', isLocalDest
          ? 'copy to self without remote is not supported (use MANIFEST-based pull)'
          : 'copy must have exactly one local endpoint')
      }
      const leaves = await this._resolveSourceLeaves(item.source, req.preFlashed, requestCancelToken, item.preScanId)
      throwIfRequestCancelled(requestCancelToken)
      for (let leafIndex = 0; leafIndex < leaves.length; leafIndex++) {
        const leaf = leaves[leafIndex]
        throwIfRequestCancelled(requestCancelToken)
        if (!Number.isSafeInteger(leaf.size) || leaf.size < 0 || leaf.size > MAX_TRANSFER_SIZE_BYTES) {
          throw new EngineError('LIMIT_EXCEEDED', `file exceeds supported transfer size: ${leaf.relativePath}`)
        }
        if (journalRows.length >= PUT_FILES_MAX) throw new EngineError('LIMIT_EXCEEDED', `copy exceeds ${PUT_FILES_MAX} files`)
        const srcRel = leaf.relativePath
        const destRel = item.destinationRelativePath !== undefined
          ? validateRelativePath(item.destinationRelativePath, { allowEmpty: false, field: 'destinationRelativePath' })
          : destRelOf(dest.relativePath ?? '', item.source.relativePath ?? '', srcRel)
        const itemCollision: 'overwrite' | 'rename' = item.collision === 'overwrite' ? 'overwrite' : collision
        const chunkSize = selectChunkSize(leaf.size)
        const destFp = leaf.destFingerprint ?? null
        const descriptor: OperationDescriptor = {
          operationId: uuidv4(),
          source: {
            deviceId: item.source.peerId ? normalizeDeviceHex(item.source.peerId) : this.myId,
            rootId: item.source.rootId,
            relativePath: srcRel
          },
          destination: {
            deviceId: dest.peerId ? normalizeDeviceHex(dest.peerId) : this.myId,
            rootId: dest.rootId,
            relativePath: destRel
          },
          collision: itemCollision,
          size: leaf.size,
          chunkSize,
          sourceFingerprint: { size: leaf.size, blake2b256: leaf.contentHash.toLowerCase() },
          destFingerprint: destFp,
          createdAtMs: Date.now()
        }
        const other = descriptor.source.deviceId === this.myId ? descriptor.destination.deviceId : descriptor.source.deviceId
        const session = this._session(other)
        sessions.set(session.peerId, session)
        const hash = coreHashOf(descriptor)
        journalRows.push(await this._buildInitiatedOperation(session.peerId, descriptor, hash, leaf))
        // The manifest snapshot has already been cancelled; release each leaf as
        // soon as its durable-row representation exists instead of retaining two
        // full object graphs until the whole directory has been transformed.
        leaves[leafIndex] = null as unknown as typeof leaf
      }
      // Release manifest leaf arrays before processing the next selected root.
      // The durable journal rows now carry every hint needed to launch later.
      leaves.length = 0
    }

    throwIfRequestCancelled(requestCancelToken)
    const staged = journalRows.map((row) => row.operationId)
    const batchId = journalRows.length ? uuidv4() : null
    if (batchId) {
      await this.deps.journals.putBatch(batchId, journalRows, () => requestCancelToken?.cancelled === true)
    }
    if (requestCancelToken?.cancelled) {
      if (batchId) await this.deps.journals.abortAcceptedBatch(batchId, staged)
      throw new EngineError('CANCELLED', 'request cancelled')
    }

    // Durable acceptance owns the canonical row objects now; drop the staging
    // array before filling the dispatcher so a 100k copy does not retain an
    // extra top-level row graph throughout launch scheduling.
    journalRows.length = 0
    // Keep only the actual transfer concurrency in live async chains. The rest
    // remain cheap journal rows plus operation IDs in the dispatcher queue.
    for (const operationId of staged) {
      const row = this.deps.journals.get(operationId)
      if (row && (sessions.get(row.peerId) ?? this._sessionOf(row.peerId))) this._queueInitialLaunch(row)
    }
    return {
      batchId,
      acceptedCount: staged.length,
      operationIds: staged.length <= COPY_INLINE_OPERATION_IDS_MAX ? staged : []
    }
  }

  private async _buildInitiatedOperation(
    peerId: string,
    descriptor: OperationDescriptor,
    hash: string,
    leaf: ManifestItem & { destFingerprint?: DestFingerprint | null }
  ): Promise<Omit<JournalRow, 'v' | 'createdAtMs' | 'updatedAtMs'>> {
    if (this.deps.journals.get(descriptor.operationId)) throw new EngineError('CONFLICT', 'operation already exists')
    const localIsSource = descriptor.source.deviceId === this.myId
    const role = localIsSource ? 'sender' : 'receiver'
    let partPath: string | null = null
    if (!localIsSource) {
      const root = this._rootOrThrow(descriptor.destination.rootId, 'write')
      validateRelativePath(descriptor.destination.relativePath)
      // Staging is intentionally filesystem-side-effect free apart from the
      // protected journal; parent creation/path reparse verification happens
      // when x-open actually acquires the destination lock.
      partPath = partPathFor(joinNativePart(root.physicalPath, descriptor.destination.relativePath))
    }
    const chunkSize = selectChunkSize(descriptor.size)
    return {
      operationId: descriptor.operationId,
      descriptor,
      descriptorHash: hash,
      role,
      peerId,
      state: 'queued',
      initiatedLocally: true,
      peerPrepared: false,
      files: [{
        relativePath: fileName(descriptor.source.relativePath),
        size: descriptor.size,
        chunkSize,
        chunkCount: chunkCount(descriptor.size, chunkSize),
        contentHash: leaf.contentHash,
        // This is journal-local recovery/optimisation metadata. mtimeMs is
        // intentionally NOT part of the canonical wire descriptor.
        sourceFingerprint: { size: leaf.size, mtimeMs: leaf.mtimeMs ?? 0, blake2b256: leaf.contentHash },
        destFingerprint: leaf.destFingerprint
          ? { size: leaf.destFingerprint.size, blake2b256: leaf.destFingerprint.blake2b256 }
          : null,
        bitmapHex: null,
        bytesDone: 0,
        partPath,
        savedTo: null,
        finalize: null,
        fileId: null,
        state: 'queued',
        error: null
      }]
    }
  }

  /** returns leaves with size + contentHash (hash computed locally on source). */
  private async _resolveSourceLeaves(
    source: EndpointRef,
    preFlashed?: CopyRequest['preFlashed'],
    requestCancelToken?: RequestCancelToken,
    preScanId?: string
  ): Promise<Array<ManifestItem & { destFingerprint?: DestFingerprint | null }>> {
    throwIfRequestCancelled(requestCancelToken)
    if (preScanId) {
      const snap = this._snapshotOrThrow(preScanId)
      const expectedPeer = source.peerId ? source.peerId.toLowerCase() : null
      const actualPeer = snap.peerId ? snap.peerId.toLowerCase() : null
      const expectedPath = (source.relativePath || '').replace(/^\/+|\/+$/g, '')
      const snapPath = (snap.relativePath || '').replace(/^\/+|\/+$/g, '')
      if (snap.rootId !== source.rootId || actualPeer !== expectedPeer || snapPath !== expectedPath) {
        throw new EngineError('STALE_SCAN', 'prepared manifest does not belong to this copy source')
      }
      // preScanId is intentionally accepted only for directory selections. A
      // prepared directory manifest stores leaves relative to the scan root;
      // re-prefix them exactly once for the canonical copy descriptor.
      return snap.items.map((item) => ({
        relativePath: joinRel(source.relativePath, item.relativePath),
        size: item.size,
        mtimeMs: item.mtimeMs,
        contentHash: item.contentHash,
        destFingerprint: null
      }))
    }
    const flashed = (preFlashed ?? []).filter((p) => {
      const sel = (source.relativePath || '').replace(/^\/+|\/+$/g, '')
      const pth = (p.relativePath || '').replace(/^\/+|\/+$/g, '')
      if (!sel) return true
      return pth === sel || pth.startsWith(sel + '/')
    })
    if (flashed.length) {
      return flashed.map((p) => ({
        relativePath: p.relativePath,
        size: p.size,
        mtimeMs: p.mtimeMs ?? 0,
        contentHash: p.contentHash,
        destFingerprint: p.destFingerprint ?? null
      }))
    }
    if (!source.peerId) {
      const root = this._rootOrThrow(source.rootId, 'read')
      const entry = await this._rootStatPath(root.physicalPath, source.relativePath ?? '', () => requestCancelToken?.cancelled === true)
      if (!entry) throw new EngineError('NOT_FOUND', 'source missing')
      if (entry.type === 'file') {
        let stable
        try {
          stable = await this._rootStableHash(root.physicalPath, entry.relativePath, () => requestCancelToken?.cancelled === true)
        } catch (err: unknown) {
          const code = (err as { code?: string })?.code
          if (code === 'STALE_SCAN' || code === 'NOT_FOUND') throw new EngineError('STALE_SOURCE', 'source changed during preflight hash')
          throw err
        }
        throwIfRequestCancelled(requestCancelToken)
        return [stable]
      }
      if (entry.type === 'dir') {
        const snap = await this.manifestStart({ peerId: null, rootId: source.rootId, relativePath: source.relativePath }, null, null, undefined, undefined, requestCancelToken)
        try {
          for (const item of snap.items) item.relativePath = joinRel(source.relativePath, item.relativePath)
          return snap.items
        } finally {
          this.manifestCancel(snap.scanId)
        }
      }
      throw new EngineError('NOT_ALLOWED', 'source is not a file/dir')
    }
    const entry = (await this.stat(source)).entry
    if (!entry) throw new EngineError('NOT_FOUND', 'remote source missing')
    if (entry.type === 'file') {
      const hashed = parseRemoteHashResponse(await this._req<unknown>(
        this._session(source.peerId),
        'fs.hash',
        { rootId: source.rootId, relativePath: source.relativePath ?? '' },
        300_000
      ))
      throwIfRequestCancelled(requestCancelToken)
      return [{ relativePath: source.relativePath ?? hashed.relativePath, size: hashed.size, mtimeMs: hashed.mtimeMs, contentHash: hashed.contentHash }]
    }
    const snap = await this.manifestStart({ peerId: source.peerId, rootId: source.rootId, relativePath: source.relativePath }, null, null, undefined, undefined, requestCancelToken)
    try {
      for (const item of snap.items) item.relativePath = joinRel(source.relativePath, item.relativePath)
      return snap.items
    } finally {
      this.manifestCancel(snap.scanId)
    }
  }

  private async _runChain(
    session: PeerSession,
    descriptor: OperationDescriptor,
    hash: string,
    leaf: { relativePath: string; size: number; mtimeMs?: number; contentHash: string; destFingerprint?: DestFingerprint | null }
  ): Promise<void> {
    const operationId = descriptor.operationId
    const transferId = newTransferId()
    const destFp = leaf.destFingerprint ?? descriptor.destFingerprint ?? null
    try {
      this._throwIfOperationCancelled(operationId, session.peerId)
      await this._gate(descriptor.source.deviceId === this.myId ? descriptor.destination.deviceId : descriptor.source.deviceId, async () => {
        this._throwIfOperationCancelled(operationId, session.peerId)
        const leafName = fileName(descriptor.source.relativePath)
        if (descriptor.source.deviceId === this.myId) {
          await this._xinitLocalSafe(session, descriptor, hash, leaf)
          this._throwIfOperationCancelled(operationId, session.peerId)
          await this._req<{ ok: true; resume: { bitmapHex: string } | null }>(
            session,
            'x-open',
            { descriptor, descriptorHash: hash, transferId, contentHash: leaf.contentHash, destFingerprint: destFp },
            120_000
          )
          this._throwIfOperationCancelled(operationId, session.peerId)
          await this.deps.journals.update(operationId, (r) => { r.peerPrepared = true }, true)
          this._throwIfOperationCancelled(operationId, session.peerId)
          let senderDone: Promise<string> | null = null
          await this._xready(
            session,
            { operationId, transferId, relativePath: leafName, descriptorHash: hash },
            (done) => { senderDone = done },
            false
          )
          if (!senderDone) throw new EngineError('IO', 'sender session did not start')
          await senderDone
        } else {
          const remote = this._session(descriptor.source.deviceId)
          await this._req(remote, 'x-init', {
            descriptor,
            descriptorHash: hash,
            contentHashHint: leaf.contentHash,
            sourceMtimeMs: leaf.mtimeMs
          }, 120_000)
          this._throwIfOperationCancelled(operationId, session.peerId)
          await this.deps.journals.update(operationId, (r) => { r.peerPrepared = true }, true)
          this._throwIfOperationCancelled(operationId, session.peerId)
          let receiverDone: Promise<string> | null = null
          await this._xopenLocal(
            remote,
            descriptor,
            hash,
            transferId,
            leaf.contentHash,
            destFp,
            (done) => { receiverDone = done }
          )
          this._throwIfOperationCancelled(operationId, session.peerId)
          await this._req(remote, 'x-ready', { operationId, transferId, relativePath: leafName, descriptorHash: hash }, 120_000)
          if (!receiverDone) throw new EngineError('IO', 'receiver session did not start')
          await receiverDone
        }
      })
      this._clearLaunchRetry(operationId)
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code ?? 'IO'
      const message = String((err as { message?: string })?.message ?? err)
      dbg('chain failed', operationId, code, message, String((err as { stack?: string })?.stack ?? '').split('\n').slice(0, 3).join(' | '))
      const current = this.deps.journals.get(operationId)
      if (code === 'CANCELLED' && (this._operationIsCancelled(operationId, session.peerId) || !current || current.state === 'cancel-pending')) {
        return
      }
      const transientAdmission = code === 'LIMIT_EXCEEDED' || code === 'BUSY'
      if (transientAdmission) {
        // In the pull path x-openLocal creates a live receiver before the peer
        // accepts x-ready. If that admission request loses a race with cleanup
        // from the previous file, tear the provisional receiver down before
        // retrying; otherwise the retry can collide with its own stale session.
        await this._stopLiveOperation(operationId, `Transient peer admission failed: ${code}`).catch(() => {})
        this._dropReceiver(operationId)
        this._dropServing(operationId)
      }
      const stale = ['STALE_SOURCE', 'STALE_DEST', 'CONFLICT'].includes(code)
      if (stale) {
        await this._parkAsStale(operationId, String(code)).catch(() => {})
        // Do not use an unbounded fire-and-forget event for a durable remote
        // state mutation. The request path is bounded by WireChannel.
        await this._req(session, 'x-stale', { operationId, code }, 30_000).catch(() => {})
      } else if (this.deps.journals.get(operationId)) {
        await this.deps.journals.update(operationId, (r) => {
          if (r.state === 'stale' || r.state === 'cancel-pending') return
          r.state = 'waiting-peer'
          r.error = message
          const f = r.files[0]
          if (f && f.state !== 'finalizing' && f.state !== 'stale') f.state = 'waiting-peer'
        }, true).catch(() => {})
      }
      // A transient admission race or an operation-scoped timeout is safe to
      // retry on a bounded timer. Everything else stays durable in
      // waiting-peer and is only retried by reconnect recovery.
      if (!stale && this._isRetryableLiveTransferError(code) && this._sessionOf(session.peerId)) {
        this._scheduleLaunchRetry(operationId, session.peerId)
      } else {
        this._clearLaunchRetry(operationId)
      }
      this._emit('operation.state', {
        operationId,
        state: stale ? 'stale' : 'waiting-peer',
        phase: 'chain',
        error: message,
        peerId: session.peerId,
        relativePath: descriptor.source.relativePath,
        direction: descriptor.source.deviceId === this.myId ? 'out' : 'in'
      })
    }
  }

  /**
   * Failures that a bounded local retry can plausibly clear. Admission races
   * mean the peer was momentarily full; an operation-scoped timeout means that
   * one request exceeded its deadline while the transport stayed healthy.
   * Deliberate refusals (NOT_ALLOWED, STALE_*, CONFLICT) are never retried
   * here: they would repeat forever against the same peer.
   */
  private _isRetryableLiveTransferError(code: string): boolean {
    return code === 'LIMIT_EXCEEDED' || code === 'BUSY' || code === 'TIMEOUT' || code === 'IO'
  }

  private async _xinitLocalSafe(session: PeerSession, descriptor: OperationDescriptor, hash: string, leaf: { relativePath: string; size: number; mtimeMs?: number; contentHash: string }): Promise<void> {
    const existing = this.deps.journals.get(descriptor.operationId)
    if (existing) {
      if (existing.descriptorHash !== hash) throw new EngineError('CONFLICT', 'op identity changed')
      if (!existing.files[0]?.contentHash) {
        await this.deps.journals.update(descriptor.operationId, (r) => {
          r.files[0].contentHash = leaf.contentHash
        }, true)
      }
      return
    }
    await this.deps.journals.put({
      operationId: descriptor.operationId,
      descriptor,
      descriptorHash: hash,
      role: 'sender',
      peerId: session.peerId,
      state: 'waiting-peer',
      files: [{
        relativePath: fileName(descriptor.source.relativePath),
        size: descriptor.size,
        chunkSize: selectChunkSize(descriptor.size),
        chunkCount: chunkCount(descriptor.size, selectChunkSize(descriptor.size)),
        contentHash: leaf.contentHash,
        sourceFingerprint: { size: leaf.size, mtimeMs: leaf.mtimeMs ?? 0, blake2b256: leaf.contentHash },
        destFingerprint: null,
        bitmapHex: null,
        bytesDone: 0,
        partPath: null,
        savedTo: null,
        fileId: null,
        state: 'queued',
        error: null
      }]
    }, true)
  }

  private async resumePending(operationId: string): Promise<void> {
    await this.resumeOperation(operationId)
  }

  // ---------- sync ----------
  async syncPreview(
    source: EndpointRef,
    destination: EndpointRef,
    filter?: FilterSpec | null,
    requestCancelToken?: RequestCancelToken
  ): Promise<{ previewId: string; expiresAtMs: number; totals: Record<string, number>; sourceScanId: string | null }> {
    throwIfRequestCancelled(requestCancelToken)
    if (this._previewBuildInProgress) throw new EngineError('BUSY', 'sync preview already in progress')
    this._previewBuildInProgress = true
    try {
      return await this._buildSyncPreview(source, destination, filter, requestCancelToken)
    } finally {
      this._previewBuildInProgress = false
    }
  }

  private async _buildSyncPreview(
    source: EndpointRef,
    destination: EndpointRef,
    filter?: FilterSpec | null,
    requestCancelToken?: RequestCancelToken
  ): Promise<{ previewId: string; expiresAtMs: number; totals: Record<string, number>; sourceScanId: string | null }> {
    throwIfRequestCancelled(requestCancelToken)
    if (!source.peerId === !destination.peerId) throw new EngineError('INVALID_REQUEST', 'sync must be remote<->local')
    const sourceScanHint = uuidv4()
    const destScanHint = uuidv4()
    this._transientSnapshotPins.add(sourceScanHint)
    this._transientSnapshotPins.add(destScanHint)
    let sourceSnapshotId: string | null = null
    let destinationSnapshotId: string | null = null
    let sourceOwnershipTransferred = false
    try {
      const emitCompare = (phase: 'compare-source' | 'compare-dest', filesDone: number, bytesDone: number) => {
        this._emit('sync.progress', { phase, filesDone, bytesDone })
      }

      emitCompare('compare-source', 0, 0)
      emitCompare('compare-dest', 0, 0)
      const sourcePromise = this.manifestStart(source, filter ?? null, null, (filesDone, bytesDone) => {
        emitCompare('compare-source', filesDone, bytesDone)
      }, sourceScanHint, requestCancelToken)
      const destPromise = this.manifestStart(destination, null, null, (filesDone, bytesDone) => {
        emitCompare('compare-dest', filesDone, bytesDone)
      }, destScanHint, requestCancelToken)

      const [srcResult, dstResult] = await Promise.allSettled([sourcePromise, destPromise])
      if (srcResult.status === 'fulfilled') sourceSnapshotId = srcResult.value.scanId
      if (dstResult.status === 'fulfilled') destinationSnapshotId = dstResult.value.scanId
      throwIfRequestCancelled(requestCancelToken)
      if (srcResult.status === 'rejected') throw srcResult.reason
      const srcSnap = srcResult.value
      let dstItems: ManifestItem[] = []
      if (dstResult.status === 'fulfilled') {
        dstItems = dstResult.value.items
      } else {
        const code = (dstResult.reason as { code?: string })?.code
        if (code !== 'NOT_FOUND') throw dstResult.reason
      }

      // Both manifests are frozen and sorted by relativePath. Merge them in
      // one pass instead of building a second 100k-entry Map for destination
      // metadata. This keeps sync-preview peak RAM close to the two required
      // snapshots plus the actionable preview rows.
      const items: Preview['items'] = []
      const totals: Record<string, number> = { new: 0, changed: 0, skipped: 0, 'remote-only': 0, conflict: 0, error: 0, bytes: 0 }
      let destIndex = 0
      for (const sourceItem of srcSnap.items) {
        throwIfRequestCancelled(requestCancelToken)
        while (
          destIndex < dstItems.length &&
          !samePortablePath(dstItems[destIndex].relativePath, sourceItem.relativePath) &&
          comparePortablePaths(dstItems[destIndex].relativePath, sourceItem.relativePath) < 0
        ) {
          totals['remote-only']++
          destIndex++
        }
        const destItem = destIndex < dstItems.length && samePortablePath(dstItems[destIndex].relativePath, sourceItem.relativePath)
          ? dstItems[destIndex]
          : null
        if (!destItem) {
          items.push({ relativePath: sourceItem.relativePath, status: 'new', sourceSize: sourceItem.size, sourceHash: sourceItem.contentHash })
          totals.new++
          totals.bytes += sourceItem.size
          continue
        }
        destIndex++
        const destFingerprint = { size: destItem.size, blake2b256: destItem.contentHash }
        if (destItem.contentHash === sourceItem.contentHash) {
          totals.skipped++
        } else {
          items.push({ relativePath: sourceItem.relativePath, status: 'changed', sourceSize: sourceItem.size, sourceHash: sourceItem.contentHash, destFingerprint })
          totals.changed++
          totals.bytes += sourceItem.size
        }
      }
      totals['remote-only'] += dstItems.length - destIndex
      throwIfRequestCancelled(requestCancelToken)
      const previewId = uuidv4()
      const expiresAtMs = Date.now() + SCAN_TTL_MS
      this._storePreview(previewId, {
        expiresAtMs,
        source: { ...source, deviceIdN: source.peerId ? normalizeDeviceHex(source.peerId) : this.myId },
        destination: { ...destination, deviceIdN: destination.peerId ? normalizeDeviceHex(destination.peerId) : this.myId },
        sourceScanId: srcSnap.scanId,
        items
      })
      sourceOwnershipTransferred = true
      return { previewId, expiresAtMs, totals, sourceScanId: srcSnap.scanId }
    } finally {
      this._transientSnapshotPins.delete(sourceScanHint)
      this._transientSnapshotPins.delete(destScanHint)
      if (destinationSnapshotId) this.manifestCancel(destinationSnapshotId)
      if (sourceSnapshotId && !sourceOwnershipTransferred) this.manifestCancel(sourceSnapshotId)
    }
  }

  syncCancel(previewId: string): { ok: true } {
    this._dropPreview(previewId)
    return { ok: true }
  }

  async syncStart(
    previewId: string,
    itemPaths?: string[],
    requestCancelToken?: RequestCancelToken
  ): Promise<CopyResult> {
    throwIfRequestCancelled(requestCancelToken)
    const pv = this._previews.get(previewId)
    if (!pv) throw new EngineError('NOT_FOUND', 'preview unknown')
    if (pv.expiresAtMs < Date.now()) {
      this._previews.delete(previewId)
      if (pv.sourceScanId) this.manifestCancel(pv.sourceScanId)
      throw new EngineError('STALE_SCAN', 'preview expired')
    }

    let selected: Set<string> | null = null
    if (itemPaths !== undefined) {
      selected = new Set(itemPaths.map((item) => validateRelativePath(item, { allowEmpty: false, field: 'itemPaths' })))
      const known = new Set(pv.items.map((item) => item.relativePath))
      for (const item of selected) {
        if (!known.has(item)) throw new EngineError('INVALID_REQUEST', `itemPaths entry is not in preview: ${item}`)
      }
    }

    const pending = pv.items.filter((item) =>
      (item.status === 'new' || item.status === 'changed') &&
      item.sourceHash &&
      pv.sourceScanId &&
      (!selected || selected.has(item.relativePath))
    )
    const srcSnap = this._snapshotOrThrow(pv.sourceScanId!)
    this._previews.delete(previewId)
    try {
      if (!pending.length) return { batchId: null, acceptedCount: 0, operationIds: [] }
      const copyItems: CopyItemInput[] = []
      const flashed: NonNullable<CopyRequest['preFlashed']> = []
      let sourceIndex = 0
      for (const item of pending) {
        throwIfRequestCancelled(requestCancelToken)
        while (sourceIndex < srcSnap.items.length && comparePortablePaths(srcSnap.items[sourceIndex].relativePath, item.relativePath) < 0) sourceIndex++
        const manifestItem = sourceIndex < srcSnap.items.length && srcSnap.items[sourceIndex].relativePath === item.relativePath
          ? srcSnap.items[sourceIndex]
          : null
        if (!manifestItem) throw new EngineError('STALE_SCAN', `source item missing from frozen manifest: ${item.relativePath}`)
        sourceIndex++
        const srcFull = joinRel(srcSnap.relativePath, manifestItem.relativePath)
        const destFull = joinRel(pv.destination.relativePath, manifestItem.relativePath)
        copyItems.push({
          source: { peerId: pv.source.peerId ?? null, rootId: pv.source.rootId, relativePath: srcFull },
          destinationRelativePath: destFull,
          collision: item.status === 'changed' ? 'overwrite' : 'rename'
        })
        flashed.push({
          relativePath: srcFull,
          size: manifestItem.size,
          mtimeMs: manifestItem.mtimeMs,
          contentHash: manifestItem.contentHash,
          destFingerprint: item.destFingerprint ?? null
        })
      }
      // One copy() call means one durable acceptance record: sync is all-or-none
      // before any chain starts, even when it mixes new and overwrite rows.
      return await this.copy({
        destination: { peerId: pv.destination.peerId ?? null, rootId: pv.destination.rootId, relativePath: pv.destination.relativePath },
        items: copyItems,
        collision: 'rename',
        preFlashed: flashed
      }, requestCancelToken)
    } finally {
      this.manifestCancel(srcSnap.scanId)
    }
  }

  private async _acquireDestinationLock(targetAbs: string, _operationId: string): Promise<() => void> {
    if (this._destroyed) throw new EngineError('CANCELLED', 'engine destroyed')
    const key = targetAbs.toLowerCase()
    let gate = this._destinationLocks.get(key)
    if (!gate) {
      gate = { active: false, waiters: [] }
      this._destinationLocks.set(key, gate)
    }
    if (!gate.active) gate.active = true
    else await new Promise<void>((resolve, reject) => gate!.waiters.push({ resolve, reject }))

    let released = false
    return () => {
      if (released) return
      released = true
      const current = this._destinationLocks.get(key)
      if (!current) return
      const next = current.waiters.shift()
      if (next) {
        next.resolve()
        return
      }
      current.active = false
      this._destinationLocks.delete(key)
    }
  }

  // ---------- per-peer transfer scheduler ----------
  /**
   * Admission control for remote-initiated x-open. Unlike the local scheduler,
   * a peer request must never enqueue an unbounded waiter: reject immediately
   * when its transfer window is full and hold the permit for the receiver's
   * complete lifetime.
   */
  private _tryAcquirePeerTransfer(peerKey: string): (() => void) | null {
    if (this._destroyed) return null
    const key = (peerKey || '').toLowerCase() || 'local'
    let gate = this._peerTransferGates.get(key)
    if (!gate) {
      gate = { active: 0, waiters: [] }
      this._peerTransferGates.set(key, gate)
    }
    if (gate.active >= CONCURRENT_TRANSFERS_PER_PEER) return null
    gate.active++

    let released = false
    return () => {
      if (released) return
      released = true
      const current = this._peerTransferGates.get(key)
      if (!current) return
      const next = current.waiters.shift()
      if (next) {
        // Hand this permit to an already queued local operation.
        next.resolve()
        return
      }
      current.active = Math.max(0, current.active - 1)
      if (current.active === 0) this._peerTransferGates.delete(key)
    }
  }

  private async _acquirePeerTransfer(peerKey: string): Promise<() => void> {
    if (this._destroyed) throw new EngineError('CANCELLED', 'engine destroyed')
    const key = (peerKey || '').toLowerCase() || 'local'
    let gate = this._peerTransferGates.get(key)
    if (!gate) {
      gate = { active: 0, waiters: [] }
      this._peerTransferGates.set(key, gate)
    }

    if (gate.active < CONCURRENT_TRANSFERS_PER_PEER) {
      gate.active++
    } else {
      // FIFO hand-off: release() transfers an existing permit directly to the
      // oldest waiter, so a newly arriving transfer cannot jump the queue or
      // temporarily exceed the configured limit.
      await new Promise<void>((resolve, reject) => gate!.waiters.push({ resolve, reject }))
    }

    let released = false
    return () => {
      if (released) return
      released = true
      const current = this._peerTransferGates.get(key)
      if (!current) return
      const next = current.waiters.shift()
      if (next) {
        // Keep `active` unchanged: the permit is handed directly to the waiter.
        next.resolve()
        return
      }
      current.active = Math.max(0, current.active - 1)
      if (current.active === 0) this._peerTransferGates.delete(key)
    }
  }

  private async _gate(peerKey: string, fn: () => Promise<void>): Promise<void> {
    const release = await this._acquirePeerTransfer(peerKey)
    try {
      await fn()
    } finally {
      release()
    }
  }

  public _emitWarn = (..._a: unknown[]) => {}
}

// ---------------- helpers ----------------
/**
 * Validate a wire/journal descriptor into the canonical OperationDescriptor.
 * Endpoints are normalised (lowercase deviceId, validated non-empty file path)
 * so descriptorHash is computed over one representation. Unknown wire fields
 * are deliberately discarded before journaling: protocol extensions must be
 * added explicitly instead of becoming peer-controlled persistent baggage.
 */
export function parseDescriptor(r: unknown): OperationDescriptor {
  const d = isRecord(r) ? r.descriptor : undefined
  if (!isRecord(d)) throw new EngineError('INVALID_REQUEST', 'descriptor must be an object')
  const operationId = requireStr(d, 'operationId', ID_MAX_LEN)
  if (!SAFE_ID_RE.test(operationId)) throw new EngineError('INVALID_REQUEST', 'operationId')
  const endpoints = {} as Pick<OperationDescriptor, 'source' | 'destination'>
  for (const key of ['source', 'destination'] as const) {
    const ep = d[key]
    if (!isRecord(ep)) throw new EngineError('INVALID_REQUEST', `descriptor.${key} must be endpoint`)
    const deviceId = requireStr(ep, 'deviceId', 64).toLowerCase()
    const rootId = requireStr(ep, 'rootId', ID_MAX_LEN)
    if (!SAFE_ID_RE.test(rootId)) throw new EngineError('INVALID_REQUEST', `descriptor.${key}.rootId`)
    if (typeof ep.relativePath !== 'string') throw new EngineError('INVALID_REQUEST', `descriptor.${key}.relativePath`)
    let relativePath: string
    try {
      relativePath = validateRelativePath(ep.relativePath, { allowEmpty: false, field: `${key}.relativePath` })
    } catch (err: unknown) {
      if (err instanceof PathError) throw new EngineError(err.code, err.message)
      throw err
    }
    endpoints[key] = { deviceId, rootId, relativePath }
  }
  const { collision, size, chunkSize, createdAtMs } = d
  if (collision !== 'rename' && collision !== 'overwrite') throw new EngineError('INVALID_REQUEST', 'collision')
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > MAX_TRANSFER_SIZE_BYTES) throw new EngineError('INVALID_REQUEST', 'size')
  if (typeof chunkSize !== 'number' || !Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new EngineError('INVALID_REQUEST', 'chunkSize')
  if (typeof createdAtMs !== 'number' || !Number.isFinite(createdAtMs)) throw new EngineError('INVALID_REQUEST', 'createdAtMs')
  const sourceFingerprint = parseFingerprint(d.sourceFingerprint, 'sourceFingerprint')
  if (!sourceFingerprint || sourceFingerprint.size !== size) {
    throw new EngineError('INVALID_REQUEST', 'sourceFingerprint must bind descriptor size')
  }
  const destFingerprint = parseFingerprint(d.destFingerprint, 'destFingerprint')
  return {
    operationId,
    source: endpoints.source,
    destination: endpoints.destination,
    collision,
    size,
    chunkSize,
    createdAtMs,
    sourceFingerprint,
    destFingerprint
  }
}

function parseFingerprint(value: unknown, field: string): DestFingerprint | null {
  if (value === undefined || value === null) return null
  if (!isRecord(value) || typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > MAX_TRANSFER_SIZE_BYTES) {
    throw new EngineError('INVALID_REQUEST', `${field}.size`)
  }
  const hash = value.blake2b256
  if (hash !== undefined && hash !== null && (typeof hash !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hash))) {
    throw new EngineError('INVALID_REQUEST', `${field}.blake2b256`)
  }
  return { size: value.size, blake2b256: typeof hash === 'string' ? hash.toLowerCase() : null }
}

export { joinNativePart }
