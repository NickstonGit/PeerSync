import { describe, expect, it } from 'vitest'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { LEGACY_UPDATE_MANIFEST_SCHEMA } from '../transport-compat'
import {
  canonicalUpdateManifest,
  isUpdateSignatureRequired,
  verifyUpdateSignature
} from './update-signature'

const fields = {
  appVersion: '0.0.0.20260914',
  buildLabel: '140926',
  platform: 'win-x64',
  size: 123456,
  sha256: 'ab'.repeat(32)
}

describe('portable update release signatures', () => {
  it('accepts the pinned signer and rejects metadata substitution', () => {
    const kp = crypto.keyPair()
    const signature = b4a.toString(crypto.sign(canonicalUpdateManifest(fields), kp.secretKey), 'hex')
    const publicKey = b4a.toString(kp.publicKey, 'hex')
    expect(verifyUpdateSignature(fields, signature, publicKey)).toBe(true)
    expect(verifyUpdateSignature({ ...fields, size: fields.size + 1 }, signature, publicKey)).toBe(false)
    expect(verifyUpdateSignature({ ...fields, sha256: 'cd'.repeat(32) }, signature, publicKey)).toBe(false)
  })

  it('verifies legacy signed metadata without using the legacy schema for new signatures', () => {
    const kp = crypto.keyPair()
    const signature = b4a.toString(
      crypto.sign(canonicalUpdateManifest(fields, LEGACY_UPDATE_MANIFEST_SCHEMA), kp.secretKey),
      'hex'
    )
    const publicKey = b4a.toString(kp.publicKey, 'hex')
    expect(verifyUpdateSignature(fields, signature, publicKey)).toBe(true)
    expect(b4a.toString(canonicalUpdateManifest(fields), 'utf8')).toContain('peersync-update-v1')
  })

  it('rejects an unsigned release and a different signer', () => {
    const kp = crypto.keyPair()
    const other = crypto.keyPair()
    const signature = b4a.toString(crypto.sign(canonicalUpdateManifest(fields), kp.secretKey), 'hex')
    expect(verifyUpdateSignature(fields, null, b4a.toString(kp.publicKey, 'hex'))).toBe(false)
    expect(verifyUpdateSignature(fields, signature, b4a.toString(other.publicKey, 'hex'))).toBe(false)
  })

  it('requires signatures only for a pinned key outside unsigned mode', () => {
    const publicKey = b4a.toString(crypto.keyPair().publicKey, 'hex')
    expect(isUpdateSignatureRequired(null)).toBe(false)
    expect(isUpdateSignatureRequired('')).toBe(false)
    expect(isUpdateSignatureRequired(publicKey)).toBe(true)
    expect(isUpdateSignatureRequired(publicKey, true)).toBe(false)
  })
})
