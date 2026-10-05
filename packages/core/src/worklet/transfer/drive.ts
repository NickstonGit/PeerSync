import Protomux, { type ProtomuxMessage } from 'protomux'
import type { PeerSocket } from 'hyperswarm'
import {
  sendFile,
  type ChunkHeader,
  type ControlMessage,
  type DriveChannel
} from '@peersync/drive'
import { DRIVE_PROTOCOL, chunkEncoding, controlEncoding, type ChunkFrame } from '@peersync/drive/transport'

interface Session {
  onMessage?: (message: ControlMessage) => void
  onChunk?: (header: ChunkHeader, data: Uint8Array) => void
  pendingCancel?: ControlMessage
}

type ProtomuxChannelLike = NonNullable<ReturnType<Protomux['createChannel']>>

function cancelForDisconnect(transferId: string): ControlMessage {
  return { type: 'cancel', transferId, reason: 'Peer disconnected' }
}

export class PeerDrive {
  private readonly channel: ProtomuxChannelLike
  private readonly control: ProtomuxMessage<ControlMessage>
  private readonly chunk: ProtomuxMessage<ChunkFrame>
  private readonly sessions = new Map<string, Session>()
  private readonly socket: PeerSocket
  private readonly writable: (() => void)[] = []
  private readonly sends = new Map<string, { abort: AbortController; done: Promise<void> }>()
  private fallbackBufferedBytes = 0
  private destroyed = false

  readonly supported: Promise<boolean>

  private constructor(channel: ProtomuxChannelLike, socket: PeerSocket) {
    this.channel = channel
    this.socket = socket
    socket.on('drain', this.onDrain)
    this.control = channel.addMessage<ControlMessage>({
      encoding: controlEncoding,
      onmessage: (message) => {
        if (message && typeof message.transferId === 'string') {
          this.sessions.get(message.transferId)?.onMessage?.(message)
        }
      }
    })
    this.chunk = channel.addMessage<ChunkFrame>({
      encoding: chunkEncoding,
      onmessage: ({ transferId, index, data }) => {
        this.sessions.get(transferId)?.onChunk?.({ transferId, index }, data)
      }
    })
    channel.open()
    this.supported = channel.fullyOpened()
  }

  static create(socket: PeerSocket): PeerDrive | null {
    const channel = Protomux.from(socket).createChannel({ protocol: DRIVE_PROTOCOL })
    return channel ? new PeerDrive(channel, socket) : null
  }

  session(fileId: string): DriveChannel {
    if (!this.destroyed && this.sessions.has(fileId)) {
      throw new Error(`drive session already open: ${fileId}`)
    }
    const session: Session = {}
    if (this.destroyed) session.pendingCancel = cancelForDisconnect(fileId)
    else this.sessions.set(fileId, session)

    return {
      send: (message) => this.control.send(message),
      sendChunk: (header, data) => {
        this.chunk.send({ ...header, data })
        // Only used on runtimes that expose neither writableLength nor
        // _writableState.length. Keep a conservative byte estimate until
        // Protomux/socket reports a drain instead of jumping straight to the
        // entire high-water mark after one chunk.
        if (this.channel.drained) this.fallbackBufferedBytes = 0
        else this.fallbackBufferedBytes += data.byteLength
      },
      onMessage: (handler) => {
        session.onMessage = handler
        if (session.pendingCancel) handler(session.pendingCancel)
      },
      onChunk: (handler) => {
        session.onChunk = handler
      },
      bufferedAmount: () => this.outstandingBytes(),
      whenWritable: () => this.whenWritable(),
      close: () => {
        if (this.sessions.get(fileId) === session) this.sessions.delete(fileId)
      }
    }
  }

  private readonly onDrain = (): void => {
    this.fallbackBufferedBytes = 0
    this.releaseWaiters()
  }

  private releaseWaiters(): void {
    const waiting = this.writable.splice(0)
    for (const resolve of waiting) resolve()
  }

  private whenWritable(): Promise<void> {
    if (this.destroyed || this.outstandingBytes() === 0) return Promise.resolve()
    return new Promise<void>((resolve) => this.writable.push(resolve))
  }

  private outstandingBytes(): number {
    if (this.destroyed) return 0
    // Prefer the transport's actual writable queue. Counting every sent chunk
    // until one global `drain` both over-counts after partial flushes and can
    // under-count when Protomux reports drained synchronously. PeerSocket is a
    // Duplex stream in the real runtime; keep a conservative fallback for the
    // small loopback socket used by tests/alternate runtimes.
    const stream = this.socket as unknown as {
      writableLength?: number
      _writableState?: { length?: number }
    }
    const direct = Number(stream.writableLength)
    if (Number.isFinite(direct) && direct >= 0) return direct
    const legacy = Number(stream._writableState?.length)
    if (Number.isFinite(legacy) && legacy >= 0) return legacy
    if (this.channel.drained) {
      this.fallbackBufferedBytes = 0
      return 0
    }
    return this.fallbackBufferedBytes
  }

  async serve(fileId: string, name: string, localPath: string | null): Promise<void> {
    const previous = this.sends.get(fileId)
    const abort = new AbortController()
    let settle!: () => void
    const done = new Promise<void>((resolve) => {
      settle = resolve
    })
    this.sends.set(fileId, { abort, done })

    if (previous) {
      previous.abort.abort()
      await previous.done
    }

    let channel: DriveChannel | null = null

    try {
      if (!(await this.supported)) {
        throw new Error('Peer does not support the drive protocol')
      }
      if (!localPath) {
        this.control.send({
          type: 'cancel',
          transferId: fileId,
          reason: 'File is no longer readable on the sender'
        })
        return
      }
      channel = this.session(fileId)

      await sendFile(localPath, channel, {
        transferId: fileId,
        name,
        signal: abort.signal,
        notifyPeerOnCancel: false
      })
    } finally {
      channel?.close()
      if (this.sends.get(fileId)?.abort === abort) this.sends.delete(fileId)
      settle()
    }
  }

  cancel(): void {
    for (const entry of this.sends.values()) entry.abort.abort()
  }

  destroy(): void {
    this.destroyed = true
    this.socket.off('drain', this.onDrain)
    this.fallbackBufferedBytes = 0
    this.releaseWaiters()
    this.cancel()
    for (const [transferId, session] of this.sessions) {
      const cancel = cancelForDisconnect(transferId)
      if (session.onMessage) session.onMessage(cancel)
      else session.pendingCancel = cancel
    }
    this.sessions.clear()

    try {
      this.channel.close()
    } catch {}
  }
}
