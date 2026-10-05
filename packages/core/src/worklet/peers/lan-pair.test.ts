import { describe, expect, it } from 'vitest'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import {
  collectDhtListenPorts,
  connectLanSwarmPeer,
  decodeLanPairPacket,
  encodeLanPairPacket,
  isUnicastIPv4,
  lanBroadcastTargets,
  lanUnicastSweep,
  LAN_PAIR_GROUP,
  LAN_PAIR_PORT,
  LAN_RENDEZVOUS_PORT,
  rotatingBatch,
  subnetBroadcast24
} from './lan-pair'

describe('lan pair packet', () => {
  it('round-trips topic, swarm key and both DHT ports', () => {
    const topic = crypto.randomBytes(32)
    const publicKey = crypto.keyPair().publicKey
    const encoded = encodeLanPairPacket(topic, publicKey, [49737, 51200])
    expect(encoded).not.toBeNull()
    const decoded = decodeLanPairPacket(encoded!)
    expect(decoded).not.toBeNull()
    expect(b4a.equals(decoded!.topic, topic)).toBe(true)
    expect(b4a.equals(decoded!.publicKey, publicKey)).toBe(true)
    expect(decoded!.dhtPorts).toEqual([49737, 51200])
  })

  it('still reads version-1 packets with a single port', () => {
    const topic = crypto.randomBytes(32)
    const publicKey = crypto.keyPair().publicKey
    const v1 = b4a.alloc(71)
    v1.set(b4a.from('AS1P'), 0)
    v1[4] = 1
    v1.set(topic, 5)
    v1.set(publicKey, 37)
    v1[69] = 64916 >> 8
    v1[70] = 64916 & 0xff
    expect(decodeLanPairPacket(v1)?.dhtPorts).toEqual([64916])
  })

  it('copies fields out of the receive buffer', () => {
    const topic = crypto.randomBytes(32)
    const publicKey = crypto.keyPair().publicKey
    const encoded = encodeLanPairPacket(topic, publicKey, 12345)!
    const decoded = decodeLanPairPacket(encoded)!
    encoded[10] = (encoded[10] + 1) & 0xff
    encoded[40] = (encoded[40] + 1) & 0xff
    expect(b4a.equals(decoded.topic, topic)).toBe(true)
    expect(b4a.equals(decoded.publicKey, publicKey)).toBe(true)
    expect(decoded.dhtPorts).toEqual([12345])
  })

  it('rejects truncated, foreign or zero-port packets', () => {
    const topic = crypto.randomBytes(32)
    const publicKey = crypto.keyPair().publicKey
    expect(decodeLanPairPacket(b4a.alloc(10))).toBeNull()
    expect(encodeLanPairPacket(topic, publicKey, 0)).toBeNull()
    const badMagic = encodeLanPairPacket(topic, publicKey, 1)!
    badMagic[0] = 0
    expect(decodeLanPairPacket(badMagic)).toBeNull()
  })
})

describe('lan destinations', () => {
  it('keeps loopback, limited broadcast and multicast', () => {
    const targets = lanBroadcastTargets([])
    expect(targets).toContain('127.0.0.1')
    expect(targets).toContain('255.255.255.255')
    expect(targets).toContain(LAN_PAIR_GROUP)
  })

  it('adds a /24 directed broadcast for LAN IPv4', () => {
    const targets = lanBroadcastTargets([
      { host: '192.168.1.20', family: 4, internal: false },
      { host: '127.0.0.1', family: 4, internal: true }
    ])
    expect(targets).toContain('192.168.1.255')
    expect(subnetBroadcast24('10.0.0.8')).toBe('10.0.0.255')
  })

  it('sweeps the local /24 except the sender', () => {
    const sweep = lanUnicastSweep([{ host: '192.168.1.20', family: 4, internal: false }])
    expect(sweep).toContain('192.168.1.1')
    expect(sweep).toContain('192.168.1.254')
    expect(sweep).not.toContain('192.168.1.20')
    expect(sweep).toHaveLength(253)
  })


  it('rotates bounded fallback batches instead of sweeping the whole subnet at once', () => {
    const hosts = ['h1', 'h2', 'h3', 'h4', 'h5']
    const first = rotatingBatch(hosts, 0, 2)
    const second = rotatingBatch(hosts, first.next, 2)
    const third = rotatingBatch(hosts, second.next, 2)
    expect(first.items).toEqual(['h1', 'h2'])
    expect(second.items).toEqual(['h3', 'h4'])
    expect(third.items).toEqual(['h5', 'h1'])
  })

  it('rejects multicast and bogus hosts as connect targets', () => {
    expect(isUnicastIPv4('192.168.0.5')).toBe(true)
    expect(isUnicastIPv4('127.0.0.1')).toBe(true)
    expect(isUnicastIPv4(LAN_PAIR_GROUP)).toBe(false)
    expect(isUnicastIPv4('255.255.255.255')).toBe(false)
    expect(isUnicastIPv4('0.0.0.0')).toBe(false)
  })
})

