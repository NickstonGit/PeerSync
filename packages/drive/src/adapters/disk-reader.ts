import fs from '#fs'
import type { FileHandle } from 'node:fs/promises'
import type { ChunkReader } from '../engine/types'
import { readRange } from './read-range'

export class DiskReader implements ChunkReader {
  private readonly path: string
  private opening: Promise<FileHandle> | null = null
  private closed = false

  constructor(path: string) {
    this.path = path
  }

  private handle(): Promise<FileHandle> {
    if (this.closed) throw new Error('DiskReader is closed')
    const pending = this.opening ?? (fs.open(this.path, 'r') as Promise<FileHandle>)
    this.opening = pending
    return pending
  }

  async size(): Promise<number> {
    // Pin metadata and all later reads to the same opened file handle. A path
    // may be replaced between size() and read(); mixing two inodes can produce
    // a transfer whose advertised size belongs to different content.
    return (await (await this.handle()).stat()).size
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    return readRange(await this.handle(), offset, length)
  }

  async close(): Promise<void> {
    this.closed = true
    const pending = this.opening
    this.opening = null
    if (!pending) return
    try {
      await (await pending).close()
    } catch {}
  }
}
