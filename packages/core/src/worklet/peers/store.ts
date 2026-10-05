import HyperDB, { type HyperDBInstance } from 'hyperdb'
import fs from 'bare-fs'
import path from 'bare-path'
import definition from '../../../schema/spec/hyperdb/index.js'
import { type RememberedPeer, mergeRememberedPeer, isValidRememberedPeer } from './remembered-peer'
import { normalizeKey } from './normalize-key'

// Persisted HyperDB schema identifier retained for compatibility with existing
// PeerSync state. Treat this as storage format, not product branding.
const COLLECTION = '@altersend/remembered-peers'

const OPEN_TIMEOUT_MS = 4000
const OPEN_RETRY_BACKOFF_MS = 500
const REMEMBER_TRANSACTION_VERSION = 1

type PeerPatch = Partial<Omit<RememberedPeer, 'remoteDevicePubkey'>>

export interface RememberedPeerListSnapshot {
  peers: RememberedPeer[]
  available: boolean
}

export type RememberTransactionPhase = 'prepared' | 'participant-committed' | 'coordinator-committed'

export interface RememberTransactionRecord {
  version: 1
  transactionId: string
  transferId: string
  remoteDevicePubkey: string
  peer: RememberedPeer
  phase: RememberTransactionPhase
  updatedAt: number
}

function isRememberTransactionRecord(value: unknown): value is RememberTransactionRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<RememberTransactionRecord>
  return (
    record.version === REMEMBER_TRANSACTION_VERSION &&
    typeof record.transactionId === 'string' &&
    /^[0-9a-f]{64}$/i.test(record.transactionId) &&
    typeof record.transferId === 'string' &&
    record.transferId.length > 0 &&
    typeof record.remoteDevicePubkey === 'string' &&
    /^[0-9a-f]{64}$/i.test(record.remoteDevicePubkey) &&
    isValidRememberedPeer(record.peer) &&
    (record.phase === 'prepared' ||
      record.phase === 'participant-committed' ||
      record.phase === 'coordinator-committed') &&
    typeof record.updatedAt === 'number' &&
    Number.isFinite(record.updatedAt)
  )
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

export class RememberedPeerStore {
  private readonly dbPath: string
  private readonly transactionDir: string
  private db: HyperDBInstance | null = null
  private closed = false
  private retryOpenAfterMs = 0
  private lastOpenError: Error | null = null
  private openCleanup: Promise<void> | null = null
  private openPoisoned = false
  private opQueue: Promise<unknown> = Promise.resolve()

  constructor(root: string) {
    this.dbPath = `${root}/remembered`
    this.transactionDir = path.join(root, 'remember-transactions')
  }

  async list(): Promise<RememberedPeer[]> {
    return (await this.listSnapshot()).peers
  }

  async listSnapshot(): Promise<RememberedPeerListSnapshot> {
    return this.run(async () => {
      const db = await this.ensureOpen()
      if (!db) return { peers: [], available: false }
      const out: RememberedPeer[] = []
      for await (const record of db.find(COLLECTION, {})) {
        if (isValidRememberedPeer(record)) out.push(record)
      }
      return { peers: out, available: true }
    })
  }

  async get(pubkeyHex: string): Promise<RememberedPeer | null> {
    return this.run(async () => {
      const db = await this.ensureOpen()
      if (!db) return null
      const record = await db.get(COLLECTION, {
        remoteDevicePubkey: normalizeKey(pubkeyHex)
      })
      return isValidRememberedPeer(record) ? record : null
    })
  }

  async remember(peer: RememberedPeer): Promise<RememberedPeer> {
    return this.run(async () => {
      const key = normalizeKey(peer.remoteDevicePubkey)
      const db = await this.ensureOpen(true)
      const existing = await db.get(COLLECTION, { remoteDevicePubkey: key })
      const merged = mergeRememberedPeer(isValidRememberedPeer(existing) ? existing : null, {
        ...peer,
        remoteDevicePubkey: key
      })
      await db.insert(COLLECTION, merged)
      await db.flush()
      return merged
    })
  }

