import b4a from 'b4a'
import {
  buildPairingInfo,
  buildRememberTransactionId,
  computePendingPairing,
  verifyPairingInfo,
  type PendingPairing
} from './pairing'
import { resolveVote, buildRememberedPeer, type RememberDecision } from './vote'
import type { RememberedPeer } from './remembered-peer'
import type { DeviceIdentity } from '../identity/device-identity-store'
import type {
  PairingInfo,
  PeerControlMessage,
  RememberCommit,
  RememberCommitAck,
  RememberFinalize,
  RememberPrepare,
  RememberVote
} from '../transfer/control-channel'
import {
  createRememberConfirmedEvent,
  createRememberDeclinedEvent,
  createRememberRequestedEvent,
  type TransferIPCMessage
} from '../rpc/events'
import { BadRequestError, type RememberVoteInput, type RememberVoteReply } from '../rpc/protocol'
import type {
  RememberTransactionPhase,
  RememberTransactionRecord
} from './store'

const REMEMBER_VOTE_TIMEOUT_MS = 60_000
const COMMIT_RETRY_MS = 1_000

export interface PairingSession {
  peerKey: string
  handshakeHash: Uint8Array | null
}

export interface RememberCoordinatorDeps {
  deviceIdentityStore: { getOrCreate(): Promise<DeviceIdentity> }
  rememberedStore: {
    remember(peer: RememberedPeer): Promise<RememberedPeer>
    get(pubkeyHex: string): Promise<RememberedPeer | null>
    getRememberTransaction(pubkeyHex: string): Promise<RememberTransactionRecord | null>
    saveRememberTransaction(record: RememberTransactionRecord): Promise<void>
    deleteRememberTransaction(pubkeyHex: string): Promise<void>
  }
  sendTo: (peerKey: string, message: PeerControlMessage) => void
  getHandshakeHash: (peerKey: string) => Uint8Array | null
  emit: (event: TransferIPCMessage) => void
}

interface OurVote {
  transferId: string
  decision: RememberDecision
  isMine: boolean
  sent: boolean
}

interface RemoteVote {
  transferId: string
  decision: RememberDecision
}

interface CommitState {
  peerKey: string
  transferId: string
  transactionId: string
  peer: RememberedPeer
  isCoordinator: boolean
  phase: RememberTransactionPhase
  localPrepared: boolean
  remotePrepared: boolean
  commitReceived: boolean
  commitAckReceived: boolean
  commandSent: boolean
  operationInFlight: boolean
  savedPeer: RememberedPeer | null
}

export class RememberCoordinator {
  private readonly deps: RememberCoordinatorDeps
  private readonly deviceIdentityReady: Promise<DeviceIdentity>
  private deviceIdentity: DeviceIdentity | null = null
  private readonly pendingPairings = new Map<string, PendingPairing>()
  private readonly ourVotes = new Map<string, OurVote>()
  private readonly remoteVotes = new Map<string, RemoteVote>()
  private readonly timers = new Map<string, unknown>()
  private readonly pairingInfoRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly commitRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly sentPairingInfo = new Set<string>()
  private readonly commits = new Map<string, CommitState>()
  private readonly earlyPrepares = new Map<string, string>()
  private readonly earlyCommits = new Map<string, string>()
  private readonly earlyCommitAcks = new Map<string, string>()
  private readonly earlyFinalizes = new Map<string, string>()

  constructor(deps: RememberCoordinatorDeps) {
    this.deps = deps
    this.deviceIdentityReady = deps.deviceIdentityStore.getOrCreate()
    this.deviceIdentityReady
      .then((identity) => {
        this.deviceIdentity = identity
      })
      .catch((err) => console.warn('RememberCoordinator: device identity init failed', err))
  }

  onPeerConnected(peerKey: string): void {
    this.deviceIdentityReady
      .then(() => {
        if (this.deps.getHandshakeHash(peerKey)) this.sendPairingInfo(peerKey)
      })
      .catch(() => {})
  }

