import fs from 'bare-fs/promises'
import path from 'bare-path'
import { decodeProtectedJson, encodeProtectedJson } from './protected-json'
import { writeFileAtomic } from './pathguard'
import { isErrnoCode } from './errors'

const PEER_ID_RE = /^[0-9a-f]{64}$/

export class PeerRevocationStore {
  private readonly filePath: string
  private ids = new Set<string>()
  private loaded = false
  private tail: Promise<void> = Promise.resolve()

  constructor(dataRoot: string, private readonly protectedKey: Uint8Array) {
    this.filePath = path.join(dataRoot, 'peer-forgets.json')
  }

  async load(): Promise<void> {
    if (this.loaded) return
    let text: string
    try {
      text = await fs.readFile(this.filePath, 'utf8')
    } catch (err) {
      if (isErrnoCode(err, 'ENOENT')) {
        this.loaded = true
        return
      }
      throw err
    }
    const decoded = decodeProtectedJson<{ version?: unknown; peerIds?: unknown }>(text, this.protectedKey)
    if (decoded.value?.version !== 1 || !Array.isArray(decoded.value.peerIds)) {
      throw new Error('invalid peer forget tombstone store')
    }
    const next = new Set<string>()
    for (const raw of decoded.value.peerIds) {
      const id = String(raw ?? '').toLowerCase()
      if (!PEER_ID_RE.test(id)) throw new Error('invalid peer id in forget tombstone store')
      next.add(id)
    }
    this.ids = next
    this.loaded = true
  }

  has(peerId: string): boolean {
    return this.ids.has(String(peerId ?? '').toLowerCase())
  }

  list(): string[] {
    return [...this.ids]
  }

  async add(peerId: string): Promise<void> {
    const id = String(peerId ?? '').toLowerCase()
    if (!PEER_ID_RE.test(id)) throw new Error('invalid peer id')
    await this.mutate((next) => next.add(id))
  }

  async remove(peerId: string): Promise<void> {
    const id = String(peerId ?? '').toLowerCase()
    if (!PEER_ID_RE.test(id)) return
    await this.mutate((next) => next.delete(id))
  }

  private mutate(change: (next: Set<string>) => unknown): Promise<void> {
    const run = this.tail.then(async () => {
      await this.load()
      const next = new Set(this.ids)
      change(next)
      if (sameSet(next, this.ids)) return
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })
      await writeFileAtomic(
        this.filePath,
        encodeProtectedJson({ version: 1, peerIds: [...next].sort() }, this.protectedKey)
      )
      this.ids = next
    })
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const value of a) if (!b.has(value)) return false
  return true
}
