import { describe, expect, it } from 'vitest'
import { FsEngine, coreHashOf, operationCore, parseDescriptor, type OperationDescriptorLike } from './fs-engine'
import type { JournalStore } from './journal'
import type { RootsManager } from './roots'
import type { PeerManager, PeerSession } from './peers'

function descriptor(): OperationDescriptorLike {
  return {
    operationId: 'op1',
    source: { deviceId: 'a'.repeat(64), rootId: 'src', relativePath: 'file.bin' },
    destination: { deviceId: 'b'.repeat(64), rootId: 'dst', relativePath: 'file.bin' },
    collision: 'overwrite',
    size: 123,
    chunkSize: 1024,
    sourceFingerprint: { size: 123, blake2b256: 'c'.repeat(64) },
    destFingerprint: null,
    createdAtMs: 42
  }
}

describe('portable canonical operation descriptor', () => {
  it('does not let non-protocol fingerprint hints change descriptor identity', () => {
    const clean = descriptor()
    const hinted = descriptor() as OperationDescriptorLike & {
      sourceFingerprint: NonNullable<OperationDescriptorLike['sourceFingerprint']> & { mtimeMs: number }
    }
    hinted.sourceFingerprint = { ...hinted.sourceFingerprint, mtimeMs: 1234.567 }

    expect(operationCore(hinted)).toBe(operationCore(clean))
    expect(coreHashOf(hinted)).toBe(coreHashOf(clean))
  })


  it('rejects empty file endpoints before any transfer path can be derived', () => {
    const emptySource = descriptor()
    emptySource.source = { ...emptySource.source, relativePath: '' }
    expect(() => parseDescriptor({ descriptor: emptySource })).toThrow(/source\.relativePath: empty/)

    const emptyDestination = descriptor()
    emptyDestination.destination = { ...emptyDestination.destination, relativePath: '' }
    expect(() => parseDescriptor({ descriptor: emptyDestination })).toThrow(/destination\.relativePath: empty/)
  })

  it('rejects a descriptor whose source fingerprint size is not the transfer size', () => {
    const wire = descriptor()
    wire.sourceFingerprint = { size: wire.size + 1, blake2b256: 'c'.repeat(64) }
    expect(() => parseDescriptor({ descriptor: wire })).toThrow(/sourceFingerprint must bind descriptor size/)
  })

  it('rejects x-open when the supplied content hash differs from the canonical descriptor fingerprint', async () => {
    const wire = descriptor()
    const descriptorHash = coreHashOf(wire)
    const engine = new FsEngine({
      getMyId: () => 'b'.repeat(64),
      roots: {} as RootsManager,
      journals: { get: () => null, list: () => [], wasRecentlyCompleted: () => false } as unknown as JournalStore,
      peers: {} as PeerManager,
      emit: () => {}
    })
    const internals = engine as unknown as {
      _xopen(session: Pick<PeerSession, 'peerId'>, p: Record<string, unknown>): Promise<unknown>
    }

    await expect(internals._xopen(
      { peerId: wire.source.deviceId },
      {
        descriptor: wire,
        descriptorHash,
        transferId: 'transfer-1',
        contentHash: 'd'.repeat(64)
      }
    )).rejects.toMatchObject({ code: 'CONFLICT' })

    await engine.destroy()
  })

  it('binds x-open descriptors to a remote source on the authenticated peer session', async () => {
    const myId = 'b'.repeat(64)
    const peerId = 'a'.repeat(64)
    const engine = new FsEngine({
      getMyId: () => myId,
      roots: {} as RootsManager,
      journals: { get: () => null, list: () => [], wasRecentlyCompleted: () => false } as unknown as JournalStore,
      peers: {} as PeerManager,
      emit: () => {}
    })
    const internals = engine as unknown as {
      _xopen(session: Pick<PeerSession, 'peerId'>, p: Record<string, unknown>): Promise<unknown>
    }

    const selfSource = descriptor()
    selfSource.source = { ...selfSource.source, deviceId: myId }
    selfSource.destination = { ...selfSource.destination, deviceId: myId }
    await expect(internals._xopen(
      { peerId },
      {
        descriptor: selfSource,
        descriptorHash: coreHashOf(selfSource),
        transferId: 'transfer-1',
        contentHash: 'c'.repeat(64)
      }
    )).rejects.toMatchObject({ code: 'NOT_ALLOWED' })

    const wrongPeer = descriptor()
    wrongPeer.source = { ...wrongPeer.source, deviceId: peerId }
    wrongPeer.destination = { ...wrongPeer.destination, deviceId: myId }
    await expect(internals._xopen(
      { peerId: 'e'.repeat(64) },
      {
        descriptor: wrongPeer,
        descriptorHash: coreHashOf(wrongPeer),
        transferId: 'transfer-2',
        contentHash: 'c'.repeat(64)
      }
    )).rejects.toMatchObject({ code: 'NOT_ALLOWED' })

    await engine.destroy()
  })

  it('binds x-init descriptors to a remote destination on the authenticated peer session', async () => {
    const myId = 'a'.repeat(64)
    const peerId = 'b'.repeat(64)
    const engine = new FsEngine({
      getMyId: () => myId,
      roots: {} as RootsManager,
      journals: { get: () => null, list: () => [] } as unknown as JournalStore,
      peers: {} as PeerManager,
      emit: () => {}
    })
    const internals = engine as unknown as {
      _xinit(session: Pick<PeerSession, 'peerId'>, p: Record<string, unknown>): Promise<unknown>
    }

    const selfDestination = descriptor()
    selfDestination.source = { ...selfDestination.source, deviceId: myId }
    selfDestination.destination = { ...selfDestination.destination, deviceId: myId }
    await expect(internals._xinit(
      { peerId },
      { descriptor: selfDestination, descriptorHash: coreHashOf(selfDestination) }
    )).rejects.toMatchObject({ code: 'NOT_ALLOWED' })

    const wrongPeer = descriptor()
    wrongPeer.source = { ...wrongPeer.source, deviceId: myId }
    wrongPeer.destination = { ...wrongPeer.destination, deviceId: peerId }
    await expect(internals._xinit(
      { peerId: 'e'.repeat(64) },
      { descriptor: wrongPeer, descriptorHash: coreHashOf(wrongPeer) }
    )).rejects.toMatchObject({ code: 'NOT_ALLOWED' })

    await engine.destroy()
  })


  it('drops unknown wire fields instead of persisting peer-controlled descriptor baggage', () => {
    const wire = {
      ...descriptor(),
      padding: 'x'.repeat(64 * 1024),
      futureBag: { nested: 'ignored' }
    }
    const parsed = parseDescriptor({ descriptor: wire }) as Record<string, unknown>

    expect(parsed.padding).toBeUndefined()
    expect(parsed.futureBag).toBeUndefined()
    expect(parsed.operationId).toBe('op1')
    expect(parsed.source).toEqual(descriptor().source)
    expect(parsed.destination).toEqual(descriptor().destination)
  })

  it('keeps the same identity after the wire parser drops a non-canonical mtime hint in both transfer directions', async () => {
    const wire = descriptor() as OperationDescriptorLike & {
      sourceFingerprint: NonNullable<OperationDescriptorLike['sourceFingerprint']> & { mtimeMs: number }
    }
    wire.sourceFingerprint = { ...wire.sourceFingerprint, mtimeMs: 1234.567 }
    const descriptorHash = coreHashOf(wire)
    const engine = new FsEngine({
      getMyId: () => 'f'.repeat(64),
      roots: {} as RootsManager,
      journals: { get: () => null, list: () => [] } as unknown as JournalStore,
      peers: {} as PeerManager,
      emit: () => {}
    })
    const internals = engine as unknown as {
      _xinit(session: Pick<PeerSession, 'peerId'>, p: Record<string, unknown>): Promise<unknown>
      _xopen(session: Pick<PeerSession, 'peerId'>, p: Record<string, unknown>): Promise<unknown>
    }
    const session = { peerId: 'e'.repeat(64) }

    // Identity validation happens before ownership/path access. Reaching
    // NOT_ALLOWED proves parseDescriptor() and the sender used the same hash.
    await expect(internals._xinit(session, { descriptor: wire, descriptorHash }))
      .rejects.toMatchObject({ code: 'NOT_ALLOWED' })
    await expect(internals._xopen(session, { descriptor: wire, descriptorHash }))
      .rejects.toMatchObject({ code: 'NOT_ALLOWED' })

    await engine.destroy()
  })

})
