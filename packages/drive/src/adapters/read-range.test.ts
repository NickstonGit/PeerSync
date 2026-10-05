import { describe, it, expect } from 'vitest'
import type { FileHandle } from 'node:fs/promises'
import { readRange } from './read-range'

describe('readRange', () => {
  it('continues until the requested range is filled after short reads', async () => {
    const source = new Uint8Array([1, 2, 3, 4, 5, 6])
    const lengths = [2, 1, 3]
    let calls = 0
    const handle = {
      read: async (buffer: Uint8Array, bufferOffset: number, length: number, position: number) => {
        const n = Math.min(lengths[calls++] ?? length, length)
        buffer.set(source.slice(position, position + n), bufferOffset)
        return { bytesRead: n, buffer }
      }
    } as unknown as FileHandle

    await expect(readRange(handle, 0, source.length)).resolves.toEqual(source)
    expect(calls).toBe(3)
  })

  it('throws if the file reaches EOF before the requested range is full', async () => {
    const handle = {
      read: async () => ({ bytesRead: 0, buffer: new Uint8Array() })
    } as unknown as FileHandle

    await expect(readRange(handle, 10, 5)).rejects.toThrow(/Short read/)
  })
})
