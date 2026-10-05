/**
 * DiskAdapter: the single seam through which FsEngine touches the filesystem.
 *
 * Two implementations exist because of one requirement: a blocked SMB/UNC
 * syscall must stay cancellable. `WorkerDiskAdapter` runs each operation in a
 * disposable OS worker process that can be killed; `DirectDiskAdapter` is the
 * in-process fallback for runtimes where the worker cannot be spawned.
 *
 * Every effect on an allowlisted root goes through here, so the implementation
 * choice is made once instead of at every call site, and the protocol state
 * machine above the seam never learns which one is in use.
 */
import fsp from 'bare-fs/promises'
import { RootFsExecutor } from './root-fs-executor'
import { canUseIsolatedIoWorker } from './io-worker-client'
import { ManifestHashCache } from './manifest-hash-cache'
import {
  createManifest,
  hashStableFile,
  statPath,
  listAllEntries,
  type FilterSpec,
  type ListEntry,
  type ListSortSpec,
  type ScanSnapshot,
  type StableFileHash
} from './fs-scan'
import {
  ensureRealDirs,
  statFile,
  resolveAllowedPath,
  validateRelativePath,
  type FileStat
} from './pathguard'
import { hashFile, sha256File } from './hashing'
import { MANIFEST_MAX_ENTRIES } from './limits'
import { EngineError, errorCode, errorMessage, isErrnoCode } from './errors'
import { joinNativePart } from './native-path'
import { COPY_CHUNK, copyFileExclusiveLocal, writeExact } from './copy-local'
import { openFile, bytesReadOf, type FileHandle } from './fs-handle'
import { statIdentity } from '@peersync/drive'

export interface DiskAdapter {
  statPath(root: string, rel: string, cancelled?: () => boolean): Promise<ListEntry | null>
  listAll(root: string, rel: string, sort: ListSortSpec | null): Promise<ListEntry[]>
  statPaths(
    root: string,
    rels: string[],
    cancelled?: () => boolean
  ): Promise<Array<{ entry?: ListEntry; error?: { code: string; message: string } }>>
  stableHash(root: string, rel: string, cancelled?: () => boolean): Promise<StableFileHash>
  manifest(
    root: string,
    rel: string,
    filter: FilterSpec | null,
    scanId: string,
    cancelToken: { cancelled: boolean },
    onProgress?: (filesDone: number, bytesDone: number) => void,
    maxEntries?: number
  ): Promise<ScanSnapshot>
  statFile(pathname: string, cancelled?: () => boolean): Promise<FileStat | null>
  preparePut(root: string, rel: string, cancelled?: () => boolean): Promise<string>
  hashAbsolute(pathname: string, cancelled?: () => boolean): Promise<{ hex: string; size: number }>
  /** SHA-256 of an absolute path, for verifying a downloaded update. */
  sha256Absolute(pathname: string, cancelled?: () => boolean): Promise<{ hex: string; size: number }>
  unlink(pathname: string, ignoreMissing?: boolean): Promise<void>
  rename(from: string, to: string): Promise<void>
  link(from: string, to: string): Promise<void>
  copyExclusive(from: string, to: string): Promise<void>
  chmod(pathname: string, mode: number): Promise<void>
  /**
   * Claim `to` with an exclusive create and return the identity of the created
   * file object, without writing payload. The caller journals that identity
   * before requesting the copy, so a crash mid-copy is provably ours.
   */
  claimExclusiveCopy(to: string): Promise<string>
  copyIntoClaim(from: string): Promise<void>
  /** Release any claim or handle held after a failure. */
  dispose(): Promise<void>
}

/** Runs each operation in a killable worker process. */
export class WorkerDiskAdapter implements DiskAdapter {
  constructor(private readonly worker: RootFsExecutor) {}

  async statPath(root: string, rel: string, cancelled?: () => boolean): Promise<ListEntry | null> {
    validateRelativePath(rel, { allowEmpty: true, field: 'STAT' })
    return await this.worker.statPath(root, rel, cancelled)
  }

  async listAll(
    root: string,
    rel: string,
    sort: ListSortSpec | null,
    cancelled?: () => boolean
  ): Promise<ListEntry[]> {
    return await this.worker.listAll(root, rel, sort, cancelled)
  }

  async statPaths(
    root: string,
    rels: string[],
    cancelled?: () => boolean
  ): Promise<Array<{ entry?: ListEntry; error?: { code: string; message: string } }>> {
    for (const rel of rels) validateRelativePath(rel, { allowEmpty: true, field: 'STAT' })
    return await this.worker.statPaths(root, rels, cancelled)
  }

