// Pairing + persistent peer sessions for PortableCore.
// fs.v1/chat.v1 ride on authenticated remembered-pair connections:
//   - pairing delegates to the upstream PairingCoordinator unchanged;
//     its TransferSwarm + identityStore keep the reference DHT lifecycle;
//   - persistent swarm keyed by the *device* identity (firewall = remembered
//     pubkeys), joining every stored rendezvous topic; on socket attach we
//     create fs.v1 + chat.v1 wire channels and reuse PeerDrive for chunks.

import Hyperswarm, { type PeerSocket } from 'hyperswarm'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import fsp from 'bare-fs/promises'
import path from 'bare-path'
import process from 'bare-process'
import { IntegrityError, ReceiverSession, PART_MARKER, type ChunkWriter } from '@peersync/drive'

import { RememberedPeerStore } from '../worklet/peers/store'
import { PeerIdentityStore } from '../worklet/transfer/peer-identity-store'
import { PairingCoordinator } from '../worklet/peers/pairing-coordinator'
import { PeerDrive } from '../worklet/transfer/drive'
import type { RememberedPeer } from '../worklet/peers/remembered-peer'
import type { DeviceIdentity } from '../worklet/identity/device-identity-store'
import type { TransferIPCMessage } from '../worklet/rpc/events'
import { isValidHexKey } from '../worklet/transfer/utils'
import { relayThrough, isRelayHost, setRelaySending } from '../worklet/relay/config'
import {
  collectDhtListenPorts,
  connectLanSwarmPeer,
  LanPairBeacon,
  LAN_RENDEZVOUS_PORT,
  type UdxHandle
} from '../worklet/peers/lan-pair'
import { HYPERSWARM_PRIVATE_API_EXPECTED, hasCompatibleHyperswarmPrivateApi, installForceRelayPrivatePatch, isObservedRelayTransport, shouldInitiateRendezvous } from '../worklet/peers/hyperswarm-private-adapter'
import { WireChannel, FS_PROTOCOL, CHAT_PROTOCOL, UPDATE_PROTOCOL } from './wire'
import { allocatePartFile } from './partfile'
import { openFile, bytesWrittenOf, type FileHandle } from './fs-handle'
import { createDiskAdapter, type DiskAdapter } from './disk-adapter'
import { errorMessage } from './errors'
import { dbg, pairLog, diagnostic } from './log'
import { comparableAppVersion, isNewerRelease, parseReleaseRevision } from './update-version'
import { isUpdateSignatureRequired, normalizeUpdatePublicKey, verifyUpdateSignature } from './update-signature'
import { UPDATE_SERVE_MAX_CONCURRENT } from './limits'
import { PeerRevocationStore } from './peer-revocations'

export interface PeerUpdateInfo {
  appVersion: string
  buildLabel: string
  /** Machine-orderable within-day release identity; 0 on pre-revision peers. */
  releaseRevision: number
  platform: string
  available: boolean
  size: number
  sha256: string
  signature: string | null
  /** Computed locally from the pinned release public key; never trusted from the peer. */
  signatureVerified: boolean
}

export interface LocalUpdateSource extends PeerUpdateInfo {
  path: string | null
}

interface PendingPairRequest {
  pendingId: string
  peerKey: string
  transferId: string
  timer: ReturnType<typeof setTimeout>
}

const PAIR_CONFIRM_TIMEOUT_MS = 60_000

// Diagnostic/support lever: force pure DHT discovery (the cross-network path)
// on a single host, e.g. to isolate LAN beacon issues. Evaluated once per
// process; the guard is hit by join/reinforce loops, so log only the first hit.
const LAN_DISABLED = Boolean(process.env.PEERSYNC_DISABLE_LAN)
let lanDisabledLogged = false

/**
 * How long a LAN dial may stay silent before it is reported. Long enough for a
 * normal Noise handshake, short enough to stay actionable.
 */
const LAN_DIAL_SETTLE_MS = 15_000

export interface PeerSession {
  peerId: string
  sessionId: string
  socket: PeerSocket
  handshakeHash: Uint8Array | null
  fs: WireChannel
  chat: WireChannel
  update: WireChannel
  drive: PeerDrive
  lastConnectionType: 'direct' | 'relay' | null
  remoteUpdate: PeerUpdateInfo | null
}

export type WireInboundRequest = Parameters<WireChannel['onRequest']>[0]

/** chat.v1 inbound: a request (needs a reply) or a fire-and-forget event. */
export type ChatInbound =
  | WireInboundRequest
  | { event: string; t?: string; messageId?: string; text?: string; tsMs?: number; on?: boolean }

export interface PeerManagerEvents {
  onPresence(peerId: string, online: boolean, connectionType?: 'direct' | 'relay'): void
  /** Fired after a replacement socket has been published and the previous transport was torn down. */
  onSessionReplaced(peerId: string, connectionType?: 'direct' | 'relay', sessionId?: string): void
  onPairingChanged(payload: Record<string, unknown>): void
  onFsRequest(session: PeerSession, req: WireInboundRequest): void | Promise<void>
  onFsEvent(session: PeerSession, event: string, payload: unknown): void
  onChatMessage(peerId: string, msg: ChatInbound): void | Promise<void>
  onUpdateInfo(peerId: string, info: PeerUpdateInfo | null): void
  onUpdateProgress(peerId: string, receivedBytes: number, totalBytes: number): void
}

/**
 * Update download writer.
 *
 * Shares the publication naming convention and the disk seam with the transfer
 * writers, so an update partial is recognizable, cannot collide with a
 * concurrent download, and goes through the same worker/direct decision.
 */
class UpdateWriter implements ChunkWriter {
  readonly partPath: string
  private _handle: FileHandle | null = null
  private _prepared = false
  private _committedPath: string | null = null

  constructor(
    private readonly _target: string,
    private readonly _size: number,
    private readonly _expectedSha256: string,
    private readonly _disk: DiskAdapter
  ) {
    this.partPath = `${_target}${PART_MARKER}${crypto.randomBytes(9).toString('hex')}`
  }

  async allocate(size: number): Promise<void> {
    if (size !== this._size) throw new Error(`update size ${size} != expected ${this._size}`)
    await fsp.mkdir(path.dirname(this._target), { recursive: true })
    await this._disk.unlink(this.partPath, true)
    await allocatePartFile(this.partPath, this._size)
    this._handle = await openFile(this.partPath, 'r+')
  }

  async write(offset: number, data: Uint8Array): Promise<void> {
    if (offset < 0 || offset + data.byteLength > this._size) throw new Error('update chunk outside target')
    const h = this._handle
    if (!h) throw new Error('update target is not allocated')
    let wrote = 0
    while (wrote < data.byteLength) {
      const n = bytesWrittenOf(await h.write(data, wrote, data.byteLength - wrote, offset + wrote))
      if (n <= 0) throw new Error('update write stalled')
      wrote += n
    }
  }

  private async _close(): Promise<void> {
    const h = this._handle
    this._handle = null
    if (!h) return
    try {
      await h.sync()
    } finally {
      await h.close()
    }
  }

  async prepareFinalize(): Promise<void> {
    if (this._prepared) return
    await this._close()
    // The digest check reads the whole file, so it goes through the disk seam:
    // in the worker it stays outside Core and stays cancellable.
    const actual = await this._disk.sha256Absolute(this.partPath)
    if (actual.size !== this._size) {
      throw new IntegrityError(`Downloaded update size changed before commit: ${actual.size} != ${this._size}`)
    }
    if (actual.hex.toLowerCase() !== this._expectedSha256.toLowerCase()) {
      throw new IntegrityError('Downloaded update SHA-256 does not match the advertised update metadata')
    }
    this._prepared = true
  }

