import fs from '#fs'
import path from '#path'
import type { FileHandle } from 'node:fs/promises'
import type { ChunkWriter } from '../engine/types'
import {
  LEGACY_PART_MARKER,
  PART_MARKER,
  candidateParts,
  claimFreeName,
  statIdentity
} from './publication'

export interface DiskWriterOptions {
  overwrite?: boolean
  /** Locally generated capability path. Never derive this from a peer transfer id. */
  partPath?: string
  /** Resume is allowed only when the durable metadata proves ownership. */
  resume?: boolean
  /** Verify the durable private partial before final publication. */
  verifyPrepared?: (partPath: string) => Promise<void>
}

interface FinalizeMetadata {
  mode: 'link' | 'copy-exclusive'
  state: 'claiming' | 'copying' | 'published'
  destination: string
  expectedSize: number
  destinationIdentity?: string
}

interface PartialMetadataV1 {
  version: 1
  targetPath: string
}

interface PartialMetadataV2 {
  version: 2
  targetPath: string
  finalize?: FinalizeMetadata
}

type PartialMetadata = PartialMetadataV1 | PartialMetadataV2

function isEexist(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'EEXIST'
}

let partialSequence = 0
const recoveredDirectories = new Map<string, Promise<void>>()

function randomToken(): string {
  const cryptoLike = (globalThis as unknown as {
    crypto?: { getRandomValues?: (target: Uint8Array) => Uint8Array }
  }).crypto
  if (cryptoLike?.getRandomValues) {
    const bytes = new Uint8Array(16)
    cryptoLike.getRandomValues(bytes)
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  }
  partialSequence = (partialSequence + 1) >>> 0
  return `${Date.now().toString(36)}-${partialSequence.toString(36)}`
}

export function createPartialPath(targetPath: string): string {
  return `${targetPath}${PART_MARKER}${randomToken()}`
}

function metadataPath(partPath: string): string {
  return `${partPath}.meta`
}

async function readMetadata(partPath: string): Promise<PartialMetadata | null> {
  try {
    const raw = await fs.readFile(metadataPath(partPath), 'utf8')
    const parsed = JSON.parse(raw) as Partial<PartialMetadata>
    if ((parsed.version !== 1 && parsed.version !== 2) || typeof parsed.targetPath !== 'string') {
      return null
    }
    return parsed as PartialMetadata
  } catch {
    return null
  }
}

async function writeMetadataRecord(partPath: string, metadata: PartialMetadataV2): Promise<void> {
  const metaPath = metadataPath(partPath)
  const tmpPath = `${metaPath}.tmp-${randomToken()}`
  await fs.writeFile(tmpPath, JSON.stringify(metadata), 'utf8')
  try {
    await fs.rename(tmpPath, metaPath)
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {})
    throw err
  }
}

async function writeMetadata(partPath: string, targetPath: string): Promise<void> {
  await writeMetadataRecord(partPath, { version: 2, targetPath })
}

async function updateFinalizeMetadata(
  partPath: string,
  targetPath: string,
  finalize?: FinalizeMetadata
): Promise<void> {
  const current = await readMetadata(partPath)
  if (!current || current.targetPath !== targetPath) {
    throw new Error('Refusing to update metadata for an unowned partial file')
  }
  await writeMetadataRecord(partPath, {
    version: 2,
    targetPath,
    ...(finalize ? { finalize } : {})
  })
}

async function ownsPartial(partPath: string, targetPath: string): Promise<boolean> {
  const parsed = await readMetadata(partPath)
  return parsed?.targetPath === targetPath
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return false
    throw err
  }
}

async function currentIdentity(filePath: string): Promise<string | null> {
  try {
    return statIdentity(await fs.stat(filePath))
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw err
  }
}

async function readFullyAt(
  handle: FileHandle,
  buffer: Uint8Array,
  length: number,
  position: number
): Promise<boolean> {
  let total = 0
  while (total < length) {
    const chunk = await handle.read(buffer, total, length - total, position + total)
    if (chunk.bytesRead <= 0) return false
    total += chunk.bytesRead
  }
  return true
}

