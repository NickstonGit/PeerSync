#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const technicalVersion = '0.0.0'

const paths = {
  rootPackage: resolve(root, 'package.json'),
  corePackage: resolve(root, 'packages/core/package.json'),
  drivePackage: resolve(root, 'packages/drive/package.json'),
  packageLock: resolve(root, 'package-lock.json'),
}

const releaseVersionRe = /^\d{6}$/
const maxReleaseRevision = 99_999_999

function readText(path) {
  return readFileSync(path, 'utf8')
}

function parseJson(path) {
  return JSON.parse(readText(path))
}

function newlineOf(text) {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

function formatJson(value, originalText) {
  const nl = newlineOf(originalText)
  return `${JSON.stringify(value, null, 2).replaceAll('\n', nl)}${nl}`
}

function todayReleaseVersion(now = new Date()) {
  const dd = String(now.getDate()).padStart(2, '0')
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const yy = String(now.getFullYear()).slice(-2)
  return `${dd}${mm}${yy}`
}

function validateReleaseVersion(value) {
  const release = String(value ?? '').trim()
  if (!releaseVersionRe.test(release)) {
    throw new Error(`invalid PeerSync version: ${release}; expected DDMMYY`)
  }
  const day = Number(release.slice(0, 2))
  const month = Number(release.slice(2, 4))
  const year = 2000 + Number(release.slice(4, 6))
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`invalid PeerSync calendar date: ${release}`)
  }
  return release
}

function validateReleaseRevision(value) {
  // The DDMMYY label stays the user-facing version. The revision is the
  // machine-orderable identity that lets two different official builds share one
  // calendar date, so it must be a positive integer and strictly monotonic per
  // releaseVersion (the release workflow enforces that against real tags).
  const revision = typeof value === 'number' ? value : Number(String(value ?? '').trim())
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > maxReleaseRevision) {
    throw new Error(`invalid PeerSync release revision: ${value}; expected an integer 1..${maxReleaseRevision}`)
  }
  return revision
}

function collectState() {
  return {
    rootPackage: parseJson(paths.rootPackage),
    corePackage: parseJson(paths.corePackage),
    drivePackage: parseJson(paths.drivePackage),
    packageLock: parseJson(paths.packageLock),
  }
}

