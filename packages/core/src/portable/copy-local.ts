/**
 * In-process file copy helpers.
 *
 * These are the non-worker fallback for a runtime where the isolated I/O worker
 * cannot be spawned. They live outside `fs-engine.ts` so the disk adapter can
 * use them without importing the protocol state machine.
 */
import fsp from 'bare-fs/promises'
import { openFile, bytesReadOf, bytesWrittenOf, type FileHandle } from './fs-handle'
import { EngineError } from './errors'

/** Streaming chunk size for local copies. */
export const COPY_CHUNK = 1 << 20

/** Write a full buffer at an offset, tolerating short writes. */
export async function writeExact(
  handle: FileHandle,
  buffer: Uint8Array,
  offset: number,
  cancelled?: () => boolean
): Promise<void> {
  let written = 0
  while (written < buffer.length) {
    if (cancelled?.()) throw new EngineError('CANCELLED', 'transfer cancelled')
    const count = bytesWrittenOf(
      await handle.write(buffer, written, buffer.length - written, offset + written)
    )
    if (count <= 0) throw new EngineError('IO', 'copy destination write stalled')
    written += count
  }
}

/**
 * Copy to a path that must not exist, without ever truncating an existing file.
 *
 * A destination this call created is removed on failure, so a retry or resume
 * never finds a half-written file it believes it owns.
 */
export async function copyFileExclusiveLocal(
  from: string,
  to: string,
  cancelled?: () => boolean
): Promise<void> {
  const source = await openFile(from, 'r')
  let destination: FileHandle | null = null
  let created = false
  try {
    const st = await source.stat()
    if (!st.isFile()) throw new EngineError('IO', 'copy source is not a regular file')
    if (cancelled?.()) throw new EngineError('CANCELLED', 'transfer cancelled')
    destination = await openFile(to, 'wx')
    created = true
    const buffer = new Uint8Array(Math.min(COPY_CHUNK, Math.max(1, st.size)))
    let position = 0
    while (position < st.size) {
      if (cancelled?.()) throw new EngineError('CANCELLED', 'transfer cancelled')
      const wanted = Math.min(buffer.byteLength, st.size - position)
      const n = bytesReadOf(await source.read(buffer, 0, wanted, position))
      if (n <= 0) throw new EngineError('IO', 'copy source ended early')
      await writeExact(destination, buffer.subarray(0, n), position, cancelled)
      position += n
    }
    await destination.sync()
  } catch (err) {
    if (destination) {
      try { await destination.close() } catch {}
    }
    if (created) {
      await fsp.unlink(to).catch(() => {})
    }
    throw err
  } finally {
    try { await source.close() } catch {}
  }
}
