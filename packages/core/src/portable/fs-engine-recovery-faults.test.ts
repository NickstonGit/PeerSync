import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FsEngine } from './fs-engine'
import { JournalStore, type JournalRow } from './journal'
import type { RootsManager } from './roots'
import type { PeerManager } from './peers'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('portable recovery fault isolation', () => {
  it('does not destroy a peer socket for an operation RPC timeout', async () => {
    const session = {
      peerId: 'a'.repeat(64),
      sessionId: 'session-1',
      socket: { destroy: vi.fn() },
      fs: {
        request: vi.fn(async () => ({ v: 1, requestId: 'req', ok: false, error: 'TIMEOUT', message: 'x-resume timed out' }))
      }
    }
    const engine = new FsEngine({
      getMyId: () => 'b'.repeat(64),
      roots: {} as RootsManager,
      journals: {} as JournalStore,
      peers: {} as PeerManager,
      emit: () => {}
    })
    const internals = engine as unknown as { _req: (value: unknown, method: string, payload: unknown, timeout: number) => Promise<unknown> }
    await expect(internals._req(session, 'x-resume', {}, 100)).rejects.toMatchObject({ code: 'TIMEOUT', scope: 'OPERATION' })
    expect(session.socket.destroy).not.toHaveBeenCalled()
    await engine.destroy()
  })

  it('starts source verification asynchronously and exposes heartbeat status', async () => {
    const row: JournalRow = {
      v: 1,
      operationId: 'op-async',
      descriptor: {
        operationId: 'op-async',
        source: { deviceId: 'a'.repeat(64), rootId: 'src', relativePath: 'source.bin' },
        destination: { deviceId: 'b'.repeat(64), rootId: 'dst', relativePath: 'target.bin' },
        sourceFingerprint: { size: 3, blake2b256: 'c'.repeat(64) },
        destFingerprint: null,
        size: 3,
        chunkSize: 1024,
        collision: 'overwrite',
        createdAtMs: 1
      },
      descriptorHash: 'd'.repeat(64),
      role: 'sender',
      peerId: 'a'.repeat(64),
      state: 'waiting-peer',
      files: [{ relativePath: 'source.bin', size: 3, chunkSize: 1024, chunkCount: 1, state: 'waiting-peer' }],
      createdAtMs: 1,
      updatedAtMs: 1
    }
    const rows = new Map([[row.operationId, row]])
    const journals = {
      get: (id: string) => rows.get(id) ?? null,
      recoveryState: () => ({ generation: 0, leaseId: null, attempts: 0, lastAttemptAtMs: null, nextAttemptAtMs: null, lastErrorCode: null, lastErrorScope: null, requiresUserAction: false, blocked: false }),
      update: async (id: string, mutate: (value: JournalRow) => void) => { const value = rows.get(id); if (value) mutate(value); return value ?? null },
      list: () => [...rows.values()],
      batchIdForOperation: () => null
    }
    const session = { peerId: 'a'.repeat(64), sessionId: 'session-async' }
    const engine = new FsEngine({
      getMyId: () => 'b'.repeat(64),
      roots: { get: () => ({ physicalPath: 'C:\\source' }), canPeer: () => true } as unknown as RootsManager,
      journals: journals as unknown as JournalStore,
      peers: { session: () => session } as unknown as PeerManager,
      emit: () => {}
    })
    const internals = engine as unknown as {
      _rootStatPath: () => Promise<{ type: string; size: number }>
      _rootStableHash: () => Promise<{ size: number; contentHash: string; mtimeMs: number }>
      _xresumePrepareInbound: (session: unknown, payload: unknown) => Promise<{ state: string }>
      _xresumeStatusInbound: (session: unknown, payload: unknown) => { state: string }
    }
    internals._rootStatPath = async () => ({ type: 'file', size: 3 })
    internals._rootStableHash = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { size: 3, contentHash: 'c'.repeat(64), mtimeMs: 1 }
    }
    const prepared = await internals._xresumePrepareInbound(session, { operationId: row.operationId, descriptorHash: row.descriptorHash, recoveryGeneration: 1 })
    expect(prepared.state).toBe('VERIFYING')
    expect(internals._xresumeStatusInbound(session, { operationId: row.operationId }).state).toBe('VERIFYING')
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(internals._xresumeStatusInbound(session, { operationId: row.operationId }).state).toBe('READY')
    await engine.destroy()
  })

  it('persists a finite recovery circuit breaker across journal reload', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'peersync-recovery-'))
    roots.push(root)
    const key = new Uint8Array(32).fill(9)
    const store = new JournalStore(root, key)
    await store.recover()
    const descriptor = {
      operationId: 'op-circuit',
      source: { deviceId: 'a'.repeat(64), rootId: 'src', relativePath: 'source.bin' },
      destination: { deviceId: 'b'.repeat(64), rootId: 'dst', relativePath: 'target.bin' },
      sourceFingerprint: { size: 1, blake2b256: 'c'.repeat(64) },
      destFingerprint: null,
      size: 1,
      chunkSize: 1024,
      collision: 'overwrite' as const,
      createdAtMs: 1
    }
    const row: JournalRow = {
      v: 1,
      operationId: 'op-circuit',
      descriptor,
      descriptorHash: 'd'.repeat(64),
      role: 'receiver',
      peerId: 'a'.repeat(64),
      state: 'waiting-peer',
      files: [{ relativePath: 'target.bin', size: 1, chunkSize: 1024, chunkCount: 1, state: 'waiting-peer' }],
      createdAtMs: 1,
      updatedAtMs: 1
    }
    await store.put(row, true)
    const first = await store.claimRecovery('op-circuit', 0)
    expect(first.allowed).toBe(true)
    expect((await store.claimRecovery('op-circuit', 4999)).allowed).toBe(false)
    expect((await store.claimRecovery('op-circuit', 5000)).allowed).toBe(true)
    expect((await store.claimRecovery('op-circuit', 35000)).allowed).toBe(true)
    const fourth = await store.claimRecovery('op-circuit', 155000)
    expect(fourth.allowed).toBe(true)
    expect(fourth.state.blocked).toBe(true)
    await store.shutdown()

    const reloaded = new JournalStore(root, key)
    await reloaded.recover()
    const state = reloaded.recoveryState('op-circuit')
    expect(state.attempts).toBe(4)
    expect(state.blocked).toBe(true)
    expect(state.requiresUserAction).toBe(true)
    await reloaded.resetRecovery('op-circuit')
    expect(reloaded.recoveryState('op-circuit').blocked).toBe(false)
    await reloaded.shutdown()
  })
})