  async stableHash(root: string, rel: string, cancelled?: () => boolean): Promise<StableFileHash> {
    validateRelativePath(rel, { allowEmpty: false, field: 'GET' })
    return await this.worker.stableHash(root, rel, cancelled)
  }

  async manifest(
    root: string,
    rel: string,
    filter: FilterSpec | null,
    scanId: string,
    cancelToken: { cancelled: boolean },
    onProgress?: (filesDone: number, bytesDone: number) => void,
    maxEntries: number = MANIFEST_MAX_ENTRIES
  ): Promise<ScanSnapshot> {
    validateRelativePath(rel, { allowEmpty: true, field: 'MANIFEST' })
    let lastBytes = 0
    const snap = await this.worker.manifest(
      root,
      rel,
      filter,
      maxEntries,
      scanId,
      () => cancelToken.cancelled,
      (bytes) => {
        lastBytes = Math.max(lastBytes, bytes)
        onProgress?.(0, lastBytes)
      }
    )
    onProgress?.(snap.fileCount, snap.totalBytes)
    return snap
  }

  async statFile(pathname: string, cancelled?: () => boolean): Promise<FileStat | null> {
    return await this.worker.statFile(pathname, cancelled)
  }

  async preparePut(root: string, rel: string, cancelled?: () => boolean): Promise<string> {
    validateRelativePath(rel, { allowEmpty: false, field: 'PUT' })
    return await this.worker.preparePut(root, rel, cancelled)
  }

  async hashAbsolute(pathname: string, cancelled?: () => boolean): Promise<{ hex: string; size: number }> {
    // Absolute paths reaching this helper were already derived from a validated
    // allowlisted root. The bounded executor keeps the blocking read outside
    // Core while preserving global worker pressure limits.
    return await this.worker.hashAbsolute(pathname, cancelled)
  }

  async sha256Absolute(pathname: string, cancelled?: () => boolean): Promise<{ hex: string; size: number }> {
    return await this.worker.sha256Absolute(pathname, cancelled)
  }

  async unlink(pathname: string, ignoreMissing = true): Promise<void> {
    return await this.worker.unlink(pathname, ignoreMissing)
  }

  async rename(from: string, to: string): Promise<void> {
    return await this.worker.rename(from, to)
  }

  async link(from: string, to: string): Promise<void> {
    return await this.worker.link(from, to)
  }

  async copyExclusive(from: string, to: string): Promise<void> {
    return await this.worker.copyExclusive(from, to)
  }

  async chmod(pathname: string, mode: number): Promise<void> {
    return await this.worker.chmod(pathname, mode)
  }

  async claimExclusiveCopy(to: string): Promise<string> {
    return await this.worker.claimExclusiveCopy(to)
  }

  async copyIntoClaim(from: string): Promise<void> {
    return await this.worker.copyIntoClaim(from)
  }

  async dispose(): Promise<void> {
    await this.worker.destroy()
  }
}

/** In-process fallback used when the worker runtime cannot be spawned. */
export class DirectDiskAdapter implements DiskAdapter {
  private _claim: FileHandle | null = null

  constructor(private readonly hashCache: ManifestHashCache) {}

  async statPath(root: string, rel: string): Promise<ListEntry | null> {
    validateRelativePath(rel, { allowEmpty: true, field: 'STAT' })
    return await statPath(root, rel)
  }

  async listAll(
    root: string,
    rel: string,
    sort: ListSortSpec | null
  ): Promise<ListEntry[]> {
    validateRelativePath(rel, { allowEmpty: true, field: 'LIST' })
    return await listAllEntries(root, rel, sort)
  }

  async statPaths(
    root: string,
    rels: string[],
    cancelled?: () => boolean
  ): Promise<Array<{ entry?: ListEntry; error?: { code: string; message: string } }>> {
    for (const rel of rels) validateRelativePath(rel, { allowEmpty: true, field: 'STAT' })
    const results: Array<{ entry?: ListEntry; error?: { code: string; message: string } }> = []
    for (const rel of rels) {
      if (cancelled?.()) throw new EngineError('CANCELLED', 'stat batch cancelled')
      try {
        const entry = await statPath(root, rel)
        results.push(entry ? { entry } : { error: { code: 'NOT_FOUND', message: 'missing' } })
      } catch (err) {
        results.push({ error: { code: errorCode(err) ?? 'IO', message: errorMessage(err) } })
      }
    }
    return results
  }

