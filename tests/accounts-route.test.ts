import path from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootServer } from './helpers/boot-server'

/** The real server and route, with the fake programs: fakea has a probe that runs a harmless node script, fakeb has none. */
describe('GET /api/ensemble/accounts', () => {
  let server: Awaited<ReturnType<typeof bootServer>>
  const url = () => `${server.baseUrl}/api/ensemble/accounts`
  beforeAll(async () => {
    server = await bootServer({
      seed: () => { process.env.ENSEMBLE_AGENTS_CONFIG = path.join(process.cwd(), 'tests', 'fixtures', 'fake-agents.json') },
    })
  })
  afterAll(() => { server.restore(); server.cleanup() })

  it('answers each program with an allowlisted status, and never the token the probe printed', async () => {
    const res = await fetch(url())
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json()
    expect(body).toEqual([
      { program: 'fakea', state: 'signed-in', account: 'ada@example.test', plan: 'Pro' },
      { program: 'fakeb', state: 'unsupported', detail: 'fakeb has no CLI-queryable account status.' },
    ])
    expect(JSON.stringify(body)).not.toContain('sk-fake-secret-token')
  })

  it('is GET only: no sign-in or sign-out, whatever the method or path', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await fetch(url(), { method, body: method === 'DELETE' ? undefined : '{}' })
      expect(res.status, method).toBeGreaterThanOrEqual(400)
      expect(res.status, method).toBeLessThan(500)
    }
    for (const suffix of ['login', 'logout']) {
      expect((await fetch(`${url()}/${suffix}`, { method: 'POST', body: '{}' })).status, suffix).toBe(404)
    }
  })

  it('sits behind the host guard', async () => {
    const res = await fetch(url(), { headers: { Origin: 'https://evil.example' } })
    expect(res.status).toBe(403)
  })

  it('is read by a GUI module that names no program and calls only GET', async () => {
    const [view, api] = await Promise.all(['accounts', 'api'].map(async f => (await fetch(`${server.baseUrl}/js/${f}.js`)).text()))
    expect(api).toContain('`${BASE}/accounts`')
    expect(api).not.toMatch(/post\(`\$\{BASE\}\/accounts/)
    expect(view).not.toMatch(/codex|claude|aider|gemini|opencode|POST|confirm\(|alert\(/i)
  })
})
