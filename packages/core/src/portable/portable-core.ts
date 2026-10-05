// PortableCore: slim production entrypoint assembly —
// identity adapter (DPAPI-seeded from shell hello), pairing + persistent
// sessions (PeerManager), fs.v1 engine with journals, chat.v1 store,
// roots allowlist. No legacy TransferOrchestrator aggregate here.

import path from 'bare-path'
import fsp from 'bare-fs/promises'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'

import { RootsManager, type RootInfo } from './roots'
import { JournalStore } from './journal'
import { PeerManager, type PeerSession, type WireInboundRequest, type ChatInbound } from './peers'
import { FsEngine, type EndpointRef, type CopyRequest, type RequestCancelToken } from './fs-engine'
import { ChatStore, isValidWireChatMessageId, type ChatMessage } from './chat'
import { CHAT_MESSAGE_ID_MAX_LEN, CHAT_TEXT_MAX_BYTES, MANIFEST_MAX_ENTRIES } from './limits'
import { uuidv4 } from './encoding'
import { deriveProtectedStateKey } from './protected-json'
import { dbg } from './log'
import { errorCode, errorMessage } from './errors'
import { asParams, isRecord, ipcError, optionalString, parseFilter, parseListSort, parsePerms, parsePreFlashed, type IpcError } from './params'
import { configureRelay, relayConfigSummary } from '../worklet/relay/config'
import { startRelayConf, stopRelayConf, applyCustomRelay } from '../worklet/relay/conf'
import type { DeviceIdentity } from '../worklet/identity/device-identity-store'
import { isDeviceType } from '../worklet/identity/device-type'
import { RecoveryScheduler } from './recovery-scheduler'
import { parseReleaseRevision } from './update-version'
import { clearHashCacheLocks } from './manifest-hash-cache'

/** How long a peer must stay continuously online before recovery is driven. */
const PEER_ONLINE_RECOVERY_STABLE_MS = 5_000

export interface HelloParams {
  shellProtocol: number
  identitySeedHex: string
  deviceName: string
  deviceType: string
  dataRoot: string
  relayConfPubkey?: string | null
  forceRelay?: boolean
  customRelay?: { keyHex: string; host: string } | null
  dhtBootstrap?: string[] | null
  updateSource?: {
    available?: boolean
    path?: string | null
    platform?: string
    size?: number
    sha256?: string
    signature?: string | null
    /** Machine-orderable within-day release identity advertised by the shell. */
    releaseRevision?: number
  } | null
  updateTrust?: {
    publicKeyHex?: string | null
    allowUnsignedDevelopment?: boolean
  } | null
}

export interface CoreEvents {
  emit(event: string, payload: unknown): void
}

export class PortableCore {
  identity: DeviceIdentity | null = null
  roots!: RootsManager
  journals!: JournalStore
  peers: PeerManager | null = null
  engine: FsEngine | null = null
  chat!: ChatStore
  dataRoot = ''
  ready = false
  private _myId = ''
  private _version = '2.0.0'
  private _buildLabel = 'dev'
  private _releaseRevision = 0
  private _bootTimeMs = 0
  private _swarmState: 'booting' | 'booted' | 'degraded' = 'booting'
  private _initState: 'new' | 'initializing' | 'ready' | 'failed' = 'new'
  private _emit: CoreEvents['emit']
  private _recoveryScheduler: RecoveryScheduler | null = null
  private _peerOnlineRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private _inboundFsHeavy = 0
  private _inboundFsHeavyByPeer = new Map<string, number>()
  private _inboundFsWaiters: Array<{
    peerId: string
    resolve: () => void
    reject: (err: Error) => void
    timer: ReturnType<typeof setTimeout>
  }> = []
  private static readonly MAX_INBOUND_FS_HEAVY = 4
  private static readonly MAX_INBOUND_FS_HEAVY_PER_PEER = 2
  private static readonly MAX_INBOUND_FS_WAITERS = 16
  private static readonly MAX_INBOUND_FS_WAITERS_PER_PEER = 4
  private static readonly INBOUND_FS_WAIT_TIMEOUT_MS = 30_000

  constructor(emit: CoreEvents['emit']) {
    this._emit = emit
    this._recoveryScheduler = new RecoveryScheduler(async (peerId) => {
      await this.engine?.resumeAll(peerId)
    })
  }

  /** Boot everything from hello params. Initialization is strictly single-flight. */
  async init(
    p: HelloParams,
    coreVersion: string,
    buildLabel: string,
    releaseRevision: unknown = 0
  ): Promise<{ deviceId: string; capabilities: string[] }> {
    if (this._initState === 'ready' || this.ready) throw this.err('STATE_ERROR', 'already initialized')
    if (this._initState === 'initializing') throw this.err('STATE_ERROR', 'initialization already in progress')
    if (this._initState === 'failed') throw this.err('STATE_ERROR', 'initialization failed; restart core before retrying')
    this._initState = 'initializing'
    try {
      const result = await this._initOnce(p, coreVersion, buildLabel, releaseRevision)
      this._initState = 'ready'
      return result
    } catch (err) {
      this._initState = 'failed'
      await this._cleanupFailedInit()
      throw err
    }
  }

