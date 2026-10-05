// Persistent operation journals.
// Sender and receiver roles keep their own journals so a restart (or a kill
// of BOTH processes) can reconstruct the operation. `.part` + journal are
// preserved for transport loss; discarded only for user cancel / stale rules.
// Checkpoint discipline: temp + atomic rename, journal never ahead of written
// bytes, fsync before rename, batched flushes.

import fs from 'bare-fs/promises'
import path from 'bare-path'
import b4a from 'b4a'
import { writeFileAtomic } from './pathguard'
import { dbg } from './log'
import { errorCode, isErrnoCode } from './errors'
import { decodeProtectedJson, encodeProtectedJson } from './protected-json'
import type { CanonicalValue } from './encoding'
import { SAFE_ID_RE } from './limits'
import { openFile, bytesReadOf, bytesWrittenOf } from './fs-handle'
import { IsolatedIoWorker, canUseIsolatedIoWorker } from './io-worker-client'

const ROW_IO_CONCURRENCY = 4

export type JournalRole = 'sender' | 'receiver'
export type State =
  | 'queued'
  | 'active'
  | 'waiting-peer'
  | 'cancel-pending'
  | 'finalizing'
  | 'done'
  | 'stale'

export type RecoveryErrorScope = 'TRANSPORT' | 'PEER_PROTOCOL' | 'OPERATION' | 'FILE' | 'FINALIZE' | 'USER_ACTION'

export interface RecoveryState {
  generation: number
  leaseId: string | null
  attempts: number
  lastAttemptAtMs: number | null
  nextAttemptAtMs: number | null
  lastErrorCode: string | null
  lastErrorScope: RecoveryErrorScope | null
  requiresUserAction: boolean
  blocked: boolean
}

export interface FileJournal {
  relativePath: string
  size: number
  chunkSize: number
  chunkCount: number
  contentHash?: string | null
  sourceFingerprint?: { size: number; mtimeMs: number; blake2b256?: string | null } | null
  destFingerprint?: { size: number; mtimeMs?: number; blake2b256?: string | null; contentHash?: string | null } | null
  /** bytes-receiver only: */
  bitmapHex?: string | null
  bytesDone?: number
  partPath?: string | null
  savedTo?: string | null
  /** crash-safe same-directory finalize transaction */
  finalize?: {
    phase: 'prepared' | 'backup-created' | 'target-replaced'
    targetPath: string
    backupPath?: string | null
    /** namespace publication primitive used for crash recovery semantics */
    publishMode?: 'link' | 'copy-exclusive'
    /**
     * Durable proof that the final pathname names the exact file object this
     * writer created, captured before the namespace change. Without it a
     * recovery pass cannot distinguish an interrupted copy from a foreign file
     * that appeared while the process was down, and must park for the user.
     *
     * A string because inode numbers exceed the JS safe-integer range and the
     * journal is serialized through JSON.
     */
    destinationIdentity?: string | null
    /** source has durably ACKed x-result; remaining cleanup is receiver-local */
    resultAcked?: boolean
  } | null
  /** live transfer correlation */
  fileId?: string | null
  /** sender-side compatibility flag: a terminal Drive ACK or committed x-result was observed */
  senderTransferComplete?: boolean
  /**
   * Durable receiver commit proof. New code settles it immediately after this
   * checkpoint is persisted; the field remains for crash recovery and journals
   * written by builds that used to wait for an independent Drive ACK.
   */
  pendingSuccessResult?: { savedToBase: string | null } | null
  state: 'queued' | 'active' | 'waiting-peer' | 'finalizing' | 'done' | 'failed' | 'stale' | 'cancel-pending'
  error?: string | null
}

export interface OperationDescriptor extends Record<string, CanonicalValue> {
  operationId: string
  source: { deviceId: string; rootId: string; relativePath: string }
  destination: { deviceId: string; rootId: string; relativePath: string }
  sourceFingerprint: { size: number; blake2b256: string | null }
  destFingerprint: { size: number; blake2b256: string | null } | null
  size: number
  chunkSize: number
  collision: 'rename' | 'overwrite'
  createdAtMs: number
  /** dir operations carry item descriptors instead of a single body */
  items?: Record<string, CanonicalValue>[]
  mode?: string
  leafRelativePath?: string
}

export interface JournalRow {
  v: 1
  schemaVersion?: 2
  operationId: string
  descriptor: OperationDescriptor
  descriptorHash: string
  role: JournalRole
  peerId: string
  state: State
  files: FileJournal[]
  createdAtMs: number
  updatedAtMs: number
  error?: string | null
  /** true when this device accepted the original shell copy request */
  initiatedLocally?: boolean
  /** peer created its complementary sender/receiver journal */
  peerPrepared?: boolean
  recovery?: RecoveryState
  waitingSinceMs?: number | null
}

type JournalInput = Omit<JournalRow, 'v' | 'createdAtMs' | 'updatedAtMs'>

interface BatchJournalRecord {
  v: 1
  kind: 'batch'
  batchId: string
  createdAtMs: number
  rows: JournalRow[]
}

interface BatchCompletionRecord {
  v: 1
  kind: 'batch-completed'
  batchId: string
  operationId: string
}

interface BatchCancelRecord {
  v: 1
  kind: 'batch-cancelled'
  batchId: string
}

interface BatchHeaderRecord {
  v: 1
  kind: 'batch-header'
  batchId: string
  createdAtMs: number
}

interface BatchRowRecord {
  v: 1
  kind: 'batch-row'
  batchId: string
  row: JournalRow
}

function now(): number {
  return Date.now()
}

const RECOVERY_BACKOFF_MS = [0, 5_000, 30_000, 120_000] as const
const MAX_RECOVERY_ATTEMPTS = 4

function defaultRecoveryState(): RecoveryState {
  return {
    generation: 0,
    leaseId: null,
    attempts: 0,
    lastAttemptAtMs: null,
    nextAttemptAtMs: null,
    lastErrorCode: null,
    lastErrorScope: null,
    requiresUserAction: false,
    blocked: false
  }
}

function normalizeRecoveryState(value: unknown): RecoveryState {
  const source = value && typeof value === 'object' ? value as Partial<RecoveryState> : {}
  const attempts = Number.isSafeInteger(source.attempts) && Number(source.attempts) >= 0 ? Math.min(Number(source.attempts), MAX_RECOVERY_ATTEMPTS) : 0
  const generation = Number.isSafeInteger(source.generation) && Number(source.generation) >= 0 ? Number(source.generation) : 0
  const scope = source.lastErrorScope
  return {
    generation,
    leaseId: typeof source.leaseId === 'string' && source.leaseId.length > 0 ? source.leaseId.slice(0, 128) : null,
    attempts,
    lastAttemptAtMs: Number.isSafeInteger(source.lastAttemptAtMs) && Number(source.lastAttemptAtMs) >= 0 ? Number(source.lastAttemptAtMs) : null,
    nextAttemptAtMs: Number.isSafeInteger(source.nextAttemptAtMs) && Number(source.nextAttemptAtMs) >= 0 ? Number(source.nextAttemptAtMs) : null,
    lastErrorCode: typeof source.lastErrorCode === 'string' ? source.lastErrorCode.slice(0, 128) : null,
    lastErrorScope: scope === 'TRANSPORT' || scope === 'PEER_PROTOCOL' || scope === 'OPERATION' || scope === 'FILE' || scope === 'FINALIZE' || scope === 'USER_ACTION' ? scope : null,
    requiresUserAction: source.requiresUserAction === true,
    blocked: source.blocked === true || source.requiresUserAction === true
  }
}

function recoveryBackoff(attempt: number): number {
  return RECOVERY_BACKOFF_MS[Math.min(Math.max(attempt, 1), RECOVERY_BACKOFF_MS.length - 1)]
}

const DIR = 'journals'
const STALE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const MAX_STALE_ROWS = 512
const BATCH_COMPLETION_GROUP_MS = 12
const BATCH_COMPLETION_GROUP_MAX = 256
const BATCH_READ_CHUNK = 1024 * 1024
const BATCH_WRITE_CHUNK = 512 * 1024
const FINISHED_BATCH_TTL_MS = 10 * 60 * 1000
const MAX_FINISHED_BATCHES = 32
const MAX_FINISHED_OPERATION_IDS = 250_000
const CORRUPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const MAX_CORRUPT_FILES = 128
let batchTmpSeq = 0

export class JournalBatchCancelled extends Error {
  code = 'CANCELLED' as const

  constructor() {
    super('batch journal acceptance cancelled')
  }
}

