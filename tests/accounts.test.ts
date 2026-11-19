import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseAgentsConfig } from '../src/adapters/agent-config'
import { REPO_ROOT } from '../src/repo-root'
import type { AgentProgram } from '../src/adapters/types'

/**
 * src/adapters/accounts.ts runs each adapter's own status subcommand. child_process and the PATH lookup
 * are mocked throughout: no real agent CLI is ever invoked here. The programs come from the checked-in
 * agents.json, so its `account` entries are exercised against realistic output too.
 */

type Callback = (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void
interface Call { file: string; args: string[]; options: Record<string, unknown> }
type Answer = { stdout?: string; stderr?: string; error?: NodeJS.ErrnoException }

const shipped = parseAgentsConfig(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'agents.json'), 'utf-8')))
const programs = (...names: string[]): AgentProgram[] => names.map(name => shipped[name])

let calls: Call[]
let onPath: (command: string) => string | undefined
const killProcessTree = vi.fn(async (_pid: number) => {})

/** `answer` decides, per probed command (the first token after /d /c), what the CLI "prints". */
function mockCli(answer: (command: string) => Answer | 'hang'): void {
  vi.doMock('child_process', () => ({
    execFile: vi.fn((file: string, args: string[], options: Record<string, unknown>, callback: Callback) => {
      calls.push({ file, args, options })
      const result = answer(args[2])
      if (result !== 'hang') callback(result.error ?? null, result.stdout ?? '', result.stderr ?? '')
      return { pid: 4242 }
    }),
  }))
  vi.doMock('../src/runtime/win-process', () => ({ findOnPath: (c: string) => onPath(c), killProcessTree }))
}

const failure = (message: string, code?: string): NodeJS.ErrnoException => Object.assign(new Error(message), { code })
const load = () => import('../src/adapters/accounts')
const statusOf = async (program: string, now?: number) => (await (await load()).getAccountStatuses(programs(program), now))[0]

beforeEach(() => {
  calls = []
  onPath = command => `C:\\bin\\${command}.cmd`
  killProcessTree.mockClear()
  vi.resetModules()
})
afterEach(() => {
  vi.doUnmock('child_process')
  vi.doUnmock('../src/runtime/win-process')
  vi.useRealTimers()
})

describe('how a probe runs', () => {
  it('goes through the command processor with a fixed argument array and no shell option', async () => {
    mockCli(() => ({ stdout: JSON.stringify({ loggedIn: true }) }))
    await statusOf('claude')
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe(process.env['ComSpec'] || 'cmd.exe')
    expect(calls[0].args).toEqual(['/d', '/c', 'claude', 'auth', 'status', '--json'])
    expect(calls[0].options).not.toHaveProperty('shell')
  })

  it('probes every program in parallel and keeps the agents.json order', async () => {
    mockCli(command => ({ stdout: command === 'claude' ? '{"loggedIn":true}' : 'Logged in using ChatGPT' }))
    const statuses = await (await load()).getAccountStatuses(programs('codex', 'claude', 'gemini'))
    expect(statuses.map(s => s.program)).toEqual(['codex', 'claude', 'gemini'])
    expect(calls.map(c => c.args[2]).sort()).toEqual(['claude', 'codex'])
  })
})