async function filesEqual(leftPath: string, rightPath: string): Promise<boolean> {
  let left: FileHandle | null = null
  let right: FileHandle | null = null
  try {
    left = await fs.open(leftPath, 'r')
    right = await fs.open(rightPath, 'r')
    const [leftStat, rightStat] = await Promise.all([left.stat(), right.stat()])
    if (leftStat.size !== rightStat.size) return false
    const chunkSize = 1024 * 1024
    const leftBuf = new Uint8Array(chunkSize)
    const rightBuf = new Uint8Array(chunkSize)
    let offset = 0
    while (offset < leftStat.size) {
      const length = Math.min(chunkSize, leftStat.size - offset)
      const [leftComplete, rightComplete] = await Promise.all([
        readFullyAt(left, leftBuf, length, offset),
        readFullyAt(right, rightBuf, length, offset)
      ])
      if (!leftComplete || !rightComplete) return false
      for (let i = 0; i < length; i++) {
        if (leftBuf[i] !== rightBuf[i]) return false
      }
      offset += length
    }
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return false
    throw err
  } finally {
    await left?.close().catch(() => {})
    await right?.close().catch(() => {})
  }
}

async function recoverFinalize(partPath: string, metadata: PartialMetadataV2): Promise<void> {
  const finalize = metadata.finalize
  if (!finalize) return

  const partExists = await pathExists(partPath)
  const destinationIdentity = await currentIdentity(finalize.destination)

  if (destinationIdentity === null) {
    if (partExists) await updateFinalizeMetadata(partPath, metadata.targetPath)
    else await fs.unlink(metadataPath(partPath)).catch(() => {})
    return
  }

  if (!partExists) {
    if (
      finalize.state === 'published' ||
      (finalize.mode === 'link' &&
        !!finalize.destinationIdentity &&
        destinationIdentity === finalize.destinationIdentity)
    ) {
      // For link publication the source identity was journaled before fs.link.
      // Therefore a matching destination is a proven committed result even if
      // the process died before the `published` checkpoint or source cleanup.
      await fs.unlink(metadataPath(partPath)).catch(() => {})
      return
    }
    throw new Error(
      `Interrupted PeerSync publication requires recovery: ${finalize.destination}`
    )
  }

  // If the complete payload reached the claimed final pathname, commit won the
  // crash race even when the process died before cleanup/checkpointing.
  if (await filesEqual(partPath, finalize.destination)) {
    await fs.unlink(partPath).catch(() => {})
    await fs.unlink(metadataPath(partPath)).catch(() => {})
    return
  }

  if (
    finalize.destinationIdentity &&
    destinationIdentity === finalize.destinationIdentity
  ) {
    // The pathname still names the exact file object created by this writer,
    // so removing an interrupted short copy cannot delete a user's replacement.
    await fs.unlink(finalize.destination).catch(() => {})
    await updateFinalizeMetadata(partPath, metadata.targetPath)
    return
  }

  // Ownership is no longer provable. Preserve the current destination and the
  // private partial, but clear the in-flight state so a later commit selects a
  // different no-clobber candidate instead of guessing/destructively cleaning.
  await updateFinalizeMetadata(partPath, metadata.targetPath)
}

function metadataOwnsPartPath(partPath: string, metadata: PartialMetadata): boolean {
  if (path.dirname(partPath) !== path.dirname(metadata.targetPath)) return false
  // New PeerSync builds use `.peersync-part-*`. Keep recognizing the old
  // Legacy transport marker kept only for crash-recovery of partials that already exist.
  return (
    partPath.startsWith(`${metadata.targetPath}${PART_MARKER}`) ||
    partPath.startsWith(`${metadata.targetPath}${LEGACY_PART_MARKER}`)
  )
}