  async handlePairingInfo(message: PairingInfo, session: PairingSession): Promise<void> {
    if (!session.handshakeHash || !this.deviceIdentity) {
      console.warn('RememberCoordinator: pairing-info before handshake/identity ready; ignoring')
      return
    }
    if (!verifyPairingInfo(message, session.handshakeHash)) {
      console.warn('RememberCoordinator: pairing-info signature invalid; ignoring')
      return
    }

    const pending = computePendingPairing(
      this.deviceIdentity.publicKey,
      message,
      session.handshakeHash
    )
    const devicePubkeyHex = b4a.toString(pending.remoteDevicePubkey, 'hex')
    this.pendingPairings.set(session.peerKey, pending)

    if (pending.remoteRememberCommitV2) {
      const recovered = await this.recoverTransaction(session.peerKey, pending)
      if (recovered) return
    }

    const known = await this.deps.rememberedStore.get(devicePubkeyHex)
    if (known) {
      if (!this.deps.getHandshakeHash(session.peerKey)) return
      this.emit(createRememberConfirmedEvent(session.peerKey, known))
    }

    this.sendOurVoteIfCompatible(session.peerKey)

    const remote = this.remoteVotes.get(session.peerKey)
    if (remote?.decision === 'remember' && !this.ourVotes.has(session.peerKey)) {
      this.emit(
        createRememberRequestedEvent({
          transferId: remote.transferId,
          peerKey: session.peerKey,
          devicePubkey: devicePubkeyHex,
          displayName: pending.remoteDisplayName,
          deviceType: pending.remoteDeviceType
        })
      )
    }
    this.evaluateVote(session.peerKey)
  }

  handleRememberVote(message: RememberVote, peerKey: string): void {
    this.remoteVotes.set(peerKey, { decision: message.vote, transferId: message.transferId })
    if (message.vote === 'remember' && !this.ourVotes.has(peerKey)) {
      const pending = this.pendingPairings.get(peerKey)
      if (pending) {
        this.emit(
          createRememberRequestedEvent({
            transferId: message.transferId,
            peerKey,
            devicePubkey: b4a.toString(pending.remoteDevicePubkey, 'hex'),
            displayName: pending.remoteDisplayName,
            deviceType: pending.remoteDeviceType
          })
        )
      }
    }
    this.evaluateVote(peerKey)
  }

  handleRememberPrepare(message: RememberPrepare, peerKey: string): void {
    const state = this.commits.get(peerKey)
    if (!state) {
      this.earlyPrepares.set(peerKey, message.transactionId)
      void this.repairCompletedCoordinator(peerKey, message.transactionId)
      return
    }
    if (state.transactionId !== message.transactionId || state.transferId !== message.transferId) return
    state.remotePrepared = true
    this.driveCommit(state)
  }

  handleRememberCommit(message: RememberCommit, peerKey: string): void {
    const state = this.commits.get(peerKey)
    if (!state) {
      this.earlyCommits.set(peerKey, message.transactionId)
      return
    }
    if (state.transactionId !== message.transactionId || state.isCoordinator) return
    state.remotePrepared = true
    state.commitReceived = true
    this.driveCommit(state)
  }

  handleRememberCommitAck(message: RememberCommitAck, peerKey: string): void {
    const state = this.commits.get(peerKey)
    if (!state) {
      this.earlyCommitAcks.set(peerKey, message.transactionId)
      void this.finalizeAlreadyCommitted(peerKey, message.transactionId)
      return
    }
    if (state.transactionId !== message.transactionId || !state.isCoordinator) return
    state.commitAckReceived = true
    this.driveCommit(state)
  }

  handleRememberFinalize(message: RememberFinalize, peerKey: string): void {
    const state = this.commits.get(peerKey)
    if (!state) {
      this.earlyFinalizes.set(peerKey, message.transactionId)
      return
    }
    if (state.transactionId !== message.transactionId || state.isCoordinator) return
    void this.finalizeParticipant(state)
  }

  async vote(input: RememberVoteInput): Promise<RememberVoteReply> {
    const { transferId, peerKey, vote, isMine } = input
    if (typeof transferId !== 'string' || transferId.length === 0) {
      throw new BadRequestError('rememberVote: transferId required')
    }
    if (typeof peerKey !== 'string' || peerKey.length === 0) {
      throw new BadRequestError('rememberVote: peerKey required')
    }
    if (vote !== 'remember' && vote !== 'no') {
      throw new BadRequestError('rememberVote: vote must be "remember" or "no"')
    }
    if (typeof isMine !== 'boolean') {
      throw new BadRequestError('rememberVote: isMine must be a boolean')
    }

    this.ourVotes.set(peerKey, { transferId, decision: vote, isMine, sent: false })
    if (vote === 'remember') {
      this.startTimeout(peerKey, transferId)
      await this.deviceIdentityReady.catch(() => {})
      if (this.ourVotes.has(peerKey)) this.sendPairingInfo(peerKey)
    } else {
      this.clearTimer(peerKey)
    }

    this.sendOurVoteIfCompatible(peerKey)
    this.evaluateVote(peerKey)
    return { ok: true }
  }

