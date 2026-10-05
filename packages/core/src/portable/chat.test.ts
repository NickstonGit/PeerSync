import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import b4a from 'b4a'
import { ChatStore, isValidWireChatMessageId } from './chat'

const dirs: string[] = []
const KEY = b4a.alloc(32, 7)
const PEER = 'ab'.repeat(32)

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'as-chat-'))
  dirs.push(root)
  return root
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})


describe('wire chat message id validation', () => {
  it('bounds peer-controlled message ids to prevent retained-memory amplification', () => {
    expect(isValidWireChatMessageId('a'.repeat(30))).toBe(true)
    expect(isValidWireChatMessageId('A'.repeat(128))).toBe(true)
    expect(isValidWireChatMessageId('a'.repeat(129))).toBe(false)
    expect(isValidWireChatMessageId('z'.repeat(30))).toBe(false)
  })
})

describe('ChatStore append-only protected log', () => {
  it('persists message/state events without rewriting one giant history blob', async () => {
    const root = tempRoot()
    const store = new ChatStore(root, KEY)
    await store.record(PEER, { messageId: 'm1', direction: 'out', text: 'secret one', tsMs: 1, state: 'sent' })
    await store.record(PEER, { messageId: 'm2', direction: 'in', text: 'secret two', tsMs: 2, state: 'delivered' })
    await store.markState(PEER, 'm1', 'delivered')

    const log = path.join(root, 'chat', `${PEER}.events`)
    const raw = fs.readFileSync(log, 'utf8')
    expect(raw.trim().split('\n')).toHaveLength(3)
    expect(raw).not.toContain('secret one')
    expect(raw).not.toContain('secret two')

    const reloaded = new ChatStore(root, KEY)
    expect(await reloaded.history(PEER, 10)).toEqual([
      { messageId: 'm1', direction: 'out', text: 'secret one', tsMs: 1, state: 'delivered' },
      { messageId: 'm2', direction: 'in', text: 'secret two', tsMs: 2, state: 'delivered' }
    ])
  })

  it('migrates the legacy per-peer json store to protected events', async () => {
    const root = tempRoot()
    const chatDir = path.join(root, 'chat')
    fs.mkdirSync(chatDir, { recursive: true })
    fs.writeFileSync(path.join(chatDir, `${PEER}.json`), JSON.stringify({
      v: 1,
      messages: [{ messageId: 'legacy', direction: 'in', text: 'old', tsMs: 3, state: 'delivered' }]
    }))

    const store = new ChatStore(root, KEY)
    expect((await store.history(PEER, 10))[0]?.messageId).toBe('legacy')
    expect(fs.existsSync(path.join(chatDir, `${PEER}.events`))).toBe(true)
    expect(fs.existsSync(path.join(chatDir, `${PEER}.json`))).toBe(false)
  })


  it('pages history by cursor within a bounded response budget', async () => {
    const root = tempRoot()
    const store = new ChatStore(root, KEY)
    const text = 'x'.repeat(8192)
    for (let i = 0; i < 70; i++) {
      await store.record(PEER, {
        messageId: `page-${String(i).padStart(4, '0')}`,
        direction: i % 2 ? 'in' : 'out',
        text,
        tsMs: i,
        state: 'delivered'
      })
    }

    const seen: string[] = []
    let before: string | null = null
    let pages = 0
    for (;;) {
      const page = await store.historyPage(PEER, before, 64)
      expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThan(600 * 1024)
      seen.unshift(...page.messages.map((message) => message.messageId))
      pages++
      if (!page.hasMore) break
      expect(page.nextCursor).toBeTruthy()
      before = page.nextCursor
    }

    expect(pages).toBeGreaterThan(1)
    expect(seen).toHaveLength(70)
    expect(new Set(seen).size).toBe(70)
    expect(seen[0]).toBe('page-0000')
    expect(seen.at(-1)).toBe('page-0069')
  // 70 durable appends of 8 KiB each, so this test is bound by disk fsync, not
  // by CPU. It needs more than the 5s default once the whole suite runs its
  // files in parallel and competes for the same disk.
  }, 30_000)

  it('marks an evicted or otherwise unknown history cursor as stale', async () => {
    const root = tempRoot()
    const store = new ChatStore(root, KEY)
    await store.record(PEER, { messageId: 'known', direction: 'in', text: 'hello', tsMs: 1, state: 'delivered' })

    expect(await store.historyPage(PEER, 'missing-cursor', 40)).toMatchObject({
      messages: [],
      nextCursor: null,
      hasMore: false,
      staleCursor: true
    })
  })

  it('removes durable history when a peer is forgotten', async () => {
    const root = tempRoot()
    const store = new ChatStore(root, KEY)
    await store.record(PEER, { messageId: 'gone', direction: 'out', text: 'delete me', tsMs: 4, state: 'sent' })

    await store.removePeerFile(PEER)

    const chatDir = path.join(root, 'chat')
    expect(fs.existsSync(path.join(chatDir, `${PEER}.events`))).toBe(false)
    expect(fs.existsSync(path.join(chatDir, `${PEER}.json`))).toBe(false)
    expect(await store.history(PEER, 10)).toEqual([])
  })

})
