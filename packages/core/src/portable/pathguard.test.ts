import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { validateRelativePath, PathError, resolveAllowedPath, ensureRealDirs } from './pathguard'

const tmpDirs: string[] = []

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

describe('validateRelativePath', () => {
  it('rejects traversal, UNC, ADS, reserved names, trailing junk', () => {
    const bad = [
      '..',
      'a/../b',
      '/abs',
      '//server/share',
      'C:foo',
      'name:stream',
      'foo\\bar',
      'CON',
      'con.txt',
      'COM1',
      'LPT9.log',
      'aux',
      'a.',
      'a ',
      'foo<>bar'
    ]
    for (const p of bad) {
      expect(() => validateRelativePath(p), p).toThrow(PathError)
    }
  })

  it('accepts nested relative files', () => {
    expect(validateRelativePath('nested/deep/conf.txt')).toBe('nested/deep/conf.txt')
  })
})


describe('resolveAllowedPath root file targets', () => {
  it('rejects the shared root itself as a GET/PUT/MKDIR target', async () => {
    // The rejection happens before touching the filesystem, so a dummy root is
    // enough to prove empty file targets cannot derive sibling temp paths.
    await expect(resolveAllowedPath('C:\\dummy-root', '', 'GET')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(resolveAllowedPath('C:\\dummy-root', '', 'PUT', 'create-chain')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(resolveAllowedPath('C:\\dummy-root', '', 'MKDIR', 'create-chain')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })
})

describe('resolveAllowedPath junctions', () => {
  it('blocks a directory junction as a reparse escape', async () => {
    if (process.platform !== 'win32') return
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'as-pg-'))
    tmpDirs.push(tmp)
    const root = path.join(tmp, 'root')
    const outside = path.join(tmp, 'outside')
    fs.mkdirSync(root)
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'x')
    const junc = path.join(root, 'esc')
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', junc, outside], { windowsHide: true })
    await expect(resolveAllowedPath(root, 'esc', 'LIST')).rejects.toMatchObject({ code: 'NOT_ALLOWED' })
    await expect(resolveAllowedPath(root, 'esc/secret.txt', 'GET')).rejects.toMatchObject({ code: 'NOT_ALLOWED' })
  })

  it('blocks PUT parent creation through a directory junction', async () => {
    if (process.platform !== 'win32') return
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'as-pg-write-'))
    tmpDirs.push(tmp)
    const root = path.join(tmp, 'root')
    const outside = path.join(tmp, 'outside')
    fs.mkdirSync(root)
    fs.mkdirSync(outside)
    const junc = path.join(root, 'esc')
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', junc, outside], { windowsHide: true })

    await expect(ensureRealDirs(path.join(junc, 'nested'), root)).rejects.toMatchObject({
      code: 'NOT_ALLOWED'
    })
    await expect(resolveAllowedPath(root, 'esc/file.txt', 'PUT', 'create-chain')).rejects.toMatchObject({
      code: 'NOT_ALLOWED'
    })
  })
})