async function recoverDirectory(dir: string): Promise<void> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return
    throw err
  }

  for (const name of names) {
    if (
      !name.endsWith('.meta') ||
      (!name.includes(PART_MARKER) && !name.includes(LEGACY_PART_MARKER))
    ) continue
    const partPath = path.join(dir, name.slice(0, -'.meta'.length))
    const metadata = await readMetadata(partPath)
    if (!metadata || !metadataOwnsPartPath(partPath, metadata)) continue

    if (metadata.version === 2 && metadata.finalize) {
      await recoverFinalize(partPath, metadata)
      continue
    }

    // Worklet downloads only promise in-process pause/resume. At process start
    // there is no protocol/session identity capable of safely reconstructing a
    // bitmap, so an owned non-finalizing partial from the previous process is
    // garbage rather than a valid resume candidate. Retire it once per directory
    // instead of leaking one full-size hidden file after every crash.
    await fs.unlink(partPath).catch(() => {})
    await fs.unlink(metadataPath(partPath)).catch(() => {})
  }
}

async function recoverDirectoryOnce(targetPath: string): Promise<void> {
  const dir = path.dirname(targetPath)
  const existing = recoveredDirectories.get(dir)
  if (existing) return await existing
  const run = recoverDirectory(dir).catch((err) => {
    if (recoveredDirectories.get(dir) === run) recoveredDirectories.delete(dir)
    throw err
  })
  recoveredDirectories.set(dir, run)
  await run
}

async function linkExclusiveJournaled(
  source: string,
  destination: string,
  targetPath: string
): Promise<void> {
  const sourceStat = await fs.stat(source)
  // A hard-link names the exact same inode/file object as the private source.
  // Persist that identity *before* the namespace commit so recovery can prove
  // ownership even if the post-link checkpoint itself fails or the process
  // crashes immediately after fs.link() returns.
  const destinationIdentity = statIdentity(sourceStat)
  await updateFinalizeMetadata(source, targetPath, {
    mode: 'link',
    state: 'claiming',
    destination,
    expectedSize: sourceStat.size,
    destinationIdentity
  })
  try {
    await fs.link(source, destination)
  } catch (err) {
    // fs.link did not commit a namespace entry. Return to the ordinary partial
    // state so commitNoReplace may safely try copy fallback / another name.
    if (await pathExists(source).catch(() => false)) {
      await updateFinalizeMetadata(source, targetPath).catch(() => {})
    }
    throw err
  }

  // fs.link() is the irreversible no-clobber commit. A metadata checkpoint is
  // useful for fast recovery, but failing to write it must never make callers
  // behave as if publication failed and create a second numbered copy. The
  // pre-commit claiming record already contains enough identity for recovery.
  await updateFinalizeMetadata(source, targetPath, {
    mode: 'link',
    state: 'published',
    destination,
    expectedSize: sourceStat.size,
    destinationIdentity
  }).catch((err) => {
    console.warn('DiskWriter: hard-link committed but publish checkpoint failed', destination, err)
  })
}

async function renameOverwriteWithRetry(source: string, destination: string): Promise<void> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await fs.rename(source, destination)
      return
    } catch (err) {
      lastError = err
      const code = (err as NodeJS.ErrnoException)?.code
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(String(code)) || attempt === 5) break
      await new Promise<void>((resolve) => setTimeout(resolve, 75 * (attempt + 1)))
    }
  }
  throw lastError ?? new Error(`Unable to replace destination: ${destination}`)
}

