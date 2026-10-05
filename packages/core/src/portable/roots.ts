// Allowed-roots registry (core side). Local ownership and remote sharing are
// deliberately separate: a registered root is always usable by its owner,
// while remote write access is an explicit per-peer grant.

import fs from 'bare-fs/promises'
import { writeFileAtomic } from './pathguard'
import { validateRelativePath } from './pathguard'
import { NAME_MAX_LEN, UUID_RE } from './limits'
import { uuidv4 } from './encoding'
import { decodeProtectedJson, encodeProtectedJson } from './protected-json'
import type { DecodedProtectedJson } from './protected-json'
import { isErrnoCode } from './errors'

const PEER_ID_RE = /^[0-9a-f]{64}$/i

interface NormalizedRootName {
  name: string
  migrated: boolean
}

function trimToUtf16Limit(value: string, max: number): string {
  let out = value.slice(0, max)
  // Avoid persisting a dangling high surrogate when truncating legacy UTF-16.
  const last = out.charCodeAt(out.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1)
  return out
}

function normalizeRootName(value: unknown, options: { migrateLegacyOverlong?: boolean } = {}): NormalizedRootName | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.length <= NAME_MAX_LEN) return { name: trimmed, migrated: trimmed !== value }
  if (!options.migrateLegacyOverlong) return null
  const name = trimToUtf16Limit(trimmed, NAME_MAX_LEN)
  return name ? { name, migrated: true } : null
}

export interface RootInfo {
  rootId: string
  physicalPath: string
  name: string
  /** Remote default/read policy. Remote write is never taken from this bit. */
  perms: { read: boolean; write: boolean }
  /** Explicit remote write grants keyed by remembered device id. */
  peerWrite: Record<string, boolean>
  addedAtMs: number
}

function normalizePhysicalRootPath(value: string): string | null {
  let physicalPath = String(value ?? '').trim().replaceAll('/', '\\')
  // Selecting a drive root in a folder picker yields X:\. Never collapse it
  // to X:, which is drive-relative on Windows and changes meaning by cwd.
  if (/^[A-Za-z]:\\*$/.test(physicalPath)) return `${physicalPath.slice(0, 2)}\\`
  physicalPath = physicalPath.replace(/[\\]+$/, '')
  if (/^[A-Za-z]:\\/.test(physicalPath)) return physicalPath
  // UNC share or a child below it. Require both server and share components.
  if (/^\\\\[^\\]+\\[^\\]+(?:\\.*)?$/.test(physicalPath)) return physicalPath
  return null
}

export class RootsManager {
  private _roots = new Map<string, RootInfo>()
  private _storePath: string
  private _listeners = new Set<() => void>()
  private _mutationTail: Promise<void> = Promise.resolve()
  recoveredCorrupt = false

  constructor(private dataRoot: string, private protectedKey: Uint8Array) {
    this._storePath = `${this.dataRoot.replace(/[\\/]+$/, '')}\\roots.json`
  }

  onChange(fn: () => void): () => void {
    this._listeners.add(fn)
    return () => this._listeners.delete(fn)
  }

  async load(): Promise<void> {
    let text: string
    try {
      text = await fs.readFile(this._storePath, 'utf8')
    } catch (err: unknown) {
      if (isErrnoCode(err, 'ENOENT')) return
      // An unreadable store is an operational failure, not proof of
      // corruption. Do not silently discard a registry on EACCES/IO errors.
      throw err
    }

    let decoded: DecodedProtectedJson<{ version?: unknown; roots?: unknown } | null>
    try {
      decoded = decodeProtectedJson<{ version?: unknown; roots?: unknown } | null>(text, this.protectedKey)
      if (decoded.value?.version !== 1 || !Array.isArray(decoded.value.roots)) {
        throw new Error('roots document shape')
      }
    } catch {
      await this._quarantine()
      this.recoveredCorrupt = true
      this._roots = new Map()
      return
    }

    const candidate = new Map<string, RootInfo>()
    let droppedInvalidEntry = false
    let migratedEntry = false
    for (const raw of decoded.value!.roots as unknown[]) {
      const normalized = this._normalize(raw)
      if (!normalized || candidate.has(normalized.root.rootId)) {
        // One legacy/bad entry must not erase every valid share. Keep the
        // authenticated document's valid rows and atomically rewrite it clean.
        droppedInvalidEntry = true
        continue
      }
      if (normalized.migrated) migratedEntry = true
      candidate.set(normalized.root.rootId, normalized.root)
    }

    // Plaintext -> protected migration and per-entry recovery are operational
    // writes. Legacy names accepted by older create-paths are migrated in place
    // instead of making the entire root disappear after restart.
    if (!decoded.encrypted || droppedInvalidEntry || migratedEntry) await this._write(candidate)
    this.recoveredCorrupt = droppedInvalidEntry
    this._roots = candidate
  }

