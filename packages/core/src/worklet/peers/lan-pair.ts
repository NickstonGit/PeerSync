import b4a from 'b4a'
import { connectViaHyperswarmPrivateApi } from './hyperswarm-private-adapter'

const MAGIC = b4a.from('AS1P')
const VERSION = 2
const PACKET_LEN_V1 = 71
const PACKET_LEN = 73
const BROADCAST_MS = 800

export const LAN_PAIR_PORT = 48737
export const LAN_RENDEZVOUS_PORT = 48738
export const LAN_PAIR_GROUP = '239.192.87.37'
const LAN_DIAL_MS = 3_000
const LAN_DIAL_CACHE_MAX = 512
const LAN_DIAL_CACHE_TTL_MS = 30_000

export interface LanPeerHint {
  publicKey: Uint8Array
  host: string
  dhtPorts: number[]
  topic: Uint8Array
}

export interface UdxSocketLike {
  bind(port?: number, host?: string): void
  close(): Promise<void> | void
  addMembership?(group: string, iface?: string): void
  setTTL?(ttl: number): void
  trySend(buffer: Uint8Array, port: number, host: string, ttl?: number): void
  on(event: 'message', cb: (msg: Uint8Array, from: { host: string; port: number }) => void): unknown
  on(event: 'error', cb: (err: Error) => void): void
}

export interface UdxHandle {
  createSocket(opts?: { reuseAddress?: boolean }): UdxSocketLike
  networkInterfaces(): Array<{ host: string; family: number | string; internal?: boolean }>
}

export interface LanPairBeaconOpts {
  topic?: Uint8Array
  topics?: () => Uint8Array[]
  port?: number
  udx: UdxHandle
  localPublicKey: () => Uint8Array | null
  dhtPorts: () => number[]
  onPeer: (hint: LanPeerHint) => void
  /** Number of rendezvous topics announced per broadcast tick. */
  topicBatchSize?: number
  /** Run fallback /24 unicast only every N ticks. */
  unicastSweepEveryTicks?: number
  /** Maximum guessed hosts probed on one sweep tick. */
  unicastSweepBatchSize?: number
}

export function isUnicastIPv4(host: string): boolean {
  if (typeof host !== 'string') return false
  const parts = host.split('.')
  if (parts.length !== 4) return false
  const n = parts.map((p) => Number(p))
  if (n.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return false
  if (n[0] === 0 || n[0] === 255) return false
  if (n[0] >= 224 && n[0] <= 239) return false
  return true
}

export function subnetBroadcast24(host: string): string | null {
  if (!isUnicastIPv4(host)) return null
  const n = host.split('.').map(Number)
  if (n[0] === 127) return null
  return `${n[0]}.${n[1]}.${n[2]}.255`
}

export function lanBroadcastTargets(
  ifaces: Array<{ host: string; family: number | string; internal?: boolean }>
): string[] {
  const out = new Set<string>(['255.255.255.255', '127.0.0.1', LAN_PAIR_GROUP])
  for (const iface of ifaces) {
    const family = iface.family
    if (family !== 4 && family !== 'IPv4') continue
    if (!isUnicastIPv4(iface.host) || iface.internal) continue
    const directed = subnetBroadcast24(iface.host)
    if (directed) out.add(directed)
  }
  return [...out]
}

/** Guessed /24 unicast scan. Many home APs drop multicast and limited broadcast. */
export function lanUnicastSweep(
  ifaces: Array<{ host: string; family: number | string; internal?: boolean }>
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const iface of ifaces) {
    if (iface.family !== 4 && iface.family !== 'IPv4') continue
    if (!isUnicastIPv4(iface.host) || iface.internal) continue
    const n = iface.host.split('.').map(Number)
    if (n[0] === 127) continue
    const prefix = `${n[0]}.${n[1]}.${n[2]}.`
    if (seen.has(prefix)) continue
    seen.add(prefix)
    for (let i = 1; i <= 254; i++) {
      if (i === n[3]) continue
      out.push(prefix + String(i))
    }
  }
  return out
}

export function uniqueUdpPorts(ports: readonly number[]): number[] {
  const out: number[] = []
  for (const port of ports) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue
    if (!out.includes(port)) out.push(port)
  }
  return out
}

export function encodeLanPairPacket(
  topic: Uint8Array,
  publicKey: Uint8Array,
  dhtPorts: number | readonly number[]
): Uint8Array | null {
  if (topic.byteLength !== 32 || publicKey.byteLength !== 32) return null
  const ports = uniqueUdpPorts(Array.isArray(dhtPorts) ? dhtPorts : [dhtPorts])
  if (ports.length === 0) return null
  const buf = b4a.alloc(PACKET_LEN)
  buf.set(MAGIC, 0)
  buf[4] = VERSION
  buf.set(topic, 5)
  buf.set(publicKey, 37)
  const first = ports[0]
  const second = ports[1] ?? ports[0]
  buf[69] = (first >> 8) & 0xff
  buf[70] = first & 0xff
  buf[71] = (second >> 8) & 0xff
  buf[72] = second & 0xff
  return buf
}

