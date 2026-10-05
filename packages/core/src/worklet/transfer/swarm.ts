import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import Hyperswarm, { type PeerInfo, type PeerSocket } from 'hyperswarm'
import { PeerControlChannel } from './control-channel'
import type { PeerControlMessage } from './control-channel'
import { PeerIdentityStore, type NoiseKeyPair } from './peer-identity-store'
import { PeerDrive } from './drive'
import { relayThrough, isRelayHost } from '../relay/config'
import { attachProAnnounce } from '../relay/announce'
import { whenRelayConfReady } from '../relay/conf'
import {
  collectDhtListenPorts,
  connectLanSwarmPeer,
  LanPairBeacon,
  type UdxHandle
} from '../peers/lan-pair'

type ConnectionType = 'direct' | 'relay'

export interface PeerSession {
  socket: PeerSocket
  peerKey: string
  controlChannel: PeerControlChannel
  handshakeHash: Uint8Array | null
  drive: PeerDrive | null
}

export interface TransferSwarmCallbacks {
  onPeerConnected: (session: PeerSession) => void
  onPeerDisconnected: (peerKey: string | null, remainingCount: number) => void
  onControlMessage: (message: PeerControlMessage, session: PeerSession) => void | Promise<void>
  onConnectionType?: (peerKey: string, connectionType: ConnectionType) => void
}

export interface TransferSwarmOptions {
  identityStore?: PeerIdentityStore
  drive?: boolean
  bootstrap?: string[] | null
}

const DHT_READY_MS = 20_000
const TOPIC_FLUSH_MS = 15_000

export class TransferSwarm {
  private swarm: Hyperswarm | null
  private readonly peerSessions: Map<PeerSocket, PeerSession>
  private readonly callbacks: TransferSwarmCallbacks
  private readonly identityStore: PeerIdentityStore | null
  private readonly driveEnabled: boolean
  private readonly bootstrap: string[] | null
  private hostedTopicHex: string | null
  private joinedAny: boolean
  private announcedTopic: Uint8Array | null
  private joinWait: Promise<void>
  /** Serialize every mutation of the underlying Hyperswarm instance. */
  private transportQueue: Promise<void>
  private joinGen: number
  private lan: LanPairBeacon | null
  private lanDialAt: Map<string, number>

  constructor(callbacks: TransferSwarmCallbacks, options: TransferSwarmOptions = {}) {
    this.identityStore = options.identityStore ?? null
    this.driveEnabled = options.drive ?? false
    this.bootstrap = options.bootstrap?.length ? options.bootstrap : null
    this.callbacks = callbacks
    this.peerSessions = new Map()
    this.hostedTopicHex = null
    this.joinedAny = false
    this.announcedTopic = null
    this.joinWait = Promise.resolve()
    this.transportQueue = Promise.resolve()
    this.joinGen = 0
    this.lan = null
    this.lanDialAt = new Map()
    this.swarm = null
  }

  get dht(): Hyperswarm['dht'] | null {
    return this.swarm?.dht ?? null
  }

  private ensureSwarm(): Hyperswarm {
    if (!this.swarm) {
      this.swarm = this.createSwarm()
    }
    return this.swarm
  }

  private createSwarm(keyPair?: NoiseKeyPair): Hyperswarm {
    const swarm = new Hyperswarm({
      ...(keyPair ? { keyPair } : {}),
      ...(this.bootstrap ? { bootstrap: this.bootstrap } : {}),
      relayThrough
    })
    attachProAnnounce(swarm.dht)
    swarm.on('connection', (socket, info) => {
      this.handleConnection(socket, info).catch((err) => {
        console.error(
          'TransferSwarm: handleConnection failed',
          err instanceof Error ? err.message : String(err)
        )
        try {
          socket.destroy()
        } catch {}
      })
    })
    swarm.on('update', () => {})
    return swarm
  }

