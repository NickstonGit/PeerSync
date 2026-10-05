export const PROTOCOL_VERSION = 1
export { CONTROL_PROTOCOL } from '../../transport-compat'

/**
 * Optional control-plane capabilities are carried inside the existing challenge
 * and auth messages. Older peers ignore unknown fields, so capability
 * negotiation does not require a protocol-version bump for features whose
 * legacy representation remains supported.
 */
export interface ControlCapabilities {
  /** Receiver can reassemble bounded manifest-start/chunk/end messages. */
  chunkedManifest?: boolean
  /** Sender accepts download-complete without a receiver-local savedTo path. */
  pathlessDownloadComplete?: boolean
}

export const LOCAL_CONTROL_CAPABILITIES: Readonly<Required<ControlCapabilities>> = Object.freeze({
  chunkedManifest: true,
  pathlessDownloadComplete: true
})
