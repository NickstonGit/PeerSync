import { describe, expect, it } from 'vitest'
import c, { type Encoding, type EncodingState } from 'compact-encoding'
import { controlEncoding, CONTROL_MAX_FRAME_BYTES } from './control-encoding'
import { PROTOCOL_VERSION } from './protocol'

function encode<T>(encoding: Encoding<T>, value: T): Uint8Array {
  const sizing: EncodingState = { start: 0, end: 0, buffer: null }
  encoding.preencode(sizing, value)
  const buffer = new Uint8Array(sizing.end)
  const writing: EncodingState = { start: 0, end: 0, buffer }
  encoding.encode(writing, value)
  return buffer
}

function decode<T>(encoding: Encoding<T>, buffer: Uint8Array): T {
  return encoding.decode({ start: 0, end: buffer.byteLength, buffer })
}

describe('controlEncoding', () => {
  it('round-trips normal control messages', () => {
    const value = {
      type: 'transfer-start',
      protocolVersion: PROTOCOL_VERSION,
      transferId: 'transfer-1',
      totalFiles: 2,
      totalBytes: 1234
    }

    const frame = encode(controlEncoding, value)
    expect(decode(controlEncoding, frame)).toEqual(value)
  })

  it('rejects oversized outbound control frames', () => {
    const value = { type: 'oversized', payload: 'x'.repeat(CONTROL_MAX_FRAME_BYTES) }
    expect(() => encode(controlEncoding, value)).toThrow(/too large/)
  })

  it('rejects oversized inbound frames before JSON parsing', () => {
    const raw = JSON.stringify({ type: 'oversized', payload: 'x'.repeat(CONTROL_MAX_FRAME_BYTES) })
    const frame = encode(c.string, raw)
    expect(() => decode(controlEncoding, frame)).toThrow(/too large/)
  })
})