  private _normalize(raw: unknown): { root: RootInfo; migrated: boolean } | null {
    if (!raw || typeof raw !== 'object') return null
    const r = raw as Record<string, unknown>
    const perms = r.perms && typeof r.perms === 'object' ? (r.perms as Record<string, unknown>) : null
    const physicalPath = typeof r.physicalPath === 'string' ? normalizePhysicalRootPath(r.physicalPath) : null
    const normalizedName = normalizeRootName(r.name, { migrateLegacyOverlong: true })
    if (
      typeof r.rootId !== 'string' || !UUID_RE.test(r.rootId) ||
      !physicalPath ||
      !normalizedName ||
      !perms || typeof perms.read !== 'boolean'
    ) return null

    const peerWrite: Record<string, boolean> = {}
    if (r.peerWrite !== undefined) {
      if (!r.peerWrite || typeof r.peerWrite !== 'object' || Array.isArray(r.peerWrite)) return null
      for (const [peerId, allowed] of Object.entries(r.peerWrite as Record<string, unknown>)) {
        if (!PEER_ID_RE.test(peerId) || typeof allowed !== 'boolean') return null
        if (allowed) peerWrite[peerId.toLowerCase()] = true
      }
    }

    const normalizedAddedAt = typeof r.addedAtMs === 'number' && Number.isFinite(r.addedAtMs) ? r.addedAtMs : Date.now()
    return {
      root: {
        rootId: r.rootId,
        physicalPath,
        name: normalizedName.name,
        // Legacy global write=true is intentionally NOT migrated. Remote write
        // becomes deny-by-default and must be granted for a concrete peer.
        perms: { read: perms.read, write: false },
        peerWrite,
        addedAtMs: normalizedAddedAt
      },
      migrated: normalizedName.migrated || normalizedAddedAt !== r.addedAtMs
    }
  }

  private async _quarantine(): Promise<void> {
    try {
      await fs.rename(this._storePath, `${this._storePath}.corrupt-${Date.now()}`)
    } catch {}
  }

  private async _write(roots: Map<string, RootInfo>): Promise<void> {
    const payload = encodeProtectedJson({ version: 1, roots: [...roots.values()] }, this.protectedKey)
    await writeFileAtomic(this._storePath, payload)
  }

  private async _commit(next: Map<string, RootInfo>): Promise<void> {
    // Durable state first, live state second. A failed disk write leaves both
    // the previous in-memory registry and the previous file intact.
    await this._write(next)
    this._roots = next
    for (const fn of this._listeners) fn()
  }

  private _serializeMutation<T>(fn: () => Promise<T>): Promise<T> {
    const run = this._mutationTail.then(fn, fn)
    this._mutationTail = run.then(() => undefined, () => undefined)
    return run
  }

  list(): RootInfo[] {
    return [...this._roots.values()].map(cloneRoot)
  }

  get(rootId: string): RootInfo | null {
    const root = this._roots.get(rootId)
    return root ? cloneRoot(root) : null
  }

  async add(input: { path: string; name?: string; perms?: Partial<RootInfo['perms']> }): Promise<RootInfo> {
    const physicalPath = normalizePhysicalRootPath(input.path)
    if (!physicalPath) {
      throw new Error(`roots.addLocal: absolute native path required, got "${input.path}"`)
    }
    const fallbackName = physicalPath.split(/[\\/]/).pop() || physicalPath
    const normalizedName = normalizeRootName(input.name && input.name.trim() ? input.name : fallbackName)
    if (!normalizedName) throw new Error(`root name must be 1-${NAME_MAX_LEN} characters`)
    const st = await fs.lstat(physicalPath).catch(() => null)
    if (!st || !st.isDirectory() || st.isSymbolicLink()) throw new Error('root path is not a real existing directory')
    return await this._serializeMutation(async () => {
      for (const r of this._roots.values()) {
        if ((normalizePhysicalRootPath(r.physicalPath) ?? r.physicalPath).toUpperCase() === physicalPath.toUpperCase()) return cloneRoot(r)
      }
      const root: RootInfo = {
        rootId: uuidv4(),
        physicalPath,
        name: normalizedName.name,
        perms: { read: input.perms?.read ?? true, write: false },
        peerWrite: {},
        addedAtMs: Date.now()
      }
      const next = new Map(this._roots)
      next.set(root.rootId, root)
      await this._commit(next)
      return cloneRoot(root)
    })
  }

