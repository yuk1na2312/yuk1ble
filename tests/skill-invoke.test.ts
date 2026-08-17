import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnsembleMessage, EnsembleTeam, EnsembleTeamAgent } from '../types/ensemble'
import type { SkillCatalog } from '../lib/skill-catalog'

/**
 * invokeAgentSkill — the raw slash-command delivery path added alongside
 * sendTeamMessage. See docs/superpowers/specs/2026-08-16-agent-skill-invocation-design.md
 * §6 (delivery) and §7 (transcript representation).
 *
 * All dependencies are mocked with a fake runtime that records every call in
 * order, per the repo's convention (tests/bridge-lifecycle.test.ts). Nothing
 * here spawns a real agent, writes a real message bus, or waits out a real
 * timer — ensureSubmitted is mocked outright, and the one test that must
 * exercise waitForCommandAccepted's own poll loop uses fake timers.
 */

const TEAM_ID = 'team-skill-1'
const TEAM_NAME = 'alpha'
const AGENT_NAME = 'claude-1'
const SESSION_NAME = `${TEAM_NAME}-${AGENT_NAME}`
const TOKEN = 'superpowers:brainstorming'

interface RecordedCall {
  op: 'pasteFromFile' | 'ensureSubmitted' | 'sendKeys' | 'capturePane' | 'sessionExists' | 'postRemoteSessionCommand'
  session?: string
  fileContent?: string
  url?: string
  text?: string
}

let runtimeRoot: string
let calls: RecordedCall[]
let appended: EnsembleMessage[]
let sessionExistsResult: boolean
let capturePaneResult: () => string
let skillCatalogFor: (program: string) => SkillCatalog

function claudeCatalog(): SkillCatalog {
  return {
    program: 'claude',
    invocation: 'slash',
    skills: [
      { token: TOKEN, name: 'brainstorming', description: 'Explore before building.', source: 'plugin', group: 'superpowers' },
    ],
  }
}

function proseCatalog(): SkillCatalog {
  return {
    program: 'codex',
    invocation: 'prose',
    skills: [
      { token: 'frontend-ui-animator', name: 'frontend-ui-animator', description: 'Animate UI.', source: 'personal', group: 'personal' },
    ],
  }
}

function noneCatalog(): SkillCatalog {
  return { program: 'gemini', invocation: 'none', skills: [], detail: 'gemini has no skills convention' }
}

function makeAgent(overrides: Partial<EnsembleTeamAgent> = {}): EnsembleTeamAgent {
  return {
    agentId: overrides.agentId ?? `${AGENT_NAME}-id`,
    name: overrides.name ?? AGENT_NAME,
    program: overrides.program ?? 'claude',
    role: overrides.role ?? 'lead',
    hostId: overrides.hostId ?? 'local',
    status: overrides.status ?? 'active',
    worktreePath: overrides.worktreePath,
    worktreeBranch: overrides.worktreeBranch,
  }
}

function makeTeam(overrides: Partial<EnsembleTeam> = {}): EnsembleTeam {
  return {
    id: overrides.id ?? TEAM_ID,
    name: overrides.name ?? TEAM_NAME,
    description: overrides.description ?? 'skill invocation test',
    status: overrides.status ?? 'active',
    agents: overrides.agents ?? [makeAgent()],
    createdBy: overrides.createdBy ?? 'test',
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    feedMode: overrides.feedMode ?? 'live',
  }
}

