// Browser/Bare/Node-safe BLAKE2b-256 primitives. Keep filesystem imports out of
// this module so transfer integrity can share one implementation everywhere.
import b4a from 'b4a'
import { blake2b } from '@noble/hashes/blake2.js'

export const DIGEST_BYTES = 32
export const DIGEST_HEX = 64

export function blake2b256(data: Uint8Array): Uint8Array {
  return blake2b(data, { dkLen: DIGEST_BYTES })
}

export function blake2b256Hex(data: Uint8Array): string {
  return b4a.toString(blake2b256(data), 'hex')
}

export function isValidDigestHex(hex: unknown): hex is string {
  return typeof hex === 'string' && /^[0-9a-f]{64}$/i.test(hex)
}

export class FileDigest {
  private _h = blake2b.create({ dkLen: DIGEST_BYTES })
  private _bytes = 0

  update(chunk: Uint8Array): void {
    this._h.update(chunk)
    this._bytes += chunk.byteLength
  }

  get bytes(): number {
    return this._bytes
  }

  digestHex(): string {
    return b4a.toString(this._h.digest(), 'hex')
  }
}
