import { describe, expect, it, vi } from 'vitest'
import { FsEngine } from './fs-engine'
import type { JournalRow, JournalStore, OperationDescriptor } from './journal'
import type { RootsManager } from './roots'
import type { PeerManager, PeerSession } from './peers'

/** Private engine surface exercised by these tests. */
interface EngineInternals {
  _receive: Map<string, { session: unknown; writer: unknown; done: Promise<string> }>
  _serving: Map<string, { session: unknown; done: Promise<string> }>
  _xstaleInbound(
    session: Pick<PeerSession, 'peerId'>,
    p: Record<string, unknown>
  ): Promise<{ ok: true }>
  _xcancelInbound(
    session: Pick<PeerSession, 'peerId'>,
    p: Record<string, unknown>
  ): Promise<{ ok: true; cancelAccepted?: true; terminalOwner?: 'commit' }>
  _xresult(
    session: Pick<PeerSession, 'peerId'>,
    p: Record<string, unknown>
  ): Promise<{ ok: true }>
  _dropReceiver(operationId: string, session?: unknown): void
  _operationIsCancelled(operationId: string, peerId?: string): boolean
}

function internals(engine: FsEngine): EngineInternals {
  return engine as unknown as EngineInternals
}

function makeRow(role: 'sender' | 'receiver' = 'receiver'): JournalRow {
  return {
    v: 1,
    operationId: 'op-1',
    // cancel paths never read the descriptor body
    descriptor: {} as OperationDescriptor,
    descriptorHash: 'a'.repeat(64),
    role,
    peerId: 'b'.repeat(64),
    state: 'active',
    files: [
      { relativePath: 'f', size: 0, chunkSize: 1, chunkCount: 0, state: 'active', partPath: null }
    ],
    createdAtMs: 1,
    updatedAtMs: 1
  }
}

function makeEngine(row = makeRow(), batchId: string | null = null) {
  const rows = new Map<string, JournalRow>([[row.operationId, row]])
  const journals: Pick<JournalStore, 'get' | 'list' | 'update' | 'remove' | 'batchIdForOperation' | 'wasRecentlyCompleted'> = {
    get: (id) => rows.get(id) ?? null,
    batchIdForOperation: (id) => batchId && id === row.operationId ? batchId : null,
    wasRecentlyCompleted: () => false,
    list: () => [...rows.values()],
    update: async (id, mutate) => {
      const value = rows.get(id)
      if (!value) return null
      mutate(value)
      return value
    },
    remove: async (id) => {
      rows.delete(id)
    }
  }
  const engine = new FsEngine({
    getMyId: () => 'c'.repeat(64),
    roots: {} as RootsManager,
    journals: journals as JournalStore,
    peers: { session: () => null } as unknown as PeerManager,
    emit: () => {}
  })
  return { engine, rows }
}

function rowOf(rows: Map<string, JournalRow>, id: string): JournalRow {
  const row = rows.get(id)
  if (!row) throw new Error(`row ${id} missing`)
  return row
}

