import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FsEngine } from './fs-engine'
import type { JournalRow, JournalStore, OperationDescriptor } from './journal'
import type { RootsManager } from './roots'
import type { PeerManager } from './peers'

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function makeFixture(withTarget = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-recovery-'))
  tmpDirs.push(dir)
  const target = path.join(dir, 'target.txt')
  const backup = `${target}.peersync-prev-op-recovery`
  if (withTarget) fs.writeFileSync(target, 'new')
  fs.writeFileSync(backup, 'old')

  const descriptor: OperationDescriptor = {
    operationId: 'op-recovery',
    source: { deviceId: 'a'.repeat(64), rootId: 'src', relativePath: 'source.txt' },
    destination: { deviceId: 'c'.repeat(64), rootId: 'dst', relativePath: 'target.txt' },
    sourceFingerprint: { size: 3, blake2b256: 'd'.repeat(64) },
    destFingerprint: { size: 3, blake2b256: null },
    size: 3,
    chunkSize: 1024,
    collision: 'overwrite',
    createdAtMs: 1
  }
  const row: JournalRow = {
    v: 1,
    operationId: descriptor.operationId,
    descriptor,
    descriptorHash: 'e'.repeat(64),
    role: 'receiver',
    peerId: 'a'.repeat(64),
    state: 'stale',
    error: 'FINALIZE_RECOVERY_CONFLICT',
    initiatedLocally: true,
    peerPrepared: false,
    files: [{
      relativePath: 'target.txt',
      size: 3,
      chunkSize: 1024,
      chunkCount: 1,
      contentHash: 'd'.repeat(64),
      state: 'stale',
      savedTo: target,
      finalize: {
        phase: 'target-replaced',
        targetPath: target,
        backupPath: backup,
        resultAcked: false
      }
    }],
    createdAtMs: 1,
    updatedAtMs: 1
  }
  const rows = new Map<string, JournalRow>([[row.operationId, row]])
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
    remove: async (id) => { rows.delete(id) }
  }
  const engine = new FsEngine({
    getMyId: () => 'c'.repeat(64),
    roots: {} as RootsManager,
    journals: journals as JournalStore,
    peers: { session: () => null } as unknown as PeerManager,
    emit: () => {}
  })
  return { engine, rows, target, backup }
}

describe('explicit finalize conflict recovery', () => {
  it('keeps the current target and removes the old backup only by explicit choice', async () => {
    const { engine, rows, target, backup } = makeFixture()
    const result = await engine.resolveFinalizeConflict('op-recovery', 'keep-new')
    expect(result).toMatchObject({ ok: true, action: 'keep-new', pendingPeerCleanup: false })
    expect(fs.readFileSync(target, 'utf8')).toBe('new')
    expect(fs.existsSync(backup)).toBe(false)
    expect(rows.has('op-recovery')).toBe(false)
    await engine.destroy()
  })

  it('restores the backup while preserving a current target that appeared after the crash', async () => {
    const { engine, rows, target, backup } = makeFixture()
    const result = await engine.resolveFinalizeConflict('op-recovery', 'restore-backup')
    const preserved = String(result.preservedPath ?? '')
    expect(fs.readFileSync(target, 'utf8')).toBe('old')
    expect(fs.existsSync(backup)).toBe(false)
    expect(preserved).not.toBe('')
    expect(fs.readFileSync(preserved, 'utf8')).toBe('new')
    expect(rows.has('op-recovery')).toBe(false)
    await engine.destroy()
  })

  it('keeps both versions under deterministic recovery-safe sibling names', async () => {
    const { engine, rows, target, backup } = makeFixture()
    const result = await engine.resolveFinalizeConflict('op-recovery', 'save-both')
    const recovered = String(result.preservedPath ?? '')
    expect(fs.readFileSync(target, 'utf8')).toBe('new')
    expect(fs.existsSync(backup)).toBe(false)
    expect(recovered).toContain('.peersync-recovered-op-recovery')
    expect(fs.readFileSync(recovered, 'utf8')).toBe('old')
    expect(rows.has('op-recovery')).toBe(false)
    await engine.destroy()
  })

  it('never moves or deletes the only surviving backup when the target is missing', async () => {
    const { engine, rows, target, backup } = makeFixture(false)
    await expect(engine.resolveFinalizeConflict('op-recovery', 'save-both')).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(fs.existsSync(target)).toBe(false)
    expect(fs.readFileSync(backup, 'utf8')).toBe('old')
    expect(rows.get('op-recovery')?.error).toBe('FINALIZE_RECOVERY_CONFLICT')
    await engine.destroy()
  })
})