  private async _initOnce(
    p: HelloParams,
    coreVersion: string,
    buildLabel: string,
    releaseRevision: unknown = 0
  ): Promise<{ deviceId: string; capabilities: string[] }> {
    if (p.shellProtocol !== 1) throw this.err('UNSUPPORTED', `shellProtocol ${p.shellProtocol}`)
    if (typeof p.identitySeedHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(p.identitySeedHex)) {
      throw this.err('INVALID_REQUEST', 'identitySeedHex must be 64-hex')
    }
    if (typeof p.dataRoot !== 'string' || p.dataRoot.length < 3) throw this.err('INVALID_REQUEST', 'dataRoot required')
    const seed = b4a.from(p.identitySeedHex, 'hex')
    const kp = crypto.keyPair(seed)
    const deviceType = isDeviceType(p.deviceType) ? p.deviceType : 'unknown'
    const name = String(p.deviceName ?? 'PeerSync').slice(0, 255) || 'PeerSync'
    const identity: DeviceIdentity = {
      publicKey: kp.publicKey,
      secretKey: kp.secretKey,
      displayName: name,
      deviceType,
      createdAt: Date.now()
    }
    this.identity = identity
    this._myId = b4a.toString(kp.publicKey, 'hex').toLowerCase()
    this.dataRoot = p.dataRoot.replace(/[\\]+$/, '')
    await this._ensureTree()
    if (p.relayConfPubkey && /^[0-9a-f]{64}$/i.test(p.relayConfPubkey)) {
      try {
        await startRelayConf(p.relayConfPubkey.toLowerCase())
      } catch (err) {
        this._emit('core.warning', { code: 'RELAY_CONF_FAILED', message: errorMessage(err) })
      }
    }
    configureRelay({ enabled: true })
    if (p.customRelay?.keyHex && p.customRelay?.host) {
      applyCustomRelay({ kind: 'relay', keyHex: p.customRelay.keyHex.toLowerCase(), host: p.customRelay.host })
    }
    const protectedStateKey = deriveProtectedStateKey(seed)
    this.roots = new RootsManager(p.dataRoot, protectedStateKey)
    await this.roots.load()
    if (this.roots.recoveredCorrupt) {
      this._emit('core.warning', { code: 'ROOTS_RECOVERED', message: 'Повреждённые настройки папок изолированы; список доступа сброшен.' })
    }
    this.journals = new JournalStore(p.dataRoot, protectedStateKey)
    await this.journals.recover()
    this.chat = new ChatStore(p.dataRoot, protectedStateKey)
    const peers = new PeerManager(p.dataRoot, identity, {
      onFsRequest: (session, req) => this._routeFs(session, req),
      onFsEvent: (session, event, payload) => {
        void this._routeFsEvent(session, event, payload)
      },
      onPresence: (peerId, online, connectionType) => {
        this._emit('peer.presence', { id: peerId, online, connectionType: connectionType ?? null })
        if (online) {
          this._schedulePeerOnlineRecovery(peerId)
        } else {
          this._cancelPeerOnlineRecovery(peerId)
        }
      },
      onSessionReplaced: (peerId, connectionType) => {
        this._emit('peer.presence', { id: peerId, online: true, connectionType: connectionType ?? null })
        const engine = this.engine
        if (engine) {
          void engine.recoverAfterPeerSessionReplacement(peerId).catch((err) => {
            this._emit('core.warning', { code: 'PEER_REPLACEMENT_RECOVERY_FAILED', message: errorMessage(err) })
          })
        }
      },
      onPairingChanged: (payload) => this._emit('pairing.changed', payload),
      onChatMessage: (peerId, msg) => this._routeChat(peerId, msg),
      onUpdateInfo: (peerId, info) => this._emit('peer.updateInfo', { peerId, update: info }),
      onUpdateProgress: (peerId, receivedBytes, totalBytes) => {
        this._emit('update.progress', { peerId, receivedBytes, totalBytes })
      }
    }, {
      forceRelay: !!p.forceRelay,
      dhtBootstrap: Array.isArray(p.dhtBootstrap) ? p.dhtBootstrap.map(String) : null
    }, seed, protectedStateKey, {
      appVersion: coreVersion,
      buildLabel,
      releaseRevision: parseReleaseRevision(releaseRevision),
      platform: String(p.updateSource?.platform ?? 'win-x64'),
      available: p.updateSource?.available === true,
      path: p.updateSource?.path ? String(p.updateSource.path) : null,
      size: Number(p.updateSource?.size ?? 0),
      sha256: String(p.updateSource?.sha256 ?? ''),
      signature: p.updateSource?.signature ? String(p.updateSource.signature) : null
    }, p.updateTrust?.publicKeyHex ? String(p.updateTrust.publicKeyHex) : null, p.updateTrust?.allowUnsignedDevelopment === true)
    this.peers = peers
    // The shell has retired the previous Core Job before this generation starts;
    // no cache writer can still own a crash-leftover shard lock.
    await clearHashCacheLocks(path.join(p.dataRoot, 'manifest-hashes-v1.json'))
    this.engine = new FsEngine({
      getMyId: () => this._myId,
      roots: this.roots,
      journals: this.journals,
      peers,
      emit: (event, payload) => this._emit(event, payload),
      hashCachePath: path.join(p.dataRoot, 'manifest-hashes-v1.json')
    })
    // fs chat wire handlers on both channels (manager attaches channels)
    // Durable local trust state must load fail-closed.  Only network bootstrap
    // failures are allowed to degrade to offline/LAN operation.
    await peers.loadLocalState()
    try {
      await peers.start()
    } catch (err) {
      this._swarmState = 'degraded'
      this._emit('core.warning', { code: 'BOOTSTRAP_DEGRADED', message: errorMessage(err) })
    }
    await this._recoverPendingPeerForgets()
    this.ready = true
    this._version = coreVersion
    this._buildLabel = buildLabel
    this._releaseRevision = parseReleaseRevision(releaseRevision)
    this._bootTimeMs = Date.now()
    if (this._swarmState !== 'degraded') this._swarmState = 'booted'
    this._emit('core.ready', {
      deviceId: this._myId,
      version: coreVersion,
      buildLabel,
      releaseRevision: this._releaseRevision
    })
    this._emit('core.swarmReady', {
      bootedAt: this._bootTimeMs,
      localPort: this.peers?.localPort() ?? null,
      swarm: this._swarmState
    })
    // initial resume pass for already-connected peers
    for (const id of this.peers?.onlinePeers() ?? []) this._schedulePeerOnlineRecovery(id)
    return { deviceId: this._myId, capabilities: ['fs.v1', 'chat.v1', 'update.v1'] }
  }

