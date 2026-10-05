import { PROTECTED_STATE_CONTEXT } from '../transport-compat'
import b4a from 'b4a'
import { createCipheriv, createDecipheriv, randomBytes } from 'bare-crypto'
import type { Buffer as BareBuffer } from 'bare-buffer'
import crypto from 'hypercore-crypto'

// bare-crypto typings accept only bare-buffer's Buffer; at runtime any
// Uint8Array works (and b4a hands back a Buffer on both Bare and Node).
function asBareBuffer(bytes: Uint8Array): BareBuffer {
  return bytes as unknown as BareBuffer
}

function bytesOf(output: string | BareBuffer): Uint8Array {
  return typeof output === 'string' ? b4a.from(output, 'utf8') : output
}

interface AeadCipher {
  update(data: BareBuffer): string | BareBuffer
  final(): string | BareBuffer
}

// Node returns ciphertext from update(); bare-crypto AEAD buffers until final().
function aeadBytes(cipher: AeadCipher, data: Uint8Array): Uint8Array {
  const head = bytesOf(cipher.update(asBareBuffer(data)))
  const tail = bytesOf(cipher.final())
  if (head.byteLength === 0) return tail
  if (tail.byteLength === 0) return head
  return b4a.concat([head, tail])
}

const CONTEXT = b4a.from(PROTECTED_STATE_CONTEXT, 'utf8')
const ALG = 'aes-256-gcm' as const
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32

interface Envelope {
  v: 2
  enc: typeof ALG
  iv: string
  tag: string
  ciphertext: string
}

export interface DecodedProtectedJson<T> {
  value: T
  encrypted: boolean
}

/**
 * The shell-provided identity seed is already persisted under DPAPI. Derive a
 * separate, domain-separated key for local state so the identity seed itself is
 * never used directly as an encryption key.
 */
export function deriveProtectedStateKey(identitySeed: Uint8Array): Uint8Array {
  return crypto.hash([CONTEXT, identitySeed])
}

export function encodeProtectedJson(value: unknown, key: Uint8Array): string {
  assertKey(key)
  const plain = b4a.from(JSON.stringify(value), 'utf8')
  const iv = randomBytes(IV_BYTES)
  // GCM auth tag defaults to 16 bytes (TAG_BYTES) on bare-crypto and Node alike.
  const cipher = createCipheriv(ALG, asBareBuffer(key), iv)
  const ciphertext = aeadBytes(cipher, plain)
  const tag = cipher.getAuthTag()

  const envelope: Envelope = {
    v: 2,
    enc: ALG,
    iv: b4a.toString(iv, 'base64'),
    tag: b4a.toString(tag, 'base64'),
    ciphertext: b4a.toString(ciphertext, 'base64')
  }
  return JSON.stringify(envelope)
}

export function decodeProtectedJson<T = unknown>(text: string, key: Uint8Array): DecodedProtectedJson<T> {
  assertKey(key)
  const parsed = JSON.parse(text) as unknown

  // One-time migration path from the pre-encryption portable format.
  if (!isProtectedEnvelope(parsed)) {
    // The short-lived audit patch used a v1 xsalsa20 envelope. It never passed
    // the standalone Bare smoke gate, so accepting it as plaintext would be
    // unsafe. Fail closed instead of silently returning encrypted metadata.
    const legacy = asRecord(parsed)
    if (legacy?.v === 1 && legacy?.enc === 'xsalsa20-poly1305') {
      throw new Error('unsupported protected-state v1 envelope')
    }
    return { value: parsed as T, encrypted: false }
  }

  const iv = b4a.from(parsed.iv, 'base64')
  const tag = b4a.from(parsed.tag, 'base64')
  const ciphertext = b4a.from(parsed.ciphertext, 'base64')
  if (iv.byteLength !== IV_BYTES || tag.byteLength !== TAG_BYTES) {
    throw new Error('protected state envelope malformed')
  }

  try {
    const decipher = createDecipheriv(ALG, asBareBuffer(key), asBareBuffer(iv))
    decipher.setAuthTag(asBareBuffer(tag))
    const plain = aeadBytes(decipher, ciphertext)
    return { value: JSON.parse(b4a.toString(plain, 'utf8')) as T, encrypted: true }
  } catch {
    throw new Error('protected state authentication failed')
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function isProtectedEnvelope(value: unknown): value is Envelope {
  const v = asRecord(value)
  return v !== null && v.v === 2 && v.enc === ALG &&
    typeof v.iv === 'string' && typeof v.tag === 'string' && typeof v.ciphertext === 'string'
}

function assertKey(key: Uint8Array): void {
  if (key.byteLength !== KEY_BYTES) throw new Error('protected state key length')
}
