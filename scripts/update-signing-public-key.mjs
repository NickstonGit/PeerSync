import b4a from 'b4a'
import crypto from 'hypercore-crypto'

const seedHex = String(process.env.PEERSYNC_UPDATE_SIGNING_SEED || '').trim().toLowerCase()
if (!/^[0-9a-f]{64}$/.test(seedHex)) {
  console.error('PEERSYNC_UPDATE_SIGNING_SEED must be exactly 64 hex characters')
  process.exit(2)
}
const kp = crypto.keyPair(b4a.from(seedHex, 'hex'))
process.stdout.write(b4a.toString(kp.publicKey, 'hex'))
