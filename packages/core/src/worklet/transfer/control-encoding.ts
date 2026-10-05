import c, { type Encoding, type EncodingState } from 'compact-encoding'

/**
 * Hard wire budget for the control plane. Per-field validation still applies
 * after decode; this cap prevents an untrusted peer from forcing the runtime to
 * materialize an arbitrarily large JSON control frame first.
 */
export const CONTROL_MAX_FRAME_BYTES = 8 * 1024 * 1024
const CONTROL_FRAME_OVERHEAD_BYTES = 1024

function jsonStringify(value: unknown): string {
  const raw = JSON.stringify(value)
  if (raw === undefined) throw new Error('invalid control message')
  return raw
}

/** UTF-8 length without allocating a second multi-megabyte encoded buffer. */
export function utf8ByteLength(value: string): number {
  let bytes = 0
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x7f) {
      bytes += 1
    } else if (code <= 0x7ff) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        i += 1
      } else {
        bytes += 3
      }
    } else {
      bytes += 3
    }
  }
  return bytes
}

export function controlJsonByteLength(value: unknown): number {
  return utf8ByteLength(jsonStringify(value))
}

export function controlMessageFits(value: unknown): boolean {
  return controlJsonByteLength(value) <= CONTROL_MAX_FRAME_BYTES
}

/**
 * Shared bounded JSON encoding for native/worklet and browser control channels.
 * Semantic validation is deliberately kept in control-validation.ts so both
 * transports apply exactly the same schema after decode.
 */
export const controlEncoding: Encoding<unknown> = {
  preencode(state, value) {
    const raw = jsonStringify(value)
    const before = state.end
    c.string.preencode(state, raw)
    if (state.end - before > CONTROL_MAX_FRAME_BYTES + 16) {
      throw new Error('control frame too large')
    }
  },
  encode(state, value) {
    const raw = jsonStringify(value)
    if (utf8ByteLength(raw) > CONTROL_MAX_FRAME_BYTES) throw new Error('control frame too large')
    c.string.encode(state, raw)
  },
  decode(state: EncodingState) {
    // Protomux supplies one message frame. Reject it before c.string allocates
    // the decoded JS string so the memory bound applies before JSON.parse().
    if (state.end - state.start > CONTROL_MAX_FRAME_BYTES + CONTROL_FRAME_OVERHEAD_BYTES) {
      throw new Error('control frame too large')
    }
    const raw = c.string.decode(state)
    if (utf8ByteLength(raw) > CONTROL_MAX_FRAME_BYTES) throw new Error('control frame too large')
    return JSON.parse(raw) as unknown
  }
}