  private async _cleanupFailedInit(): Promise<void> {
    this.ready = false
    try {
      await this.engine?.destroy()
    } catch {}
    this.engine = null
    try {
      await this.journals?.shutdown()
    } catch {}
    try {
      await this.peers?.destroy()
    } catch {}
    this.peers = null
    try {
      await stopRelayConf()
    } catch {}
  }

  private async _ensureTree(): Promise<void> {
    for (const sub of ['peers', 'topics', 'journals', 'chat']) {
      await fsp.mkdir(path.join(this.dataRoot, sub), { recursive: true })
    }
  }

  private err(code: string, message: string): IpcError {
    return ipcError(code, message)
  }

  private async _completePeerForget(peerId: string): Promise<void> {
    const peers = this.peers
    if (!peers) throw new Error('peer manager unavailable')
    await this.roots.revokePeer(peerId)
    await this.journals.invalidatePeer(peerId)
    await this.chat.removePeerFile(peerId)
    await peers.finishPeerForget(peerId)
  }

  private async _recoverPendingPeerForgets(): Promise<void> {
    const peers = this.peers
    if (!peers) return
    for (const peerId of peers.pendingPeerForgets()) {
      try {
        await this._completePeerForget(peerId)
      } catch (err) {
        this._emit('core.warning', {
          code: 'PEER_FORGET_CLEANUP_PENDING',
          message: `Peer cleanup pending for ${peerId.slice(0, 12)}: ${errorMessage(err)}`
        })
      }
    }
  }

