import { TransferSwarm, type PeerSession } from '../transfer/swarm'
import type { PeerIdentityStore } from '../transfer/peer-identity-store'
import type { PeerControlMessage } from '../transfer/control-channel'
import { isValidHexKey } from '../transfer/utils'
import { RememberCoordinator } from './remember-coordinator'
import type { RememberedPeer } from './remembered-peer'
import type { RememberTransactionRecord } from './store'
import type { DeviceIdentity } from '../identity/device-identity-store'
import {
  createPairingPeerConnectedEvent,
  TRANSFER_ERROR_CODES,
  type TransferIPCMessage
} from '../rpc/events'
import {
  BadRequestError,
  type HostReply,
  type JoinReply,
  type RememberVoteInput,
  type RememberVoteReply
} from '../rpc/protocol'

export interface PairingCoordinatorDeps {
  identityStore: PeerIdentityStore
  /** Only `getOrCreate` is consumed (by RememberCoordinator); portable passes a pre-seeded adapter. */
  deviceIdentityStore: { getOrCreate(): Promise<DeviceIdentity> }
  rememberedStore: {
    remember(peer: RememberedPeer): Promise<RememberedPeer>
    get(pubkeyHex: string): Promise<RememberedPeer | null>
    getRememberTransaction(pubkeyHex: string): Promise<RememberTransactionRecord | null>
    saveRememberTransaction(record: RememberTransactionRecord): Promise<void>
    deleteRememberTransaction(pubkeyHex: string): Promise<void>
  }
  emit: (event: TransferIPCMessage) => void
  onRememberConfirmed: () => void
  bootstrap?: string[] | null
  /** Portable host confirmation disables the legacy auto-vote path. */
  autoRememberVote?: boolean
}

const PAIR_HUNT_MS = 4_000

export class PairingCoordinator {
  private readonly swarm: TransferSwarm
  private readonly remember: RememberCoordinator
  private readonly emit: (event: TransferIPCMessage) => void
  private topic: string | null = null
  private isMine = false
  private huntTimer: unknown = null
  private readonly autoRememberVote: boolean

  constructor(deps: PairingCoordinatorDeps) {
    this.emit = deps.emit
    this.autoRememberVote = deps.autoRememberVote !== false
    this.swarm = new TransferSwarm(
      {
        onPeerConnected: (session) => this.onPeerConnected(session),
        onPeerDisconnected: (peerKey) => this.onPeerDisconnected(peerKey),
        onControlMessage: (message, session) => this.onControlMessage(message, session)
      },
      { identityStore: deps.identityStore, bootstrap: deps.bootstrap }
    )
    this.remember = new RememberCoordinator({
      deviceIdentityStore: deps.deviceIdentityStore,
      rememberedStore: deps.rememberedStore,
      sendTo: (peerKey, message) => this.swarm.sendTo(peerKey, message),
      getHandshakeHash: (peerKey) => this.swarm.getHandshakeHash(peerKey),
      emit: (event) => {
        // Discovery/lifecycle progression must not depend on UI event delivery.
        // A renderer/IPC failure is observational; it must not roll back or stall
        // an already durable remember transaction.
        if (event.type === 'remember-confirmed') {
          try {
            deps.onRememberConfirmed()
          } catch (err) {
            console.warn('PairingCoordinator: remember-confirmed callback failed', err)
          }
        }
        this.emitEvent(event)
      }
    })
  }

  get peerCount(): number {
    return this.swarm.peerCount
  }

  warmup(): Promise<void> {
    return this.swarm.warmup()
  }

  async host(): Promise<HostReply> {
    this.stopHunt()
    await this.swarm.recycleTopic()
    const topic = this.swarm.generateKey()
    this.topic = topic
    this.isMine = false
    try {
      await this.swarm.flushAnnouncement()
    } catch (err) {
      await this.resetFailedTopic(topic)
      throw err
    }
    this.startHunt()
    this.swarm.startLanDiscovery()
    return { topic }
  }

  async join(topic: string): Promise<JoinReply> {
    if (typeof topic !== 'string' || !isValidHexKey(topic)) {
      throw new BadRequestError('Invalid topic format', TRANSFER_ERROR_CODES.invalidTopic)
    }
    this.stopHunt()
    await this.swarm.recycleTopic()
    this.topic = topic
    this.isMine = false
    try {
      await this.swarm.join(topic)
    } catch (err) {
      await this.resetFailedTopic(topic)
      throw err
    }
    this.startHunt()
    this.swarm.startLanDiscovery()
    return { state: 'joined' }
  }

  async destroy(): Promise<void> {
    this.stopHunt()
    this.swarm.stopLanDiscovery()
    this.topic = null
    this.remember.reset()
    await this.swarm.destroy()
  }

  vote(input: RememberVoteInput): Promise<RememberVoteReply> {
    return this.remember.vote(input)
  }

  private onPeerConnected(session: PeerSession): void {
    this.stopHunt()
    this.swarm.stopLanDiscovery()
    this.emitEvent(createPairingPeerConnectedEvent(session.peerKey))
    this.remember.onPeerConnected(session.peerKey)
    if (this.topic && this.autoRememberVote) {
      void this.remember
        .vote({
          transferId: this.topic,
          peerKey: session.peerKey,
          vote: 'remember',
          isMine: this.isMine
        })
        .catch((err) => console.warn('PairingCoordinator: automatic remember vote failed', err))
    }
  }


  private emitEvent(event: TransferIPCMessage): void {
    try {
      this.emit(event)
    } catch (err) {
      console.warn('PairingCoordinator: event delivery failed', event.type, err)
    }
  }

  private onPeerDisconnected(peerKey: string | null): void {
    if (peerKey) this.remember.onPeerDisconnected(peerKey)
  }

  private onControlMessage(message: PeerControlMessage, session: PeerSession): void | Promise<void> {
    if (message.type === 'pairing-info') {
      return this.remember.handlePairingInfo(message, session)
    }
    if (message.type === 'remember-vote') {
      this.remember.handleRememberVote(message, session.peerKey)
      return
    }
    if (message.type === 'remember-prepare') {
      this.remember.handleRememberPrepare(message, session.peerKey)
      return
    }
    if (message.type === 'remember-commit') {
      this.remember.handleRememberCommit(message, session.peerKey)
      return
    }
    if (message.type === 'remember-commit-ack') {
      this.remember.handleRememberCommitAck(message, session.peerKey)
      return
    }
    if (message.type === 'remember-finalize') {
      this.remember.handleRememberFinalize(message, session.peerKey)
    }
  }

  private async resetFailedTopic(topic: string): Promise<void> {
    if (this.topic === topic) this.topic = null
    this.isMine = false
    try {
      await this.swarm.recycleTopic()
    } catch (cleanupErr) {
      console.warn('PairingCoordinator: failed to recycle topic after announce failure', cleanupErr)
    }
  }

  private startHunt(): void {
    this.stopHunt()
    this.huntTimer = setInterval(() => {
      if (this.swarm.peerCount > 0) {
        this.stopHunt()
        this.swarm.stopLanDiscovery()
        return
      }
      void this.swarm.refreshDiscovery()
    }, PAIR_HUNT_MS)
  }

  private stopHunt(): void {
    if (this.huntTimer == null) return
    clearInterval(this.huntTimer)
    this.huntTimer = null
  }
}