  private async handleConnection(socket: PeerSocket, info: PeerInfo): Promise<void> {
    const peerKey = b4a.toString(info.publicKey, 'hex')

    let session: PeerSession | null = null
    const controlChannel = PeerControlChannel.create(socket, (message) => {
      if (!session) return
      return this.callbacks.onControlMessage(message, session)
    })
    if (!controlChannel) {
      try {
        socket.destroy()
      } catch {}
      return
    }

    session = {
      socket,
      peerKey,
      controlChannel,
      handshakeHash: socket.handshakeHash ?? null,
      drive: this.driveEnabled ? PeerDrive.create(socket) : null
    }

    // The rest of the transfer stack intentionally models peer state by
    // `peerKey` (auth nonce/capabilities/recognition), not by socket. Make that
    // invariant true at the transport boundary instead of allowing two live
    // sockets to share one peer-scoped state bucket during direct/relay races.
    // Install terminal cleanup before publishing the session to callbacks. A
    // synchronous callback/send failure must not leave a destroyed socket in
    // peerSessions merely because close/error listeners were attached later.
    socket.on('close', () => this.cleanupPeer(socket))
    socket.on('error', () => this.cleanupPeer(socket))

    for (const [oldSocket, oldSession] of this.peerSessions) {
      if (oldSession.peerKey !== peerKey) continue
      this.dropPeer(oldSocket, true)
    }
    this.peerSessions.set(socket, session)
    try {
      this.callbacks.onPeerConnected(session)
      this.classifyConnection(socket, peerKey)
    } catch (err) {
      // onPeerConnected may already have installed peer-scoped auth state. Run
      // the same idempotent disconnect path used by a normal socket close.
      this.dropPeer(socket, true)
      throw err
    }
  }

  private classifyConnection(socket: PeerSocket, peerKey: string): void {
    if (!this.callbacks.onConnectionType) return
    const remoteHost = () =>
      (socket as unknown as { rawStream?: { remoteHost?: string } }).rawStream?.remoteHost
    const classify = (): ConnectionType => (isRelayHost(remoteHost()) ? 'relay' : 'direct')

    let current = classify()
    this.callbacks.onConnectionType(peerKey, current)

    if (current !== 'relay') return

    let ticks = 0
    const timer = setInterval(() => {
      const next = classify()
      if (next !== current) {
        current = next
        this.callbacks.onConnectionType?.(peerKey, next)
      }
      if (next !== 'relay' || ++ticks >= 8) clearInterval(timer)
    }, 2000)
    ;(timer as unknown as { unref?: () => void }).unref?.()

    socket.on('close', () => clearInterval(timer))
  }

  private cleanupPeer(socket: PeerSocket): void {
    this.dropPeer(socket, false)
  }

  private dropPeer(socket: PeerSocket, destroySocket: boolean): void {
    const session = this.peerSessions.get(socket)
    if (!session) return
    this.peerSessions.delete(socket)
    session.drive?.destroy()
    if (destroySocket) {
      try {
        socket.destroy()
      } catch {}
    }
    try {
      this.callbacks.onPeerDisconnected(session.peerKey, this.peerSessions.size)
    } catch (err) {
      // Transport teardown must remain terminal even if UI/status cleanup has a
      // bug. Never let one callback strand later sessions during dropAllPeers.
      console.warn(
        'TransferSwarm: disconnect callback failed',
        err instanceof Error ? err.message : String(err)
      )
    }
  }

  private dropAllPeers(): void {
    for (const socket of Array.from(this.peerSessions.keys())) {
      this.dropPeer(socket, true)
    }
  }