async function copyExclusiveJournaled(
  source: string,
  destination: string,
  targetPath: string
): Promise<void> {
  const sourceHandle = await fs.open(source, 'r')
  let destinationHandle: FileHandle | null = null
  let destinationIdentity: string | undefined
  try {
    const sourceStat = await sourceHandle.stat()
    await updateFinalizeMetadata(source, targetPath, {
      mode: 'copy-exclusive',
      state: 'claiming',
      destination,
      expectedSize: sourceStat.size
    })

    destinationHandle = await fs.open(destination, 'wx')
    destinationIdentity = statIdentity(await destinationHandle.stat())
    // Persist exact ownership before copying the first byte into the visible
    // final pathname. Recovery can now safely remove an interrupted short copy.
    await updateFinalizeMetadata(source, targetPath, {
      mode: 'copy-exclusive',
      state: 'copying',
      destination,
      expectedSize: sourceStat.size,
      destinationIdentity
    })

    const buffer = new Uint8Array(Math.min(1024 * 1024, Math.max(1, sourceStat.size)))
    let offset = 0
    while (offset < sourceStat.size) {
      const wanted = Math.min(buffer.byteLength, sourceStat.size - offset)
      const read = await sourceHandle.read(buffer, 0, wanted, offset)
      if (read.bytesRead !== wanted) throw new Error('Copy source ended before expected size')
      let written = 0
      while (written < wanted) {
        const out = await destinationHandle.write(
          buffer,
          written,
          wanted - written,
          offset + written
        )
        if (out.bytesWritten <= 0) throw new Error('Copy destination write stalled')
        written += out.bytesWritten
      }
      offset += wanted
    }
    await destinationHandle.sync()
    await destinationHandle.close()
    destinationHandle = null
    await updateFinalizeMetadata(source, targetPath, {
      mode: 'copy-exclusive',
      state: 'published',
      destination,
      expectedSize: sourceStat.size,
      destinationIdentity
    })
  } catch (err) {
    await destinationHandle?.close().catch(() => {})
    destinationHandle = null
    if (
      destinationIdentity &&
      (await currentIdentity(destination).catch(() => null)) === destinationIdentity
    ) {
      await fs.unlink(destination).catch(() => {})
    }
    if (await pathExists(source).catch(() => false)) {
      await updateFinalizeMetadata(source, targetPath).catch(() => {})
    }
    throw err
  } finally {
    await sourceHandle.close().catch(() => {})
  }
}

export class DiskWriter implements ChunkWriter {
  private readonly targetPath: string
  readonly partPath: string
  private readonly overwrite: boolean
  private readonly resume: boolean
  private readonly verifyPrepared?: (partPath: string) => Promise<void>
  private handle: FileHandle | null = null
  private prepared = false
  private committedPath: string | null = null

  constructor(
    targetPath: string,
    { overwrite = false, partPath, resume = false, verifyPrepared }: DiskWriterOptions = {}
  ) {
    this.targetPath = targetPath
    this.partPath = partPath ?? createPartialPath(targetPath)
    this.overwrite = overwrite
    this.resume = resume
    this.verifyPrepared = verifyPrepared
  }

  async allocate(size: number): Promise<void> {
    await recoverDirectoryOnce(this.targetPath)
    await fs.mkdir(path.dirname(this.partPath), { recursive: true })
    if (this.resume) {
      if (!(await ownsPartial(this.partPath, this.targetPath))) {
        throw new Error('Refusing to resume unowned partial file')
      }
      this.handle = await fs.open(this.partPath, 'r+')
      await this.handle.truncate(size)
      return
    }

    // Exclusive creation makes local ownership explicit. A pre-existing sibling
    // is never truncated merely because its name resembles a PeerSync file.
    this.handle = await fs.open(this.partPath, 'wx+')
    try {
      await this.handle.truncate(size)
      await writeMetadata(this.partPath, this.targetPath)
    } catch (err) {
      await this.closeHandle().catch(() => {})
      await fs.unlink(this.partPath).catch(() => {})
      await fs.unlink(metadataPath(this.partPath)).catch(() => {})
      throw err
    }
  }

  async write(offset: number, data: Uint8Array): Promise<void> {
    if (!this.handle) throw new Error('DiskWriter.write before allocate')
    let written = 0
    while (written < data.length) {
      const out = await this.handle.write(
        data,
        written,
        data.length - written,
        offset + written
      )
      if (out.bytesWritten <= 0) {
        throw new Error(`Disk write stalled at ${offset + written}`)
      }
      written += out.bytesWritten
    }
  }

