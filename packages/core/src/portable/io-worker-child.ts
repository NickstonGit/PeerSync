import fsp from 'bare-fs/promises'
import path from 'bare-path'
import ParentChannel from 'bare-subprocess/parent'
import b4a from 'b4a'
import { FileDigest, sha256File } from './hashing'
import { allocatePartFile } from './partfile'
import { openFile, bytesReadOf, bytesWrittenOf, type FileHandle } from './fs-handle'
import { createManifest, hashStableFile, listAllEntries, statPath } from './fs-scan'
import { ManifestHashCache } from './manifest-hash-cache'
import { ensureRealDirs, joinNative, resolveAllowedPath, statFile, validateRelativePath } from './pathguard'
import { statIdentity } from '@peersync/drive'
import type { IoStatPathResult, IoWorkerMessage, IoWorkerRequest, IoWorkerResult } from './io-worker-protocol'

const HASH_READ_CHUNK = 1 << 20
const HASH_PROGRESS_INTERVAL_MS = 1_000
const COPY_CHUNK = 1 << 20

function errorCode(err: unknown): string {
  if (!err || typeof err !== 'object') return 'IO'
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' && code.length <= 64 ? code : 'IO'
}

function errorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.slice(0, 512)
}

async function writeExact(handle: FileHandle, data: Uint8Array, position: number | null): Promise<void> {
  let written = 0
  while (written < data.byteLength) {
    const pos = position === null ? null : position + written
    const n = bytesWrittenOf(await handle.write(data, written, data.byteLength - written, pos))
    if (n <= 0) throw new Error('write stalled')
    written += n
  }
}

async function atomicWrite(pathname: string, data: Uint8Array): Promise<void> {
  // Deterministic per-target temp path is intentional. The parent serializes
  // writes for one journal row; if a previous worker was killed in fsync, the
  // next worker can remove the orphan before retrying rather than leaking a
  // unique temp file per timeout.
  const tmp = `${pathname}.io-worker-tmp`
  await fsp.unlink(tmp).catch(() => {})
  const handle = await openFile(tmp, 'w')
  try {
    await writeExact(handle, data, null)
    await handle.sync()
  } catch (err) {
    try { await handle.close() } catch {}
    await fsp.unlink(tmp).catch(() => {})
    throw err
  }
  await handle.close()
  try {
    await fsp.rename(tmp, pathname)
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {})
    throw err
  }
}

async function copyExclusive(
  from: string,
  to: string,
  onProgress: (bytes: number) => void
): Promise<void> {
  const source = await openFile(from, 'r')
  let destination: FileHandle | null = null
  let created = false
  try {
    const st = await source.stat()
    if (!st.isFile()) throw new Error('copy source is not a regular file')
    destination = await openFile(to, 'wx')
    created = true

    const buffer = new Uint8Array(Math.min(COPY_CHUNK, Math.max(1, st.size)))
    let position = 0
    while (position < st.size) {
      const wanted = Math.min(buffer.byteLength, st.size - position)
      const n = bytesReadOf(await source.read(buffer, 0, wanted, position))
      if (n <= 0) throw new Error('copy source ended early')
      await writeExact(destination, buffer.subarray(0, n), position)
      position += n
      onProgress(position)
    }
    await destination.sync()
  } catch (err) {
    if (destination) {
      try { await destination.close() } catch {}
      destination = null
    }
    if (created) await fsp.unlink(to).catch(() => {})
    throw err
  } finally {
    if (destination) {
      try { await destination.close() } catch {}
    }
    try { await source.close() } catch {}
  }
}