  // ---------- IPC dispatch (shell methods) ----------
  async call(method: string, payload: unknown, requestCancelToken?: RequestCancelToken): Promise<unknown> {
    if (requestCancelToken?.cancelled) throw this.err('CANCELLED', 'request cancelled')
    const p = asParams(payload)
    switch (method) {
      // ---- core ----
      case 'ping':
        return { pong: p.seq ?? null, at: Date.now() }
      case 'getStatus':
      case 'core.getStatus':
        return {
          online: this.ready,
          peerId: this._myId,
          deviceId: this._myId,
          peers: await this.peers?.peersList() ?? [],
          connected: this.peers?.onlinePeers() ?? [],
          roots: this.roots?.list().length ?? 0,
          version: this._version,
          buildLabel: this._buildLabel,
          releaseRevision: this._releaseRevision,
          swarm: this._swarmState,
          bootTimeMs: this._bootTimeMs,
          relay: relayConfigSummary()
        }
      case 'app.shutdown':
        return { ok: true }

      // ---- pairing ----
      case 'pairing.createCode': {
        this._guard()
        return (await this.peers!.pairHost()) satisfies { code: string }
      }
      case 'pairing.joinCode': {
        this._guard()
        return await this.peers!.pairJoin(String(p.code ?? ''))
      }
      case 'pairing.accept': {
        this._guard()
        return await this.peers!.pairAccept(String(p.pendingId ?? ''), !!p.mine)
      }
      case 'pairing.decline': {
        this._guard()
        return await this.peers!.pairDecline(String(p.pendingId ?? ''))
      }
      case 'pairing.reset': {
        this._guard()
        return await this.peers!.pairReset().then(() => ({ ok: true }))
      }

      // ---- peers ----
      case 'peer.list':
        this._guard()
        return { peers: await this.peers!.peersList() }
      case 'peer.forget': {
        this._guard()
        const id = String(p.id ?? '').toLowerCase()
        await this.peers!.beginPeerForget(id)
        await this._completePeerForget(id)
        this._emit('fs.rootsChanged', { roots: this.roots.list().map(maskRoot) })
        return { ok: true }
      }
      case 'peer.rename':
        this._guard()
        return await this.peers!.peerRename(String(p.id ?? ''), String(p.name ?? '').slice(0, 255))
      case 'peer.poke':
        this._guard()
        return await this.peers!.peerPoke(String(p.id ?? ''))

      // ---- manual peer-to-peer application update ----
      case 'update.request':
        this._guard()
        return await this.peers!.downloadUpdate(String(p.peerId ?? ''))

      // ---- roots ----
      case 'roots.addLocal': {
        this._guard()
        const root = await this.roots.add({
          path: String(p.path ?? ''),
          name: p.name ? String(p.name) : undefined,
          perms: parsePerms(p.perms)
        })
        this._emit('fs.rootsChanged', { roots: this.roots.list().map(maskRoot) })
        return { root: maskRoot(root) }
      }
      case 'roots.removeLocal': {
        this._guard()
        const rootId = String(p.rootId ?? '')
        if (!this.roots.get(rootId)) return { ok: false }
        await this.engine!.quiesceRoot(rootId)
        let removed: RootInfo | null = null
        try {
          // Invalidate durable operations while the root still exists, after
          // new/live users have been drained. Removing the registry entry first
          // could strand resumable journal rows if invalidation then failed.
          await this.journals.invalidateRoot(rootId)
          removed = await this.roots.remove(rootId)
        } finally {
          this.engine!.releaseRootQuiesce(rootId)
        }
        this._emit('fs.rootsChanged', { roots: this.roots.list().map(maskRoot) })
        return { ok: !!removed }
      }
      case 'roots.setPerms': {
        this._guard()
        const rootId = String(p.rootId ?? '')
        const before = this.roots.get(rootId)
        await this.roots.setPerms(rootId, parsePerms(p.perms))
        const after = this.roots.get(rootId)
        if (before?.perms.read === true && after?.perms.read === false) {
          await this.engine!.revokeRootAccess(rootId, { read: true })
        }
        this._emit('fs.rootsChanged', { roots: this.roots.list().map(maskRoot) })
        return { ok: true }
      }
      case 'roots.setPeerPerms': {
        this._guard()
        const rootId = String(p.rootId ?? '')
        const peerId = String(p.peerId ?? '').toLowerCase()
        const hadWrite = this.roots.canPeer(rootId, peerId, 'write')
        await this.roots.setPeerPerms(rootId, peerId, parsePerms(p.perms))
        if (hadWrite && !this.roots.canPeer(rootId, peerId, 'write')) {
          await this.engine!.revokeRootAccess(rootId, { peerId, write: true })
        }
        this._emit('fs.rootsChanged', { roots: this.roots.list().map(maskRoot) })
        return { ok: true }
      }
      case 'roots.listLocal': {
        this._guard()
        return { roots: this.roots.list().map(maskRoot) }
      }
      case 'roots.browse': {
        this._guard()
        const peerId = p.peerId ? String(p.peerId).toLowerCase() : ''
        return await this.engine!.browseRoots(peerId || null)
      }

      // ---- fs ----
      case 'fs.list': {
        this._guard()
        return await this.engine!.list(this._endRef(p.target ?? p), optionalString(p.cursor, 'cursor'), parseListSort(p.sort), requestCancelToken)
      }
      case 'fs.stat':
        this._guard()
        return await this.engine!.stat(this._endRef(p.target ?? p))
      case 'fs.statBatch': {
        this._guard()
        const targets = Array.isArray(p.targets) ? p.targets : []
        if (targets.length > 512) throw this.err('INVALID_REQUEST', 'fs.statBatch supports at most 512 targets')
        return await this.engine!.statBatch(targets.map((target) => this._endRef(target)))
      }
      case 'fs.manifest': {
        this._guard()
        const action = String(p.action ?? 'start')
        if (action === 'start') {
          const scanId = typeof p.scanId === 'string' && p.scanId ? String(p.scanId) : uuidv4()
          this._emit('fs.manifestStarted', { scanId })
          let maxEntries: number | undefined
          if (p.maxEntries !== undefined) {
            const requestedMaxEntries = Number(p.maxEntries)
            if (!Number.isSafeInteger(requestedMaxEntries) || requestedMaxEntries < 1 || requestedMaxEntries > MANIFEST_MAX_ENTRIES) {
              throw this.err('INVALID_REQUEST', 'invalid manifest maxEntries')
            }
            maxEntries = requestedMaxEntries
          }
          const snap = await this.engine!.manifestStart(
            this._endRef(p.target ?? p),
            parseFilter(p.filter),
            null,
            undefined,
            scanId,
            requestCancelToken,
            maxEntries
          )
          if (p.purpose === 'copy') snap.expiresAtMs = snap.hardExpiresAtMs
          return { scanId: snap.scanId, fileCount: snap.fileCount, totalBytes: snap.totalBytes, entriesDigest: snap.entriesDigest, expiresAtMs: snap.expiresAtMs, kind: snap.kind }
        }
        if (action === 'page') return await this.engine!.manifestPage(String(p.scanId ?? ''), optionalString(p.cursor, 'cursor'))
        if (action === 'cancel') return await this.engine!.manifestCancel(String(p.scanId ?? ''))
        throw this.err('INVALID_REQUEST', 'bad fs.manifest action')
      }
      case 'fs.copy': {
        this._guard()
        const items: unknown[] = Array.isArray(p.items) ? p.items : []
        const req: CopyRequest = {
          destination: this._endRef(p.destination),
          items: items.map((i) => ({
            source: this._endRef(isRecord(i) && i.source !== undefined ? i.source : i),
            destinationRelativePath: isRecord(i) && typeof i.destinationRelativePath === 'string' ? i.destinationRelativePath : undefined,
            collision: isRecord(i) && i.collision === 'overwrite' ? 'overwrite' : undefined,
            preScanId: isRecord(i) && typeof i.preScanId === 'string' ? i.preScanId : undefined
          })),
          collision: p.collision === 'overwrite' ? 'overwrite' : 'rename',
          preFlashed: parsePreFlashed(p.preFlashed)
        }
        return await this.engine!.copy(req, requestCancelToken)
      }
      case 'fs.syncPreview': {
        this._guard()
        return await this.engine!.syncPreview(this._endRef(p.source ?? { deviceId: this._myId }), this._endRef(p.destination ?? {}), parseFilter(p.filter), requestCancelToken)
      }
      case 'fs.syncStart':
        this._guard()
        return await this.engine!.syncStart(
          String(p.previewId ?? ''),
          Array.isArray(p.itemPaths) ? p.itemPaths.map(String) : undefined,
          requestCancelToken
        )
      case 'fs.syncCancel':
        this._guard()
        return this.engine!.syncCancel(String(p.previewId ?? ''))

      // ---- operations ----
      case 'operation.list':
        this._guard()
        return await this.engine!.listResumable(
          optionalString(p.cursor, 'cursor'),
          typeof p.limit === 'number' && Number.isSafeInteger(p.limit) ? p.limit : 128,
          typeof p.peerId === 'string' && p.peerId ? p.peerId : null
        )
      case 'operation.batchStatus':
        this._guard()
        return this.engine!.batchStatus(String(p.batchId ?? ''))
      case 'operation.resume':
        this._guard()
        if (p.operationId) return await this.engine!.resumeOperation(String(p.operationId))
        return await this.engine!.resumeAll()
      case 'operation.cancel':
        this._guard()
        return await this.engine!.cancelOperation(String(p.operationId ?? ''))
      case 'operation.cancelBatch':
        this._guard()
        return await this.engine!.cancelBatch(
          String(p.batchId ?? ''),
          optionalString(p.relativePath, 'relativePath')
        )
      case 'operation.recoveryInfo':
        this._guard()
        return await this.engine!.finalizeRecoveryInfo(String(p.operationId ?? ''))
      case 'operation.resolveFinalizeConflict': {
        this._guard()
        const action = String(p.action ?? '')
        if (action !== 'keep-new' && action !== 'restore-backup' && action !== 'save-both') {
          throw this.err('INVALID_REQUEST', 'invalid recovery action')
        }
        return await this.engine!.resolveFinalizeConflict(String(p.operationId ?? ''), action)
      }

      // ---- chat ----
      case 'chat.send': {
        this._guard()
        return await this._chatSend(String(p.peerId ?? ''), String(p.text ?? ''))
      }
      case 'chat.history': {
        this._guard()
        const peerId = String(p.peerId ?? '').toLowerCase()
        if (!/^[0-9a-f]{64}$/.test(peerId)) throw this.err('INVALID_REQUEST', 'peerId must be 64-hex')
        const before = optionalString(p.before, 'before')
        if (before && before.length > CHAT_MESSAGE_ID_MAX_LEN) throw this.err('INVALID_REQUEST', 'chat history cursor too long')
        return await this.chat.historyPage(peerId, before, Number(p.limit ?? 40))
      }
      default:
        throw this.err('UNSUPPORTED', `unknown method ${method}`)
    }
  }