  async rename(rootId: string, name: string): Promise<void> {
    const normalizedName = normalizeRootName(name)
    if (!normalizedName) throw new Error(`root name must be 1-${NAME_MAX_LEN} characters`)
    await this._serializeMutation(async () => {
      const current = this._roots.get(rootId)
      if (!current) throw new Error('root not found')
      const next = cloneMap(this._roots)
      next.set(rootId, { ...cloneRoot(current), name: normalizedName.name })
      await this._commit(next)
    })
  }

  async setPerms(rootId: string, perms: Partial<RootInfo['perms']>): Promise<void> {
    await this._serializeMutation(async () => {
      const current = this._roots.get(rootId)
      if (!current) throw new Error('root not found')
      const next = cloneMap(this._roots)
      const updated = cloneRoot(current)
      if (typeof perms.read === 'boolean') updated.perms.read = perms.read
      // Global remote write is intentionally unsupported. Keep the field false
      // for wire/API compatibility and use setPeerPerms for write grants.
      updated.perms.write = false
      next.set(rootId, updated)
      await this._commit(next)
    })
  }

  async setPeerPerms(rootId: string, peerId: string, perms: { write?: boolean }): Promise<void> {
    const id = String(peerId ?? '').toLowerCase()
    if (!PEER_ID_RE.test(id)) throw new Error('invalid peer id')
    await this._serializeMutation(async () => {
      const current = this._roots.get(rootId)
      if (!current) throw new Error('root not found')
      const next = cloneMap(this._roots)
      const updated = cloneRoot(current)
      if (perms.write === true) updated.peerWrite[id] = true
      else delete updated.peerWrite[id]
      next.set(rootId, updated)
      await this._commit(next)
    })
  }

  async revokePeer(peerId: string): Promise<void> {
    const id = String(peerId ?? '').toLowerCase()
    if (!PEER_ID_RE.test(id)) return
    await this._serializeMutation(async () => {
      let changed = false
      const next = cloneMap(this._roots)
      for (const [rootId, root] of next) {
        if (root.peerWrite[id] === true) {
          delete root.peerWrite[id]
          next.set(rootId, root)
          changed = true
        }
      }
      if (changed) await this._commit(next)
    })
  }

  canPeer(rootId: string, peerId: string, perm: 'read' | 'write'): boolean {
    const root = this._roots.get(rootId)
    if (!root) return false
    const id = String(peerId ?? '').toLowerCase()
    if (!PEER_ID_RE.test(id)) return false
    if (perm === 'read') return root.perms.read
    return root.peerWrite[id] === true
  }

  async remove(rootId: string): Promise<RootInfo | null> {
    return await this._serializeMutation(async () => {
      const current = this._roots.get(rootId)
      if (!current) return null
      const next = cloneMap(this._roots)
      next.delete(rootId)
      await this._commit(next)
      return cloneRoot(current)
    })
  }

  /** Roots visible to a concrete peer. Physical paths and ACL internals never leave. */
  forPeer(peerId: string): Array<{ rootId: string; name: string; perms: { read: boolean; write: boolean } }> {
    const id = String(peerId ?? '').toLowerCase()
    return [...this._roots.values()]
      .filter((r) => r.perms.read)
      .map((r) => ({ rootId: r.rootId, name: r.name, perms: { read: true, write: r.peerWrite[id] === true } }))
  }
}

function cloneRoot(root: RootInfo): RootInfo {
  return { ...root, perms: { ...root.perms }, peerWrite: { ...root.peerWrite } }
}

function cloneMap(input: Map<string, RootInfo>): Map<string, RootInfo> {
  return new Map([...input.entries()].map(([id, root]) => [id, cloneRoot(root)]))
}

export { validateRelativePath }
