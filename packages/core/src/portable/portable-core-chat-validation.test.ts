import { describe, expect, it, vi } from 'vitest'
import { PortableCore } from './portable-core'

describe('portable chat IPC validation', () => {
  it('rejects malformed chat.history peer ids before touching persistence', async () => {
    const historyPage = vi.fn(async () => ({ messages: [], nextCursor: null, hasMore: false }))
    const core = new PortableCore(() => {}) as unknown as {
      ready: boolean
      chat: { historyPage: typeof historyPage }
      call: (method: string, payload: unknown) => Promise<unknown>
    }
    core.ready = true
    core.chat = { historyPage }

    await expect(core.call('chat.history', { peerId: '../journals/anything' })).rejects.toMatchObject({
      ipcCode: 'INVALID_REQUEST'
    })
    expect(historyPage).not.toHaveBeenCalled()
  })

  it('normalizes a valid peer id before loading history', async () => {
    const historyPage = vi.fn(async () => ({ messages: [], nextCursor: null, hasMore: false }))
    const core = new PortableCore(() => {}) as unknown as {
      ready: boolean
      chat: { historyPage: typeof historyPage }
      call: (method: string, payload: unknown) => Promise<unknown>
    }
    core.ready = true
    core.chat = { historyPage }
    const peerId = 'A'.repeat(64)

    await core.call('chat.history', { peerId, limit: 20 })
    expect(historyPage).toHaveBeenCalledWith('a'.repeat(64), null, 20)
  })
})
