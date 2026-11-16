import { execFile } from 'child_process'
import http from 'http'
import path from 'path'
import { promisify } from 'util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

/** `ensemble run` against a stub server: what the CLI posts is the contract under test. */
describe('ensemble run --agents', () => {
  let server: http.Server
  let baseUrl: string
  let programs: Array<{ name: string; color: string; installed: boolean }>
  let posted: Array<{ agents: Array<{ program: string; model?: string; role: string }> }>

  beforeEach(async () => {
    posted = []
    programs = [
      { name: 'alpha', color: '#112233', installed: false },
      { name: 'beta', color: '#445566', installed: true },
      { name: 'gamma', color: '#778899', installed: true },
      { name: 'delta', color: '#aabbcc', installed: true },
    ]
    server = http.createServer((req, res) => {
      const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
      const url = req.url ?? ''
      if (url === '/api/v1/health') return send(200, { status: 'healthy', version: '1.0.0' })
      if (url === '/api/ensemble/programs') return send(200, programs)
      if (url === '/api/ensemble/teams' && req.method === 'POST') {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', () => { posted.push(JSON.parse(body)); send(202, { team: { id: 'stub-team' } }) })
        return
      }
      if (url.startsWith('/api/ensemble/teams/stub-team/feed')) return send(200, { messages: [] })
      if (url === '/api/ensemble/teams/stub-team') return send(200, { team: { status: 'disbanded' } })
      send(404, { error: 'not found' })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })

  afterEach(() => new Promise<void>(resolve => server.close(() => resolve())))

  const run = (...args: string[]) => execFileAsync(
    process.execPath, [path.resolve('bin/ensemble.cjs'), 'run', 'do it', ...args, '--timeout', '30'],
    { env: { ...process.env, ENSEMBLE_URL: baseUrl }, encoding: 'utf8', timeout: 30_000 },
  )

  it('posts program:model suffixes as {program, model} and leaves unsuffixed entries unchanged', async () => {
    await run('--agents', 'codex:gpt-5.6-sol,claude:sonnet,plain')

    expect(posted).toHaveLength(1)
    expect(posted[0].agents).toEqual([
      { program: 'codex', model: 'gpt-5.6-sol', role: 'lead' },
      { program: 'claude', model: 'sonnet', role: 'worker' },
      { program: 'plain', role: 'worker' },
    ])
  }, 40_000)

  it('without --agents, runs the first two installed programs of the server catalog', async () => {
    await run()

    expect(posted[0].agents.map(a => a.program)).toEqual(['beta', 'gamma'])
  }, 40_000)

  it('without --agents and with fewer than two installed, says so and posts nothing', async () => {
    programs = programs.map(p => ({ ...p, installed: p.name === 'beta' }))

    await expect(run()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Fewer than two') })
    expect(posted).toEqual([])
  }, 40_000)
})