describe('a JSON status subcommand', () => {
  it('reads account and plan from the named keys', async () => {
    mockCli(() => ({ stdout: JSON.stringify({ loggedIn: true, email: 'user@example.com', subscriptionType: 'Max' }) }))
    expect(await statusOf('claude')).toEqual({ program: 'claude', state: 'signed-in', account: 'user@example.com', plan: 'Max' })
  })

  it('accepts the alternate key spellings listed in the adapter', async () => {
    mockCli(() => ({ stdout: JSON.stringify({ loggedIn: true, account: 'user@example.com', plan: 'Max' }) }))
    expect(await statusOf('claude')).toEqual({ program: 'claude', state: 'signed-in', account: 'user@example.com', plan: 'Max' })
  })

  it('answers signed-out for false', async () => {
    mockCli(() => ({ stdout: JSON.stringify({ loggedIn: false }) }))
    expect(await statusOf('claude')).toEqual({ program: 'claude', state: 'signed-out' })
  })

  it('treats an account with no boolean as signed in, and neither as an error', async () => {
    mockCli(() => ({ stdout: '{"email":"a@b.co"}' }))
    expect((await statusOf('claude')).state).toBe('signed-in')
    vi.resetModules()
    mockCli(() => ({ stdout: '{"other":1}' }))
    expect(await statusOf('claude')).toEqual({ program: 'claude', state: 'error', detail: 'unrecognized claude account status output' })
  })

  it('reports non-JSON output as an error without echoing it', async () => {
    mockCli(() => ({ stdout: 'sk-leaky <html>oops' }))
    const status = await statusOf('claude')
    expect(status).toEqual({ program: 'claude', state: 'error', detail: 'claude probe failed' })
  })
})

describe('a plain-text status subcommand', () => {
  it('reads the real terse line: signed in, no plan', async () => {
    mockCli(() => ({ stdout: 'Logged in using ChatGPT' }))
    expect(await statusOf('codex')).toEqual({ program: 'codex', state: 'signed-in', account: 'ChatGPT' })
  })

  it('answers signed-out for "Not logged in"', async () => {
    mockCli(() => ({ stdout: 'Not logged in' }))
    expect(await statusOf('codex')).toEqual({ program: 'codex', state: 'signed-out' })
  })

  it('takes an email and a parenthetical plan from a more detailed line', async () => {
    mockCli(() => ({ stdout: 'Logged in using ChatGPT account dev@example.com (Plus plan)' }))
    expect(await statusOf('codex')).toEqual({ program: 'codex', state: 'signed-in', account: 'dev@example.com', plan: 'Plus plan' })
  })

  it('reads stderr when stdout is empty', async () => {
    mockCli(() => ({ stdout: '', stderr: 'Logged in using ChatGPT\n' }))
    expect(await statusOf('codex')).toEqual({ program: 'codex', state: 'signed-in', account: 'ChatGPT' })
  })

  it('trusts a usable answer even when the CLI exits non-zero', async () => {
    mockCli(() => ({ stderr: 'Not logged in\n', error: failure('Command failed: exit code 1') }))
    expect((await statusOf('codex')).state).toBe('signed-out')
  })

  it('reports empty and unrecognized output as errors', async () => {
    mockCli(() => ({ stdout: '  \n' }))
    expect(await statusOf('codex')).toEqual({ program: 'codex', state: 'error', detail: 'empty codex account status output' })
    vi.resetModules()
    mockCli(() => ({ stdout: 'something else entirely' }))
    expect(await statusOf('codex')).toEqual({ program: 'codex', state: 'error', detail: 'unrecognized codex account status output' })
  })
})

describe('unsupported', () => {
  it('gives the reason configured in agents.json and runs nothing', async () => {
    mockCli(() => ({ error: failure('should not run') }))
    const statuses = await (await load()).getAccountStatuses(programs('gemini', 'aider', 'opencode'))
    expect(statuses.map(s => s.state)).toEqual(['unsupported', 'unsupported', 'unsupported'])
    expect(statuses[0].detail).toMatch(/\/auth/)
    for (const status of statuses) expect(status.detail).toBeTruthy()
    expect(calls).toEqual([])
  })

  it('gives a generic reason to a program with no account key', async () => {
    mockCli(() => ({ error: failure('should not run') }))
    const [bare] = Object.values(parseAgentsConfig({
      bare: { command: 'bare', readyMarkers: ['>'], inputMethod: 'sendKeys', color: '#112233', icon: '*' },
    }))
    const [status] = await (await load()).getAccountStatuses([bare])
    expect(status).toEqual({ program: 'bare', state: 'unsupported', detail: 'bare has no CLI-queryable account status.' })
    expect(calls).toEqual([])
  })
})