  private enqueueTransport<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.transportQueue.then(operation, operation)
    this.transportQueue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async waitDhtReady(swarm: Hyperswarm): Promise<void> {
    const dht = swarm.dht
    if (!dht?.ready) return
    await Promise.race([
      dht.ready(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, DHT_READY_MS)
      })
    ])
  }

  private withTimeout(promise: Promise<unknown>, ms: number, operation: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error(`${operation} timed out after ${ms}ms`))
      }, ms)

      promise.then(
        () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve()
        },
        (err: unknown) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(err)
        }
      )
    })
  }

  private joinTopic(topic: Uint8Array): Promise<void> {
    const gen = ++this.joinGen
    const run = async () => {
      const discovery = crypto.discoveryKey(topic)
      this.joinedAny = true
      this.announcedTopic = topic
      const swarm = this.ensureSwarm()
      await this.waitDhtReady(swarm)
      if (gen !== this.joinGen || this.swarm !== swarm) return
      // Pairing (and first transfer announce) must look up immediately.
      // Waiting for relay config with client:false leaves both sides
      // announcing and nobody dialing — that is the "searching forever" hang.
      const session = swarm.join(discovery, { server: true, client: true })
      await this.withTimeout(session.flushed(), TOPIC_FLUSH_MS, 'DHT topic announce')
      if (gen !== this.joinGen || this.swarm !== swarm) return

      const enableRelay = () => {
        if (this.swarm !== swarm || !this.joinedAny || gen !== this.joinGen) return
        swarm.join(discovery, { server: true, client: true })
      }
      whenRelayConfReady().then(enableRelay, (err: unknown) => {
        console.warn('TransferSwarm: relay conf wait failed', err)
        enableRelay()
      })
    }
    this.joinWait = run()
    return this.joinWait
  }

  async warmup(): Promise<void> {
    await this.enqueueTransport(async () => {
      const swarm = this.ensureSwarm()
      await this.waitDhtReady(swarm)
    })
  }

  async flushAnnouncement(): Promise<void> {
    await this.joinWait
    const swarm = this.swarm
    if (!swarm) return
    await this.waitDhtReady(swarm)
    await this.withTimeout(swarm.flush(), TOPIC_FLUSH_MS, 'DHT announcement flush')
  }

  async refreshDiscovery(): Promise<void> {
    if (!this.announcedTopic || !this.swarm) return
    try {
      await this.swarm.status(crypto.discoveryKey(this.announcedTopic))?.refresh()
    } catch (err) {
      console.warn('TransferSwarm: discovery refresh failed', err)
    }
  }

  /**
   * End the current pairing generation with a hard transport boundary.
   *
   * Reusing a swarm after an uncertain leave lets a late connection from the
   * previous topic race the next pairing generation. Pairing is infrequent,
   * so correctness wins over keeping a warm DHT: destroy the old swarm and
   * let the next host/join create a fresh one.
   */
  private async recycleTopicInner(): Promise<void> {
    this.stopLanDiscovery()
    this.joinGen += 1
    this.hostedTopicHex = null
    this.joinedAny = false
    this.announcedTopic = null
    const pending = this.joinWait
    this.joinWait = Promise.resolve()
    await pending.catch(() => {})

    this.dropAllPeers()

    const oldSwarm = this.swarm
    this.swarm = null
    if (oldSwarm) {
      try {
        await oldSwarm.destroy()
      } catch (err) {
        console.warn('TransferSwarm: pairing generation destroy failed', err)
      }
    }
  }

  async recycleTopic(): Promise<void> {
    await this.enqueueTransport(() => this.recycleTopicInner())
  }

  private async suspendTransportInner(): Promise<void> {
    this.stopLanDiscovery()
    this.joinGen += 1
    this.joinedAny = false
    this.announcedTopic = null
    this.joinWait = Promise.resolve()

    this.dropAllPeers()

    const oldSwarm = this.swarm
    this.swarm = null

    if (oldSwarm) {
      try {
        await oldSwarm.destroy()
      } catch (err) {
        console.warn('TransferSwarm: old swarm destroy failed', err)
      }
    }
  }

  async suspendTransport(): Promise<void> {
    await this.enqueueTransport(() => this.suspendTransportInner())
  }

  async endSession(): Promise<void> {
    this.hostedTopicHex = null
    await this.suspendTransport()
  }

  async join(topicHex: string): Promise<void> {
    await this.enqueueTransport(async () => {
      // Creation and assignment must live in the same serialized transport
      // transaction. Otherwise two callers can both observe !swarm across the
      // identity-store await and leak one fully-live Hyperswarm instance.
      if (!this.swarm && this.identityStore) {
        this.swarm = this.createSwarm(await this.identityStore.getOrCreate(topicHex))
      }
      await this.joinTopic(b4a.from(topicHex, 'hex'))
    })
  }

  generateKey(): string {
    if (this.hostedTopicHex) {
      return this.hostedTopicHex
    }
    const topic = crypto.randomBytes(32)
    const topicHex = b4a.toString(topic, 'hex')
    this.hostedTopicHex = topicHex
    // Keep generateKey synchronous, but always own the background join promise.
    // Host entry points that need readiness still await flushAnnouncement(),
    // which observes the same joinWait and propagates the failure.
    const queued = this.enqueueTransport(() => this.joinTopic(topic))
    this.joinWait = queued
    void queued.catch((err) => {
      console.warn('TransferSwarm: generated topic join failed', err)
    })
    return topicHex
  }

  broadcast(message: PeerControlMessage): void {
    for (const session of this.peerSessions.values()) {
      session.controlChannel.send(message)
    }
  }

  get sessions(): PeerSession[] {
    return Array.from(this.peerSessions.values())
  }

  getSession(peerKey: string): PeerSession | null {
    for (const session of this.peerSessions.values()) {
      if (session.peerKey === peerKey) return session
    }
    return null
  }

  sendTo(peerKey: string, message: PeerControlMessage): boolean {
    const session = this.getSession(peerKey)
    if (!session) return false
    session.controlChannel.send(message)
    return true
  }

  getHandshakeHash(peerKey: string): Uint8Array | null {
    return this.getSession(peerKey)?.handshakeHash ?? null
  }

  get peerCount(): number {
    return this.peerSessions.size
  }

  hasConnectedPeers(): boolean {
    return this.peerSessions.size > 0
  }

  dhtListenPort(): number | null {
    const ports = this.dhtListenPorts()
    return ports[0] ?? null
  }

  dhtListenPorts(): number[] {
    return collectDhtListenPorts(this.swarm?.dht)
  }

  startLanDiscovery(): void {
    this.stopLanDiscovery()
    const topic = this.announcedTopic
    const swarm = this.swarm
    const udx = swarm?.dht?.udx as UdxHandle | undefined
    if (!topic || !swarm || !udx?.createSocket) {
      console.warn('pair lan skipped')
      return
    }
    const beacon = new LanPairBeacon()
    this.lan = beacon
    beacon.start({
      topic,
      udx,
      localPublicKey: () => swarm.keyPair?.publicKey ?? null,
      dhtPorts: () => this.dhtListenPorts(),
      onPeer: (hint) => {
        console.warn(
          'pair lan peer',
          b4a.toString(hint.publicKey, 'hex').slice(0, 8),
          hint.host,
          hint.dhtPorts.join(',')
        )
        this.connectKnownPeer(hint.publicKey, hint.host, hint.dhtPorts)
      }
    })
    if (!beacon.active) {
      this.lan = null
      console.warn('pair lan skipped')
      return
    }
    console.warn('pair lan beacon')
  }

  stopLanDiscovery(): void {
    this.lanDialAt.clear()
    const lan = this.lan
    this.lan = null
    lan?.stop()
  }

  connectKnownPeer(publicKey: Uint8Array, host: string, dhtPorts: number | readonly number[]): void {
    if (!this.swarm || this.peerSessions.size > 0) return
    connectLanSwarmPeer(
      this.swarm,
      publicKey,
      host,
      Array.isArray(dhtPorts) ? dhtPorts : [dhtPorts],
      this.lanDialAt
    )
  }

  async destroy(): Promise<void> {
    this.stopLanDiscovery()
    for (const conn of this.peerSessions.keys()) {
      try {
        conn.destroy()
      } catch {}
    }
    if (this.swarm) {
      await this.swarm.destroy()
    }
  }
}
