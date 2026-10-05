import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { JournalStore, type JournalRow, type OperationDescriptor } from './journal'

type JournalInput = Omit<JournalRow, 'v' | 'createdAtMs' | 'updatedAtMs'>

const roots: string[] = []
const key = new Uint8Array(32).fill(7)

function row(operationId: string): JournalInput {
  const descriptor: OperationDescriptor = {
    operationId,
    source: { deviceId: 'a'.repeat(64), rootId: 'src', relativePath: `${operationId}.bin` },
    destination: { deviceId: 'b'.repeat(64), rootId: 'dst', relativePath: `${operationId}.bin` },
    sourceFingerprint: { size: 1, blake2b256: 'c'.repeat(64) },
    destFingerprint: null,
    size: 1,
    chunkSize: 1024,
    collision: 'overwrite',
    createdAtMs: 1
  }
  return {
    operationId,
    descriptor,
    descriptorHash: 'd'.repeat(64),
    role: 'sender',
    peerId: 'b'.repeat(64),
    state: 'queued',
    files: [{
      relativePath: `${operationId}.bin`,
      size: 1,
      chunkSize: 1024,
      chunkCount: 1,
      state: 'queued'
    }],
    initiatedLocally: true,
    peerPrepared: false
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'as-journal-batch-'))
  roots.push(root)
  return root
}

