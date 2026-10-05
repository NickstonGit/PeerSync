// bare-fs/promises FileHandle as it behaves at runtime. The shipped bare-fs
// typings declare `read()`/`write()` as returning a bare number, while the
// implementation (and Node, which the vitest alias maps to) resolve with
// `{ bytesRead }` / `{ bytesWritten }`. Both shapes are accepted here so the
// code stays correct on either runtime.

import fsp from 'bare-fs/promises'

export type BareStats = Awaited<ReturnType<typeof fsp.lstat>>

type OpenFlag = Parameters<typeof fsp.open>[1]
type ReadResult = number | { bytesRead: number }
type WriteResult = number | { bytesWritten: number }

export interface FileHandle {
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null
  ): Promise<ReadResult>
  write(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null
  ): Promise<WriteResult>
  stat(): Promise<BareStats>
  sync(): Promise<void>
  truncate(len: number): Promise<void>
  close(): Promise<void>
}

export async function openFile(path: string, flags: OpenFlag): Promise<FileHandle> {
  return (await fsp.open(path, flags)) as unknown as FileHandle
}

export function bytesReadOf(res: ReadResult): number {
  return typeof res === 'number' ? res : res.bytesRead
}

export function bytesWrittenOf(res: WriteResult): number {
  return typeof res === 'number' ? res : res.bytesWritten
}
