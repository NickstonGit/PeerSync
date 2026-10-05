import type { ChunkWriter, DriveChannel, ChunkHeader, ControlMessage } from './types'
import { selectChunkSize, chunkCount, chunkRange } from './chunker'
import { Bitmap } from './bitmap'
import { IntegrityError } from './errors'
import {
  MAX_TRANSFER_SIZE_BYTES,
  NEED_BATCH_CHUNKS,
  PEER_SILENCE_TIMEOUT_MS,
  PROGRESS_INTERVAL_MS,
  PROGRESS_STEP_BYTES
} from './constants'
import { Timeout } from './timeout'

const MAX_QUEUED_CONTROL_FRAMES = NEED_BATCH_CHUNKS * 4

interface CancelOptions {
  notifyPeer?: boolean
}

export interface ReceiverOptions {
  transferId?: string
  expectedSize?: number
  resumeBits?: Uint8Array
  stallTimeoutMs?: number
  progressStepBytes?: number
  progressIntervalMs?: number
  onProgress?: (receivedBytes: number, totalBytes: number) => void
  onChunkWritten?: (bitmap: Bitmap) => void | Promise<void>
  /** Called after all payload bytes are durable and before verify/publish starts. */
  onFinalizeStart?: () => void
  /** True only while publication has crossed the irreversible commit boundary. */
  onCommitState?: (committing: boolean) => void
}

export class ReceiverSession {
  private readonly writer: ChunkWriter
  private readonly channel: DriveChannel
  private readonly opts: ReceiverOptions

  private size = 0
  private chunkSize = 0
  private bitmap: Bitmap | null = null
  private requested = new Set<number>()
  private nextNeedIndex = 0
  private queuedChunkFrames = 0
  private queuedControlFrames = 0
  private receivedBytes = 0
  private reportedBytes = 0
  private reportedAt = 0
  private transferId: string | null
  private settled = false
  private cancelling = false
  private committing = false
  private settle!: { resolve: (savedTo: string) => void; reject: (err: Error) => void }
  private readonly done: Promise<string>
  private tail: Promise<void> = Promise.resolve()
  private readonly silence: Timeout

  constructor(writer: ChunkWriter, channel: DriveChannel, opts: ReceiverOptions) {
    this.writer = writer
    this.channel = channel
    this.opts = opts
    this.transferId = opts.transferId ?? null
    const silenceMs = opts.stallTimeoutMs ?? PEER_SILENCE_TIMEOUT_MS
    this.silence = new Timeout(silenceMs, () => {
      // A watchdog must not sit behind the serial queue it is supposed to
      // interrupt. fail() marks the session settled synchronously and aborts
      // the writer outside tail; the writer's isolated I/O process is the hard
      // cancellation boundary for a blocked local syscall.
      void this.fail(new Error(`No data from sender for ${silenceMs}ms`))
    })
    this.done = new Promise<string>((resolve, reject) => {
      this.settle = { resolve, reject }
    })
    this.done.catch(() => {})
    this.channel.onMessage((message) => {
      this.onMessage(message)
    })
    this.channel.onChunk((header, data) => {
      if (this.settled || this.cancelling) return
      // Never retain an unbounded number of network payloads while disk I/O is
      // slow. Legitimate senders have at most NEED_BATCH_CHUNKS credits; a
      // buggy/malicious peer cannot make the promise chain retain more.
      if (this.queuedChunkFrames >= NEED_BATCH_CHUNKS) {
        this.cancelling = true
        this.silence.stop()
        void this.fail(new IntegrityError('Receiver chunk credit window exceeded'))
        return
      }
      this.queuedChunkFrames++
      this.enqueue(async () => {
        try {
          await this.onChunk(header, data)
        } finally {
          this.queuedChunkFrames--
        }
      })
    })
    this.restartSilenceTimer()
  }

  private restartSilenceTimer(): void {
    if (this.settled) return
    this.silence.restart()
  }

  private enqueue(task: () => Promise<void>): void {
    this.tail = this.tail.then(task).catch((err) => this.fail(err))
  }

  private enqueueControl(task: () => Promise<void>): void {
    if (this.settled || this.cancelling) return
    if (this.queuedControlFrames >= MAX_QUEUED_CONTROL_FRAMES) {
      this.cancelling = true
      this.silence.stop()
      void this.fail(new IntegrityError('Receiver control queue exceeded'))
      return
    }
    this.queuedControlFrames++
    this.enqueue(async () => {
      try {
        await task()
      } finally {
        this.queuedControlFrames--
      }
    })
  }

  receive(): Promise<string> {
    return this.done
  }

  get received(): Bitmap | null {
    return this.bitmap
  }

