import { IoWorkerError, IsolatedIoWorker, isIoWorkerTerminationFenceFailure } from './io-worker-client'
import type { FilterSpec, ListEntry, ListSortSpec, ScanSnapshot, StableFileHash } from './fs-scan'
import type { FileStat } from './pathguard'
import type { IoStatPathResult } from './io-worker-protocol'

const DEFAULT_ROOT_WORKERS = 4

interface Waiter {
  resolve: () => void
  reject: (err: Error) => void
  cancelled?: () => boolean
  timer: ReturnType<typeof setInterval> | null
}

/**
 * Bounded owner for disposable filesystem worker processes.
 *
 * Each operation gets its own worker process so a blocked SMB/UNC syscall can
 * be killed without poisoning another request. The semaphore caps process and
 * storage queue pressure; a scan/manifest uses one worker for the whole scan,
 * never one process per file.
 */
export class RootFsExecutor {
  private active = 0
  private readonly waiters: Waiter[] = []
  private readonly workers = new Set<IsolatedIoWorker>()
  private destroyed = false
  private fatal: Error | null = null

  constructor(
    private readonly hashCachePath: string | null,
    private readonly maxWorkers = DEFAULT_ROOT_WORKERS
  ) {}

  private async acquire(cancelled?: () => boolean): Promise<void> {
    if (this.fatal) throw this.fatal
    if (this.destroyed) throw new IoWorkerError('CANCELLED', 'root filesystem executor destroyed')
    if (cancelled?.()) throw new IoWorkerError('CANCELLED', 'root filesystem operation cancelled')
    if (this.active < this.maxWorkers) {
      this.active++
      return
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, cancelled, timer: null }
      if (cancelled) {
        waiter.timer = setInterval(() => {
          if (!cancelled()) return
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          if (waiter.timer) clearInterval(waiter.timer)
          waiter.timer = null
          reject(new IoWorkerError('CANCELLED', 'root filesystem operation cancelled'))
        }, 50)
        const t = waiter.timer as unknown as { unref?: () => void }
        t.unref?.()
      }
      this.waiters.push(waiter)
    })
  }

  private release(): void {
    if (this.active > 0) this.active--
    while (this.waiters.length) {
      const waiter = this.waiters.shift()!
      if (waiter.cancelled?.()) {
        if (waiter.timer) clearInterval(waiter.timer)
        waiter.reject(new IoWorkerError('CANCELLED', 'root filesystem operation cancelled'))
        continue
      }
      if (waiter.timer) clearInterval(waiter.timer)
      waiter.timer = null
      this.active++
      waiter.resolve()
      break
    }
  }

  private poison(err: Error): void {
    if (this.fatal) return
    this.fatal = err
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.timer) clearInterval(waiter.timer)
      waiter.timer = null
      waiter.reject(err)
    }
  }

  private async run<T>(
    fn: (worker: IsolatedIoWorker) => Promise<T>,
    cancelled?: () => boolean
  ): Promise<T> {
    await this.acquire(cancelled)
    let worker: IsolatedIoWorker | null = null
    try {
      // Slot ownership starts at acquire(), not at worker construction. Keep
      // every operation after acquire inside this try/finally so a synchronous
      // spawn/constructor failure cannot leak semaphore capacity.
      worker = new IsolatedIoWorker()
      this.workers.add(worker)
      return await fn(worker)
    } finally {
      if (worker) {
        try {
          await worker.terminate('root filesystem operation complete')
          this.workers.delete(worker)
        } catch (err) {
          if (isIoWorkerTerminationFenceFailure(err)) {
            // Never hand this capacity/namespace to a replacement worker. In
            // standalone production the global fail-closed handler terminates
            // the Core generation; this poison also protects direct/library use.
            const fatal = err instanceof Error ? err : new Error(String(err))
            this.poison(fatal)
            throw fatal
          }
          throw err
        }
      }
      this.release()
    }
  }

  async stableHash(root: string, rel: string, cancelled?: () => boolean): Promise<StableFileHash> {
    return await this.run(
      async (worker) => await worker.stableHash(root, rel, this.hashCachePath, { cancelled }),
      cancelled
    )
  }

  async manifest(
    root: string,
    rel: string,
    filter: FilterSpec | null,
    maxEntries: number,
    scanId: string,
    cancelled?: () => boolean,
    onProgress?: (bytes: number) => void
  ): Promise<ScanSnapshot> {
    return await this.run(
      async (worker) => await worker.manifest(root, rel, filter, maxEntries, scanId, this.hashCachePath, { cancelled, onProgress }) as ScanSnapshot,
      cancelled
    )
  }

  async listAll(root: string, rel: string, sort: ListSortSpec | null, cancelled?: () => boolean): Promise<ListEntry[]> {
    return await this.run(
      async (worker) => await worker.listAll(root, rel, sort, { cancelled }) as ListEntry[],
      cancelled
    )
  }

  async statPath(root: string, rel: string, cancelled?: () => boolean): Promise<ListEntry | null> {
    return await this.run(
      async (worker) => await worker.statPath(root, rel, { cancelled }) as ListEntry | null,
      cancelled
    )
  }

  async statPaths(root: string, rels: string[], cancelled?: () => boolean): Promise<IoStatPathResult[]> {
    return await this.run(async (worker) => {
      const results: IoStatPathResult[] = []
      // Keep one isolated process for the whole logical batch, while bounding
      // each parent-channel frame to the same 64-path envelope used on fs.v1.
      for (let offset = 0; offset < rels.length; offset += 64) {
        if (cancelled?.()) throw new IoWorkerError('CANCELLED', 'stat batch cancelled')
        results.push(...await worker.statPaths(root, rels.slice(offset, offset + 64), { cancelled }))
      }
      return results
    }, cancelled)
  }

  async statFile(pathname: string, cancelled?: () => boolean): Promise<FileStat | null> {
    return await this.run(async (worker) => await worker.statFile(pathname, { cancelled }), cancelled)
  }

  async preparePut(root: string, rel: string, cancelled?: () => boolean): Promise<string> {
    return await this.run(async (worker) => await worker.preparePut(root, rel, { cancelled }), cancelled)
  }

  async hashAbsolute(pathname: string, cancelled?: () => boolean): Promise<{ hex: string; size: number }> {
    return await this.run(async (worker) => await worker.hash(pathname, { cancelled }), cancelled)
  }

  /**
   * SHA-256 of an absolute path, for the update digest check.
   *
   * Separate from `hashAbsolute` because content addressing elsewhere uses
   * blake2b-256; an update is verified against the digest its metadata
   * advertises, so the algorithm cannot be substituted.
   */
  async sha256Absolute(pathname: string, cancelled?: () => boolean): Promise<{ hex: string; size: number }> {
    return await this.run(async (worker) => await worker.sha256(pathname, { cancelled }), cancelled)
  }

  async unlink(pathname: string, ignoreMissing = false, cancelled?: () => boolean): Promise<void> {
    await this.run(async (worker) => await worker.unlink(pathname, ignoreMissing, { cancelled }), cancelled)
  }

  async rename(from: string, to: string, cancelled?: () => boolean): Promise<void> {
    await this.run(async (worker) => await worker.rename(from, to, { cancelled }), cancelled)
  }

  async link(from: string, to: string, cancelled?: () => boolean): Promise<void> {
    await this.run(async (worker) => await worker.link(from, to, { cancelled }), cancelled)
  }

  async copyExclusive(from: string, to: string, cancelled?: () => boolean): Promise<void> {
    return await this.run(
      async (worker) => await worker.copyExclusive(from, to, { cancelled }),
      cancelled
    )
  }

  async claimExclusiveCopy(to: string, cancelled?: () => boolean): Promise<string> {
    return await this.run(
      async (worker) => await worker.claimExclusiveCopy(to, { cancelled }),
      cancelled
    )
  }

  async copyIntoClaim(from: string, cancelled?: () => boolean): Promise<void> {
    return await this.run(
      async (worker) => await worker.copyIntoClaim(from, { cancelled }),
      cancelled
    )
  }

  async chmod(pathname: string, mode: number, cancelled?: () => boolean): Promise<void> {
    await this.run(async (worker) => await worker.chmod(pathname, mode, { cancelled }), cancelled)
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return
    this.destroyed = true
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.timer) clearInterval(waiter.timer)
      waiter.reject(new IoWorkerError('CANCELLED', 'root filesystem executor destroyed'))
    }
    await Promise.allSettled([...this.workers].map((worker) => worker.terminate('root filesystem executor destroyed')))
    this.workers.clear()
  }
}
