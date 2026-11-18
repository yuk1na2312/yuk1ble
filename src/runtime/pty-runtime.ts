import { existsSync } from 'fs'
import { basename, join } from 'path'
import headless from '@xterm/headless'
import type { Terminal as HeadlessTerminal } from '@xterm/headless'
import * as pty from 'node-pty'
import type { AgentRuntime, SendKeysOptions, SessionInfo } from './agent-runtime'
import { findOnPath, killProcessTree, killProcessTreeSync } from './win-process'
import { listAgentPrograms } from '../adapters/agent-config'

const { Terminal } = headless

interface PtySession {
  name: string
  pty: pty.IPty
  pid: number
  cwd: string
  createdAt: string
  term: HeadlessTerminal
  scrollback: string
  exited: boolean
  /** Exit listeners have fired and every listener is dropped. */
  ended: boolean
  dataListeners: Set<(chunk: string) => void>
  exitListeners: Set<() => void>
}

export const MAX_SCROLLBACK = 200_000
/** Per session and per kind: a runaway client cannot pile up listeners (each one is a retained closure). */
export const MAX_LISTENERS = 16
const sessions = new Map<string, PtySession>()

/**
 * Environment variables withheld from agent shells (provider credentials, and the
 * session state of whichever agent is running ensemble). Each adapter lists its own
 * in agents.json; the union applies to every shell because a session is created
 * before its program is known.
 */
function deniedEnvPatterns(): RegExp[] {
  return listAgentPrograms().flatMap(program => (program.stripEnv ?? []).map(source => new RegExp(source, 'i')))
}

const KEYMAP: Record<string, string> = {
  Enter: '\r',
  'C-m': '\r',
  'C-c': '\x03',
  'C-d': '\x04',
  'C-z': '\x1a',
  Escape: '\x1b',
  Tab: '\t',
  Space: ' ',
  Up: '\x1b[A',
  Down: '\x1b[B',
  Right: '\x1b[C',
  Left: '\x1b[D',
}

function pickShell(): string {
  const configured = process.env.ENSEMBLE_SHELL?.trim()
  if (configured) {
    if (/^cmd(?:\.exe)?$/i.test(basename(configured))) {
      throw new Error('ENSEMBLE_SHELL must be PowerShell; cmd.exe is not supported')
    }
    return configured
  }

  const pathPwsh = findOnPath('pwsh')
  if (pathPwsh) return pathPwsh

  const programFiles = process.env.ProgramFiles
  const standardPwsh = programFiles
    ? join(programFiles, 'PowerShell', '7', 'pwsh.exe')
    : undefined
  if (standardPwsh && existsSync(standardPwsh)) return standardPwsh

  return findOnPath('powershell') || 'powershell.exe'
}

function getSession(name: string): PtySession {
  const session = sessions.get(name)
  if (!session || session.exited) {
    throw new Error(`PTY session not found: ${name}`)
  }
  return session
}

/** Tell the exit listeners once, then drop every listener so the session holds nothing on to its subscribers. */
function endSession(session: PtySession): void {
  if (session.ended) return
  session.ended = true
  const listeners = [...session.exitListeners]
  session.dataListeners.clear()
  session.exitListeners.clear()
  for (const listener of listeners) {
    try {
      listener()
    } catch (err) {
      console.error(`[PtyRuntime] exit listener of ${session.name} threw:`, err)
    }
  }
}

function subscribe<T>(set: Set<T>, listener: T, name: string, kind: string): () => void {
  if (set.size >= MAX_LISTENERS) {
    throw new Error(`Too many ${kind} listeners on PTY session ${name} (max ${MAX_LISTENERS})`)
  }
  set.add(listener)
  return () => { set.delete(listener) }
}

async function killAll(): Promise<void> {
  const activeSessions = [...sessions.values()]
  sessions.clear()

  await Promise.all(activeSessions.map(async session => {
    session.exited = true
    endSession(session)
    try {
      session.pty.kill()
    } catch {
      // The process may already have exited.
    }
    await killProcessTree(session.pid)
  }))
}

process.once('exit', () => {
  for (const session of sessions.values()) {
    killProcessTreeSync(session.pid)
  }
})
process.once('SIGINT', () => {
  void killAll().finally(() => process.exit(0))
})
process.once('SIGTERM', () => {
  void killAll().finally(() => process.exit(0))
})

