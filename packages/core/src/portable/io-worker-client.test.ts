import { describe, expect, it, vi } from 'vitest'
import { IsolatedIoWorker } from './io-worker-client'

type FakeChild = {
  pid: number
  killed: boolean
  connected: boolean
  on: (event: string, callback: (...args: unknown[]) => void) => FakeChild
  send: (message: unknown, handle: unknown, callback?: (err?: Error | null) => void) => boolean
  disconnect: () => void
  kill: (signal: string) => void
  emit: (event: string, ...args: unknown[]) => void
  sendCallbacks: Array<(err?: Error | null) => void>
}

function makeChild(): FakeChild {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const child: FakeChild = {
    pid: 1234,
    killed: false,
    connected: true,
    on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
      const entries = listeners.get(event) ?? []
      entries.push(callback)
      listeners.set(event, entries)
      return child
    }),
    send: vi.fn((_message: unknown, _handle: unknown, callback?: (err?: Error | null) => void) => {
      if (callback) child.sendCallbacks.push(callback)
      return false
    }),
    disconnect: vi.fn(),
    kill: vi.fn((signal: string) => {
      child.killed = true
      child.emit('exit', null, signal)
    }),
    emit: (event: string, ...args: unknown[]) => {
      for (const callback of listeners.get(event) ?? []) callback(...args)
    },
    sendCallbacks: []
  }
  return child
}

function makeWorker(child: FakeChild): IsolatedIoWorker {
  const worker = Object.create(IsolatedIoWorker.prototype) as IsolatedIoWorker
  Object.assign(worker, {
    child,
    pending: null,
    nextId: 1,
    closed: false,
    exited: false,
    exitPromise: Promise.resolve(),
    exitResolve: () => {},
    termination: null
  })
  const internals = worker as unknown as {
    onMessage: (message: unknown) => void
    onExit: () => void
  }
  child.on('message', (message: unknown) => internals.onMessage(message))
  child.on('exit', () => internals.onExit())
  return worker
}

describe('IsolatedIoWorker IPC backpressure', () => {
  it('does not terminate a worker when send reports backpressure', async () => {
    const child = makeChild()
    const worker = makeWorker(child)
    const request = worker.write(0, new Uint8Array(64 * 1024))

    expect(child.send).toHaveBeenCalledWith(
      expect.objectContaining({ op: 'write' }),
      undefined,
      expect.any(Function)
    )
    child.sendCallbacks[0](null)
    child.emit('message', { id: 1, type: 'result', ok: true, result: { ok: true } })

    await expect(request).resolves.toBeUndefined()
    expect(child.kill).not.toHaveBeenCalled()
    await worker.terminate()
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('terminates a worker when the send callback reports a real IPC error', async () => {
    const child = makeChild()
    const worker = makeWorker(child)
    const request = worker.write(0, new Uint8Array(64 * 1024))

    child.sendCallbacks[0](new Error('pipe closed'))

    await expect(request).rejects.toMatchObject({ code: 'IO_WORKER', message: 'pipe closed' })
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })
})