describe('lan swarm helpers', () => {
  it('keeps pairing and persistent beacons on different UDP ports', () => {
    expect(LAN_PAIR_PORT).toBe(48737)
    expect(LAN_RENDEZVOUS_PORT).toBe(48738)
    expect(LAN_RENDEZVOUS_PORT).not.toBe(LAN_PAIR_PORT)
  })

  it('collects both DHT listen sockets', () => {
    expect(
      collectDhtListenPorts({
        io: {
          serverSocket: { address: () => ({ port: 49737 }) },
          clientSocket: { address: () => ({ port: 51200 }) }
        },
        address: () => ({ port: 51200 })
      })
    ).toEqual([49737, 51200])
  })

  it('resets failed attempts and enqueues a LAN peer', () => {
    const queued: Array<{ attempts: number; tried: boolean; explicit: boolean }> = []
    const publicKey = crypto.keyPair().publicKey
    const swarm = {
      keyPair: { publicKey: crypto.keyPair().publicKey },
      explicitPeers: new Set<unknown>(),
      _allConnections: { has: () => false },
      _enqueue: (peer: { attempts: number; tried: boolean; explicit: boolean }) => queued.push(peer),
      _upsertPeer: () => ({
        publicKey,
        explicit: false,
        queued: false,
        attempts: 9,
        tried: true,
        _updatePriority: () => true
      })
    }
    connectLanSwarmPeer(swarm, publicKey, '192.168.1.50', [49737, 51200], new Map())
    expect(queued).toHaveLength(1)
    expect(queued[0].attempts).toBe(0)
    expect(queued[0].tried).toBe(false)
    expect(queued[0].explicit).toBe(true)
    expect(swarm.explicitPeers.size).toBe(1)
  })

  it('does not skip a second remembered peer when another connection is already up', () => {
    const attempted: Uint8Array[] = []
    const online = crypto.keyPair().publicKey
    const next = crypto.keyPair().publicKey
    const swarm = {
      keyPair: { publicKey: crypto.keyPair().publicKey },
      explicitPeers: new Set<unknown>(),
      _allConnections: { has: (publicKey: Uint8Array) => b4a.equals(publicKey, online) },
      _attemptClientConnections: () => attempted.push(next),
      _enqueue: () => {},
      _upsertPeer: (publicKey: Uint8Array) => ({
        publicKey,
        explicit: false,
        queued: true,
        attempts: 0,
        tried: false,
        _updatePriority: () => false
      })
    }
    connectLanSwarmPeer(swarm, next, '192.168.1.51', [49737], new Map())
    expect(attempted).toHaveLength(1)
  })

  it('reports whether a dial was attempted so the caller can avoid logging noise', () => {
    // A LAN rendezvous beacon repeats several times a second. The dial is
    // throttled to one per 3s, so a discovery hint that was throttled away must
    // report "no dial", otherwise every hint is logged and the diagnostics
    // ring fills with discovery noise.
    const swarm = {
      keyPair: { publicKey: crypto.keyPair().publicKey },
      explicitPeers: new Set<unknown>(),
      _allConnections: { has: () => false },
      _attemptClientConnections: () => {},
      _enqueue: () => {},
      _upsertPeer: (publicKey: Uint8Array) => ({
        publicKey,
        explicit: false,
        queued: false,
        attempts: 0,
        tried: false,
        _updatePriority: () => false
      })
    }
    const publicKey = crypto.keyPair().publicKey
    const dialAt = new Map<string, number>()

    // First hint dials.
    expect(connectLanSwarmPeer(swarm, publicKey, '192.168.1.60', [49737], dialAt)).toBe(true)
    // A repeat inside the throttle window does not.
    expect(connectLanSwarmPeer(swarm, publicKey, '192.168.1.60', [49737], dialAt)).toBe(false)
    // An unusable hint never dials.
    expect(connectLanSwarmPeer(swarm, publicKey, '224.0.0.1', [49737], dialAt)).toBe(false)
    expect(connectLanSwarmPeer(swarm, publicKey, '192.168.1.60', [], dialAt)).toBe(false)
  })

  it('stops claiming a dial once the peer is already connected', () => {
    // Regression guard: a repeating beacon plus an already-open connection made
    // every hint report a fresh dial, which filled the diagnostics ring with
    // 100 identical lines and hid every real error.
    const publicKey = crypto.keyPair().publicKey
    const swarm = {
      keyPair: { publicKey: crypto.keyPair().publicKey },
      explicitPeers: new Set<unknown>(),
      _allConnections: { has: (key: Uint8Array) => b4a.equals(key, publicKey) },
      _attemptClientConnections: () => {},
      _enqueue: () => {
        throw new Error('must not enqueue an already connected peer')
      },
      _upsertPeer: (key: Uint8Array) => ({
        publicKey: key,
        explicit: false,
        queued: false,
        attempts: 0,
        tried: false,
        _updatePriority: () => true
      })
    }
    expect(connectLanSwarmPeer(swarm, publicKey, '192.168.1.61', [49737], new Map())).toBe(false)
  })
})
