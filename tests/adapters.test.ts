import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveAgentProgram, clearAgentsConfigCache } from '../lib/agent-config'
import { MAX_GATE_ATTEMPTS, waitForReady } from '../lib/readiness'
import { ensureSubmitted } from '../lib/paste-submit'
import {
  CLAUDE_READY_SCREEN, CLAUDE_TRUST_SCREEN, CODEX_HOOKS_GATE_SCREEN, CODEX_READY_SCREEN,
} from './fixtures/screens'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const savedEnv = {
  config: process.env.ENSEMBLE_AGENTS_CONFIG,
  flags: process.env.ENSEMBLE_AGENT_FLAGS,
  trust: process.env.ENSEMBLE_CODEX_TRUST_HOOKS,
}
function restoreEnv(): void {
  for (const [key, value] of [
    ['ENSEMBLE_AGENTS_CONFIG', savedEnv.config], ['ENSEMBLE_AGENT_FLAGS', savedEnv.flags], ['ENSEMBLE_CODEX_TRUST_HOOKS', savedEnv.trust],
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

beforeEach(() => {
  delete process.env.ENSEMBLE_AGENTS_CONFIG
  delete process.env.ENSEMBLE_AGENT_FLAGS
  delete process.env.ENSEMBLE_CODEX_TRUST_HOOKS
  clearAgentsConfigCache()
  vi.resetModules()
})
afterEach(() => {
  restoreEnv()
  clearAgentsConfigCache()
  vi.resetModules()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function spawner(capturePane?: (session: string, lines?: number) => Promise<string>) {
  vi.doMock('../lib/agent-runtime', () => ({ getRuntime: vi.fn(() => ({ capturePane })), setRuntime: vi.fn() }))
  return import('../lib/agent-spawner')
}

describe('start command: cwd and repo-root flags come from the adapter', () => {
  const cwd = 'C:\\Users\\someone\\My Projects\\x'

  it('adds the adapter cwdFlag and nothing for a program without one', async () => {
    const { resolveStartCommand } = await spawner()
    expect(resolveStartCommand('codex', cwd)).toBe(
      `& 'codex' '--dangerously-bypass-approvals-and-sandbox' '--cd' '${cwd}'`,
    )
    expect(resolveStartCommand('gemini', cwd)).toBe("& 'gemini' '--yolo'")
  })

  it('adds the adapter addDirFlag with the repo root, but not when already there', async () => {
    const { resolveStartCommand } = await spawner()
    expect(resolveStartCommand('claude', cwd)).toBe(`& 'claude' '--permission-mode' 'auto' '--add-dir' '${REPO_ROOT}'`)
    expect(resolveStartCommand('claude', REPO_ROOT)).toBe("& 'claude' '--permission-mode' 'auto'")
  })

  it.each([
    ['the short alias', '-C D:\\other'],
    ['the flag itself', '--cd D:\\other'],
    ['the = form', '--cd=D:\\other'],
  ])('does not add --cd when ENSEMBLE_AGENT_FLAGS already has %s', async (_label, flags) => {
    process.env.ENSEMBLE_AGENT_FLAGS = flags
    const { resolveStartCommand } = await spawner()
    const command = resolveStartCommand('codex', cwd)
    expect(command).not.toContain(cwd)
    expect(command.match(/'--cd'/g)?.length ?? 0).toBeLessThanOrEqual(1)
  })

  it('does not add --add-dir when ENSEMBLE_AGENT_FLAGS already has it', async () => {
    process.env.ENSEMBLE_AGENT_FLAGS = '--add-dir=D:\\elsewhere'
    const { resolveStartCommand } = await spawner()
    expect(resolveStartCommand('claude', cwd)).not.toContain(REPO_ROOT)
  })

  it('refuses an unknown program instead of launching claude', async () => {
    const { resolveStartCommand } = await spawner()
    expect(() => resolveStartCommand('gpt', cwd)).toThrow('unknown program "gpt"; available: codex, claude')
  })
})

describe('token usage patterns come from the adapter', () => {
  it.each([
    ['claude', 'context 123k tokens used', '~123k tokens'],
    ['claude', 'context 1.2k tokens used', '~1.2k tokens'],
    ['claude', 'used 12,345 tokens', '~12,345 tokens'],
    ['claude code', 'used 900 tokens', '~900 tokens'],
    ['codex', '  73% left  ', '73% budget left'],
    ['claude', 'nothing relevant on screen', 'unknown'],
    ['gemini', '73% left, 12k tokens', 'unknown'], // gemini's adapter lists no usage patterns
  ])('%s reading %j gives %j', async (program, screen, expected) => {
    const { getAgentTokenUsage } = await spawner(async () => screen)
    expect(await getAgentTokenUsage('session', program)).toBe(expected)
  })

  it('answers unknown when the session cannot be read', async () => {
    const { getAgentTokenUsage } = await spawner(async () => { throw new Error('PTY session not found') })
    expect(await getAgentTokenUsage('session', 'claude')).toBe('unknown')
  })
})

/** Scripted screens and a virtual clock: sleeping advances time, so a 20 s wait takes no time. */
function scriptedAgent(screens: string[], sticky = false) {
  let clock = 0
  let polls = 0
  const sent: Array<{ keys: string; opts?: { literal?: boolean; enter?: boolean }; atPoll: number }> = []
  const runtime = {
    capturePane: vi.fn(async () => {
      const screen = screens[Math.min(polls, screens.length - 1)]
      polls++
      return sticky ? screens[0] : screen
    }),
    sendKeys: vi.fn(async (_session: string, keys: string, opts?: { literal?: boolean; enter?: boolean }) => {
      sent.push({ keys, opts, atPoll: polls })
    }),
    sessionExists: vi.fn(async () => true),
  }
  return {
    runtime, sent, polls: () => polls, elapsed: () => clock,
    clock: { now: () => clock, sleep: async (ms: number) => { clock += ms } },
  }
}

function ready(program: string, agent: ReturnType<typeof scriptedAgent>, env: NodeJS.ProcessEnv = {}) {
  const adapter = resolveAgentProgram(program)
  if (!adapter) throw new Error(`no adapter for ${program}`)
  return waitForReady({
    runtime: agent.runtime,
    sessionName: `s-${program}`,
    readyMarkers: adapter.readyMarkers,
    gates: adapter.gates ?? [],
    isAborted: () => false,
    abortReason: 'test',
    maxWaitMs: 150_000,
    quiescentMs: 20_000,
    env,
    ...agent.clock,
  })
}

describe('gates loaded from agents.json answer with the same keys as before', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })

  it('claude folder trust: Enter, once per 3 s window, and not ready while the modal shows its "❯"', async () => {
    const agent = scriptedAgent([CLAUDE_TRUST_SCREEN, CLAUDE_TRUST_SCREEN, CLAUDE_TRUST_SCREEN, CLAUDE_READY_SCREEN])
    expect(await ready('claude', agent)).toBe(true)
    expect(agent.sent).toEqual([{ keys: 'Enter', opts: undefined, atPoll: 1 }])
    expect(agent.polls()).toBe(4) // the modal's own ❯ was not taken for the prompt
  })

  it('claude bypass-permissions warning: Down, then enter', async () => {
    const warning = 'WARNING: Claude Code running in Bypass Permissions mode\n 1. No, exit\n 2. Yes, I accept'
    const agent = scriptedAgent([warning, CLAUDE_READY_SCREEN])
    expect(await ready('claude', agent)).toBe(true)
    expect(agent.sent).toEqual([{ keys: 'Down', opts: { enter: true }, atPoll: 1 }])
  })

  it('codex hooks review: "3" as literal text by default', async () => {
    const agent = scriptedAgent([CODEX_HOOKS_GATE_SCREEN, CODEX_HOOKS_GATE_SCREEN, CODEX_READY_SCREEN])
    expect(await ready('codex', agent)).toBe(true)
    expect(agent.sent).toEqual([{ keys: '3', opts: { literal: true }, atPoll: 1 }])
  })

  it('codex hooks review: "2" when ENSEMBLE_CODEX_TRUST_HOOKS=1, read at answer time', async () => {
    const agent = scriptedAgent([CODEX_HOOKS_GATE_SCREEN, CODEX_READY_SCREEN])
    expect(await ready('codex', agent, { ENSEMBLE_CODEX_TRUST_HOOKS: '1' })).toBe(true)
    expect(agent.sent.map(s => s.keys)).toEqual(['2'])

    const other = scriptedAgent([CODEX_HOOKS_GATE_SCREEN, CODEX_READY_SCREEN])
    expect(await ready('codex', other, { ENSEMBLE_CODEX_TRUST_HOOKS: '0' })).toBe(true)
    expect(other.sent.map(s => s.keys)).toEqual(['3'])
  })

  it('answers again after the 3 s debounce, and gives up after MAX_GATE_ATTEMPTS to check readiness directly', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // The gate never clears; its screen also carries the ❯ marker, so only the attempt cap lets it through.
    const agent = scriptedAgent([CLAUDE_TRUST_SCREEN], true)
    expect(await ready('claude', agent)).toBe(true)
    expect(agent.sent.length).toBe(MAX_GATE_ATTEMPTS)
    // One answer per 3 s window (polls are 1 s apart).
    expect(agent.sent.map(s => s.atPoll)).toEqual([1, 4, 7, 10, 13])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('did not clear'))
  })

  it('treats a settled, unrecognised screen as ready only after the quiescence window', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const agent = scriptedAgent(['some unfamiliar prompt'], true)
    expect(await ready('aider', agent)).toBe(true)
    expect(agent.elapsed()).toBeGreaterThanOrEqual(20_000)
  })

  it('stops when aborted or when the session has exited', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const aborted = scriptedAgent([CLAUDE_TRUST_SCREEN])
    const adapter = resolveAgentProgram('claude')!
    expect(await waitForReady({
      runtime: aborted.runtime, sessionName: 's', readyMarkers: adapter.readyMarkers, gates: adapter.gates ?? [],
      isAborted: () => true, abortReason: 'disbanded', maxWaitMs: 5000, quiescentMs: 20_000, ...aborted.clock,
    })).toBe(false)
    expect(aborted.runtime.capturePane).not.toHaveBeenCalled()

    const exited = scriptedAgent([CLAUDE_TRUST_SCREEN])
    exited.runtime.sessionExists.mockResolvedValue(false)
    expect(await ready('claude', exited)).toBe(false)
    expect(exited.sent).toEqual([])
  })
})