  async getRememberTransaction(remoteDevicePubkey: string): Promise<RememberTransactionRecord | null> {
    return this.run(async () => {
      const normalized = normalizeKey(remoteDevicePubkey)
      const filePath = this.transactionPath(normalized)
      try {
        const raw = (await fs.promises.readFile(filePath, 'utf8')) as string
        const parsed = JSON.parse(raw) as unknown
        if (!isRememberTransactionRecord(parsed)) {
          throw new Error('RememberedPeerStore: invalid remember transaction journal')
        }
        if (
          normalizeKey(parsed.remoteDevicePubkey) !== normalized ||
          normalizeKey(parsed.peer.remoteDevicePubkey) !== normalized
        ) {
          throw new Error('RememberedPeerStore: remember transaction peer identity mismatch')
        }
        return parsed
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
        throw err
      }
    })
  }

  async saveRememberTransaction(record: RememberTransactionRecord): Promise<void> {
    if (!isRememberTransactionRecord(record)) {
      throw new Error('RememberedPeerStore: refusing invalid remember transaction')
    }
    if (normalizeKey(record.remoteDevicePubkey) !== normalizeKey(record.peer.remoteDevicePubkey)) {
      throw new Error('RememberedPeerStore: refusing remember transaction for mismatched peer')
    }
    await this.run(async () => {
      await fs.promises.mkdir(this.transactionDir, { recursive: true })
      const filePath = this.transactionPath(record.remoteDevicePubkey)
      const tmpPath = `${filePath}.tmp`
      try {
        await fs.promises.writeFile(tmpPath, JSON.stringify(record), 'utf8')
        const handle = (await fs.promises.open(tmpPath, 'r+')) as unknown as {
          sync(): Promise<void>
          close(): Promise<void>
        }
        try {
          await handle.sync()
        } finally {
          await handle.close()
        }
        await fs.promises.rename(tmpPath, filePath)
      } catch (err) {
        try {
          await fs.promises.unlink(tmpPath)
        } catch {}
        throw err
      }
    })
  }

  async deleteRememberTransaction(remoteDevicePubkey: string): Promise<void> {
    await this.run(async () => {
      try {
        await fs.promises.unlink(this.transactionPath(remoteDevicePubkey))
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
      }
    })
  }

  async forget(pubkeyHex: string): Promise<void> {
    await this.run(async () => {
      const db = await this.ensureOpen(true)
      await db.delete(COLLECTION, { remoteDevicePubkey: normalizeKey(pubkeyHex) })
      await db.flush()
    })
  }

  async clear(): Promise<void> {
    await this.run(async () => {
      const db = await this.ensureOpen(true)
      const keys: string[] = []
      for await (const record of db.find(COLLECTION, {})) {
        const key = (record as { remoteDevicePubkey?: unknown }).remoteDevicePubkey
        if (typeof key === 'string') keys.push(key)
      }
      for (const remoteDevicePubkey of keys) await db.delete(COLLECTION, { remoteDevicePubkey })
      await db.flush()
    })
  }

  setBlocked(pubkeyHex: string, blocked: boolean): Promise<RememberedPeer | null> {
    return this.patch(pubkeyHex, { blocked })
  }

  rename(pubkeyHex: string, displayName: string): Promise<RememberedPeer | null> {
    const trimmed = displayName.trim()
    if (trimmed.length === 0) {
      throw new Error('RememberedPeerStore: displayName must not be empty')
    }
    return this.patch(pubkeyHex, { displayName: trimmed })
  }

  setMine(pubkeyHex: string, isMine: boolean): Promise<RememberedPeer | null> {
    return this.patch(pubkeyHex, { isMine })
  }

  setAutoAccept(pubkeyHex: string, autoAccept: boolean): Promise<RememberedPeer | null> {
    return this.patch(pubkeyHex, { autoAccept })
  }

  touch(pubkeyHex: string, lastSeenAt: number): Promise<RememberedPeer | null> {
    return this.patch(pubkeyHex, { lastSeenAt })
  }

  async close(): Promise<void> {
    await this.run(async () => {
      this.closed = true
      const cleanup = this.openCleanup
      if (cleanup) await cleanup
      const db = this.db
      this.db = null
      if (db) await db.close()
    })
  }

