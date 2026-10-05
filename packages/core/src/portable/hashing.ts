// blake2b-256 (32 raw bytes, hex64 over the wire) — pure JS (@noble/hashes):
// identical output on Bare and Node, streaming-capable, zero native deps.

import b4a from 'b4a'
import { sha256 } from '@noble/hashes/sha2.js'
import { openFile, bytesReadOf } from './fs-handle'
import { FileDigest } from './content-digest'

export {
  DIGEST_BYTES,
  DIGEST_HEX,
  FileDigest,
  blake2b256,
  blake2b256Hex,
  isValidDigestHex
} from './content-digest'

const READ_CHUNK = 1 << 20

class HashCancelledError extends Error {
  code = 'CANCELLED'
  constructor() {
    super('hash cancelled')
  }
}

export async function hashFile(
  path: string,
  shouldCancel?: () => boolean,
  onProgress?: (bytes: number) => void
): Promise<{ hex: string; size: number }> {
  const handle = await openFile(path, 'r')
  const d = new FileDigest()
  try {
    const buf = b4a.allocUnsafe(READ_CHUNK)
    for (;;) {
      if (shouldCancel?.()) throw new HashCancelledError()
      const bytesRead = bytesReadOf(await handle.read(buf, 0, READ_CHUNK, d.bytes))
      if (bytesRead <= 0) break
      d.update(buf.subarray(0, bytesRead))
      onProgress?.(d.bytes)
      if (shouldCancel?.()) throw new HashCancelledError()
    }
  } finally {
    await handle.close()
  }
  return { hex: d.digestHex(), size: d.bytes }
}

export async function sha256File(
  path: string,
  shouldCancel?: () => boolean,
  onProgress?: (bytes: number) => void
): Promise<{ hex: string; size: number }> {
  const handle = await openFile(path, 'r')
  const digest = sha256.create()
  let bytes = 0
  try {
    const buf = b4a.allocUnsafe(READ_CHUNK)
    for (;;) {
      if (shouldCancel?.()) throw new HashCancelledError()
      const bytesRead = bytesReadOf(await handle.read(buf, 0, READ_CHUNK, bytes))
      if (bytesRead <= 0) break
      digest.update(buf.subarray(0, bytesRead))
      bytes += bytesRead
      onProgress?.(bytes)
      if (shouldCancel?.()) throw new HashCancelledError()
    }
  } finally {
    await handle.close()
  }
  return { hex: b4a.toString(digest.digest(), 'hex'), size: bytes }
}

export async function hashFileRange(path: string, offset: number, length: number): Promise<string> {
  const handle = await openFile(path, 'r')
  const d = new FileDigest()
  try {
    const buf = b4a.allocUnsafe(Math.min(READ_CHUNK, Math.max(1, length)))
    let pos = offset
    let left = length
    while (left > 0) {
      const bytesRead = bytesReadOf(await handle.read(buf, 0, Math.min(buf.byteLength, left), pos))
      if (bytesRead <= 0) break
      d.update(buf.subarray(0, bytesRead))
      pos += bytesRead
      left -= bytesRead
    }
  } finally {
    await handle.close()
  }
  return d.digestHex()
}
