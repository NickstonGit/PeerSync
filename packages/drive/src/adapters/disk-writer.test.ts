import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DiskWriter } from './disk-writer'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('DiskWriter no-clobber publish', () => {
  it('falls back to exclusive copy when hard links are unsupported', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'peersync-disk-writer-'))
    try {
      const target = path.join(dir, 'file.bin')
      await fs.writeFile(target, Buffer.from('local'))
      vi.spyOn(fs, 'link').mockRejectedValue(
        Object.assign(new Error('hard links unsupported'), { code: 'ENOTSUP' })
      )

      const writer = new DiskWriter(target)
      expect(writer.partPath).toContain('.peersync-part-')
      expect(writer.partPath).not.toContain('.altersend-part-')
      const bytes = Buffer.from('incoming')
      await writer.allocate(bytes.length)
      await writer.write(0, bytes)
      const destination = await writer.finalize()

      expect(await fs.readFile(target, 'utf8')).toBe('local')
      expect(path.basename(destination)).toBe('file (1).bin')
      expect(await fs.readFile(destination, 'utf8')).toBe('incoming')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('treats a successful hard-link as committed when the published checkpoint fails', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'peersync-disk-link-checkpoint-'))
    try {
      const target = path.join(dir, 'file.bin')
      const writer = new DiskWriter(target)
      const bytes = Buffer.from('incoming')
      await writer.allocate(bytes.length)
      await writer.write(0, bytes)

      const originalRename = fs.rename.bind(fs)
      let renameCalls = 0
      vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
        renameCalls += 1
        // allocate metadata = 1, link claiming metadata = 2, published = 3
        if (renameCalls === 3) throw Object.assign(new Error('checkpoint failed'), { code: 'EIO' })
        return await originalRename(...args)
      })

      const destination = await writer.finalize()
      expect(destination).toBe(target)
      expect(await fs.readFile(target, 'utf8')).toBe('incoming')
      await expect(fs.access(path.join(dir, 'file (1).bin'))).rejects.toThrow()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('does not publish when prepared-content verification fails', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'peersync-disk-verify-'))
    try {
      const target = path.join(dir, 'file.bin')
      const writer = new DiskWriter(target, {
        verifyPrepared: async () => {
          throw new Error('digest mismatch')
        }
      })
      await writer.allocate(4)
      await writer.write(0, Buffer.from('data'))

      await expect(writer.finalize()).rejects.toThrow(/digest mismatch/)
      await expect(fs.access(target)).rejects.toThrow()
      expect(await fs.readFile(writer.partPath, 'utf8')).toBe('data')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('recovers an owned legacy transport partial but creates new PeerSync partials', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'peersync-disk-legacy-recovery-'))
    try {
      const target = path.join(dir, 'file.bin')
      const legacyPart = `${target}.altersend-part-legacy`
      await fs.writeFile(legacyPart, Buffer.from('old-partial'))
      await fs.writeFile(`${legacyPart}.meta`, JSON.stringify({ version: 2, targetPath: target }), 'utf8')

      const writer = new DiskWriter(target)
      await writer.allocate(1)
      expect(writer.partPath).toContain('.peersync-part-')
      await expect(fs.access(legacyPart)).rejects.toThrow()
      await expect(fs.access(`${legacyPart}.meta`)).rejects.toThrow()
      await writer.abort()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

})