export class PtyRuntime implements AgentRuntime {
  list(): SessionInfo[] {
    return [...sessions.values()]
      .filter(session => !session.exited)
      .map(session => ({
        name: session.name,
        createdAt: session.createdAt,
        workingDirectory: session.cwd,
      }))
  }

  exists(name: string): boolean {
    const session = sessions.get(name)
    return Boolean(session && !session.exited)
  }

  async create(name: string, cwd: string): Promise<void> {
    if (this.exists(name)) {
      throw new Error(`PTY session already exists: ${name}`)
    }

    const deny = deniedEnvPatterns()
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !deny.some(re => re.test(k)))
    ) as Record<string, string>

    const term = new Terminal({
      cols: 120,
      rows: 40,
      scrollback: 5000,
      allowProposedApi: true,
    })
    const terminal = pty.spawn(pickShell(), [
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-NoExit',
      '-Command',
      '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); ' +
        '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ' +
        '$OutputEncoding = [Console]::OutputEncoding',
    ], {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd,
      env,
      useConptyDll: true,
    })

    const session: PtySession = {
      name,
      pty: terminal,
      pid: terminal.pid,
      cwd,
      createdAt: new Date().toISOString(),
      term,
      scrollback: '',
      exited: false,
      ended: false,
      dataListeners: new Set(),
      exitListeners: new Set(),
    }

    terminal.onData(chunk => {
      term.write(chunk)
      session.scrollback += chunk
      if (session.scrollback.length > MAX_SCROLLBACK) {
        session.scrollback = session.scrollback.slice(-MAX_SCROLLBACK)
      }
      for (const listener of session.dataListeners) {
        try {
          listener(chunk)
        } catch (err) {
          // A listener that throws would throw on every chunk: drop it.
          session.dataListeners.delete(listener)
          console.error(`[PtyRuntime] data listener of ${name} threw and was removed:`, err)
        }
      }
    })

    terminal.onExit(() => {
      session.exited = true
      term.dispose()
      if (sessions.get(session.name) === session) {
        sessions.delete(session.name)
      }
      endSession(session)
    })

    sessions.set(name, session)
  }

  async kill(name: string): Promise<void> {
    const session = sessions.get(name)
    if (!session) return

    session.exited = true
    endSession(session)
    try {
      session.pty.kill()
    } catch {
      // The PTY process may already have exited.
    }
    await killProcessTree(session.pid)
    sessions.delete(name)
  }

  write(name: string, data: string): void {
    getSession(name).pty.write(data)
  }

  sendKeys(name: string, keys: string, opts: SendKeysOptions = {}): void {
    const session = getSession(name)
    const tokens = keys.split(' ')
    const allTokensAreMapped = tokens.every(token =>
      Object.prototype.hasOwnProperty.call(KEYMAP, token)
    )
    const bytes = opts.literal || !allTokensAreMapped
      ? keys
      : tokens.map(key => KEYMAP[key]).join('')

    session.pty.write(opts.enter ? `${bytes}\r` : bytes)
  }

  paste(name: string, text: string): void {
    const session = getSession(name)
    // Two writes on purpose: the CR must not travel inside the paste burst (see src/core/paste-submit.ts).
    session.pty.write(text)
    session.pty.write('\r')
  }

  resize(name: string, cols: number, rows: number): void {
    if (!Number.isInteger(cols) || cols <= 0 || !Number.isInteger(rows) || rows <= 0) {
      throw new Error(`Invalid PTY dimensions: ${cols}x${rows}`)
    }
    const session = getSession(name)
    session.pty.resize(cols, rows)
    session.term.resize(cols, rows)
  }

  screen(name: string, lines: number = 2000): string {
    const session = sessions.get(name)
    if (!session || session.exited) return ''

    const lineCount = Math.max(1, Math.floor(lines))
    const buffer = session.term.buffer.active
    const end = buffer.baseY + buffer.cursorY
    const start = Math.max(0, end - lineCount + 1)
    const output: string[] = []
    for (let index = start; index <= end; index++) {
      output.push(buffer.getLine(index)?.translateToString(true) ?? '')
    }
    return output.join('\n')
  }

  replay(name: string): string {
    const session = sessions.get(name)
    return session && !session.exited ? session.scrollback : ''
  }

  onData(name: string, cb: (chunk: string) => void): () => void {
    return subscribe(getSession(name).dataListeners, cb, name, 'data')
  }

  onExit(name: string, cb: () => void): () => void {
    return subscribe(getSession(name).exitListeners, cb, name, 'exit')
  }
}
