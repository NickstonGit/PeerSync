import { describe, expect, it, vi } from 'vitest'
import { FsEngine, type StoredSnapshot } from './fs-engine'
import type { JournalStore } from './journal'
import type { RootsManager } from './roots'
import type { PeerManager } from './peers'

interface SyncInternals {
  _snapshots: Map<string, StoredSnapshot>
  _previews: Map<string, {
    expiresAtMs: number
    source: { peerId: string | null; rootId: string; relativePath: string; deviceIdN: string }
    destination: { peerId: string | null; rootId: string; relativePath: string; deviceIdN: string }
    sourceScanId: string | null
    items: Array<{
      relativePath: string
      status: 'new' | 'changed' | 'skipped' | 'remote-only' | 'conflict' | 'error'
      sourceSize: number | null
      sourceHash: string | null
    }>
  }>
}

describe('portable sync manifest ordering', () => {
  it('finds a later mixed-case path using the same comparator as manifest sorting', async () => {
    const engine = new FsEngine({
      getMyId: () => 'a'.repeat(64),
      roots: {} as RootsManager,
      journals: { batchIdForOperation: () => null, pruneStale: async () => 0 } as unknown as JournalStore,
      peers: {} as PeerManager,
      emit: () => {}
    })
    const internal = engine as unknown as SyncInternals
    const now = Date.now()
    internal._snapshots.set('scan-1', {
      scanId: 'scan-1',
      relativePath: '',
      items: [
        { relativePath: 'a.txt', size: 1, mtimeMs: 1, contentHash: '1'.repeat(64) },
        { relativePath: 'B.txt', size: 2, mtimeMs: 2, contentHash: '2'.repeat(64) }
      ],
      fileCount: 2,
      totalBytes: 3,
      entriesDigest: '3'.repeat(64),
      createdAtMs: now,
      expiresAtMs: now + 60_000,
      hardExpiresAtMs: now + 120_000,
      kind: 'local',
      peerId: null,
      rootId: 'source'
    })
    internal._previews.set('preview-1', {
      expiresAtMs: now + 60_000,
      source: { peerId: null, rootId: 'source', relativePath: '', deviceIdN: 'a'.repeat(64) },
      destination: { peerId: 'b'.repeat(64), rootId: 'dest', relativePath: '', deviceIdN: 'b'.repeat(64) },
      sourceScanId: 'scan-1',
      items: [
        { relativePath: 'B.txt', status: 'new', sourceSize: 2, sourceHash: '2'.repeat(64) }
      ]
    })
    const copy = vi.spyOn(engine, 'copy').mockResolvedValue({ batchId: 'batch-1', acceptedCount: 1, operationIds: [] })

    await expect(engine.syncStart('preview-1')).resolves.toMatchObject({ acceptedCount: 1 })
    expect(copy).toHaveBeenCalledOnce()
    expect(copy.mock.calls[0][0].items[0].source.relativePath).toBe('B.txt')
    expect(copy.mock.calls[0][0].items[0].destinationRelativePath).toBe('B.txt')

    await engine.destroy()
  })

  it('treats case-only path differences as the same Windows destination entry', async () => {
    const engine = new FsEngine({
      getMyId: () => 'a'.repeat(64),
      roots: {} as RootsManager,
      journals: { batchIdForOperation: () => null, pruneStale: async () => 0 } as unknown as JournalStore,
      peers: {} as PeerManager,
      emit: () => {}
    })
    const now = Date.now()
    const sourceSnapshot: StoredSnapshot = {
      scanId: 'source-scan',
      relativePath: '',
      items: [{ relativePath: 'foo.txt', size: 7, mtimeMs: 1, contentHash: '4'.repeat(64) }],
      fileCount: 1,
      totalBytes: 7,
      entriesDigest: '5'.repeat(64),
      createdAtMs: now,
      expiresAtMs: now + 60_000,
      hardExpiresAtMs: now + 120_000,
      kind: 'local',
      peerId: null,
      rootId: 'source'
    }
    const destinationSnapshot: StoredSnapshot = {
      scanId: 'destination-scan',
      relativePath: '',
      items: [{ relativePath: 'Foo.txt', size: 7, mtimeMs: 2, contentHash: '4'.repeat(64) }],
      fileCount: 1,
      totalBytes: 7,
      entriesDigest: '6'.repeat(64),
      createdAtMs: now,
      expiresAtMs: now + 60_000,
      hardExpiresAtMs: now + 120_000,
      kind: 'remote',
      peerId: 'b'.repeat(64),
      rootId: 'dest'
    }
    vi.spyOn(engine, 'manifestStart').mockImplementation(async (ref) =>
      ref.rootId === 'source' ? sourceSnapshot : destinationSnapshot
    )

    const preview = await engine.syncPreview(
      { peerId: null, rootId: 'source', relativePath: '' },
      { peerId: 'b'.repeat(64), rootId: 'dest', relativePath: '' }
    )

    expect(preview.totals).toMatchObject({ new: 0, changed: 0, skipped: 1, 'remote-only': 0 })
    engine.syncCancel(preview.previewId)
    await engine.destroy()
  })

  it('rejects a stale destination manifest instead of treating the destination as empty', async () => {
    const engine = new FsEngine({
      getMyId: () => 'a'.repeat(64),
      roots: {} as RootsManager,
      journals: { batchIdForOperation: () => null, pruneStale: async () => 0 } as unknown as JournalStore,
      peers: {} as PeerManager,
      emit: () => {}
    })
    const now = Date.now()
    const sourceSnapshot: StoredSnapshot = {
      scanId: 'source-stable',
      relativePath: '',
      items: [{ relativePath: 'a.txt', size: 7, mtimeMs: 1, contentHash: '4'.repeat(64) }],
      fileCount: 1,
      totalBytes: 7,
      entriesDigest: '5'.repeat(64),
      createdAtMs: now,
      expiresAtMs: now + 60_000,
      hardExpiresAtMs: now + 120_000,
      kind: 'local',
      peerId: null,
      rootId: 'source'
    }
    vi.spyOn(engine, 'manifestStart').mockImplementation(async (ref) => {
      if (ref.rootId === 'source') return sourceSnapshot
      throw Object.assign(new Error('destination changed during scan'), { code: 'STALE_SCAN' })
    })

    await expect(engine.syncPreview(
      { peerId: null, rootId: 'source', relativePath: '' },
      { peerId: 'b'.repeat(64), rootId: 'dest', relativePath: '' }
    )).rejects.toMatchObject({ code: 'STALE_SCAN' })

    await engine.destroy()
  })

})
