import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnsembleMessage, EnsembleTeam } from '../types/ensemble'

/**
 * Bridge lifecycle — `ensemble bridge <teamId>` is the only component that
 * turns a `team-say` append into a push delivery into a teammate's PTY, so the
 * server must spawn it on team creation and tree-kill it on disband.
 *
 * child_process is mocked throughout: nothing here spawns a real bridge, a real
 * agent CLI, or a real taskkill.
 */

interface SpawnCall {
  file: string
  args: string[]
  options: Record<string, unknown>
}

interface ExecCall {
  file: string
  args: string[]
}

let runtimeRoot: string
let spawnCalls: SpawnCall[]
let execFileCalls: ExecCall[]
let execFileSyncCalls: ExecCall[]
let unrefCount: number
let nextSpawnPid: number | undefined
let nextSpawnError: Error | undefined
/** pid -> command line reported by the mocked Win32_Process query. */
let commandLines: Map<number, string>

const TEAM_ID = 'team-bridge-1'
/** High enough that no live process owns it — `process.kill(pid, 0)` throws. */
const DEAD_PID = 999_999

let sigintListeners = process.listeners('SIGINT')
let sigtermListeners = process.listeners('SIGTERM')
let beforeExitListeners = process.listeners('beforeExit')
let exitListeners = process.listeners('exit')

function bridgePidFile(teamId = TEAM_ID): string {
  return path.join(runtimeRoot, teamId, 'bridge.pid')
}

function finishedMarker(teamId = TEAM_ID): string {
  return path.join(runtimeRoot, teamId, '.finished')
}

function taskkillCalls(): ExecCall[] {
  return execFileCalls.filter(call => call.file === 'taskkill')
}

function mockChildProcess(): void {
  vi.doMock('child_process', () => {
    const spawn = vi.fn((file: string, args: string[], options: Record<string, unknown>) => {
      spawnCalls.push({ file, args, options })
      if (nextSpawnError) throw nextSpawnError
      return {
        pid: nextSpawnPid,
        unref: () => { unrefCount++ },
        on: vi.fn(),
      }
    })

    const execFile = vi.fn((file: string, args: string[], ...rest: unknown[]) => {
      execFileCalls.push({ file, args })
      const callback = rest.find(entry => typeof entry === 'function') as
        ((error: Error | null, stdout: string, stderr: string) => void) | undefined
      let stdout = ''
      if (file === 'powershell.exe') {
        const pid = Number.parseInt(/ProcessId=(\d+)/.exec(args.join(' '))?.[1] || '', 10)
        stdout = commandLines.get(pid) || ''
      }
      callback?.(null, stdout, '')
      return {}
    })

    const execFileSync = vi.fn((file: string, args: string[]) => {
      execFileSyncCalls.push({ file, args })
      return ''
    })

    return { spawn, execFile, execFileSync, default: { spawn, execFile, execFileSync } }
  })
}

function mockServiceDependencies(team?: EnsembleTeam, messages: EnsembleMessage[] = []): EnsembleMessage[] {
  const appended: EnsembleMessage[] = []
  vi.doMock('../lib/ensemble-registry', () => ({
    getMessages: vi.fn(() => messages),
    loadTeams: vi.fn(() => (team ? [team] : [])),
    appendMessage: vi.fn((_id: string, message: EnsembleMessage) => appended.push(message)),
    updateTeam: vi.fn((_id: string, updates: Partial<EnsembleTeam>) => ({ ...team, ...updates })),
    createTeam: vi.fn(() => team),
    getTeam: vi.fn(() => team),
    saveTeams: vi.fn(),
  }))
  vi.doMock('../lib/agent-spawner', () => ({
    spawnLocalAgent: vi.fn(),
    killLocalAgent: vi.fn(),
    spawnRemoteAgent: vi.fn(),
    killRemoteAgent: vi.fn(),
    postRemoteSessionCommand: vi.fn(),
    isRemoteSessionReady: vi.fn(),
    getAgentTokenUsage: vi.fn(async () => 'unknown'),
  }))
  vi.doMock('../lib/hosts-config', () => ({
    isSelf: vi.fn(() => true),
    getHostById: vi.fn(),
    getSelfHostId: vi.fn(() => 'local'),
  }))
  vi.doMock('../lib/agent-runtime', () => ({
    getRuntime: vi.fn(() => ({
      capturePane: vi.fn(),
      sendKeys: vi.fn(),
      pasteFromFile: vi.fn(),
      sessionExists: vi.fn(async () => false),
    })),
  }))
  vi.doMock('../lib/agent-config', () => ({
    resolveAgentProgram: vi.fn(() => ({ readyMarker: '>', inputMethod: 'sendKeys' })),
    resolveReadyMarkers: vi.fn(() => ['>']),
  }))
  return appended
}