async function writeBatchAtomic(
  filePath: string,
  batchId: string,
  rows: JournalRow[],
  key: Uint8Array,
  isCancelled?: () => boolean
): Promise<void> {
  const tmp = `${filePath}.tmp-${Date.now().toString(36)}-${(++batchTmpSeq).toString(36)}`
  const handle = await openFile(tmp, 'w')
  let position = 0
  let pending: Uint8Array[] = []
  let pendingBytes = 0
  const throwIfCancelled = (): void => {
    if (isCancelled?.()) throw new JournalBatchCancelled()
  }
  const flushPending = async (): Promise<void> => {
    if (!pendingBytes) return
    const bytes = pending.length === 1 ? pending[0] : b4a.concat(pending, pendingBytes)
    pending = []
    pendingBytes = 0
    let offset = 0
    while (offset < bytes.byteLength) {
      const written = bytesWrittenOf(await handle.write(bytes, offset, bytes.byteLength - offset, position))
      if (written <= 0) throw new Error('batch journal write stalled')
      offset += written
      position += written
    }
  }
  const writeLine = async (value: BatchHeaderRecord | BatchRowRecord): Promise<void> => {
    const bytes = b4a.from(encodeProtectedJson(value, key) + '\n', 'utf8')
    pending.push(bytes)
    pendingBytes += bytes.byteLength
    if (pendingBytes >= BATCH_WRITE_CHUNK) await flushPending()
  }
  try {
    throwIfCancelled()
    await writeLine({ v: 1, kind: 'batch-header', batchId, createdAtMs: now() })
    for (const row of rows) {
      throwIfCancelled()
      await writeLine({ v: 1, kind: 'batch-row', batchId, row })
    }
    await flushPending()
    throwIfCancelled()
    await handle.sync()
    throwIfCancelled()
  } catch (err) {
    try { await handle.close() } catch {}
    try { await fs.unlink(tmp) } catch {}
    throw err
  }
  await handle.close()
  if (isCancelled?.()) {
    try { await fs.unlink(tmp) } catch {}
    throw new JournalBatchCancelled()
  }
  try {
    await fs.rename(tmp, filePath)
  } catch (err) {
    try { await fs.unlink(tmp) } catch {}
    throw err
  }
}

async function forEachProtectedBatchLine(
  filePath: string,
  key: Uint8Array,
  visit: (value: unknown, lineNo: number) => void,
  tolerateTruncatedTail = false
): Promise<void> {
  const handle = await openFile(filePath, 'r')
  const buf = b4a.allocUnsafe(BATCH_READ_CHUNK)
  let position = 0
  let carry = b4a.alloc(0)
  let lineNo = 0
  const consume = (line: Uint8Array): void => {
    if (line.byteLength === 0) return
    const decoded = decodeProtectedJson<unknown>(b4a.toString(line, 'utf8'), key)
    visit(decoded.value, lineNo++)
  }
  try {
    for (;;) {
      const n = bytesReadOf(await handle.read(buf, 0, buf.byteLength, position))
      if (n <= 0) break
      position += n
      const chunk = carry.byteLength ? b4a.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n)
      let start = 0
      for (let i = 0; i < chunk.byteLength; i++) {
        if (chunk[i] !== 0x0a) continue
        consume(chunk.subarray(start, i))
        start = i + 1
      }
      carry = start < chunk.byteLength ? b4a.from(chunk.subarray(start)) : b4a.alloc(0)
    }
    if (carry.byteLength) {
      try {
        consume(carry)
      } catch (err) {
        if (!tolerateTruncatedTail) throw err
      }
    }
  } finally {
    await handle.close()
  }
}

export class JournalStore {
  private _rows = new Map<string, JournalRow>()
  private _dirty = new Set<string>()
  private _timer: ReturnType<typeof setTimeout> | null = null
  private _rowFlushes = new Map<string, Promise<void>>()
  private _removingRows = new Set<string>()
  private _rowIoFreeSlots = Array.from({ length: ROW_IO_CONCURRENCY }, (_unused, index) => index)
  private _rowIoWaiters: Array<(slot: number) => void> = []
  private _rowIoWorkers: Array<IsolatedIoWorker | null> = Array.from({ length: ROW_IO_CONCURRENCY }, () => null)
  private _batchByOperation = new Map<string, string>()
  private _batchMembers = new Map<string, Set<string>>()
  private _batchCompleted = new Map<string, Set<string>>()
  private _batchTotals = new Map<string, number>()
  private _finishedBatches = new Map<string, { total: number; completed: number; expiresAtMs: number; operationIds: string[]; donePath: string }>()
  private _batchFiles = new Map<string, string>()
  private _batchDoneFiles = new Map<string, string>()
  private _batchCompletionQueues = new Map<string, {
    pending: Array<{ record: BatchCompletionRecord; resolve: () => void; reject: (error: unknown) => void }>
    timer: ReturnType<typeof setTimeout> | null
    flushing: Promise<void> | null
  }>()
  private _completedBatchOperations = new Set<string>()
  private _completedBatchOwners = new Map<string, string>()
  private _batchResidualCheckpoints = new Map<string, Set<string>>()
  private _batchLegacyCompletionFiles = new Map<string, Set<string>>()
  private _cancelledBatches = new Set<string>()
  private _corruptCompletionBatches = new Set<string>()
  private _orderedOperationIds: string[] = []
  private _operationIndexDirty = true
  private _operationIndexRemoved = 0
  private _operationsByPeer = new Map<string, Set<string>>()
  dir: string

  constructor(private dataRoot: string, private protectedKey: Uint8Array) {
    this.dir = path.join(dataRoot.replace(/[\\]+$/, ''), DIR)
  }