describe('JournalStore durable batch acceptance', () => {
  it('recovers unfinished members but never resurrects a completed member', async () => {
    const root = await tempRoot()
    const first = new JournalStore(root, key)
    await first.recover()
    await first.putBatch('batch1', [row('op1'), row('op2')])

    // Completing one operation appends to one durable per-batch completion log
    // while the shared acceptance file remains the source of truth for the
    // unfinished sibling.
    await first.remove('op1')
    expect(first.batchStatus('batch1')).toMatchObject({ total: 2, completed: 1, remaining: 1, done: false })
    const midFiles = await fs.readdir(path.join(root, 'journals'))
    expect(midFiles.filter((name) => name.endsWith('.done'))).toEqual(['batch-batch1.done'])
    expect(midFiles).not.toContain('op1.json')

    const second = new JournalStore(root, key)
    const recovered = await second.recover()
    expect(recovered.map((r) => r.operationId)).toEqual(['op2'])
    expect(second.get('op1')).toBeNull()
    expect(second.get('op2')?.state).toBe('queued')

    await second.remove('op2')
    const files = await fs.readdir(path.join(root, 'journals'))
    // Acceptance/checkpoint files are compacted, while the one append-only
    // completion log stays briefly as replay suppression evidence.
    expect(files.filter((name) => name.endsWith('.batch') || name.endsWith('.json'))).toEqual([])
    expect(files.filter((name) => name.endsWith('.done'))).toEqual(['batch-batch1.done'])
    expect(second.batchStatus('batch1')).toMatchObject({ total: 2, completed: 2, remaining: 0, done: true })
    expect(second.wasRecentlyCompleted('op1')).toBe(true)
    expect(second.wasRecentlyCompleted('op2')).toBe(true)
    await expect(second.put(row('op1'))).rejects.toThrow(/completed/)

    const third = new JournalStore(root, key)
    await third.recover()
    expect(third.get('op1')).toBeNull()
    expect(third.wasRecentlyCompleted('op1')).toBe(true)
  })

  it('keeps newer per-operation state over the original batch row after restart', async () => {
    const root = await tempRoot()
    const first = new JournalStore(root, key)
    await first.recover()
    await first.putBatch('batch2', [row('op3')])
    await first.update('op3', (value) => {
      value.state = 'waiting-peer'
      value.files[0].state = 'waiting-peer'
    }, true)

    const second = new JournalStore(root, key)
    await second.recover()
    expect(second.get('op3')?.state).toBe('waiting-peer')
  })

  it('never exposes or recovers a batch cancelled during acceptance', async () => {
    const root = await tempRoot()
    const store = new JournalStore(root, key)
    await store.recover()
    let checks = 0
    await expect(store.putBatch('batch-cancel', [row('op-c1'), row('op-c2')], () => ++checks >= 3))
      .rejects.toMatchObject({ code: 'CANCELLED' })
    expect(store.get('op-c1')).toBeNull()
    expect(store.get('op-c2')).toBeNull()

    const recovered = await new JournalStore(root, key).recover()
    expect(recovered).toEqual([])
  })

  it('atomically quarantines an accepted but not-yet-launched batch', async () => {
    const root = await tempRoot()
    const store = new JournalStore(root, key)
    await store.recover()
    await store.putBatch('batch-abort', [row('op-a1'), row('op-a2')])

    await store.abortAcceptedBatch('batch-abort', ['op-a1', 'op-a2'])
    expect(store.get('op-a1')).toBeNull()
    expect(store.get('op-a2')).toBeNull()

    const recovered = await new JournalStore(root, key).recover()
    expect(recovered).toEqual([])
    const names = await fs.readdir(path.join(root, 'journals'))
    expect(names.filter((name: string) => name.endsWith('.batch') || name.endsWith('.batch.cancel'))).toEqual([])
  })

  it('group-commits concurrent batch completions without resurrecting rows', async () => {
    const root = await tempRoot()
    const first = new JournalStore(root, key)
    await first.recover()
    const rows = Array.from({ length: 32 }, (_, index) => row(`op-g${index}`))
    await first.putBatch('batch-group', rows)

    await Promise.all(rows.slice(0, 31).map((value) => first.remove(value.operationId)))
    expect(first.batchStatus('batch-group')).toMatchObject({ total: 32, completed: 31, remaining: 1, done: false })

    const recoveredStore = new JournalStore(root, key)
    const recovered = await recoveredStore.recover()
    expect(recovered.map((value) => value.operationId)).toEqual(['op-g31'])

    await recoveredStore.remove('op-g31')
    expect(recoveredStore.batchStatus('batch-group')).toMatchObject({ total: 32, completed: 32, remaining: 0, done: true })
    const names = await fs.readdir(path.join(root, 'journals'))
    expect(names.filter((name) => name.endsWith('.batch') || name.endsWith('.json'))).toEqual([])
    expect(names.filter((name) => name.endsWith('.done'))).toEqual(['batch-batch-group.done'])
  })

  it('expires finished batch tombstones during maintenance even without status lookups', async () => {
    const root = await tempRoot()
    const store = new JournalStore(root, key)
    await store.recover()
    await store.putBatch('batch-expire', [row('op-e1')])
    await store.remove('op-e1')

    const donePath = path.join(root, 'journals', 'batch-batch-expire.done')
    expect((await fs.readdir(path.join(root, 'journals')))).toContain('batch-batch-expire.done')
    await store.pruneStale(Date.now() + 11 * 60 * 1000)
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect((await fs.readdir(path.join(root, 'journals')))).not.toContain('batch-batch-expire.done')
    await expect(fs.stat(donePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not refresh an expired finished-batch TTL across Core restart', async () => {
    const root = await tempRoot()
    const first = new JournalStore(root, key)
    await first.recover()
    await first.putBatch('batch-old-done', [row('op-old')])
    await first.remove('op-old')

    const donePath = path.join(root, 'journals', 'batch-batch-old-done.done')
    const old = new Date(Date.now() - 11 * 60 * 1000)
    await fs.utimes(donePath, old, old)

    const second = new JournalStore(root, key)
    await second.recover()
    expect(second.wasRecentlyCompleted('op-old')).toBe(false)
    expect((await fs.readdir(path.join(root, 'journals')))).not.toContain('batch-batch-old-done.done')
  })

  it('removes abandoned atomic-write temp files at startup', async () => {
    const root = await tempRoot()
    const dir = path.join(root, 'journals')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'op-temp.json.io-worker-tmp'), 'x')
    await fs.writeFile(path.join(dir, 'batch-temp.batch.tmp-dead-1'), 'x')

    const store = new JournalStore(root, key)
    await store.recover()
    const names = await fs.readdir(dir)
    expect(names).not.toContain('op-temp.json.io-worker-tmp')
    expect(names).not.toContain('batch-temp.batch.tmp-dead-1')
  })

  it('finishes durable terminal cleanup after a crash between done persistence and remove', async () => {
    const root = await tempRoot()
    const first = new JournalStore(root, key)
    await first.recover()
    await first.putBatch('batch-terminal-recovery', [row('op-terminal')])
    await first.update('op-terminal', (current) => {
      current.state = 'done'
      current.files[0].state = 'done'
      current.files[0].bytesDone = current.files[0].size
    }, true)

    const second = new JournalStore(root, key)
    await second.recover()

    expect(second.get('op-terminal')).toBeNull()
    expect(second.wasRecentlyCompleted('op-terminal')).toBe(true)
    expect(second.batchStatus('batch-terminal-recovery')).toMatchObject({ total: 1, completed: 1, remaining: 0, done: true })
    const names = await fs.readdir(path.join(root, 'journals'))
    expect(names).not.toContain('op-terminal.json')
    expect(names).not.toContain('batch-batch-terminal-recovery.batch')
    expect(names).toContain('batch-batch-terminal-recovery.done')
  })

})

describe('JournalStore per-operation flushing', () => {
  it('an immediate update does not wait for an unrelated dirty operation', async () => {
    const root = await tempRoot()
    const store = new JournalStore(root, key)
    await store.recover()

    let releaseOther!: () => void
    const otherGate = new Promise<void>((resolve) => { releaseOther = resolve })
    const calls: string[] = []
    const internals = store as unknown as {
      _dirty: Set<string>
      _queueRowFlush: (operationId: string) => Promise<void>
    }
    internals._queueRowFlush = async (operationId: string) => {
      calls.push(operationId)
      if (operationId === 'op-other') await otherGate
      internals._dirty.delete(operationId)
    }

    await store.put(row('op-fast'))
    await store.put(row('op-other'))
    const result = await Promise.race([
      store.update('op-fast', (value) => { value.state = 'active' }, true).then(() => 'done'),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100))
    ])

    expect(result).toBe('done')
    expect(calls).toEqual(['op-fast'])

    releaseOther()
    await store.flush()
  })
})
