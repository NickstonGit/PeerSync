// chat.v1 — core-owned encrypted append-only event store.
// Each peer is keyed ONLY by authenticated crypto peerId/deviceId; display
// names are presentation metadata and never participate in persistence keys.
// Append-only MESSAGE/STATE events avoid rewriting/re-encrypting up to 5000
// messages on every delivery-state transition. The log is compacted
// periodically and legacy <peer>.json stores are migrated on first load.

import fsp from 'bare-fs/promises'
import path from 'bare-path'
import b4a from 'b4a'
import { writeFileAtomic } from './pathguard'
import { decodeProtectedJson, encodeProtectedJson } from './protected-json'
import { openFile, bytesWrittenOf } from './fs-handle'
import { isErrnoCode } from './errors'
import { CHAT_HISTORY_MAX_STORED, CHAT_HISTORY_PAGE_MAX, CHAT_HISTORY_RESPONSE_BUDGET, CHAT_MESSAGE_ID_MAX_LEN } from './limits'

export function isValidWireChatMessageId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 30 && value.length <= CHAT_MESSAGE_ID_MAX_LEN && /^[0-9a-fA-F-]+$/.test(value)
}

export interface ChatMessage {
  messageId: string
  direction: 'in' | 'out'
  text: string
  tsMs: number
  state: 'delivered' | 'queued-offline' | 'sent'
}

export interface ChatHistoryPage {
  messages: ChatMessage[]
  nextCursor: string | null
  hasMore: boolean
  staleCursor?: boolean
}

type ChatEvent =
  | { v: 1; type: 'message'; message: ChatMessage }
  | { v: 1; type: 'state'; messageId: string; state: ChatMessage['state'] }

const MAX_STORED = CHAT_HISTORY_MAX_STORED
const COMPACT_EVENT_THRESHOLD = MAX_STORED * 3
const GENERATION_TOMBSTONE_TTL_MS = 30 * 60 * 1000
const MAX_GENERATION_TOMBSTONES = 2048
const GENERATION_SWEEP_INTERVAL_MS = 60 * 1000

function validMessage(m: unknown): m is ChatMessage {
  const x = m as Partial<ChatMessage> | null
  return Boolean(
    x && typeof x.messageId === 'string' && typeof x.text === 'string' &&
    (x.direction === 'in' || x.direction === 'out') &&
    typeof x.tsMs === 'number' && Number.isFinite(x.tsMs) &&
    (x.state === 'delivered' || x.state === 'queued-offline' || x.state === 'sent')
  )
}

function validState(state: unknown): state is ChatMessage['state'] {
  return state === 'delivered' || state === 'queued-offline' || state === 'sent'
}

export class ChatStore {
  private _msgs = new Map<string, ChatMessage[]>()
  private _byId = new Map<string, Map<string, ChatMessage>>()
  private _eventCounts = new Map<string, number>()
  private _dir: string
  private _tails = new Map<string, Promise<void>>()
  private _generations = new Map<string, number>()
  private _generationTouched = new Map<string, number>()
  private _lastGenerationSweep = 0

  constructor(dataRoot: string, private protectedKey: Uint8Array) {
    this._dir = path.join(dataRoot.replace(/[\\]+$/, ''), 'chat')
  }

  generation(peerId: string): number {
    this._sweepGenerationTombstones()
    return this._generations.get(peerId.toLowerCase()) ?? 0
  }

  private _sweepGenerationTombstones(force = false): void {
    const t = Date.now()
    if (!force && t - this._lastGenerationSweep < GENERATION_SWEEP_INTERVAL_MS) return
    this._lastGenerationSweep = t
    const rows = [...this._generationTouched.entries()].sort((a, b) => a[1] - b[1])
    const overflow = Math.max(0, rows.length - MAX_GENERATION_TOMBSTONES)
    for (let i = 0; i < rows.length; i++) {
      const [key, touched] = rows[i]
      if (this._tails.has(key)) continue
      if (i < overflow || t - touched >= GENERATION_TOMBSTONE_TTL_MS) {
        this._generationTouched.delete(key)
        this._generations.delete(key)
      }
    }
  }

