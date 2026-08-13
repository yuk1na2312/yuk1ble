import { existsSync, readFileSync } from 'fs'
import { execFile, execFileSync } from 'child_process'
import { basename, delimiter, join } from 'path'
import headless from '@xterm/headless'
import type { Terminal as HeadlessTerminal } from '@xterm/headless'
import * as pty from 'node-pty'
import type { AgentRuntime, DiscoveredSession } from './agent-runtime'

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
}

const MAX_SCROLLBACK = 200_000
const sessions = new Map<string, PtySession>()
const DENY = [
  /^ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)$/i,
  /^OPENAI_(API_KEY|BASE_URL|ORGANIZATION)$/i,
  /^(GEMINI|GOOGLE)_API_KEY$/i,
  /^CLAUDE_CODE_/i, /^CLAUDECODE$/i, /^CLAUDE_(PID|EFFORT)$/i,
  /^CLAUDE_CODE_USE_(BEDROCK|VERTEX)$/i,
]

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

function executableNames(command: string): string[] {
  if (/\.[^\\/]+$/.test(command)) return [command]

  const extensions = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean)
  return [command, ...extensions.map(extension => `${command}${extension.toLowerCase()}`)]
}

function findOnPath(command: string): string | undefined {
  const pathValue = process.env.PATH || process.env.Path
  if (!pathValue) return undefined

  const names = executableNames(command)
  for (const directory of pathValue
    .split(delimiter)
    .filter(Boolean)
    .map(directory => directory.replace(/^"|"$/g, ''))) {
    for (const name of names) {
      const candidate = join(directory, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
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

function validateEnvironmentKey(key: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`Invalid environment variable name: ${key}`)
  }
  return key
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function killProcessTree(pid: number): Promise<void> {
  return new Promise(resolve => {
    execFile('taskkill', ['/T', '/F', '/PID', String(pid)], () => resolve())
  })
}

function killProcessTreeSync(pid: number): void {
  try {
    execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' })
  } catch {
    // The process tree may already have exited.
  }
}

async function killAll(): Promise<void> {
  const activeSessions = [...sessions.values()]
  sessions.clear()

  await Promise.all(activeSessions.map(async session => {
    session.exited = true
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
  readonly type = 'direct'

  async listSessions(): Promise<DiscoveredSession[]> {
    return [...sessions.values()]
      .filter(session => !session.exited)
      .map(session => ({
        name: session.name,
        windows: 1,
        createdAt: session.createdAt,
        workingDirectory: session.cwd,
      }))
  }

  async sessionExists(name: string): Promise<boolean> {
    return sessionExistsSync(name)
  }

  async getWorkingDirectory(name: string): Promise<string> {
    const session = sessions.get(name)
    return session && !session.exited ? session.cwd : ''
  }

  async isInCopyMode(_name: string): Promise<boolean> {
    return false
  }

  async cancelCopyMode(_name: string): Promise<void> {
    // Copy mode is a tmux concept and does not apply to an in-process PTY.
  }

  async createSession(name: string, cwd: string): Promise<void> {
    if (sessionExistsSync(name)) {
      throw new Error(`PTY session already exists: ${name}`)
    }

    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !DENY.some(re => re.test(k)))
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
    }

    terminal.onData(chunk => {
      term.write(chunk)
      session.scrollback += chunk
      if (session.scrollback.length > MAX_SCROLLBACK) {
        session.scrollback = session.scrollback.slice(-MAX_SCROLLBACK)
      }
    })

    terminal.onExit(() => {
      session.exited = true
      term.dispose()
      if (sessions.get(session.name) === session) {
        sessions.delete(session.name)
      }
    })

    sessions.set(name, session)
  }

  async killSession(name: string): Promise<void> {
    const session = sessions.get(name)
    if (!session) return

    session.exited = true
    try {
      session.pty.kill()
    } catch {
      // The PTY process may already have exited.
    }
    await killProcessTree(session.pid)
    sessions.delete(name)
  }

  async renameSession(oldName: string, newName: string): Promise<void> {
    renameSessionSync(oldName, newName)
  }

  async sendKeys(
    name: string,
    keys: string,
    opts: { literal?: boolean; enter?: boolean } = {}
  ): Promise<void> {
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

  resize(name: string, cols: number, rows: number): void {
    if (!Number.isInteger(cols) || cols <= 0 || !Number.isInteger(rows) || rows <= 0) {
      throw new Error(`Invalid PTY dimensions: ${cols}x${rows}`)
    }
    const session = getSession(name)
    session.pty.resize(cols, rows)
    session.term.resize(cols, rows)
  }

  async pasteFromFile(name: string, filePath: string): Promise<void> {
    const session = getSession(name)
    session.pty.write(readFileSync(filePath, 'utf8'))
    session.pty.write('\r')
  }

  async capturePane(name: string, lines: number = 2000): Promise<string> {
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

  async setEnvironment(name: string, key: string, value: string): Promise<void> {
    const session = getSession(name)
    const safeKey = validateEnvironmentKey(key)
    session.pty.write(`$env:${safeKey}=${quotePowerShell(value)}\r`)
  }

  async unsetEnvironment(name: string, key: string): Promise<void> {
    const session = getSession(name)
    const safeKey = validateEnvironmentKey(key)
    session.pty.write(`Remove-Item Env:\\${safeKey} -ErrorAction SilentlyContinue\r`)
  }

  getAttachCommand(_name: string, _socketPath?: string): { command: string; args: string[] } {
    return { command: '', args: [] }
  }
}

export function sessionExistsSync(name: string, _socketPath?: string): boolean {
  const session = sessions.get(name)
  return Boolean(session && !session.exited)
}

export function killSessionSync(name: string): void {
  const session = sessions.get(name)
  if (!session) return

  session.exited = true
  sessions.delete(name)
  try {
    session.pty.kill()
  } catch {
    // The process may already have exited.
  }
  killProcessTreeSync(session.pid)
}

export function renameSessionSync(oldName: string, newName: string): void {
  const session = getSession(oldName)
  if (sessionExistsSync(newName)) {
    throw new Error(`PTY session already exists: ${newName}`)
  }

  sessions.delete(oldName)
  session.name = newName
  sessions.set(newName, session)
}