  async recover(): Promise<JournalRow[]> {
    await fs.mkdir(this.dir, { recursive: true })
    let names: string[] = []
    try {
      names = (await fs.readdir(this.dir)) as string[]
    } catch (err: unknown) {
      if (!isErrnoCode(err, 'ENOENT')) throw err
    }

    const nameSet = new Set(names)
    // Startup is a quiescent journal boundary: no writer from the previous Core
    // generation can still own these deterministic temp names. Remove abandoned
    // atomic-write/batch temps immediately instead of leaking one file per crash.
    for (const name of names) {
      if (!name.endsWith('.io-worker-tmp') && !name.includes('.tmp-')) continue
      try { await fs.unlink(path.join(this.dir, name)) } catch {}
    }

    // Corrupt journals are diagnostic evidence, not replay state. Keep a useful
    // bounded window, but do not let repeated bad media/AV incidents grow the
    // portable data directory forever.
    const corruptResidue: Array<{ name: string; mtimeMs: number }> = []
    for (const name of names) {
      if (!name.includes('.corrupt-') && !name.includes('.corrupt-completion-')) continue
      try {
        const stat = await fs.stat(path.join(this.dir, name))
        corruptResidue.push({ name, mtimeMs: Number(stat.mtimeMs) || now() })
      } catch {}
    }
    corruptResidue.sort((a, b) => a.mtimeMs - b.mtimeMs)
    const corruptCutoff = now() - CORRUPT_RETENTION_MS
    const corruptOverflow = Math.max(0, corruptResidue.length - MAX_CORRUPT_FILES)
    for (let i = 0; i < corruptResidue.length; i++) {
      const item = corruptResidue[i]
      if (i >= corruptOverflow && item.mtimeMs >= corruptCutoff) continue
      try { await fs.unlink(path.join(this.dir, item.name)) } catch {}
    }

    // Cancellation markers are read first so directory iteration order cannot
    // resurrect an accepted-but-never-launched batch after a forced teardown.
    for (const name of names) {
      if (!name.endsWith('.batch.cancel')) continue
      const full = path.join(this.dir, name)
      try {
        const decoded = decodeProtectedJson<unknown>(await fs.readFile(full, 'utf8'), this.protectedKey).value
        if (this._isBatchCancel(decoded)) this._cancelledBatches.add(decoded.batchId)
      } catch {
        try { await fs.rename(full, full + '.corrupt-' + now()) } catch {}
      }
    }

    for (const name of names) {
      const full = path.join(this.dir, name)
      if (name.endsWith('.batch.cancel')) continue
      if (name.includes('.batch.cancelled-')) {
        try { await fs.unlink(full) } catch {}
        continue
      }
      if (name.endsWith('.done') && name.startsWith('batch-')) {
        const batchId = name.slice(6, -5)
        if (!SAFE_ID_RE.test(batchId)) continue
        // A .done log is required indefinitely while the acceptance .batch still
        // has unfinished siblings. Once acceptance is gone it is only a bounded
        // duplicate-replay tombstone; expire it from its on-disk mtime so Core
        // restarts cannot refresh a ten-minute TTL forever.
        if (!nameSet.has(`batch-${batchId}.batch`)) {
          try {
            const stat = await fs.stat(full)
            const mtimeMs = Number(stat.mtimeMs)
            if (Number.isFinite(mtimeMs) && mtimeMs + FINISHED_BATCH_TTL_MS <= now()) {
              await fs.unlink(full).catch(() => {})
              continue
            }
          } catch {}
        }
        const recovered = new Set<string>()
        try {
          await forEachProtectedBatchLine(full, this.protectedKey, (value) => {
            if (!this._isBatchCompletion(value) || value.batchId !== batchId) {
              throw new Error('invalid batch completion log')
            }
            recovered.add(value.operationId)
          }, true)
          const completed = this._batchCompleted.get(batchId) ?? new Set<string>()
          for (const operationId of recovered) {
            completed.add(operationId)
            this._completedBatchOperations.add(operationId)
            this._completedBatchOwners.set(operationId, batchId)
          }
          this._batchCompleted.set(batchId, completed)
          this._batchDoneFiles.set(batchId, full)
        } catch {
          // Never guess which unfinished operations are safe if an authenticated
          // completion record is corrupt. Park the whole batch below rather than
          // replaying a file that may already have committed successfully.
          this._corruptCompletionBatches.add(batchId)
          try { await fs.rename(full, full + '.corrupt-' + now()) } catch {}
        }
        continue
      }
      if (name.endsWith('.batch')) {
        const fileBatchId = name.startsWith('batch-') ? name.slice(6, -6) : ''
        if (SAFE_ID_RE.test(fileBatchId) && this._cancelledBatches.has(fileBatchId)) continue
        try {
          await this._recoverBatchFile(full)
        } catch {
          // Broken batch acceptance must never be guessed. Park it exactly as
          // ordinary corrupt journals are parked; no partially decoded rows are
          // retained by _recoverBatchFile on failure.
          try { await fs.rename(full, full + '.corrupt-' + now()) } catch {}
        }
        continue
      }
      if (!name.endsWith('.json')) continue
      let text: string
      try {
        text = await fs.readFile(full, 'utf8')
       } catch (err: unknown) {
         if (isErrnoCode(err, 'ENOENT')) continue
         try { await fs.rename(full, full + '.corrupt-' + now()) } catch {}
         dbg('journal read failure quarantined', name, errorCode(err) ?? 'IO')
         continue
       }

      let decodedValue: unknown = null
      let encrypted = true
      try {
        const decoded = decodeProtectedJson<unknown>(text, this.protectedKey)
        decodedValue = decoded.value
        encrypted = decoded.encrypted
      } catch {
        decodedValue = null
      }

      if (this._isBatchCompletion(decodedValue)) {
        const completed = this._batchCompleted.get(decodedValue.batchId) ?? new Set<string>()
        completed.add(decodedValue.operationId)
        this._batchCompleted.set(decodedValue.batchId, completed)
        this._completedBatchOperations.add(decodedValue.operationId)
        this._completedBatchOwners.set(decodedValue.operationId, decodedValue.batchId)
        this._trackLegacyBatchCompletionFile(decodedValue.batchId, decodedValue.operationId)
        const members = this._batchMembers.get(decodedValue.batchId)
        if (this._batchByOperation.get(decodedValue.operationId) === decodedValue.batchId) {
          this._batchByOperation.delete(decodedValue.operationId)
          this._rows.delete(decodedValue.operationId)
        }
        members?.delete(decodedValue.operationId)
        continue
      }
      if (this._isBatch(decodedValue)) {
        this._batchFiles.set(decodedValue.batchId, full)
        this._batchTotals.set(decodedValue.batchId, decodedValue.rows.length)
        const members = new Set<string>()
        const completed = this._batchCompleted.get(decodedValue.batchId) ?? new Set<string>()
        for (const candidate of decodedValue.rows) {
          const row = this._normalize(candidate)
          if (!row || completed.has(row.operationId)) continue
          members.add(row.operationId)
          this._batchByOperation.set(row.operationId, decodedValue.batchId)
          const existing = this._rows.get(row.operationId)
          if (!existing || existing.updatedAtMs <= row.updatedAtMs) this._rows.set(row.operationId, row)
        }
        if (members.size) this._batchMembers.set(decodedValue.batchId, members)
        continue
      }

      const row = this._normalize(decodedValue)
      if (row && this._completedBatchOperations.has(row.operationId)) {
        const owner = this._completedBatchOwners.get(row.operationId)
        if (owner) this._trackBatchResidualCheckpoint(owner, row.operationId)
        continue
      }
      if (!row) {
        // broken journal: never guess, never touch user data — park corrupt entry
        try {
          await fs.rename(full, full + '.corrupt-' + now())
        } catch {}
        continue
      }
      if (!encrypted) this._dirty.add(row.operationId)
      const existing = this._rows.get(row.operationId)
      if (!existing || existing.updatedAtMs <= row.updatedAtMs) this._rows.set(row.operationId, row)
    }
    // A corrupt completion log makes replay ambiguous. Park its acceptance
    // record and remove all in-memory members instead of risking duplicate
    // overwrite/rename side effects.
    for (const batchId of this._corruptCompletionBatches) {
      const members = this._batchMembers.get(batchId)
      if (members) {
        for (const operationId of members) {
          this._rows.delete(operationId)
          this._batchByOperation.delete(operationId)
        }
      }
      const batchPath = this._batchFiles.get(batchId) ?? this._batchPath(batchId)
      try { await fs.rename(batchPath, batchPath + '.corrupt-completion-' + now()) } catch {}
      this._batchMembers.delete(batchId)
      this._batchCompleted.delete(batchId)
      this._batchTotals.delete(batchId)
      this._batchFiles.delete(batchId)
    }

    // Retire cancelled acceptance records before normal recovery reconciliation.
    // The marker is removed only after the .batch file is gone; this ordering
    // makes every crash point safe.
    for (const batchId of [...this._cancelledBatches]) {
      const batchPath = this._batchPath(batchId)
      let acceptanceGone = false
      try {
        await fs.unlink(batchPath)
        acceptanceGone = true
      } catch (err: unknown) {
        if (isErrnoCode(err, 'ENOENT')) acceptanceGone = true
      }
      if (!acceptanceGone) continue
      try { await fs.unlink(this._batchCancelPath(batchId)) } catch {}
      this._cancelledBatches.delete(batchId)
    }

    // Directory iteration order is unspecified. Reconcile batch acceptance
    // records with per-operation terminal tombstones after every file has been
    // decoded so recovery is identical whether the batch or tombstone was read
    // first.
    for (const [batchId, completed] of this._batchCompleted) {
      const members = this._batchMembers.get(batchId)
      for (const operationId of completed) {
        this._completedBatchOperations.add(operationId)
        this._completedBatchOwners.set(operationId, batchId)
        // readdir order is unspecified. If a completed operation checkpoint was
        // decoded before its .done log, it is present in _rows here; remember
        // the physical file so final batch compaction removes it before the
        // acceptance/done pair disappears.
        if (this._rows.has(operationId)) this._trackBatchResidualCheckpoint(batchId, operationId)
        if (this._batchByOperation.get(operationId) === batchId) {
          this._batchByOperation.delete(operationId)
          this._rows.delete(operationId)
        }
        members?.delete(operationId)
      }
    }
    await this._cleanupCompletedBatches()

    for (const row of this._rows.values()) {
      // Compatibility with journals written before resultAcked existed.
      const finalize = row.files[0]?.finalize
      if (
        row.role === 'receiver' && row.state === 'finalizing' && finalize &&
        finalize.resultAcked !== true && typeof row.error === 'string' &&
        row.error.startsWith('finalize cleanup pending:')
      ) {
        finalize.resultAcked = true
        this._dirty.add(row.operationId)
      }
      // Socket state is gone after restart, but rewriting every member of a
      // 100k batch here would recreate N fsyncs. Normalize transient state in
      // memory; the next real operation update persists it. A locally accepted
      // row that never reached the peer remains explicitly `queued`.
       if (row.state === 'active' || (row.state === 'queued' && !(row.initiatedLocally && !row.peerPrepared))) {
         row.state = 'waiting-peer'
         const file = row.files[0]
         if (file?.state === 'active' || file?.state === 'queued') file.state = 'waiting-peer'
       }
       if (row.state === 'waiting-peer') row.waitingSinceMs = typeof row.waitingSinceMs === 'number' ? row.waitingSinceMs : row.updatedAtMs

    }
    await this._flushDirty(true, true)

    // A terminal row can survive only if Core died after persisting `done` but
    // before remove() appended the batch completion/removes the checkpoint. It
    // is safe -- and necessary -- to finish that durable cleanup during startup;
    // otherwise a committed file leaves a permanent .json/.batch residue.
    for (const row of [...this._rows.values()]) {
      if (row.state !== 'done') continue
      try {
        await this.remove(row.operationId)
      } catch (err) {
        dbg('terminal journal recovery cleanup failed', row.operationId, String((err as Error)?.message ?? err))
      }
    }

    await this.pruneStale()
    this._rebuildPeerIndex()
    this._operationIndexDirty = true
    return this.list()
  }

