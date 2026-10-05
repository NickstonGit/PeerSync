import { describe, it, expect, beforeEach, vi } from 'vitest'

const { files } = vi.hoisted(() => ({ files: new Map<string, string>() }))

vi.mock('bare-fs', () => {
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  return {
    default: {
      promises: {
        readFile: async (p: string) => {
          if (!files.has(p)) throw enoent()
          return files.get(p)!
        },
        writeFile: async (p: string, data: string) => {
          files.set(p, data)
        },
        rename: async (from: string, to: string) => {
          if (!files.has(from)) throw enoent()
          files.set(to, files.get(from)!)
          files.delete(from)
        },
        unlink: async (p: string) => {
          files.delete(p)
        },
        mkdir: async () => {}
      }
    }
  }
})

import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { DeviceIdentityStore } from './device-identity-store'

const ROOT = '/identity'
const FILE = `${ROOT}/device.json`

const readFile = () => JSON.parse(files.get(FILE) as string)

beforeEach(() => files.clear())

describe('DeviceIdentityStore', () => {
  it('managed/fresh: does not publish metadata until the host seals and commits the secret', async () => {
    const store = new DeviceIdentityStore(ROOT)
    const prepared = await store.provideSecret({ mode: 'managed', state: 'absent' })

    expect(prepared.commitRequired).toBe(true)
    expect(prepared.secretKey).toMatch(/^[0-9a-f]{128}$/)
    expect(files.has(FILE)).toBe(false)

    await store.commitSecret()
    const file = readFile()
    expect(file.version).toBe(2)
    expect(file.secretKey).toBeUndefined()

    const id = await store.getOrCreate()
    expect(b4a.toString(id.publicKey, 'hex')).toBe(file.publicKey)
  })

  it('managed/injected: reuses the host-supplied durable secret and seals nothing', async () => {
    const kp = crypto.keyPair()
    const secretHex = b4a.toString(kp.secretKey, 'hex')

    const store = new DeviceIdentityStore(ROOT)
    const prepared = await store.provideSecret({
      mode: 'managed',
      state: 'present',
      secret: secretHex
    })

    expect(prepared).toEqual({ secretKey: null, commitRequired: false })
    const id = await store.getOrCreate()
    expect(b4a.toString(id.secretKey, 'hex')).toBe(secretHex)
    expect(b4a.toString(id.publicKey, 'hex')).toBe(b4a.toString(kp.publicKey, 'hex'))
    expect(readFile().secretKey).toBeUndefined()
  })

  it('migrates legacy v1 only after the host confirms the secret was sealed', async () => {
    const kp = crypto.keyPair()
    const legacy = {
      version: 1,
      publicKey: b4a.toString(kp.publicKey, 'hex'),
      secretKey: b4a.toString(kp.secretKey, 'hex'),
      displayName: 'Old Device',
      deviceType: 'laptop',
      createdAt: 123
    }
    files.set(FILE, JSON.stringify(legacy))

    const store = new DeviceIdentityStore(ROOT)
    const prepared = await store.provideSecret({ mode: 'managed', state: 'absent' })

    expect(prepared).toEqual({ secretKey: legacy.secretKey, commitRequired: true })
    expect(readFile().version).toBe(1)

    await store.commitSecret()
    const file = readFile()
    expect(file.version).toBe(2)
    expect(file.secretKey).toBeUndefined()
    expect(file.publicKey).toBe(legacy.publicKey)
    expect(file.displayName).toBe('Old Device')
  })

  it('managed/malformed secret: fails closed instead of rotating identity', async () => {
    const store = new DeviceIdentityStore(ROOT)
    await expect(
      store.provideSecret({ mode: 'managed', state: 'present', secret: 'not-a-valid-secret' })
    ).rejects.toThrow(/malformed/)
    expect(files.has(FILE)).toBe(false)
  })

  it('managed/unavailable secret: fails closed instead of treating it as absent', async () => {
    const store = new DeviceIdentityStore(ROOT)
    await expect(
      store.provideSecret({ mode: 'managed', state: 'unavailable', reason: 'keychain locked' })
    ).rejects.toThrow(/unavailable/)
    expect(files.has(FILE)).toBe(false)
  })

  it('managed/absent refuses to replace existing managed metadata', async () => {
    const kp = crypto.keyPair()
    files.set(
      FILE,
      JSON.stringify({
        version: 2,
        publicKey: b4a.toString(kp.publicKey, 'hex'),
        displayName: 'Existing',
        deviceType: 'laptop',
        createdAt: 1
      })
    )

    const store = new DeviceIdentityStore(ROOT)
    await expect(store.provideSecret({ mode: 'managed', state: 'absent' })).rejects.toThrow(
      /secret is missing/
    )
    expect(readFile().publicKey).toBe(b4a.toString(kp.publicKey, 'hex'))
  })

  it('legacy mode: keeps the secret in the file when no keychain is available', async () => {
    const store = new DeviceIdentityStore(ROOT)
    const prepared = await store.provideSecret({ mode: 'legacy' })

    expect(prepared).toEqual({ secretKey: null, commitRequired: false })
    const file = readFile()
    expect(file.version).toBe(1)
    expect(file.secretKey).toMatch(/^[0-9a-f]{128}$/)
  })
})