  async stableHash(root: string, rel: string, cancelled?: () => boolean): Promise<StableFileHash> {
    validateRelativePath(rel, { allowEmpty: false, field: 'GET' })
    return await hashStableFile(root, rel, { cancelled, hashCache: this.hashCache })
  }

  async manifest(
    root: string,
    rel: string,
    filter: FilterSpec | null,
    scanId: string,
    cancelToken: { cancelled: boolean },
    onProgress?: (filesDone: number, bytesDone: number) => void,
    maxEntries: number = MANIFEST_MAX_ENTRIES
  ): Promise<ScanSnapshot> {
    validateRelativePath(rel, { allowEmpty: true, field: 'MANIFEST' })
    return await createManifest(root, rel, filter, {
      cancelToken,
      onProgress,
      maxEntries,
      scanId,
      hashCache: this.hashCache
    })
  }

  async statFile(pathname: string): Promise<FileStat | null> {
    return await statFile(pathname)
  }

  async preparePut(root: string, rel: string): Promise<string> {
    validateRelativePath(rel, { allowEmpty: false, field: 'PUT' })
    const slash = rel.lastIndexOf('/')
    const parentRel = slash < 0 ? '' : rel.slice(0, slash)
    await ensureRealDirs(joinNativePart(root, parentRel), root)
    return await resolveAllowedPath(root, rel, 'PUT', 'create-chain')
  }

  async hashAbsolute(pathname: string, cancelled?: () => boolean): Promise<{ hex: string; size: number }> {
    return await hashFile(pathname, cancelled)
  }

  async sha256Absolute(pathname: string, cancelled?: () => boolean): Promise<{ hex: string; size: number }> {
    return await sha256File(pathname, cancelled)
  }

  async unlink(pathname: string, ignoreMissing = true): Promise<void> {
    try { await fsp.unlink(pathname) } catch (err) {
      if (!ignoreMissing || !isErrnoCode(err, 'ENOENT')) throw err
    }
  }

  async rename(from: string, to: string): Promise<void> {
    await fsp.rename(from, to)
  }

  async link(from: string, to: string): Promise<void> {
    await fsp.link(from, to)
  }

  async copyExclusive(from: string, to: string): Promise<void> {
    await copyFileExclusiveLocal(from, to)
  }

  async chmod(pathname: string, mode: number): Promise<void> {
    await fsp.chmod(pathname, mode)
  }

  async claimExclusiveCopy(to: string): Promise<string> {
    await this._releaseClaim()
    const handle = await openFile(to, 'wx')
    this._claim = handle
    try {
      const st = await handle.stat()
      return statIdentity(st)
    } catch (err) {
      this._claim = null
      try { await handle.close() } catch {}
      await fsp.unlink(to).catch(() => {})
      throw err
    }
  }

  async copyIntoClaim(from: string): Promise<void> {
    const handle = this._claim
    if (!handle) throw new EngineError('IO', 'exclusive copy was not claimed')
    const source = await openFile(from, 'r')
    try {
      const st = await source.stat()
      if (!st.isFile()) throw new EngineError('IO', 'copy source is not a regular file')
      const buffer = new Uint8Array(Math.min(COPY_CHUNK, Math.max(1, st.size)))
      let position = 0
      while (position < st.size) {
        const wanted = Math.min(buffer.byteLength, st.size - position)
        const n = bytesReadOf(await source.read(buffer, 0, wanted, position))
        if (n <= 0) throw new EngineError('IO', 'copy source ended early')
        await writeExact(handle, buffer.subarray(0, n), position)
        position += n
      }
      await handle.sync()
    } finally {
      try { await source.close() } catch {}
      this._claim = null
      try { await handle.close() } catch {}
    }
  }

  async dispose(): Promise<void> {
    await this._releaseClaim()
  }

  private async _releaseClaim(): Promise<void> {
    const current = this._claim
    this._claim = null
    if (current) {
      try { await current.close() } catch {}
    }
  }
}

/**
 * Build the adapter for this runtime.
 *
 * The worker is preferred so a hung network share cannot wedge Core; the direct
 * path is the fallback and must stay behaviourally identical.
 */
export function createDiskAdapter(hashCachePath: string | null): {
  adapter: DiskAdapter
  hashCache: ManifestHashCache
} {
  const hashCache = new ManifestHashCache(hashCachePath)
  if (canUseIsolatedIoWorker()) {
    return { adapter: new WorkerDiskAdapter(new RootFsExecutor(hashCachePath)), hashCache }
  }
  return { adapter: new DirectDiskAdapter(hashCache), hashCache }
}