function mockServiceDependencies(team?: EnsembleTeam): void {
  vi.doMock('../lib/ensemble-registry', () => ({
    getTeam: vi.fn(() => team),
    appendMessage: vi.fn((_id: string, message: EnsembleMessage) => appended.push(message)),
    getMessages: vi.fn(() => []),
    loadTeams: vi.fn(() => (team ? [team] : [])),
    updateTeam: vi.fn((_id: string, updates: Partial<EnsembleTeam>) => ({ ...team, ...updates })),
    createTeam: vi.fn(),
    deleteTeam: vi.fn(),
    saveTeams: vi.fn(),
  }))
  vi.doMock('../lib/agent-spawner', () => ({
    spawnLocalAgent: vi.fn(),
    killLocalAgent: vi.fn(),
    spawnRemoteAgent: vi.fn(),
    killRemoteAgent: vi.fn(),
    postRemoteSessionCommand: vi.fn(async (url: string, session: string, text: string) => {
      calls.push({ op: 'postRemoteSessionCommand', url, session, text })
    }),
    isRemoteSessionReady: vi.fn(),
    getAgentTokenUsage: vi.fn(async () => 'unknown'),
  }))
  vi.doMock('../lib/hosts-config', () => ({
    isSelf: vi.fn((hostId: string) => !hostId || hostId === 'local'),
    getHostById: vi.fn((hostId: string) =>
      hostId === 'remote-1' ? { id: 'remote-1', url: 'http://remote.test' } : undefined
    ),
    getSelfHostId: vi.fn(() => 'local'),
  }))
  vi.doMock('../lib/agent-runtime', () => ({
    getRuntime: vi.fn(() => ({
      sessionExists: vi.fn(async (session: string) => {
        calls.push({ op: 'sessionExists', session })
        return sessionExistsResult
      }),
      pasteFromFile: vi.fn(async (session: string, filePath: string) => {
        calls.push({ op: 'pasteFromFile', session, fileContent: fs.readFileSync(filePath, 'utf-8') })
      }),
      capturePane: vi.fn(async (session: string) => {
        calls.push({ op: 'capturePane', session })
        return capturePaneResult()
      }),
      sendKeys: vi.fn(async (session: string) => {
        calls.push({ op: 'sendKeys', session })
      }),
    })),
  }))
  vi.doMock('../lib/agent-config', () => ({
    resolveAgentProgram: vi.fn(() => ({ readyMarker: '>', inputMethod: 'pasteFromFile' })),
    resolveReadyMarkers: vi.fn(() => ['>']),
  }))
  vi.doMock('../lib/paste-submit', () => ({
    ensureSubmitted: vi.fn(async (_runtime: unknown, session: string) => {
      calls.push({ op: 'ensureSubmitted', session })
    }),
    PASTE_NOT_SUBMITTED: /\[Pasted (?:text|Content)/i,
  }))
  vi.doMock('../lib/skill-catalog', () => ({
    getSkillCatalog: vi.fn(async (program: string) => skillCatalogFor(program)),
    clearSkillCatalogCache: vi.fn(),
  }))
}

async function importService(team?: EnsembleTeam) {
  mockServiceDependencies(team)
  const mod = await import('../services/ensemble-service')
  return mod
}

/** Drives waitForCommandAccepted's real poll loop to completion without
 *  waiting out its real 10s bound. Mirrors tests/paste-submit.test.ts. */
async function runFast<T>(fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers()
  try {
    const done = fn()
    await vi.advanceTimersByTimeAsync(15_000)
    return await done
  } finally {
    vi.useRealTimers()
  }
}

describe('invokeAgentSkill', () => {
  const originalRuntimeDir = process.env.ENSEMBLE_RUNTIME_DIR

  beforeEach(() => {
    runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-skill-'))
    process.env.ENSEMBLE_RUNTIME_DIR = runtimeRoot
    calls = []
    appended = []
    sessionExistsResult = true
    capturePaneResult = () => '❯ '
    skillCatalogFor = () => claudeCatalog()
    vi.resetModules()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.resetModules()
    vi.doUnmock('../lib/ensemble-registry')
    vi.doUnmock('../lib/agent-spawner')
    vi.doUnmock('../lib/hosts-config')
    vi.doUnmock('../lib/agent-runtime')
    vi.doUnmock('../lib/agent-config')
    vi.doUnmock('../lib/paste-submit')
    vi.doUnmock('../lib/skill-catalog')

    if (originalRuntimeDir === undefined) delete process.env.ENSEMBLE_RUNTIME_DIR
    else process.env.ENSEMBLE_RUNTIME_DIR = originalRuntimeDir

    fs.rmSync(runtimeRoot, { recursive: true, force: true })
  })

  it('404s on an unknown team, delivering nothing', async () => {
    const mod = await importService(undefined)

    const result = await mod.invokeAgentSkill(TEAM_ID, AGENT_NAME, TOKEN, '')

    expect(result.status).toBe(404)
    expect(result.error).toBe('Team not found')
    expect(calls).toHaveLength(0)
    expect(appended).toHaveLength(0)
  })

  it('404s on an unknown agent, delivering nothing', async () => {
    const team = makeTeam({ agents: [makeAgent({ name: 'someone-else' })] })
    const mod = await importService(team)

    const result = await mod.invokeAgentSkill(TEAM_ID, AGENT_NAME, TOKEN, '')

    expect(result.status).toBe(404)
    expect(result.error).toBe('Agent not found')
    expect(calls).toHaveLength(0)
    expect(appended).toHaveLength(0)
  })

  it('rejects an unknown token with 400 and delivers nothing (allowlist boundary)', async () => {
    const team = makeTeam()
    const mod = await importService(team)

    const result = await mod.invokeAgentSkill(TEAM_ID, AGENT_NAME, 'not-installed', 'args here')

    expect(result.status).toBe(400)
    expect(result.error).toContain('unknown skill')
    expect(result.error).toContain('not-installed')
    expect(calls.filter(c => c.op === 'pasteFromFile')).toHaveLength(0)
    expect(appended).toHaveLength(0)
  })

  it('rejects with 400 when the program has no skill invocation at all', async () => {
    const team = makeTeam({ agents: [makeAgent({ program: 'gemini' })] })
    skillCatalogFor = () => noneCatalog()
    const mod = await importService(team)

    const result = await mod.invokeAgentSkill(TEAM_ID, AGENT_NAME, TOKEN, '')

    expect(result.status).toBe(400)
    expect(result.error).toBe('gemini has no skills convention')
    expect(calls.filter(c => c.op === 'pasteFromFile')).toHaveLength(0)
    expect(appended).toHaveLength(0)
  })

  it('returns 409 and delivers zero bursts when the agent session is not running', async () => {
    const team = makeTeam()
    sessionExistsResult = false
    const mod = await importService(team)

    const result = await mod.invokeAgentSkill(TEAM_ID, AGENT_NAME, TOKEN, 'redesign the pane header')

    expect(result.status).toBe(409)
    expect(result.error).toBe('agent session is not running')
    expect(calls.filter(c => c.op === 'pasteFromFile')).toHaveLength(0)
    expect(appended).toHaveLength(0)
  })

  it('delivers exactly two bursts in order, each pasteFromFile followed by ensureSubmitted, and appends one command message', async () => {
    const team = makeTeam()
    const mod = await importService(team)

    const result = await mod.invokeAgentSkill(TEAM_ID, AGENT_NAME, TOKEN, 'redesign the pane header')

    expect(result.status).toBe(200)

    const ops = calls.map(c => c.op)
    // burst 1 -> submit -> composer confirmation -> burst 2 -> submit
    expect(ops).toEqual([
      'sessionExists',
      'pasteFromFile',
      'ensureSubmitted',
      'capturePane',
      'pasteFromFile',
      'ensureSubmitted',
    ])

    const pasteCalls = calls.filter(c => c.op === 'pasteFromFile')
    expect(pasteCalls).toHaveLength(2)

    // Burst 1 file content is EXACTLY "/token args" — full equality, not a substring check.
    expect(pasteCalls[0].fileContent).toBe('/superpowers:brainstorming redesign the pane header')

    // Built by concatenation so this cannot pass vacuously against a stale
    // constant re-imported from the source under test.
    const wrapperMarker = '[Team message from ' + 'user' + ']:'
    expect(pasteCalls[0].fileContent).not.toContain(wrapperMarker)

    // Burst 2 is the short bus nudge, never the raw command again.
    expect(pasteCalls[1].fileContent).not.toContain('/superpowers:brainstorming')
    expect(pasteCalls[1].fileContent).toContain('team-say')

    // Exactly one message reaches the feed, and it is the command line —
    // the bus nudge (burst 2) must never appear in the transcript.
    expect(appended).toHaveLength(1)
    expect(appended[0]).toMatchObject({
      teamId: TEAM_ID,
      from: 'user',
      to: AGENT_NAME,
      type: 'command',
      content: '/superpowers:brainstorming redesign the pane header',
    })
    expect(result.data?.message).toEqual(appended[0])
  })

  it('formats a token with no args as a bare "/token" with no trailing space', async () => {
    const team = makeTeam()
    const mod = await importService(team)

    await mod.invokeAgentSkill(TEAM_ID, AGENT_NAME, TOKEN, '')

    const pasteCalls = calls.filter(c => c.op === 'pasteFromFile')
    expect(pasteCalls[0].fileContent).toBe('/superpowers:brainstorming')
    expect(appended[0].content).toBe('/superpowers:brainstorming')
  })

  it('invocation "prose" delegates to sendTeamMessage and produces zero raw slash bursts', async () => {
    const team = makeTeam({ agents: [makeAgent({ program: 'codex' })] })
    skillCatalogFor = () => proseCatalog()
    const mod = await importService(team)

    const result = await mod.invokeAgentSkill(TEAM_ID, AGENT_NAME, 'frontend-ui-animator', 'animate the header')

    expect(result.status).toBe(200)

    // sendTeamMessage still delivers exactly once, through the ordinary
    // wrapped path — but that single paste must be prose, never a raw "/…" line.
    const pasteCalls = calls.filter(c => c.op === 'pasteFromFile')
    expect(pasteCalls).toHaveLength(1)
    expect(pasteCalls[0].fileContent).not.toMatch(/^\//)
    expect(pasteCalls[0].fileContent).toContain('Use your "frontend-ui-animator" skill: animate the header')
    expect(pasteCalls[0].fileContent).toContain('[Team message from user]:')

    // sendTeamMessage's own message type ('chat'), not 'command' — this
    // request never touches the raw/command path at all.
    expect(appended).toHaveLength(1)
    expect(appended[0].type).toBe('chat')
  })

  it('remote agents deliver both bursts via postRemoteSessionCommand, never pasteFromFile', async () => {
    const team = makeTeam({ agents: [makeAgent({ hostId: 'remote-1' })] })
    const mod = await importService(team)

    const result = await mod.invokeAgentSkill(TEAM_ID, AGENT_NAME, TOKEN, 'redesign the pane header')

    expect(result.status).toBe(200)
    expect(calls.filter(c => c.op === 'pasteFromFile')).toHaveLength(0)

    const remoteCalls = calls.filter(c => c.op === 'postRemoteSessionCommand')
    expect(remoteCalls).toHaveLength(2)
    expect(remoteCalls[0]).toMatchObject({ url: 'http://remote.test', session: SESSION_NAME, text: '/superpowers:brainstorming redesign the pane header' })
    expect(remoteCalls[1].text).toContain('team-say')

    expect(appended).toHaveLength(1)
    expect(appended[0].type).toBe('command')
  })

  it('waitForCommandAccepted returning false skips burst 2 and appends an ensemble warning', async () => {
    const team = makeTeam()
    // The composer keeps echoing the command on every poll — never confirmed clear.
    capturePaneResult = () => `❯ /${TOKEN} redesign the pane header`
    const mod = await importService(team)

    const result = await runFast(() => mod.invokeAgentSkill(TEAM_ID, AGENT_NAME, TOKEN, 'redesign the pane header'))

    expect(result.status).toBe(200)

    // Burst 1 happened; burst 2 (the nudge) must not have.
    expect(calls.filter(c => c.op === 'pasteFromFile')).toHaveLength(1)
    expect(calls.filter(c => c.op === 'ensureSubmitted')).toHaveLength(1)

    // Bounded retries: at most two extra standalone Enters.
    expect(calls.filter(c => c.op === 'sendKeys').length).toBeLessThanOrEqual(2)

    // ensemble warning first, then the single command message — never a
    // second 'command'-typed message and never the nudge in the transcript.
    expect(appended).toHaveLength(2)
    expect(appended[0].from).toBe('ensemble')
    expect(appended[0].type).toBe('chat')
    expect(appended[0].content).toContain('may not have been accepted')
    expect(appended[1].type).toBe('command')
    expect(appended[1].content).toBe(`/${TOKEN} redesign the pane header`)
  }, 20_000)

  it('reports a delivery failure without throwing, and still records the command message', async () => {
    const team = makeTeam()
    mockServiceDependencies(team)
    // Override the runtime mock so burst 1 itself throws.
    vi.doMock('../lib/agent-runtime', () => ({
      getRuntime: vi.fn(() => ({
        sessionExists: vi.fn(async () => true),
        pasteFromFile: vi.fn(async () => { throw new Error('PTY session not found') }),
        capturePane: vi.fn(async () => '❯ '),
        sendKeys: vi.fn(async () => {}),
      })),
    }))
    const mod = await import('../services/ensemble-service')

    const result = await mod.invokeAgentSkill(TEAM_ID, AGENT_NAME, TOKEN, '')

    expect(result.status).toBe(200)
    expect(appended.some(m => m.from === 'ensemble' && m.content.includes('failed'))).toBe(true)
    expect(appended.some(m => m.type === 'command')).toBe(true)
  })
})
