// fs.v1 / chat.v1 protomux channels (envelope over the core-to-core
// wire). JSON via compact-encoding raw + our own 256 KiB wire cap decode.

import Protomux, { type ProtomuxChannel, type ProtomuxMessage } from 'protomux'
import c, { type EncodingState } from 'compact-encoding'
import b4a from 'b4a'
import { randomBytes } from 'hypercore-crypto'
import { WIRE_MAX_JSON } from './limits'
import { dbg } from './log'
import { errorMessage } from './errors'

export { FS_PROTOCOL, CHAT_PROTOCOL, UPDATE_PROTOCOL } from '../transport-compat'

const MAX_PREOPEN_QUEUE = 256
const MAX_PENDING_REQUESTS = 256
const MAX_INBOUND_REQUESTS = 64
const MAX_COMPLETED_RESPONSES = 512
const MAX_WIRE_TOKEN_LENGTH = 128
const MAX_WIRE_ERROR_CODE_LENGTH = 64
const MAX_WIRE_ERROR_MESSAGE_LENGTH = 1024
const WIRE_ERROR_CODE_RE = /^[A-Za-z0-9_-]{1,64}$/
const WIRE_MAX_OUTBOUND_JSON = WIRE_MAX_JSON - 64

function wireJsonFits(json: string): boolean {
  return b4a.byteLength(json, 'utf8') <= WIRE_MAX_OUTBOUND_JSON
}

// length-prefixed UTF-8 JSON with a hard cap (compact-encoding string), the
// same framing control-channel uses for its c.json messages.
const jsonEncoding = {
  preencode(state: EncodingState, val: string) {
    c.string.preencode(state, val)
  },
  encode(state: EncodingState, val: string) {
    c.string.encode(state, val)
  },
  decode(state: EncodingState): string {
    if (state.end - state.start > WIRE_MAX_JSON) throw new Error('wire frame too large')
    return c.string.decode(state)
  }
}

export type WireRequest = { v: 1; requestId: string; method: string; payload: unknown }
export type WireResponse = { v: 1; requestId: string; ok: boolean; result?: unknown; error?: string; message?: string }
export type WireEvent = { v: 1; event: string; payload: unknown }

/** Inbound frame after JSON.parse — fields are validated before use. */
type InboundFrame = Partial<WireRequest & WireResponse & WireEvent>

type QueuedFrame = { json: string; requestId: string | null }

export function normalizeInboundResponse(requestId: string, msg: InboundFrame): WireResponse {
  const ok = msg.ok === true
  const response: WireResponse = { v: 1, requestId, ok }
  if (ok) {
    if ('result' in msg) response.result = msg.result
    return response
  }
  const rawError = typeof msg.error === 'string' ? msg.error : ''
  response.error = rawError.length <= MAX_WIRE_ERROR_CODE_LENGTH && WIRE_ERROR_CODE_RE.test(rawError)
    ? rawError
    : 'REMOTE_ERROR'
  if (typeof msg.message === 'string' && msg.message.length > 0) {
    response.message = msg.message.slice(0, MAX_WIRE_ERROR_MESSAGE_LENGTH)
  }
  return response
}

export class WireChannel {
  private _channel: ProtomuxChannel | null
  private _message: ProtomuxMessage<string> | null = null
  private _pending = new Map<string, { resolve: (r: WireResponse) => void; timer: ReturnType<typeof setTimeout>; method: string }>()
  private _completed = new Map<string, { method: string; response: WireResponse }>()
  private _inbound = new Map<string, { cancelled: boolean }>()
  private _open = false
  private _queue: QueuedFrame[] = []
  private _closed = false
  onEvent: (ev: { event: string; payload: unknown }) => void = () => {}
  onRequest: (req: {
    requestId: string
    method: string
    payload: unknown
    /** Becomes true as soon as the wire channel/session is closed. */
    cancelled: () => boolean
    respond: (ok: boolean, body: { result?: unknown; error?: string; message?: string }) => void
  }) => void | Promise<void> = (req) => {
    req.respond(false, { error: 'INTERNAL', message: 'request handler not installed' })
  }

  constructor(socket: unknown, private _protocol: string) {
    this._channel = Protomux.from(socket).createChannel({ protocol: _protocol, onopen: () => this._onOpen(), onclose: () => this._onClose() })
    // protomux rejects unknown channel opens gracefully: peer without fs.v1
    // simply leaves _open false; request() then rejects/timeout-bounds buffering.
    if (!this._channel) {
      dbg('wire createChannel returned null for', _protocol)
      this._closed = true
      return
    }
    this._message = this._channel.addMessage<string>({ encoding: jsonEncoding, onmessage: (raw) => this._onRaw(raw) })
    this._channel.open()
  }

