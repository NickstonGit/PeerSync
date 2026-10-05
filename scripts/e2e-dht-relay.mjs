// Local hyperdht node used as a Hyperswarm relayThrough target for E2E.
// Prints one JSON line {key,host,port} then stays alive until SIGINT/SIGTERM.
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const DHT = require('hyperdht')
const { Server: BlindRelayServer } = require('blind-relay')

const node = new DHT({ ephemeral: false })
await node.ready()
const streams = new Set()
let closedReceived = 0
let closedTransmitted = 0
const relay = new BlindRelayServer({ createStream: (options) => {
  const stream = node.createRawStream(options)
  streams.add(stream)
  stream.once('close', () => {
    closedReceived += stream.bytesReceived
    closedTransmitted += stream.bytesTransmitted
    streams.delete(stream)
  })
  return stream
} })
const server = node.createServer((socket) => {
  socket.on('error', () => {})
  relay.accept(socket, { id: socket.remotePublicKey }).on('error', () => {})
})
await server.listen(node.defaultKeyPair)
const statsPath = process.argv[2]
const statsTimer = statsPath ? setInterval(() => {
  let bytesReceived = closedReceived
  let bytesTransmitted = closedTransmitted
  for (const stream of streams) {
    bytesReceived += stream.bytesReceived
    bytesTransmitted += stream.bytesTransmitted
  }
  fs.writeFileSync(statsPath + '.tmp', JSON.stringify({ ...relay.stats, bytesReceived, bytesTransmitted }))
  fs.renameSync(statsPath + '.tmp', statsPath)
}, 100) : null
const addr = typeof node.address === 'function' ? node.address() : null
const key = Buffer.from(node.defaultKeyPair.publicKey).toString('hex')
const host = '127.0.0.1'
const port = Number(addr?.port) || 0
process.stdout.write(JSON.stringify({ ok: true, key, host, port, bootstrap: `${host}:${port}` }) + '\n')

const stop = async () => {
  try {
    if (statsTimer) clearInterval(statsTimer)
    await relay.close()
    await server.close()
    await node.destroy()
  } catch {}
  process.exit(0)
}
process.on('SIGINT', () => void stop())
process.on('SIGTERM', () => void stop())
