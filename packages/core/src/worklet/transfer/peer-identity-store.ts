import { TOPIC_KEY_CONTEXT } from '../../transport-compat'
import b4a from 'b4a'
import fs from 'bare-fs'
import crypto from 'hypercore-crypto'
import { isValidHexKey } from './utils'

export interface NoiseKeyPair {
  publicKey: Uint8Array
  secretKey: Uint8Array
}

interface SerializedKeyPair {
  publicKey: string
  secretKey: string
}

const HEX_RE = /^[0-9a-f]+$/i
const PORTABLE_TOPIC_KEY_CONTEXT = b4a.from(TOPIC_KEY_CONTEXT, 'utf8')
function isHexString(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length % 2 === 0 && HEX_RE.test(value)
  )
}

function isValidSerializedKeyPair(value: unknown): value is SerializedKeyPair {
  if (!value || typeof value !== 'object') return false
  const v = value as { publicKey?: unknown; secretKey?: unknown }
  return isHexString(v.publicKey) && isHexString(v.secretKey)
}

function sanitizeTopics(raw: object): Record<string, SerializedKeyPair> {
  const valid: Record<string, SerializedKeyPair> = {}
  let dropped = 0
  for (const [topicHex, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (isValidHexKey(topicHex) && isValidSerializedKeyPair(entry)) {
      valid[topicHex.toLowerCase()] = entry
    } else {
      dropped++
    }
  }
  if (dropped > 0) {
    console.warn(`PeerIdentityStore: dropped ${dropped} invalid identity entries`)
  }
  return valid
}

interface IdentityFile {
  version: 1
  topics: Record<string, SerializedKeyPair>
}

export class PeerIdentityStore {
  private readonly root: string
  private readonly filePath: string
  private cache: IdentityFile | null = null
  private opQueue: Promise<unknown> = Promise.resolve()
  private dirEnsured: Promise<void> | null = null

  constructor(root: string, private derivationSecret?: Uint8Array) {
    this.root = root
    this.filePath = `${root}/topic-keys.json`
  }

  async getOrCreate(topicHex: string): Promise<NoiseKeyPair> {
    const key = normalizeTopic(topicHex)
    if (this.derivationSecret) {
      const seed = crypto.hash([PORTABLE_TOPIC_KEY_CONTEXT, this.derivationSecret, b4a.from(key, 'hex')])
      return crypto.keyPair(seed)
    }
    return this.run(async () => {
      const file = await this.load()
      const existing = file.topics[key]
      if (existing) return deserialize(existing)

      const fresh = crypto.keyPair()
      const next: IdentityFile = {
        version: 1,
        topics: { ...file.topics, [key]: serialize(fresh) }
      }
      await this.save(next)
      return fresh
    })
  }

  async delete(topicHex: string): Promise<void> {
    const key = normalizeTopic(topicHex)
    if (this.derivationSecret) return
    await this.run(async () => {
      const file = await this.load()
      if (!(key in file.topics)) return
      const remaining: Record<string, SerializedKeyPair> = {}
      for (const [k, v] of Object.entries(file.topics)) {
        if (k !== key) remaining[k] = v
      }
      await this.save({ version: 1, topics: remaining })
    })
  }

  async clear(): Promise<void> {
    if (this.derivationSecret) return
    await this.run(async () => {
      await this.save({ version: 1, topics: {} })
    })
  }


  /** Portable mode no longer persists topic private keys. Remove the legacy
   * plaintext store once the DPAPI-derived deterministic mode is active. */
  async clearLegacyPersisted(): Promise<void> {
    if (!this.derivationSecret) return
    this.cache = null
    try {
      await fs.promises.unlink(this.filePath)
    } catch (err) {
      if ((err as { code?: string })?.code !== 'ENOENT') throw err
    }
    try {
      await fs.promises.unlink(`${this.filePath}.tmp`)
    } catch {}
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.opQueue.catch(() => undefined).then(fn)
    this.opQueue = next
    return next
  }

  private async load(): Promise<IdentityFile> {
    if (this.cache) return this.cache
    try {
      const raw = (await fs.promises.readFile(this.filePath, 'utf8')) as string
      const parsed = JSON.parse(raw) as { version?: unknown; topics?: unknown }
      if (parsed?.version === 1 && parsed.topics && typeof parsed.topics === 'object') {
        this.cache = { version: 1, topics: sanitizeTopics(parsed.topics) }
        return this.cache
      }
      console.warn('PeerIdentityStore: identity file shape mismatch — starting fresh')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code !== 'ENOENT') {
        console.warn('PeerIdentityStore: failed to read identity file', err)
      }
    }
    this.cache = { version: 1, topics: {} }
    return this.cache
  }

  private async save(file: IdentityFile): Promise<void> {
    await this.ensureDir()
    const tmpPath = `${this.filePath}.tmp`
    try {
      await fs.promises.writeFile(tmpPath, JSON.stringify(file), 'utf8')
      await fs.promises.rename(tmpPath, this.filePath)
      this.cache = file
    } catch (err) {
      try {
        await fs.promises.unlink(tmpPath)
      } catch {}
      throw err
    }
  }

  private ensureDir(): Promise<void> {
    if (this.dirEnsured) return this.dirEnsured
    const promise = fs.promises.mkdir(this.root, { recursive: true }).catch((err: unknown) => {
      this.dirEnsured = null
      throw err
    })
    this.dirEnsured = promise
    return promise
  }
}

function normalizeTopic(topicHex: string): string {
  if (!isValidHexKey(topicHex)) {
    throw new Error('PeerIdentityStore: invalid topic')
  }
  return topicHex.toLowerCase()
}

function serialize(keyPair: NoiseKeyPair): SerializedKeyPair {
  return {
    publicKey: b4a.toString(keyPair.publicKey, 'hex'),
    secretKey: b4a.toString(keyPair.secretKey, 'hex')
  }
}

function deserialize(serialized: SerializedKeyPair): NoiseKeyPair {
  return {
    publicKey: b4a.from(serialized.publicKey, 'hex'),
    secretKey: b4a.from(serialized.secretKey, 'hex')
  }
}
