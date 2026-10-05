import os from 'bare-os'
import path from 'bare-path'
import { spawn } from 'bare-subprocess'
import type { IoFileStat, IoFilterSpec, IoListEntry, IoListSortSpec, IoManifestSnapshot, IoStableFileHash, IoStatPathResult, IoWorkerMessage, IoWorkerRequest, IoWorkerResult } from './io-worker-protocol'

const DEFAULT_IO_TIMEOUT_MS = 120_000
const JOURNAL_IO_TIMEOUT_MS = 20_000
const TERMINATE_WAIT_MS = 1_500
export const IO_WORKER_TERMINATION_UNCONFIRMED = 'IO_WORKER_TERMINATION_UNCONFIRMED'

type RequestPayload = IoWorkerRequest extends infer Request
  ? Request extends { id: number }
    ? Omit<Request, 'id'>
    : never
  : never

type SpawnedProcess = {
  readonly pid: number
  readonly killed: boolean
  readonly connected: boolean
  on(event: 'message', cb: (message: unknown) => void): void
  on(event: 'exit', cb: (code: number | null, signal: string | null) => void): void
  on(event: 'error', cb: (err: Error) => void): void
  on(event: 'disconnect', cb: () => void): void
  send(message: unknown, handle?: unknown, cb?: (err?: Error | null) => void): boolean
  disconnect(): void
  kill(signum?: number | string): void
}

type BareWorkerSpawnOptions = {
  stdio: Array<'ignore' | 'ipc'>
  windowsHide: boolean
  serialization: 'advanced'
}

type BareSpawnWithWorkerOptions = (
  file: string,
  args: string[] | null,
  opts: BareWorkerSpawnOptions
) => SpawnedProcess

// bare-subprocess 6.1.0 supports spawn(file, args, options), IPC stdio and
// advanced serialization at runtime, but its overloaded TypeScript declaration
// does not model that combination completely. Keep the compatibility cast at
// this boundary instead of deriving the third argument via Parameters<...>,
// which resolves to the library's two-argument overload.
const spawnWorkerProcess = spawn as unknown as BareSpawnWithWorkerOptions

interface PendingRequest {
  id: number
  resolve: (result: IoWorkerResult) => void
  reject: (err: Error) => void
  timeoutMs: number
  timer: ReturnType<typeof setTimeout> | null
  cancelTimer: ReturnType<typeof setInterval> | null
  onProgress?: (bytes: number) => void
}

interface RequestOptions {
  cancelled?: () => boolean
  onProgress?: (bytes: number) => void
}

export class IoWorkerError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

type TerminationFenceFailureHandler = (error: IoWorkerError) => void
let terminationFenceFailureHandler: TerminationFenceFailureHandler | null = null

/**
 * Standalone Core installs a fail-closed handler here. If a hard-killed worker
 * does not reach an observed `exit`, callers must not continue against the same
 * persistent namespace. The handler therefore escalates the whole Core
 * generation so the Python-owned Job Object can retire every descendant.
 */
export function setIoWorkerTerminationFenceFailureHandler(handler: TerminationFenceFailureHandler | null): void {
  terminationFenceFailureHandler = handler
}

export function isIoWorkerTerminationFenceFailure(err: unknown): boolean {
  return !!err && typeof err === 'object'
    && (err as { code?: unknown }).code === IO_WORKER_TERMINATION_UNCONFIRMED
}

export function canUseIsolatedIoWorker(): boolean {
  if (typeof Bare === 'undefined') return false
  try {
    const exe = os.execPath()
    const base = path.basename(exe).toLowerCase()
    // When running `bare entry.js` in development, execPath points at the Bare
    // runtime, not at this bundle. The standalone PSNCore binary can
    // safely self-spawn into the worker branch.
    return Boolean(exe) && base !== 'bare' && base !== 'bare.exe'
  } catch {
    return false
  }
}

function spawnWorker(): SpawnedProcess {
  const opts: BareWorkerSpawnOptions = {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
    serialization: 'advanced'
  }
  return spawnWorkerProcess(
    os.execPath(),
    ['--peersync-io-worker'],
    opts
  )
}

export class IsolatedIoWorker {
  private readonly child: SpawnedProcess
  private pending: PendingRequest | null = null
  private nextId = 1
  private closed = false
  private exited = false
  private exitResolve!: () => void
  private readonly exitPromise: Promise<void>
  private termination: Promise<void> | null = null

