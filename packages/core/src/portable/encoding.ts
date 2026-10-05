// Canonical encoding for OperationDescriptor + blake2b-256 digests.
// Deterministic across runtimes: fixed key order per object (lexicographic),
// numbers encoded as decimal strings, no whitespace. Unit-tested.

import b4a from 'b4a'
import { blake2b256 } from './hashing'

export type CanonicalValue = string | number | boolean | null | undefined | CanonicalValue[] | { [k: string]: CanonicalValue }

function canonicalize(value: CanonicalValue): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('only safe integers are canonically encodable')
    return `n:${value}`
  }
  if (typeof value === 'string') return `s:${JSON.stringify(value)}`
  if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v)).join(',')}]`
  const keys = Object.keys(value).sort()
  const parts = keys.map((k) => `s:${JSON.stringify(k)}=>${canonicalize((value as Record<string, CanonicalValue>)[k])}`)
  return `{${parts.join(',')}}`
}

export function canonicalEncoding(value: CanonicalValue): string {
  return canonicalize(value)
}

export function descriptorHashCanonical(json: string): Uint8Array {
  return blake2b256(b4a.from(json, 'utf8'))
}

// ---- UUID v4 without deps ----
import crypto from 'hypercore-crypto'

export function uuidv4(): string {
  const b = crypto.randomBytes(16)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = b4a.toString(b, 'hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
