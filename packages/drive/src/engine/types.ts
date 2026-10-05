export interface AbortLike {
  readonly aborted: boolean
  addEventListener(type: 'abort', listener: () => void): void
  removeEventListener(type: 'abort', listener: () => void): void
}

export interface ChunkReader {
  size(): Promise<number>
  read(offset: number, length: number): Promise<Uint8Array>
  close(): Promise<void>
}

export interface ChunkWriter {
  allocate(size: number): Promise<void>
  write(offset: number, data: Uint8Array): Promise<void>
  /**
   * Optional two-phase finalization contract.
   *
   * Writers that can separate durable preparation (flush/hash/close) from the
   * irreversible namespace/storage commit should implement both methods. The
   * receiver may still honour cancellation while prepareFinalize() is running,
   * but once commitFinalize() starts the commit is terminal: a late cancel must
   * not turn an already-published file into a failed transfer.
   *
   * finalize() remains the compatibility path for writers that cannot expose a
   * precise commit boundary. For those writers the whole finalize() call is
   * treated as non-cancellable.
   */
  prepareFinalize?(): Promise<void>
  commitFinalize?(): Promise<string>
  finalize(): Promise<string>
  abort(): Promise<void>
}

export interface DriveChannel {
  send(message: ControlMessage): void
  sendChunk(header: ChunkHeader, data: Uint8Array): void
  onMessage(handler: (message: ControlMessage) => void): void
  onChunk(handler: (header: ChunkHeader, data: Uint8Array) => void): void
  bufferedAmount(): number
  whenWritable?(): Promise<void>
  close(): void
}

export interface ChunkHeader {
  transferId: string
  index: number
}

export type ControlMessage =
  | StartMessage
  | NeedMessage
  | CompleteMessage
  | AckMessage
  | CancelMessage

export interface StartMessage {
  type: 'start'
  transferId: string
  name: string
  size: number
  chunkSize: number
}

export interface NeedMessage {
  type: 'need'
  transferId: string
  indices: number[]
  /** Optional backward-compatible receiver progress hint for resumed/batched sends. */
  receivedBytes?: number
}

export interface CompleteMessage {
  type: 'complete'
  transferId: string
}

export interface AckMessage {
  type: 'ack'
  transferId: string
  savedTo: string
}

export interface CancelMessage {
  type: 'cancel'
  transferId: string
  reason?: string
}
