import b4a from 'b4a'

export const MAX_FRAME = 1024 * 1024

export interface Frame {
  value: Record<string, unknown> | null
  error: string | null
}

export function encodeFrame(payload: unknown): Uint8Array {
  const json = JSON.stringify(payload)
  const body = b4a.from(json, 'utf8')
  if (body.byteLength > MAX_FRAME) throw new Error('frame too large')
  const frame = new Uint8Array(4 + body.byteLength)
  writeUInt32LE(frame, body.byteLength)
  frame.set(body, 4)
  return frame
}

function writeUInt32LE(target: Uint8Array, value: number): void {
  new DataView(target.buffer, target.byteOffset, 4).setUint32(0, value, true)
}

function readUInt32LE(source: Uint8Array): number {
  return new DataView(source.buffer, source.byteOffset, 4).getUint32(0, true)
}

export class FrameDecoder {
  private pending: Uint8Array = new Uint8Array(0)
  private offset = 0

  push(chunk: Uint8Array): Frame[] {
    const views: Frame[] = []
    const remaining = this.pending.subarray(this.offset)
    this.pending = remaining.byteLength
      ? b4a.concat([remaining, chunk], remaining.byteLength + chunk.byteLength)
      : b4a.from(chunk)
    this.offset = 0

    for (;;) {
      const available = this.pending.byteLength - this.offset
      if (available < 4) break
      const header = this.pending.subarray(this.offset, this.offset + 4)
      const len = readUInt32LE(header)
      if (len === 0 || len > MAX_FRAME) {
        views.push({ value: null, error: `bad frame length ${len}` })
        this.pending = new Uint8Array(0)
        this.offset = 0
        return views
      }
      if (available < 4 + len) break
      const bodyStart = this.offset + 4
      const body = this.pending.subarray(bodyStart, bodyStart + len)
      this.offset = bodyStart + len
      try {
        views.push({ value: JSON.parse(b4a.toString(body, 'utf8')), error: null })
      } catch {
        views.push({ value: null, error: 'unparseable frame' })
      }
    }

    if (this.offset === this.pending.byteLength) {
      this.pending = new Uint8Array(0)
      this.offset = 0
    } else if (this.offset > 64 * 1024) {
      // Compact once after a large consumed prefix instead of allocating once
      // per decoded frame. This matters when Core emits a burst of small events.
      this.pending = b4a.from(this.pending.subarray(this.offset))
      this.offset = 0
    }
    return views
  }
}