  onPeerDisconnected(peerKey: string): void {
    if (this.commits.has(peerKey)) {
      // The sidecar journal is the owner now. Drop only ephemeral routing state;
      // recovery is driven by authenticated pairing-info on the next session.
      this.clearEphemeralPeer(peerKey)
      return
    }

    const our = this.ourVotes.get(peerKey)
    const remote = this.remoteVotes.get(peerKey)
    if (our || remote) {
      this.emit(createRememberDeclinedEvent(peerKey, our?.transferId ?? remote?.transferId ?? ''))
    }
    this.cleanupPeer(peerKey)
  }

  reset(): void {
    for (const peerKey of [...this.timers.keys()]) this.clearTimer(peerKey)
    for (const peerKey of [...this.pairingInfoRetryTimers.keys()]) this.clearPairingInfoRetry(peerKey)
    for (const peerKey of [...this.commitRetryTimers.keys()]) this.clearCommitRetry(peerKey)
    this.ourVotes.clear()
    this.remoteVotes.clear()
    this.pendingPairings.clear()
    this.sentPairingInfo.clear()
    this.commits.clear()
    this.earlyPrepares.clear()
    this.earlyCommits.clear()
    this.earlyCommitAcks.clear()
    this.earlyFinalizes.clear()
  }

  private sendOurVoteIfCompatible(peerKey: string): void {
    const our = this.ourVotes.get(peerKey)
    if (!our || our.sent) return

    if (our.decision === 'no') {
      our.sent = true
      this.deps.sendTo(peerKey, {
        type: 'remember-vote',
        transferId: our.transferId,
        vote: 'no',
        isMine: our.isMine
      })
      return
    }

    const pending = this.pendingPairings.get(peerKey)
    if (!pending) return

    if (!pending.remoteRememberCommitV2) {
      // Never expose a positive vote to a legacy peer: an old coordinator may
      // immediately persist it using the unsafe one-sided commit protocol.
      our.sent = true
      this.deps.sendTo(peerKey, {
        type: 'remember-vote',
        transferId: our.transferId,
        vote: 'no',
        isMine: our.isMine
      })
      this.emit(createRememberDeclinedEvent(peerKey, our.transferId))
      this.cleanupPeer(peerKey)
      return
    }

    our.sent = true
    this.deps.sendTo(peerKey, {
      type: 'remember-vote',
      transferId: our.transferId,
      vote: 'remember',
      isMine: our.isMine
    })
  }

  private evaluateVote(peerKey: string): void {
    if (this.commits.has(peerKey)) return
    const our = this.ourVotes.get(peerKey)
    const remoteEntry = this.remoteVotes.get(peerKey)
    const remote =
      remoteEntry && remoteEntry.transferId === our?.transferId ? remoteEntry.decision : null
    const status = resolveVote(our ? { decision: our.decision, isMine: our.isMine } : null, remote)

    if (status === 'pending') return
    if (status === 'confirmed') {
      const pending = this.pendingPairings.get(peerKey)
      if (!pending || !our) return
      if (!pending.remoteRememberCommitV2) {
        this.emit(createRememberDeclinedEvent(peerKey, our.transferId))
        this.cleanupPeer(peerKey)
        return
      }
      const peer = buildRememberedPeer(
        pending,
        { decision: our.decision, isMine: our.isMine },
        Date.now()
      )
      const state = this.createCommitState(peerKey, our.transferId, pending, peer, 'prepared')
      this.commits.set(peerKey, state)
      const early = this.earlyPrepares.get(peerKey)
      if (early === state.transactionId) state.remotePrepared = true
      this.earlyPrepares.delete(peerKey)
      this.clearTimer(peerKey)
      void this.prepareCommit(state)
      return
    }

    this.emit(createRememberDeclinedEvent(peerKey, our?.transferId ?? ''))
    this.cleanupPeer(peerKey)
  }