  async commitFinalize(): Promise<string> {
    if (this._committedPath) return this._committedPath
    if (!this._prepared) throw new Error('UpdateWriter.commitFinalize before prepareFinalize')
    // The payload is verified in full before the final name is touched, so the
    // rename cannot publish a file that failed its digest.
    await this._disk.rename(this.partPath, this._target)
    this._committedPath = this._target
    return this._committedPath
  }

  async finalize(): Promise<string> {
    await this.prepareFinalize()
    return await this.commitFinalize()
  }

  async abort(): Promise<void> {
    await this._close().catch(() => {})
    // Cleanup runs through the adapter, so a blocked filesystem syscall stays
    // cancellable instead of pinning the update single-flight.
    await this._disk.unlink(this.partPath, true).catch(() => {})
    await this._disk.dispose().catch(() => {})
  }
}

export class PeerManager {
  identity: DeviceIdentity
  remembered: RememberedPeerStore
  topicKeys: PeerIdentityStore
  private readonly _revocations: PeerRevocationStore
  private readonly _dataRoot: string
  private readonly _updateSource: LocalUpdateSource
  private readonly _updateSigningPublicKey: string
  private readonly _updateSignatureRequired: boolean
  private readonly _disk: DiskAdapter

  private _cache = new Map<string, RememberedPeer>()
  private _swarm: Hyperswarm | null = null
  private _forceRelay = false
  private _dhtBootstrap: string[] | null = null
  private _sessions = new Map<string, PeerSession>()
  private _sessionGeneration = 0
  private _reconnectAttempts = new Map<string, number>()
  private _reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private _stableSessionTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private _joinPromises = new Map<string, Promise<unknown>>()
  private _pairCoordinator: PairingCoordinator | null = null
  private _pairTopic: string | null = null
  private _pairRole: 'host' | 'join' | null = null
  private _pairEpoch = 0
  private _pairPending = new Map<string, PendingPairRequest>()
  private _destroyed = false
  private _localStateLoaded = false
  private _lan: LanPairBeacon | null = null
  private _lanDialAt = new Map<string, number>()
  private _lanDialWatch = new Map<string, ReturnType<typeof setTimeout>>()
  private _reinforceGen = new Map<string, symbol>()
  private _onFsRequest: PeerManagerEvents['onFsRequest'] = () => {}
  private _onFsEvent: PeerManagerEvents['onFsEvent'] = () => {}
  private _onPresence: PeerManagerEvents['onPresence'] = () => {}
  private _onSessionReplaced: PeerManagerEvents['onSessionReplaced'] = () => {}
  private _onPairing: PeerManagerEvents['onPairingChanged'] = () => {}
  private _onChat: PeerManagerEvents['onChatMessage'] = () => {}
  private _onUpdateInfo: PeerManagerEvents['onUpdateInfo'] = () => {}
  private _onUpdateProgress: PeerManagerEvents['onUpdateProgress'] = () => {}
  private _updateDownloading = false
  private _updateServingPeers = new Set<string>()

  constructor(
    dataRoot: string,
    identity: DeviceIdentity,
    events: Partial<PeerManagerEvents> = {},
    net: { forceRelay?: boolean; dhtBootstrap?: string[] | null } = {},
    topicDerivationSecret?: Uint8Array,
    protectedStateKey?: Uint8Array,
    updateSource?: Partial<LocalUpdateSource> | null,
    updateSigningPublicKey?: string | null,
    allowUnsignedUpdateDevelopment = false,
    disk?: DiskAdapter
  ) {
    Object.assign(this, {
      _onFsRequest: events.onFsRequest,
      _onFsEvent: events.onFsEvent,
      _onPresence: events.onPresence,
      _onSessionReplaced: events.onSessionReplaced,
      _onPairing: events.onPairingChanged,
      _onChat: events.onChatMessage,
      _onUpdateInfo: events.onUpdateInfo,
      _onUpdateProgress: events.onUpdateProgress
    })
    this._dataRoot = dataRoot
    this._disk = disk ?? createDiskAdapter(null).adapter
    this._updateSigningPublicKey = normalizeUpdatePublicKey(updateSigningPublicKey)
    // Portable builds without a pinned release key use the remembered-`mine` trust boundary
    // plus exact size/SHA-256. A pinned key can opt a different runtime into signature gating.
    this._updateSignatureRequired = isUpdateSignatureRequired(
      this._updateSigningPublicKey,
      allowUnsignedUpdateDevelopment
    )
    this._updateSource = normalizeLocalUpdateSource(
      updateSource,
      this._updateSigningPublicKey,
      this._updateSignatureRequired
    )
    this._forceRelay = !!net.forceRelay
    this._dhtBootstrap = net.dhtBootstrap?.length ? net.dhtBootstrap : null
    this.identity = identity
    this.remembered = new RememberedPeerStore(`${dataRoot}\\peers`)
    this.topicKeys = new PeerIdentityStore(`${dataRoot}\\topics`, topicDerivationSecret)
    if (!protectedStateKey) throw new Error('protected state key required')
    this._revocations = new PeerRevocationStore(dataRoot, protectedStateKey)
  }

  // ---------- lifecycle ----------

  async loadLocalState(): Promise<void> {
    if (this._localStateLoaded) return
    await this.topicKeys.clearLegacyPersisted().catch(() => {})
    // Forget tombstones are a security boundary, not a network feature.  A
    // corrupt/unreadable store must fail Core initialization rather than be
    // downgraded to a "degraded network" warning.
    await this._revocations.load()
    const snapshot = await this.remembered.listSnapshot()
    if (!snapshot.available) {
      throw Object.assign(new Error('remembered peer store is temporarily unavailable'), {
        ipcCode: 'STORE_UNAVAILABLE'
      })
    }
    this._cache.clear()
    for (const p of snapshot.peers) {
      const id = p.remoteDevicePubkey.toLowerCase()
      if (!this._revocations.has(id)) this._cache.set(id, p)
    }
    this._localStateLoaded = true
  }

  async start(): Promise<void> {
    await this.loadLocalState()
    this._swarm = new Hyperswarm({
      keyPair: { publicKey: this.identity.publicKey, secretKey: this.identity.secretKey },
      ...(this._dhtBootstrap ? { bootstrap: this._dhtBootstrap } : {}),
      firewall: (remotePublicKey: Uint8Array) => {
        const hex = b4a.toString(remotePublicKey, 'hex')
        const known = this._knownPubkeys()
        return !known.has(hex.toLowerCase())
      },
      relayThrough: (force: boolean, swarm: unknown) => {
        setRelaySending(true)
        try {
          return relayThrough(force || this._forceRelay, swarm)
        } finally {
          setRelaySending(false)
        }
      }
    })
    if (!hasCompatibleHyperswarmPrivateApi(this._swarm)) {
      pairLog('hyperswarm private API unavailable', HYPERSWARM_PRIVATE_API_EXPECTED)
    }
    if (this._forceRelay && !installForceRelayPrivatePatch(this._swarm)) {
      throw new Error(`forceRelay requires ${HYPERSWARM_PRIVATE_API_EXPECTED} private API shape`)
    }
    this._swarm.on('connection', (socket) => this._onPersistentConnection(socket))
    await this._swarmReady()
    this._ensurePairCoordinator()
    void this._pairCoordinator?.warmup().catch((err: Error) => pairLog('warmup failed', err?.message))
    for (const peer of this._cache.values()) {
      void this.joinRendezvous(peer.rendezvousTopic)
    }
    this._ensureLanRendezvous()
  }

