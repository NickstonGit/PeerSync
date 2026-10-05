import { describe, expect, it } from 'vitest'
import c, { type Encoding, type EncodingState } from 'compact-encoding'
import {
  chunkEncoding,
  controlEncoding,
  DRIVE_MAX_CHUNK_BYTES,
  DRIVE_MAX_CONTROL_BYTES,
  type ChunkFrame
} from './transport'

const unsafeChunkEncoding: Encoding<ChunkFrame> = {
  preencode(state: EncodingState, frame: ChunkFrame) {
    c.string.preencode(state, frame.transferId)
    c.uint.preencode(state, frame.index)
    c.raw.preencode(state, frame.data)
  },
  encode(state: EncodingState, frame: ChunkFrame) {
    c.string.encode(state, frame.transferId)
    c.uint.encode(state, frame.index)
    c.raw.encode(state, frame.data)
  },
  decode(_state: EncodingState): ChunkFrame {
    throw new Error('unused')
  }
}

describe('drive transport frame limits', () => {
  it('rejects an oversized chunk before exposing it to the receiver', () => {
    const frame = c.encode(unsafeChunkEncoding, {
      transferId: 't1',
      index: 0,
      data: new Uint8Array(DRIVE_MAX_CHUNK_BYTES + 1)
    })
    expect(() => c.decode(chunkEncoding, frame)).toThrow(/too large/)
  })

  it('rejects an oversized control frame before JSON dispatch', () => {
    const raw = JSON.stringify({
      type: 'cancel',
      transferId: 't1',
      reason: 'x'.repeat(DRIVE_MAX_CONTROL_BYTES)
    })
    const frame = c.encode(c.string, raw)
    expect(() => c.decode(controlEncoding, frame)).toThrow(/too large/)
  })

  it('accepts a normal need frame', () => {
    const value = { type: 'need' as const, transferId: 't1', indices: [0, 1], receivedBytes: 0 }
    const frame = c.encode(controlEncoding, value)
    expect(c.decode(controlEncoding, frame)).toEqual(value)
  })
})