  get open(): boolean {
    return this._open && !this._closed
  }

  private _onOpen(): void {
    if (this._closed) return
    dbg('wire channel OPEN', this._protocol)
    this._open = true
    const queued = this._queue.splice(0)
    for (const entry of queued) {
      // A timed-out request is no longer allowed to execute remotely.
      if (entry.requestId !== null && !this._pending.has(entry.requestId)) continue
      this._send(entry.json)
      if (this._closed) break
    }
  }

  private _onClose(): void {
    dbg('wire channel CLOSE', this._protocol)
    this._terminate('channel-closed')
  }

  private _terminate(reason: string): void {
    this._open = false
    this._closed = true
    this._queue = []
    // Handlers may be inside a long isolated filesystem scan. Flip their token
    // before dropping bookkeeping so workers can terminate instead of running
    // for minutes after the requesting peer/session disappeared.
    for (const token of this._inbound.values()) token.cancelled = true
    this._inbound.clear()
    this._failAll(reason)
  }

  private _failAll(reason: string): void {
    for (const [id, p] of this._pending) {
      clearTimeout(p.timer)
      this._pending.delete(id)
      p.resolve({ v: 1, requestId: id, ok: false, error: 'OFFLINE', message: reason })
    }
  }

  private _dropQueuedRequest(requestId: string): void {
    if (this._queue.length === 0) return
    this._queue = this._queue.filter((entry) => entry.requestId !== requestId)
  }

  private _rememberResponse(requestId: string, method: string, response: WireResponse): void {
    this._completed.delete(requestId)
    this._completed.set(requestId, { method, response })
    while (this._completed.size > MAX_COMPLETED_RESPONSES) {
      const oldest = this._completed.keys().next().value
      if (typeof oldest !== 'string') break
      this._completed.delete(oldest)
    }
  }

  private _enqueue(entry: QueuedFrame): boolean {
    if (this._closed) return false
    if (this._queue.length >= MAX_PREOPEN_QUEUE) return false
    this._queue.push(entry)
    return true
  }

  private _send(json: string): void {
    if (this._closed || !this._message) return
    if (!wireJsonFits(json)) {
      this._terminate('outbound wire frame too large')
      return
    }
    try {
      this._message.send(json)
    } catch (err) {
      this._terminate(errorMessage(err))
    }
  }

