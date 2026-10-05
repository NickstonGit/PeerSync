import { isBoundedString, isSafeFileName, isValidHexKey, MAX_DISPLAY_NAME_LEN } from './utils'
import { PROTOCOL_VERSION, type ControlCapabilities } from './protocol'
import { isDeviceType } from '../identity/device-type'
import {
  type DownloadComplete,
  type DownloadFailed,
  type DownloadProgress,
  type DownloadRequest,
  type DeviceInvite,
  type DeviceInviteResponse,
  type FileOffer,
  type ManifestChunk,
  type ManifestEnd,
  type ManifestStart,
  type PairingInfo,
  type PeerControlMessage,
  type RememberVote,
  type Recognition,
  type TextOffer,
  type TopicAuth,
  type TopicChallenge,
  type TransferOffer,
  type TransferReady,
  type TransferStart
} from './control-channel'

const MAX_ID_LEN = 128
const MAX_PATH_LEN = 4096
export const MAX_TEXT_CONTENT_LEN = 65_536
const MAX_MESSAGE_LEN = 1024
export const MAX_FILES_PER_TRANSFER = 10_000
// Aggregate logical manifest budget. Frame limits alone do not bound the memory
// retained while reassembling many valid manifest chunks.
export const MAX_MANIFEST_BYTES = 32 * 1024 * 1024

const SIGNATURE_HEX_RE = /^[0-9a-f]{128}$/i

function isValidSignatureHex(x: unknown): x is string {
  return typeof x === 'string' && SIGNATURE_HEX_RE.test(x)
}

const HEX_RE = /^[0-9a-f]+$/i

function isBoundedHex(x: unknown, maxLen: number): x is string {
  return typeof x === 'string' && x.length > 0 && x.length <= maxLen && HEX_RE.test(x)
}

function isOptionalBoundedString(x: unknown, maxLen: number): boolean {
  return x === undefined || (typeof x === 'string' && x.length > 0 && x.length <= maxLen)
}

function isNonNegativeInteger(x: unknown, max = Number.MAX_SAFE_INTEGER): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= max
}

function isPositiveInteger(x: unknown, max = Number.MAX_SAFE_INTEGER): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x > 0 && x <= max
}

function isValidCapabilities(x: unknown): x is ControlCapabilities {
  if (x === undefined) return true
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false
  const caps = x as ControlCapabilities
  return (
    (caps.chunkedManifest === undefined || typeof caps.chunkedManifest === 'boolean') &&
    (caps.pathlessDownloadComplete === undefined ||
      typeof caps.pathlessDownloadComplete === 'boolean')
  )
}

export function isValidFileOffer(x: unknown): x is FileOffer {
  if (!x || typeof x !== 'object') return false
  const o = x as Partial<FileOffer>
  return (
    isBoundedString(o.id, MAX_ID_LEN) &&
    isBoundedString(o.transferId, MAX_ID_LEN) &&
    isSafeFileName(o.name) &&
    isBoundedString(o.path, MAX_PATH_LEN) &&
    isNonNegativeInteger(o.size) &&
    (o.contentHash === undefined || (typeof o.contentHash === 'string' && /^[0-9a-f]{64}$/i.test(o.contentHash))) &&
    o.kind === 'file'
  )
}

export function isValidTextOffer(x: unknown): x is TextOffer {
  if (!x || typeof x !== 'object') return false
  const o = x as Partial<TextOffer>
  return (
    isBoundedString(o.id, MAX_ID_LEN) &&
    isBoundedString(o.transferId, MAX_ID_LEN) &&
    o.kind === 'text' &&
    isBoundedString(o.content, MAX_TEXT_CONTENT_LEN)
  )
}

export function isValidTransferOffer(x: unknown): x is TransferOffer {
  if (!x || typeof x !== 'object') return false
  const kind = (x as { kind?: unknown }).kind
  if (kind === 'file') return isValidFileOffer(x)
  if (kind === 'text') return isValidTextOffer(x)
  return false
}

