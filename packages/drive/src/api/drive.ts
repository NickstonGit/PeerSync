import nodePath from '#path'
import type { DriveChannel } from '../engine/types'
import type { Bitmap } from '../engine/bitmap'
import type { AbortLike } from '../engine/types'
import { SenderSession } from '../engine/sender'
import { ReceiverSession } from '../engine/receiver'
import { DiskReader } from '../adapters/disk-reader'
import { DiskWriter } from '../adapters/disk-writer'

const { basename, join } = nodePath

let transferSequence = 0

function defaultTransferId(): string {
  const cryptoLike = (globalThis as unknown as { crypto?: { getRandomValues?: (target: Uint8Array) => Uint8Array } }).crypto
  if (cryptoLike?.getRandomValues) {
    const bytes = new Uint8Array(16)
    cryptoLike.getRandomValues(bytes)
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  }
  transferSequence = (transferSequence + 1) >>> 0
  // Compatibility fallback for runtimes without Web Crypto. Transfer IDs are
  // scoped to a live peer channel; monotonic process sequence + wall clock is
  // deterministic and collision-resistant within the process without relying
  // on Math.random().
  return `${Date.now().toString(36)}-${transferSequence.toString(36)}`
}

function onAbort(signal: AbortLike | undefined, cancel: () => void): () => void {
  if (!signal) return () => {}
  if (signal.aborted) {
    cancel()
    return () => {}
  }
  signal.addEventListener('abort', cancel)
  return () => signal.removeEventListener('abort', cancel)
}

export interface SendFileOptions {
  transferId?: string
  name?: string
  signal?: AbortLike
  notifyPeerOnCancel?: boolean
  highWaterMark?: number
  onProgress?: (sentBytes: number, totalBytes: number) => void
}

export async function sendFile(
  path: string,
  channel: DriveChannel,
  opts: SendFileOptions = {}
): Promise<string> {
  const reader = new DiskReader(path)
  const sender = new SenderSession(reader, channel, {
    transferId: opts.transferId ?? defaultTransferId(),
    name: opts.name ?? basename(path),
    highWaterMark: opts.highWaterMark,
    onProgress: opts.onProgress
  })
  const release = onAbort(opts.signal, () =>
    sender.cancel('Transfer cancelled', { notifyPeer: opts.notifyPeerOnCancel !== false })
  )
  try {
    return await sender.start()
  } finally {
    release()
    await sender.close()
  }
}

export interface ReceiveFileOptions {
  transferId?: string
  expectedSize?: number
  signal?: AbortLike
  resumeBits?: Uint8Array
  overwrite?: boolean
  onProgress?: (receivedBytes: number, totalBytes: number) => void
  onChunkWritten?: (bitmap: Bitmap) => void
  /** True only while publication has crossed the irreversible commit boundary. */
  onCommitState?: (committing: boolean) => void
  /** Locally generated owned partial path; never a peer-controlled id. */
  partPath?: string
  /** Resume only an already-owned partial. */
  resumePartial?: boolean
  /** Verify the durable private partial before it crosses the final publication boundary. */
  verifyPrepared?: (partPath: string) => Promise<void>
}

export function receiveFile(
  targetPath: string,
  channel: DriveChannel,
  opts: ReceiveFileOptions = {}
): Promise<string> {
  const writer = new DiskWriter(targetPath, {
    overwrite: opts.overwrite,
    partPath: opts.partPath,
    resume: opts.resumePartial === true,
    verifyPrepared: opts.verifyPrepared
  })
  const receiver = new ReceiverSession(writer, channel, {
    transferId: opts.transferId,
    expectedSize: opts.expectedSize,
    resumeBits: opts.resumeBits,
    onProgress: opts.onProgress,
    onChunkWritten: opts.onChunkWritten,
    onCommitState: opts.onCommitState
  })
  const release = onAbort(opts.signal, () => {
    receiver.cancel()
  })
  return receiver.receive().finally(release)
}

export class Drive {
  private readonly receiveDir: string

  constructor(receiveDir: string) {
    this.receiveDir = receiveDir
  }

  send(filePath: string, channel: DriveChannel, opts: SendFileOptions = {}): Promise<string> {
    return sendFile(filePath, channel, opts)
  }

  receive(name: string, channel: DriveChannel, opts: ReceiveFileOptions = {}): Promise<string> {
    // Drive is a rooted convenience API: callers provide a file name, never a
    // path. Reject both native and foreign separators so the contract remains
    // safe when code/data crosses Windows and POSIX hosts.
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || basename(name) !== name) {
      return Promise.reject(new Error('receive name must be a single file name'))
    }
    return receiveFile(join(this.receiveDir, name), channel, opts)
  }
}