export async function runIoWorkerChild(): Promise<void> {
  const parent = new ParentChannel()
  let handle: FileHandle | null = null
  /** Destination claimed by `claim-exclusive-copy`, awaiting payload bytes. */
  let writeHandle: FileHandle | null = null
  let claimedDestination: string | null = null
  let tail: Promise<void> = Promise.resolve()
  let disconnected = false

  const send = (message: IoWorkerMessage): void => {
    if (!parent.connected) return
    parent.send(message)
  }

  const closeHandle = async (): Promise<void> => {
    const current = handle
    handle = null
    if (current) await current.close()
  }

  /** Release an unfinished exclusive claim without touching the claimed name. */
  const closeWriteHandle = async (): Promise<void> => {
    const current = writeHandle
    writeHandle = null
    claimedDestination = null
    if (current) {
      try { await current.close() } catch {}
    }
  }

  const progressReporter = (id: number) => {
    let lastAt = 0
    return (bytes: number) => {
      const now = Date.now()
      if (now - lastAt < HASH_PROGRESS_INTERVAL_MS) return
      lastAt = now
      send({ id, type: 'progress', bytes })
    }
  }

  const respond = async (req: IoWorkerRequest): Promise<void> => {
    try {
      let result: IoWorkerResult
      switch (req.op) {
        case 'open-read': {
          await closeHandle()
          const opened = await openFile(req.path, 'r')
          try {
            const st = await opened.stat()
            if (!st.isFile()) throw new Error('source is not a regular file')
            handle = opened
            result = { size: st.size }
          } catch (err) {
            try { await opened.close() } catch {}
            throw err
          }
          break
        }
        case 'open-read-root': {
          await closeHandle()
          const abs = await resolveAllowedPath(req.root, req.rel, 'GET', 'exact')
          const opened = await openFile(abs, 'r')
          try {
            const st = await opened.stat()
            if (!st.isFile()) throw new Error('source is not a regular file')
            handle = opened
            result = { path: abs, size: st.size }
          } catch (err) {
            try { await opened.close() } catch {}
            throw err
          }
          break
        }
        case 'open-write': {
          await closeHandle()
          await allocatePartFile(req.path, req.size, { exclusive: req.exclusive === true })
          handle = await openFile(req.path, 'r+')
          result = { ok: true }
          break
        }
        case 'read': {
          if (!handle) throw new Error('source file is not open')
          if (!Number.isSafeInteger(req.offset) || req.offset < 0 || !Number.isSafeInteger(req.length) || req.length < 0) {
            throw new Error('invalid read range')
          }
          const buf = b4a.allocUnsafe(req.length)
          const bytesRead = bytesReadOf(await handle.read(buf, 0, req.length, req.offset))
          result = { data: b4a.from(buf.subarray(0, bytesRead)) }
          break
        }
        case 'write': {
          if (!handle) throw new Error('receiver file is not open')
          if (!Number.isSafeInteger(req.offset) || req.offset < 0 || !(req.data instanceof Uint8Array)) {
            throw new Error('invalid write request')
          }
          await writeExact(handle, req.data, req.offset)
          result = { ok: true }
          break
        }
        case 'sync': {
          if (handle) await handle.sync()
          result = { ok: true }
          break
        }
        case 'close-handle': {
          await closeHandle()
          await closeWriteHandle()
          result = { ok: true }
          break
        }
        case 'hash': {
          const hashHandle = await openFile(req.path, 'r')
          const digest = new FileDigest()
          const report = progressReporter(req.id)
          try {
            const buf = b4a.allocUnsafe(HASH_READ_CHUNK)
            for (;;) {
              const bytesRead = bytesReadOf(await hashHandle.read(buf, 0, buf.byteLength, digest.bytes))
              if (bytesRead <= 0) break
              digest.update(buf.subarray(0, bytesRead))
              // Heartbeat is time-based and emitted only after a completed read.
              // The parent timeout therefore measures lack of completed I/O, not
              // throughput below an implicit bytes-per-time threshold.
              report(digest.bytes)
            }
          } finally {
            await hashHandle.close()
          }
          result = { hex: digest.digestHex(), size: digest.bytes }
          break
        }
        case 'sha256': {
          result = await sha256File(req.path, undefined, progressReporter(req.id))
          break
        }
        case 'stable-hash': {
          const report = progressReporter(req.id)
          const cache = new ManifestHashCache(req.hashCachePath ?? null)
          const stable = await hashStableFile(req.root, req.rel, {
            hashCache: cache,
            onIoProgress: report
          })
          await cache.flush()
          result = { stable }
          break
        }
        case 'manifest': {
          const report = progressReporter(req.id)
          const cache = new ManifestHashCache(req.hashCachePath ?? null)
          const manifest = await createManifest(req.root, req.rel, req.filter ?? null, {
            maxEntries: req.maxEntries,
            scanId: req.scanId,
            hashCache: cache,
            onProgress: (_filesDone, bytesDone) => report(bytesDone),
            onIoProgress: report
          })
          result = { manifest }
          break
        }
        case 'list-all': {
          const entries = await listAllEntries(req.root, req.rel, req.sort ?? null)
          result = { entries }
          break
        }
        case 'stat-path': {
          result = { entry: await statPath(req.root, req.rel) }
          break
        }
        case 'stat-path-batch': {
          if (!Array.isArray(req.rels) || req.rels.length > 512) {
            throw new Error('invalid stat-path-batch request')
          }
          const stats: IoStatPathResult[] = []
          for (const rel of req.rels) {
            try {
              const entry = await statPath(req.root, rel)
              stats.push(entry ? { entry } : { error: { code: 'NOT_FOUND', message: 'missing' } })
            } catch (err) {
              stats.push({ error: { code: errorCode(err), message: errorMessage(err) } })
            }
          }
          result = { stats }
          break
        }
        case 'stat-file': {
          result = { stat: await statFile(req.path) }
          break
        }
        case 'prepare-put': {
          const clean = validateRelativePath(req.rel, { allowEmpty: false, field: 'PUT' })
          const slash = clean.lastIndexOf('/')
          const parentRel = slash < 0 ? '' : clean.slice(0, slash)
          await ensureRealDirs(joinNative(req.root, parentRel), req.root)
          result = { path: await resolveAllowedPath(req.root, clean, 'PUT', 'create-chain') }
          break
        }
        case 'unlink': {
          try {
            await fsp.unlink(req.path)
          } catch (err) {
            if (!req.ignoreMissing || errorCode(err) !== 'ENOENT') throw err
          }
          result = { ok: true }
          break
        }
        case 'rename': {
          await fsp.rename(req.from, req.to)
          result = { ok: true }
          break
        }
        case 'link': {
          // link() is our atomic no-clobber namespace primitive. Unlike
          // rename(), it fails with EEXIST if another process created the
          // destination after our last observation.
          await fsp.link(req.from, req.to)
          result = { ok: true }
          break
        }
        case 'copy-exclusive': {
          // Portable no-clobber fallback for filesystems without hard links.
          // `wx` claims the final name without replacing a user file. Keep the
          // source partial untouched until the parent durably checkpoints the
          // finalization transaction.
          await copyExclusive(req.from, req.to, progressReporter(req.id))
          result = { ok: true }
          break
        }
        case 'claim-exclusive-copy': {
          // Claim the final name without writing a payload byte and report the
          // identity of the file object just created. The parent journals that
          // identity before requesting the copy, so a crash mid-copy is
          // provably ours during recovery.
          await closeHandle()
          const claimedPath = req.to
          const claimed = await openFile(claimedPath, 'wx')
          writeHandle = claimed
          claimedDestination = claimedPath
          try {
            const st = await claimed.stat()
            result = { identity: statIdentity(st) }
          } catch (err) {
            writeHandle = null
            claimedDestination = null
            try { await claimed.close() } catch {}
            await fsp.unlink(claimedPath).catch(() => {})
            throw err
          }
          break
        }
        case 'copy-into-claim': {
          if (!writeHandle || !claimedDestination) throw new Error('no exclusive claim is open')
          const source = await openFile(req.from, 'r')
          let completed = false
          try {
            const st = await source.stat()
            if (!st.isFile()) throw new Error('copy source is not a regular file')
            const buffer = new Uint8Array(Math.min(COPY_CHUNK, Math.max(1, st.size)))
            let position = 0
            while (position < st.size) {
              const wanted = Math.min(buffer.byteLength, st.size - position)
              const n = bytesReadOf(await source.read(buffer, 0, wanted, position))
              if (n <= 0) throw new Error('copy source ended early')
              await writeExact(writeHandle, buffer.subarray(0, n), position)
              position += n
            }
            await writeHandle.sync()
            completed = true
            result = { ok: true }
          } finally {
            try { await source.close() } catch {}
            const current = writeHandle
            const claimed = claimedDestination
            writeHandle = null
            claimedDestination = null
            if (current) {
              try { await current.close() } catch {}
            }
            // An ordinary failure removes the short copy this claim created, so
            // retry/resume stays safe. A worker kill never reaches here: the
            // name survives with its recorded identity, and recovery proves
            // ownership from that identity instead of guessing from a size.
            if (!completed && claimed) {
              await fsp.unlink(claimed).catch(() => {})
            }
          }
          break
        }
        case 'chmod': {
          if (!Number.isSafeInteger(req.mode) || req.mode < 0 || req.mode > 0o7777) throw new Error('invalid chmod mode')
          await fsp.chmod(req.path, req.mode)
          result = { ok: true }
          break
        }
        case 'atomic-write': {
          if (!(req.data instanceof Uint8Array)) throw new Error('invalid atomic write payload')
          await fsp.mkdir(path.dirname(req.path), { recursive: true })
          await atomicWrite(req.path, req.data)
          result = { ok: true }
          break
        }
      }
      send({ id: req.id, type: 'result', ok: true, result })
    } catch (err) {
      send({
        id: req.id,
        type: 'result',
        ok: false,
        error: { code: errorCode(err), message: errorMessage(err) }
      })
    }
  }

  await new Promise<void>((resolve) => {
    parent.on('message', (message: unknown) => {
      if (disconnected || !message || typeof message !== 'object') return
      const req = message as IoWorkerRequest
      if (!Number.isSafeInteger(req.id) || typeof req.op !== 'string') return
      tail = tail.then(() => respond(req)).catch(() => {})
    })
    parent.on('disconnect', () => {
      disconnected = true
      void tail.finally(async () => {
        try { await closeHandle() } catch {}
        try { await closeWriteHandle() } catch {}
        resolve()
      })
    })
    parent.on('error', () => {
      disconnected = true
      void tail.finally(async () => {
        try { await closeHandle() } catch {}
        try { await closeWriteHandle() } catch {}
        resolve()
      })
    })
  })
}
