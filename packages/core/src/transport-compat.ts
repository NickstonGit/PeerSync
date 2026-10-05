// Exact transport/state compatibility bytes used by existing PeerSync peers
// and persisted data. These identifiers are protocol contracts, not product
// branding. Changing one requires an explicit versioned migration.
export const FS_PROTOCOL = 'altersend/fs.v1'
export const CHAT_PROTOCOL = 'altersend/chat.v1'
export const UPDATE_PROTOCOL = 'altersend/update.v1'
export const CONTROL_PROTOCOL = 'altersend/control'
export const DEVICE_AUTH_CONTEXT = 'altersend-device-auth-v1'
export const REMEMBER_TRANSACTION_CONTEXT = 'altersend-remember-transaction-v2'
export const RENDEZVOUS_CONTEXT = 'altersend-rendezvous-v1'
export const PROTECTED_STATE_CONTEXT = 'AlterSend portable protected-state v2'
export const TOPIC_KEY_CONTEXT = 'AlterSend portable topic-noise-key v1'
export const RELAY_PROTOCOL = 'altersend-pro'

// PeerSync writes the new schema; the legacy value remains accepted for
// sidecars/signatures produced by earlier builds.
export const UPDATE_MANIFEST_SCHEMA = 'peersync-update-v1'
export const LEGACY_UPDATE_MANIFEST_SCHEMA = 'altersend-update-v1'