  setVersion(v: string): void {
    this._version = v
  }

  private _guard(): void {
    if (!this.ready) throw this.err('INVALID_REQUEST', 'core not initialized (send hello first)')
  }
  private _endRef(o: unknown): EndpointRef {
    if (!isRecord(o)) throw this.err('INVALID_REQUEST', 'endpoint required')
    // `deviceId` is tolerated as an alias for "this device" (peerId stays null).
    const peerId = o.peerId === null || o.peerId === undefined || o.peerId === '' ? null : String(o.peerId).toLowerCase()
    return { peerId, rootId: String(o.rootId ?? ''), relativePath: String(o.relativePath ?? '') }
  }

  // ---------- inbound wire ----------
  private async _routeFs(session: PeerSession, req: WireInboundRequest): Promise<void> {
    if (!this.engine) {
      req.respond(false, { error: 'INTERNAL', message: 'engine not ready' })
      return
    }
    try {
      const requestCancelToken: RequestCancelToken = {
        get cancelled() {
          return req.cancelled()
        },
        set cancelled(_value: boolean) {
          // WireChannel owns this token; engine code may observe but not clear it.
        }
      }
      const run = () => this.engine!.onWire(session, req.method, req.payload, requestCancelToken)
      const result = this._isHeavyInboundFs(req.method, req.payload)
        ? await this._withInboundFsSlot(session.peerId, run)
        : await run()
      req.respond(true, { result })
    } catch (err: unknown) {
      const code = publicFsErrorCode(errorCode(err))
      dbg('fs wire request failed', req.method, code)
      req.respond(false, { error: code, message: publicFsErrorMessage(code) })
    }
  }

