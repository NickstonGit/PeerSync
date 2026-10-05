import fs from 'node:fs'
import cryptoNode from 'node:crypto'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

function parseBuildLabel(value) {
  const m = /^(?:n-)?(\d{2})(\d{2})(\d{2})$/i.exec(String(value || '').trim())
  if (!m) return null
  const day = Number(m[1]); const month = Number(m[2]); const year = 2000 + Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return [year, month, day]
}

function comparableAppVersion(version, build) {
  const main = String(version || '').trim().split(/[+-]/, 1)[0]
  if (!/^\d+(?:\.\d+){0,3}$/.test(main)) return String(version || '0.0.0')
  const parts = main.split('.').map(Number)
  if (parts.length >= 4) return parts.join('.')
  const parsed = parseBuildLabel(build)
  if (!parsed) return parts.join('.')
  while (parts.length < 3) parts.push(0)
  const stamp = parsed[0] * 10000 + parsed[1] * 100 + parsed[2]
  return `${parts[0]}.${parts[1]}.${parts[2]}.${stamp}`
}

const [artifact, releaseVersion, platform = 'win-x64', outputArg] = process.argv.slice(2)
if (!artifact || !/^\d{6}$/.test(String(releaseVersion || ''))) {
  console.error('usage: node scripts/sign-portable-update.mjs <artifact> <DDMMYY> [platform] [output]')
  process.exit(2)
}
const rawVersion = '0.0.0'
const buildLabel = releaseVersion
const seedHex = String(process.env.PEERSYNC_UPDATE_SIGNING_SEED || '').trim().toLowerCase()
if (!/^[0-9a-f]{64}$/.test(seedHex)) {
  console.error('PEERSYNC_UPDATE_SIGNING_SEED must be exactly 64 hex characters')
  process.exit(2)
}
const bytes = fs.statSync(artifact).size
const hash = cryptoNode.createHash('sha256')
for await (const chunk of fs.createReadStream(artifact)) hash.update(chunk)
const sha256 = hash.digest('hex')
const appVersion = comparableAppVersion(rawVersion, buildLabel)
const fields = ['peersync-update-v1', appVersion, buildLabel, platform, bytes, sha256]
const kp = crypto.keyPair(b4a.from(seedHex, 'hex'))
const signature = b4a.toString(crypto.sign(b4a.from(JSON.stringify(fields), 'utf8'), kp.secretKey), 'hex')
const publicKey = b4a.toString(kp.publicKey, 'hex')
const manifest = {
  schema: 'peersync-update-v1',
  appVersion,
  buildLabel,
  platform,
  size: bytes,
  sha256,
  signature,
  publicKey
}
const output = outputArg || `${artifact}.update.json`
fs.writeFileSync(output, JSON.stringify(manifest, null, 2) + '\n')
console.log(output)