describe('portable cancel lifecycle', () => {
  it('stops a live receiver before parking an offline cancel', async () => {
    const { engine, rows } = makeEngine(makeRow('receiver'))
    const session = { cancel: vi.fn() }
    const writer = { claimCancellation: vi.fn(() => 'cancel-owned'), cancel: vi.fn(async () => {}) }
    internals(engine)._receive.set('op-1', {
      session,
      writer,
      done: Promise.resolve('ignored')
    })

    const result = await engine.cancelOperation('op-1')

    expect(result).toEqual({ ok: true, pending: true })
    expect(session.cancel).toHaveBeenCalledOnce()
    expect(writer.cancel).toHaveBeenCalledOnce()
    expect(rowOf(rows, 'op-1').state).toBe('cancel-pending')
    expect(rowOf(rows, 'op-1').files[0].state).toBe('cancel-pending')
  })

  it('cancels every cancellable operation in a batch', async () => {
    const row = makeRow('sender')
    row.initiatedLocally = true
    row.peerPrepared = false
    const { engine, rows } = makeEngine(row, 'batch-1')
    await expect(engine.cancelBatch('batch-1', 'other')).resolves.toEqual({ ok: true, cancelled: 0, pending: 0, skipped: 0 })
    await expect(engine.cancelBatch('batch-1')).resolves.toEqual({ ok: true, cancelled: 1, pending: 0, skipped: 0 })
    expect(rows.has('op-1')).toBe(false)
  })

  it('rejects local receiver cancellation once commit owns the terminal outcome', async () => {
    const { engine, rows } = makeEngine(makeRow('receiver'))
    const session = { cancel: vi.fn() }
    const writer = {
      claimCancellation: vi.fn(() => 'commit-owned'),
      cancel: vi.fn(async () => {})
    }
    internals(engine)._receive.set('op-1', {
      session,
      writer,
      done: Promise.resolve('committed')
    })

    await expect(engine.cancelOperation('op-1')).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(rowOf(rows, 'op-1').state).toBe('active')
    expect(rowOf(rows, 'op-1').files[0].state).toBe('active')
    expect(session.cancel).not.toHaveBeenCalled()
    expect(writer.cancel).not.toHaveBeenCalled()
  })

  it('peer x-cancel reports commit ownership without creating a cancellation tombstone', async () => {
    const { engine, rows } = makeEngine(makeRow('receiver'))
    const peerId = 'b'.repeat(64)
    const writer = {
      claimCancellation: vi.fn(() => 'commit-owned'),
      cancel: vi.fn(async () => {})
    }
    internals(engine)._receive.set('op-1', {
      session: { cancel: vi.fn() },
      writer,
      done: Promise.resolve('committed')
    })

    await expect(internals(engine)._xcancelInbound(
      { peerId },
      { operationId: 'op-1' }
    )).resolves.toEqual({ ok: true, terminalOwner: 'commit' })

    expect(rowOf(rows, 'op-1').state).toBe('active')
    expect(internals(engine)._operationIsCancelled('op-1', peerId)).toBe(false)
  })

  it('stops and closes a live sender before parking an offline cancel', async () => {
    const { engine, rows } = makeEngine(makeRow('sender'))
    const session = { cancel: vi.fn(), close: vi.fn(async () => {}) }
    internals(engine)._serving.set('op-1', {
      session,
      done: Promise.resolve('ignored')
    })

    const result = await engine.cancelOperation('op-1')

    expect(result.pending).toBe(true)
    expect(session.cancel).toHaveBeenCalledOnce()
    expect(session.close).toHaveBeenCalledOnce()
    expect(rowOf(rows, 'op-1').state).toBe('cancel-pending')
  })

  it('remembers an early peer x-cancel so a delayed x-init/x-open cannot recreate the operation', async () => {
    const { engine, rows } = makeEngine()
    rows.clear()
    const peerId = 'b'.repeat(64)

    await expect(internals(engine)._xcancelInbound(
      { peerId },
      { operationId: 'op-race' }
    )).resolves.toEqual({ ok: true, cancelAccepted: true })

    expect(rows.has('op-race')).toBe(false)
    expect(internals(engine)._operationIsCancelled('op-race', peerId)).toBe(true)
    expect(internals(engine)._operationIsCancelled('op-race', 'd'.repeat(64))).toBe(false)
  })

  it('bounds peer-controlled stale error codes before persisting them', async () => {
    const row = makeRow('sender')
    row.descriptor = {
      operationId: row.operationId,
      source: { deviceId: 'c'.repeat(64), rootId: 'src', relativePath: 'f' },
      destination: { deviceId: 'b'.repeat(64), rootId: 'dst', relativePath: 'f' },
      collision: 'rename',
      size: 0,
      chunkSize: 65536,
      sourceFingerprint: { size: 0, blake2b256: 'a'.repeat(64) },
      destFingerprint: null,
      createdAtMs: 1
    }
    const { engine, rows } = makeEngine(row)

    await expect(internals(engine)._xstaleInbound(
      { peerId: 'b'.repeat(64) },
      { operationId: 'op-1', code: 'X'.repeat(100_000) }
    )).resolves.toEqual({ ok: true })

    expect(rowOf(rows, 'op-1').error).toBe('STALE_SOURCE')
  })

  it('peer x-cancel stops a live sender and removes its journal', async () => {
    const { engine, rows } = makeEngine(makeRow('sender'))
    const session = { cancel: vi.fn(), close: vi.fn(async () => {}) }
    internals(engine)._serving.set('op-1', {
      session,
      done: Promise.resolve('ignored')
    })

    const result = await internals(engine)._xcancelInbound(
      { peerId: 'b'.repeat(64) },
      { operationId: 'op-1' }
    )

    expect(result).toEqual({ ok: true, cancelAccepted: true })
    expect(session.cancel).toHaveBeenCalledOnce()
    expect(session.close).toHaveBeenCalledOnce()
    expect(rows.has('op-1')).toBe(false)
  })

  it('cancels a durable locally-staged job immediately when the peer journal was never prepared', async () => {
    const row = makeRow('sender')
    row.state = 'queued'
    row.files[0].state = 'queued'
    row.initiatedLocally = true
    row.peerPrepared = false
    const { engine, rows } = makeEngine(row)

    await expect(engine.cancelOperation('op-1')).resolves.toEqual({ ok: true, pending: false })
    expect(rows.has('op-1')).toBe(false)
  })

  it('does not turn an already-completed operation back into cancel-pending', async () => {
    const row = makeRow('receiver')
    row.state = 'done'
    row.files[0].state = 'done'
    const { engine, rows } = makeEngine(row)

    await expect(engine.cancelOperation('op-1')).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(rowOf(rows, 'op-1').state).toBe('done')
    expect(rowOf(rows, 'op-1').files[0].state).toBe('done')
  })

  it('identity-aware cleanup cannot delete a replacement resume session', () => {
    const { engine } = makeEngine()
    const oldSession = {}
    const newSession = {}
    internals(engine)._receive.set('op-1', {
      session: newSession,
      writer: {},
      done: Promise.resolve('')
    })

    internals(engine)._dropReceiver('op-1', oldSession)

    expect(internals(engine)._receive.get('op-1')?.session).toBe(newSession)
  })

  it('keeps live sender ownership until a negative x-result has stopped and closed it', async () => {
    const row = makeRow('sender')
    row.descriptor = {
      operationId: row.operationId,
      source: { deviceId: 'c'.repeat(64), rootId: 'src', relativePath: 'f' },
      destination: { deviceId: 'b'.repeat(64), rootId: 'dst', relativePath: 'f' },
      collision: 'rename',
      size: 0,
      chunkSize: 65536,
      sourceFingerprint: { size: 0, blake2b256: 'a'.repeat(64) },
      destFingerprint: null,
      createdAtMs: 1
    }
    const { engine, rows } = makeEngine(row)
    let releaseClose!: () => void
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve })
    const live = { cancel: vi.fn(), close: vi.fn(() => closeGate) }
    internals(engine)._serving.set('op-1', {
      session: live,
      done: Promise.resolve('ignored')
    })

    const result = internals(engine)._xresult(
      { peerId: 'b'.repeat(64) },
      { operationId: 'op-1', ok: false, digestOk: false, error: 'IO' }
    )

    await vi.waitFor(() => expect(live.close).toHaveBeenCalledOnce())
    expect(internals(engine)._serving.has('op-1')).toBe(true)
    expect(rowOf(rows, 'op-1').state).toBe('waiting-peer')
    releaseClose()

    await expect(result).resolves.toEqual({ ok: true })
    expect(internals(engine)._serving.has('op-1')).toBe(false)
    expect(live.cancel).toHaveBeenCalledOnce()
  })

  it('settles a sender from committed x-result even when the Drive ACK was lost', async () => {
    const row = makeRow('sender')
    row.descriptor = {
      operationId: row.operationId,
      source: { deviceId: 'c'.repeat(64), rootId: 'src', relativePath: 'f' },
      destination: { deviceId: 'b'.repeat(64), rootId: 'dst', relativePath: 'f' },
      collision: 'rename',
      size: 0,
      chunkSize: 65536,
      sourceFingerprint: { size: 0, blake2b256: 'a'.repeat(64) },
      destFingerprint: null,
      createdAtMs: 1
    }
    row.files[0].senderTransferComplete = false
    const { engine, rows } = makeEngine(row)

    await expect(internals(engine)._xresult(
      { peerId: 'b'.repeat(64) },
      { operationId: 'op-1', ok: true, digestOk: true, savedToBase: 'f' }
    )).resolves.toEqual({ ok: true })

    expect(rows.has('op-1')).toBe(false)
  })

  it('finishes a persisted pre-fix pending x-result without waiting for the peer to reconnect', async () => {
    const row = makeRow('sender')
    row.state = 'waiting-peer'
    row.descriptor = {
      operationId: row.operationId,
      source: { deviceId: 'c'.repeat(64), rootId: 'src', relativePath: 'f' },
      destination: { deviceId: 'b'.repeat(64), rootId: 'dst', relativePath: 'f' },
      collision: 'rename',
      size: 0,
      chunkSize: 65536,
      sourceFingerprint: { size: 0, blake2b256: 'a'.repeat(64) },
      destFingerprint: null,
      createdAtMs: 1
    }
    row.files[0].state = 'waiting-peer'
    row.files[0].senderTransferComplete = false
    row.files[0].pendingSuccessResult = { savedToBase: 'f' }
    const { engine, rows } = makeEngine(row)

    await expect(engine.resumeAll('b'.repeat(64))).resolves.toEqual({ started: ['op-1'], waiting: [] })
    expect(rows.has('op-1')).toBe(false)
  })

})
