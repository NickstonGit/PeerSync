// M0 spike harness: framed IPC smoke against the built PSNCore exe.
// Usage: node scripts/spike-ipc-smoke.mjs [pathToExe]
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// On Windows Bare's inherited anonymous pipes can deadlock;
// the production shell uses overlapped named pipes. Use
// `python scripts/spike-headless-smoke.py` as the Windows 10k gate.
if (process.platform === 'win32') {
  console.log('SKIP win32: use python scripts/spike-headless-smoke.py (named pipes)')
  process.exit(0)
}

const exe = process.argv[2] ?? 'build/core/PSNCore.exe'

function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  const f = Buffer.allocUnsafe(4 + body.length)
  f.writeUInt32LE(body.length, 0)
  body.copy(f, 4)
  return f
}

function attachChild(child, messages, waiters) {
  child.stderr.on('data', (d) => process.stderr.write(`[core] ${d}`))
  let pending = Buffer.alloc(0)
  child.stdout.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk])
    for (;;) {
      if (pending.length < 4) return
      const len = pending.readUInt32LE(0)
      if (pending.length < 4 + len) return
      const msg = JSON.parse(pending.subarray(4, 4 + len).toString('utf8'))
      pending = pending.subarray(4 + len)
      messages.push(msg)
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].match(msg)) {
          waiters[i].resolve(msg)
          waiters.splice(i, 1)
        }
      }
    }
  })
}

function waitFor(messages, waiters, match, label, ms = 30000) {
  const existing = messages.find(match)
  if (existing) return Promise.resolve(existing)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for ' + label)), ms)
    waiters.push({
      match,
      resolve: (m) => {
        clearTimeout(timer)
        resolve(m)
      }
    })
  })
}

const fail = (m, child) => {
  console.error('FAIL: ' + m)
  try {
    child.kill()
  } catch {}
  process.exit(1)
}

// 1) hello without dataRoot and without --data= must fail (plan hello contract)
{
  const child = spawn(exe, ['--app-version=0.0.0', '--build-label=140926'], {
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const messages = []
  const waiters = []
  attachChild(child, messages, waiters)
  try {
    await waitFor(messages, waiters, (m) => m.event === 'core.starting', 'core.starting')
    child.stdin.write(
      frame({
        type: 'request',
        requestId: 'bad-hello',
        method: 'hello',
        payload: { shellProtocol: 1, identitySeedHex: '01'.repeat(32) }
      })
    )
    const badHello = await waitFor(
      messages,
      waiters,
      (m) => m.type === 'response' && m.requestId === 'bad-hello',
      'hello-without-dataRoot',
      15000
    )
    if (badHello.ok !== false) fail('hello without dataRoot should fail, got ' + JSON.stringify(badHello), child)
    console.log('ok hello without dataRoot rejected:', badHello.error?.code || badHello.error)
  } finally {
    child.kill()
    await once(child, 'exit').catch(() => {})
  }
}

const dataRoot = mkdtempSync(join(tmpdir(), 'as-ipc-smoke-'))
const child = spawn(exe, ['--app-version=0.0.0', '--build-label=140926', `--data=${dataRoot}`], {
  stdio: ['pipe', 'pipe', 'pipe']
})
const messages = []
const waiters = []
attachChild(child, messages, waiters)

try {
  await waitFor(messages, waiters, (m) => m.event === 'core.starting', 'core.starting')
  console.log('ok core.starting')

  child.stdin.write(
    frame({
      type: 'request',
      requestId: 'r1',
      method: 'hello',
      payload: {
        shellProtocol: 1,
        identitySeedHex: '01'.repeat(32),
        deviceName: 'smoke',
        deviceType: 'desktop',
        dataRoot
      }
    })
  )
  const helloAck = await waitFor(
    messages,
    waiters,
    (m) => m.type === 'response' && m.requestId === 'r1' && m.ok,
    'helloAck'
  )
  if (!/^[0-9a-f]{64}$/.test(helloAck.result.peerId ?? '')) fail('bad peerId ' + helloAck.result.peerId, child)
  console.log('ok helloAck peerId=' + helloAck.result.peerId.slice(0, 12) + '…')

  const bad = await (async () => {
    child.stdin.write(frame({ type: 'request', requestId: 'r2', method: 'nope', payload: {} }))
    return waitFor(messages, waiters, (m) => m.type === 'response' && m.requestId === 'r2', 'unknown-method', 5000)
  })()
  if (bad.ok !== false || bad.error?.code !== 'UNSUPPORTED') fail('unknown method reply ' + JSON.stringify(bad), child)
  console.log('ok UNSUPPORTED for unknown method')

  const N = 10000
  for (let i = 0; i < N; i++) {
    child.stdin.write(frame({ type: 'request', requestId: 'p' + i, method: 'ping', payload: { seq: i } }))
    if (i % 2000 === 0) await new Promise((r) => setImmediate(r))
  }
  const done = (async () => {
    let seen = 0
    while (seen < N) {
      await waitFor(messages, waiters, (m) => m.type === 'response' && m.requestId === 'p' + seen, 'ping ' + seen, 60000)
      seen++
    }
    return seen
  })()
  console.log('ok ping stress ' + (await done) + '/' + N)

  const ready = await Promise.race([
    waitFor(messages, waiters, (m) => m.event === 'core.swarmReady', 'swarmReady', 20000).then(() => 'booted'),
    new Promise((r) => setTimeout(() => r('timeout'), 20000)),
    waitFor(
      messages,
      waiters,
      (m) => m.event === 'core.warning' && m.payload.code === 'BOOTSTRAP_FAILED',
      'bootstrap warning'
    ).then(() => 'no-dht')
  ])
  child.stdin.write(frame({ type: 'request', requestId: 'r3', method: 'getStatus', payload: {} }))
  const status = await waitFor(messages, waiters, (m) => m.type === 'response' && m.requestId === 'r3', 'getStatus')
  console.log('ok getStatus', JSON.stringify(status.result), 'swarm-smoke=' + ready)

  child.stdin.write(frame({ type: 'request', requestId: 'r9', method: 'app.shutdown', payload: {} }))
  const [code] = await once(child, 'exit')
  console.log('ok core exited code=' + code)
  if (code !== 0) fail('nonzero exit ' + code, child)
  console.log('SPIKE IPC SMOKE: PASS')
} catch (err) {
  fail(String(err?.message ?? err), child)
} finally {
  try {
    rmSync(dataRoot, { recursive: true, force: true })
  } catch {}
}