  private patch(pubkeyHex: string, patch: PeerPatch): Promise<RememberedPeer | null> {
    return this.run(async () => {
      const db = await this.ensureOpen(true)
      const existing = await db.get(COLLECTION, { remoteDevicePubkey: normalizeKey(pubkeyHex) })
      if (!isValidRememberedPeer(existing)) return null
      const next = { ...existing, ...patch }
      await db.insert(COLLECTION, next)
      await db.flush()
      return next
    })
  }

  /**
   * Reads are allowed to degrade while another process owns the RocksDB lock so
   * startup/liveness never depends on the remembered-peer database. Mutations
   * are different: reporting success without a durable write breaks the
   * remember/block/rename contract, so required=true fails explicitly.
   *
   * The unavailable state is deliberately not sticky. A short backoff prevents
   * a hot open loop while still letting the existing coordinator retries recover
   * as soon as the competing store owner releases the lock.
   */
  private async ensureOpen(required: true): Promise<HyperDBInstance>
  private async ensureOpen(required?: false): Promise<HyperDBInstance | null>
  private async ensureOpen(required = false): Promise<HyperDBInstance | null> {
    if (this.closed) throw new Error('RememberedPeerStore: store is closed')
    if (this.db) return this.db
    if (this.openPoisoned) {
      if (required) throw this.unavailableError(this.lastOpenError)
      return null
    }
    if (this.openCleanup) {
      if (required) throw this.unavailableError(this.lastOpenError)
      return null
    }
    if (Date.now() < this.retryOpenAfterMs) {
      if (required) throw this.unavailableError(this.lastOpenError)
      return null
    }
    const db = HyperDB.rocks(this.dbPath, definition)
    try {
      // A read forces the RocksDB engine to open and acquire the file lock, so a
      // contended lock surfaces here (bounded) rather than on every later op.
      await withTimeout(
        db.get(COLLECTION, { remoteDevicePubkey: '00' }),
        OPEN_TIMEOUT_MS,
        'RememberedPeerStore: open timed out (store locked by another instance?)'
      )
      this.db = db
      this.retryOpenAfterMs = 0
      this.lastOpenError = null
      return db
    } catch (err) {
      const cause = err instanceof Error ? err : new Error(String(err))
      this.lastOpenError = cause
      this.retryOpenAfterMs = Date.now() + OPEN_RETRY_BACKOFF_MS
      // A timed-out open is still an active engine lifecycle. Do not create a
      // replacement instance for the same RocksDB path until close() proves the
      // half-open instance is terminal. If close itself fails, poison this
      // store generation and require a process restart rather than risk two
      // owners of the same namespace.
      try {
        const cleanup = Promise.resolve(db.close()).then(
          () => {
            if (this.openCleanup === cleanup) this.openCleanup = null
          },
          (closeErr: unknown) => {
            this.lastOpenError = closeErr instanceof Error ? closeErr : new Error(String(closeErr))
            this.openPoisoned = true
            if (this.openCleanup === cleanup) this.openCleanup = null
          }
        )
        this.openCleanup = cleanup
      } catch (closeErr) {
        this.lastOpenError = closeErr instanceof Error ? closeErr : new Error(String(closeErr))
        this.openPoisoned = true
      }
      console.warn(
        'RememberedPeerStore: remembered store unavailable',
        cause
      )
      if (required) throw this.unavailableError(cause)
      return null
    }
  }

  private transactionPath(remoteDevicePubkey: string): string {
    const normalized = normalizeKey(remoteDevicePubkey)
    if (!/^[0-9a-f]{64}$/.test(normalized)) {
      throw new Error('RememberedPeerStore: invalid remote device key for transaction journal')
    }
    return path.join(this.transactionDir, `${normalized}.json`)
  }

  private unavailableError(cause: Error | null): Error & { code: 'STORE_UNAVAILABLE' } {
    const err = new Error(
      `RememberedPeerStore: persistence unavailable${cause?.message ? `: ${cause.message}` : ''}`
    ) as Error & { code: 'STORE_UNAVAILABLE' }
    err.code = 'STORE_UNAVAILABLE'
    return err
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.opQueue.catch(() => undefined).then(fn)
    this.opQueue = next
    return next
  }
}