  private _isHeavyInboundFs(method: string, payload: unknown): boolean {
    if (method === 'fs.hash' || method === 'x-init' || method === 'x-open' || method === 'x-resume') return true
    // Every list page can hydrate up to LIST_PAGE_SIZE metadata entries; not
    // only the first page is I/O-heavy when the default/name/type snapshot is
    // lazily materialized.
    if (method === 'fs.list') return true
    if (method === 'fs.manifest') {
      const p = asParams(payload)
      return String(p.action ?? 'start') === 'start'
    }
    return false
  }

  private _canRunInboundFs(peerId: string): boolean {
    return (
      this._inboundFsHeavy < PortableCore.MAX_INBOUND_FS_HEAVY &&
      (this._inboundFsHeavyByPeer.get(peerId) ?? 0) < PortableCore.MAX_INBOUND_FS_HEAVY_PER_PEER
    )
  }

  private _claimInboundFs(peerId: string): void {
    this._inboundFsHeavy += 1
    this._inboundFsHeavyByPeer.set(peerId, (this._inboundFsHeavyByPeer.get(peerId) ?? 0) + 1)
  }

  private _pumpInboundFsWaiters(): void {
    for (let index = 0; index < this._inboundFsWaiters.length;) {
      if (this._inboundFsHeavy >= PortableCore.MAX_INBOUND_FS_HEAVY) return
      const waiter = this._inboundFsWaiters[index]
      if (!this._canRunInboundFs(waiter.peerId)) {
        index += 1
        continue
      }
      this._inboundFsWaiters.splice(index, 1)
      clearTimeout(waiter.timer)
      this._claimInboundFs(waiter.peerId)
      waiter.resolve()
    }
  }

  private async _acquireInboundFsSlot(peerId: string): Promise<() => void> {
    if (this._canRunInboundFs(peerId)) {
      this._claimInboundFs(peerId)
    } else {
      const peerQueued = this._inboundFsWaiters.reduce((n, waiter) => n + Number(waiter.peerId === peerId), 0)
      if (
        this._inboundFsWaiters.length >= PortableCore.MAX_INBOUND_FS_WAITERS ||
        peerQueued >= PortableCore.MAX_INBOUND_FS_WAITERS_PER_PEER
      ) {
        throw this.err('LIMIT_EXCEEDED', 'too many queued filesystem scans')
      }
      await new Promise<void>((resolve, reject) => {
        const waiter: (typeof this._inboundFsWaiters)[number] = {
          peerId,
          resolve,
          reject,
          timer: null as unknown as ReturnType<typeof setTimeout>
        }
        waiter.timer = setTimeout(() => {
          const index = this._inboundFsWaiters.indexOf(waiter)
          if (index >= 0) this._inboundFsWaiters.splice(index, 1)
          reject(this.err('LIMIT_EXCEEDED', 'filesystem scan queue timed out'))
        }, PortableCore.INBOUND_FS_WAIT_TIMEOUT_MS)
        this._inboundFsWaiters.push(waiter)
      })
    }

    let released = false
    return () => {
      if (released) return
      released = true
      this._inboundFsHeavy = Math.max(0, this._inboundFsHeavy - 1)
      const next = (this._inboundFsHeavyByPeer.get(peerId) ?? 1) - 1
      if (next <= 0) this._inboundFsHeavyByPeer.delete(peerId)
      else this._inboundFsHeavyByPeer.set(peerId, next)
      this._pumpInboundFsWaiters()
    }
  }

