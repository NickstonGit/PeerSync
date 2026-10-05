import { describe, expect, it, vi } from 'vitest'
import {
  connectViaHyperswarmPrivateApi,
  hasCompatibleHyperswarmPrivateApi,
  installForceRelayPrivatePatch,
  isObservedRelayTransport,
  shouldInitiateRendezvous
} from './hyperswarm-private-adapter'

describe('hyperswarm private compatibility adapter', () => {
  it('chooses exactly one relay dialer in the upstream tie-break direction', () => {
    const low = new Uint8Array([1, 2])
    const high = new Uint8Array([1, 3])
    expect(shouldInitiateRendezvous(low, high, true)).toBe(false)
    expect(shouldInitiateRendezvous(high, low, true)).toBe(true)
    expect(shouldInitiateRendezvous(low, high, false)).toBe(true)
    expect(shouldInitiateRendezvous(high, low, false)).toBe(true)
    expect(shouldInitiateRendezvous(low, low, true)).toBe(false)
  })
  function fakeSwarm() {
    const enqueued: unknown[] = []
    const peer = {
      explicit: false,
      queued: false,
      attempts: 7,
      tried: true,
      forceRelaying: false,
      _updatePriority: () => true
    }
    return {
      peer,
      enqueued,
      swarm: {
        keyPair: {},
        dht: {
          remoteAddress: () => ({ host: '192.168.1.2', port: 42 }),
          connect: vi.fn((_key: Uint8Array, _options?: unknown) => ({ rawStream: null as { socket: unknown; remoteHost: string; remotePort: number } | null, once: vi.fn() }))
        },
        server: { holepunch: () => true, _shareLocalAddress: true },
        explicitPeers: new Set<unknown>(),
        _allConnections: { has: (_key: Uint8Array) => false },
        _enqueue: (p: unknown) => enqueued.push(p),
        _attemptClientConnections: () => {},
        _upsertPeer: (_publicKey: Uint8Array, _relayAddresses: unknown) => peer
      }
    }
  }

  it('fails closed on an unknown private API shape', () => {
    expect(hasCompatibleHyperswarmPrivateApi({})).toBe(false)
    expect(
      connectViaHyperswarmPrivateApi({}, new Uint8Array(32), [{ host: '127.0.0.1', port: 1 }])
    ).toBe(false)
    expect(installForceRelayPrivatePatch({})).toBe(false)
  })

  it('centralizes LAN peer enqueue mutations', () => {
    const { swarm, peer, enqueued } = fakeSwarm()
    expect(hasCompatibleHyperswarmPrivateApi(swarm)).toBe(true)
    expect(
      connectViaHyperswarmPrivateApi(swarm, new Uint8Array(32), [
        { host: '192.168.1.2', port: 49737 }
      ])
    ).toBe(true)
    expect(peer.explicit).toBe(true)
    expect(peer.attempts).toBe(0)
    expect(peer.tried).toBe(false)
    expect(enqueued).toEqual([peer])
  })

  it('reports no dial when the peer is already connected or in flight', () => {
    // `_allConnections` covers both live sessions and pending handshakes. A LAN
    // beacon repeats several times a second, so claiming a dial here would log a
    // fresh connection attempt forever and bury real diagnostics.
    const { swarm, peer, enqueued } = fakeSwarm()
    const publicKey = new Uint8Array(32)
    swarm._allConnections.has = (key: Uint8Array) => key === publicKey
    expect(
      connectViaHyperswarmPrivateApi(swarm, publicKey, [{ host: '192.168.1.2', port: 49737 }])
    ).toBe(false)
    // The peer is still promoted to explicit so a later retry is not throttled.
    expect(peer.explicit).toBe(true)
    expect(enqueued).toEqual([])
  })

  it('guards force-relay monkey patch in one place', () => {
    const { swarm, peer } = fakeSwarm()
    expect(installForceRelayPrivatePatch(swarm)).toBe(true)
    swarm._upsertPeer(new Uint8Array(32), null)
    expect(peer.forceRelaying).toBe(true)
    // idempotent: installing twice does not wrap twice or fail.
    expect(installForceRelayPrivatePatch(swarm)).toBe(true)
  })

  it('disables direct routes for application dials but preserves relay control dials', () => {
    const { swarm } = fakeSwarm()
    const connect = swarm.dht.connect
    expect(installForceRelayPrivatePatch(swarm)).toBe(true)
    expect(swarm.dht.remoteAddress()).toBeNull()
    expect(swarm.server.holepunch()).toBe(false)
    expect(swarm.server._shareLocalAddress).toBe(false)
    const key = new Uint8Array(32)
    swarm.dht.connect(key, { keyPair: swarm.keyPair })
    expect(connect.mock.calls[0][1]).toMatchObject({ localConnection: false, fastOpen: false })
    expect((connect.mock.calls[0][1] as { holepunch: () => boolean }).holepunch()).toBe(false)
    swarm.dht.connect(key)
    expect(connect.mock.calls[1][1]).toBeUndefined()
  })

  it('requires the observed relay UDP socket, host and port, and forgets closed controls', () => {
    const { swarm } = fakeSwarm()
    expect(installForceRelayPrivatePatch(swarm)).toBe(true)
    const control = swarm.dht.connect(new Uint8Array(32))
    const endpoint = { socket: {}, remoteHost: '127.0.0.1', remotePort: 1000 }
    control.rawStream = endpoint
    expect(isObservedRelayTransport(swarm, { rawStream: endpoint })).toBe(true)
    expect(isObservedRelayTransport(swarm, { rawStream: { ...endpoint, remotePort: 2000 } })).toBe(false)
    expect(isObservedRelayTransport(swarm, { rawStream: { ...endpoint, socket: {} } })).toBe(false)
    expect(isObservedRelayTransport(swarm, {})).toBe(false)
    const close = control.once.mock.calls[0][1] as () => void
    close()
    expect(isObservedRelayTransport(swarm, { rawStream: endpoint })).toBe(false)
  })
})
