import process from 'bare-process'

export type DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error' | 'critical'

const rank: Record<DiagnosticLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  critical: 50
}

let level: DiagnosticLevel = 'error'
const runtimePid = typeof Bare !== 'undefined' ? Bare.pid : 0
const sessionId = `${runtimePid}-${Date.now().toString(36)}`

try {
  if (['1', 'true', 'yes', 'on'].includes(String(Bare.env?.PEERSYNC_DEBUG ?? '').toLowerCase())) level = 'debug'
} catch {}

function text(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) ?? String(value) } catch { return String(value) }
}

function safeText(value: unknown): string {
  return text(value)
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"']+/g, '[PATH]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[IP]')
}

function emit(levelValue: DiagnosticLevel, event: string, component: string, message: string, fields: Record<string, unknown> = {}): void {
  if (rank[levelValue] < rank[level]) return
  const record: Record<string, unknown> = {
    schemaVersion: 1,
    sessionId,
    tsMs: Date.now(),
    level: levelValue,
    source: 'core',
    component,
    event,
    message: safeText(message).slice(0, 4096)
  }
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    record[key] = typeof value === 'string' ? safeText(value).slice(0, 1024) : value
  }
  try { process.stderr.write(JSON.stringify(record) + '\n') } catch {}
}

export function setDebugEnabled(value: boolean): void {
  level = value ? 'debug' : 'error'
}

export function setDiagnosticLevel(value: DiagnosticLevel): void {
  if (value in rank) level = value
}

export function getDiagnosticLevel(): DiagnosticLevel {
  return level
}

export function dbg(...parts: unknown[]): void {
  emit('debug', 'core.debug', 'core', parts.map(text).join(' '))
}

export function pairLog(...parts: unknown[]): void {
  emit('info', 'peer.pair', 'peers', parts.map(text).join(' '))
}

export function diagnostic(levelValue: DiagnosticLevel, event: string, component: string, message: string, fields?: Record<string, unknown>): void {
  emit(levelValue, event, component, message, fields)
}