  private async _withInboundFsSlot<T>(peerId: string, run: () => Promise<T>): Promise<T> {
    const release = await this._acquireInboundFsSlot(peerId)
    try {
      return await run()
    } finally {
      release()
    }
  }

  private async _routeFsEvent(session: PeerSession, event: string, payload: unknown): Promise<void> {
    try {
      if (event === 'x-stale') {
        // Compatibility with older peers that emitted x-stale as an event.
        // Durable journal mutation must still pass through the bounded heavy-I/O
        // gate; otherwise fire-and-forget events can create an unbounded fsync
        // fan-out outside WireChannel's inbound request limit.
        await this._withInboundFsSlot(session.peerId, async () => {
          await this.engine?.onWire(session, 'x-stale', payload ?? {})
        })
      } else if (event === 'fs.manifest') {
        const p = asParams(payload)
        if (p.action === 'cancel') this.engine?.manifestCancel(String(p.scanId ?? ''), session.peerId)
      }
    } catch {}
  }

  private async _routeChat(peerId: string, req: ChatInbound): Promise<void> {
    const respond = 'respond' in req ? req.respond : () => {}
    if ('method' in req && req.method !== 'msg') {
      respond(false, { error: 'UNSUPPORTED' })
      return
    }
    const msg = asParams('payload' in req ? req.payload : req)
    if (msg.t && msg.t !== 'msg') {
      respond(true, { result: { ok: true } })
      return
    }
    const chatGeneration = this.chat.generation(peerId)
    if (!this.peers?.isRemembered(peerId)) {
      respond(false, { error: 'NOT_ALLOWED', message: 'unpaired peer' })
      return
    }
    const messageId = String(msg.messageId ?? '')
    const text = String(msg.text ?? '')
    if (!isValidWireChatMessageId(messageId)) {
      respond(false, { error: 'INVALID_REQUEST' })
      return
    }
    if (b4a.byteLength(b4a.from(text, 'utf8')) > CHAT_TEXT_MAX_BYTES) {
      respond(false, { error: 'INVALID_REQUEST', message: 'text too large' })
      return
    }
    const ts = typeof msg.tsMs === 'number' && Number.isSafeInteger(msg.tsMs) ? msg.tsMs : Date.now()
    const stored = await this.chat.record(
      peerId,
      { messageId, direction: 'in', text, tsMs: ts, state: 'delivered' },
      chatGeneration,
      () => this._emit('chat.message', { peerId, messageId, text, tsMs: ts, direction: 'in' })
    )
    if (stored.stale) {
      respond(false, { error: 'NOT_ALLOWED', message: 'peer was forgotten while message was in flight' })
      return
    }
    respond(true, { result: { ok: true, deduped: !stored.stored } })
  }

