import { afterEach, describe, expect, it } from 'vitest'
import fs from 'bare-fs/promises'
import os from 'bare-os'
import path from 'bare-path'
import { createDiskAdapter, DirectDiskAdapter } from './disk-adapter'
import { ManifestHashCache } from './manifest-hash-cache'
import { joinNativePart } from './native-path'
import { copyFileExclusiveLocal } from './copy-local'

const tmpDirs: string[] = []

afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

async function fixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-adapter-'))
  tmpDirs.push(dir)
  return dir
}

function direct(): DirectDiskAdapter {
  return new DirectDiskAdapter(new ManifestHashCache(null))
}

describe('disk adapter construction', () => {
  it('builds an adapter for the current runtime', () => {
    const { adapter, hashCache } = createDiskAdapter(null)
    expect(adapter).toBeDefined()
    expect(hashCache).toBeInstanceOf(ManifestHashCache)
  })
})

describe('direct disk adapter', () => {
  it('resolves and stats a file inside the root', async () => {
    const dir = await fixture()
    await fs.writeFile(path.join(dir, 'a.txt'), 'hello')
    const entry = await direct().statPath(dir, 'a.txt')
    expect(entry?.name).toBe('a.txt')
  })

  it('rejects a path that escapes the root', async () => {
    const dir = await fixture()
    await expect(direct().statPath(dir, '../outside.txt')).rejects.toThrow()
  })

  it('rejects a traversal segment before touching the filesystem', async () => {
    const dir = await fixture()
    await expect(direct().preparePut(dir, '../evil.txt')).rejects.toThrow()
  })

  it('creates the parent chain for a put target', async () => {
    const dir = await fixture()
    const target = await direct().preparePut(dir, 'deep/nested/file.txt')
    expect(target.endsWith('deep') || target.endsWith('deep/nested')).toBe(false)
    expect(await fs.stat(path.join(dir, 'deep', 'nested')).then(() => true).catch(() => false)).toBe(true)
  })

  it('lists entries without the worker', async () => {
    const dir = await fixture()
    await fs.writeFile(path.join(dir, 'a.txt'), 'a')
    await fs.writeFile(path.join(dir, 'b.txt'), 'b')
    const names = (await direct().listAll(dir, '', null)).map((e) => e.name).sort()
    expect(names).toEqual(['a.txt', 'b.txt'])
  })

  it('statPaths reports per-entry errors instead of failing the batch', async () => {
    const dir = await fixture()
    await fs.writeFile(path.join(dir, 'present.txt'), 'x')
    const results = await direct().statPaths(dir, ['present.txt', 'missing.txt'])
    expect(results[0].entry?.name).toBe('present.txt')
    expect(results[1].error?.code).toBe('NOT_FOUND')
  })

  it('unlink tolerates a missing file only when asked', async () => {
    const dir = await fixture()
    const adapter = direct()
    await expect(adapter.unlink(path.join(dir, 'nope.txt'), true)).resolves.toBeUndefined()
    await expect(adapter.unlink(path.join(dir, 'nope.txt'), false)).rejects.toThrow()
  })

  it('deletes a real file', async () => {
    const dir = await fixture()
    const target = path.join(dir, 'gone.txt')
    await fs.writeFile(target, 'x')
    await direct().unlink(target, false)
    expect(await fs.stat(target).then(() => true).catch(() => false)).toBe(false)
  })

  it('rename moves a file and link aliases one', async () => {
    const dir = await fixture()
    const source = path.join(dir, 'source.txt')
    const moved = path.join(dir, 'moved.txt')
    const alias = path.join(dir, 'alias.txt')
    await fs.writeFile(source, 'payload')
    const adapter = direct()

    await adapter.rename(source, moved)
    expect(await fs.readFile(moved, 'utf8')).toBe('payload')

    await adapter.link(moved, alias)
    expect(await fs.readFile(alias, 'utf8')).toBe('payload')
  })

  it('copyExclusive refuses to clobber an existing destination', async () => {
    const dir = await fixture()
    const source = path.join(dir, 'src.txt')
    const taken = path.join(dir, 'taken.txt')
    await fs.writeFile(source, 'new')
    await fs.writeFile(taken, 'existing')

    await expect(direct().copyExclusive(source, taken)).rejects.toMatchObject({ code: 'EEXIST' })
    // The pre-existing file must be untouched.
    expect(await fs.readFile(taken, 'utf8')).toBe('existing')
  })
})

