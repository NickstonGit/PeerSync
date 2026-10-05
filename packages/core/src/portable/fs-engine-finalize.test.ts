import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FsEngine } from './fs-engine'
import type { JournalRow, JournalStore, OperationDescriptor } from './journal'
import type { RootsManager } from './roots'
import type { PeerManager } from './peers'

interface EngineInternals {
  _deliverPendingResult(operationId: string): Promise<boolean>
}

function internals(engine: FsEngine): EngineInternals {
  return engine as unknown as EngineInternals
}

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function descriptor(): OperationDescriptor {
  return {
    operationId: 'op-1',
    source: { deviceId: 'a'.repeat(64), rootId: 'src-root', relativePath: 'source.txt' },
    destination: { deviceId: 'c'.repeat(64), rootId: 'dst-root', relativePath: 'target.txt' },
    sourceFingerprint: { size: 3, blake2b256: null },
    destFingerprint: { size: 3, blake2b256: null },
    size: 3,
    chunkSize: 1024,
    collision: 'overwrite',
    createdAtMs: 1
  }
}

function makeEngine(row: JournalRow) {
  const rows = new Map<string, JournalRow>([[row.operationId, row]])
  const events: Array<{ event: string; payload: unknown }> = []
  const journals: Pick<JournalStore, 'get' | 'list' | 'update' | 'remove' | 'batchIdForOperation' | 'wasRecentlyCompleted'> = {
    get: (id) => rows.get(id) ?? null,
    batchIdForOperation: () => null,
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
    emit: (event, payload) => events.push({ event, payload })
  })
  return { engine, rows, events }
}

describe('overwrite finalize cleanup', () => {
  it('removes the transactional backup even before x-result can be ACKed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-finalize-'))
    tmpDirs.push(dir)
    const target = path.join(dir, 'target.txt')
    const backup = `${target}.peersync-prev-op-1`
    fs.writeFileSync(target, 'new')
    fs.writeFileSync(backup, 'old')

    const row: JournalRow = {
      v: 1,
      operationId: 'op-1',
      descriptor: descriptor(),
      descriptorHash: 'd'.repeat(64),
      role: 'receiver',
      peerId: 'a'.repeat(64),
      state: 'finalizing',
      files: [{
        relativePath: 'target.txt',
        size: 3,
        chunkSize: 1024,
        chunkCount: 1,
        contentHash: 'e'.repeat(64),
        savedTo: target,
        finalize: {
          phase: 'target-replaced',
          targetPath: target,
          backupPath: backup,
          resultAcked: false
        },
        state: 'done'
      }],
      createdAtMs: 1,
      updatedAtMs: 1
    }
    const { engine, rows } = makeEngine(row)

    // No peer session exists in makeEngine(), so x-result cannot be ACKed.
    // Local filesystem cleanup must nevertheless complete immediately.
    await expect(internals(engine)._deliverPendingResult('op-1')).resolves.toBe(false)
    expect(fs.existsSync(backup)).toBe(false)
    expect(rows.has('op-1')).toBe(true)
    expect(rows.get('op-1')?.files[0]?.finalize?.backupPath).toBeNull()
    expect(rows.get('op-1')?.files[0]?.finalize?.resultAcked).not.toBe(true)
    await engine.destroy()
  })

  it('removes an ACKed transactional backup even when the peer is offline', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-finalize-'))
    tmpDirs.push(dir)
    const target = path.join(dir, 'target.txt')
    const backup = `${target}.peersync-prev-op-1`
    fs.writeFileSync(target, 'new')
    fs.writeFileSync(backup, 'old')

    const row: JournalRow = {
      v: 1,
      operationId: 'op-1',
      descriptor: descriptor(),
      descriptorHash: 'd'.repeat(64),
      role: 'receiver',
      peerId: 'a'.repeat(64),
      state: 'finalizing',
      files: [{
        relativePath: 'target.txt',
        size: 3,
        chunkSize: 1024,
        chunkCount: 1,
        contentHash: 'e'.repeat(64),
        savedTo: target,
        finalize: {
          phase: 'target-replaced',
          targetPath: target,
          backupPath: backup,
          resultAcked: true
        },
        state: 'done'
      }],
      createdAtMs: 1,
      updatedAtMs: 1
    }
    const { engine, rows, events } = makeEngine(row)

    await expect(internals(engine)._deliverPendingResult('op-1')).resolves.toBe(true)
    expect(fs.existsSync(backup)).toBe(false)
    expect(rows.has('op-1')).toBe(false)
    expect(events.some(({ event, payload }) => event === 'operation.state' && (payload as { state?: string }).state === 'done')).toBe(true)
    await engine.destroy()
  })
})
