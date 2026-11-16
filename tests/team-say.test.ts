import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootServer, freeClosedPort } from './helpers/boot-server'

const CLI = path.resolve(process.cwd(), 'cli/ensemble.ts')

interface CliResult { code: number; stdout: string; stderr: string }

function runCli(args: string[], env: Record<string, string>): Promise<CliResult> {
  return new Promise(resolve => {
    execFile(
      process.execPath,
      ['--import', 'tsx', CLI, ...args],
      { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60_000 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
        resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() })
      },
    )
  })
}

describe('team-say over HTTP', () => {
  let server: Awaited<ReturnType<typeof bootServer>>
  let teamId: string

  beforeAll(async () => {
    server = await bootServer()
    const store = await server.store()
    const team = store.createTeam({
      name: 'say-team', description: 'd',
      agents: [{ program: 'codex' }, { program: 'claude' }],
    })
    store.updateTeam(team.id, {
      status: 'active',
      agents: team.agents.map(a => ({ ...a, status: 'active' as const })),
    })
    teamId = team.id
  })

  afterAll(() => {
    server.restore()
    server.cleanup()
  })

  const say = (...args: string[]) => runCli(['team-say', ...args], { ENSEMBLE_URL: server.baseUrl })

  it('posts the message, prints "Sent to <recipient>" and pastes it into the recipient only', async () => {
    const result = await say(teamId, 'codex-1', 'claude-2', 'hello "world" & <you>')

    expect(result).toMatchObject({ code: 0, stdout: 'Sent to claude-2', stderr: '' })

    const feed = await (await fetch(`${server.baseUrl}/api/ensemble/teams/${teamId}/feed`)).json() as {
      messages: Array<{ from: string; to: string; content: string; seq: number }>
    }
    expect(feed.messages).toHaveLength(1)
    expect(feed.messages[0]).toMatchObject({ from: 'codex-1', to: 'claude-2', content: 'hello "world" & <you>', seq: 1 })

    // Delivery goes through pasteFromFile (the paste + Enter path), one session only.
    expect(server.runtime.pasteFromFile).toHaveBeenCalledTimes(1)
    expect(server.runtime.pasteFromFile.mock.calls[0][0]).toBe('say-team-claude-2')
  })

  it('records a well-formed message: v4 id, recent ISO timestamp, type chat, unique per message', async () => {
    await say(teamId, 'codex-1', 'claude-2', 'bericht met spaties')
    await say(teamId, 'codex-1', 'claude-2', 'tweede')

    const feed = await (await fetch(`${server.baseUrl}/api/ensemble/teams/${teamId}/feed`)).json() as {
      messages: Array<{ id: string; type: string; timestamp: string; content: string }>
    }
    const mine = feed.messages.filter(m => m.content === 'bericht met spaties' || m.content === 'tweede')
    expect(mine).toHaveLength(2)
    for (const m of mine) {
      expect(m.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
      expect(m.type).toBe('chat')
      expect(Date.now() - new Date(m.timestamp).getTime()).toBeLessThan(30_000)
    }
    expect(mine[0].id).not.toBe(mine[1].id)
  })

  it('numbers messages and serves them by ?since=<seq>', async () => {
    const feedUrl = `${server.baseUrl}/api/ensemble/teams/${teamId}/feed`
    const since = async (value: string | number) => (await (await fetch(`${feedUrl}?since=${value}`)).json() as {
      messages: Array<{ content: string; seq: number }>
    }).messages
    const base = (await since(0)).at(-1)?.seq ?? 0

    await say(teamId, 'claude-2', 'codex-1', 'second')
    await say(teamId, 'codex-1', 'team', 'third')

    expect((await since(base)).map(m => [m.seq, m.content])).toEqual([[base + 1, 'second'], [base + 2, 'third']])
    expect(await since(base + 2)).toEqual([])
    // An ISO timestamp from before everything still works for older callers.
    expect((await since('2000-01-01T00:00:00.000Z')).length).toBe(base + 2)
  })

  it('exits non-zero with a clear error when the team does not exist', async () => {
    const result = await say('no-such-team', 'codex-1', 'claude-2', 'hi')
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('team-say failed: HTTP 404')
    expect(result.stderr).toContain('Team not found')
  })

  it('exits non-zero with a clear error when the server is not running', async () => {
    const port = await freeClosedPort()
    const result = await runCli(['team-say', teamId, 'codex-1', 'claude-2', 'hi'], { ENSEMBLE_URL: `http://127.0.0.1:${port}` })
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('cannot reach the ensemble server')
    expect(result.stderr).toContain(`http://127.0.0.1:${port}`)
  })

  it('exits non-zero for an empty message instead of claiming it was sent', async () => {
    const result = await say(teamId, 'codex-1', 'claude-2', '   ')
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('HTTP 400')
  })

  it('falls back to ENSEMBLE_PORT when ENSEMBLE_URL is unset', async () => {
    const port = new URL(server.baseUrl).port
    const result = await runCli(['team-say', teamId, 'codex-1', 'claude-2', 'via port'], { ENSEMBLE_URL: '', ENSEMBLE_PORT: port })
    expect(result).toMatchObject({ code: 0, stdout: 'Sent to claude-2' })
  })
})

describe('the CLI is a pure HTTP client', () => {
  it('imports neither the runtime, the store nor the PTY module', () => {
    // A second PtyRuntime registry in the CLI process is permanently empty and
    // loading node-pty costs every team-say start-up time (AGENTS.md gotchas).
    const source = fs.readFileSync(CLI, 'utf8')
    const imports = source.split('\n').filter(line => /^\s*import\b/.test(line)).join('\n')
    expect(imports).not.toMatch(/agent-runtime|pty-runtime|ensemble-registry|node-pty|collab-paths/)
    expect(source).not.toMatch(/setRuntime\(/)
  })
})