  private async _recoverBatchFile(full: string): Promise<void> {
    let batchId: string | null = null
    let sawRow = false
    let rowCount = 0
    const members = new Set<string>()
    const touched = new Map<string, { row: JournalRow | null; batchId: string | null }>()
    try {
      await forEachProtectedBatchLine(full, this.protectedKey, (value, lineNo) => {
        if (lineNo === 0) {
          if (!value || typeof value !== 'object') throw new Error('batch header missing')
          const header = value as Partial<BatchHeaderRecord>
          if (header.v !== 1 || header.kind !== 'batch-header' || typeof header.batchId !== 'string' || !SAFE_ID_RE.test(header.batchId)) {
            throw new Error('invalid batch header')
          }
          batchId = header.batchId
          return
        }
        if (!batchId || !value || typeof value !== 'object') throw new Error('invalid batch row')
        const record = value as Partial<BatchRowRecord>
        if (record.v !== 1 || record.kind !== 'batch-row' || record.batchId !== batchId || !record.row) {
          throw new Error('invalid batch row')
        }
        const row = this._normalize(record.row)
        if (!row) throw new Error('invalid batch journal row')
        sawRow = true
        rowCount += 1
        if (this._completedBatchOperations.has(row.operationId)) return
        if (!touched.has(row.operationId)) {
          touched.set(row.operationId, {
            row: this._rows.get(row.operationId) ?? null,
            batchId: this._batchByOperation.get(row.operationId) ?? null
          })
        }
        members.add(row.operationId)
        this._batchByOperation.set(row.operationId, batchId)
        const existing = this._rows.get(row.operationId)
        if (!existing || existing.updatedAtMs <= row.updatedAtMs) this._rows.set(row.operationId, row)
      })
      if (!batchId || !sawRow) throw new Error('empty batch journal')
      this._batchFiles.set(batchId, full)
      this._batchTotals.set(batchId, rowCount)
      if (members.size) this._batchMembers.set(batchId, members)
    } catch (err) {
      for (const [operationId, previous] of touched) {
        if (previous.row) this._rows.set(operationId, previous.row)
        else this._rows.delete(operationId)
        if (previous.batchId) this._batchByOperation.set(operationId, previous.batchId)
        else this._batchByOperation.delete(operationId)
      }
      if (batchId) {
        this._batchMembers.delete(batchId)
        if (this._batchFiles.get(batchId) === full) this._batchFiles.delete(batchId)
      }
      throw err
    }
  }

  private _isBatch(value: unknown): value is BatchJournalRecord {
    if (!value || typeof value !== 'object') return false
    const v = value as Partial<BatchJournalRecord>
    return v.v === 1 && v.kind === 'batch' && typeof v.batchId === 'string' && SAFE_ID_RE.test(v.batchId) && Array.isArray(v.rows)
  }

  private _isBatchCompletion(value: unknown): value is BatchCompletionRecord {
    if (!value || typeof value !== 'object') return false
    const v = value as Partial<BatchCompletionRecord>
    return v.v === 1 && v.kind === 'batch-completed' && typeof v.batchId === 'string' && SAFE_ID_RE.test(v.batchId) &&
      typeof v.operationId === 'string' && SAFE_ID_RE.test(v.operationId)
  }

  private _isBatchCancel(value: unknown): value is BatchCancelRecord {
    if (!value || typeof value !== 'object') return false
    const v = value as Partial<BatchCancelRecord>
    return v.v === 1 && v.kind === 'batch-cancelled' && typeof v.batchId === 'string' && SAFE_ID_RE.test(v.batchId)
  }

  private _normalize(parsed: unknown): JournalRow | null {
    if (!parsed || typeof parsed !== 'object' || (parsed as { v?: unknown }).v !== 1) return null
    const r = parsed as JournalRow
    const needsMigration = r.schemaVersion !== 2 || r.recovery === undefined
    r.schemaVersion = 2
    r.recovery = normalizeRecoveryState(r.recovery)
    if (
      typeof r.operationId !== 'string' || !SAFE_ID_RE.test(r.operationId) ||
      typeof r.descriptorHash !== 'string' ||
      (r.role !== 'sender' && r.role !== 'receiver') ||
      typeof r.peerId !== 'string' ||
      !Array.isArray(r.files) ||
      !r.descriptor ||
      typeof r.descriptor !== 'object'
    ) {
      return null
    }
    if (![
      'queued', 'active', 'waiting-peer', 'cancel-pending', 'finalizing', 'done', 'stale'
    ].includes(r.state)) return null
    if (needsMigration) this._dirty.add(r.operationId)
    r.updatedAtMs = typeof r.updatedAtMs === 'number' ? r.updatedAtMs : now()
    return r
  }

  private _indexPeerRow(row: JournalRow): void {
    const peerId = row.peerId.toLowerCase()
    let ids = this._operationsByPeer.get(peerId)
    if (!ids) {
      ids = new Set<string>()
      this._operationsByPeer.set(peerId, ids)
    }
    ids.add(row.operationId)
  }

  private _unindexPeerRow(operationId: string, row?: JournalRow | null): void {
    const existing = row ?? this._rows.get(operationId)
    if (!existing) return
    const peerId = existing.peerId.toLowerCase()
    const ids = this._operationsByPeer.get(peerId)
    if (!ids) return
    ids.delete(operationId)
    if (ids.size === 0) this._operationsByPeer.delete(peerId)
  }

  private _rebuildPeerIndex(): void {
    this._operationsByPeer.clear()
    for (const row of this._rows.values()) this._indexPeerRow(row)
  }

  list(filter?: { peerId?: string; state?: State | State[] }): JournalRow[] {
    const peerId = filter?.peerId?.toLowerCase()
    const want = filter?.state ? (Array.isArray(filter.state) ? filter.state : [filter.state]) : null
    const out: JournalRow[] = []
    if (peerId) {
      for (const operationId of this._operationsByPeer.get(peerId) ?? []) {
        const row = this._rows.get(operationId)
        if (row && (!want || want.includes(row.state))) out.push(row)
      }
      return out
    }
    for (const row of this._rows.values()) {
      if (!want || want.includes(row.state)) out.push(row)
    }
    return out
  }