  private async _chatSend(peerId: string, text: string): Promise<{ messageId: string; state: ChatMessage['state'] }> {
    const id = String(peerId ?? '').toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(id)) throw this.err('INVALID_REQUEST', 'peerId must be 64-hex')
    const chatGeneration = this.chat.generation(id)
    if (!this.peers?.isRemembered(id)) throw this.err('NOT_ALLOWED', 'chat only with a paired peer')
    const nbytes = b4a.byteLength(b4a.from(text, 'utf8'))
    if (!text || nbytes === 0) throw this.err('INVALID_REQUEST', 'empty text')
    if (nbytes > CHAT_TEXT_MAX_BYTES) throw this.err('INVALID_REQUEST', 'text exceeds 8192 bytes')
    const mid = uuidv4()
    const ts = Date.now()
    const recorded = await this.chat.record(id, { messageId: mid, direction: 'out', text, tsMs: ts, state: 'queued-offline' }, chatGeneration)
    if (recorded.stale) throw this.err('NOT_ALLOWED', 'peer was forgotten while message was being queued')
    const session = this.peers?.session(id)
    if (session) {
      try {
        const res = await session.chat.request('msg', { t: 'msg', messageId: mid, text, tsMs: ts }, 30_000)
        if (res.ok) {
          await this.chat.markState(id, mid, 'delivered')
          this._emit('chat.message', { peerId: id, messageId: mid, text, tsMs: ts, direction: 'out', state: 'delivered' })
          return { messageId: mid, state: 'delivered' }
        }
      } catch {}
      return { messageId: mid, state: 'queued-offline' }
    }
    return { messageId: mid, state: 'queued-offline' }
  }

  /**
   * A peer's transport can flap online for a moment before it settles. Running
   * recovery on the first edge would restart chains against a socket that is
   * about to be replaced, so edges are coalesced and recovery starts only after
   * the peer has been continuously online for a short stable window.
   */
  private _schedulePeerOnlineRecovery(peerId: string): void {
    if (!peerId) return
    const existing = this._peerOnlineRecoveryTimers.get(peerId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this._peerOnlineRecoveryTimers.delete(peerId)
      void this._onPeerOnline(peerId)
    }, PEER_ONLINE_RECOVERY_STABLE_MS)
    this._peerOnlineRecoveryTimers.set(peerId, timer)
  }

  /** The peer went offline again before the stable window elapsed. */
  private _cancelPeerOnlineRecovery(peerId: string): void {
    const timer = this._peerOnlineRecoveryTimers.get(peerId)
    if (!timer) return
    clearTimeout(timer)
    this._peerOnlineRecoveryTimers.delete(peerId)
  }

  private async _onPeerOnline(peerId: string): Promise<void> {
    // resume receiver-role waits + flush queued chat
    try {
      this._recoveryScheduler?.schedule(peerId)
    } catch {}
    try {
      const pending = await this.chat.pendingFor(peerId)
      const session = this.peers?.session(peerId)
      if (!session) return
      let lastDelivered: ChatMessage | null = null
      for (const m of pending) {
        if (m.state === 'queued-offline') {
          try {
            const res = await session.chat.request('msg', { t: 'msg', messageId: m.messageId, text: m.text, tsMs: m.tsMs }, 30_000)
            if (res.ok) {
              await this.chat.markState(peerId, m.messageId, 'delivered')
              lastDelivered = m
            }
          } catch {
            break
          }
        }
      }
      if (lastDelivered) {
        this._emit('chat.message', {
          peerId,
          messageId: lastDelivered.messageId,
          text: lastDelivered.text,
          tsMs: lastDelivered.tsMs,
          direction: 'out',
          state: 'delivered'
        })
      }
    } catch {}
    // deliver cancel-pending for this peer (cancel offline -> pending -> ack)
    for (const row of this.journals.list({ state: ['cancel-pending'] })) {
      if (row.peerId === peerId) {
        try {
          await this.engine?.cancelOperation(row.operationId)
        } catch {}
      }
    }
  }

  async shutdown(): Promise<void> {
    if (!this.ready) return
    this.ready = false
    for (const timer of this._peerOnlineRecoveryTimers.values()) clearTimeout(timer)
    this._peerOnlineRecoveryTimers.clear()
    try {
      await this.engine?.destroy()
    } catch {}
    const shutdownError = this.err('OFFLINE', 'core shutting down')
    for (const waiter of this._inboundFsWaiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(shutdownError)
    }
    this._inboundFsHeavy = 0
    this._inboundFsHeavyByPeer.clear()
    try {
      await this.journals.shutdown()
    } catch {}
    try {
      await this.peers?.destroy()
    } catch {}
    try {
      await stopRelayConf()
    } catch {}
  }
}

function maskRoot(r: RootInfo): Record<string, unknown> {
  const peerWrite = r.peerWrite ?? {}
  return {
    rootId: r.rootId,
    name: r.name,
    path: r.physicalPath,
    perms: r.perms,
    peerWritePeers: Object.keys(peerWrite).filter((id) => peerWrite[id] === true),
    addedAtMs: r.addedAtMs
  }
}

const PUBLIC_FS_CODES = new Set([
  'INVALID_REQUEST', 'NOT_ALLOWED', 'NOT_FOUND', 'CONFLICT', 'OFFLINE',
  'STALE_SOURCE', 'STALE_DEST', 'STALE_SCAN', 'LIMIT_EXCEEDED', 'INTEGRITY', 'UNSUPPORTED'
])

function publicFsErrorCode(code: unknown): string {
  const value = String(code ?? 'IO').toUpperCase()
  return PUBLIC_FS_CODES.has(value) ? value : 'IO'
}

function publicFsErrorMessage(code: string): string {
  switch (code) {
    case 'INVALID_REQUEST': return 'Некорректный запрос'
    case 'NOT_ALLOWED': return 'Операция не разрешена'
    case 'NOT_FOUND': return 'Объект недоступен'
    case 'CONFLICT': return 'Конфликт состояния'
    case 'OFFLINE': return 'Устройство не в сети'
    case 'STALE_SOURCE': return 'Исходный файл изменился'
    case 'STALE_DEST': return 'Файл назначения изменился'
    case 'STALE_SCAN': return 'Снимок каталога устарел'
    case 'LIMIT_EXCEEDED': return 'Превышен допустимый объём операции'
    case 'INTEGRITY': return 'Ошибка проверки целостности'
    case 'UNSUPPORTED': return 'Операция не поддерживается'
    default: return 'Ошибка файловой операции'
  }
}