  constructor() {
    if (!canUseIsolatedIoWorker()) throw new IoWorkerError('UNSUPPORTED', 'isolated I/O worker requires standalone Bare runtime')
    this.exitPromise = new Promise<void>((resolve) => { this.exitResolve = resolve })
    this.child = spawnWorker()
    this.child.on('message', (message) => this.onMessage(message))
    this.child.on('exit', () => this.onExit())
    this.child.on('disconnect', () => {
      if (this.exited || this.closed) return
      const pending = this.pending
      if (pending) {
        this.rejectPendingAfterTermination(
          pending,
          new IoWorkerError('IO_WORKER_EXIT', 'I/O worker disconnected'),
          'I/O worker disconnected'
        )
      } else {
        void this.terminate('I/O worker disconnected').catch(() => {})
      }
    })
    this.child.on('error', (err) => {
      if (this.exited || this.closed) return
      const pending = this.pending
      if (pending) {
        this.rejectPendingAfterTermination(
          pending,
          new IoWorkerError('IO_WORKER', err.message),
          'I/O worker process error'
        )
      } else {
        void this.terminate('I/O worker process error').catch(() => {})
      }
    })
  }

  private clearPendingTimers(pending: PendingRequest): void {
    if (pending.timer) clearTimeout(pending.timer)
    pending.timer = null
    if (pending.cancelTimer) clearInterval(pending.cancelTimer)
    pending.cancelTimer = null
  }

  private onMessage(message: unknown): void {
    if (!message || typeof message !== 'object') return
    const msg = message as IoWorkerMessage
    const pending = this.pending
    if (!pending || msg.id !== pending.id) return
    if (msg.type === 'progress') {
      pending.onProgress?.(msg.bytes)
      this.armTimer(pending)
      return
    }
    if (msg.type !== 'result') return
    this.pending = null
    this.clearPendingTimers(pending)
    if (msg.ok) pending.resolve(msg.result)
    else pending.reject(new IoWorkerError(msg.error.code, msg.error.message))
  }

  private onExit(): void {
    if (this.exited) return
    this.exited = true
    this.failPending(new IoWorkerError('IO_WORKER_EXIT', 'I/O worker exited'))
    this.exitResolve()
  }

  private detachPending(): PendingRequest | null {
    const pending = this.pending
    this.pending = null
    if (pending) this.clearPendingTimers(pending)
    return pending
  }

  private failPending(err: Error): void {
    const pending = this.detachPending()
    pending?.reject(err)
  }

  /**
   * Timeout/cancel is not reported to the caller until the mutating process is
   * proven dead. This is the ownership barrier that prevents recovery/retry
   * from racing a late Windows filesystem completion from the old worker.
   */
  private rejectPendingAfterTermination(pending: PendingRequest, err: Error, reason: string): void {
    if (this.pending !== pending) return
    this.detachPending()
    void this.terminate(reason).then(
      () => pending.reject(err),
      (terminationErr: unknown) => pending.reject(
        terminationErr instanceof Error ? terminationErr : new Error(String(terminationErr))
      )
    )
  }

  private armTimer(pending: PendingRequest): void {
    if (pending.timer) clearTimeout(pending.timer)
    pending.timer = setTimeout(() => {
      if (this.pending !== pending) return
      this.rejectPendingAfterTermination(
        pending,
        new IoWorkerError('IO_TIMEOUT', `local I/O did not make progress for ${pending.timeoutMs}ms`),
        'I/O timeout'
      )
    }, pending.timeoutMs)
  }

  async request(payload: RequestPayload, timeoutMs = DEFAULT_IO_TIMEOUT_MS, options: RequestOptions = {}): Promise<IoWorkerResult> {
    if (this.closed || this.exited) throw new IoWorkerError('CANCELLED', 'I/O worker is closed')
    if (options.cancelled?.()) throw new IoWorkerError('CANCELLED', 'I/O request cancelled')
    if (this.pending) throw new IoWorkerError('IO_WORKER_BUSY', 'I/O worker already has an active request')
    const id = this.nextId++
    return await new Promise<IoWorkerResult>((resolve, reject) => {
      const pending: PendingRequest = { id, resolve, reject, timeoutMs, timer: null, cancelTimer: null, onProgress: options.onProgress }
      this.pending = pending
      this.armTimer(pending)
      if (options.cancelled) {
        pending.cancelTimer = setInterval(() => {
          if (this.pending !== pending || !options.cancelled?.()) return
          this.rejectPendingAfterTermination(
            pending,
            new IoWorkerError('CANCELLED', 'I/O request cancelled'),
            'I/O request cancelled'
          )
        }, 50)
        const timer = pending.cancelTimer as unknown as { unref?: () => void }
        timer.unref?.()
      }
      try {
        this.child.send({ id, ...payload }, undefined, (err?: Error | null) => {
          if (!err || this.pending !== pending) return
          this.rejectPendingAfterTermination(
            pending,
            new IoWorkerError('IO_WORKER', err.message),
            'I/O worker IPC send failed'
          )
        })
      } catch (err) {
        if (this.pending !== pending) return
        this.rejectPendingAfterTermination(
          pending,
          err instanceof Error ? err : new Error(String(err)),
          'I/O worker IPC send failed'
        )
      }
    })
  }