  private _withPeer<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this._tails.get(key) ?? Promise.resolve()
    const run = previous.then(fn, fn)
    const tail = run.then(() => undefined, () => undefined)
    this._tails.set(key, tail)
    void tail.finally(() => {
      if (this._tails.get(key) === tail) this._tails.delete(key)
    })
    return run
  }

  async load(peerId: string): Promise<void> {
    const key = peerId.toLowerCase()
    await this._withPeer(key, async () => this._loadUnlocked(key))
  }

  private _legacyPath(key: string): string {
    return path.join(this._dir, `${key}.json`)
  }

  private _logPath(key: string): string {
    return path.join(this._dir, `${key}.events`)
  }

  private _publish(key: string, messages: ChatMessage[], eventCount: number): void {
    const kept = messages.slice(-MAX_STORED)
    this._msgs.set(key, kept)
    this._byId.set(key, new Map(kept.map((m) => [m.messageId, m])))
    this._eventCounts.set(key, eventCount)
  }

  private _applyEvent(messages: ChatMessage[], byId: Map<string, ChatMessage>, event: ChatEvent): void {
    if (event.type === 'message') {
      if (!validMessage(event.message) || byId.has(event.message.messageId)) return
      const msg = { ...event.message }
      messages.push(msg)
      byId.set(msg.messageId, msg)
      if (messages.length > MAX_STORED) {
        const removed = messages.shift()
        if (removed) byId.delete(removed.messageId)
      }
      return
    }
    if (typeof event.messageId !== 'string' || !validState(event.state)) return
    const msg = byId.get(event.messageId)
    if (msg) msg.state = event.state
  }

  private async _loadEventLog(key: string): Promise<boolean> {
    let text: string
    try {
      text = await fsp.readFile(this._logPath(key), 'utf8')
    } catch (err: unknown) {
      if (isErrnoCode(err, 'ENOENT')) return false
      throw err
    }

    const messages: ChatMessage[] = []
    const byId = new Map<string, ChatMessage>()
    const lines = text.split('\n')
    let eventCount = 0
    let truncatedTail = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line.trim()) continue
      try {
        const decoded = decodeProtectedJson<unknown>(line, this.protectedKey).value as Partial<ChatEvent>
        if (decoded?.v !== 1 || (decoded.type !== 'message' && decoded.type !== 'state')) throw new Error('bad event')
        this._applyEvent(messages, byId, decoded as ChatEvent)
        eventCount++
      } catch {
        // A crash can tear the final append. Ignore only that unterminated tail;
        // authenticated corruption in the middle is quarantined instead of
        // silently accepting a damaged history.
        const isLastNonEmpty = lines.slice(i + 1).every((x) => !x.trim())
        if (isLastNonEmpty && !text.endsWith('\n')) {
          truncatedTail = true
          break
        }
        const corrupt = this._logPath(key) + `.corrupt-${Date.now()}`
        await fsp.rename(this._logPath(key), corrupt).catch(() => {})
        throw new Error(`chat event log authentication failed: ${corrupt}`)
      }
    }
    this._msgs.set(key, messages)
    this._byId.set(key, byId)
    this._eventCounts.set(key, eventCount)
    if (truncatedTail || eventCount > COMPACT_EVENT_THRESHOLD) await this._compactUnlocked(key)
    return true
  }

  private async _loadUnlocked(key: string): Promise<void> {
    if (this._msgs.has(key)) return
    await fsp.mkdir(this._dir, { recursive: true })
    if (await this._loadEventLog(key)) return

    let text: string
    try {
      text = await fsp.readFile(this._legacyPath(key), 'utf8')
    } catch (err: unknown) {
      if (isErrnoCode(err, 'ENOENT')) {
        this._publish(key, [], 0)
        return
      }
      throw err
    }

    let decoded: ReturnType<typeof decodeProtectedJson<unknown>>
    try {
      decoded = decodeProtectedJson<unknown>(text, this.protectedKey)
    } catch {
      await fsp.rename(this._legacyPath(key), this._legacyPath(key) + `.corrupt-${Date.now()}`).catch(() => {})
      this._publish(key, [], 0)
      return
    }

    const doc = decoded.value as { messages?: unknown[] } | null
    const messages = (Array.isArray(doc?.messages) ? doc.messages : []).filter(validMessage).slice(-MAX_STORED).map((m) => ({ ...m }))
    this._publish(key, messages, 0)

    // Migration is commit-then-delete: legacy remains the fallback until the
    // encrypted event log has been atomically written successfully.
    try {
      await this._compactUnlocked(key)
      await fsp.unlink(this._legacyPath(key)).catch(() => {})
    } catch {
      // Decoded history stays usable in memory; migration will retry later.
    }
  }

  private async _appendEventUnlocked(key: string, event: ChatEvent): Promise<void> {
    await fsp.mkdir(this._dir, { recursive: true })
    const data = b4a.from(encodeProtectedJson(event, this.protectedKey) + '\n', 'utf8')
    const handle = await openFile(this._logPath(key), 'a')
    try {
      let written = 0
      while (written < data.byteLength) {
        const bytesWritten = bytesWrittenOf(await handle.write(data, written, data.byteLength - written, null))
        if (bytesWritten <= 0) throw new Error('short chat log append')
        written += bytesWritten
      }
    } finally {
      await handle.close().catch(() => {})
    }
    this._eventCounts.set(key, (this._eventCounts.get(key) ?? 0) + 1)
  }

  private async _compactUnlocked(key: string): Promise<void> {
    const messages = this._msgs.get(key) ?? []
    const text = messages.map((message) => encodeProtectedJson(
      { v: 1, type: 'message', message } satisfies ChatEvent,
      this.protectedKey
    )).join('\n') + (messages.length ? '\n' : '')
    await writeFileAtomic(this._logPath(key), text, { sync: false })
    this._eventCounts.set(key, messages.length)
  }

  private async _compactIfNeededUnlocked(key: string): Promise<void> {
    if ((this._eventCounts.get(key) ?? 0) > COMPACT_EVENT_THRESHOLD) await this._compactUnlocked(key)
  }

  async history(peerId: string, limit = 200): Promise<ChatMessage[]> {
    const key = peerId.toLowerCase()
    return await this._withPeer(key, async () => {
      await this._loadUnlocked(key)
      const list = this._msgs.get(key) ?? []
      return list.slice(Math.max(0, list.length - Math.max(1, Math.min(MAX_STORED, limit))))
    })
  }

  /**
   * Page chat history backwards using the oldest messageId from the previous
   * page as an opaque cursor.  Pages are bounded by both count and encoded
   * bytes, so every valid response stays comfortably below the 1 MiB IPC cap.
   */
  async historyPage(peerId: string, before: string | null, limit = 40): Promise<ChatHistoryPage> {
    const key = peerId.toLowerCase()
    return await this._withPeer(key, async () => {
      await this._loadUnlocked(key)
      const list = this._msgs.get(key) ?? []
      let end = list.length
      if (before) {
        const cursorIndex = list.findIndex((message) => message.messageId === before)
        if (cursorIndex < 0) {
          // Retention may evict a cursor if thousands of new messages arrive
          // while the UI is idle.  Never silently restart from the tail because
          // that would duplicate pages; make the client explicitly reconcile.
          return { messages: [], nextCursor: null, hasMore: false, staleCursor: true }
        }
        end = cursorIndex
      }

      const requested = Number.isFinite(limit) ? Math.trunc(limit) : 40
      const pageLimit = Math.max(1, Math.min(CHAT_HISTORY_PAGE_MAX, requested))
      const newestFirst: ChatMessage[] = []
      let encodedBytes = 128 // response envelope + cursor/hasMore headroom
      let index = end - 1

      while (index >= 0 && newestFirst.length < pageLimit) {
        const message = list[index]
        const encoded = JSON.stringify(message)
        const messageBytes = b4a.byteLength(encoded, 'utf8') + 1
        if (newestFirst.length > 0 && encodedBytes + messageBytes > CHAT_HISTORY_RESPONSE_BUDGET) break
        newestFirst.push({ ...message })
        encodedBytes += messageBytes
        index--
      }

      const messages = newestFirst.reverse()
      const hasMore = index >= 0
      return {
        messages,
        nextCursor: hasMore && messages.length > 0 ? messages[0].messageId : null,
        hasMore
      }
    })
  }

  async record(
    peerId: string,
    msg: ChatMessage,
    expectedGeneration?: number,
    onAccepted?: () => void
  ): Promise<{ stored: boolean; stale?: boolean }> {
    const key = peerId.toLowerCase()
    return await this._withPeer(key, async () => {
      if (expectedGeneration !== undefined && expectedGeneration !== this.generation(key)) return { stored: false, stale: true }
      await this._loadUnlocked(key)
      if (expectedGeneration !== undefined && expectedGeneration !== this.generation(key)) return { stored: false, stale: true }
      const byId = this._byId.get(key) ?? new Map<string, ChatMessage>()
      if (byId.has(msg.messageId)) return { stored: false }

      // Preserve the shell UX contract: inbound chat may paint its unread
      // indicator before the filesystem write completes. Persistence is still
      // serialized per peer and no in-memory history mutation happens until
      // the protected append succeeds.
      try { onAccepted?.() } catch {}
      await this._appendEventUnlocked(key, { v: 1, type: 'message', message: msg })
      const stored = { ...msg }
      const list = this._msgs.get(key) ?? []
      list.push(stored)
      byId.set(stored.messageId, stored)
      if (list.length > MAX_STORED) {
        const removed = list.shift()
        if (removed) byId.delete(removed.messageId)
      }
      this._msgs.set(key, list)
      this._byId.set(key, byId)
      await this._compactIfNeededUnlocked(key)
      return { stored: true }
    })
  }

  async markState(peerId: string, messageId: string, state: ChatMessage['state']): Promise<void> {
    const key = peerId.toLowerCase()
    await this._withPeer(key, async () => {
      await this._loadUnlocked(key)
      const msg = this._byId.get(key)?.get(messageId)
      if (!msg || msg.state === state) return
      await this._appendEventUnlocked(key, { v: 1, type: 'state', messageId, state })
      msg.state = state
      await this._compactIfNeededUnlocked(key)
    })
  }

  async pendingFor(peerId: string): Promise<ChatMessage[]> {
    const key = peerId.toLowerCase()
    return await this._withPeer(key, async () => {
      await this._loadUnlocked(key)
      return (this._msgs.get(key) ?? []).filter((m) => m.direction === 'out' && (m.state === 'queued-offline' || m.state === 'sent'))
    })
  }

  forget(peerId: string): void {
    const key = peerId.toLowerCase()
    this._msgs.delete(key)
    this._byId.delete(key)
    this._eventCounts.delete(key)
  }

  private async _unlinkStoredFile(filePath: string): Promise<void> {
    let lastErr: unknown = null
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        await fsp.unlink(filePath)
        return
      } catch (err: unknown) {
        if (isErrnoCode(err, 'ENOENT')) return
        lastErr = err
        if (!isErrnoCode(err, 'EPERM', 'EACCES', 'EBUSY') || attempt === 5) break
        await new Promise<void>((resolve) => setTimeout(() => resolve(), 100 * (attempt + 1)))
      }
    }
    throw lastErr ?? new Error(`failed to remove chat store ${filePath}`)
  }

  async removePeerFile(peerId: string): Promise<void> {
    const key = peerId.toLowerCase()
    await this._withPeer(key, async () => {
      this._generations.set(key, this.generation(key) + 1)
      this._generationTouched.set(key, Date.now())
      // Forget must not report success while a canonical history file is still
      // present: otherwise the same peer can be re-paired after restart and the
      // supposedly deleted conversation silently comes back.
      await Promise.all([
        this._unlinkStoredFile(this._logPath(key)),
        this._unlinkStoredFile(this._legacyPath(key))
      ])
      this._msgs.delete(key)
      this._byId.delete(key)
      this._eventCounts.delete(key)
    })
    this._sweepGenerationTombstones(true)
  }
}