export function decodeLanPairPacket(
  buf: Uint8Array
): { topic: Uint8Array; publicKey: Uint8Array; dhtPorts: number[] } | null {
  if (!buf || buf.byteLength < PACKET_LEN_V1) return null
  if (!b4a.equals(buf.subarray(0, 4), MAGIC)) return null
  const version = buf[4]
  if (version !== 1 && version !== 2) return null
  const first = ((buf[69] << 8) | buf[70]) & 0xffff
  const ports = uniqueUdpPorts(
    version === 2 && buf.byteLength >= PACKET_LEN
      ? [first, ((buf[71] << 8) | buf[72]) & 0xffff]
      : [first]
  )
  if (ports.length === 0) return null
  return {
    topic: b4a.from(buf.subarray(5, 37)),
    publicKey: b4a.from(buf.subarray(37, 69)),
    dhtPorts: ports
  }
}

export function collectDhtListenPorts(dht: unknown): number[] {
  const node = dht as {
    address?: () => { port?: number } | null
    localAddress?: () => { port?: number } | null
    io?: {
      serverSocket?: { address?: () => { port?: number } | null }
      clientSocket?: { address?: () => { port?: number } | null }
    }
  } | null
  const ports: number[] = []
  const add = (value: unknown) => {
    const port = Number((value as { port?: number } | null | undefined)?.port)
    if (Number.isInteger(port) && port > 0 && port <= 65535 && !ports.includes(port)) {
      ports.push(port)
    }
  }
  try {
    add(node?.io?.serverSocket?.address?.())
    add(node?.io?.clientSocket?.address?.())
    add(node?.localAddress?.())
    add(node?.address?.())
  } catch {
    add(node?.address?.())
  }
  return ports
}

export function connectLanSwarmPeer(
  swarm: unknown,
  publicKey: Uint8Array,
  host: string,
  dhtPorts: readonly number[],
  dialAt: Map<string, number>
): boolean {
  if (!isUnicastIPv4(host)) return false
  const ports = uniqueUdpPorts(dhtPorts)
  if (ports.length === 0) return false
  const dialId = `${b4a.toString(publicKey, 'hex')}|${host}|${ports.join(',')}`
  const now = Date.now()
  const prev = dialAt.get(dialId) ?? 0
  // Report whether a dial was actually attempted. A LAN beacon repeats many
  // times per second; the caller uses this to avoid logging a discovery hint
  // that was throttled away, which would otherwise bury the ring in noise.
  if (now - prev < LAN_DIAL_MS) return false

  // LAN discovery input is unauthenticated until the Noise connection. Keep
  // spoofed/failed dial hints from growing this cache without bound.
  if (dialAt.size >= LAN_DIAL_CACHE_MAX) {
    for (const [key, at] of dialAt) {
      if (now - at >= LAN_DIAL_CACHE_TTL_MS) dialAt.delete(key)
    }
    while (dialAt.size >= LAN_DIAL_CACHE_MAX) {
      const oldest = dialAt.keys().next().value as string | undefined
      if (oldest === undefined) break
      dialAt.delete(oldest)
    }
  }
  dialAt.set(dialId, now)
  return connectViaHyperswarmPrivateApi(swarm, publicKey, ports.map((port) => ({ host, port })))
}

function listTopics(opts: LanPairBeaconOpts): Uint8Array[] {
  const raw = opts.topics ? opts.topics() : opts.topic ? [opts.topic] : []
  return raw.filter((topic) => topic && topic.byteLength === 32).map((topic) => b4a.from(topic))
}

export function rotatingBatch<T>(items: readonly T[], cursor: number, max: number): { items: T[]; next: number } {
  if (items.length === 0 || max <= 0) return { items: [], next: 0 }
  const take = Math.min(items.length, Math.max(1, Math.floor(max)))
  const start = ((cursor % items.length) + items.length) % items.length
  const out: T[] = []
  for (let i = 0; i < take; i++) out.push(items[(start + i) % items.length])
  return { items: out, next: (start + take) % items.length }
}

export class LanPairBeacon {
  private socket: UdxSocketLike | null = null
  private timer: unknown = null
  private stopped = true
  private ticks = 0
  private topicCursor = 0
  private sweepCursor = 0
  private sweepTopicCursor = 0
  private port = LAN_PAIR_PORT
  private opts: LanPairBeaconOpts | null = null

  get active(): boolean {
    return !this.stopped && this.socket != null
  }

