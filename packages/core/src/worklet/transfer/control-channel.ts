import Protomux, { type ProtomuxMessage } from 'protomux'
import type { PeerSocket } from 'hyperswarm'
import { isValidControlMessage } from './control-validation'
import { controlEncoding } from './control-encoding'
import type { DeviceType } from '../identity/device-identity-store'
import {
  CONTROL_PROTOCOL,
  PROTOCOL_VERSION,
  type ControlCapabilities
} from './protocol'

export { PROTOCOL_VERSION }

export interface FileOffer {
  id: string
  transferId: string
  name: string
  path: string
  size: number
  /** Blake2b-256 of the exact file bytes. New peers always send it; legacy peers may omit it. */
  contentHash?: string
  kind: 'file'
}

export interface TextOffer {
  id: string
  transferId: string
  kind: 'text'
  content: string
}

export type TransferOffer = FileOffer | TextOffer

/** Legacy single-frame manifest. New peers use the chunked manifest messages. */
export interface TransferReady {
  type: 'transfer-ready'
  transferId: string
  files: TransferOffer[]
  peer?: string
}

export interface ManifestStart {
  type: 'manifest-start'
  transferId: string
  totalOffers: number
  totalChunks: number
  /** Sum of UTF-8 JSON bytes of all offers, excluding manifest envelopes. */
  manifestBytes?: number
}

export interface ManifestChunk {
  type: 'manifest-chunk'
  transferId: string
  index: number
  files: TransferOffer[]
}

export interface ManifestEnd {
  type: 'manifest-end'
  transferId: string
  totalOffers: number
  totalChunks: number
  manifestBytes?: number
}

export type ManifestMessage = ManifestStart | ManifestChunk | ManifestEnd

export interface TransferStart {
  type: 'transfer-start'
  transferId: string
  totalFiles: number
  totalBytes: number
}

export interface DownloadRequest {
  type: 'download-request'
  transferId: string
  fileId: string
  fileName: string
  path: string
  totalBytes: number
}

export interface DownloadProgress {
  type: 'download-progress'
  transferId: string
  fileId: string
  fileName: string
  bytesTransferred: number
  totalBytes: number
}

export interface DownloadComplete {
  type: 'download-complete'
  transferId: string
  fileId: string
  fileName: string
  /**
   * Legacy compatibility field. Updated receivers omit it because the sender
   * has no protocol reason to learn the receiver's local filesystem path.
   */
  savedTo?: string
}

export interface DownloadFailed {
  type: 'download-failed'
  transferId: string
  fileId: string
  fileName: string
  message: string
  paused?: boolean
}

export interface PairingInfo {
  type: 'pairing-info'
  devicePubkey: string
  displayName: string
  deviceType: DeviceType
  capabilities: { canBackground: boolean; rememberCommitV2?: boolean }
  signature: string
}

export interface RememberVote {
  type: 'remember-vote'
  transferId: string
  vote: 'remember' | 'no'
  isMine: boolean
}

export interface RememberPrepare {
  type: 'remember-prepare'
  transactionId: string
  transferId: string
}

export interface RememberCommit {
  type: 'remember-commit'
  transactionId: string
}

export interface RememberCommitAck {
  type: 'remember-commit-ack'
  transactionId: string
}

export interface RememberFinalize {
  type: 'remember-finalize'
  transactionId: string
}

export interface Recognition {
  type: 'recognition'
  signature: string
}

export interface DeviceInvite {
  type: 'invite'
  displayName: string
  deviceType: DeviceType
  topic: string
  fileCount?: number
  textCount?: number
  totalSize?: number
}

export interface DeviceInviteResponse {
  type: 'invite-response'
  topic: string
  response: 'declined'
}

interface ClientHello {
  type: 'hello'
  client: 'web'
}

export interface TopicChallenge {
  type: 'challenge'
  nonce: string
  capabilities?: ControlCapabilities
}

export interface TopicAuth {
  type: 'auth'
  proof: string
  capabilities?: ControlCapabilities
}

interface WebRelayConnection {
  type: 'web-relay'
  cid: string
  host: string
}

interface SessionEnd {
  type: 'session-end'
}

export type PeerControlMessage =
  | TransferStart
  | TransferReady
  | ManifestStart
  | ManifestChunk
  | ManifestEnd
  | DownloadRequest
  | DownloadProgress
  | DownloadComplete
  | DownloadFailed
  | PairingInfo
  | RememberVote
  | RememberPrepare
  | RememberCommit
  | RememberCommitAck
  | RememberFinalize
  | Recognition
  | DeviceInvite
  | DeviceInviteResponse
  | ClientHello
  | TopicChallenge
  | TopicAuth
  | WebRelayConnection
  | SessionEnd

type PeerControlHandler = (message: PeerControlMessage) => void | Promise<void>

export class PeerControlChannel {
  private readonly message: ProtomuxMessage
  private opened = false
  private readonly pending: PeerControlMessage[] = []

  constructor(message: ProtomuxMessage) {
    this.message = message
  }

  static create(socket: PeerSocket, onmessage: PeerControlHandler): PeerControlChannel | null {
    const mux = Protomux.from(socket)
    let instance: PeerControlChannel | null = null
    const channel = mux.createChannel({
      protocol: CONTROL_PROTOCOL,
      onopen: () => {
        instance?.flush()
      }
    })

    if (!channel) return null

    const message = channel.addMessage({
      encoding: controlEncoding,
      onmessage: (raw: unknown) => {
        if (!isValidControlMessage(raw)) {
          const m = raw as { type?: unknown; protocolVersion?: unknown } | null
          console.warn(
            'PeerControlChannel: dropping invalid message',
            'protocolVersion=',
            m?.protocolVersion,
            'type=',
            m?.type
          )
          return
        }
        try {
          const completion = onmessage(raw)
          if (completion) {
            void Promise.resolve(completion).catch((err) => {
              console.warn(
                'PeerControlChannel: async handler failed',
                raw.type,
                err instanceof Error ? err.message : String(err)
              )
            })
          }
        } catch (err) {
          console.warn(
            'PeerControlChannel: handler threw',
            raw.type,
            err instanceof Error ? err.message : String(err)
          )
        }
      }
    })

    instance = new PeerControlChannel(message)
    channel.open()
    if ((channel as { opened?: boolean }).opened) instance.flush()
    return instance
  }

  send(message: PeerControlMessage): void {
    if (!this.opened) {
      this.pending.push(message)
      return
    }
    this.message.send({ ...message, protocolVersion: PROTOCOL_VERSION })
  }

  flush(): void {
    this.opened = true
    const queue = this.pending.splice(0)
    for (const msg of queue) {
      this.message.send({ ...msg, protocolVersion: PROTOCOL_VERSION })
    }
  }
}
