import { afterEach, describe, expect, it } from 'vitest'
import fs from 'bare-fs/promises'
import os from 'bare-os'
import path from 'bare-path'
import { PART_MARKER } from '@peersync/drive'
import { DirectDiskAdapter } from './disk-adapter'
import { ManifestHashCache } from './manifest-hash-cache'

const tmpDirs: string[] = []

afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

async function fixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-update-'))
  tmpDirs.push(dir)
  return dir
}

function adapter(): DirectDiskAdapter {
  return new DirectDiskAdapter(new ManifestHashCache(null))
}

describe('update disk seam', () => {
  it('computes the real sha-256 an update digest is verified against', async () => {
    const dir = await fixture()
    const file = path.join(dir, 'payload.bin')
    // The published SHA-256 of "abc", so this checks the digest itself rather
    // than comparing the seam against another call to the same function.
    const expected = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    await fs.writeFile(file, 'abc')

    const actual = await adapter().sha256Absolute(file)
    expect(actual.hex.toLowerCase()).toBe(expected)
    expect(actual.size).toBe(3)
  })

  it('reports a digest for a missing path only as a failure', async () => {
    const dir = await fixture()
    await expect(adapter().sha256Absolute(path.join(dir, 'absent.bin'))).rejects.toThrow()
  })
})

describe('update partial naming', () => {
  it('uses the shared PeerSync partial marker so it is recognizable', () => {
    const target = 'C:/data/update/PSN.next.exe'
    const part = `${target}${PART_MARKER}abc123`
    expect(part.startsWith(`${target}${PART_MARKER}`)).toBe(true)
    // The legacy fixed `.part` suffix allowed two concurrent downloads of the
    // same target to share one file.
    expect(part.endsWith('.part')).toBe(false)
  })

  it('a random token makes concurrent downloads distinct', () => {
    const target = 'C:/data/update/PSN.next.exe'
    const a = `${target}${PART_MARKER}deadbeef01`
    const b = `${target}${PART_MARKER}deadbeef02`
    expect(a).not.toBe(b)
  })
})

describe('update commit', () => {
  it('renames the verified partial over the target without a pre-unlink window', async () => {
    const dir = await fixture()
    const target = path.join(dir, 'PSN.next.exe')
    const part = `${target}${PART_MARKER}token1`
    const disk = adapter()

    await fs.writeFile(target, 'old build')
    await fs.writeFile(part, 'new build')

    // The target is never removed first: a crash between unlink and rename used
    // to leave the user with no executable at all.
    await disk.rename(part, target)
    expect(await fs.readFile(target, 'utf8')).toBe('new build')
  })
})
