// PSNCore entrypoint: framed JSON IPC on stdio with the
// Python shell. Thin transport only; all features live in PortableCore.

import 'bare-buffer'
import 'bare-crypto'
import 'bare-dns'
import 'bare-tcp'
import 'bare-tls'
import 'bare-zlib'
import process from 'bare-process'
import { encodeFrame, FrameDecoder } from './framing'
import { PortableCore } from './portable-core'
import { RequestAdmissionGate } from './request-admission'
import { parseReleaseRevision } from './update-version'
import { setDebugEnabled } from './log'
import { errorMessage } from './errors'
import { runIoWorkerChild } from './io-worker-child'
import { setIoWorkerTerminationFenceFailureHandler } from './io-worker-client'

const args = Bare.argv as string[]
if (args.includes('--peersync-io-worker')) {
  void runIoWorkerChild()
    .then(() => process.exit(0))
    .catch(() => process.exit(2))
} else {
if (argsHasDebugFlag()) setDebugEnabled(true)
function argsHasDebugFlag(): boolean {
  return args.includes('--debug')
}

function argValue(prefix: string): string | undefined {
  const flag = args.find((a: string) => a.startsWith(prefix))
  return flag?.slice(prefix.length)
}
const appVersion = argValue('--app-version=') ?? '0.0.0'
const buildLabel = argValue('--build-label=') ?? 'dev'
const releaseRevision = parseReleaseRevision(argValue('--release-revision='))

function log(...parts: unknown[]): void {
  try {
    process.stderr.write(parts.map((p) => String(p)).join(' ') + '\n')
  } catch {}
}

function send(payload: Record<string, unknown>): void {
  process.stdout.write(encodeFrame(payload))
}
function sendEvent(event: string, payload: unknown): void {
  send({ type: 'event', event, payload })
}
function sendResponse(requestId: unknown, ok: boolean, body: Record<string, unknown>): void {
  send({ type: 'response', requestId, ok, ...body })
}
function fail(requestId: unknown, code: string, message: string, details?: unknown): void {
  sendResponse(requestId, false, { error: { code, message, ...(details ? { details } : {}) } })
}

// A child whose hard-kill was not followed by an observed `exit` still owns
// potentially pending Windows filesystem I/O. Continuing this Core generation
// would permit recovery/retry against an unstable namespace. Exit immediately;
// the Python shell owns the enclosing KILL_ON_JOB_CLOSE Job Object and will
// retire the whole Core process tree before any replacement is published.
setIoWorkerTerminationFenceFailureHandler((error) => {
  try {
    process.stderr.write(`core: fatal I/O worker ownership fence lost: ${error.message}\n`)
  } catch {}
  process.exit(70)
})
/** PortableCore throws `ipcCode`-tagged errors; engine/path errors carry `code`. */
function ipcErrorCode(err: unknown): string {
  if (!err || typeof err !== 'object') return 'INTERNAL'
  const e = err as { ipcCode?: unknown; code?: unknown }
  return String(e.ipcCode ?? e.code ?? 'INTERNAL')
}

const core = new PortableCore((event, payload) => {
  try {
    sendEvent(event, payload)
  } catch (err) {
    log('core: emit failed', err)
  }
})
core.setVersion(appVersion)

let initialized = false
let exiting = false
const inFlightRequests = new Map<string, { cancelled: boolean }>()
// Core's own admission cap, independent of whatever the shell does. The shell
// already bounds its own unanswered-request map to 512; staying below that
// keeps the handler set, its cancellation tokens and the pending filesystem
// work behind them bounded even if a caller ignores the shell's limit.
const MAX_CONCURRENT_REQUESTS = 256
const requestAdmission = new RequestAdmissionGate(MAX_CONCURRENT_REQUESTS)
let shutdownPromise: Promise<void> | null = null

function waitForRequestHandlers(): Promise<void> {
  return requestAdmission.waitForDrain()
}

function cancelInFlightRequests(): void {
  for (const token of inFlightRequests.values()) token.cancelled = true
}

async function handle(msg: Record<string, unknown>): Promise<void> {
  const type = msg.type
  const requestId = msg.requestId
  if (type === 'shutdown') {
    void shutdown('ipc-shutdown')
    return
  }
  if (type === 'cancel') {
    const id = typeof requestId === 'string' ? requestId : ''
    const token = id ? inFlightRequests.get(id) : null
    if (token) token.cancelled = true
    // Do not acknowledge cancellation before the original handler has actually
    // unwound. The shell treats a final response as proof that Core can no
    // longer start side effects for this request; if that response never comes,
    // it tears Core down rather than risk a ghost fs.copy after UI timeout.
    return
  }
  if (type !== 'request') return
  const method = String(msg.method ?? '')
  const payload = msg.payload as Record<string, unknown>
  if (method === 'app.shutdown') {
    void shutdown('ipc-shutdown', requestId)
    return
  }
  if (exiting) {
    fail(requestId, 'OFFLINE', 'core shutting down')
    return
  }

  if (!requestAdmission.tryEnter()) {
    // Refuse rather than queue: a queued request has no handler to cancel and
    // its caller's timeout can expire while it silently waits for a slot.
    fail(requestId, 'OVERLOADED', 'too many concurrent requests')
    return
  }

  try {
    if (!initialized) {
      if (method !== 'hello') {
        fail(requestId, 'INVALID_REQUEST', 'hello required first')
        return
      }
      const dataRoot = String(
        payload?.dataRoot || argValue('--data=') || process.env.PEERSYNC_DATA || ''
      )
      const relayKey = payload?.customRelay && typeof payload.customRelay === 'object'
        ? payload.customRelay as { keyHex?: string; host?: string }
        : null
      const argvRelayKey = argValue('--relay-key=')
      const argvRelayHost = argValue('--relay-host=')
      const argvBootstrap = argValue('--dht-bootstrap=')
      const updateSource = payload?.updateSource && typeof payload.updateSource === 'object'
        ? payload.updateSource as { available?: unknown; path?: unknown; platform?: unknown; size?: unknown; sha256?: unknown; signature?: unknown }
        : null
      const updateTrust = payload?.updateTrust && typeof payload.updateTrust === 'object'
        ? payload.updateTrust as { publicKeyHex?: unknown; allowUnsignedDevelopment?: unknown }
        : null
      const result = await core.init({
        shellProtocol: Number(payload?.shellProtocol ?? 0),
        identitySeedHex: String(payload?.identitySeedHex ?? ''),
        deviceName: String(payload?.deviceName ?? 'PeerSync'),
        deviceType: String(payload?.deviceType ?? 'unknown'),
        dataRoot,
        relayConfPubkey: payload?.relayConfPubkey ? String(payload.relayConfPubkey) : null,
        forceRelay: payload?.forceRelay === true || args.includes('--force-relay'),
        customRelay: (relayKey?.keyHex && relayKey?.host)
          ? { keyHex: String(relayKey.keyHex), host: String(relayKey.host) }
          : (argvRelayKey && argvRelayHost ? { keyHex: argvRelayKey, host: argvRelayHost } : null),
        dhtBootstrap: Array.isArray(payload?.dhtBootstrap)
          ? (payload.dhtBootstrap as unknown[]).map(String)
          : (argvBootstrap ? argvBootstrap.split(',').map((s) => s.trim()).filter(Boolean) : null),
        updateSource: updateSource
          ? {
              available: updateSource.available === true,
              path: typeof updateSource.path === 'string' ? updateSource.path : null,
              platform: typeof updateSource.platform === 'string' ? updateSource.platform : 'win-x64',
              size: Number(updateSource.size ?? 0),
              sha256: typeof updateSource.sha256 === 'string' ? updateSource.sha256 : '',
              signature: typeof updateSource.signature === 'string' ? updateSource.signature : null
            }
          : null,
        updateTrust: updateTrust
          ? { publicKeyHex: typeof updateTrust.publicKeyHex === 'string' ? updateTrust.publicKeyHex : null, allowUnsignedDevelopment: updateTrust.allowUnsignedDevelopment === true }
          : null
      }, appVersion, buildLabel, releaseRevision)
      initialized = true
      if (exiting) {
        fail(requestId, 'CANCELLED', 'core shutting down')
        return
      }
      sendResponse(requestId, true, {
        result: {
          coreProtocol: 1,
          coreVersion: appVersion,
          buildLabel,
          releaseRevision,
          capabilities: result.capabilities,
          peerId: result.deviceId,
          deviceId: result.deviceId
        }
      })
      return
    }

    const requestKey = typeof requestId === 'string' ? requestId : String(requestId ?? '')
    const cancelToken = { cancelled: false }
    if (requestKey) inFlightRequests.set(requestKey, cancelToken)
    try {
      const result = await core.call(method, payload, cancelToken)
      // Once a handler returns successfully, that return value is authoritative.
      // A cancel/shutdown frame that raced with the final durable commit must not
      // rewrite an already-committed operation into a synthetic CANCELLED reply.
      // Cancellation that was observed before completion is surfaced by core.call.
      sendResponse(requestId, true, { result })
    } finally {
      if (requestKey && inFlightRequests.get(requestKey) === cancelToken) inFlightRequests.delete(requestKey)
    }
  } catch (err: unknown) {
    fail(requestId, ipcErrorCode(err), errorMessage(err).slice(0, 512))
  } finally {
    requestAdmission.leave()
  }
}

function shutdown(reason: string, acknowledgeRequestId?: unknown): Promise<void> {
  if (shutdownPromise) return shutdownPromise
  exiting = true
  cancelInFlightRequests()
  log(`core: shutdown (${reason})`)
  shutdownPromise = (async () => {
    const guard = setTimeout(() => {
      log('core: shutdown watchdog fired — forcing exit')
      process.exit(0)
    }, 3500)
    try {
      // The shutdown response is a lifecycle barrier, not merely an ACK that the
      // request was parsed. Admission is already closed and every active request
      // has observed cancellation before the shell is allowed to treat teardown
      // as graceful. This prevents a late fs.copy durable commit after ACK.
      await waitForRequestHandlers()
      if (acknowledgeRequestId !== undefined) {
        try {
          sendResponse(acknowledgeRequestId, true, { result: { ok: true } })
        } catch (err) {
          log('core: shutdown ACK failed', err)
        }
      }
      try {
        await Promise.race([core.shutdown(), sleep(1500)])
      } catch (err) {
        log('core: shutdown error', err)
      }
      try {
        await Promise.race([flushStdout(), sleep(200)])
      } catch {}
    } finally {
      clearTimeout(guard)
    }
    process.exit(0)
  })()
  return shutdownPromise
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(() => resolve(), ms))
}
function flushStdout(): Promise<void> {
  // streamx stdout drains through the loop; one macrotask tick is enough in practice
  return new Promise<void>((resolve) => setTimeout(() => resolve(), 50))
}