  private createCommitState(
    peerKey: string,
    transferId: string,
    pending: PendingPairing,
    peer: RememberedPeer,
    phase: RememberTransactionPhase
  ): CommitState {
    if (!this.deviceIdentity) throw new Error('RememberCoordinator: device identity unavailable')
    const localHex = b4a.toString(this.deviceIdentity.publicKey, 'hex')
    const remoteHex = b4a.toString(pending.remoteDevicePubkey, 'hex')
    return {
      peerKey,
      transferId,
      transactionId: buildRememberTransactionId(
        this.deviceIdentity.publicKey,
        pending.remoteDevicePubkey
      ),
      peer,
      isCoordinator: localHex < remoteHex,
      phase,
      localPrepared: false,
      remotePrepared: false,
      commitReceived: false,
      commitAckReceived: false,
      commandSent: false,
      operationInFlight: false,
      savedPeer: null
    }
  }

  private recordFor(state: CommitState, phase = state.phase): RememberTransactionRecord {
    return {
      version: 1,
      transactionId: state.transactionId,
      transferId: state.transferId,
      remoteDevicePubkey: state.peer.remoteDevicePubkey,
      peer: state.peer,
      phase,
      updatedAt: Date.now()
    }
  }

  private async prepareCommit(state: CommitState): Promise<void> {
    try {
      await this.deps.rememberedStore.saveRememberTransaction(this.recordFor(state, 'prepared'))
      if (this.commits.get(state.peerKey) !== state) return
      state.phase = 'prepared'
      state.localPrepared = true
      this.deps.sendTo(state.peerKey, {
        type: 'remember-prepare',
        transactionId: state.transactionId,
        transferId: state.transferId
      })
      this.driveCommit(state)
    } catch (err) {
      console.warn('RememberCoordinator: failed to persist remember prepare journal', err)
      this.emit(createRememberDeclinedEvent(state.peerKey, state.transferId))
      this.cleanupPeer(state.peerKey)
    }
  }

  private driveCommit(state: CommitState): void {
    if (!state.localPrepared || this.commits.get(state.peerKey) !== state) return

    if (state.isCoordinator) {
      if (state.remotePrepared && !state.commandSent) {
        state.commandSent = true
        this.deps.sendTo(state.peerKey, {
          type: 'remember-commit',
          transactionId: state.transactionId
        })
      }
      if (state.commitAckReceived) void this.commitCoordinator(state)
      return
    }

    if (state.commitReceived) void this.commitParticipant(state)
  }

  private async commitParticipant(state: CommitState): Promise<void> {
    if (state.operationInFlight) return
    state.operationInFlight = true
    try {
      const saved = await this.deps.rememberedStore.remember(state.peer)
      await this.deps.rememberedStore.saveRememberTransaction(
        this.recordFor(state, 'participant-committed')
      )
      if (this.commits.get(state.peerKey) !== state) return
      state.phase = 'participant-committed'
      state.savedPeer = saved
      this.deps.sendTo(state.peerKey, {
        type: 'remember-commit-ack',
        transactionId: state.transactionId
      })
    } catch (err) {
      console.warn('RememberCoordinator: participant commit failed; transaction remains recoverable', err)
      this.scheduleCommitRetry(state, () => this.commitParticipant(state))
    } finally {
      state.operationInFlight = false
    }
  }

  private async commitCoordinator(state: CommitState): Promise<void> {
    if (state.operationInFlight) return
    state.operationInFlight = true
    try {
      const saved = await this.deps.rememberedStore.remember(state.peer)
      await this.deps.rememberedStore.saveRememberTransaction(
        this.recordFor(state, 'coordinator-committed')
      )
      if (this.commits.get(state.peerKey) !== state) return
      state.phase = 'coordinator-committed'
      state.savedPeer = saved
      this.deps.sendTo(state.peerKey, {
        type: 'remember-finalize',
        transactionId: state.transactionId
      })
      await this.deps.rememberedStore.deleteRememberTransaction(state.peer.remoteDevicePubkey)
      this.emit(createRememberConfirmedEvent(state.peerKey, saved))
      this.cleanupPeer(state.peerKey)
    } catch (err) {
      console.warn('RememberCoordinator: coordinator commit failed; transaction remains recoverable', err)
      this.scheduleCommitRetry(state, () => this.commitCoordinator(state))
    } finally {
      state.operationInFlight = false
    }
  }

  private async finalizeParticipant(state: CommitState): Promise<void> {
    if (state.phase !== 'participant-committed') return
    try {
      const saved = state.savedPeer ?? (await this.deps.rememberedStore.get(state.peer.remoteDevicePubkey))
      if (!saved) return
      await this.deps.rememberedStore.deleteRememberTransaction(state.peer.remoteDevicePubkey)
      this.emit(createRememberConfirmedEvent(state.peerKey, saved))
      this.cleanupPeer(state.peerKey)
    } catch (err) {
      console.warn('RememberCoordinator: participant finalize failed; journal retained', err)
    }
  }

