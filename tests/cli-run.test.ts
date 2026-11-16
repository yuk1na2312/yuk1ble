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
  let posted: Array<{ agents: Array<{ program: string; model?: string; role: string }> }>

  beforeEach(async () => {
    posted = []
    server = http.createServer((req, res) => {
      const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
      const url = req.url ?? ''
      if (url === '/api/v1/health') return send(200, { status: 'healthy', version: '1.0.0' })
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
})
