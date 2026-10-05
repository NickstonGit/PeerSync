import type { ChunkReader, DriveChannel, ControlMessage } from './types'
import { selectChunkSize, chunkCount, chunkRange } from './chunker'
import { MAX_TRANSFER_SIZE_BYTES, NEED_BATCH_CHUNKS, PEER_SILENCE_TIMEOUT_MS, PROGRESS_STEP_BYTES } from './constants'
import { Timeout } from './timeout'
import { Bitmap } from './bitmap'

interface CancelOptions {
  notifyPeer?: boolean
}

export interface SenderOptions {
  transferId: string
  name: string
  highWaterMark?: number
  ackTimeoutMs?: number
  progressStepBytes?: number
  onProgress?: (sentBytes: number, totalBytes: number) => void
}

const DEFAULT_HIGH_WATER = 8 * 1024 * 1024

type SenderState = 'created' | 'awaiting-need' | 'sending' | 'awaiting-ack' | 'settled'

export class SenderSession {
  private readonly reader: ChunkReader
  private readonly channel: DriveChannel
  private readonly opts: SenderOptions
  private readonly highWater: number
  private readonly done: Promise<string>
  private readonly settleWaiters: (() => void)[] = []

  private size = 0
  private chunkSize = 0
  private totalChunks = 0
  private served: Bitmap | null = null
  private started = false
  private announced = false
  private sending = false
  private sendLoop: Promise<void> | null = null
  private settled = false
  private state: SenderState = 'created'
  private readonly silence: Timeout
  private readonly pendingIndices = new Set<number>()
  private readonly activeIndices = new Set<number>()
  private needQueued = false
  private emptyNeedSeen = false
  private receiverBaseCaptured = false
  private receiverBaseBytes: number | null = null
  private pendingReceivedBytes: number | null = null
  private servedBytes = 0
  private sentBytes = 0
  private reportedBytes = 0
  private settle!: { resolve: (savedTo: string) => void; reject: (err: Error) => void }

  constructor(reader: ChunkReader, channel: DriveChannel, opts: SenderOptions) {
    this.reader = reader
    this.channel = channel
    this.opts = opts
    this.highWater = opts.highWaterMark ?? DEFAULT_HIGH_WATER
    if (!Number.isFinite(this.highWater) || this.highWater < 0) {
      throw new RangeError('highWaterMark must be a finite non-negative number')
    }
    this.done = new Promise<string>((resolve, reject) => {
      this.settle = { resolve, reject }
    })
    const silenceMs = opts.ackTimeoutMs ?? PEER_SILENCE_TIMEOUT_MS
    this.silence = new Timeout(silenceMs, () =>
      this.fail(new Error(`Receiver was silent for ${silenceMs}ms`), { notifyPeer: false })
    )
    this.done.catch(() => {})
    this.channel.onMessage((message) => this.onMessage(message))
  }