  async prepareFinalize(): Promise<void> {
    if (this.prepared) return
    if (!this.handle) throw new Error('DiskWriter.prepareFinalize before allocate')
    if (!(await ownsPartial(this.partPath, this.targetPath))) {
      throw new Error('Refusing to finalize unowned partial file')
    }
    await this.handle.sync()
    await this.closeHandle()
    await this.verifyPrepared?.(this.partPath)
    this.prepared = true
  }

  async commitFinalize(): Promise<string> {
    if (this.committedPath) return this.committedPath
    if (!this.prepared) throw new Error('DiskWriter.commitFinalize before prepareFinalize')
    const destination = this.overwrite
      ? await this.commitOverwrite()
      : await this.commitNoReplace()
    // Metadata is the durable proof that a PeerSync-owned partial may be
    // deleted. Never remove that proof while the partial still exists.
    if (!(await pathExists(this.partPath))) {
      await fs.unlink(metadataPath(this.partPath)).catch(() => {})
    }
    this.committedPath = destination
    return this.committedPath
  }

  async finalize(): Promise<string> {
    await this.prepareFinalize()
    return await this.commitFinalize()
  }

  private async commitOverwrite(): Promise<string> {
    // Same-directory rename is the only publication primitive here that keeps
    // overwrite atomic. Retry transient Windows/AV sharing failures, but never
    // downgrade to an in-place copy that could expose a torn destination.
    await renameOverwriteWithRetry(this.partPath, this.targetPath)
    return this.targetPath
  }

  private async commitNoReplace(): Promise<string> {
    const ext = path.extname(this.targetPath)
    const parts = candidateParts(
      path.dirname(this.targetPath),
      path.basename(this.targetPath, ext),
      ext
    )
    const { candidate: destination } = await claimFreeName(
      this.targetPath,
      parts,
      path.join,
      async (name) => {
        try {
          await linkExclusiveJournaled(this.partPath, name, this.targetPath)
        } catch (err) {
          // EEXIST means this candidate is taken: rethrow so claimFreeName
          // advances to the next one. Any other failure (for example a
          // filesystem without hard links) falls back to an exclusive copy.
          if (isEexist(err)) throw err
          await copyExclusiveJournaled(this.partPath, name, this.targetPath)
        }
      },
      isEexist
    )

    // The durable content is now reachable at the final no-clobber path.
    // Removing the private partial is cleanup only; journal metadata remains
    // until that cleanup has actually happened.
    await fs.unlink(this.partPath).catch((err) => {
      console.warn(
        'DiskWriter: committed destination but failed to remove partial',
        this.partPath,
        err
      )
    })
    return destination
  }

  /** Close only. The owned partial + metadata intentionally survive pause/resume. */
  async abort(): Promise<void> {
    await this.closeHandle()
  }

  private async closeHandle(): Promise<void> {
    const handle = this.handle
    if (!handle) return
    this.handle = null
    await handle.close()
  }
}

/**
 * Delete a partial only when its metadata proves it belongs to targetPath.
 * This is the only destructive cleanup API for drive partials.
 */
export async function discardOwnedPartial(partPath: string, targetPath: string): Promise<boolean> {
  if (!(await ownsPartial(partPath, targetPath))) return false
  try {
    await fs.unlink(partPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn('discardOwnedPartial: failed to remove partial', partPath, err)
      return false
    }
  }
  await fs.unlink(metadataPath(partPath)).catch(() => {})
  return true
}

/** Legacy helper retained for API compatibility; fixed `<target>.part` is never trusted. */
export function partialPath(targetPath: string): string {
  return `${targetPath}.part`
}

/**
 * Legacy fixed-name cleanup is deliberately fail-closed. It removes the path
 * only when a new ownership metadata file proves it was created by PeerSync.
 */
export async function discardPartial(targetPath: string): Promise<void> {
  await discardOwnedPartial(partialPath(targetPath), targetPath)
}