  private _swarmReady(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this._swarm) return resolve()
      const dht = this._swarm.dht
      const after = () => {
        try {
          const st = dht.address?.() ?? null
          dbg('persistent dht ready', 'localPort=', st?.port, 'nat=', dht.nat?.type)
        } catch {}
        resolve()
      }
      if (typeof dht.ready === 'function') dht.ready().then(after, after)
      else after()
    })
  }

  private _knownPubkeys(): Set<string> {
    return new Set(this._cache.keys())
  }

  async destroy(): Promise<void> {
    this._destroyed = true
    this._stopLanRendezvous()
    for (const timer of this._lanDialWatch.values()) clearTimeout(timer)
    this._lanDialWatch.clear()
     this._reinforceGen.clear()
     for (const timer of this._reconnectTimers.values()) clearTimeout(timer)
     this._reconnectTimers.clear()
     for (const timer of this._stableSessionTimers.values()) clearTimeout(timer)
     this._stableSessionTimers.clear()
     this._reconnectAttempts.clear()
     for (const s of this._sessions.values()) {

      s.fs.destroy()
      s.chat.destroy()
      s.update.destroy()
      try {
        s.drive.destroy()
        s.socket.destroy()
      } catch {}
    }
    this._sessions.clear()
    this._updateServingPeers.clear()
    this._clearAllPairPending()
    await this._pairCoordinator?.destroy().catch(() => {})
    this._pairCoordinator = null
    await this._swarm?.destroy().catch(() => {})
    this._swarm = null
  }

  private _scheduleReconnect(peerId: string, topic: string, reason: string): void {
    if (this._destroyed) return
    const id = peerId.toLowerCase()
    this._reinforceGen.delete(topic)
    const stableTimer = this._stableSessionTimers.get(id)
    if (stableTimer) clearTimeout(stableTimer)
    this._stableSessionTimers.delete(id)
    if (this._reconnectTimers.has(id)) return
    const attempt = (this._reconnectAttempts.get(id) ?? 0) + 1
    this._reconnectAttempts.set(id, attempt)
    const base = Math.min(60_000, 1000 * (2 ** Math.min(attempt - 1, 6)))
    const delay = Math.min(60_000, Math.round(base * (0.85 + Math.random() * 0.3)))
    diagnostic('warn', 'peer.transport.reconnect.scheduled', 'peers', reason, { peerRef: id.slice(0, 12), attempt, delayMs: delay })
    const timer = setTimeout(() => {
      this._reconnectTimers.delete(id)
      if (this._destroyed || this._sessions.has(id)) return
      void this.joinRendezvous(topic).catch(() => {})
    }, delay)
    const anyTimer = timer as unknown as { unref?: () => void }
    if (typeof anyTimer.unref === 'function') anyTimer.unref()
    this._reconnectTimers.set(id, timer)
  }

  private _clearReconnect(peerId: string, resetAttempts = true): void {
    const id = peerId.toLowerCase()
    const timer = this._reconnectTimers.get(id)
    if (timer) clearTimeout(timer)
    this._reconnectTimers.delete(id)
    const stableTimer = this._stableSessionTimers.get(id)
    if (stableTimer) clearTimeout(stableTimer)
    this._stableSessionTimers.delete(id)
    if (resetAttempts) this._reconnectAttempts.delete(id)
  }

  private _armStableSessionReset(peerId: string, sessionId: string): void {
    const id = peerId.toLowerCase()
    const timer = setTimeout(() => {
      this._stableSessionTimers.delete(id)
      if (this._sessions.get(id)?.sessionId === sessionId) this._reconnectAttempts.delete(id)
    }, 30_000)
    const anyTimer = timer as unknown as { unref?: () => void }
    if (typeof anyTimer.unref === 'function') anyTimer.unref()
    this._stableSessionTimers.set(id, timer)
  }

  // ---------- persistent sessions / fs channels ----------

  private _onPersistentConnection(socket: PeerSocket): void {
    if (this._forceRelay && !isObservedRelayTransport(this._swarm, socket)) {
      diagnostic('warn', 'peer.transport.rejected', 'peers', 'forceRelay rejected an unverified relay transport')
      socket.destroy()
      return
    }
    const remotePk = socket.remotePublicKey ? b4a.toString(socket.remotePublicKey, 'hex').toLowerCase() : null
    dbg('persistent connection from', remotePk ? keyTag(remotePk) : null, 'known=', remotePk ? this._cache.has(remotePk) : false)
     if (!remotePk) {
       diagnostic('warn', 'peer.transport.rejected', 'peers', 'connection has no authenticated peer identity')
       socket.destroy()

      return
    }
     if (!this._cache.has(remotePk)) {
       diagnostic('warn', 'peer.transport.rejected', 'peers', 'connection is not a remembered peer', { peerRef: remotePk.slice(0, 12) })
       socket.destroy()

      return
    }
    const prev = this._sessions.get(remotePk)
    let handshakeHash: Uint8Array | null = null
    try {
      handshakeHash = socket.handshakeHash ?? null
    } catch {}
    const fs = new WireChannel(socket, FS_PROTOCOL)
    const chat = new WireChannel(socket, CHAT_PROTOCOL)
    const update = new WireChannel(socket, UPDATE_PROTOCOL)
    const drive = PeerDrive.create(socket)
    if (!drive) {
      fs.destroy()
      chat.destroy()
       update.destroy()
       diagnostic('error', 'peer.transport.rejected', 'peers', 'drive channel could not be created', { peerRef: remotePk.slice(0, 12) })
       socket.destroy()

      return
    }
      this._clearReconnect(remotePk, false)
      const lanWatch = this._lanDialWatch.get(remotePk)
      if (lanWatch) {
        clearTimeout(lanWatch)
        this._lanDialWatch.delete(remotePk)
      }
     const session: PeerSession = {
       peerId: remotePk,
       sessionId: `session-${++this._sessionGeneration}`,
       socket,

      handshakeHash,
      fs,
      chat,
      update,
      drive,
      lastConnectionType: null,
      remoteUpdate: null
    }
    fs.onRequest = (req) => this._onFsRequest(session, req)
    fs.onEvent = (ev) => this._onFsEvent(session, ev.event, ev.payload)
    chat.onRequest = (req) => this._onChat(remotePk, { ...req })
    // Chat messages use request/response so WireChannel can apply an inbound
    // concurrency bound. Fire-and-forget chat events are handshake-only and
    // must never become an unbounded persistence path.
    chat.onEvent = (ev) => {
      if (ev.event !== 'hello') dbg('ignoring unsupported chat event', ev.event)
    }
    update.onRequest = (req) => this._onUpdateRequest(session, req)
    update.onEvent = (ev) => {
      if (ev.event !== 'hello') return
      const info = normalizeRemoteUpdateInfo(ev.payload, this._updateSigningPublicKey)
      session.remoteUpdate = info
      pairLog(
        'update hello',
        keyTag(remotePk),
        info?.appVersion || 'none',
        info?.buildLabel || '-',
        info?.available ? 'file' : 'no-file'
      )
      this._onUpdateInfo(remotePk, info)
    }
     socket.on('close', () => {
       if (this._sessions.get(remotePk) === session) {
         diagnostic('info', 'peer.transport.closed', 'peers', 'peer transport closed', { peerRef: remotePk.slice(0, 12), sessionId: session.sessionId })

        this._sessions.delete(remotePk)
        this._updateServingPeers.delete(remotePk)
        session.fs.destroy()
        session.chat.destroy()
        session.update.destroy()
        try {
          session.drive.destroy()
        } catch {}
        this._onPresence(remotePk, false)
        this._onUpdateInfo(remotePk, null)
        pairLog('persistent disconnected', keyTag(remotePk))
        const rec = this._cache.get(remotePk)
         if (rec && !this._destroyed) this._scheduleReconnect(remotePk, rec.rendezvousTopic, 'peer transport closed')

      }
    })
     socket.on('error', (err) => {
       diagnostic('error', 'peer.transport.error', 'peers', errorMessage(err), { peerRef: remotePk.slice(0, 12), sessionId: session.sessionId })
       pairLog('persistent socket error', keyTag(remotePk), errorMessage(err))

      // Some Bare socket failures report `error` before `close`. Run the same
      // terminal cleanup path once; the close listener is guarded by the session
      // identity and becomes a no-op if this handler already removed it.
      if (this._sessions.get(remotePk) === session) {
        this._sessions.delete(remotePk)
        this._updateServingPeers.delete(remotePk)
        session.fs.destroy()
        session.chat.destroy()
        session.update.destroy()
        try {
          session.drive.destroy()
        } catch {}
        this._onPresence(remotePk, false)
        this._onUpdateInfo(remotePk, null)
        const rec = this._cache.get(remotePk)
         if (rec && !this._destroyed) this._scheduleReconnect(remotePk, rec.rendezvousTopic, 'peer transport closed')

      }
    })
    // Publish the replacement before tearing down the previous socket so
    // peer.list cannot observe a hole and the old close cannot flip presence
    // to false after this connection is already live.
     this._sessions.set(remotePk, session)
     this._armStableSessionReset(remotePk, session.sessionId)
     chat.notify('hello', { v: 1 })

    update.notify('hello', { v: 1, ...publicUpdateInfo(this._updateSource) })
    pairLog(
      'update advertise',
      this._updateSource.appVersion,
      this._updateSource.buildLabel,
      this._updateSource.available ? 'file' : 'no-file'
    )
    void this.remembered.touch(remotePk, Date.now()).then((updated) => {
      if (!updated || !this._cache.has(remotePk)) return
      const current = this._cache.get(remotePk)!
      this._cache.set(remotePk, { ...current, lastSeenAt: updated.lastSeenAt })
    }).catch(() => {})
    this._classifyConnection(session)
    pairLog('persistent connected', keyTag(remotePk), session.lastConnectionType ?? 'unknown')
    if (prev && prev !== session) {
      try {
        prev.fs.destroy()
        prev.chat.destroy()
         prev.update.destroy()
         prev.drive.destroy()
         diagnostic('info', 'peer.transport.replaced', 'peers', 'previous peer transport retired', { peerRef: remotePk.slice(0, 12), previousSessionId: prev.sessionId, sessionId: session.sessionId })
         prev.socket.destroy()

      } catch {}
      // The peer was already online, and _sessions already points at the new
      // socket, so there is no presence hole to publish. Use a dedicated
      // post-teardown edge instead: PortableCore updates connection metadata
      // without starting the ordinary pre-teardown resume path.
       this._onSessionReplaced(remotePk, session.lastConnectionType ?? undefined, session.sessionId)

    } else {
      this._onPresence(remotePk, true, session.lastConnectionType ?? undefined)
    }
  }

  private _classifyConnection(session: PeerSession): void {
    let host: string | null = null
    try {
      host = session.socket.rawStream?.remoteHost ?? null
    } catch {}
    // Classify from the observed transport endpoint only. `--force-relay` is
    // an instruction, not proof that the socket actually traversed a relay.
    // This mirrors TransferSwarm's upstream classification semantics.
    session.lastConnectionType = (this._forceRelay ? isObservedRelayTransport(this._swarm, session.socket) : isRelayHost(host)) ? 'relay' : 'direct'
    dbg('persistent connection type', session.lastConnectionType, 'remoteHost=', host ? textTag(host) : 'unknown', 'forceRelay=', this._forceRelay)
  }

  async joinRendezvous(topicHex: string): Promise<void> {
    pairLog('rendezvous join', topicTag(topicHex))
    const swarm = this._swarm
    if (!swarm || this._destroyed) return
    const existing = this._joinPromises.get(topicHex)
    if (existing) {
      await existing.then(() => {})
    } else {
      const promise = (async () => {
        try {
          const sess = swarm.join(crypto.discoveryKey(b4a.from(topicHex, 'hex')), {
            server: true,
            client: this._rendezvousClient(topicHex)
          })
          await sess.flushed()
          pairLog('rendezvous join flushed', topicTag(topicHex))
        } catch (err) {
          pairLog('rendezvous join failed', topicTag(topicHex), errorMessage(err))
        } finally {
          this._joinPromises.delete(topicHex)
        }
      })()
      this._joinPromises.set(topicHex, promise)
      await promise
    }
    this._ensureLanRendezvous()
    try {
      // `join` reuses an existing Hyperswarm discovery object. Explicitly
      // refresh it after a socket loss so a transient DHT outage cannot leave
      // the remembered peer permanently announced but undiscoverable.
      const status = swarm.status(crypto.discoveryKey(b4a.from(topicHex, 'hex')))
      if (status && typeof status.refresh === 'function') await status.refresh()
    } catch (err) {
      pairLog('rendezvous refresh failed', topicTag(topicHex), errorMessage(err))
    }
    this._startReinforce(topicHex)
  }

  /** keep re-announcing until a persistent session for this rendezvous topic exists. */
  private _startReinforce(topicHex: string): void {
    // Use a unique token rather than a reusable integer generation. A leave +
    // immediate rejoin must never let an old sleeping reinforce loop match the
    // new generation (ABA race).
    const token = Symbol(topicHex)
    this._reinforceGen.set(topicHex, token)
    void this._reinforceRendezvous(topicHex, token)
  }

  private async _reinforceRendezvous(topicHex: string, gen: symbol): Promise<void> {
    let cycles = 0
    try {
      while (!this._destroyed && this._reinforceGen.get(topicHex) === gen) {
        // joinRendezvous() has just performed a discovery join and flushed it.
        // Give that join a full stability window before starting the background
        // reinforce cycle; otherwise every explicit poke emits two immediate joins
        // and the LAN/DHT paths race each other into duplicate connections.
        await new Promise<void>((resolve) => setTimeout(() => resolve(), 5000))
        if (this._destroyed || this._reinforceGen.get(topicHex) !== gen) return
        const peerId = this._peerIdByRendezvous(topicHex)
        if (!peerId) return
        if (this._sessions.has(peerId)) {
          pairLog('rendezvous session formed', keyTag(peerId))
          return
        }
        this._ensureLanRendezvous()
        cycles += 1
        if (cycles === 1 || cycles % 12 === 0) pairLog('rendezvous reinforce join', topicTag(topicHex))
        const swarm = this._swarm
        if (!swarm) return
        try {
          const sess = swarm.join(crypto.discoveryKey(b4a.from(topicHex, 'hex')), {
            server: true,
            client: this._rendezvousClient(topicHex)
          })
          await sess.flushed()
        } catch {}
      }
    } finally {
      // Natural completion (session formed / peer forgotten) must not retain a
      // dead topic key. Do not delete a token installed by a newer rejoin.
      if (this._reinforceGen.get(topicHex) === gen) this._reinforceGen.delete(topicHex)
    }
  }

  private _peerIdByRendezvous(topicHex: string): string | null {
    for (const [id, rec] of this._cache) {
      if (rec.rendezvousTopic === topicHex) return id
    }
    return null
  }

  private _rendezvousClient(topicHex: string): boolean {
    const peerId = this._peerIdByRendezvous(topicHex)
    return shouldInitiateRendezvous(this.identity.publicKey, peerId ? b4a.from(peerId, 'hex') : null, this._forceRelay)
  }

  async leaveRendezvous(topicHex: string): Promise<void> {
    // Deleting the unique token invalidates every sleeping loop immediately;
    // a later rejoin receives a distinct Symbol, so old loops cannot revive.
    this._reinforceGen.delete(topicHex)
    try {
      await this._swarm?.leave(crypto.discoveryKey(b4a.from(topicHex, 'hex')))
    } catch {}
    this._joinPromises.delete(topicHex)
    if (this._cache.size === 0) this._stopLanRendezvous()
  }

  private _rendezvousTopicBytes(): Uint8Array[] {
    const out: Uint8Array[] = []
    for (const [peerId, peer] of this._cache) {
      // Authenticated peerId/deviceId is the identity. Connected peers do not
      // need LAN rendezvous probes; displayName is intentionally irrelevant.
      if (this._sessions.has(peerId)) continue
      try {
        const topic = b4a.from(peer.rendezvousTopic, 'hex')
        if (topic.byteLength === 32) out.push(topic)
      } catch {}
    }
    return out
  }

  private _ensureLanRendezvous(): void {
    // Diagnostic/support lever: force pure DHT discovery (the cross-network
    // path) on a single host, e.g. to isolate LAN beacon issues.
    if (LAN_DISABLED || this._forceRelay) {
      if (this._lan) this._stopLanRendezvous()
      if (!lanDisabledLogged) {
        lanDisabledLogged = true
        pairLog('rendezvous lan disabled by env')
      }
      return
    }
    if (this._destroyed || !this._swarm || this._cache.size === 0) {
      if (this._cache.size === 0) this._stopLanRendezvous()
      return
    }
    if (this._lan?.active) return
    this._stopLanRendezvous()
    const udx: UdxHandle | undefined = this._swarm.dht.udx
    if (!udx?.createSocket) {
      pairLog('rendezvous lan skipped')
      return
    }
    const beacon = new LanPairBeacon()
    this._lan = beacon
    beacon.start({
      port: LAN_RENDEZVOUS_PORT,
      topics: () => this._rendezvousTopicBytes(),
      udx,
      localPublicKey: () => this.identity.publicKey,
      dhtPorts: () => collectDhtListenPorts(this._swarm?.dht),
      topicBatchSize: 4,
      unicastSweepEveryTicks: 10,
      unicastSweepBatchSize: 16,
      onPeer: (hint) => this._onLanRendezvousPeer(hint)
    })
    if (!beacon.active) {
      this._lan = null
      pairLog('rendezvous lan skipped')
      return
    }
    pairLog('rendezvous lan beacon')
  }

  private _onLanRendezvousPeer(hint: {
    publicKey: Uint8Array
    host: string
    dhtPorts: number[]
    topic: Uint8Array
  }): void {
    if (!this._swarm || this._destroyed) return
    const hex = b4a.toString(hint.publicKey, 'hex').toLowerCase()
    const rec = this._cache.get(hex)
    if (!rec || this._sessions.has(hex)) return
    try {
      const expected = b4a.from(rec.rendezvousTopic, 'hex')
      if (!b4a.equals(hint.topic, expected)) return
    } catch {
      return
    }
    // Log only a dial that was actually attempted. A LAN beacon repeats several
    // times a second and the dial itself is throttled, so logging every hint
    // buried the diagnostics ring under discovery noise.
    if (connectLanSwarmPeer(this._swarm, hint.publicKey, hint.host, hint.dhtPorts, this._lanDialAt)) {
      pairLog('rendezvous lan peer', keyTag(hex), hint.host, hint.dhtPorts.join(','))
      this._watchLanDial(hex, hint)
    }
  }

  /**
   * A LAN dial never surfaces through the swarm's connection event, so its
   * failure would otherwise be invisible. Watch the peer briefly and report
   * when the hint produced no session, which is what a blocked port or a dead
   * address looks like from here.
   */
  private _watchLanDial(peerId: string, hint: { host: string; dhtPorts: number[] }): void {
    const key = peerId.toLowerCase()
    this._lanDialWatch.delete(key)
    const timer = setTimeout(() => {
      this._lanDialWatch.delete(key)
      if (this._destroyed || this._sessions.has(key)) return
      diagnostic('warn', 'peer.transport.lan.dial.silent', 'peers', 'LAN dial produced no session', {
        peerRef: key.slice(0, 12),
        host: hint.host,
        ports: hint.dhtPorts.join(',')
      })
    }, LAN_DIAL_SETTLE_MS)
    const anyTimer = timer as unknown as { unref?: () => void }
    if (typeof anyTimer.unref === 'function') anyTimer.unref()
    this._lanDialWatch.set(key, timer)
  }

  private _stopLanRendezvous(): void {
    this._lanDialAt.clear()
    for (const timer of this._lanDialWatch.values()) clearTimeout(timer)
    this._lanDialWatch.clear()
    const lan = this._lan
    this._lan = null
    lan?.stop()
  }

  session(peerId: string): PeerSession | null {
    return this._sessions.get(peerId.toLowerCase()) ?? null
  }

  onlinePeers(): string[] {
    return [...this._sessions.keys()]
  }

  get connected(): boolean {
    return this._sessions.size > 0
  }

  // ---------- pairing (reference PairingCoordinator) ----------

  async pairHost(): Promise<{ code: string }> {
    // Keep the reference pairing swarm alive for the whole pairing session.
    // Recycle only the topic so a new code does not tear down the DHT.
    if (this._pairRole && this._pairRole !== 'host') await this.pairReset()
    const coordinator = this._ensurePairCoordinator()
    this._pairRole = 'host'
    this._pairEpoch += 1
    const epoch = this._pairEpoch
    this._onPairing({ event: 'searching', role: 'host' })
    const reply = await coordinator.host()
    this._pairTopic = reply.topic
    pairLog('reference host', topicTag(reply.topic))
    void this._watchSearch(epoch, 180_000)
    return { code: reply.topic }
  }

  async pairJoin(code: string): Promise<{ ok: true; code: string }> {
    let topic = String(code ?? '').trim().toLowerCase()
    if (!isValidHexKey(topic)) {
      const m = /([a-fA-F0-9]{64})/.exec(String(code ?? ''))
      if (!m) throw Object.assign(new Error('bad code'), { ipcCode: 'INVALID_REQUEST' })
      topic = m[1].toLowerCase()
    }

    if (this._pairRole === 'host' || (this._pairRole === 'join' && this._pairTopic && this._pairTopic !== topic)) {
      await this.pairReset()
    }
    const coordinator = this._ensurePairCoordinator()
    this._pairRole = 'join'
    this._pairTopic = topic
    this._pairEpoch += 1
    const epoch = this._pairEpoch
    this._onPairing({ event: 'searching', role: 'join' })
    pairLog('reference join', topicTag(topic))
    await coordinator.join(topic)
    pairLog('reference join flushed', topicTag(topic))
    void this._watchSearch(epoch, 120_000)
    return { ok: true, code: topic }
  }

  private async _watchSearch(epoch: number, ms: number): Promise<void> {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      await new Promise<void>((resolve) => setTimeout(() => resolve(), 4_000))
      if (this._destroyed || this._pairEpoch !== epoch) return
      if ((this._pairCoordinator?.peerCount ?? 0) > 0) return
    }
    if (this._destroyed || this._pairEpoch !== epoch) return
    if ((this._pairCoordinator?.peerCount ?? 0) > 0) return
    const role = this._pairRole
    pairLog('search expired', this._pairTopic ? topicTag(this._pairTopic) : null, role)
    await this.pairReset()
    this._onPairing({ event: 'expired', role, reason: 'search-timeout' })
  }

  private _ensurePairCoordinator(): PairingCoordinator {
    if (this._pairCoordinator) return this._pairCoordinator

    this._pairCoordinator = new PairingCoordinator({
      // This is the important reference behaviour: the pairing TransferSwarm
      // receives the topic identity store instead of running anonymous.
      identityStore: this.topicKeys,
      // PortableCore already owns the DPAPI-seeded device identity, so expose
      // the same getOrCreate contract without creating a second identity file.
      deviceIdentityStore: { getOrCreate: async () => this.identity },
      rememberedStore: {
        get: async (peerId: string) => {
          const id = peerId.toLowerCase()
          if (this._revocations.has(id)) return null
          return await this.remembered.get(id)
        },
        remember: async (peer: RememberedPeer) => {
          const id = peer.remoteDevicePubkey.toLowerCase()
          if (this._revocations.has(id)) throw new Error('peer identity is pending forget cleanup')
          return await this.remembered.remember(peer)
        },
        getRememberTransaction: (peerId: string) =>
          this.remembered.getRememberTransaction(peerId),
        saveRememberTransaction: (record) => this.remembered.saveRememberTransaction(record),
        deleteRememberTransaction: (peerId: string) =>
          this.remembered.deleteRememberTransaction(peerId)
      },
      bootstrap: this._dhtBootstrap,
      emit: (event) => {
        void this._onReferencePairingEvent(event)
      },
      onRememberConfirmed: () => {},
      // The portable flow treats the joiner's code entry as the request, but
      // requires an explicit confirmation on the device that created the code.
      autoRememberVote: false
    })
    return this._pairCoordinator
  }

  private async _onReferencePairingEvent(evt: TransferIPCMessage): Promise<void> {
    try {
      if (evt.type === 'pairing-peer-connected') {
        const peerKey = String(evt.peerKey || '')
        pairLog('reference connected', this._pairRole, peerKey ? keyTag(peerKey) : null)
        this._onPairing({ event: 'connected', role: this._pairRole, peerKey })

        // Only the joiner auto-votes.  Entering the one-time code is the
        // joiner's consent/request; the host must confirm the authenticated
        // device card in the UI before its own remember vote is sent.
        if (this._pairRole === 'join' && this._pairCoordinator && this._pairTopic && peerKey) {
          await this._pairCoordinator.vote({
            transferId: this._pairTopic,
            peerKey,
            vote: 'remember',
            isMine: false
          })
          this._onPairing({ event: 'waiting-confirmation', role: 'join', peerKey })
        }
        return
      }

      if (evt.type === 'remember-confirmed' && evt.peer) {
        const peer: RememberedPeer = evt.peer
        this._clearPairPending(peer.remoteDevicePubkey.toLowerCase())
        this._cache.set(peer.remoteDevicePubkey.toLowerCase(), peer)
        // Persistent rendezvous is independent of the UI payload. Start it
        // before summarizing the peer so a listing bug cannot drop the session.
        void this.joinRendezvous(peer.rendezvousTopic)
        this._ensureLanRendezvous()
        this._onPairing({
          event: 'confirmed',
          role: this._pairRole,
          pendingId: peer.remoteDevicePubkey,
          peer: await this._peerInfo(peer)
        })
        pairLog('remember confirmed', this._pairRole, keyTag(peer.remoteDevicePubkey))
        return
      }

      if (evt.type === 'remember-declined') {
        const peerKey = String(evt.peerKey || '')
        const pendingId = this._pendingIdForPeerKey(peerKey)
        if (pendingId) this._clearPairPending(pendingId)
        pairLog('remember declined', this._pairRole, peerKey ? keyTag(peerKey) : null)
        this._onPairing({
          event: 'declined',
          role: this._pairRole,
          pendingId: pendingId ?? peerKey,
          transferId: evt.transferId
        })
        return
      }

      if (evt.type === 'remember-requested' && this._pairCoordinator && this._pairTopic) {
        // A request is only actionable on the host.  The stable pendingId is
        // the authenticated remote device pubkey, not the ephemeral swarm key.
        if (this._pairRole !== 'host') return
        const pendingId = String(evt.devicePubkey || '').toLowerCase()
        const peerKey = String(evt.peerKey || '')
        const transferId = String(evt.transferId || this._pairTopic)
        if (!/^[0-9a-f]{64}$/.test(pendingId) || !peerKey || !transferId) return
        if (this._pairPending.has(pendingId)) return

        const timer = setTimeout(() => {
          if (!this._pairPending.has(pendingId)) return
          void this.pairDecline(pendingId).catch(() => {})
        }, PAIR_CONFIRM_TIMEOUT_MS)
        this._pairPending.set(pendingId, { pendingId, peerKey, transferId, timer })
        const fingerprint = pendingId.match(/.{1,8}/g)?.join(' ') ?? pendingId
        this._onPairing({
          event: 'request',
          role: 'host',
          pendingId,
          name: String(evt.displayName || 'Unknown device'),
          deviceType: String(evt.deviceType || 'unknown'),
          fingerprint
        })
        this._onPairing({ event: 'waiting-confirmation', role: 'host', pendingId })
        return
      }
    } catch (err: unknown) {
      dbg('reference pairing event failed', evt.type, errorMessage(err))
      pairLog('reference pairing event failed', evt.type, errorMessage(err))
    }
  }

  private _pendingIdForPeerKey(peerKey: string): string | null {
    for (const [pendingId, pending] of this._pairPending) {
      if (pending.peerKey === peerKey) return pendingId
    }
    return null
  }

  private _clearPairPending(pendingId?: string | null): void {
    if (!pendingId) return
    const key = String(pendingId).toLowerCase()
    const pending = this._pairPending.get(key)
    if (!pending) return
    clearTimeout(pending.timer)
    this._pairPending.delete(key)
  }

  private _clearAllPairPending(): void {
    for (const pending of this._pairPending.values()) clearTimeout(pending.timer)
    this._pairPending.clear()
  }

  async pairAccept(pendingId: string, mine: boolean): Promise<{ ok: true }> {
    const key = String(pendingId ?? '').toLowerCase()
    const pending = this._pairPending.get(key)
    if (pending && this._pairCoordinator) {
      await this._pairCoordinator.vote({
        transferId: pending.transferId,
        peerKey: pending.peerKey,
        vote: 'remember',
        isMine: !!mine
      })
      // Keep the request retryable if the vote could not be sent.
      this._clearPairPending(key)
      return { ok: true }
    }

    // Backward-compatible idempotence for a confirmation repeated after the
    // pairing has already been persisted.
    const rec = await this.remembered.get(key)
    if (rec) {
      const updated = await this.remembered.setMine(key, !!mine)
      if (updated && !this._revocations.has(key)) this._cache.set(key, updated)
      return { ok: true }
    }
    throw Object.assign(new Error('pairing confirmation is stale — create a new code'), { ipcCode: 'NOT_FOUND' })
  }

  async pairDecline(pendingId: string): Promise<{ ok: true }> {
    const key = String(pendingId ?? '').toLowerCase()
    const pending = this._pairPending.get(key)
    if (pending && this._pairCoordinator) {
      this._clearPairPending(key)
      await this._pairCoordinator.vote({
        transferId: pending.transferId,
        peerKey: pending.peerKey,
        vote: 'no',
        isMine: false
      })
    }
    return { ok: true }
  }

  async peerPoke(peerId: string): Promise<{ ok: true }> {
    const id = String(peerId).toLowerCase()
    if (this.session(id)) return { ok: true }
    const rec = this._cache.get(id) ?? (await this.remembered.get(id)) ?? null
    if (rec && !this._reconnectTimers.has(id)) await this.joinRendezvous(rec.rendezvousTopic)
    return { ok: true }
  }

  private async _onUpdateRequest(
    session: PeerSession,
    req: {
      requestId: string
      method: string
      payload: unknown
      respond: (ok: boolean, body: { result?: unknown; error?: string; message?: string }) => void
    }
  ): Promise<void> {
    if (req.method !== 'start') {
      req.respond(false, { error: 'UNSUPPORTED', message: 'unknown update method' })
      return
    }
    const rememberedPeer = this._cache.get(session.peerId)
    if (!rememberedPeer?.isMine) {
      req.respond(false, { error: 'NOT_ALLOWED', message: 'updates are served only to a device marked as mine' })
      return
    }
    const source = this._updateSource
    const payload = (req.payload ?? {}) as { transferId?: unknown; version?: unknown }
    const transferId = String(payload.transferId ?? '')
    const version = String(payload.version ?? '')
    if (!source.available || !source.path || (this._updateSignatureRequired && !source.signatureVerified)) {
      req.respond(false, { error: 'NOT_AVAILABLE', message: 'this client has no usable update to serve' })
      return
    }
    if (!/^[0-9a-f]{16,64}$/i.test(transferId) || version !== source.appVersion) {
      req.respond(false, { error: 'INVALID_REQUEST', message: 'invalid update request' })
      return
    }
    if (this._updateServingPeers.has(session.peerId) || this._updateServingPeers.size >= UPDATE_SERVE_MAX_CONCURRENT) {
      req.respond(false, { error: 'BUSY', message: 'update sender is busy' })
      return
    }

    // Claim the slot before the first await so concurrent start requests cannot
    // all pass admission and create unbounded drive sender sessions.
    this._updateServingPeers.add(session.peerId)
    let handedToDrive = false
    try {
      const st = await fsp.stat(source.path)
      if (!st.isFile() || st.size !== source.size) {
        req.respond(false, { error: 'STALE_SOURCE', message: 'local launcher changed' })
        return
      }

      if (!(await session.drive.supported)) {
        req.respond(false, { error: 'UNSUPPORTED', message: 'peer does not support secure update transfer' })
        return
      }
      if (this._sessions.get(session.peerId) !== session) {
        req.respond(false, { error: 'OFFLINE', message: 'peer session changed while preparing update' })
        return
      }

      req.respond(true, { result: publicUpdateInfo(source) })
      handedToDrive = true
      void session.drive.serve(transferId, 'PSN.exe', source.path).catch((err: unknown) => {
        dbg('update serve failed', session.peerId.slice(0, 12), String((err as Error)?.message ?? err))
      }).finally(() => {
        this._updateServingPeers.delete(session.peerId)
      })
    } catch (err) {
      req.respond(false, { error: 'IO', message: String((err as Error)?.message ?? err) })
    } finally {
      if (!handedToDrive) this._updateServingPeers.delete(session.peerId)
    }
  }

  async downloadUpdate(peerId: string): Promise<Record<string, unknown>> {
    if (this._updateDownloading) {
      throw Object.assign(new Error('another update download is already running'), { ipcCode: 'BUSY' })
    }
    const id = String(peerId ?? '').toLowerCase()
    const session = this._sessions.get(id)
    if (!session) throw Object.assign(new Error('peer is offline'), { ipcCode: 'OFFLINE' })
    const info = session.remoteUpdate
    if (!info || !info.available) {
      throw Object.assign(new Error('peer does not advertise an update'), { ipcCode: 'NOT_AVAILABLE' })
    }
    const rememberedPeer = this._cache.get(id)
    if (!rememberedPeer?.isMine) {
      throw Object.assign(new Error('updates are allowed only from a device marked as mine'), { ipcCode: 'NOT_ALLOWED' })
    }
    if (this._updateSignatureRequired && !info.signatureVerified) {
      throw Object.assign(new Error('update release signature is missing or invalid'), { ipcCode: 'INTEGRITY' })
    }
    if (!isNewerRelease(
      info.appVersion,
      info.buildLabel,
      this._updateSource.appVersion,
      this._updateSource.buildLabel,
      info.releaseRevision,
      this._updateSource.releaseRevision
    )) {
      throw Object.assign(new Error('remote version is not newer'), { ipcCode: 'NOT_AVAILABLE' })
    }
    if (info.platform !== this._updateSource.platform) {
      throw Object.assign(new Error('remote update platform is incompatible'), { ipcCode: 'UNSUPPORTED' })
    }
    if (!Number.isSafeInteger(info.size) || info.size <= 0 || info.size > 2 * 1024 * 1024 * 1024) {
      throw Object.assign(new Error('remote update size is invalid'), { ipcCode: 'INVALID_REQUEST' })
    }

    // Single-flight ownership starts before the first await. Everything created
    // below (drive session, ReceiverSession, writer worker/handle) is owned by
    // this flag and must settle before the flag is released.
    this._updateDownloading = true
    let channel: ReturnType<PeerDrive['session']> | null = null
    let receiver: ReceiverSession | null = null
    let received: Promise<string> | null = null
    try {
      if (!(await session.drive.supported)) {
        throw Object.assign(new Error('peer does not support secure update transfer'), { ipcCode: 'UNSUPPORTED' })
      }
      if (this._sessions.get(id) !== session) {
        throw Object.assign(new Error('peer session changed while preparing update'), { ipcCode: 'OFFLINE' })
      }

      const transferId = b4a.toString(crypto.randomBytes(12), 'hex')
      const target = path.join(this._dataRoot, 'update', 'PSN.next.exe')
      const writer = new UpdateWriter(target, info.size, info.sha256, this._disk)
      channel = session.drive.session(transferId)
      receiver = new ReceiverSession(writer, channel, {
        transferId,
        expectedSize: info.size,
        onProgress: (receivedBytes, total) => this._onUpdateProgress(id, receivedBytes, total)
      })
      received = receiver.receive()

      try {
        const start = await session.update.request(
          'start',
          { transferId, version: info.appVersion },
          30_000
        )
        if (!start.ok) {
          throw Object.assign(new Error(start.message ?? start.error ?? 'update source rejected request'), {
            ipcCode: start.error ?? 'REMOTE_ERROR'
          })
        }
        const savedTo = await received
        this._onUpdateProgress(id, info.size, info.size)
        return {
          peerId: id,
          path: savedTo,
          version: info.appVersion,
          buildLabel: info.buildLabel,
          releaseRevision: info.releaseRevision,
          platform: info.platform,
          size: info.size,
          sha256: info.sha256,
          signature: info.signature,
          signatureVerified: info.signatureVerified,
          signatureRequired: this._updateSignatureRequired,
          trustedSource: true
        }
      } catch (err) {
        receiver.cancel(errorMessage(err) || 'update start failed')
        await received.catch(() => {})
        throw err
      }
    } finally {
      channel?.close()
      this._updateDownloading = false
    }
  }

  async pairReset(): Promise<void> {
    this._pairEpoch += 1
    this._clearAllPairPending()
    const coordinator = this._pairCoordinator
    this._pairCoordinator = null
    this._pairTopic = null
    this._pairRole = null
    await coordinator?.destroy().catch(() => {})
  }

  // ---------- peer management ----------

  pendingPeerForgets(): string[] {
    return this._revocations.list()
  }

  async beginPeerForget(peerId: string): Promise<void> {
    const id = peerId.toLowerCase()
    // Durable deny comes first. Once this commits, restart cannot resurrect the
    // identity even if later cleanup fails.
    await this._revocations.add(id)
    // Pairing pendingIds are the authenticated remote device pubkey, i.e. the
    // same stable identity used by peerForget. Retire its timer before tearing
    // down transport so it cannot emit a stale decline for an identity the user
    // has just revoked.
    this._clearPairPending(id)
    const rec = (await this.remembered.get(id)) ?? this._cache.get(id) ?? null
    const session = this._sessions.get(id)
    if (session) {
      session.fs.destroy()
      session.chat.destroy()
      session.update.destroy()
       try { session.drive.destroy() } catch {}
       diagnostic('info', 'peer.transport.revoked', 'peers', 'peer transport retired after forget', { peerRef: id.slice(0, 12), sessionId: session.sessionId })
       try { session.socket.destroy() } catch {}

      this._sessions.delete(id)
      this._updateServingPeers.delete(id)
      this._onPresence(id, false)
    }
    this._cache.delete(id)
    if (rec) await this.leaveRendezvous(rec.rendezvousTopic).catch(() => {})
    if (this._cache.size === 0) this._stopLanRendezvous()
  }

  async finishPeerForget(peerId: string): Promise<void> {
    const id = peerId.toLowerCase()
    await this.remembered.forget(id)
    await this._revocations.remove(id)
  }

  async peerForget(peerId: string): Promise<{ ok: true }> {
    await this.beginPeerForget(peerId)
    await this.finishPeerForget(peerId)
    return { ok: true }
  }

  async peerRename(peerId: string, name: string): Promise<{ ok: true }> {
    const id = peerId.toLowerCase()
    const updated = await this.remembered.rename(id, name)
    if (updated && this._cache.has(id)) this._cache.set(id, updated)
    return { ok: true }
  }

  async peersList(): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = []
    for (const p of this._cache.values()) {
      out.push(await this._peerInfo(p))
    }
    return out
  }

  private async _peerInfo(p: RememberedPeer): Promise<Record<string, unknown>> {
    const id = String(p.remoteDevicePubkey || '').toLowerCase()
    const session = this._sessions.get(id)
    const update = session?.remoteUpdate
      ? {
          ...session.remoteUpdate,
          newer: isNewerRelease(
            session.remoteUpdate.appVersion,
            session.remoteUpdate.buildLabel,
            this._updateSource.appVersion,
            this._updateSource.buildLabel,
            session.remoteUpdate.releaseRevision,
            this._updateSource.releaseRevision
          ),
          compatible: session.remoteUpdate.platform === this._updateSource.platform,
          trustedSource: !!p.isMine,
          signatureRequired: this._updateSignatureRequired,
          usable: session.remoteUpdate.available
            && (!this._updateSignatureRequired || session.remoteUpdate.signatureVerified)
            && !!p.isMine
        }
      : null
    return {
      id,
      name: p.displayName,
      type: p.deviceType,
      mine: !!p.isMine,
      online: this._sessions.has(id),
      connectionType: session?.lastConnectionType ?? null,
      update,
      pairedAt: p.pairedAt,
      lastSeen: p.lastSeenAt
    }
  }

  isRemembered(peerId: string): boolean {
    return this._cache.has(String(peerId ?? '').toLowerCase())
  }

  localPort(): number | null {
    try {
      const st = this._swarm?.dht.address?.() ?? null
      const port = Number(st?.port)
      return Number.isFinite(port) && port > 0 ? port : null
    } catch {
      return null
    }
  }

  refreshRemembered(): void {
    // cache is updated on confirm/forget; nothing else to sync live
  }
}

