import { DEVICE_AUTH_CONTEXT as DEVICE_AUTH_CONTEXT_BYTES, REMEMBER_TRANSACTION_CONTEXT as REMEMBER_TRANSACTION_CONTEXT_BYTES } from '../../transport-compat'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import type { DeviceIdentity, DeviceType } from '../identity/device-identity-store'
import type { PairingInfo, Recognition } from '../transfer/control-channel'
import { deriveRendezvousTopic, DEVICE_PUBKEY_LEN } from './rendezvous'

export interface DeviceCapabilities {
  canBackground: boolean
  rememberCommitV2?: boolean
}

const DEVICE_AUTH_CONTEXT = b4a.from(DEVICE_AUTH_CONTEXT_BYTES)
const SIGNATURE_LEN = 64

function deviceAuthChallenge(handshakeHash: Uint8Array): Uint8Array {
  return crypto.hash([DEVICE_AUTH_CONTEXT, handshakeHash])
}

export function buildPairingInfo(
  identity: DeviceIdentity,
  handshakeHash: Uint8Array,
  capabilities: DeviceCapabilities
): PairingInfo {
  return {
    type: 'pairing-info',
    devicePubkey: b4a.toString(identity.publicKey, 'hex'),
    displayName: identity.displayName,
    deviceType: identity.deviceType,
    capabilities,
    signature: b4a.toString(
      crypto.sign(deviceAuthChallenge(handshakeHash), identity.secretKey),
      'hex'
    )
  }
}

export function verifyPairingInfo(message: PairingInfo, handshakeHash: Uint8Array): boolean {
  try {
    const devicePubkey = b4a.from(message.devicePubkey, 'hex')
    const signature = b4a.from(message.signature, 'hex')
    if (devicePubkey.byteLength !== DEVICE_PUBKEY_LEN || signature.byteLength !== SIGNATURE_LEN) {
      return false
    }
    return crypto.verify(deviceAuthChallenge(handshakeHash), signature, devicePubkey)
  } catch {
    return false
  }
}

export function buildRecognition(identity: DeviceIdentity, handshakeHash: Uint8Array): Recognition {
  return {
    type: 'recognition',
    signature: b4a.toString(
      crypto.sign(deviceAuthChallenge(handshakeHash), identity.secretKey),
      'hex'
    )
  }
}

export function verifyRecognition(
  message: Recognition,
  handshakeHash: Uint8Array,
  devicePubkey: Uint8Array
): boolean {
  try {
    const signature = b4a.from(message.signature, 'hex')
    if (signature.byteLength !== SIGNATURE_LEN) return false
    return crypto.verify(deviceAuthChallenge(handshakeHash), signature, devicePubkey)
  } catch {
    return false
  }
}

export interface PendingPairing {
  remoteDevicePubkey: Uint8Array
  remoteDisplayName: string
  remoteDeviceType: DeviceType
  remoteCanBackground: boolean
  remoteRememberCommitV2: boolean
  rendezvousTopic: Uint8Array
}

const REMEMBER_TRANSACTION_CONTEXT = b4a.from(REMEMBER_TRANSACTION_CONTEXT_BYTES)

export function buildRememberTransactionId(
  localPublicKey: Uint8Array,
  remotePublicKey: Uint8Array
): string {
  const localHex = b4a.toString(localPublicKey, 'hex')
  const remoteHex = b4a.toString(remotePublicKey, 'hex')
  const [first, second] = localHex < remoteHex ? [localPublicKey, remotePublicKey] : [remotePublicKey, localPublicKey]
  return b4a.toString(crypto.hash([REMEMBER_TRANSACTION_CONTEXT, first, second]), 'hex')
}

export function computePendingPairing(
  localPublicKey: Uint8Array,
  remote: PairingInfo,
  sessionHandshakeHash: Uint8Array
): PendingPairing {
  const remoteDevicePubkey = b4a.from(remote.devicePubkey, 'hex')
  const rendezvousTopic = deriveRendezvousTopic(
    localPublicKey,
    remoteDevicePubkey,
    sessionHandshakeHash
  )
  return {
    remoteDevicePubkey,
    remoteDisplayName: remote.displayName,
    remoteDeviceType: remote.deviceType,
    remoteCanBackground: remote.capabilities.canBackground,
    remoteRememberCommitV2: remote.capabilities.rememberCommitV2 === true,
    rendezvousTopic
  }
}
