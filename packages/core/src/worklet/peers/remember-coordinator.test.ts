import { describe, it, expect, vi } from 'vitest'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { RememberCoordinator, type RememberCoordinatorDeps } from './remember-coordinator'
import { buildPairingInfo } from './pairing'
import type { RememberedPeer } from './remembered-peer'
import type { DeviceIdentity } from '../identity/device-identity-store'
import type { PeerControlMessage, RememberVote } from '../transfer/control-channel'
import type { TransferIPCMessage } from '../rpc/events'
import type { RememberTransactionRecord } from './store'

const handshake = crypto.randomBytes(64)

function makeIdentity(): DeviceIdentity {
  const kp = crypto.keyPair()
  return {
    publicKey: kp.publicKey,
    secretKey: kp.secretKey,
    displayName: 'Device',
    deviceType: 'laptop',
    createdAt: 0
  }
}

function setup(localIdentity: DeviceIdentity = makeIdentity()) {
  const sends: { peerKey: string; message: PeerControlMessage }[] = []
  const emits: TransferIPCMessage[] = []
  const remembered: RememberedPeer[] = []
  const transactions = new Map<string, RememberTransactionRecord>()
  const deps: RememberCoordinatorDeps = {
    deviceIdentityStore: { getOrCreate: async () => localIdentity },
    rememberedStore: {
      get: async () => null,
      remember: async (peer) => {
        remembered.push(peer)
        return peer
      },
      getRememberTransaction: async (pubkey) => transactions.get(pubkey) ?? null,
      saveRememberTransaction: async (record) => {
        transactions.set(record.remoteDevicePubkey, record)
      },
      deleteRememberTransaction: async (pubkey) => {
        transactions.delete(pubkey)
      }
    },
    sendTo: (peerKey, message) => sends.push({ peerKey, message }),
    getHandshakeHash: () => handshake,
    emit: (e) => emits.push(e)
  }
  return { coord: new RememberCoordinator(deps), sends, emits, remembered, transactions }
}

function peer() {
  const id = makeIdentity()
  return {
    key: b4a.toString(id.publicKey, 'hex'),
    info: buildPairingInfo(id, handshake, { canBackground: false, rememberCommitV2: true })
  }
}

const remoteVote = (transferId: string, vote: 'remember' | 'no'): RememberVote => ({
  type: 'remember-vote',
  transferId,
  vote,
  isMine: false
})

const flush = (): Promise<void> => new Promise<void>((resolve) => setTimeout(() => resolve(), 0))

async function completeCommit(
  coord: RememberCoordinator,
  sends: { peerKey: string; message: PeerControlMessage }[],
  peerKey: string
): Promise<void> {
  await flush()
  const prepare = [...sends]
    .reverse()
    .find((entry) => entry.peerKey === peerKey && entry.message.type === 'remember-prepare')
  expect(prepare?.message.type).toBe('remember-prepare')
  if (!prepare || prepare.message.type !== 'remember-prepare') return

  coord.handleRememberPrepare(prepare.message, peerKey)
  await flush()
  const commit = [...sends]
    .reverse()
    .find((entry) => entry.peerKey === peerKey && entry.message.type === 'remember-commit')
  if (commit?.message.type === 'remember-commit') {
    coord.handleRememberCommitAck(
      { type: 'remember-commit-ack', transactionId: prepare.message.transactionId },
      peerKey
    )
  } else {
    coord.handleRememberCommit(
      { type: 'remember-commit', transactionId: prepare.message.transactionId },
      peerKey
    )
    await flush()
    coord.handleRememberFinalize(
      { type: 'remember-finalize', transactionId: prepare.message.transactionId },
      peerKey
    )
  }
  await flush()
}

describe('RememberCoordinator.vote validation', () => {
  it('rejects bad input', async () => {
    const { coord } = setup()
    const k = peer().key
    await expect(
      coord.vote({ transferId: '', peerKey: k, vote: 'remember', isMine: true })
    ).rejects.toThrow()
    await expect(
      coord.vote({ transferId: 't', peerKey: '', vote: 'remember', isMine: true })
    ).rejects.toThrow()
    await expect(
      coord.vote({ transferId: 't', peerKey: k, vote: 'maybe' as never, isMine: true })
    ).rejects.toThrow()
    await expect(
      coord.vote({ transferId: 't', peerKey: k, vote: 'remember', isMine: 'x' as never })
    ).rejects.toThrow()
  })
})