function normalizeLocalUpdateSource(
  value: Partial<LocalUpdateSource> | null | undefined,
  updateSigningPublicKey: string,
  signatureRequired: boolean
): LocalUpdateSource {
  const buildLabel = cleanText(value?.buildLabel, 96)
  const appVersion = comparableAppVersion(cleanText(value?.appVersion, 64) || '0.0.0', buildLabel)
  const releaseRevision = parseReleaseRevision(value?.releaseRevision)
  const platform = cleanText(value?.platform, 32) || 'win-x64'
  const size = Number(value?.size ?? 0)
  const sha256 = String(value?.sha256 ?? '').toLowerCase()
  const signature = typeof value?.signature === 'string' ? value.signature.trim().toLowerCase() : null
  const sourcePath = typeof value?.path === 'string' && value.path.length > 0 ? value.path : null
  const hasFile = value?.available === true
    && sourcePath !== null
    && Number.isSafeInteger(size)
    && size > 0
    && /^[0-9a-f]{64}$/.test(sha256)
  const signatureVerified = hasFile && verifyUpdateSignature(
    { appVersion, buildLabel, platform, size, sha256 },
    signature,
    updateSigningPublicKey
  )
  const available = hasFile && (!signatureRequired || signatureVerified)
  return {
    appVersion,
    buildLabel,
    releaseRevision,
    platform,
    available,
    size: available ? size : 0,
    sha256: available ? sha256 : '',
    signature: available ? signature : null,
    signatureVerified,
    path: available ? sourcePath : null
  }
}

