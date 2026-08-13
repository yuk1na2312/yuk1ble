/**
 * In-memory ring buffer of server console output.
 *
 * The monitoring GUI needs the same stream you would otherwise watch in the
 * `npm run dev` window. Console methods are patched once at startup; the
 * originals are always called, so the terminal keeps working unchanged.
 */

const MAX_ENTRIES = 2000

export interface LogEntry {
  seq: number
  timestamp: string
  level: 'log' | 'warn' | 'error'
  text: string
}

const entries: LogEntry[] = []
let seq = 0
let installed = false

function record(level: LogEntry['level'], args: unknown[]): void {
  const text = args
    .map(arg => {
      if (typeof arg === 'string') return arg
      if (arg instanceof Error) return arg.stack || arg.message
      try {
        return JSON.stringify(arg)
      } catch {
        return String(arg)
      }
    })
    .join(' ')

  entries.push({ seq: ++seq, timestamp: new Date().toISOString(), level, text })
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
}

/** Patch console.log/warn/error to tee into the buffer. Safe to call twice. */
export function installLogCapture(): void {
  if (installed) return
  installed = true

  const levels: Array<LogEntry['level']> = ['log', 'warn', 'error']
  for (const level of levels) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      try {
        record(level, args)
      } catch {
        // Never let logging break the caller.
      }
      original(...args)
    }
  }
}

/** Entries newer than `since` (a seq number). Omit `since` for the whole buffer. */
export function getLogEntries(since?: number): { entries: LogEntry[]; latest: number } {
  const from = Number.isFinite(since) ? (since as number) : 0
  return { entries: entries.filter(entry => entry.seq > from), latest: seq }
}
