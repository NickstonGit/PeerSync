import type { FileHandle } from 'node:fs/promises'

export async function readRange(
  handle: FileHandle,
  offset: number,
  length: number
): Promise<Uint8Array> {
  const buffer = new Uint8Array(length)
  let filled = 0
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled)
    if (bytesRead <= 0) {
      throw new Error(`Short read at offset ${offset + filled}: expected ${length - filled} more bytes`)
    }
    filled += bytesRead
  }
  return buffer
}
