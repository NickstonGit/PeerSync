import { afterEach, describe, expect, it, vi } from 'vitest'
import { PortableCore } from './portable-core'
import { PeerManager } from './peers'

const coreTimers = new Set<ReturnType<typeof setTimeout>>()

interface PortableCoreHarness {
  ready: boolean
  peers: unknown
  engine: unknown
  chat: unknown
  journals: unknown
  _schedulePeerOnlineRecovery: (id: string, replacement?: boolean) => void
  _cancelPeerOnlineRecovery: (id: string) => void
  _onPeerOnline: (id: string) => Promise<void>
}

interface PeerManagerHarness {
  _sessions: Map<string, unknown>
  _cache: Map<string, unknown>
  _reconnectAttempts: Map<string, number>
  _reconnectTimers: Map<string, ReturnType<typeof setTimeout>>
  _scheduleReconnect: (peerId: string, topic: string, reason: string) => void
  joinRendezvous: (topic: string) => Promise<void>
  peerPoke: (id: string) => Promise<{ ok: true }>
}

afterEach(() => {
  for (const timer of coreTimers) clearTimeout(timer)
  coreTimers.clear()
  vi.useRealTimers()
})

describe('portable peer-online recovery', () => {
  it('coalesces repeated online edges and starts recovery only after a stable window', async () => {
    vi.useFakeTimers()
    const peerId = 'a'.repeat(64)
    const session = {}
    const resumeAll = vi.fn(async () => ({ started: [], waiting: [] }))
    const core = new PortableCore(() => {}) as unknown as PortableCoreHarness
    core.ready = true
    core.peers = { session: vi.fn(() => session) }
    core.engine = { resumeAll }
    core.chat = { pendingFor: vi.fn(async () => []) }
    core.journals = { list: vi.fn(() => []) }
    core._onPeerOnline = vi.fn(async () => {})

    core._schedulePeerOnlineRecovery(peerId)
    core._schedulePeerOnlineRecovery(peerId)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(core._onPeerOnline).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(core._onPeerOnline).toHaveBeenCalledTimes(1)
    expect(core._onPeerOnline).toHaveBeenCalledWith(peerId)
  })

  it('cancels pending recovery when the peer goes offline', async () => {
    vi.useFakeTimers()
    const peerId = 'b'.repeat(64)
    const core = new PortableCore(() => {}) as unknown as PortableCoreHarness
    core.ready = true
    core.peers = { session: vi.fn(() => ({})) }
    core.chat = { pendingFor: vi.fn(async () => []) }
    core.journals = { list: vi.fn(() => []) }
    core._onPeerOnline = vi.fn(async () => {})

    core._schedulePeerOnlineRecovery(peerId)
    core._cancelPeerOnlineRecovery(peerId)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(core._onPeerOnline).not.toHaveBeenCalled()
  })
})

describe('portable peer reconnect poke', () => {
  it('does not emit another discovery join while the peer session is already online', async () => {
    const peerId = 'c'.repeat(64)
    const manager = new PeerManager(
      'D:/does-not-matter',
      { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64), displayName: 'test', deviceType: 'unknown', createdAt: 0 },
      {},
      {},
      undefined,
      new Uint8Array(32),
      {},
      '',
      false
    ) as unknown as PeerManagerHarness
    manager._sessions = new Map([[peerId, {}]])
    manager._cache = new Map()
    manager.joinRendezvous = vi.fn(async () => {})

    await expect(manager.peerPoke(peerId)).resolves.toEqual({ ok: true })
    expect(manager.joinRendezvous).not.toHaveBeenCalled()
  })

  it('backs off repeated transport reconnects with jitter', async () => {
    vi.useFakeTimers()
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.15)
    const peerId = 'd'.repeat(64)
    const manager = new PeerManager(
      'D:/does-not-matter',
      { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64), displayName: 'test', deviceType: 'unknown', createdAt: 0 },
      {},
      {},
      undefined,
      new Uint8Array(32),
      {},
      '',
      false
    ) as unknown as PeerManagerHarness
    manager._sessions = new Map()
    manager._cache = new Map()
    manager._reconnectAttempts = new Map()
    manager._reconnectTimers = new Map()
    manager.joinRendezvous = vi.fn(async () => {})

    manager._scheduleReconnect(peerId, 'topic-1', 'test')
    expect(manager._reconnectAttempts.get(peerId)).toBe(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(manager.joinRendezvous).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(manager.joinRendezvous).toHaveBeenCalledWith('topic-1')

    manager._scheduleReconnect(peerId, 'topic-1', 'test')
    expect(manager._reconnectAttempts.get(peerId)).toBe(2)
    await vi.advanceTimersByTimeAsync(0)
    expect(manager.joinRendezvous).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(manager.joinRendezvous).toHaveBeenCalledTimes(2)
    random.mockRestore()
  })
})
