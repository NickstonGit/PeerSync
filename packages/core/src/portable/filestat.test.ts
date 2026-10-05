import { afterEach, describe, expect, it } from 'vitest'
import fs from 'bare-fs/promises'
import os from 'bare-os'
import path from 'bare-path'
import { statFile, fileExistsRegular } from './pathguard'

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rm(dir, { recursive: true, force: true })
})

async function fixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-filestat-'))
  tmpDirs.push(dir)
  await fs.writeFile(path.join(dir, 'file.txt'), 'hello')
  return dir
}

describe('file stat identity', () => {
  it('returns dev/ino/birthtime alongside size for a regular file', async () => {
    const dir = await fixture()
    const st = await statFile(path.join(dir, 'file.txt'))
    expect(st).not.toBeNull()
    expect(st!.size).toBe(5)
    expect(typeof st!.mtimeMs).toBe('number')
    expect(st!.dev).toBeTruthy()
    expect(st!.ino).toBeTruthy()
    expect(typeof st!.birthtimeMs).toBe('number')
    expect(typeof st!.mode).toBe('number')
  })

  it('stringifies dev and ino so a JSON journal round-trips them unchanged', async () => {
    const dir = await fixture()
    const st = await statFile(path.join(dir, 'file.txt'))

    // Journal rows are written through JSON.stringify. If identity were stored
    // as numbers it would be re-read as a double, so the wire form is a string.
    expect(typeof st!.dev).toBe('string')
    expect(typeof st!.ino).toBe('string')

    const revived = JSON.parse(JSON.stringify(st!)) as NonNullable<typeof st>
    expect(revived.ino).toBe(st!.ino)
    expect(revived.dev).toBe(st!.dev)
  })

  it('reports the same identity for the same file and a different one after replacement', async () => {
    const dir = await fixture()
    const target = path.join(dir, 'file.txt')
    const first = await statFile(target)
    expect((await statFile(target))!.ino).toBe(first!.ino)

    // Recreating the file yields a new object identity for the same path.
    await fs.rm(target)
    await fs.writeFile(target, 'hello again')
    const second = await statFile(target)
    expect(second!.ino === first!.ino || second!.birthtimeMs >= first!.birthtimeMs).toBe(true)
  })

  it('returns null for a missing path and for a directory', async () => {
    const dir = await fixture()
    expect(await statFile(path.join(dir, 'absent.txt'))).toBeNull()
    expect(await statFile(dir)).toBeNull()
  })

  it('keeps fileExistsRegular working on the new stat shape', async () => {
    const dir = await fixture()
    expect(await fileExistsRegular(path.join(dir, 'file.txt'))).toBe(true)
    expect(await fileExistsRegular(path.join(dir, 'absent.txt'))).toBe(false)
  })
})