export function isValidTransferOfferForTransfer(
  x: unknown,
  transferId: string
): x is TransferOffer {
  return isValidTransferOffer(x) && x.transferId === transferId
}

export function hasUniqueTransferOfferIds(files: readonly TransferOffer[]): boolean {
  const seen = new Set<string>()
  for (const offer of files) {
    if (seen.has(offer.id)) return false
    seen.add(offer.id)
  }
  return true
}

function isValidOfferArray(files: unknown, transferId: string, allowEmpty: boolean): boolean {
  return (
    Array.isArray(files) &&
    (allowEmpty || files.length > 0) &&
    files.length <= MAX_FILES_PER_TRANSFER &&
    files.every((offer) => isValidTransferOfferForTransfer(offer, transferId)) &&
    hasUniqueTransferOfferIds(files as TransferOffer[])
  )
}

export function isValidControlMessage(x: unknown): x is PeerControlMessage {
  if (!x || typeof x !== 'object') return false
  const m = x as { type?: unknown; protocolVersion?: unknown }

  if (m.protocolVersion !== PROTOCOL_VERSION) return false

  switch (m.type) {
    case 'transfer-start': {
      const v = x as Partial<TransferStart>
      return (
        isBoundedString(v.transferId, MAX_ID_LEN) &&
        isNonNegativeInteger(v.totalFiles, MAX_FILES_PER_TRANSFER) &&
        isNonNegativeInteger(v.totalBytes)
      )
    }
    case 'transfer-ready': {
      const v = x as Partial<TransferReady>
      return (
        isBoundedString(v.transferId, MAX_ID_LEN) &&
        isValidOfferArray(v.files, v.transferId, false)
      )
    }
    case 'manifest-start': {
      const v = x as Partial<ManifestStart>
      return (
        isBoundedString(v.transferId, MAX_ID_LEN) &&
        isPositiveInteger(v.totalOffers, MAX_FILES_PER_TRANSFER) &&
        isPositiveInteger(v.totalChunks, MAX_FILES_PER_TRANSFER) &&
        (v.manifestBytes === undefined || isPositiveInteger(v.manifestBytes, MAX_MANIFEST_BYTES))
      )
    }
    case 'manifest-chunk': {
      const v = x as Partial<ManifestChunk>
      return (
        isBoundedString(v.transferId, MAX_ID_LEN) &&
        isNonNegativeInteger(v.index, MAX_FILES_PER_TRANSFER - 1) &&
        isValidOfferArray(v.files, v.transferId, false)
      )
    }
    case 'manifest-end': {
      const v = x as Partial<ManifestEnd>
      return (
        isBoundedString(v.transferId, MAX_ID_LEN) &&
        isPositiveInteger(v.totalOffers, MAX_FILES_PER_TRANSFER) &&
        isPositiveInteger(v.totalChunks, MAX_FILES_PER_TRANSFER) &&
        (v.manifestBytes === undefined || isPositiveInteger(v.manifestBytes, MAX_MANIFEST_BYTES))
      )
    }
    case 'download-request': {
      const v = x as Partial<DownloadRequest>
      return (
        isBoundedString(v.transferId, MAX_ID_LEN) &&
        isBoundedString(v.fileId, MAX_ID_LEN) &&
        isSafeFileName(v.fileName) &&
        isBoundedString(v.path, MAX_PATH_LEN) &&
        isNonNegativeInteger(v.totalBytes)
      )
    }
    case 'download-progress': {
      const v = x as Partial<DownloadProgress>
      return (
        isBoundedString(v.transferId, MAX_ID_LEN) &&
        isBoundedString(v.fileId, MAX_ID_LEN) &&
        isSafeFileName(v.fileName) &&
        isNonNegativeInteger(v.bytesTransferred) &&
        isNonNegativeInteger(v.totalBytes)
      )
    }
    case 'download-complete': {
      const v = x as Partial<DownloadComplete>
      return (
        isBoundedString(v.transferId, MAX_ID_LEN) &&
        isBoundedString(v.fileId, MAX_ID_LEN) &&
        isSafeFileName(v.fileName) &&
        // savedTo is a legacy field. Accept bounded values from older peers for
        // compatibility, but updated code never surfaces or sends local paths.
        isOptionalBoundedString(v.savedTo, MAX_PATH_LEN)
      )
    }
    case 'download-failed': {
      const v = x as Partial<DownloadFailed>
      return (
        isBoundedString(v.transferId, MAX_ID_LEN) &&
        isBoundedString(v.fileId, MAX_ID_LEN) &&
        isSafeFileName(v.fileName) &&
        isBoundedString(v.message, MAX_MESSAGE_LEN)
      )
    }
    case 'pairing-info': {
      const v = x as Partial<PairingInfo>
      return (
        isValidHexKey(v.devicePubkey) &&
        isValidSignatureHex(v.signature) &&
        isBoundedString(v.displayName, MAX_DISPLAY_NAME_LEN) &&
        isDeviceType(v.deviceType) &&
        !!v.capabilities &&
        typeof v.capabilities === 'object' &&
        typeof v.capabilities.canBackground === 'boolean' &&
        (v.capabilities.rememberCommitV2 === undefined ||
          typeof v.capabilities.rememberCommitV2 === 'boolean')
      )
    }
    case 'remember-vote': {
      const v = x as Partial<RememberVote>
      return (
        isBoundedString(v.transferId, MAX_ID_LEN) &&
        (v.vote === 'remember' || v.vote === 'no') &&
        typeof v.isMine === 'boolean'
      )
    }
    case 'remember-prepare': {
      const v = x as { transactionId?: unknown; transferId?: unknown }
      return isValidHexKey(v.transactionId) && isBoundedString(v.transferId, MAX_ID_LEN)
    }
    case 'remember-commit':
    case 'remember-commit-ack':
    case 'remember-finalize': {
      const v = x as { transactionId?: unknown }
      return isValidHexKey(v.transactionId)
    }
    case 'recognition': {
      const v = x as Partial<Recognition>
      return isValidSignatureHex(v.signature)
    }
    case 'invite': {
      const v = x as Partial<DeviceInvite>
      return (
        isBoundedString(v.displayName, MAX_DISPLAY_NAME_LEN) &&
        isDeviceType(v.deviceType) &&
        isBoundedString(v.topic, MAX_ID_LEN) &&
        (v.fileCount === undefined || isNonNegativeInteger(v.fileCount, MAX_FILES_PER_TRANSFER)) &&
        (v.textCount === undefined || isNonNegativeInteger(v.textCount, MAX_FILES_PER_TRANSFER)) &&
        (v.totalSize === undefined || isNonNegativeInteger(v.totalSize))
      )
    }
    case 'invite-response': {
      const v = x as Partial<DeviceInviteResponse>
      return isBoundedString(v.topic, MAX_ID_LEN) && v.response === 'declined'
    }
    case 'hello':
      return (x as { client?: unknown }).client === 'web'
    case 'challenge': {
      const v = x as Partial<TopicChallenge>
      return isBoundedHex(v.nonce, MAX_ID_LEN) && isValidCapabilities(v.capabilities)
    }
    case 'auth': {
      const v = x as Partial<TopicAuth>
      return isBoundedHex(v.proof, MAX_ID_LEN) && isValidCapabilities(v.capabilities)
    }
    case 'web-relay': {
      const v = x as { cid?: unknown; host?: unknown }
      return isBoundedString(v.cid, MAX_ID_LEN) && isBoundedString(v.host, MAX_ID_LEN)
    }
    case 'session-end':
      return true
    default:
      return false
  }
}