  private onMessage(message: ControlMessage): void {
    if (message.type === 'start') {
      if (this.transferId === null) this.transferId = message.transferId
      else if (message.transferId !== this.transferId) return
      this.enqueueControl(() => this.onStart(message.size, message.chunkSize))
      return
    }
    if (this.transferId === null || message.transferId !== this.transferId) return
    switch (message.type) {
      case 'complete':
        this.enqueueControl(() => this.onComplete())
        break
      case 'cancel':
        // Peer cancellation is terminal control, not ordered transfer work.
        // Running it through tail can deadlock behind a stalled local write.
        // Once an irreversible commit has started, success owns the terminal
        // transition. Treat a later cancel as stale instead of reporting a
        // failure for a file that may already be published.
        if (this.committing) return
        this.cancelling = true
        this.silence.stop()
        void this.fail(new Error(message.reason ?? 'Transfer cancelled by sender'), {
          notifyPeer: false
        })
        break
    }
  }

  private isValidGeometry(size: number, chunkSize: number): boolean {
    return (
      Number.isSafeInteger(size) &&
      size >= 0 &&
      size <= MAX_TRANSFER_SIZE_BYTES &&
      chunkSize === selectChunkSize(size)
    )
  }

  private requestNextBatch(): void {
    const bitmap = this.bitmap
    if (!bitmap || this.transferId === null || this.settled || this.cancelling) return
    let indices = bitmap.missing(NEED_BATCH_CHUNKS, this.nextNeedIndex)
    // Defensive wrap: normally every prior batch is complete before cursor
    // advance, but a restored/custom bitmap may still contain an earlier hole.
    if (indices.length === 0 && !bitmap.allSet() && this.nextNeedIndex > 0) {
      this.nextNeedIndex = 0
      indices = bitmap.missing(NEED_BATCH_CHUNKS, 0)
    }
    if (indices.length > 0) this.nextNeedIndex = indices[indices.length - 1] + 1
    this.requested = new Set(indices)
    this.channel.send({
      type: 'need',
      transferId: this.transferId,
      indices,
      receivedBytes: this.receivedBytes
    })
  }

  private resendCurrentBatch(): void {
    if (this.transferId === null || this.settled || this.cancelling) return
    this.channel.send({
      type: 'need',
      transferId: this.transferId,
      indices: [...this.requested],
      receivedBytes: this.receivedBytes
    })
  }