function normalizeRemoteUpdateInfo(value: unknown, updateSigningPublicKey: string): PeerUpdateInfo | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const appVersion = cleanText(v.appVersion, 64)
  const buildLabel = cleanText(v.buildLabel, 96)
  const releaseRevision = parseReleaseRevision(v.releaseRevision)
  const platform = cleanText(v.platform, 32)
  if (!appVersion || !platform) return null
  const available = v.available === true
  const size = Number(v.size ?? 0)
  const sha256 = String(v.sha256 ?? '').toLowerCase()
  const signature = typeof v.signature === 'string' ? v.signature.slice(0, 256).toLowerCase() : null
  if (available && (!Number.isSafeInteger(size) || size <= 0 || !/^[0-9a-f]{64}$/.test(sha256))) return null
  const signatureVerified = available && verifyUpdateSignature(
    { appVersion, buildLabel, platform, size, sha256 },
    signature,
    updateSigningPublicKey
  )
  return {
    appVersion,
    buildLabel,
    releaseRevision,
    platform,
    available,
    size: available ? size : 0,
    sha256: available ? sha256 : '',
    signature,
    signatureVerified
  }
}

function publicUpdateInfo(source: LocalUpdateSource): PeerUpdateInfo {
  return {
    appVersion: source.appVersion,
    buildLabel: source.buildLabel,
    releaseRevision: source.releaseRevision,
    platform: source.platform,
    available: source.available,
    size: source.available ? source.size : 0,
    sha256: source.available ? source.sha256 : '',
    signature: source.available ? source.signature : null,
    signatureVerified: source.signatureVerified
  }
}

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function topicTag(topicHex: string): string {
  try {
    const digest = crypto.hash(b4a.from(String(topicHex ?? ''), 'hex'))
    return b4a.toString(digest, 'hex').slice(0, 12)
  } catch {
    return 'invalid-topic'
  }
}

function textTag(value: string): string {
  try {
    const digest = crypto.hash(b4a.from(String(value ?? ''), 'utf8'))
    return b4a.toString(digest, 'hex').slice(0, 12)
  } catch {
    return 'invalid-value'
  }
}

function keyTag(keyHex: string): string {
  try {
    const value = String(keyHex ?? '')
    if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) return 'invalid-key'
    const digest = crypto.hash(b4a.from(value, 'hex'))
    return b4a.toString(digest, 'hex').slice(0, 12)
  } catch {
    return 'invalid-key'
  }
}