describe('exclusive claim and copy', () => {
  it('claims a name, reports its identity, then fills it', async () => {
    const dir = await fixture()
    const source = path.join(dir, 'src.txt')
    const destination = path.join(dir, 'dest.txt')
    await fs.writeFile(source, 'payload bytes')
    const adapter = direct()

    const identity = await adapter.claimExclusiveCopy(destination)
    expect(identity.split(':')).toHaveLength(4)
    expect(identity).not.toContain(' ')
    // The name exists but is still empty: no payload byte has been written.
    expect((await fs.stat(destination)).size).toBe(0)

    await adapter.copyIntoClaim(source)
    expect(await fs.readFile(destination, 'utf8')).toBe('payload bytes')
  })

  it('records identity in a form that survives a JSON journal', async () => {
    const dir = await fixture()
    const destination = path.join(dir, 'identity.txt')
    const adapter = direct()
    const identity = await adapter.claimExclusiveCopy(destination)
    await adapter.dispose()

    // Inode numbers exceed Number.MAX_SAFE_INTEGER, which is exactly why the
    // identity is a string rather than a number. Round-tripping it through
    // JSON must be lossless.
    const [, inode] = identity.split(':')
    expect(BigInt(inode)).toBeGreaterThan(0n)
    const revived = JSON.parse(JSON.stringify({ identity })) as { identity: string }
    expect(revived.identity).toBe(identity)
  })

  it('copyIntoClaim fails closed when nothing was claimed', async () => {
    const dir = await fixture()
    await fs.writeFile(path.join(dir, 'src.txt'), 'x')
    await expect(direct().copyIntoClaim(path.join(dir, 'src.txt'))).rejects.toMatchObject({
      code: 'IO'
    })
  })

  it('refuses to claim a name that already exists', async () => {
    const dir = await fixture()
    const destination = path.join(dir, 'taken.txt')
    await fs.writeFile(destination, 'mine')
    await expect(direct().claimExclusiveCopy(destination)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await fs.readFile(destination, 'utf8')).toBe('mine')
  })

  it('copyIntoClaim fails closed when nothing was claimed', async () => {
    const dir = await fixture()
    await fs.writeFile(path.join(dir, 'src.txt'), 'x')
    await expect(direct().copyIntoClaim(path.join(dir, 'src.txt'))).rejects.toMatchObject({
      code: 'IO'
    })
  })

  it('dispose releases a stale claim so a retry can claim again', async () => {
    const dir = await fixture()
    const adapter = direct()
    const first = path.join(dir, 'a.txt')
    await adapter.claimExclusiveCopy(first)
    await adapter.dispose()

    const second = path.join(dir, 'b.txt')
    const identity = await adapter.claimExclusiveCopy(second)
    expect(identity).toBeTruthy()
    await adapter.dispose()
  })
})

describe('local copy helper', () => {
  it('never truncates an existing destination', async () => {
    const dir = await fixture()
    const source = path.join(dir, 'src.txt')
    const destination = path.join(dir, 'dst.txt')
    await fs.writeFile(source, 'new content')
    await fs.writeFile(destination, 'old content much longer')

    await expect(copyFileExclusiveLocal(source, destination)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await fs.readFile(destination, 'utf8')).toBe('old content much longer')
  })

  it('copies a missing source without creating a destination', async () => {
    const dir = await fixture()
    const destination = path.join(dir, 'dst.txt')
    await expect(copyFileExclusiveLocal(path.join(dir, 'absent.txt'), destination)).rejects.toThrow()
    expect(await fs.stat(destination).then(() => true).catch(() => false)).toBe(false)
  })
})

describe('native path joining', () => {
  it('joins a relative path onto the physical root', () => {
    expect(joinNativePart('/root', 'a/b.txt')).toBe(path.join('/root', 'a', 'b.txt'))
  })

  it('returns the root unchanged for an empty relative path', () => {
    expect(joinNativePart('/root', '')).toBe(path.join('/root'))
  })
})