  private async recoverTransaction(peerKey: string, pending: PendingPairing): Promise<boolean> {
    if (!this.deviceIdentity) return false
    const remoteHex = b4a.toString(pending.remoteDevicePubkey, 'hex')
    let record: RememberTransactionRecord | null
    try {
      record = await this.deps.rememberedStore.getRememberTransaction(remoteHex)
    } catch (err) {
      console.warn('RememberCoordinator: failed to read remember transaction journal', err)
      return false
    }
    if (!record) return false

    const expected = buildRememberTransactionId(this.deviceIdentity.publicKey, pending.remoteDevicePubkey)
    if (record.transactionId !== expected) {
      console.warn('RememberCoordinator: ignoring remember journal with unexpected transaction id')
      return false
    }

    const state = this.createCommitState(
      peerKey,
      record.transferId,
      pending,
      record.peer,
      record.phase
    )
    state.localPrepared = true
    this.commits.set(peerKey, state)
    this.clearTimer(peerKey)

    const earlyPrepare = this.earlyPrepares.get(peerKey)
    if (earlyPrepare === state.transactionId) state.remotePrepared = true
    this.earlyPrepares.delete(peerKey)

    const earlyCommit = this.earlyCommits.get(peerKey)
    const earlyAck = this.earlyCommitAcks.get(peerKey)
    const earlyFinalize = this.earlyFinalizes.get(peerKey)
    this.earlyCommits.delete(peerKey)
    this.earlyCommitAcks.delete(peerKey)
    this.earlyFinalizes.delete(peerKey)

    if (
      (record.phase === 'coordinator-committed' && !state.isCoordinator) ||
      (record.phase === 'participant-committed' && state.isCoordinator)
    ) {
      console.warn('RememberCoordinator: remember journal phase does not match deterministic role')
      return true
    }

    if (record.phase === 'coordinator-committed' && state.isCoordinator) {
      const saved = await this.deps.rememberedStore.get(remoteHex)
      if (saved) {
        this.deps.sendTo(peerKey, { type: 'remember-finalize', transactionId: state.transactionId })
        await this.deps.rememberedStore.deleteRememberTransaction(remoteHex)
        this.emit(createRememberConfirmedEvent(peerKey, saved))
        this.cleanupPeer(peerKey)
      } else {
        state.phase = 'prepared'
        await this.deps.rememberedStore.saveRememberTransaction(this.recordFor(state, 'prepared'))
        this.deps.sendTo(peerKey, {
          type: 'remember-prepare',
          transactionId: state.transactionId,
          transferId: state.transferId
        })
        this.driveCommit(state)
      }
      return true
    }

    if (record.phase === 'participant-committed' && !state.isCoordinator) {
      state.savedPeer = await this.deps.rememberedStore.get(remoteHex)
      if (state.savedPeer) {
        this.deps.sendTo(peerKey, {
          type: 'remember-commit-ack',
          transactionId: state.transactionId
        })
        if (earlyFinalize === state.transactionId) void this.finalizeParticipant(state)
      } else {
        state.phase = 'prepared'
        await this.deps.rememberedStore.saveRememberTransaction(this.recordFor(state, 'prepared'))
        this.deps.sendTo(peerKey, {
          type: 'remember-prepare',
          transactionId: state.transactionId,
          transferId: state.transferId
        })
        if (earlyCommit === state.transactionId) {
          state.commitReceived = true
          this.driveCommit(state)
        }
      }
      return true
    }

    this.deps.sendTo(peerKey, {
      type: 'remember-prepare',
      transactionId: state.transactionId,
      transferId: state.transferId
    })
    if (!state.isCoordinator && earlyCommit === state.transactionId) {
      state.commitReceived = true
    }
    if (state.isCoordinator && earlyAck === state.transactionId) {
      state.commitAckReceived = true
    }
    this.driveCommit(state)
    return true
  }

  private async repairCompletedCoordinator(peerKey: string, transactionId: string): Promise<void> {
    const pending = this.pendingPairings.get(peerKey)
    if (!pending || !this.deviceIdentity) return
    const expected = buildRememberTransactionId(this.deviceIdentity.publicKey, pending.remoteDevicePubkey)
    if (expected !== transactionId) return
    const localHex = b4a.toString(this.deviceIdentity.publicKey, 'hex')
    const remoteHex = b4a.toString(pending.remoteDevicePubkey, 'hex')
    if (localHex >= remoteHex) return
    const known = await this.deps.rememberedStore.get(remoteHex)
    if (known) {
      this.deps.sendTo(peerKey, { type: 'remember-commit', transactionId })
    }
  }

