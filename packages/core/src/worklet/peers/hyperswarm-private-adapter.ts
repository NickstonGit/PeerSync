// Hyperswarm private-API compatibility boundary.
// PeerSync needs a LAN address hint and optional force-relay bit that are not
// currently exposed by Hyperswarm's public API. Keep every private member in
// this one guarded adapter so a dependency update fails closed instead of
// scattering unchecked `_...` calls throughout the product.

export const HYPERSWARM_PRIVATE_API_EXPECTED = 'hyperswarm@4.17.0'

/** A single relay dialer avoids duplicate encrypted sessions tearing down a
 * usable connection while an initial file request is being admitted. Keep
 * Hyperswarm's public-key tie-break direction; ordinary discovery is unchanged.
 */
export function shouldInitiateRendezvous(localKey: Uint8Array, remoteKey: Uint8Array | null, forceRelay: boolean): boolean {
  if (!forceRelay || !remoteKey) return true
  for (let i = 0; i < Math.min(localKey.length, remoteKey.length); i++) {
    if (localKey[i] !== remoteKey[i]) return localKey[i] > remoteKey[i]
  }
  return localKey.length > remoteKey.length
}

type PeerInfo = {
  explicit: boolean
  queued: boolean
  attempts: number
  tried: boolean
  forceRelaying?: boolean
  _updatePriority: () => boolean
}

type PrivateSwarm = {
  _upsertPeer: (publicKey: Uint8Array, relayAddresses: Array<{ host: string; port: number }> | null) => PeerInfo | null
  explicitPeers: Set<unknown>
  _allConnections: { has: (publicKey: Uint8Array) => boolean }
  _enqueue: (peerInfo: unknown) => void
  _attemptClientConnections?: () => void
}

function asPrivate(swarm: unknown): PrivateSwarm | null {
  const x = swarm as Partial<PrivateSwarm> | null
  if (!x || typeof x._upsertPeer !== 'function') return null
  if (!x.explicitPeers || typeof x.explicitPeers.add !== 'function') return null
  if (!x._allConnections || typeof x._allConnections.has !== 'function') return null
  if (typeof x._enqueue !== 'function') return null
  return x as PrivateSwarm
}

export function hasCompatibleHyperswarmPrivateApi(swarm: unknown): boolean {
  return asPrivate(swarm) !== null
}

export function connectViaHyperswarmPrivateApi(
  swarm: unknown,
  publicKey: Uint8Array,
  addresses: Array<{ host: string; port: number }>
): boolean {
  const target = asPrivate(swarm)
  if (!target) return false
  const peerInfo = target._upsertPeer(publicKey, addresses)
  if (!peerInfo || typeof peerInfo._updatePriority !== 'function') return false
  peerInfo.explicit = true
  peerInfo.attempts = 0
  peerInfo.tried = false
  target.explicitPeers.add(peerInfo)
  // `_allConnections` holds both live sessions and handshakes still in flight.
  // Returning true here would claim a dial happened when none did, so a beacon
  // that repeats every 800ms would report a fresh connection attempt forever.
  if (target._allConnections.has(publicKey)) return false
  if (peerInfo.queued) {
    target._attemptClientConnections?.()
    return true
  }
  if (peerInfo._updatePriority()) target._enqueue(peerInfo)
  else target._attemptClientConnections?.()
  return true
}

const patched = new WeakSet<object>()
type RawEndpoint = { socket?: unknown; remotePort?: number; remoteHost?: string }
type RelaySocket = { rawStream?: RawEndpoint | null; once: (event: string, listener: () => void) => unknown }
type RelayOptions = { keyPair?: unknown; localConnection?: boolean; fastOpen?: boolean; holepunch?: () => boolean }
type RelaySwarm = PrivateSwarm & {
  keyPair: unknown
  dht: { connect: (key: Uint8Array, options?: RelayOptions) => RelaySocket; remoteAddress: () => unknown }
  server: { holepunch: () => boolean; _shareLocalAddress: boolean }
}
const relaySockets = new WeakMap<object, Set<RelaySocket>>()

/** Compare the observed endpoint with the actual relay control transport,
 * including port and UDP socket. A force flag or a DNS hostname is not proof.
 */
export function isObservedRelayTransport(swarm: unknown, socket: { rawStream?: RawEndpoint | null }): boolean {
  const raw = socket.rawStream
  if (!raw?.socket || !raw.remoteHost || !raw.remotePort) return false
  const controls = swarm && typeof swarm === 'object' ? relaySockets.get(swarm) : null
  if (!controls) return false
  for (const control of controls) {
    const endpoint = control.rawStream
    if (endpoint?.socket === raw.socket && endpoint.remotePort === raw.remotePort && endpoint.remoteHost === raw.remoteHost) return true
  }
  return false
}

export function installForceRelayPrivatePatch(swarm: unknown): boolean {
  const target = asPrivate(swarm)
  if (!target) return false
  const obj = target as unknown as object
  if (patched.has(obj)) return true
  const relay = target as Partial<RelaySwarm>
  if (!relay.keyPair || typeof relay.dht?.connect !== 'function' || typeof relay.dht.remoteAddress !== 'function'
    || typeof relay.server?.holepunch !== 'function' || typeof relay.server._shareLocalAddress !== 'boolean') return false
  const controls = new Set<RelaySocket>()
  relaySockets.set(obj, controls)
  const connect = relay.dht.connect.bind(relay.dht)
  // Advertise no directly reachable address and disable LAN/punch races for
  // application peers. Relay control connections retain their normal options.
  relay.dht.remoteAddress = () => null
  relay.server.holepunch = () => false
  relay.server._shareLocalAddress = false
  relay.dht.connect = (key, options) => {
    const application = options?.keyPair === relay.keyPair
    const socket = connect(key, application ? { ...options, localConnection: false, fastOpen: false, holepunch: () => false } : options)
    if (!application) {
      controls.add(socket)
      socket.once('close', () => controls.delete(socket))
    }
    return socket
  }
  const original = target._upsertPeer.bind(target)
  target._upsertPeer = (publicKey, relayAddresses) => {
    const info = original(publicKey, relayAddresses)
    if (info) info.forceRelaying = true
    return info
  }
  patched.add(obj)
  return true
}
