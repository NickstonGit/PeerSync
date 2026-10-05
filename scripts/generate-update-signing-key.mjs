import b4a from 'b4a'
import crypto from 'hypercore-crypto'

// Generate the seed explicitly instead of slicing implementation-specific
// secret-key bytes. The 32-byte seed is the only release secret that CI needs.
const seedBytes = crypto.randomBytes(32)
const kp = crypto.keyPair(seedBytes)
const seed = b4a.toString(seedBytes, 'hex')
const publicKey = b4a.toString(kp.publicKey, 'hex')
console.log('PEERSYNC_UPDATE_SIGNING_SEED=' + seed)
console.log('publicKey=' + publicKey)
console.error('Keep PEERSYNC_UPDATE_SIGNING_SEED secret and stable across all production releases. Never commit it. The current portable production build does not require or consume this seed automatically. See docs/update-signing.md before enabling signing.')
