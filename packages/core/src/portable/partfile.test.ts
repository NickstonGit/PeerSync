import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { allocatePartFile } from './partfile'

const tmpDirs: string[] = []

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

describe('allocatePartFile', () => {
  it('keeps already-downloaded bytes on resume (r+ not w)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-part-'))
    tmpDirs.push(dir)
    const part = path.join(dir, 'file.bin.part')
    const payload = Buffer.alloc(64, 0)
    payload.write('HELLO-RESUME', 0)
    fs.writeFileSync(part, payload)
    await allocatePartFile(part, 64)
    const after = fs.readFileSync(part)
    expect(after.length).toBe(64)
    expect(after.subarray(0, 12).toString()).toBe('HELLO-RESUME')
  })

  it('creates a new .part when missing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-part-'))
    tmpDirs.push(dir)
    const part = path.join(dir, 'nested', 'file.bin.part')
    await allocatePartFile(part, 32)
    expect(fs.statSync(part).size).toBe(32)
  })
})