  async openRead(pathname: string): Promise<number> {
    const result = await this.request({ op: 'open-read', path: pathname })
    if (!('size' in result)) throw new IoWorkerError('IO_WORKER_PROTOCOL', 'open-read returned invalid result')
    return result.size
  }

  async openReadRoot(root: string, rel: string): Promise<{ path: string; size: number }> {
    const result = await this.request({ op: 'open-read-root', root, rel })
    if (!('path' in result) || !('size' in result)) throw new IoWorkerError('IO_WORKER_PROTOCOL', 'open-read-root returned invalid result')
    return { path: result.path, size: result.size }
  }

  async openWrite(pathname: string, size: number, opts: { exclusive?: boolean } = {}): Promise<void> {
    await this.request({ op: 'open-write', path: pathname, size, exclusive: opts.exclusive === true })
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    const result = await this.request({ op: 'read', offset, length })
    if (!('data' in result)) throw new IoWorkerError('IO_WORKER_PROTOCOL', 'read returned invalid result')
    return result.data
  }

  async write(offset: number, data: Uint8Array): Promise<void> {
    await this.request({ op: 'write', offset, data })
  }

  async sync(): Promise<void> {
    await this.request({ op: 'sync' })
  }

  async closeHandle(): Promise<void> {
    await this.request({ op: 'close-handle' })
  }

  async hash(pathname: string, options: RequestOptions = {}): Promise<{ hex: string; size: number }> {
    const result = await this.request({ op: 'hash', path: pathname }, DEFAULT_IO_TIMEOUT_MS, options)
    if (!('hex' in result) || !('size' in result)) throw new IoWorkerError('IO_WORKER_PROTOCOL', 'hash returned invalid result')
    return { hex: result.hex, size: result.size }
  }

  async sha256(pathname: string, options: RequestOptions = {}): Promise<{ hex: string; size: number }> {
    const result = await this.request({ op: 'sha256', path: pathname }, DEFAULT_IO_TIMEOUT_MS, options)
    if (!('hex' in result) || !('size' in result)) throw new IoWorkerError('IO_WORKER_PROTOCOL', 'sha256 returned invalid result')
    return { hex: result.hex, size: result.size }
  }

  async stableHash(root: string, rel: string, hashCachePath: string | null, options: RequestOptions = {}): Promise<IoStableFileHash> {
    const result = await this.request({ op: 'stable-hash', root, rel, hashCachePath }, DEFAULT_IO_TIMEOUT_MS, options)
    if (!('stable' in result)) throw new IoWorkerError('IO_WORKER_PROTOCOL', 'stable-hash returned invalid result')
    return result.stable
  }

  async manifest(root: string, rel: string, filter: IoFilterSpec | null, maxEntries: number, scanId: string, hashCachePath: string | null, options: RequestOptions = {}): Promise<IoManifestSnapshot> {
    const result = await this.request({ op: 'manifest', root, rel, filter, maxEntries, scanId, hashCachePath }, Math.max(DEFAULT_IO_TIMEOUT_MS, 10 * 60_000), options)
    if (!('manifest' in result)) throw new IoWorkerError('IO_WORKER_PROTOCOL', 'manifest returned invalid result')
    return result.manifest
  }

  async listAll(root: string, rel: string, sort: IoListSortSpec | null, options: RequestOptions = {}): Promise<IoListEntry[]> {
    const result = await this.request({ op: 'list-all', root, rel, sort }, Math.max(DEFAULT_IO_TIMEOUT_MS, 5 * 60_000), options)
    if (!('entries' in result)) throw new IoWorkerError('IO_WORKER_PROTOCOL', 'list-all returned invalid result')
    return result.entries
  }

  async statPath(root: string, rel: string, options: RequestOptions = {}): Promise<IoListEntry | null> {
    const result = await this.request({ op: 'stat-path', root, rel }, DEFAULT_IO_TIMEOUT_MS, options)
    if (!('entry' in result)) throw new IoWorkerError('IO_WORKER_PROTOCOL', 'stat-path returned invalid result')
    return result.entry
  }

  async statPaths(root: string, rels: string[], options: RequestOptions = {}): Promise<IoStatPathResult[]> {
    const result = await this.request({ op: 'stat-path-batch', root, rels }, DEFAULT_IO_TIMEOUT_MS, options)
    if (!('stats' in result) || !Array.isArray(result.stats)) {
      throw new IoWorkerError('IO_WORKER_PROTOCOL', 'stat-path-batch returned invalid result')
    }
    return result.stats
  }

