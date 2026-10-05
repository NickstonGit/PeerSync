import c, { type Encoding, type EncodingState } from 'compact-encoding'
import { MAX_TRANSFER_SIZE_BYTES, NEED_BATCH_CHUNKS } from './engine/constants'
import type { ChunkHeader, ControlMessage } from './engine/types'

// Exact legacy channel id retained for wire compatibility with existing PeerSync peers.
export const DRIVE_PROTOCOL = 'altersend/drive'
export const DRIVE_MAX_CHUNK_BYTES = 4 * 1024 * 1024
export const DRIVE_MAX_CONTROL_BYTES = 64 * 1024
const DRIVE_FRAME_OVERHEAD_BYTES = 1024
const TRANSFER_ID_MAX = 128
const TEXT_MAX = 4096

export interface ChunkFrame extends ChunkHeader {
  data: Uint8Array
}

function requireTransferId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > TRANSFER_ID_MAX) {
    throw new Error('invalid drive transferId')
  }
  return value
}

function requireText(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > TEXT_MAX) {
    throw new Error(`invalid drive ${field}`)
  }
  return value
}

function parseControlMessage(value: unknown): ControlMessage {
  if (!value || typeof value !== 'object') throw new Error('invalid drive control message')
  const obj = value as Record<string, unknown>
  const type = obj.type
  const transferId = requireTransferId(obj.transferId)
  if (type === 'start') {
    const name = requireText(obj.name, 'name')
    const size = Number(obj.size)
    const chunkSize = Number(obj.chunkSize)
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_TRANSFER_SIZE_BYTES) throw new Error('invalid drive start size')
    if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0 || chunkSize > DRIVE_MAX_CHUNK_BYTES) throw new Error('invalid drive chunkSize')
    return { type, transferId, name, size, chunkSize }
  }
  if (type === 'need') {
    if (!Array.isArray(obj.indices) || obj.indices.length > NEED_BATCH_CHUNKS) throw new Error('invalid drive need indices')
    const indices = obj.indices.map((item) => {
      const index = Number(item)
      if (!Number.isSafeInteger(index) || index < 0) throw new Error('invalid drive need index')
      return index
    })
    const receivedBytes = obj.receivedBytes === undefined ? undefined : Number(obj.receivedBytes)
    if (receivedBytes !== undefined && (!Number.isSafeInteger(receivedBytes) || receivedBytes < 0 || receivedBytes > MAX_TRANSFER_SIZE_BYTES)) {
      throw new Error('invalid drive receivedBytes')
    }
    return receivedBytes === undefined ? { type, transferId, indices } : { type, transferId, indices, receivedBytes }
  }
  if (type === 'complete') return { type, transferId }
  if (type === 'ack') return { type, transferId, savedTo: requireText(obj.savedTo, 'savedTo', true) }
  if (type === 'cancel') {
    const reason = obj.reason === undefined ? undefined : requireText(obj.reason, 'reason', true)
    return reason === undefined ? { type, transferId } : { type, transferId, reason }
  }
  throw new Error('invalid drive control type')
}

export const controlEncoding: Encoding<ControlMessage> = {
  preencode(state, message) {
    const raw = JSON.stringify(parseControlMessage(message))
    const before = state.end
    c.string.preencode(state, raw)
    // Measure encoded UTF-8 bytes, not JS UTF-16 code units. This keeps names
    // or reasons containing non-ASCII characters under the same wire cap.
    if (state.end - before > DRIVE_MAX_CONTROL_BYTES + 16) {
      throw new Error('drive control frame too large')
    }
  },
  encode(state, message) {
    const raw = JSON.stringify(parseControlMessage(message))
    if (raw.length > DRIVE_MAX_CONTROL_BYTES) throw new Error('drive control frame too large')
    c.string.encode(state, raw)
  },
  decode(state: EncodingState) {
    // Check the encoded frame before compact-encoding creates a large string.
    if (state.end - state.start > DRIVE_MAX_CONTROL_BYTES + DRIVE_FRAME_OVERHEAD_BYTES) {
      throw new Error('drive control frame too large')
    }
    const raw = c.string.decode(state)
    if (raw.length > DRIVE_MAX_CONTROL_BYTES) throw new Error('drive control frame too large')
    return parseControlMessage(JSON.parse(raw) as unknown)
  }
}

export const chunkEncoding: Encoding<ChunkFrame> = {
  preencode(state, frame) {
    requireTransferId(frame.transferId)
    if (!Number.isSafeInteger(frame.index) || frame.index < 0) throw new Error('invalid drive chunk index')
    if (!(frame.data instanceof Uint8Array) || frame.data.byteLength > DRIVE_MAX_CHUNK_BYTES) throw new Error('drive chunk frame too large')
    c.string.preencode(state, frame.transferId)
    c.uint.preencode(state, frame.index)
    c.raw.preencode(state, frame.data)
  },
  encode(state, frame) {
    requireTransferId(frame.transferId)
    if (!Number.isSafeInteger(frame.index) || frame.index < 0) throw new Error('invalid drive chunk index')
    if (!(frame.data instanceof Uint8Array) || frame.data.byteLength > DRIVE_MAX_CHUNK_BYTES) throw new Error('drive chunk frame too large')
    c.string.encode(state, frame.transferId)
    c.uint.encode(state, frame.index)
    c.raw.encode(state, frame.data)
  },
  decode(state: EncodingState) {
    // Protomux gives the decoder one bounded message frame. Reject an oversized
    // frame before c.raw can expose/allocate the payload to the receiver.
    if (state.end - state.start > DRIVE_MAX_CHUNK_BYTES + DRIVE_FRAME_OVERHEAD_BYTES) {
      throw new Error('drive chunk frame too large')
    }
    const transferId = requireTransferId(c.string.decode(state))
    const index = c.uint.decode(state)
    if (!Number.isSafeInteger(index) || index < 0) throw new Error('invalid drive chunk index')
    const data = c.raw.decode(state)
    if (data.byteLength > DRIVE_MAX_CHUNK_BYTES) throw new Error('drive chunk frame too large')
    return { transferId, index, data }
  }
}