// ---- stdio streams: pipes auto-open in bare-stdio constructors; regular files
// need lazy open. fs streams (redirected stderr) have no `readyState`.
for (const [name, stream] of [
  ['stdin', process.stdin],
  ['stdout', process.stdout],
  ['stderr', process.stderr]
] as const) {
  const s = stream as unknown as { readyState?: string; open?: (cb?: (err: Error | null) => void) => void }
  if (typeof s.readyState !== 'string' && typeof s.open === 'function') {
    s.open((err: Error | null) => {
      if (err) log(`core: ${name} open failed: ${err.message}`)
    })
  }
}

const decoder = new FrameDecoder()
process.stdin.on('data', (chunk: Uint8Array) => {
  for (const frame of decoder.push(chunk)) {
    if (frame.error) {
      if (frame.error.startsWith('bad frame length')) {
        sendEvent('core.fatal', { code: 'IPC_FRAME', message: frame.error })
        void shutdown('ipc-bad-frame')
        return
      }
      sendEvent('core.warning', { code: 'IPC_JSON', message: frame.error })
      continue
    }
    const msg = frame.value as Record<string, unknown>
    if (!msg || typeof msg !== 'object') continue
    void handle(msg).catch((err) => {
      log('core: handler error', err)
    })
  }
})
process.stdin.on('end', () => void shutdown('stdin-eof'))
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void shutdown(sig))

sendEvent('core.starting', { coreVersion: appVersion, buildLabel, releaseRevision, pid: Bare.pid })
log(`core: portable entry started (${appVersion} ${buildLabel} r${releaseRevision}) pid ${Bare.pid}`)
}