async function importService(team?: EnsembleTeam, messages: EnsembleMessage[] = []) {
  const appended = mockServiceDependencies(team, messages)
  mockChildProcess()
  const mod = await import('../services/ensemble-service')
  return { mod, appended }
}

function makeTeam(overrides: Partial<EnsembleTeam> = {}): EnsembleTeam {
  return {
    id: overrides.id ?? TEAM_ID,
    name: overrides.name ?? 'alpha',
    description: overrides.description ?? 'bridge test',
    status: overrides.status ?? 'active',
    agents: overrides.agents ?? [],
    createdBy: overrides.createdBy ?? 'test',
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    feedMode: overrides.feedMode ?? 'live',
  }
}

describe('collab bridge lifecycle', () => {
  const originalRuntimeDir = process.env.ENSEMBLE_RUNTIME_DIR
  const originalGrace = process.env.ENSEMBLE_BRIDGE_STOP_GRACE_MS

  beforeEach(() => {
    sigintListeners = process.listeners('SIGINT')
    sigtermListeners = process.listeners('SIGTERM')
    beforeExitListeners = process.listeners('beforeExit')
    exitListeners = process.listeners('exit')

    runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-bridge-'))
    process.env.ENSEMBLE_RUNTIME_DIR = runtimeRoot
    // Skip the graceful shutdown window; it is exercised by the .finished path.
    process.env.ENSEMBLE_BRIDGE_STOP_GRACE_MS = '0'

    spawnCalls = []
    execFileCalls = []
    execFileSyncCalls = []
    unrefCount = 0
    nextSpawnPid = 4242
    nextSpawnError = undefined
    commandLines = new Map()
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    vi.doUnmock('child_process')
    vi.doUnmock('../lib/ensemble-registry')
    vi.doUnmock('../lib/agent-spawner')
    vi.doUnmock('../lib/hosts-config')
    vi.doUnmock('../lib/agent-runtime')
    vi.doUnmock('../lib/agent-config')

    for (const listener of process.listeners('SIGINT')) {
      if (!sigintListeners.includes(listener)) process.removeListener('SIGINT', listener)
    }
    for (const listener of process.listeners('SIGTERM')) {
      if (!sigtermListeners.includes(listener)) process.removeListener('SIGTERM', listener)
    }
    for (const listener of process.listeners('beforeExit')) {
      if (!beforeExitListeners.includes(listener)) process.removeListener('beforeExit', listener)
    }
    for (const listener of process.listeners('exit')) {
      if (!exitListeners.includes(listener)) process.removeListener('exit', listener)
    }

    if (originalRuntimeDir === undefined) delete process.env.ENSEMBLE_RUNTIME_DIR
    else process.env.ENSEMBLE_RUNTIME_DIR = originalRuntimeDir
    if (originalGrace === undefined) delete process.env.ENSEMBLE_BRIDGE_STOP_GRACE_MS
    else process.env.ENSEMBLE_BRIDGE_STOP_GRACE_MS = originalGrace

    fs.rmSync(runtimeRoot, { recursive: true, force: true })
  })

  describe('startCollabBridge()', () => {
    it('spawns the CLI bridge detached and unreferenced', async () => {
      const { mod } = await importService()
      const pid = mod.startCollabBridge(TEAM_ID)

      expect(pid).toBe(4242)
      expect(spawnCalls).toHaveLength(1)

      const call = spawnCalls[0]
      expect(call.file).toBe(process.execPath)
      expect(call.args.slice(0, 2)).toEqual(['--import', 'tsx'])
      expect(call.args[2].replace(/\\/g, '/')).toMatch(/cli\/ensemble\.ts$/)
      expect(call.args.slice(3)).toEqual(['bridge', TEAM_ID])
      expect(call.options.detached).toBe(true)
      expect(call.options.windowsHide).toBe(true)
      expect((call.options.stdio as unknown[])[0]).toBe('ignore')
      expect(unrefCount).toBe(1)
    })

    it('writes the pid file itself so a disband racing startup can find it', async () => {
      const { mod } = await importService()
      mod.startCollabBridge(TEAM_ID)

      // The bridge process would write this moments later; the parent cannot
      // wait for that, so it writes the pid synchronously at spawn time.
      expect(fs.readFileSync(bridgePidFile(), 'utf-8').trim()).toBe('4242')
    })

    it('does not double-spawn when a live bridge pid is already on disk', async () => {
      fs.mkdirSync(path.join(runtimeRoot, TEAM_ID), { recursive: true })
      fs.writeFileSync(bridgePidFile(), `${process.pid}\n`)

      const { mod } = await importService()
      const pid = mod.startCollabBridge(TEAM_ID)

      expect(pid).toBe(process.pid)
      expect(spawnCalls).toHaveLength(0)
    })

    it('does not double-spawn on a repeated call within one server run', async () => {
      nextSpawnPid = process.pid
      const { mod } = await importService()

      expect(mod.startCollabBridge(TEAM_ID)).toBe(process.pid)
      expect(mod.startCollabBridge(TEAM_ID)).toBe(process.pid)
      expect(spawnCalls).toHaveLength(1)
    })

    it('replaces a stale pid file whose process is gone', async () => {
      fs.mkdirSync(path.join(runtimeRoot, TEAM_ID), { recursive: true })
      fs.writeFileSync(bridgePidFile(), `${DEAD_PID}\n`)

      const { mod } = await importService()
      const pid = mod.startCollabBridge(TEAM_ID)

      expect(pid).toBe(4242)
      expect(spawnCalls).toHaveLength(1)
      expect(fs.readFileSync(bridgePidFile(), 'utf-8').trim()).toBe('4242')
    })

    it('degrades instead of throwing when the spawn fails', async () => {
      nextSpawnError = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
      const { mod } = await importService()

      expect(() => mod.startCollabBridge(TEAM_ID)).not.toThrow()
      expect(mod.startCollabBridge(TEAM_ID)).toBeUndefined()
      expect(fs.existsSync(bridgePidFile())).toBe(false)
    })

    it('degrades when the spawn yields no pid', async () => {
      nextSpawnPid = undefined
      const { mod } = await importService()

      expect(mod.startCollabBridge(TEAM_ID)).toBeUndefined()
      expect(fs.existsSync(bridgePidFile())).toBe(false)
    })
  })

  describe('stopCollabBridge()', () => {
    it('tree-kills a bridge this process spawned', async () => {
      nextSpawnPid = process.pid
      const { mod } = await importService()
      mod.startCollabBridge(TEAM_ID)

      await mod.stopCollabBridge(TEAM_ID)

      expect(taskkillCalls()).toEqual([
        { file: 'taskkill', args: ['/T', '/F', '/PID', String(process.pid)] },
      ])
      expect(fs.existsSync(bridgePidFile())).toBe(false)
    })

    it('kills a bridge that never wrote its own pid file (disband races startup)', async () => {
      nextSpawnPid = process.pid
      const { mod } = await importService()
      mod.startCollabBridge(TEAM_ID)
      // Simulate the bridge being killed before it got as far as its pid file.
      fs.rmSync(bridgePidFile(), { force: true })

      await mod.stopCollabBridge(TEAM_ID)

      expect(taskkillCalls().map(call => call.args)).toEqual([
        ['/T', '/F', '/PID', String(process.pid)],
      ])
    })

    it('kills a bridge recovered from disk after a server restart when it verifies', async () => {
      // Fresh module state = no in-memory tracking, exactly like a restart.
      fs.mkdirSync(path.join(runtimeRoot, TEAM_ID), { recursive: true })
      fs.writeFileSync(bridgePidFile(), `${process.pid}\n`)
      commandLines.set(
        process.pid,
        `"node.exe" --import tsx E:\\repo\\cli\\ensemble.ts bridge ${TEAM_ID}`,
      )

      const { mod } = await importService()
      await mod.stopCollabBridge(TEAM_ID)

      expect(execFileCalls.some(call => call.file === 'powershell.exe')).toBe(true)
      expect(taskkillCalls().map(call => call.args)).toEqual([
        ['/T', '/F', '/PID', String(process.pid)],
      ])
      expect(fs.existsSync(bridgePidFile())).toBe(false)
    })

    it('refuses to kill a recycled pid that is not this team\u2019s bridge', async () => {
      fs.mkdirSync(path.join(runtimeRoot, TEAM_ID), { recursive: true })
      fs.writeFileSync(bridgePidFile(), `${process.pid}\n`)
      commandLines.set(process.pid, '"C:\\Windows\\System32\\notepad.exe"')

      const { mod } = await importService()
      await mod.stopCollabBridge(TEAM_ID)

      expect(taskkillCalls()).toHaveLength(0)
      // The pid file is left alone: nothing was proven about it either way.
      expect(fs.existsSync(bridgePidFile())).toBe(true)
    })

    it('refuses to kill when the command line cannot be read', async () => {
      fs.mkdirSync(path.join(runtimeRoot, TEAM_ID), { recursive: true })
      fs.writeFileSync(bridgePidFile(), `${process.pid}\n`)

      const { mod } = await importService()
      await mod.stopCollabBridge(TEAM_ID)

      expect(taskkillCalls()).toHaveLength(0)
    })

    it('refuses to kill a live pid whose command line names another team', async () => {
      fs.mkdirSync(path.join(runtimeRoot, TEAM_ID), { recursive: true })
      fs.writeFileSync(bridgePidFile(), `${process.pid}\n`)
      commandLines.set(process.pid, '"node.exe" --import tsx cli\\ensemble.ts bridge other-team')

      const { mod } = await importService()
      await mod.stopCollabBridge(TEAM_ID)

      expect(taskkillCalls()).toHaveLength(0)
    })

    it('clears a stale pid file without killing anything when the process is gone', async () => {
      fs.mkdirSync(path.join(runtimeRoot, TEAM_ID), { recursive: true })
      fs.writeFileSync(bridgePidFile(), `${DEAD_PID}\n`)

      const { mod } = await importService()
      await mod.stopCollabBridge(TEAM_ID)

      expect(taskkillCalls()).toHaveLength(0)
      expect(fs.existsSync(bridgePidFile())).toBe(false)
    })

    it('is a no-op when no bridge was ever started', async () => {
      const { mod } = await importService()
      await expect(mod.stopCollabBridge('unknown-team')).resolves.toBeUndefined()
      expect(taskkillCalls()).toHaveLength(0)
    })
  })

  describe('disbandTeam()', () => {
    it('signals the bridge via .finished and then tree-kills it', async () => {
      nextSpawnPid = process.pid
      const team = makeTeam()
      const { mod } = await importService(team)

      mod.startCollabBridge(TEAM_ID)
      const result = await mod.disbandTeam(TEAM_ID)

      expect(result.status).toBe(200)
      expect(fs.existsSync(finishedMarker())).toBe(true)
      expect(taskkillCalls().map(call => call.args)).toEqual([
        ['/T', '/F', '/PID', String(process.pid)],
      ])
      expect(fs.existsSync(bridgePidFile())).toBe(false)
    })
  })
})