  async statFile(pathname: string, options: RequestOptions = {}): Promise<IoFileStat | null> {
    const result = await this.request({ op: 'stat-file', path: pathname }, DEFAULT_IO_TIMEOUT_MS, options)
    if (!('stat' in result)) throw new IoWorkerError('IO_WORKER_PROTOCOL', 'stat-file returned invalid result')
    return result.stat
  }

  async preparePut(root: string, rel: string, options: RequestOptions = {}): Promise<string> {
    const result = await this.request({ op: 'prepare-put', root, rel }, DEFAULT_IO_TIMEOUT_MS, options)
    if (!('path' in result)) throw new IoWorkerError('IO_WORKER_PROTOCOL', 'prepare-put returned invalid result')
    return result.path
  }

  async unlink(pathname: string, ignoreMissing = false, options: RequestOptions = {}): Promise<void> {
    await this.request({ op: 'unlink', path: pathname, ignoreMissing }, DEFAULT_IO_TIMEOUT_MS, options)
  }

  async rename(from: string, to: string, options: RequestOptions = {}): Promise<void> {
    await this.request({ op: 'rename', from, to }, DEFAULT_IO_TIMEOUT_MS, options)
  }

  async link(from: string, to: string, options: RequestOptions = {}): Promise<void> {
    await this.request({ op: 'link', from, to }, DEFAULT_IO_TIMEOUT_MS, options)
  }

  async copyExclusive(from: string, to: string, options: RequestOptions = {}): Promise<void> {
    await this.request(
      { op: 'copy-exclusive', from, to },
      DEFAULT_IO_TIMEOUT_MS,
      options
    )
  }

  /**
   * Claim `to` with an exclusive create and return the identity of the created
   * file object. No payload byte is written, so the caller can journal the
   * identity before starting the copy.
   */
  async claimExclusiveCopy(to: string, options: RequestOptions = {}): Promise<string> {
    const result = await this.request(
      { op: 'claim-exclusive-copy', to },
      DEFAULT_IO_TIMEOUT_MS,
      options
    )
    if (!('identity' in result) || typeof result.identity !== 'string') {
      throw new IoWorkerError('IO_WORKER_PROTOCOL', 'claim-exclusive-copy returned invalid result')
    }
    return result.identity
  }

  /** Write the partial into the destination held by `claimExclusiveCopy`. */
  async copyIntoClaim(from: string, options: RequestOptions = {}): Promise<void> {
    await this.request({ op: 'copy-into-claim', from }, DEFAULT_IO_TIMEOUT_MS, options)
  }

  async chmod(pathname: string, mode: number, options: RequestOptions = {}): Promise<void> {
    await this.request({ op: 'chmod', path: pathname, mode }, DEFAULT_IO_TIMEOUT_MS, options)
  }

  async atomicWrite(pathname: string, data: Uint8Array): Promise<void> {
    await this.request({ op: 'atomic-write', path: pathname, data }, JOURNAL_IO_TIMEOUT_MS)
  }

  async terminate(reason = 'I/O worker closed'): Promise<void> {
    if (!this.termination) this.termination = this.terminateInner(reason)
    await this.termination
  }

  private async terminateInner(reason: string): Promise<void> {
    this.closed = true
    // Detach the request, but do not settle it yet. A caller observing
    // CANCELLED/IO_TIMEOUT is allowed to recover/retry, so settlement itself
    // must be behind the process-exit fence.
    const pending = this.detachPending()

    if (!this.exited) {
      try { this.child.kill('SIGKILL') } catch {}
      await Promise.race([this.exitPromise, delay(TERMINATE_WAIT_MS)])
    }

    if (!this.exited) {
      const error = new IoWorkerError(
        IO_WORKER_TERMINATION_UNCONFIRMED,
        `I/O worker ${this.child.pid} did not confirm exit after hard kill (${reason})`
      )
      pending?.reject(error)
      // This callback must be fail-closed in the standalone Core. It is invoked
      // before this method can reject back to code that might otherwise retry.
      try { terminationFenceFailureHandler?.(error) } catch {}
      throw error
    }

    pending?.reject(new IoWorkerError('CANCELLED', reason))
  }
}

export async function atomicWriteIsolated(pathname: string, data: Uint8Array): Promise<void> {
  const worker = new IsolatedIoWorker()
  try {
    await worker.atomicWrite(pathname, data)
  } finally {
    await worker.terminate('atomic write complete')
  }
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(() => resolve(), ms))
}
