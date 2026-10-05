import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { statIdentity } from '@peersync/drive'
import { FsEngine } from './fs-engine'
import { statFile } from './pathguard'
import type { JournalRow, JournalStore, OperationDescriptor } from './journal'
import type { RootsManager } from './roots'
import type { PeerManager } from './peers'

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

interface EngineInternals {
  _recoverReceiverFinalize(row: JournalRow): Promise<void>
}

/** Identity string exactly as the commit path records it. */
async function identityOf(target: string): Promise<string> {
  const st = await statFile(target)
  if (!st) throw new Error(`cannot stat ${target}`)
  return statIdentity(st)
}

/**
 * Crash state: an exclusive copy created the final name, the journal recorded
 * the pre-copy phase, and the process died before the payload finished.
 */
async function makeInterruptedCopy(options: {
  phase: 'prepared' | 'backup-created'
  identityMatches: boolean
  withBackup: boolean
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-identity-recovery-'))
  tmpDirs.push(dir)

  const target = path.join(dir, 'target.txt')
  const part = path.join(dir, 'part.txt')
  // A short copy: the process died part-way through the payload.
  fs.writeFileSync(target, 'new-partial')
  fs.writeFileSync(part, 'new-partial-full-payload')

  const backup = `${target}.peersync-prev-op-identity`
  if (options.withBackup) fs.writeFileSync(backup, 'old')

  const descriptor: OperationDescriptor = {
    operationId: 'op-identity',
    source: { deviceId: 'a'.repeat(64), rootId: 'src', relativePath: 'source.txt' },
    destination: { deviceId: 'c'.repeat(64), rootId: 'dst', relativePath: 'target.txt' },
    sourceFingerprint: { size: 3, blake2b256: 'd'.repeat(64) },
    destFingerprint: { size: 3, blake2b256: null },
    size: 3,
    chunkSize: 1024,
    collision: 'overwrite',
    createdAtMs: 1
  }

  const realIdentity = await identityOf(target)
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
      partPath: part,
      state: 'stale',
      finalize: {
        phase: options.phase,
        targetPath: target,
        backupPath: options.withBackup ? backup : null,
        publishMode: 'copy-exclusive',
        destinationIdentity: options.identityMatches ? realIdentity : '999:999:0:0'
      }
    }],
    createdAtMs: 1,
    updatedAtMs: 1
  }

  const rows = new Map<string, JournalRow>([[row.operationId, row]])
  const journals = {
    get: (id: string) => rows.get(id) ?? null,
    batchIdForOperation: () => null,
    wasRecentlyCompleted: () => false,
    list: () => [...rows.values()],
    update: async (id: string, mutate: (r: JournalRow) => void) => {
      const value = rows.get(id)
      if (!value) return null
      mutate(value)
      return value
    },
    remove: async (id: string) => { rows.delete(id) }
  } as unknown as JournalStore

  const engine = new FsEngine({
    getMyId: () => 'c'.repeat(64),
    roots: {} as RootsManager,
    journals,
    peers: { session: () => null } as unknown as PeerManager,
    emit: () => {}
  })

  return { engine: engine as unknown as EngineInternals, rows, target, part, backup }
}

describe('object-identity finalize recovery', () => {
  it('resumes automatically when the recorded identity still names the target', async () => {
    const { engine, rows, target } = await makeInterruptedCopy({
      phase: 'backup-created',
      identityMatches: true,
      withBackup: false
    })
    await engine._recoverReceiverFinalize(rows.get('op-identity')!)

    const row = rows.get('op-identity')!
    expect(row.state).toBe('waiting-peer')
    expect(row.error).toBeNull()
    expect(row.files[0].finalize).toBeNull()
    // The interrupted copy is still ours; recovery preserves the evidence and
    // lets the next commit finish the publication.
    expect(fs.readFileSync(target, 'utf8')).toBe('new-partial')
    await (engine as unknown as FsEngine).destroy()
  })

  it('resumes from the prepared phase too', async () => {
    const { engine, rows } = await makeInterruptedCopy({
      phase: 'prepared',
      identityMatches: true,
      withBackup: false
    })
    await engine._recoverReceiverFinalize(rows.get('op-identity')!)
    expect(rows.get('op-identity')!.state).toBe('waiting-peer')
    await (engine as unknown as FsEngine).destroy()
  })

  it('parks when the identity does not match, because ownership is unprovable', async () => {
    const { engine, rows, target } = await makeInterruptedCopy({
      phase: 'backup-created',
      identityMatches: false,
      withBackup: false
    })
    await engine._recoverReceiverFinalize(rows.get('op-identity')!)

    const row = rows.get('op-identity')!
    expect(row.state).toBe('stale')
    expect(row.error).toBe('FINALIZE_RECOVERY_CONFLICT')
    // A foreign file must never be treated as ours.
    expect(fs.readFileSync(target, 'utf8')).toBe('new-partial')
    await (engine as unknown as FsEngine).destroy()
  })

  it('parks when no identity was journalled at all', async () => {
    const { engine, rows } = await makeInterruptedCopy({
      phase: 'backup-created',
      identityMatches: false,
      withBackup: false
    })
    delete rows.get('op-identity')!.files[0].finalize!.destinationIdentity
    await engine._recoverReceiverFinalize(rows.get('op-identity')!)

    expect(rows.get('op-identity')!.error).toBe('FINALIZE_RECOVERY_CONFLICT')
    await (engine as unknown as FsEngine).destroy()
  })

  it('keeps the bitmap only while the private partial still exists', async () => {
    const { engine, rows, part } = await makeInterruptedCopy({
      phase: 'backup-created',
      identityMatches: true,
      withBackup: false
    })
    const file = rows.get('op-identity')!.files[0]
    file.bitmapHex = 'ff'
    file.bytesDone = 3
    await engine._recoverReceiverFinalize(rows.get('op-identity')!)

    expect(fs.existsSync(part)).toBe(true)
    expect(rows.get('op-identity')!.files[0].bitmapHex).toBe('ff')
    await (engine as unknown as FsEngine).destroy()
  })
})
