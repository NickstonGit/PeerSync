// M0 spike entrypoint for PSNCore.exe.
// Runs under the Bare runtime. stdin/stdout are reserved for framed IPC
// (uint32_le length + UTF-8 JSON, max 1 MiB). All diagnostics go to stderr.
// This spike proves: bare-build standalone EXE on win32-x64, hidden console,
// framing under load, Hyperswarm boot, graceful shutdown. fs.v1 comes later.

import process from 'bare-process'
import Hyperswarm from 'hyperswarm'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import { encodeFrame, FrameDecoder, MAX_FRAME } from './framing'
import { parseReleaseRevision } from './update-version'

void MAX_FRAME

const args = Bare.argv as string[]

function argValue(prefix: string): string | undefined {
  const flag = args.find((arg: string) => arg.startsWith(prefix))
  return flag?.slice(prefix.length)
}

const appVersion = argValue('--app-version=') ?? '0.0.0'
const buildLabel = argValue('--build-label=') ?? 'dev'

function log(...parts: unknown[]): void {
  try {
    process.stderr.write(parts.map((part) => String(part)).join(' ') + '\n')
  } catch {}
}

function send(payload: Record<string, unknown>): void {
  process.stdout.write(encodeFrame(payload))
}

function respond(requestId: unknown, ok: boolean, body: Record<string, unknown>): void {
  send({ type: 'response', requestId, ok, ...body })
}

function respondError(requestId: unknown, code: string, message: string): void {
  respond(requestId, false, { error: { code, message } })
}

function emit(event: string, payload: unknown): void {
  send({ type: 'event', event, payload })
}

let swarm: InstanceType<typeof Hyperswarm> | null = null
let swarmReady = false
let identityPubKey: string | null = null
let shuttingDown = false

function statusPayload(): Record<string, unknown> {
  return {
    coreVersion: appVersion,
    buildLabel,
    releaseRevision: parseReleaseRevision(argValue('--release-revision=')),
    swarm: swarmReady ? 'booted' : 'booting',
    peerId: identityPubKey
  }
}

function bootSwarm(): void {
  if (swarm) return
  swarm = new Hyperswarm({ keyPair: swarmKeyPair ?? undefined })
  swarm.on('connection', (socket, info) => {
    emit('peer.connection', { remotePublicKey: b4a.toString(info.publicKey, 'hex') })
    socket.destroy()
  })
  swarm.dht
    .ready()
    .then(
      () => {
        const address = typeof swarm?.dht.address === 'function' ? swarm.dht.address() : null
        swarmReady = true
        emit('core.swarmReady', { bootedAt: Date.now(), localPort: address?.port ?? null })
      },
      (err: Error) => {
        emit('core.warning', { code: 'BOOTSTRAP_FAILED', message: String(err?.message ?? err) })
      }
    )
}

let swarmKeyPair: { publicKey: Uint8Array; secretKey: Uint8Array } | null = null

function handleRequest(msg: Record<string, unknown>): void {
  const requestId = msg.requestId
  const method = msg.method
  const payload = (msg.payload ?? {}) as Record<string, unknown>
  if (typeof method !== 'string') {
    respondError(requestId, 'INVALID_REQUEST', 'missing method')
    return
  }
  switch (method) {
    case 'hello': {
      if (payload.shellProtocol !== 1) {
        respondError(
          requestId,
          'UNSUPPORTED',
          `shellProtocol ${String(payload.shellProtocol)} not supported`
        )
        return
      }
      const seedHex = payload.identitySeedHex
      if (typeof seedHex === 'string' && /^[0-9a-f]{64}$/i.test(seedHex)) {
        swarmKeyPair = crypto.keyPair(b4a.from(seedHex, 'hex'))
      } else {
        swarmKeyPair = crypto.keyPair()
      }
      identityPubKey = b4a.toString(swarmKeyPair.publicKey, 'hex')
      respond(requestId, true, {
        result: {
          coreProtocol: 1,
          coreVersion: appVersion,
          buildLabel,
          releaseRevision: parseReleaseRevision(argValue('--release-revision=')),
          capabilities: ['spike'],
          peerId: identityPubKey
        }
      })
      bootSwarm()
      return
    }
    case 'ping': {
      respond(requestId, true, { result: { pong: payload.seq ?? null, at: Date.now() } })
      return
    }
    case 'getStatus': {
      respond(requestId, true, { result: statusPayload() })
      return
    }
    case 'app.shutdown': {
      respond(requestId, true, { result: { stopping: true } })
      void shutdown('ipc-shutdown')
      return
    }
    default: {
      respondError(requestId, 'UNSUPPORTED', `unknown method ${method}`)
    }
  }
}

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  log(`core: shutdown (${reason})`)
  try {
    await swarm?.destroy()
  } catch (err) {
    log('core: swarm destroy failed', err)
  }
  process.exit(0)
}

// ---- framed stdin reader ----
// For pipe handles bare-stdio returns a bare-pipe Pipe built with a numeric
// fd, which opens the handle inside its constructor — do NOT call open() on
// it (that would pass the callback as fd and destroy the stream => EBUSY).
// The regular-file fallback (bare-fs streams, e.g. redirected stderr) is
// created with eagerOpen:false and must be opened explicitly.

for (const [name, stream] of [
  ['stdin', process.stdin],
  ['stdout', process.stdout],
  ['stderr', process.stderr]
] as const) {
  const s = stream as unknown as {
    readyState?: string
    open?: (cb?: (err: Error | null) => void) => void
    on?: (event: string, cb: (arg?: unknown) => void) => void
  }
  if (typeof s.readyState === 'string') {
    log(`core: ${name} is a bare-pipe (readyState=${s.readyState}), no manual open`)
  } else if (typeof s.open === 'function') {
    s.open((err: Error | null) => {
      log(`core: ${name} open ${err ? 'failed: ' + err.message : 'ok'}`)
    })
  } else {
    log(`core: ${name} has no open()`)
  }
  if (typeof s.on === 'function') {
    s.on('error', (err: unknown) => log(`core: ${name} stream error`, err))
  }
}

const decoder = new FrameDecoder()

function consume(chunk: Uint8Array): void {
  for (const frame of decoder.push(chunk)) {
    if (frame.error) {
      if (frame.error.startsWith('bad frame length')) {
        emit('core.fatal', { code: 'IPC_FRAME', message: frame.error })
        void shutdown('ipc-bad-frame')
        return
      }
      emit('core.warning', { code: 'IPC_JSON', message: frame.error })
      continue
    }
    const msg = frame.value
    if (msg && typeof msg === 'object') {
      if (msg.type === 'request') handleRequest(msg)
      else if (msg.type === 'shutdown') void shutdown('ipc-shutdown-event')
    }
  }
}

process.stdin.on('data', (chunk: Uint8Array) => consume(chunk))
process.stdin.on('end', () => void shutdown('stdin-eof'))

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => void shutdown(sig))
}

send({
  type: 'event',
  event: 'core.starting',
  payload: {
    coreVersion: appVersion,
    buildLabel,
    releaseRevision: parseReleaseRevision(argValue('--release-revision=')),
    pid: Bare.pid
  }
})
log(`core: spike entry started, version ${appVersion} (${buildLabel}), pid ${Bare.pid}`)