  private async finalizeAlreadyCommitted(peerKey: string, transactionId: string): Promise<void> {
    const pending = this.pendingPairings.get(peerKey)
    if (!pending || !this.deviceIdentity) return
    const expected = buildRememberTransactionId(this.deviceIdentity.publicKey, pending.remoteDevicePubkey)
    if (expected !== transactionId) return
    const localHex = b4a.toString(this.deviceIdentity.publicKey, 'hex')
    const remoteHex = b4a.toString(pending.remoteDevicePubkey, 'hex')
    if (localHex >= remoteHex) return
    const known = await this.deps.rememberedStore.get(remoteHex)
    if (!known) return
    this.deps.sendTo(peerKey, { type: 'remember-finalize', transactionId })
  }

  private scheduleCommitRetry(state: CommitState, retry: () => Promise<void>): void {
    if (this.commits.get(state.peerKey) !== state || this.commitRetryTimers.has(state.peerKey)) return
    const timer = setTimeout(() => {
      if (this.commitRetryTimers.get(state.peerKey) !== timer) return
      this.commitRetryTimers.delete(state.peerKey)
      if (this.commits.get(state.peerKey) === state) void retry()
    }, COMMIT_RETRY_MS)
    this.commitRetryTimers.set(state.peerKey, timer)
  }

  private sendPairingInfo(peerKey: string, attempt = 0): void {
    if (this.sentPairingInfo.has(peerKey)) return
    if (!this.deviceIdentity) return
    const handshakeHash = this.deps.getHandshakeHash(peerKey)
    if (!handshakeHash) {
      if (attempt < 8) {
        this.clearPairingInfoRetry(peerKey)
        const timer = setTimeout(() => {
          if (this.pairingInfoRetryTimers.get(peerKey) !== timer) return
          this.pairingInfoRetryTimers.delete(peerKey)
          this.sendPairingInfo(peerKey, attempt + 1)
        }, 150)
        this.pairingInfoRetryTimers.set(peerKey, timer)
      }
      return
    }
    this.clearPairingInfoRetry(peerKey)
    this.deps.sendTo(
      peerKey,
      buildPairingInfo(this.deviceIdentity, handshakeHash, {
        canBackground: false,
        rememberCommitV2: true
      })
    )
    this.sentPairingInfo.add(peerKey)
  }

  private emit(event: TransferIPCMessage): void {
    try {
      this.deps.emit(event)
    } catch (err) {
      console.warn('RememberCoordinator: event delivery failed', event.type, err)
    }
  }

  private clearPairingInfoRetry(peerKey: string): void {
    const timer = this.pairingInfoRetryTimers.get(peerKey)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.pairingInfoRetryTimers.delete(peerKey)
    }
  }

  private clearCommitRetry(peerKey: string): void {
    const timer = this.commitRetryTimers.get(peerKey)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.commitRetryTimers.delete(peerKey)
    }
  }

  private startTimeout(peerKey: string, transferId: string): void {
    this.clearTimer(peerKey)
    this.timers.set(
      peerKey,
      setTimeout(() => {
        this.timers.delete(peerKey)
        if (this.commits.has(peerKey)) return
        this.emit(createRememberDeclinedEvent(peerKey, transferId))
        this.cleanupPeer(peerKey)
      }, REMEMBER_VOTE_TIMEOUT_MS)
    )
  }

  private clearTimer(peerKey: string): void {
    const timer = this.timers.get(peerKey)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.timers.delete(peerKey)
    }
  }

  private clearEphemeralPeer(peerKey: string): void {
    this.clearTimer(peerKey)
    this.clearPairingInfoRetry(peerKey)
    this.clearCommitRetry(peerKey)
    this.ourVotes.delete(peerKey)
    this.remoteVotes.delete(peerKey)
    this.pendingPairings.delete(peerKey)
    this.sentPairingInfo.delete(peerKey)
    this.commits.delete(peerKey)
    this.earlyPrepares.delete(peerKey)
    this.earlyCommits.delete(peerKey)
    this.earlyCommitAcks.delete(peerKey)
    this.earlyFinalizes.delete(peerKey)
  }

  private cleanupPeer(peerKey: string): void {
    this.clearEphemeralPeer(peerKey)
  }
}
