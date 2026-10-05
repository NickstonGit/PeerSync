import { describe, expect, it } from 'vitest'
import b4a from 'b4a'
import { encodeFrame, FrameDecoder, MAX_FRAME } from './framing'

describe('FrameDecoder', () => {
  it('decodes many frames from one chunk without losing order', () => {
    const decoder = new FrameDecoder()
    const frames = Array.from({ length: 64 }, (_, index) => encodeFrame({ index }))
    const bytes = b4a.concat(frames, frames.reduce((sum, frame) => sum + frame.byteLength, 0))
    const out = decoder.push(bytes)
    expect(out.map((frame) => frame.value)).toEqual(Array.from({ length: 64 }, (_, index) => ({ index })))
  })

  it('keeps a partial frame across pushes', () => {
    const decoder = new FrameDecoder()
    const frame = encodeFrame({ hello: 'world' })
    expect(decoder.push(frame.subarray(0, 7))).toEqual([])
    expect(decoder.push(frame.subarray(7))).toEqual([{ value: { hello: 'world' }, error: null }])
  })

  it('rejects oversized frame headers and resets cleanly', () => {
    const decoder = new FrameDecoder()
    const bad = new Uint8Array(4)
    new DataView(bad.buffer).setUint32(0, MAX_FRAME + 1, true)
    expect(decoder.push(bad)[0]?.error).toMatch(/bad frame length/)
    expect(decoder.push(encodeFrame({ ok: true }))).toEqual([{ value: { ok: true }, error: null }])
  })
})