  private async onStart(size: number, chunkSize: number): Promise<void> {
    if (this.settled || this.cancelling) return
    if (!this.isValidGeometry(size, chunkSize)) {
      throw new IntegrityError(`Rejected transfer geometry: size=${size} chunkSize=${chunkSize}`)
    }
    const expected = this.opts.expectedSize
    if (expected !== undefined && size !== expected) {
      throw new IntegrityError(`Sender announced ${size} bytes, expected ${expected}`)
    }
    if (this.bitmap) {
      if (size !== this.size || chunkSize !== this.chunkSize) {
        throw new IntegrityError(`Sender re-announced ${size}/${chunkSize} mid-transfer`)
      }
      if (this.requested.size > 0) this.resendCurrentBatch()
      else this.requestNextBatch()
      return
    }

    this.size = size
    this.chunkSize = chunkSize
    const total = chunkCount(size, chunkSize)
    try {
      this.bitmap = this.opts.resumeBits
        ? Bitmap.deserialize(total, this.opts.resumeBits)
        : new Bitmap(total)
    } catch (err) {
      throw new IntegrityError(
        `Resume state does not match this file: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    // Avoid an O(chunkCount) startup scan. Every full chunk contributes
    // chunkSize bytes; only the final chunk can be shorter.
    this.receivedBytes = this.bitmap.count() * chunkSize
    if (total > 0 && this.bitmap.get(total - 1)) {
      this.receivedBytes -= chunkSize - chunkRange(total - 1, size, chunkSize).length
    }

    // While local allocation is active we are not waiting on peer input. The
    // isolated writer owns its own bounded I/O deadline.
    this.silence.stop()
    await this.writer.allocate(size)
    if (this.settled || this.cancelling) return
    // The stall watchdog measures useful protocol progress, not arbitrary
    // traffic. A valid first start advances the receiver into an allocated,
    // geometry-bound state; repeated start/need/ack noise must not keep a
    // stalled transfer alive forever.
    this.restartSilenceTimer()
    this.requestNextBatch()
  }

  private async onChunk(header: ChunkHeader, data: Uint8Array): Promise<void> {
    if (this.settled || this.cancelling) return
    if (header.transferId !== this.transferId) return
    const bitmap = this.bitmap
    if (!bitmap) return
    if (!Number.isInteger(header.index) || header.index < 0 || header.index >= bitmap.size) {
      throw new Error(`Chunk index ${header.index} out of range`)
    }
    if (bitmap.get(header.index)) return
    // The sender may only put data in flight after an explicit need request.
    // This keeps a malicious or buggy peer from building an unbounded write
    // promise chain on a slow destination disk.
    if (!this.requested.has(header.index)) {
      throw new IntegrityError(`Received unrequested chunk ${header.index}`)
    }

    const { offset, length } = chunkRange(header.index, this.size, this.chunkSize)

    if (data.length !== length) {
      throw new Error(`Chunk ${header.index} length ${data.length}, expected ${length}`)
    }

    // A peer-silence timer only measures time spent waiting for peer input.
    // Disk write + durable checkpoint have their own bounded I/O lifecycle.
    this.silence.stop()
    await this.writer.write(offset, data)
    if (this.settled || this.cancelling) return
    bitmap.set(header.index)
    this.requested.delete(header.index)
    this.receivedBytes += length
    await this.opts.onChunkWritten?.(bitmap)
    if (this.settled || this.cancelling) return
    // Only a successfully persisted, explicitly credited chunk proves useful
    // forward progress. Wrong-direction controls, duplicates and malformed
    // chunks deliberately do not extend the peer-silence deadline.
    this.restartSilenceTimer()
    this.reportProgress(bitmap.allSet())
  }

  private reportProgress(force: boolean): void {
    if (!force && this.receivedBytes === this.reportedBytes) return

    const step = this.opts.progressStepBytes ?? PROGRESS_STEP_BYTES
    const now = Date.now()
    const interval = this.opts.progressIntervalMs ?? PROGRESS_INTERVAL_MS
    const steppedEnough = this.receivedBytes - this.reportedBytes >= step
    const waitedEnough = now - this.reportedAt >= interval
    if (!force && !steppedEnough && !waitedEnough) return

    this.reportedBytes = this.receivedBytes
    this.reportedAt = now
    this.opts.onProgress?.(this.receivedBytes, this.size)
  }

  private async onComplete(): Promise<void> {
    if (this.settled || this.cancelling) return
    const bitmap = this.bitmap
    if (!bitmap) throw new Error('Received complete before start')
    if (this.requested.size > 0) {
      // A complete before any credited chunk was written is never a stale
      // resume race: it is an incomplete transfer and must fail fast. Once
      // progress exists, a repeated start/resume can legitimately leave an old
      // complete in flight, so re-advertise only that current credit window.
      if (bitmap.count() === 0) {
        await this.fail(new Error('Transfer incomplete'))
        return
      }
      this.resendCurrentBatch()
      return
    }
    if (!bitmap.allSet()) {
      this.requestNextBatch()
      return
    }

    this.silence.stop()

    let savedTo: string
    this.opts.onFinalizeStart?.()
    const prepareFinalize = this.writer.prepareFinalize
    const commitFinalize = this.writer.commitFinalize
    if (prepareFinalize && commitFinalize) {
      // Preparation is still cancellable because it has not crossed the
      // writer's irreversible publication boundary yet.
      await prepareFinalize.call(this.writer)
      if (this.settled || this.cancelling) return

      // No await occurs between the cancellation check and setting committing,
      // so external cancel cannot interleave in that gap on the JS event loop.
      this.committing = true
      this.opts.onCommitState?.(true)
      try {
        savedTo = await commitFinalize.call(this.writer)
      } finally {
        this.committing = false
        this.opts.onCommitState?.(false)
      }
    } else {
      // Compatibility writers do not expose a safe split. Conservatively make
      // the entire finalize call the point-of-no-return window.
      this.committing = true
      this.opts.onCommitState?.(true)
      try {
        savedTo = await this.writer.finalize()
      } finally {
        this.committing = false
        this.opts.onCommitState?.(false)
      }
    }

    if (this.settled) return
    this.settled = true
    this.cancelling = false
    this.silence.stop()
    try {
      this.channel.send({ type: 'ack', transferId: this.transferId!, savedTo })
    } catch {}
    this.settle.resolve(savedTo)
  }

  cancel(reason = 'Transfer cancelled'): void {
    if (this.settled || this.cancelling || this.committing) return
    this.cancelling = true
    this.silence.stop()
    void this.fail(new Error(reason))
  }

  private async fail(err: Error, { notifyPeer = true }: CancelOptions = {}): Promise<void> {
    if (this.settled) return
    this.settled = true
    this.silence.stop()
    this.requested.clear()
    if (notifyPeer && this.transferId !== null) {
      try {
        this.channel.send({ type: 'cancel', transferId: this.transferId, reason: err.message })
      } catch {}
    }
    try {
      await this.writer.abort()
    } catch {}
    this.settle.reject(err)
  }
}
