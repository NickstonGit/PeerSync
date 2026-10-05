import b4a from 'b4a'
import fs from 'bare-fs'
import crypto from 'hypercore-crypto'
import { DEVICE_TYPES, type DeviceType } from './device-type'

export type { DeviceType }

export interface DeviceIdentity {
  publicKey: Uint8Array
  secretKey: Uint8Array
  displayName: string
  deviceType: DeviceType
  createdAt: number
}

interface SerializedMeta {
  version: 2
  publicKey: string
  displayName: string
  deviceType: DeviceType
  createdAt: number
}

interface SerializedLegacy {
  version: 1
  publicKey: string
  secretKey: string
  displayName: string
  deviceType: DeviceType
  createdAt: number
}

export type DeviceSecretInit =
  | { mode: 'managed'; state: 'present'; secret: string }
  | { mode: 'managed'; state: 'absent' }
  | { mode: 'managed'; state: 'unavailable'; reason?: string }
  | { mode: 'legacy' }

type DeviceMeta = Omit<SerializedMeta, 'version'>

const HEX_RE = /^[0-9a-f]+$/i
const PUBLIC_KEY_HEX_LEN = 64
const SECRET_KEY_HEX_LEN = 128

function isHex(value: unknown, expectedLen: number): value is string {
  return typeof value === 'string' && value.length === expectedLen && HEX_RE.test(value)
}

function hasCommonMeta(v: Record<string, unknown>): boolean {
  return (
    isHex(v.publicKey, PUBLIC_KEY_HEX_LEN) &&
    typeof v.displayName === 'string' &&
    typeof v.deviceType === 'string' &&
    DEVICE_TYPES.has(v.deviceType as DeviceType) &&
    typeof v.createdAt === 'number' &&
    Number.isFinite(v.createdAt)
  )
}

function isMeta(value: unknown): value is SerializedMeta {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return v.version === 2 && hasCommonMeta(v)
}

function isLegacy(value: unknown): value is SerializedLegacy {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return v.version === 1 && isHex(v.secretKey, SECRET_KEY_HEX_LEN) && hasCommonMeta(v)
}

function deviceFromSecret(
  secretKey: Uint8Array,
  meta: Omit<DeviceMeta, 'publicKey'>
): DeviceIdentity {
  return {
    publicKey: b4a.from(secretKey.subarray(32, 64)),
    secretKey,
    displayName: meta.displayName,
    deviceType: meta.deviceType,
    createdAt: meta.createdAt
  }
}

export interface DeviceIdentityDefaults {
  displayName?: string
  deviceType?: DeviceType
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type LoadedFile =
  | { kind: 'meta'; meta: DeviceMeta }
  | { kind: 'legacy'; meta: DeviceMeta; identity: DeviceIdentity }
  | null

class DeviceIdentityStateError extends Error {
  readonly code = 'DEVICE_IDENTITY_UNAVAILABLE'

  constructor(message: string) {
    super(message)
    this.name = 'DeviceIdentityStateError'
  }
}

export class DeviceIdentityStore {
  private readonly root: string
  private readonly filePath: string
  private readonly defaults: Required<DeviceIdentityDefaults>
  private cache: DeviceIdentity | null = null
  private opQueue: Promise<unknown> = Promise.resolve()
  private dirEnsured: Promise<void> | null = null
  private readonly ready = createDeferred<DeviceIdentity>()
  private initStarted = false
  private readySettled = false
  private pendingCommit: { identity: DeviceIdentity; secretKey: string } | null = null

  constructor(root: string, defaults: DeviceIdentityDefaults = {}) {
    this.root = root
    this.filePath = `${root}/device.json`
    this.defaults = {
      displayName: defaults.displayName ?? 'Unknown Device',
      deviceType: defaults.deviceType ?? 'unknown'
    }
    void this.ready.promise.catch(() => {})
  }

  async provideSecret(init: DeviceSecretInit): Promise<{ secretKey: string | null; commitRequired: boolean }> {
    return this.run(async () => {
      if (this.initStarted) {
        throw new DeviceIdentityStateError('DeviceIdentityStore: device secret was already initialized')
      }
      this.initStarted = true

      try {
        const prepared = await this.prepare(init)
        if (prepared.commitRequired) {
          this.pendingCommit = { identity: prepared.identity, secretKey: prepared.secretKey }
          return { secretKey: prepared.secretKey, commitRequired: true }
        }
        this.publish(prepared.identity)
        return { secretKey: null, commitRequired: false }
      } catch (err) {
        this.failReady(err)
        throw err
      }
    })
  }

  async commitSecret(): Promise<void> {
    await this.run(async () => {
      const pending = this.pendingCommit
      if (!pending) return

      try {
        await this.saveMeta(pending.identity)
        this.pendingCommit = null
        this.publish(pending.identity)
      } catch (err) {
        this.failReady(err)
        throw err
      }
    })
  }

  async getOrCreate(): Promise<DeviceIdentity> {
    if (this.cache) return this.cache
    return this.ready.promise
  }