  private _onRaw(raw: string): void {
    if (this._closed) return
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err: unknown) {
      dbg('wire unparseable frame', errorMessage(err))
      return
    }
    if (!parsed || typeof parsed !== 'object') return
    const msg = parsed as InboundFrame
    const isResponse = typeof msg.requestId === 'string' && 'ok' in msg
    const rawTag = typeof msg.method === 'string' ? msg.method : typeof msg.event === 'string' ? msg.event : isResponse ? 'response' : 'unknown'
    dbg('wire in', rawTag.slice(0, 64))
    if (msg.v !== 1) return
    if (typeof msg.requestId === 'string' && isResponse) {
      const p = this._pending.get(msg.requestId)
      if (p) {
        clearTimeout(p.timer)
        this._pending.delete(msg.requestId)
        this._dropQueuedRequest(msg.requestId)
        const response = normalizeInboundResponse(msg.requestId, msg)
        this._rememberResponse(msg.requestId, p.method, response)
        p.resolve(response)
      }
      return
    }
    if (typeof msg.requestId === 'string' && typeof msg.method === 'string') {
      const requestId = msg.requestId
      const method = msg.method
      // Keep attacker-controlled map keys and echoed response tokens small.
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId) || method.length === 0 || method.length > MAX_WIRE_TOKEN_LENGTH) return
      const completed = this._completed.get(requestId)
      if (completed) {
        if (completed.method !== method) {
          this._send(JSON.stringify({ v: 1, requestId, ok: false, error: 'CONFLICT', message: 'requestId already completed for another method' }))
        } else {
          this._send(JSON.stringify(completed.response))
        }
        return
      }
      if (this._inbound.has(requestId)) {
        this._send(JSON.stringify({ v: 1, requestId, ok: false, error: 'CONFLICT', message: 'requestId already active' }))
        return
      }
      if (this._inbound.size >= MAX_INBOUND_REQUESTS) {
        this._send(JSON.stringify({ v: 1, requestId, ok: false, error: 'LIMIT_EXCEEDED', message: 'too many inbound requests' }))
        return
      }
      const cancellation = { cancelled: false }
      this._inbound.set(requestId, cancellation)
      let responded = false
      const respond = (ok: boolean, body: { result?: unknown; error?: string; message?: string }) => {
        if (responded) return
        responded = true
        this._inbound.delete(requestId)
        let response: WireResponse = { v: 1, requestId, ok, ...body }
        let json = JSON.stringify(response)
        if (!wireJsonFits(json)) {
          response = { v: 1, requestId, ok: false, error: 'LIMIT_EXCEEDED', message: 'wire response too large' }
          json = JSON.stringify(response)
        }
        this._rememberResponse(requestId, method, response)
        this._send(json)
      }
      let completion: void | Promise<void>
      try {
        completion = this.onRequest({
          requestId,
          method,
          payload: msg.payload,
          cancelled: () => cancellation.cancelled || this._closed,
          respond
        })
      } catch (err) {
        respond(false, { error: 'INTERNAL', message: errorMessage(err) })
        return
      }

      // An inbound request is owned by WireChannel until the handler reaches a
      // terminal response. Async handler failures must therefore terminate the
      // request here instead of becoming detached rejected promises that keep
      // `_inbound` occupied forever. A handler that resolves without replying
      // is also a protocol error and is closed deterministically.
      void Promise.resolve(completion).then(
        () => {
          if (!responded) {
            respond(false, { error: 'INTERNAL', message: 'request handler completed without response' })
          }
        },
        (err) => respond(false, { error: 'INTERNAL', message: errorMessage(err) })
      )
      return
    }
    if (typeof msg.event === 'string') {
      if (msg.event.length === 0 || msg.event.length > MAX_WIRE_TOKEN_LENGTH) return
      this.onEvent({ event: msg.event, payload: msg.payload })
    }
  }

  /** request/response; resolves to a WireResponse (never throws RPC errors). */
  request(method: string, payload: unknown, timeoutMs = 60_000, requestId?: string): Promise<WireResponse> {
    return new Promise<WireResponse>((resolve) => {
      const id = requestId ?? b4a.toString(randomBytes(16), 'hex')
      if (this._closed || !this._channel) {
        resolve({ v: 1, requestId: id, ok: false, error: 'OFFLINE', message: 'channel closed' })
        return
      }
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || method.length === 0 || method.length > MAX_WIRE_TOKEN_LENGTH) {
        resolve({ v: 1, requestId: id, ok: false, error: 'INVALID_REQUEST', message: 'invalid wire request token' })
        return
      }
      if (this._pending.has(id)) {
        resolve({ v: 1, requestId: id, ok: false, error: 'CONFLICT', message: 'requestId already pending' })
        return
      }
      const completed = this._completed.get(id)
      if (completed) {
        resolve(completed.method === method ? { ...completed.response } : { v: 1, requestId: id, ok: false, error: 'CONFLICT', message: 'requestId already completed for another method' })
        return
      }
      if (this._pending.size >= MAX_PENDING_REQUESTS) {
        resolve({ v: 1, requestId: id, ok: false, error: 'LIMIT_EXCEEDED', message: 'too many pending wire requests' })
        return
      }
      const json = JSON.stringify({ v: 1, requestId: id, method, payload })
      if (!wireJsonFits(json)) {
        resolve({ v: 1, requestId: id, ok: false, error: 'LIMIT_EXCEEDED', message: 'wire request too large' })
        return
      }

      const timer = setTimeout(() => {
        if (this._pending.delete(id)) {
          this._dropQueuedRequest(id)
          resolve({ v: 1, requestId: id, ok: false, error: 'TIMEOUT', message: `${method} timed out` })
        }
      }, timeoutMs)
      this._pending.set(id, { resolve, timer, method })
      if (this._open) {
        this._send(json)
      } else if (!this._enqueue({ json, requestId: id })) {
        clearTimeout(timer)
        this._pending.delete(id)
        resolve({ v: 1, requestId: id, ok: false, error: 'OFFLINE', message: 'channel not open / pre-open queue full' })
      }
    })
  }

  notify(event: string, payload: unknown): void {
    if (this._closed) return
    if (event.length === 0 || event.length > MAX_WIRE_TOKEN_LENGTH) return
    const json = JSON.stringify({ v: 1, event, payload })
    if (!wireJsonFits(json)) {
      dbg('wire dropping oversized outbound event', this._protocol, event)
      return
    }
    if (this._open) this._send(json)
    else if (!this._enqueue({ json, requestId: null })) dbg('wire dropping pre-open event; queue full', this._protocol, event)
  }

  destroy(): void {
    if (this._closed) return
    this._terminate('destroyed')
    try {
      this._channel?.close()
    } catch {}
  }
}