describe('RememberCoordinator two-sided vote', () => {
  it("on 'no' it sends the vote to that peer only, no pairing-info", async () => {
    const { coord, sends } = setup()
    const k = peer().key
    await coord.vote({ transferId: 't1', peerKey: k, vote: 'no', isMine: false })
    expect(sends).toEqual([
      {
        peerKey: k,
        message: { type: 'remember-vote', transferId: 't1', vote: 'no', isMine: false }
      }
    ])
  })

  it('persists and emits confirmed (with peerKey) when both sides vote remember', async () => {
    const { coord, sends, emits, remembered } = setup()
    const p = peer()
    await coord.vote({ transferId: 't1', peerKey: p.key, vote: 'remember', isMine: true })
    await coord.handlePairingInfo(p.info, { peerKey: p.key, handshakeHash: handshake })
    coord.handleRememberVote(remoteVote('t1', 'remember'), p.key)
    await completeCommit(coord, sends, p.key)

    expect(sends.some((s) => s.message.type === 'pairing-info' && s.peerKey === p.key)).toBe(true)
    expect(remembered).toHaveLength(1)
    expect(remembered[0].remoteDevicePubkey).toBe(p.key)
    expect(remembered[0].autoAccept).toBe(true)
    const confirmed = emits.find((e) => e.type === 'remember-confirmed')
    expect(confirmed?.peerKey).toBe(p.key)
    coord.reset()
  })

  it("declines immediately on the remote's 'no'", async () => {
    const { coord, emits, remembered } = setup()
    const p = peer()
    await coord.vote({ transferId: 't1', peerKey: p.key, vote: 'remember', isMine: false })
    coord.handleRememberVote(remoteVote('t1', 'no'), p.key)
    await flush()
    expect(remembered).toHaveLength(0)
    expect(emits.some((e) => e.type === 'remember-declined')).toBe(true)
    coord.reset()
  })

  it('ignores a remote vote from a different transfer', async () => {
    const { coord, remembered } = setup()
    const p = peer()
    await coord.vote({ transferId: 't1', peerKey: p.key, vote: 'remember', isMine: false })
    await coord.handlePairingInfo(p.info, { peerKey: p.key, handshakeHash: handshake })
    coord.handleRememberVote(remoteVote('t2', 'remember'), p.key)
    await flush()
    expect(remembered).toHaveLength(0)
    coord.reset()
  })

  it('emits remember-requested only after authenticated pairing-info is available', async () => {
    const { coord, emits } = setup()
    await flush()
    const p = peer()
    coord.handleRememberVote(remoteVote('t1', 'remember'), p.key)
    expect(emits.filter((e) => e.type === 'remember-requested')).toHaveLength(0)

    await coord.handlePairingInfo(p.info, { peerKey: p.key, handshakeHash: handshake })
    const requested = emits.filter((e) => e.type === 'remember-requested')
    expect(requested).toHaveLength(1)
    expect(requested[0]).toMatchObject({ displayName: 'Device', devicePubkey: p.key })
    coord.reset()
  })

  it('rejects pairing-info whose signature does not match the claimed pubkey', async () => {
    const { coord, remembered } = setup()
    const p = peer()
    const forged = { ...p.info, signature: b4a.toString(crypto.randomBytes(64), 'hex') }
    await coord.vote({ transferId: 't1', peerKey: p.key, vote: 'remember', isMine: false })
    await coord.handlePairingInfo(forged, { peerKey: p.key, handshakeHash: handshake })
    coord.handleRememberVote(remoteVote('t1', 'remember'), p.key)
    await flush()
    expect(remembered).toHaveLength(0)
    coord.reset()
  })

  it('pairs two peers independently in one session (first confirm must not break the second)', async () => {
    const { coord, sends, emits, remembered } = setup()
    const a = peer()
    const b = peer()
    await coord.vote({ transferId: 't1', peerKey: a.key, vote: 'remember', isMine: false })
    await coord.vote({ transferId: 't1', peerKey: b.key, vote: 'remember', isMine: false })

    await coord.handlePairingInfo(a.info, { peerKey: a.key, handshakeHash: handshake })
    coord.handleRememberVote(remoteVote('t1', 'remember'), a.key)
    await completeCommit(coord, sends, a.key)

    await coord.handlePairingInfo(b.info, { peerKey: b.key, handshakeHash: handshake })
    coord.handleRememberVote(remoteVote('t1', 'remember'), b.key)
    await completeCommit(coord, sends, b.key)

    expect(remembered.map((r) => r.remoteDevicePubkey).sort()).toEqual([a.key, b.key].sort())
    const confirmedKeys = emits
      .filter((e) => e.type === 'remember-confirmed')
      .map((e) => e.peerKey)
      .sort()
    expect(confirmedKeys).toEqual([a.key, b.key].sort())
    coord.reset()
  })

  it('declines the request when the peer disconnects before voting', async () => {
    const { coord, emits } = setup()
    const p = peer()
    await coord.vote({ transferId: 't1', peerKey: p.key, vote: 'remember', isMine: false })
    coord.onPeerDisconnected(p.key)
    const declined = emits.find((e) => e.type === 'remember-declined')
    expect(declined?.peerKey).toBe(p.key)
    coord.reset()
  })



  it('does not retry a durable remember commit when only event delivery fails', async () => {
    const localIdentity = makeIdentity()
    const p = peer()
    let rememberCalls = 0
    const transactions = new Map<string, RememberTransactionRecord>()
    const deps: RememberCoordinatorDeps = {
      deviceIdentityStore: { getOrCreate: async () => localIdentity },
      rememberedStore: {
        get: async () => null,
        remember: async (record) => {
          rememberCalls += 1
          return record
        },
        getRememberTransaction: async (pubkey) => transactions.get(pubkey) ?? null,
        saveRememberTransaction: async (record) => {
          transactions.set(record.remoteDevicePubkey, record)
        },
        deleteRememberTransaction: async (pubkey) => {
          transactions.delete(pubkey)
        }
      },
      sendTo: () => undefined,
      getHandshakeHash: () => handshake,
      emit: (event) => {
        if (event.type === 'remember-confirmed') throw new Error('event sink unavailable')
      }
    }
    const coord = new RememberCoordinator(deps)

    await coord.vote({ transferId: 't1', peerKey: p.key, vote: 'remember', isMine: true })
    await coord.handlePairingInfo(p.info, { peerKey: p.key, handshakeHash: handshake })
    coord.handleRememberVote(remoteVote('t1', 'remember'), p.key)
    // Complete the v2 durable handshake. Event delivery failure must not cause
    // a second HyperDB commit.
    const prepare = await (async () => {
      await flush()
      return transactions.get(p.key)
    })()
    expect(prepare).not.toBeNull()
    if (prepare) {
      coord.handleRememberPrepare(
        { type: 'remember-prepare', transactionId: prepare.transactionId, transferId: 't1' },
        p.key
      )
      await flush()
      coord.handleRememberCommitAck(
        { type: 'remember-commit-ack', transactionId: prepare.transactionId },
        p.key
      )
      await flush()
      if (rememberCalls === 0) {
        coord.handleRememberCommit(
          { type: 'remember-commit', transactionId: prepare.transactionId },
          p.key
        )
        await flush()
        coord.handleRememberFinalize(
          { type: 'remember-finalize', transactionId: prepare.transactionId },
          p.key
        )
        await flush()
      }
    }

    expect(rememberCalls).toBe(1)
    coord.reset()
  })

  it('declines after the 60s window if the peer never votes', async () => {
    vi.useFakeTimers()
    try {
      const { coord, emits } = setup()
      const p = peer()
      await coord.vote({ transferId: 't1', peerKey: p.key, vote: 'remember', isMine: true })
      await vi.advanceTimersByTimeAsync(60_000)
      const declined = emits.find((e) => e.type === 'remember-declined')
      expect(declined?.peerKey).toBe(p.key)
    } finally {
      vi.useRealTimers()
    }
  })
})