describe('a CLI that exists only as an agents.json entry', () => {
  const ZZ = {
    zzcli: {
      command: 'zzcli',
      flags: ['--fast'],
      cwdFlag: '--root',
      addDirFlag: '--also',
      readyMarkers: ['zz ready>'],
      inputMethod: 'pasteFromFile',
      pasteMarker: '\\[zz pasted',
      gates: [{ name: 'zz license', pattern: 'Accept the ZZ license\\?', keys: ['y', 'Enter'], literal: false }],
      usagePatterns: [{ pattern: 'zz used (\\d+)', format: '$1 zz units' }],
      color: '#010203',
      icon: 'Z',
    },
  }
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-zz-'))
    const file = path.join(dir, 'agents.json')
    fs.writeFileSync(file, JSON.stringify(ZZ))
    process.env.ENSEMBLE_AGENTS_CONFIG = file
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('builds its command line from the entry alone', async () => {
    const { resolveStartCommand } = await spawner()
    expect(resolveStartCommand('zzcli', 'C:\\work\\proj')).toBe(
      `& 'zzcli' '--fast' '--root' 'C:\\work\\proj' '--also' '${REPO_ROOT}'`,
    )
  })

  it('is started, answered at its own gate, and recognised at its own prompt', async () => {
    const agent = scriptedAgent(['Accept the ZZ license? (y/n)', 'loading...', 'zz ready> '])
    expect(await ready('zzcli', agent)).toBe(true)
    expect(agent.sent.map(s => s.keys)).toEqual(['y', 'Enter'])
    expect(agent.polls()).toBe(3)
  })

  it('submits a parked paste using its own pasteMarker, which the default would not recognise', async () => {
    vi.useFakeTimers()
    const adapter = resolveAgentProgram('zzcli')!
    const panes = ['> [zz pasted 4 lines]', '> ']
    let i = 0
    const runtime = {
      capturePane: vi.fn(async () => panes[Math.min(i++, panes.length - 1)]),
      sendKeys: vi.fn(async () => {}),
    }

    const done = ensureSubmitted(runtime, 's-zz', adapter.pasteMarker)
    await vi.advanceTimersByTimeAsync(20_000)
    await done
    expect(runtime.sendKeys).toHaveBeenCalledTimes(1)
    expect(runtime.sendKeys).toHaveBeenCalledWith('s-zz', 'Enter')

    // The default marker misses it: nothing is sent.
    i = 0
    runtime.sendKeys.mockClear()
    const unaware = ensureSubmitted(runtime, 's-zz')
    await vi.advanceTimersByTimeAsync(20_000)
    await unaware
    expect(runtime.sendKeys).not.toHaveBeenCalled()
  })

  it('has its token usage read by its own pattern', async () => {
    const { getAgentTokenUsage } = await spawner(async () => 'zz used 42 so far')
    expect(await getAgentTokenUsage('s', 'zzcli')).toBe('42 zz units')
  })

})
