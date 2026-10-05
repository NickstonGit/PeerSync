import { describe, expect, it } from 'vitest'
import { FsEngine } from './fs-engine'
import type { JournalStore } from './journal'
import type { RootsManager } from './roots'
import type { PeerManager } from './peers'

interface EngineInternals {
  _withServeLock<T>(operationId: string, fn: () => Promise<T>): Promise<T>
  _tryAcquirePeerTransfer(peerId: string): (() => void) | null
}

describe('portable per-operation serve serialization', () => {
  it('never runs two x-ready activation critical sections for one operation concurrently', async () => {
    const engine = new FsEngine({
      getMyId: () => 'a'.repeat(64),
      roots: {} as RootsManager,
      journals: { batchIdForOperation: () => null, pruneStale: async () => 0 } as unknown as JournalStore,
      peers: {} as PeerManager,
      emit: () => {}
    })
    const internal = engine as unknown as EngineInternals
    const order: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })

    const first = internal._withServeLock('op-1', async () => {
      order.push('first:start')
      await firstGate
      order.push('first:end')
    })
    const second = internal._withServeLock('op-1', async () => {
      order.push('second:start')
      order.push('second:end')
    })

    await Promise.resolve()
    expect(order).toEqual(['first:start'])
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])

    await engine.destroy()
  })
  it('rejects a third remote transfer instead of queueing an unbounded waiter', async () => {
    const engine = new FsEngine({
      getMyId: () => 'a'.repeat(64),
      roots: {} as RootsManager,
      journals: { batchIdForOperation: () => null, pruneStale: async () => 0 } as unknown as JournalStore,
      peers: {} as PeerManager,
      emit: () => {}
    })
    const internal = engine as unknown as EngineInternals
    const release1 = internal._tryAcquirePeerTransfer('b'.repeat(64))
    const release2 = internal._tryAcquirePeerTransfer('b'.repeat(64))
    expect(release1).not.toBeNull()
    expect(release2).not.toBeNull()
    expect(internal._tryAcquirePeerTransfer('b'.repeat(64))).toBeNull()

    release1?.()
    const release3 = internal._tryAcquirePeerTransfer('b'.repeat(64))
    expect(release3).not.toBeNull()
    release2?.()
    release3?.()
    await engine.destroy()
  })

})