describe('failures are statuses, never throws', () => {
  it('says not installed when the command is not on PATH, without running it', async () => {
    onPath = () => undefined
    mockCli(() => ({ stdout: '{"loggedIn":true}' }))
    expect(await statusOf('claude')).toEqual({ program: 'claude', state: 'error', detail: 'claude is not installed' })
    expect(calls).toEqual([])
  })

  it('says not installed on ENOENT', async () => {
    mockCli(() => ({ error: failure('spawn ENOENT', 'ENOENT') }))
    expect(await statusOf('claude')).toEqual({ program: 'claude', state: 'error', detail: 'claude is not installed' })
  })

  it('says the probe failed on a non-zero exit with no output', async () => {
    mockCli(() => ({ error: failure('Command failed: exit code 1') }))
    expect(await statusOf('codex')).toEqual({ program: 'codex', state: 'error', detail: 'codex probe failed' })
  })

  it('gives up after 5 s, kills the whole process tree and answers an error', async () => {
    vi.useFakeTimers()
    mockCli(() => 'hang')
    const { getAccountStatuses } = await load()
    const pending = getAccountStatuses(programs('claude'))
    await vi.advanceTimersByTimeAsync(5000)
    expect((await pending)[0]).toEqual({ program: 'claude', state: 'error', detail: 'claude probe timed out' })
    expect(killProcessTree).toHaveBeenCalledWith(4242)
  })
})

describe('what leaves the module', () => {
  it('never lets a token, in JSON or in text, into the result', async () => {
    const secret = 'sk-super-secret-access-token-xyz'
    mockCli(command => command === 'claude'
      ? { stdout: JSON.stringify({ loggedIn: true, email: 'user@example.com', subscriptionType: 'Max', accessToken: secret, raw: { nested: secret } }) }
      : { stdout: `Logged in using ChatGPT account dev@example.com (Plus plan) session_token=${secret}` })
    const serialized = JSON.stringify(await (await load()).getAccountStatuses(programs('claude', 'codex')))
    expect(serialized).not.toContain(secret)
    expect(serialized).toContain('user@example.com')
    expect(serialized).toContain('dev@example.com')
  })

  it('answers only the five known keys, each clipped to a bounded length', async () => {
    mockCli(() => ({ stdout: JSON.stringify({ loggedIn: true, email: `${'a'.repeat(500)}@example.com` }) }))
    const status = await statusOf('claude')
    expect(Object.keys(status).sort()).toEqual(['account', 'program', 'state'])
    expect(status.account?.length).toBe(200)
  })
})

describe('caching', () => {
  it('serves a program from cache for 60 s, then probes again', async () => {
    mockCli(() => ({ stdout: '{"loggedIn":true}' }))
    const { ACCOUNTS_CACHE_MS } = await load()
    await statusOf('claude', 1_000)
    await statusOf('claude', 1_000 + ACCOUNTS_CACHE_MS - 1)
    expect(calls).toHaveLength(1)
    await statusOf('claude', 1_000 + ACCOUNTS_CACHE_MS)
    expect(calls).toHaveLength(2)
  })

  it('lets concurrent requests share one probe', async () => {
    mockCli(() => ({ stdout: '{"loggedIn":true}' }))
    const { getAccountStatuses } = await load()
    await Promise.all([getAccountStatuses(programs('claude')), getAccountStatuses(programs('claude'))])
    expect(calls).toHaveLength(1)
  })

  it('clearAccountsCache() makes the next call probe again', async () => {
    mockCli(() => ({ stdout: '{"loggedIn":true}' }))
    const mod = await load()
    await mod.getAccountStatuses(programs('claude'))
    mod.clearAccountsCache()
    await mod.getAccountStatuses(programs('claude'))
    expect(calls).toHaveLength(2)
  })
})