  async start(): Promise<string> {
    if (this.started) throw new Error('SenderSession already started')
    this.started = true

    try {
      this.size = await this.reader.size()
      if (!Number.isSafeInteger(this.size) || this.size < 0 || this.size > MAX_TRANSFER_SIZE_BYTES) {
        throw new RangeError(`File size ${this.size} is outside the supported transfer range`)
      }
      this.chunkSize = selectChunkSize(this.size)
      this.totalChunks = chunkCount(this.size, this.chunkSize)
      this.served = new Bitmap(this.totalChunks)

      if (this.settled) return this.done

      this.channel.send({
        type: 'start',
        transferId: this.opts.transferId,
        name: this.opts.name,
        size: this.size,
        chunkSize: this.chunkSize
      })
      this.announced = true
      this.state = 'awaiting-need'
      this.silence.start()
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)))
    }

    return this.done
  }

  private onMessage(message: ControlMessage): void {
    if (message.transferId !== this.opts.transferId) return
    switch (message.type) {
      case 'need':
        if (!this.announced || this.settled) break
        // Only newly accepted credit is receiver-side forward progress. Replayed
        // or duplicate needs are no-ops and must not keep a stalled sender alive.
        if (this.queueNeed(message.indices, message.receivedBytes)) this.silence.restart()
        break
      case 'ack':
        if (this.settled) break
        // ACK is terminal only after we emitted complete for the current credit
        // window and no newer credit was accepted. This prevents a peer from
        // turning the initial start frame into a false successful transfer.
        if (this.state !== 'awaiting-ack') {
          this.fail(new Error('Received ack before sender completed the credited batch'))
          break
        }
        this.confirmRemoteCommit(message.savedTo)
        break
      case 'cancel':
        this.fail(new Error(message.reason ?? 'Transfer cancelled by receiver'), {
          notifyPeer: false
        })
        break
      case 'start':
      case 'complete':
        // These frames travel sender -> receiver. Receiving one here is a
        // protocol violation, not useful activity for the sender watchdog.
        if (!this.settled) this.fail(new Error(`Unexpected ${message.type} frame from receiver`))
        break
    }
  }

  private hasValidIndices(indices: number[]): boolean {
    if (indices.length > NEED_BATCH_CHUNKS) return false
    const seen = new Set<number>()
    for (const index of indices) {
      if (!Number.isInteger(index) || index < 0 || index >= this.totalChunks) return false
      if (seen.has(index)) return false
      seen.add(index)
    }
    return true
  }

  private queueNeed(indices: number[], receivedBytes?: number): boolean {
    if (!this.hasValidIndices(indices)) {
      this.fail(new Error('Rejected invalid chunk request'))
      return false
    }
    if (receivedBytes !== undefined && (!Number.isSafeInteger(receivedBytes) || receivedBytes < 0 || receivedBytes > this.size)) {
      this.fail(new Error('Rejected invalid receiver progress'))
      return false
    }
    let queuedAny = false
    for (const index of indices) {
      // A repeated start/resume can re-announce the batch currently being
      // served. Do not queue those indices a second time: a stale second
      // complete would otherwise race the receiver's next credit window.
      if (this.served?.get(index) || this.activeIndices.has(index) || this.pendingIndices.has(index)) continue
      // The protocol grants at most NEED_BATCH_CHUNKS outstanding credits in
      // total. Capping only each individual `need` frame lets a peer enqueue
      // an unbounded union while the current batch is blocked on disk I/O.
      if (this.activeIndices.size + this.pendingIndices.size >= NEED_BATCH_CHUNKS) {
        this.fail(new Error('Rejected chunk request beyond credit window'))
        return false
      }
      this.pendingIndices.add(index)
      queuedAny = true
    }
    // An empty need is meaningful only once: zero-byte / fully-resumed file
    // asks us to emit complete. Replaying the same empty credit must not create
    // an infinite no-data complete/need keepalive loop.
    let queueEmpty = false
    if (indices.length === 0 && !this.sending && !this.emptyNeedSeen) {
      this.emptyNeedSeen = true
      queueEmpty = true
    }
    const shouldQueue = queuedAny || queueEmpty
    if (!shouldQueue) return false
    if (!this.receiverBaseCaptured) {
      // The first accepted credit tells us how many bytes were already durable
      // at the receiver before this session started serving missing chunks.
      // Keep that baseline immutable: later overlapping credit may report
      // progress that already includes chunks counted in servedBytes.
      this.receiverBaseCaptured = true
      this.receiverBaseBytes = receivedBytes ?? null
    }
    if (receivedBytes !== undefined) {
      this.pendingReceivedBytes = Math.max(this.pendingReceivedBytes ?? 0, receivedBytes)
    }
    this.needQueued = true
    this.state = 'sending'
    if (!this.sending) this.startSendLoop()
    return true
  }


  private startSendLoop(): void {
    if (this.sendLoop) return
    const loop = this.sendQueuedNeeds()
    this.sendLoop = loop
    void loop
      .catch((err) => this.fail(err instanceof Error ? err : new Error(String(err))))
      .finally(() => {
        if (this.sendLoop === loop) this.sendLoop = null
        // A need can arrive in the tiny window after sendQueuedNeeds observed
        // an empty queue but before this finally runs. Restart rather than
        // leaving valid credits stranded until another control frame arrives.
        if (!this.settled && this.needQueued && !this.sending) this.startSendLoop()
      })
  }

  private async sendQueuedNeeds(): Promise<void> {
    if (this.sending) return
    this.sending = true
    try {
      while (!this.settled && this.needQueued) {
        const indices = [...this.pendingIndices]
        this.pendingIndices.clear()
        this.needQueued = false
        const receiverBytes = this.pendingReceivedBytes
        this.pendingReceivedBytes = null
        await this.sendBatch(indices, receiverBytes)
      }
    } finally {
      this.sending = false
    }
  }

  private async sendBatch(indices: number[], receiverBytes: number | null): Promise<void> {
    this.activeIndices.clear()
    for (const index of indices) this.activeIndices.add(index)
    try {
      await this.sendBatchActive(indices, receiverBytes)
    } finally {
      this.activeIndices.clear()
    }
  }

  private async sendBatchActive(indices: number[], receiverBytes: number | null): Promise<void> {
    if (receiverBytes !== null) {
      // Overlapping/repeated need messages can carry an older progress hint;
      // UI progress must never move backwards.
      this.sentBytes = Math.max(this.sentBytes, receiverBytes)
    } else {
      // Backward compatibility with older receivers: historically a need list
      // represented the complete missing set, so infer already-present bytes.
      const pendingBytes = indices.reduce(
        (total, index) => total + chunkRange(index, this.size, this.chunkSize).length,
        0
      )
      this.sentBytes = Math.max(this.sentBytes, this.size - pendingBytes)
    }
    this.reportedBytes = Math.min(this.reportedBytes, this.sentBytes)
    const step = this.opts.progressStepBytes ?? PROGRESS_STEP_BYTES
    for (const index of indices) {
      if (this.settled) return
      const { offset, length } = chunkRange(index, this.size, this.chunkSize)
      const data = await this.reader.read(offset, length)
      if (data.length !== length) {
        throw new Error(`Short read for chunk ${index}: ${data.length} bytes, expected ${length}`)
      }

      await this.drain()
      if (this.settled) return
      this.channel.sendChunk({ transferId: this.opts.transferId, index }, data)
      this.served?.set(index)
      // Local forward progress proves this session is not stuck in drain().
      this.silence.restart()

      this.servedBytes += data.length
      this.sentBytes = Math.min(this.size, this.sentBytes + data.length)
      if (this.sentBytes - this.reportedBytes >= step || this.sentBytes === this.size) {
        this.reportedBytes = this.sentBytes
        this.opts.onProgress?.(this.sentBytes, this.size)
      }
    }

    if (this.settled) return
    // Publish the state before sending complete. DriveChannel implementations
    // are allowed to deliver control synchronously (tests/adapters). For the
    // current protocol, the first accepted receivedBytes value is the durable
    // resume baseline. Add only unique chunks physically sent by this session;
    // this remains correct even when later credit arrives while a batch is in
    // flight. Older receivers did not send receivedBytes and used one need as
    // the complete missing set, so preserve that legacy terminal interpretation.
    if (this.receiverBaseBytes !== null && this.receiverBaseBytes + this.servedBytes > this.size) {
      this.fail(new Error('Receiver progress overlaps requested chunks'))
      return
    }
    const receiverCanBeComplete = this.receiverBaseBytes === null || this.receiverBaseBytes + this.servedBytes === this.size
    this.state = this.needQueued || this.pendingIndices.size > 0
      ? 'sending'
      : receiverCanBeComplete ? 'awaiting-ack' : 'awaiting-need'
    this.channel.send({
      type: 'complete',
      transferId: this.opts.transferId
    })
    // complete is only a control notification; it does not itself prove useful
    // progress, so do not extend the watchdog here.
  }

  private async drain(): Promise<void> {
    let fallbackDelayMs = 8
    while (!this.settled && this.channel.bufferedAmount() > this.highWater) {
      const settled = this.settlementSignal()
      try {
        if (this.channel.whenWritable) {
          await Promise.race([this.channel.whenWritable(), settled.promise])
        } else {
          // Some browser transports cannot expose a drain event. Poll with a
          // bounded backoff instead of a 1 ms timer loop that burns CPU while
          // the socket is congested.
          await Promise.race([
            new Promise<void>((resolve) => setTimeout(() => resolve(), fallbackDelayMs)),
            settled.promise
          ])
          fallbackDelayMs = Math.min(100, fallbackDelayMs * 2)
        }
      } finally {
        // Promise.race does not cancel its loser. Remove the settlement waiter
        // when writable/timer wins so a long congested transfer cannot build an
        // ever-growing settleWaiters array.
        settled.cancel()
      }
    }
  }

  private settlementSignal(): { promise: Promise<void>; cancel: () => void } {
    if (this.settled) return { promise: Promise.resolve(), cancel: () => {} }
    let active = true
    let resolve!: () => void
    const waiter = () => {
      if (!active) return
      active = false
      resolve()
    }
    const promise = new Promise<void>((done) => {
      resolve = done
      this.settleWaiters.push(waiter)
    })
    const cancel = () => {
      if (!active) return
      active = false
      const index = this.settleWaiters.indexOf(waiter)
      if (index >= 0) this.settleWaiters.splice(index, 1)
    }
    return { promise, cancel }
  }

  private releaseSettleWaiters(): void {
    const waiting = this.settleWaiters.splice(0)
    for (const resolve of waiting) resolve()
  }

  /**
   * The filesystem x-result is an authenticated terminal proof from the same
   * receiver: it is emitted only after full-payload verification and commit.
   * It can therefore settle a sender whose final Drive ACK was dropped.
   */
  confirmRemoteCommit(savedTo: string): void {
    if (this.settled) return
    this.settled = true
    this.state = 'settled'
    this.releaseSettleWaiters()
    this.silence.stop()
    this.pendingIndices.clear()
    this.activeIndices.clear()
    this.needQueued = false
    this.settle.resolve(savedTo)
  }

  cancel(reason = 'Transfer cancelled', options: CancelOptions = {}): void {
    this.fail(new Error(reason), options)
  }

  private fail(err: Error, { notifyPeer = true }: CancelOptions = {}): void {
    if (this.settled) return
    this.settled = true
    this.state = 'settled'
    this.releaseSettleWaiters()
    this.silence.stop()
    this.pendingIndices.clear()
    this.activeIndices.clear()
    this.needQueued = false
    if (notifyPeer) {
      try {
        this.channel.send({ type: 'cancel', transferId: this.opts.transferId })
      } catch {}
    }
    this.settle.reject(err)
  }

  async close(): Promise<void> {
    // Abort the reader first. Production SourceReader owns file I/O in a
    // killable worker, so this physically interrupts a blocked SMB/UNC read.
    // Waiting for sendLoop before reader.close() recreates a cleanup deadlock:
    // sendLoop is precisely what may be stuck inside reader.read().
    await this.reader.close().catch(() => {})
    const loop = this.sendLoop
    if (loop) await loop.catch(() => {})
  }
}
