import { LEGACY_UPDATE_MANIFEST_SCHEMA, UPDATE_MANIFEST_SCHEMA } from '../transport-compat'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

export interface UpdateSignatureFields {
  appVersion: string
  buildLabel: string
  platform: string
  size: number
  sha256: string
}

/** Stable signed payload shared by the build signer and the receiving Core. */
export function canonicalUpdateManifest(
  fields: UpdateSignatureFields,
  schema = UPDATE_MANIFEST_SCHEMA
): Uint8Array {
  return b4a.from(
    JSON.stringify([
      schema,
      String(fields.appVersion ?? ''),
      String(fields.buildLabel ?? ''),
      String(fields.platform ?? ''),
      Number(fields.size ?? 0),
      String(fields.sha256 ?? '').toLowerCase()
    ]),
    'utf8'
  )
}

export function normalizeUpdatePublicKey(value?: string | null): string {
  const key = String(value ?? '').trim().toLowerCase()
  return /^[0-9a-f]{64}$/.test(key) ? key : ''
}

/**
 * Signing is optional for the portable P2P update path. A signature is required
 * only when this runtime has a pinned release public key and unsigned mode was
 * not explicitly enabled. Builds without a pinned key use the remembered-`mine`
 * trust boundary plus exact size/SHA-256 verification.
 */
export function isUpdateSignatureRequired(
  publicKeyHex: string | null | undefined,
  allowUnsignedDevelopment = false
): boolean {
  return !!normalizeUpdatePublicKey(publicKeyHex) && !allowUnsignedDevelopment
}

export function verifyUpdateSignature(
  fields: UpdateSignatureFields,
  signatureHex: string | null | undefined,
  publicKeyHex: string | null | undefined
): boolean {
  const signature = String(signatureHex ?? '').trim().toLowerCase()
  const publicKey = normalizeUpdatePublicKey(publicKeyHex)
  if (!/^[0-9a-f]{128}$/.test(signature) || !publicKey) return false
  try {
    const sig = b4a.from(signature, 'hex')
    const key = b4a.from(publicKey, 'hex')
    // New releases sign the PeerSync schema. The legacy schema is verification-
    // only so existing signed metadata remains readable during migration.
    return (
      crypto.verify(canonicalUpdateManifest(fields), sig, key) ||
      crypto.verify(canonicalUpdateManifest(fields, LEGACY_UPDATE_MANIFEST_SCHEMA), sig, key)
    )
  } catch {
    return false
  }
}