  listPage(
    filter: { peerId?: string; state?: State | State[] } | undefined,
    cursor: string | null,
    limit: number
  ): { rows: JournalRow[]; nextCursor: string | null } {
    if (this._operationIndexDirty) {
      this._orderedOperationIds = [...this._rows.keys()].sort((a, b) => a.localeCompare(b))
      this._operationIndexDirty = false
      this._operationIndexRemoved = 0
    }
    const want = filter?.state ? (Array.isArray(filter.state) ? filter.state : [filter.state]) : null
    const peerId = filter?.peerId
    let lo = 0
    let hi = this._orderedOperationIds.length
    if (cursor) {
      while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if (this._orderedOperationIds[mid].localeCompare(cursor) <= 0) lo = mid + 1
        else hi = mid
      }
    }
    const rows: JournalRow[] = []
    let index = lo
    let lastExamined: string | null = null
    for (; index < this._orderedOperationIds.length && rows.length < limit; index++) {
      const operationId = this._orderedOperationIds[index]
      lastExamined = operationId
      const row = this._rows.get(operationId)
      if (!row) continue
      if (peerId && row.peerId !== peerId) continue
      if (want && !want.includes(row.state)) continue
      rows.push(row)
    }
    // If the page filled, more indexed IDs may remain. Advance the cursor by
    // the last examined ID (not merely the last matched row) so filtered scans
    // never re-walk skipped entries.
    const nextCursor = index < this._orderedOperationIds.length ? lastExamined : null
    return { rows, nextCursor }
  }

  get(operationId: string): JournalRow | null {
    return this._rows.get(operationId) ?? null
  }

  batchIdForOperation(operationId: string): string | null {
    return this._batchByOperation.get(operationId) ?? null
  }

  async putBatch(batchId: string, rows: JournalInput[], isCancelled?: () => boolean): Promise<JournalRow[]> {
    if (!SAFE_ID_RE.test(batchId)) throw new Error('invalid batchId')
    if (!Array.isArray(rows) || rows.length === 0) return []
    const timestamp = now()
    const fullRows = rows.map((row) => {
      const full: JournalRow = { v: 1, schemaVersion: 2, recovery: defaultRecoveryState(), createdAtMs: timestamp, updatedAtMs: timestamp, ...row }
      if (!SAFE_ID_RE.test(full.operationId)) throw new Error('invalid operationId')
      if (this._rows.has(full.operationId) || this.wasRecentlyCompleted(full.operationId)) throw new Error(`operation already exists or completed: ${full.operationId}`)
      return full
    })
    // One durable barrier accepts the whole directory batch. Rows are encoded
    // as independently authenticated lines and streamed to a temp file; this
    // avoids constructing a second giant JSON/ciphertext buffer for 100k-file
    // copies while retaining atomic rename + one fsync crash semantics.
    const batchPath = this._batchPath(batchId)
    await writeBatchAtomic(batchPath, batchId, fullRows, this.protectedKey, isCancelled)
    // Cancellation can be delivered in the event-loop turn immediately after
    // the atomic rename. Quarantine the acceptance record before exposing rows
    // in memory so a forced process teardown cannot resurrect the batch.
    if (isCancelled?.()) {
      await this._cancelAcceptedBatchFile(batchId, batchPath)
      throw new JournalBatchCancelled()
    }
    this._batchFiles.set(batchId, batchPath)
    const members = new Set<string>()
    for (const full of fullRows) {
      this._rows.set(full.operationId, full)
      this._indexPeerRow(full)
      this._batchByOperation.set(full.operationId, batchId)
      members.add(full.operationId)
    }
    this._operationIndexDirty = true
    this._batchMembers.set(batchId, members)
    this._batchCompleted.set(batchId, new Set())
    this._batchTotals.set(batchId, fullRows.length)
    return fullRows
  }

  /**
   * Cancel a batch after its single acceptance barrier but before any transfer
   * is launched. The batch file is renamed out of the recovery namespace first;
   * after that crash point recovery cannot resurrect any member.
   */
  async abortAcceptedBatch(batchId: string, operationIds: readonly string[]): Promise<void> {
    if (!SAFE_ID_RE.test(batchId)) throw new Error('invalid batchId')
    const batchPath = this._batchFiles.get(batchId) ?? this._batchPath(batchId)
    await this._cancelAcceptedBatchFile(batchId, batchPath)
    for (const operationId of operationIds) {
      if (this._batchByOperation.get(operationId) !== batchId) continue
      this._unindexPeerRow(operationId)
      this._rows.delete(operationId)
      this._dirty.delete(operationId)
      this._updCounter.delete(operationId)
      this._batchByOperation.delete(operationId)
      this._completedBatchOwners.delete(operationId)
    }
    this._batchMembers.delete(batchId)
    this._batchCompleted.delete(batchId)
    this._batchResidualCheckpoints.delete(batchId)
    this._batchLegacyCompletionFiles.delete(batchId)
    this._batchTotals.delete(batchId)
    this._batchFiles.delete(batchId)
  }

  private _batchCancelPath(batchId: string): string {
    return path.join(this.dir, `batch-${batchId}.batch.cancel`)
  }

  private async _cancelAcceptedBatchFile(batchId: string, batchPath: string): Promise<void> {
    const marker: BatchCancelRecord = { v: 1, kind: 'batch-cancelled', batchId }
    // Marker FIRST. If Core is killed at any later point recovery sees this and
    // suppresses the acceptance record even if Windows/AV is still holding it.
    await writeFileAtomic(this._batchCancelPath(batchId), encodeProtectedJson(marker, this.protectedKey))
    this._cancelledBatches.add(batchId)

    const quarantined = `${batchPath}.cancelled-${now()}-${(++batchTmpSeq).toString(36)}`
    let moved = false
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        await fs.rename(batchPath, quarantined)
        moved = true
        break
      } catch (err: unknown) {
        if (isErrnoCode(err, 'ENOENT')) {
          moved = true
          break
        }
        if (!isErrnoCode(err, 'EPERM', 'EACCES', 'EBUSY') || attempt === 5) break
        await new Promise<void>((resolve) => setTimeout(() => resolve(), 80 * (attempt + 1)))
      }
    }
    if (!moved) {
      // Durable marker is sufficient for correctness. Leave both files for
      // recover() to retire once the transient sharing lock disappears.
      return
    }
    try { await fs.unlink(quarantined) } catch {}
    try { await fs.unlink(this._batchCancelPath(batchId)) } catch {}
    this._cancelledBatches.delete(batchId)
  }

  private _forgetFinishedBatch(batchId: string): void {
    const finished = this._finishedBatches.get(batchId)
    if (!finished) return
    this._finishedBatches.delete(batchId)
    for (const operationId of finished.operationIds) {
      if (this._completedBatchOwners.get(operationId) !== batchId) continue
      this._completedBatchOperations.delete(operationId)
      this._completedBatchOwners.delete(operationId)
    }
    this._batchDoneFiles.delete(batchId)
    void this._unlinkWithRetry(finished.donePath)
  }

  private async _unlinkWithRetry(filePath: string): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await fs.unlink(filePath)
        return
      } catch (err: unknown) {
        if (isErrnoCode(err, 'ENOENT')) return
        if (!isErrnoCode(err, 'EPERM', 'EACCES', 'EBUSY') || attempt === 3) return
        await new Promise<void>((resolve) => setTimeout(() => resolve(), 100 * (attempt + 1)))
      }
    }
  }

  private _pruneExpiredFinishedBatches(nowMs: number): number {
    let pruned = 0
    for (const [batchId, finished] of [...this._finishedBatches]) {
      if (finished.expiresAtMs > nowMs) continue
      this._forgetFinishedBatch(batchId)
      pruned += 1
    }
    return pruned
  }

  wasRecentlyCompleted(operationId: string): boolean {
    if (!this._completedBatchOperations.has(operationId)) return false
    const batchId = this._completedBatchOwners.get(operationId)
    if (!batchId) return true
    const finished = this._finishedBatches.get(batchId)
    if (finished && finished.expiresAtMs < now()) {
      this._forgetFinishedBatch(batchId)
      return false
    }
    return true
  }

  async put(row: JournalInput, immediate = false): Promise<JournalRow> {
    const full: JournalRow = { v: 1, schemaVersion: 2, recovery: defaultRecoveryState(), createdAtMs: now(), updatedAtMs: now(), ...row }
    if (!SAFE_ID_RE.test(full.operationId)) throw new Error('invalid operationId')
    // Journal rows are operation identities, not upsert records. Reject an
    // already-live id at the persistence boundary so an async caller race can
    // never silently replace the descriptor/peer/role selected by the winner.
    if (this._rows.has(full.operationId) || this.wasRecentlyCompleted(full.operationId)) {
      throw new Error('operation already exists or completed')
    }
    this._rows.set(full.operationId, full)
    this._indexPeerRow(full)
    this._operationIndexDirty = true
    this._dirty.add(full.operationId)
    if (immediate) await this._flushOperation(full.operationId)
    else this._schedule()
    return full
  }

  private _batchPath(batchId: string): string {
    return path.join(this.dir, `batch-${batchId}.batch`)
  }

  private _batchDonePath(batchId: string): string {
    return path.join(this.dir, `batch-${batchId}.done`)
  }

  private async _flushBatchCompletionQueue(batchId: string): Promise<void> {
    const queue = this._batchCompletionQueues.get(batchId)
    if (!queue) return
    if (queue.flushing) {
      await queue.flushing
      return
    }
    if (queue.timer) clearTimeout(queue.timer)
    queue.timer = null
    if (queue.pending.length === 0) return

    const batch = queue.pending.splice(0, BATCH_COMPLETION_GROUP_MAX)
    const run = (async () => {
      const donePath = this._batchDoneFiles.get(batchId) ?? this._batchDonePath(batchId)
      try {
        const handle = await openFile(donePath, 'a')
        try {
          // Group several tiny-file completions behind one durable barrier. Every
          // waiter is resolved only *after* the whole appended group is synced,
          // so remove() never drops a row whose replay-suppression record is not
          // crash durable yet.
          const encoded = batch.map(({ record }) => encodeProtectedJson(record, this.protectedKey) + '\n').join('')
          const bytes = b4a.from(encoded, 'utf8')
          let offset = 0
          while (offset < bytes.byteLength) {
            const written = bytesWrittenOf(await handle.write(bytes, offset, bytes.byteLength - offset, null))
            if (written <= 0) throw new Error('batch completion log write stalled')
            offset += written
          }
          await handle.sync()
          this._batchDoneFiles.set(batchId, donePath)
        } finally {
          // Close before resolving completion waiters. The last waiter may
          // immediately unlink the .done log during batch compaction; on
          // Windows that must never race an open append handle.
          await handle.close()
        }
        for (const item of batch) item.resolve()
      } catch (err) {
        for (const item of batch) item.reject(err)
      }
    })()
    queue.flushing = run
    try {
      await run
    } finally {
      if (queue.flushing === run) queue.flushing = null
      if (queue.pending.length > 0) {
        queue.timer = setTimeout(() => {
          queue.timer = null
          void this._flushBatchCompletionQueue(batchId).catch((err) => {
            const current = this._batchCompletionQueues.get(batchId)
            const pending = current?.pending.splice(0) ?? []
            for (const item of pending) item.reject(err)
          })
        }, BATCH_COMPLETION_GROUP_MS)
        const anyT = queue.timer as unknown as { unref?: () => void }
        if (typeof anyT.unref === 'function') anyT.unref()
      } else {
        this._batchCompletionQueues.delete(batchId)
      }
    }
  }

  private _appendBatchCompletion(record: BatchCompletionRecord): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let queue = this._batchCompletionQueues.get(record.batchId)
      if (!queue) {
        queue = { pending: [], timer: null, flushing: null }
        this._batchCompletionQueues.set(record.batchId, queue)
      }
      queue.pending.push({ record, resolve, reject })
      if (queue.pending.length >= BATCH_COMPLETION_GROUP_MAX) {
        if (queue.timer) clearTimeout(queue.timer)
        queue.timer = null
        void this._flushBatchCompletionQueue(record.batchId).catch(reject)
        return
      }
      if (!queue.timer && !queue.flushing) {
        queue.timer = setTimeout(() => {
          queue!.timer = null
          void this._flushBatchCompletionQueue(record.batchId).catch((err) => {
            const current = this._batchCompletionQueues.get(record.batchId)
            const pending = current?.pending.splice(0) ?? []
            for (const item of pending) item.reject(err)
          })
        }, BATCH_COMPLETION_GROUP_MS)
        const anyT = queue.timer as unknown as { unref?: () => void }
        if (typeof anyT.unref === 'function') anyT.unref()
      }
    })
  }

  private _trackBatchResidualCheckpoint(batchId: string, operationId: string): void {
    const residual = this._batchResidualCheckpoints.get(batchId) ?? new Set<string>()
    residual.add(operationId)
    this._batchResidualCheckpoints.set(batchId, residual)
  }

  private _trackLegacyBatchCompletionFile(batchId: string, operationId: string): void {
    const legacy = this._batchLegacyCompletionFiles.get(batchId) ?? new Set<string>()
    legacy.add(operationId)
    this._batchLegacyCompletionFiles.set(batchId, legacy)
  }

  private async _markBatchOperationCompleted(operationId: string): Promise<string | null> {
    const batchId = this._batchByOperation.get(operationId)
    if (!batchId) return null

    const completed = this._batchCompleted.get(batchId) ?? new Set<string>()
    if (!completed.has(operationId)) {
      // One append-only completion log per batch keeps crash-safe replay
      // suppression without creating tens of thousands of tiny NTFS files.
      const record: BatchCompletionRecord = { v: 1, kind: 'batch-completed', batchId, operationId }
      await this._appendBatchCompletion(record)
      completed.add(operationId)
      this._batchCompleted.set(batchId, completed)
      this._completedBatchOperations.add(operationId)
      this._completedBatchOwners.set(operationId, batchId)
    }

    const members = this._batchMembers.get(batchId)
    members?.delete(operationId)
    // Completion durability is established here; physical checkpoint cleanup
    // and final batch compaction happen in remove() after the in-memory row is
    // dropped. That lets the last member record a rare Windows unlink failure
    // without forcing O(N) ENOENT probes for every completed sibling.
    this._batchByOperation.delete(operationId)
    return batchId
  }

  private async _cleanupCompletedBatches(): Promise<void> {
    for (const batchId of [...this._batchMembers.keys(), ...this._batchCompleted.keys()]) {
      await this._cleanupCompletedBatch(batchId)
    }
  }

  private async _cleanupCompletedBatch(batchId: string): Promise<void> {
    const members = this._batchMembers.get(batchId)
    if (members && members.size > 0) return
    const completed = this._batchCompleted.get(batchId)
    if (!completed || completed.size === 0) return

    // Normal per-operation checkpoint rows must disappear *before* the batch
    // acceptance record. While acceptance + completion evidence still exist,
    // a crash cannot replay those rows. Removing acceptance first would make a
    // leftover checkpoint look like an independent operation on next startup.
    const residualCheckpoints = this._batchResidualCheckpoints.get(batchId) ?? new Set<string>()
    for (const operationId of residualCheckpoints) {
      await fs.unlink(path.join(this.dir, `${operationId}.json`)).catch((err: unknown) => {
        if (!isErrnoCode(err, 'ENOENT')) throw err
      })
    }

    // Once every replayable checkpoint is gone, deleting acceptance makes all
    // remaining completion evidence informational only. This ordering is safe
    // for both the current .done log and legacy per-operation completion files.
    const batchPath = this._batchFiles.get(batchId) ?? this._batchPath(batchId)
    await fs.unlink(batchPath).catch((err: unknown) => {
      if (!isErrnoCode(err, 'ENOENT')) throw err
    })
    // Keep the compact append-only completion log for a bounded replay window.
    // This prevents a duplicated/retried x-open from reusing an operationId
    // after the acceptance record has been compacted away, including across a
    // Core restart, without creating one tombstone file per operation.
    const donePath = this._batchDoneFiles.get(batchId) ?? this._batchDonePath(batchId)
    const legacyCompletionFiles = this._batchLegacyCompletionFiles.get(batchId) ?? new Set<string>()
    for (const operationId of legacyCompletionFiles) {
      await fs.unlink(path.join(this.dir, `${operationId}.json`)).catch((err: unknown) => {
        if (!isErrnoCode(err, 'ENOENT')) throw err
      })
    }
    this._batchResidualCheckpoints.delete(batchId)
    this._batchLegacyCompletionFiles.delete(batchId)
    const total = this._batchTotals.get(batchId) ?? completed.size
    let completedAtMs = now()
    try {
      const stat = await fs.stat(donePath)
      const mtimeMs = Number(stat.mtimeMs)
      if (Number.isFinite(mtimeMs) && mtimeMs > 0) completedAtMs = mtimeMs
    } catch {}
    const expiresAtMs = completedAtMs + FINISHED_BATCH_TTL_MS
    this._finishedBatches.delete(batchId)
    this._finishedBatches.set(batchId, {
      total,
      completed: completed.size,
      expiresAtMs,
      operationIds: [...completed],
      donePath
    })
    const retainedOperationIds = (): number => {
      let count = 0
      for (const finished of this._finishedBatches.values()) count += finished.operationIds.length
      return count
    }
    // Replay suppression is deliberately bounded as well. Without a global
    // operation cap, 256 recently-completed 100k-file batches could retain
    // millions of UUID strings even though all transfer state was already
    // compacted. Evict oldest completed batches first; normal duplicate retries
    // still get a generous recent window while memory stays predictable.
    while (this._finishedBatches.size > MAX_FINISHED_BATCHES || retainedOperationIds() > MAX_FINISHED_OPERATION_IDS) {
      const oldest = this._finishedBatches.keys().next().value
      if (typeof oldest !== 'string') break
      this._forgetFinishedBatch(oldest)
    }
    this._pruneExpiredFinishedBatches(now())
    this._batchMembers.delete(batchId)
    this._batchCompleted.delete(batchId)
    this._batchTotals.delete(batchId)
    this._batchFiles.delete(batchId)
  }

  batchStatus(batchId: string): { batchId: string; total: number; completed: number; remaining: number; done: boolean } | null {
    if (!SAFE_ID_RE.test(batchId)) return null
    const finished = this._finishedBatches.get(batchId)
    if (finished) {
      if (finished.expiresAtMs < now()) {
        this._forgetFinishedBatch(batchId)
      } else {
        return { batchId, total: finished.total, completed: finished.completed, remaining: 0, done: true }
      }
    }
    const members = this._batchMembers.get(batchId)
    const completed = this._batchCompleted.get(batchId)
    const total = this._batchTotals.get(batchId) ?? ((members?.size ?? 0) + (completed?.size ?? 0))
    if (!members && !completed && total === 0) return null
    const completedCount = completed?.size ?? 0
    const remaining = members?.size ?? Math.max(0, total - completedCount)
    return { batchId, total, completed: completedCount, remaining, done: remaining === 0 }
  }

  async update(operationId: string, mutate: (row: JournalRow) => void, immediate = false): Promise<JournalRow | null> {
    const row = this._rows.get(operationId)
    if (!row) {
      dbg('journal update MISS', operationId)
      return null
    }
    const previousState = row.state
    mutate(row)
    if (row.state === 'waiting-peer' && previousState !== 'waiting-peer' && typeof row.waitingSinceMs !== 'number') row.waitingSinceMs = now()
    if (row.state === 'active') row.waitingSinceMs = null
    row.updatedAtMs = now()
    this._dirty.add(operationId)
    if (this._updCounter.get(operationId) === undefined) {
      this._updCounter.set(operationId, 0)
      dbg('journal update #1', operationId)
    }
    if (immediate) await this._flushOperation(operationId)
    else this._schedule()
    return row
  }

  recoveryState(operationId: string): RecoveryState {
    return normalizeRecoveryState(this._rows.get(operationId)?.recovery)
  }

  recoveryEligible(operationId: string, nowMs = now()): boolean {
    const state = this.recoveryState(operationId)
    return !state.blocked && !state.requiresUserAction && (state.nextAttemptAtMs === null || state.nextAttemptAtMs <= nowMs)
  }

  async claimRecovery(operationId: string, nowMs = now()): Promise<{ allowed: boolean; state: RecoveryState; reason?: string }> {
    const row = this._rows.get(operationId)
    if (!row) return { allowed: false, state: defaultRecoveryState(), reason: 'NOT_FOUND' }
    const state = normalizeRecoveryState(row.recovery)
    if (state.blocked || state.requiresUserAction) return { allowed: false, state, reason: 'RECOVERY_BLOCKED' }
    if (state.nextAttemptAtMs !== null && state.nextAttemptAtMs > nowMs) return { allowed: false, state, reason: 'RECOVERY_BACKOFF' }
    const attempt = state.attempts + 1
    state.generation += 1
    state.attempts = attempt
    state.lastAttemptAtMs = nowMs
    state.leaseId = `g${state.generation}`
    state.nextAttemptAtMs = attempt >= MAX_RECOVERY_ATTEMPTS ? null : nowMs + recoveryBackoff(attempt)
    if (attempt >= MAX_RECOVERY_ATTEMPTS) {
      state.blocked = true
      state.requiresUserAction = true
    }
    await this.update(operationId, (current) => {
      current.schemaVersion = 2
      current.recovery = { ...state }
    }, true)
    return { allowed: true, state: { ...state } }
  }

  async failRecovery(operationId: string, code: string, scope: RecoveryErrorScope = 'OPERATION', nowMs = now()): Promise<RecoveryState> {
    const row = this._rows.get(operationId)
    const state = normalizeRecoveryState(row?.recovery)
    state.lastErrorCode = code.slice(0, 128)
    state.lastErrorScope = scope
    state.lastAttemptAtMs = nowMs
    if (state.attempts >= MAX_RECOVERY_ATTEMPTS || scope === 'USER_ACTION') {
      state.blocked = true
      state.requiresUserAction = true
      state.nextAttemptAtMs = null
    } else {
      state.nextAttemptAtMs = nowMs + recoveryBackoff(Math.max(1, state.attempts))
    }
    if (row) await this.update(operationId, (current) => {
      current.schemaVersion = 2
      current.recovery = { ...state }
      current.error = state.lastErrorCode
    }, true)
    return { ...state }
  }

  async completeRecovery(operationId: string): Promise<RecoveryState> {
    const row = this._rows.get(operationId)
    const state = normalizeRecoveryState(row?.recovery)
    state.attempts = 0
    state.nextAttemptAtMs = null
    state.lastErrorCode = null
    state.lastErrorScope = null
    state.requiresUserAction = false
    state.blocked = false
    if (row) await this.update(operationId, (current) => {
      current.schemaVersion = 2
      current.recovery = { ...state }
      current.error = null
    }, true)
    return { ...state }
  }

  async resetRecovery(operationId: string): Promise<RecoveryState> {
    const row = this._rows.get(operationId)
    if (!row) return defaultRecoveryState()
    const state = defaultRecoveryState()
    state.generation = normalizeRecoveryState(row.recovery).generation
    await this.update(operationId, (current) => {
      current.schemaVersion = 2
      current.recovery = { ...state }
      current.error = null
    }, true)
    return { ...state }
  }

  private _updCounter = new Map<string, number>()

  touch(operationId: string): void {
    const row = this._rows.get(operationId)
    if (!row) return
    row.updatedAtMs = now()
    this._dirty.add(operationId)
    this._schedule()
  }

  private _schedule(): void {
    if (this._timer) return
    this._timer = setTimeout(() => {
      this._timer = null
      void this._flushDirty(false, true).catch((err) => {
        dbg('journal background flush failed', String((err as Error)?.message ?? err))
      })
    }, 250)
    const anyT = this._timer as unknown as { unref?: () => void }
    if (typeof anyT.unref === 'function') anyT.unref()
  }

  async flush(): Promise<void> {
    if (this._timer) clearTimeout(this._timer)
    this._timer = null
    // Shutdown/explicit flush must not leave a timer-backed completion group
    // behind. New arrivals that raced an in-flight group are drained in the
    // same loop before returning.
    for (const batchId of [...this._batchCompletionQueues.keys()]) {
      while (true) {
        const queue = this._batchCompletionQueues.get(batchId)
        if (!queue) break
        if (queue.flushing) await queue.flushing
        const after = this._batchCompletionQueues.get(batchId)
        if (!after) break
        if (after.pending.length === 0) {
          if (after.timer) { clearTimeout(after.timer); after.timer = null }
          this._batchCompletionQueues.delete(batchId)
          break
        }
        await this._flushBatchCompletionQueue(batchId)
      }
    }

    // Drain both dirtiness and already-queued per-row chains. Under normal
    // shutdown no new mutations arrive, but the loop also closes a race where
    // an update lands while a prior snapshot is being persisted.
    for (;;) {
      if (this._dirty.size > 0) await this._flushDirty(true, false)
      const active = [...this._rowFlushes.values()]
      if (active.length > 0) {
        const results = await Promise.allSettled(active)
        const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
        if (failed) throw failed.reason
      }
      if (this._dirty.size === 0 && this._rowFlushes.size === 0) break
    }
  }

  async shutdown(): Promise<void> {
    try {
      await this.flush()
    } finally {
      const workers = this._rowIoWorkers.splice(0)
      await Promise.allSettled(
        workers
          .filter((worker): worker is IsolatedIoWorker => worker !== null)
          .map((worker) => worker.terminate('journal store shutdown'))
      )
    }
  }

  private async _flushOperation(operationId: string): Promise<void> {
    if (this._removingRows.has(operationId)) return
    // One generation is enough for an immediate caller. _queueRowFlush chains
    // behind any older generation and snapshots the row only when its turn
    // begins, so the mutation that called us is necessarily included. Later
    // mutations may mark the row dirty again and are flushed by their own
    // immediate/background generation instead of extending this caller's
    // latency indefinitely.
    try {
      await this._queueRowFlush(operationId)
    } catch (err) {
      if (this._dirty.has(operationId)) this._schedule()
      throw err
    }
  }

  private async _flushDirty(throwOnFailure: boolean, scheduleRetry: boolean): Promise<void> {
    const ids = [...this._dirty].filter((id) => !this._removingRows.has(id))
    if (ids.length === 0) return
    const results = await Promise.allSettled(ids.map((id) => this._queueRowFlush(id)))
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (this._dirty.size > 0 && scheduleRetry) this._schedule()
    if (rejected && throwOnFailure) throw rejected.reason
  }

  private _queueRowFlush(operationId: string): Promise<void> {
    const previous = this._rowFlushes.get(operationId) ?? Promise.resolve()
    const run = previous.catch(() => {}).then(async () => {
      if (this._removingRows.has(operationId)) {
        this._dirty.delete(operationId)
        return
      }
      const row = this._rows.get(operationId)
      if (!row || !this._dirty.has(operationId)) return

      // Encode a stable snapshot, then clear only the dirtiness represented by
      // that snapshot. A concurrent update re-adds the id while this write is
      // in flight and therefore schedules/queues another generation.
      const encoded = encodeProtectedJson(row, this.protectedKey)
      this._dirty.delete(operationId)
      let lastErr: unknown = null
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          await this._withRowIoSlot(async (slot) => {
            const filePath = path.join(this.dir, `${operationId}.json`)
            if (!canUseIsolatedIoWorker()) {
              await writeFileAtomic(filePath, encoded)
              return
            }

            let worker = this._rowIoWorkers[slot]
            if (!worker) {
              worker = new IsolatedIoWorker()
              this._rowIoWorkers[slot] = worker
            }
            try {
              await worker.atomicWrite(filePath, b4a.from(encoded, 'utf8'))
            } catch (err) {
              // A timed-out/failed worker is disposable. Never reuse a process
              // whose syscall/IPC state is unknown; the existing journal retry
              // loop will acquire a clean replacement without weakening the
              // per-row durability barrier.
              if (this._rowIoWorkers[slot] === worker) this._rowIoWorkers[slot] = null
              await worker.terminate('journal pooled writer failed')
              throw err
            }
          })
          lastErr = null
          break
        } catch (err) {
          lastErr = err
          dbg('journal flush retry', operationId, attempt, String((err as Error)?.message ?? err))
          if (attempt < 3) await new Promise<void>((resolve) => setTimeout(() => resolve(), 120 * (attempt + 1)))
        }
      }
      if (lastErr) {
        dbg('journal flush failed', operationId, String((lastErr as Error)?.message ?? lastErr))
        if (!this._removingRows.has(operationId) && this._rows.has(operationId)) this._dirty.add(operationId)
        throw lastErr
      }
    })

    this._rowFlushes.set(operationId, run)
    const cleanup = (): void => {
      if (this._rowFlushes.get(operationId) === run) this._rowFlushes.delete(operationId)
    }
    void run.then(cleanup, cleanup)
    return run
  }

  private async _waitRowFlush(operationId: string): Promise<void> {
    for (;;) {
      const current = this._rowFlushes.get(operationId)
      if (!current) return
      await current.catch(() => {})
      if (this._rowFlushes.get(operationId) === current) this._rowFlushes.delete(operationId)
    }
  }

  private async _withRowIoSlot<T>(fn: (slot: number) => Promise<T>): Promise<T> {
    const available = this._rowIoFreeSlots.pop()
    const slot = available === undefined
      ? await new Promise<number>((resolve) => this._rowIoWaiters.push(resolve))
      : available
    try {
      return await fn(slot)
    } finally {
      const next = this._rowIoWaiters.shift()
      if (next) next(slot)
      else this._rowIoFreeSlots.push(slot)
    }
  }

  /**
   * Keep stale operation history bounded. Stale rows are useful for diagnostics,
   * but they must not become an unbounded on-disk/in-memory leak on long-lived
   * installations. Recent rows are retained, and the oldest overflow is pruned.
   */
  async pruneStale(nowMs = now()): Promise<number> {
    // The engine calls this maintenance hook every 30 seconds. Finished batch
    // tombstones therefore expire on time even when no caller asks batchStatus
    // or wasRecentlyCompleted again.
    this._pruneExpiredFinishedBatches(nowMs)

    const stale = [...this._rows.values()]
      .filter((row) =>
         row.state === 'stale' &&
         !row.files.some((file) => Boolean(file.partPath)) &&
         !row.files.some((file) => Boolean(file.finalize?.backupPath))

      )
      .sort((a, b) => a.updatedAtMs - b.updatedAtMs)
    if (stale.length === 0) return 0

    const cutoff = nowMs - STALE_RETENTION_MS
    const overflow = Math.max(0, stale.length - MAX_STALE_ROWS)
    const doomed = new Set<string>()
    for (let i = 0; i < stale.length; i++) {
      const row = stale[i]
      if (row.updatedAtMs < cutoff || i < overflow) doomed.add(row.operationId)
    }

    let removed = 0
    for (const operationId of doomed) {
      try {
        await this.remove(operationId)
        removed += 1
      } catch (err) {
        dbg('stale journal prune failed', operationId, String((err as Error)?.message ?? err))
      }
    }
    return removed
  }

  async remove(operationId: string): Promise<void> {
    // This method constructs a filename even when the row is already absent.
    // Keep the path-safety invariant local to the store, not only to callers.
    if (!SAFE_ID_RE.test(operationId)) throw new Error('invalid operationId')

    // Only the same row is a serialization dependency. Mark it removing before
    // waiting so a background generation queued behind the current flush will
    // observe the tombstone and skip instead of renaming stale JSON back after
    // terminal cleanup. Unrelated operationIds continue flushing concurrently.
    this._removingRows.add(operationId)
    const previous = this._rows.get(operationId) ?? null
    const wasDirty = this._dirty.delete(operationId)
    try {
      await this._waitRowFlush(operationId)
      // A killed isolated writer can leave only this deterministic temp name.
      // Once the same-row chain is drained it is no longer live, so terminal
      // removal can clean it without racing a writer for this operationId.
      const workerTempPath = `${path.join(this.dir, `${operationId}.json`)}.io-worker-tmp`
      await fs.unlink(workerTempPath).catch(() => {})

      let completedBatchId: string | null = null
      try {
        // If this operation was accepted through a durable batch record, append
        // its completion to the authenticated per-batch log before dropping the
        // in-memory row. Otherwise a crash could replay the original queued row.
        completedBatchId = await this._markBatchOperationCompleted(operationId)
      } catch (err) {
        if (previous && wasDirty) this._dirty.add(operationId)
        throw err
      }
      this._unindexPeerRow(operationId, previous)
      this._rows.delete(operationId)
      this._operationIndexRemoved += 1
      if (this._operationIndexRemoved > Math.max(1024, Math.floor(this._orderedOperationIds.length / 4))) {
        this._operationIndexDirty = true
      }
      this._updCounter.delete(operationId)

      // The batch completion record is already durable, so a per-operation
      // checkpoint file is no longer needed for recovery. Remove it immediately
      // instead of retaining thousands of completed checkpoint files until the
      // slowest sibling in a large batch finishes. A transient Windows sharing
      // failure is harmless here: final batch cleanup retries compatibility files.
      if (completedBatchId) {
        const checkpointPath = path.join(this.dir, `${operationId}.json`)
        let cleaned = false
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await fs.unlink(checkpointPath)
            cleaned = true
            break
          } catch (err: unknown) {
            if (isErrnoCode(err, 'ENOENT')) { cleaned = true; break }
            if (!isErrnoCode(err, 'EPERM', 'EACCES', 'EBUSY') || attempt === 2) break
            await new Promise<void>((resolve) => setTimeout(() => resolve(), 60 * (attempt + 1)))
          }
        }
        if (!cleaned) this._trackBatchResidualCheckpoint(completedBatchId, operationId)
        await this._cleanupCompletedBatch(completedBatchId)
        return
      }

      const filePath = path.join(this.dir, `${operationId}.json`)
      let lastErr: unknown = null
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          await fs.unlink(filePath)
          return
        } catch (err: unknown) {
          if (isErrnoCode(err, 'ENOENT')) return
          lastErr = err
          if (!isErrnoCode(err, 'EPERM', 'EACCES', 'EBUSY') || attempt === 5) break
          await new Promise<void>((resolve) => setTimeout(() => resolve(), 100 * (attempt + 1)))
        }
      }

      // The on-disk row is still present. Restore the in-memory row as dirty so
      // callers cannot observe a successful deletion that will reappear after a
      // restart.
      if (previous) {
        this._rows.set(operationId, previous)
        this._indexPeerRow(previous)
        this._dirty.add(operationId)
      }
      throw lastErr ?? new Error(`failed to remove journal ${operationId}`)
    } finally {
      this._removingRows.delete(operationId)
      if (this._dirty.size > 0) this._schedule()
    }
  }

  /** roots removed -> invalidate all operations bound to that destination/source root */
  async invalidateRoot(rootId: string): Promise<JournalRow[]> {
    const affected: JournalRow[] = []
    for (const row of this._rows.values()) {
      if (row.descriptor.source.rootId === rootId || row.descriptor.destination.rootId === rootId) {
        await this.update(row.operationId, (r) => {
          r.state = 'stale'
          r.error = 'root-removed'
        }, true)
        affected.push(row)
      }
    }
    return affected
  }

  async invalidatePeer(peerId: string): Promise<JournalRow[]> {
    const affected: JournalRow[] = []
    for (const row of this._rows.values()) {
      if (row.peerId === peerId && row.state !== 'done') {
        await this.update(row.operationId, (r) => {
          r.state = 'stale'
          r.error = 'peer-forgotten'
        }, true)
        affected.push(row)
      }
    }
    return affected
  }
}
