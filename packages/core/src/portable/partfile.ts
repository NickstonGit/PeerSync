// Resume-safe .part allocation: never open existing files with 'w' (truncates).

import fsp from 'bare-fs/promises'
import path from 'bare-path'
import { openFile, type FileHandle } from './fs-handle'
import { isErrnoCode } from './errors'

export async function allocatePartFile(
  partPath: string,
  size: number,
  opts: { exclusive?: boolean } = {}
): Promise<void> {
  await fsp.mkdir(path.dirname(partPath), { recursive: true })
  let h: FileHandle
  if (opts.exclusive) {
    h = await openFile(partPath, 'wx+')
  } else {
    try {
      h = await openFile(partPath, 'r+')
    } catch (err: unknown) {
      if (!isErrnoCode(err, 'ENOENT')) throw err
      h = await openFile(partPath, 'w+')
    }
  }
  try {
    await h.truncate(size)
  } finally {
    await h.close()
  }
}