function checkState(state) {
  const releaseVersion = validateReleaseVersion(state.rootPackage.releaseVersion)
  const releaseRevision = validateReleaseRevision(state.rootPackage.releaseRevision)
  const mismatches = []
  const expect = (name, actual, expected) => {
    if (actual !== expected) mismatches.push(`${name}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
  }

  // 0.0.0 is private npm/workspace plumbing only; it is never the PeerSync product version.
  expect('package.json technical version', state.rootPackage.version, technicalVersion)
  expect('packages/core/package.json version', state.corePackage.version, technicalVersion)
  expect('packages/drive/package.json version', state.drivePackage.version, technicalVersion)
  expect(
    'packages/core/package.json @peersync/drive',
    state.corePackage.dependencies?.['@peersync/drive'],
    technicalVersion
  )
  expect('package-lock.json version', state.packageLock.version, technicalVersion)
  expect('package-lock.json packages[""] version', state.packageLock.packages?.['']?.version, technicalVersion)
  expect('package-lock.json packages["packages/core"] version', state.packageLock.packages?.['packages/core']?.version, technicalVersion)
  expect(
    'package-lock.json packages["packages/core"] @peersync/drive',
    state.packageLock.packages?.['packages/core']?.dependencies?.['@peersync/drive'],
    technicalVersion
  )
  expect('package-lock.json packages["packages/drive"] version', state.packageLock.packages?.['packages/drive']?.version, technicalVersion)

  if ('buildLabel' in state.rootPackage) {
    mismatches.push('package.json buildLabel must be removed; use releaseVersion only')
  }

  if (mismatches.length) {
    throw new Error(`portable version metadata is out of sync:\n- ${mismatches.join('\n- ')}`)
  }
  return { releaseVersion, releaseRevision }
}

function buildUpdatedFiles(releaseVersion, releaseRevision) {
  const release = validateReleaseVersion(releaseVersion)
  const revision = validateReleaseRevision(releaseRevision)
  const state = collectState()
  state.rootPackage.version = technicalVersion
  state.rootPackage.releaseVersion = release
  state.rootPackage.releaseRevision = revision
  delete state.rootPackage.buildLabel

  state.corePackage.version = technicalVersion
  if (!state.corePackage.dependencies?.['@peersync/drive']) {
    throw new Error('packages/core/package.json is missing dependency @peersync/drive')
  }
  state.corePackage.dependencies['@peersync/drive'] = technicalVersion
  state.drivePackage.version = technicalVersion

  state.packageLock.version = technicalVersion
  if (!state.packageLock.packages?.['']) throw new Error('package-lock.json is missing root package metadata')
  if (!state.packageLock.packages?.['packages/core']) throw new Error('package-lock.json is missing packages/core metadata')
  if (!state.packageLock.packages?.['packages/drive']) throw new Error('package-lock.json is missing packages/drive metadata')
  state.packageLock.packages[''].version = technicalVersion
  state.packageLock.packages['packages/core'].version = technicalVersion
  state.packageLock.packages['packages/core'].dependencies['@peersync/drive'] = technicalVersion
  state.packageLock.packages['packages/drive'].version = technicalVersion

  return new Map([
    [paths.rootPackage, formatJson(state.rootPackage, readText(paths.rootPackage))],
    [paths.corePackage, formatJson(state.corePackage, readText(paths.corePackage))],
    [paths.drivePackage, formatJson(state.drivePackage, readText(paths.drivePackage))],
    [paths.packageLock, formatJson(state.packageLock, readText(paths.packageLock))],
  ])
}

function writeTransaction(files) {
  const originals = new Map()
  const written = []
  try {
    for (const [path] of files) originals.set(path, readText(path))
    for (const [path, content] of files) {
      writeFileSync(path, content, 'utf8')
      written.push(path)
    }
  } catch (error) {
    for (const path of written.reverse()) {
      try { writeFileSync(path, originals.get(path), 'utf8') } catch {}
    }
    throw error
  }
}

function usage() {
  console.error('Usage:')
  console.error('  npm run version:portable -- [DDMMYY] [revision]')
  console.error('  npm run version:portable:check')
}

function revisionArgument(index) {
  if (index >= process.argv.length) return undefined
  return process.argv[index]
}

try {
  if (process.argv[2] === '--check') {
    const { releaseVersion, releaseRevision } = checkState(collectState())
    console.log(`PeerSync version metadata OK: ${releaseVersion} r${releaseRevision}`)
    process.exit(0)
  }

  if (process.argv[2] === '--help' || process.argv[2] === '-h') {
    usage()
    process.exit(0)
  }

  // The revision only moves forward. An omitted argument keeps the current one,
  // so a same-day hotfix never silently reuses a released revision, and a new
  // DDMMYY label must still be paired with an explicitly chosen revision.
  const current = collectState().rootPackage
  const release = process.argv[2] ?? todayReleaseVersion()
  const sameDay = validateReleaseVersion(release) === validateReleaseVersion(current.releaseVersion)
  const requested = revisionArgument(3)
  let revision
  if (requested === undefined) {
    revision = validateReleaseRevision(current.releaseRevision)
    if (!sameDay) {
      throw new Error(
        `a new DDMMYY label requires an explicit revision: npm run version:portable -- ${release} <revision>`
      )
    }
  } else {
    revision = validateReleaseRevision(requested)
    if (revision <= validateReleaseRevision(current.releaseRevision) && sameDay) {
      throw new Error(
        `release revision must increase: ${current.releaseRevision} -> ${revision}`
      )
    }
  }
  writeTransaction(buildUpdatedFiles(release, revision))
  const checked = checkState(collectState())
  console.log(`PeerSync version -> ${checked.releaseVersion} r${checked.releaseRevision}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