  start(opts: LanPairBeaconOpts): void {
    this.stop()
    this.port = opts.port && opts.port > 0 && opts.port <= 65535 ? opts.port : LAN_PAIR_PORT
    this.opts = opts
    let socket: UdxSocketLike
    try {
      socket = opts.udx.createSocket({ reuseAddress: true })
    } catch (err) {
      console.warn('pair lan socket create failed', err instanceof Error ? err.message : err)
      return
    }
    socket.on('error', (err) => {
      console.warn('pair lan socket', err instanceof Error ? err.message : String(err))
    })
    socket.on('message', (msg, from) => {
      if (this.stopped || !this.opts) return
      const parsed = decodeLanPairPacket(msg)
      if (!parsed) return
      const wanted = listTopics(this.opts)
      if (!wanted.some((topic) => b4a.equals(parsed.topic, topic))) return
      const local = this.opts.localPublicKey()
      if (local && b4a.equals(parsed.publicKey, local)) return
      if (!isUnicastIPv4(from.host)) return
      this.opts.onPeer({
        publicKey: parsed.publicKey,
        host: from.host,
        dhtPorts: parsed.dhtPorts,
        topic: parsed.topic
      })
    })
    try {
      socket.bind(this.port, '0.0.0.0')
    } catch (err) {
      console.warn('pair lan bind failed', err instanceof Error ? err.message : err)
      try {
        void socket.close()
      } catch {}
      return
    }
    try {
      socket.setTTL?.(1)
    } catch {}
    this.joinMulticast(socket, opts.udx)
    this.socket = socket
    this.stopped = false
    this.ticks = 0
    this.topicCursor = 0
    this.sweepCursor = 0
    this.sweepTopicCursor = 0
    this.tick()
    this.timer = setInterval(() => this.tick(), BROADCAST_MS)
  }

  stop(): void {
    this.stopped = true
    if (this.timer != null) {
      clearInterval(this.timer)
      this.timer = null
    }
    const socket = this.socket
    this.socket = null
    this.opts = null
    if (!socket) return
    try {
      void socket.close()
    } catch (err) {
      console.warn('pair lan close failed', err instanceof Error ? err.message : err)
    }
  }

  private joinMulticast(socket: UdxSocketLike, udx: UdxHandle): void {
    if (!socket.addMembership) return
    const ifaces = this.safeIfaces(udx)
    const seen = new Set<string>([''])
    try {
      socket.addMembership(LAN_PAIR_GROUP)
    } catch {}
    for (const iface of ifaces) {
      if (iface.family !== 4 && iface.family !== 'IPv4') continue
      if (!isUnicastIPv4(iface.host) || seen.has(iface.host)) continue
      seen.add(iface.host)
      try {
        socket.addMembership(LAN_PAIR_GROUP, iface.host)
      } catch {}
    }
  }

  private tick(): void {
    if (this.stopped || !this.socket || !this.opts) return
    const local = this.opts.localPublicKey()
    const dhtPorts = this.opts.dhtPorts()
    const topics = listTopics(this.opts)
    if (!local || dhtPorts.length === 0 || topics.length === 0) return
    const ifaces = this.safeIfaces(this.opts.udx)

    // Cheap discovery path: broadcast/multicast only a bounded rotating topic
    // batch. With one pairing topic this is identical to previous behavior.
    const topicLimit = this.opts.topicBatchSize ?? topics.length
    const selected = rotatingBatch(topics, this.topicCursor, topicLimit)
    this.topicCursor = selected.next
    const broadcasts = lanBroadcastTargets(ifaces)
    for (const topic of selected.items) {
      const packet = encodeLanPairPacket(topic, local, dhtPorts)
      if (!packet) continue
      for (const host of broadcasts) {
        try { this.socket.trySend(packet, this.port, host, 1) } catch {}
      }
    }

    // Expensive fallback: one rendezvous topic and only a small rotating slice
    // of guessed /24 hosts. This makes traffic bounded instead of
    // O(rememberedPeers * 253) every few seconds.
    const every = Math.max(1, Math.floor(this.opts.unicastSweepEveryTicks ?? 3))
    if (this.ticks % every === 0) {
      const sweep = lanUnicastSweep(ifaces)
      const hostBatch = rotatingBatch(sweep, this.sweepCursor, this.opts.unicastSweepBatchSize ?? 64)
      this.sweepCursor = hostBatch.next
      const topicPick = rotatingBatch(topics, this.sweepTopicCursor, 1)
      this.sweepTopicCursor = topicPick.next
      const topic = topicPick.items[0]
      const packet = topic ? encodeLanPairPacket(topic, local, dhtPorts) : null
      if (packet) {
        for (const host of hostBatch.items) {
          try { this.socket.trySend(packet, this.port, host, 1) } catch {}
        }
      }
    }
    this.ticks += 1
  }

  private safeIfaces(udx: UdxHandle): Array<{ host: string; family: number | string; internal?: boolean }> {
    try {
      return udx.networkInterfaces() ?? []
    } catch {
      return []
    }
  }
}