  private async prepare(
    init: DeviceSecretInit
  ): Promise<
    | { identity: DeviceIdentity; commitRequired: false }
    | { identity: DeviceIdentity; secretKey: string; commitRequired: true }
  > {
    const stored = await this.loadFile()

    if (init.mode === 'legacy') {
      if (stored?.kind === 'legacy') return { identity: stored.identity, commitRequired: false }
      if (stored?.kind === 'meta') {
        throw new DeviceIdentityStateError(
          'DeviceIdentityStore: managed identity exists but the OS secret store is unavailable'
        )
      }
      const fresh = this.makeFresh()
      await this.saveLegacy(fresh)
      return { identity: fresh, commitRequired: false }
    }

    if (init.state === 'unavailable') {
      throw new DeviceIdentityStateError(
        `DeviceIdentityStore: managed identity secret is unavailable${init.reason ? `: ${init.reason}` : ''}`
      )
    }

    if (init.state === 'present') {
      if (!isHex(init.secret, SECRET_KEY_HEX_LEN)) {
        throw new DeviceIdentityStateError(
          'DeviceIdentityStore: managed identity secret is malformed'
        )
      }

      const secretKey = b4a.from(init.secret, 'hex')
      const id = deviceFromSecret(secretKey, stored?.meta ?? this.freshMeta())
      const derivedKey = b4a.toString(id.publicKey, 'hex').toLowerCase()

      if (stored && stored.meta.publicKey.toLowerCase() !== derivedKey) {
        throw new DeviceIdentityStateError(
          'DeviceIdentityStore: managed identity secret does not match persisted public identity'
        )
      }

      if (stored?.kind !== 'meta') await this.saveMeta(id)
      return { identity: id, commitRequired: false }
    }

    if (stored?.kind === 'legacy') {
      return {
        identity: stored.identity,
        secretKey: b4a.toString(stored.identity.secretKey, 'hex'),
        commitRequired: true
      }
    }

    if (stored?.kind === 'meta') {
      throw new DeviceIdentityStateError(
        'DeviceIdentityStore: managed identity metadata exists but its secret is missing'
      )
    }

    const fresh = this.makeFresh()
    return {
      identity: fresh,
      secretKey: b4a.toString(fresh.secretKey, 'hex'),
      commitRequired: true
    }
  }

  private publish(identity: DeviceIdentity): void {
    this.cache = identity
    if (this.readySettled) return
    this.readySettled = true
    this.ready.resolve(identity)
  }

  private failReady(error: unknown): void {
    if (this.readySettled) return
    this.readySettled = true
    this.ready.reject(error instanceof Error ? error : new Error(String(error)))
  }

  private freshMeta(): Omit<DeviceMeta, 'publicKey'> {
    return {
      displayName: this.defaults.displayName,
      deviceType: this.defaults.deviceType,
      createdAt: Date.now()
    }
  }

  private makeFresh(): DeviceIdentity {
    const kp = crypto.keyPair()
    return {
      publicKey: kp.publicKey,
      secretKey: kp.secretKey,
      ...this.freshMeta()
    }
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.opQueue.catch(() => undefined).then(fn)
    this.opQueue = next
    return next
  }

  private async loadFile(): Promise<LoadedFile> {
    try {
      const raw = (await fs.promises.readFile(this.filePath, 'utf8')) as string
      const parsed = JSON.parse(raw) as unknown
      if (isMeta(parsed)) {
        const { publicKey, displayName, deviceType, createdAt } = parsed
        return { kind: 'meta', meta: { publicKey, displayName, deviceType, createdAt } }
      }
      if (isLegacy(parsed)) {
        const { publicKey, secretKey, displayName, deviceType, createdAt } = parsed
        const sk = b4a.from(secretKey, 'hex')
        const identity = deviceFromSecret(sk, { displayName, deviceType, createdAt })
        if (b4a.toString(identity.publicKey, 'hex').toLowerCase() !== publicKey.toLowerCase()) {
          throw new DeviceIdentityStateError(
            'DeviceIdentityStore: legacy identity public key does not match its secret'
          )
        }
        return {
          kind: 'legacy',
          meta: { publicKey, displayName, deviceType, createdAt },
          identity
        }
      }
      throw new DeviceIdentityStateError('DeviceIdentityStore: identity metadata is invalid')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') return null
      if (err instanceof DeviceIdentityStateError) throw err
      throw new DeviceIdentityStateError(
        `DeviceIdentityStore: failed to read identity metadata: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  private saveMeta(id: DeviceIdentity): Promise<void> {
    return this.writeFile({
      version: 2,
      publicKey: b4a.toString(id.publicKey, 'hex'),
      displayName: id.displayName,
      deviceType: id.deviceType,
      createdAt: id.createdAt
    } satisfies SerializedMeta)
  }

  private saveLegacy(id: DeviceIdentity): Promise<void> {
    return this.writeFile({
      version: 1,
      publicKey: b4a.toString(id.publicKey, 'hex'),
      secretKey: b4a.toString(id.secretKey, 'hex'),
      displayName: id.displayName,
      deviceType: id.deviceType,
      createdAt: id.createdAt
    } satisfies SerializedLegacy)
  }

  private async writeFile(payload: SerializedMeta | SerializedLegacy): Promise<void> {
    await this.ensureDir()
    const tmpPath = `${this.filePath}.tmp`
    try {
      await fs.promises.writeFile(tmpPath, JSON.stringify(payload), 'utf8')
      await fs.promises.rename(tmpPath, this.filePath)
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
