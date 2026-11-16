/**
 * POST /api/ensemble/sessions/:name/input and /resize against the real server:
 * what may be typed into, what is validated, and what is a 404.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MAX_INPUT_BYTES } from '../lib/http-routes'
import { bootServer } from './helpers/boot-server'

describe('session input and resize routes', () => {
  let server: Awaited<ReturnType<typeof bootServer>>
  const session = 'io-team-codex-1'

  beforeAll(async () => {
    server = await bootServer()
    const store = await server.store()
    const live = (name: string, status: 'active' | 'disbanded') => {
      const team = store.createTeam({ name, description: 'd', agents: [{ program: 'codex' }, { program: 'claude' }] })
      store.updateTeam(team.id, { status, agents: team.agents.map(a => ({ ...a, status: 'active' as const })) })
    }
    live('io-team', 'active')
    live('spaced team', 'active')
    live('old-team', 'disbanded')
  })
  beforeEach(() => {
    server.runtime.write.mockClear()
    server.runtime.resize.mockClear()
    server.runtime.exists.mockReset()
    server.runtime.exists.mockReturnValue(true)
  })
  afterAll(() => {
    server.restore()
    server.cleanup()
  })

  const post = (name: string, action: 'input' | 'resize', body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${server.baseUrl}/api/ensemble/sessions/${encodeURIComponent(name)}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  const errorOf = async (res: Response) => (await res.json() as { error: string }).error

  describe('input', () => {
    it('writes the raw bytes to the session untouched', async () => {
      const data = '\x1b[A ls -la ✓\r\x03'

      const res = await post(session, 'input', { data })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(server.runtime.write).toHaveBeenCalledExactlyOnceWith(session, data)
    })

    it('accepts the name an agent terminal really has when the team name needs sanitizing', async () => {
      // The spawner strips the space from "spaced team-codex-1".
      expect((await post('spacedteam-codex-1', 'input', { data: 'x' })).status).toBe(200)
      expect(server.runtime.write).toHaveBeenCalledWith('spacedteam-codex-1', 'x')
    })

    it('is a 404 for a session that is not an agent of any team, even though a terminal by that name exists', async () => {
      const res = await post('some-other-shell', 'input', { data: 'rm -rf /' })

      expect(res.status).toBe(404)
      expect(await errorOf(res)).toBe('Session not found')
      expect(server.runtime.write).not.toHaveBeenCalled()
    })

    it('is a 404 for an agent of a disbanded team', async () => {
      expect((await post('old-team-codex-1', 'input', { data: 'x' })).status).toBe(404)
      expect((await post('old-team-codex-1', 'resize', { cols: 80, rows: 24 })).status).toBe(404)
      expect(server.runtime.write).not.toHaveBeenCalled()
    })

    it('is a 404 when the team is live but the terminal is gone, and when it vanishes mid-request', async () => {
      server.runtime.exists.mockReturnValue(false)
      expect((await post(session, 'input', { data: 'x' })).status).toBe(404)

      server.runtime.exists.mockReturnValueOnce(true).mockReturnValue(false)
      server.runtime.write.mockImplementationOnce(() => { throw new Error('PTY session not found: x') })
      expect((await post(session, 'input', { data: 'x' })).status).toBe(404)
    })

    it('answers 404 before it looks at the body', async () => {
      expect((await post('some-other-shell', 'input', '{ not json')).status).toBe(404)
    })

    it.each([
      ['malformed JSON', '{ nope', 'malformed JSON'],
      ['JSON null', 'null', 'non-empty string'],
      ['an array', '[]', 'non-empty string'],
      ['no data', '{}', 'non-empty string'],
      ['numeric data', '{"data":5}', 'non-empty string'],
      ['an empty string', '{"data":""}', 'non-empty string'],
    ])('is a 400 for %s, and writes nothing', async (_label, body, expected) => {
      const res = await post(session, 'input', body)

      expect(res.status).toBe(400)
      expect(await errorOf(res)).toContain(expected)
      expect(server.runtime.write).not.toHaveBeenCalled()
    })

    it('caps one request at 64 KB of bytes, counting multi-byte characters as the bytes they are', async () => {
      expect((await post(session, 'input', { data: 'a'.repeat(MAX_INPUT_BYTES) })).status).toBe(200)
      server.runtime.write.mockClear()

      expect((await post(session, 'input', { data: 'a'.repeat(MAX_INPUT_BYTES + 1) })).status).toBe(413)
      // 21 846 three-byte characters are 65 538 bytes although they are far fewer than 64 K characters.
      const res = await post(session, 'input', { data: '€'.repeat(21_846) })
      expect(res.status).toBe(413)
      expect(await errorOf(res)).toContain('65536')
      expect(server.runtime.write).not.toHaveBeenCalled()
    })

    it('refuses a foreign Origin like every other write', async () => {
      const res = await post(session, 'input', { data: 'x' }, { Origin: 'http://evil.example' })

      expect(res.status).toBe(403)
      expect(server.runtime.write).not.toHaveBeenCalled()
    })
  })

  describe('resize', () => {
    it('resizes the session', async () => {
      const res = await post(session, 'resize', { cols: 120, rows: 40 })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, cols: 120, rows: 40 })
      expect(server.runtime.resize).toHaveBeenCalledExactlyOnceWith(session, 120, 40)
    })

    it.each([
      [20, 5], [400, 200], [20, 200], [400, 5],
    ])('accepts the bounds %i x %i', async (cols, rows) => {
      expect((await post(session, 'resize', { cols, rows })).status).toBe(200)
    })

    it.each([
      ['cols below 20', { cols: 19, rows: 24 }],
      ['cols above 400', { cols: 401, rows: 24 }],
      ['rows below 5', { cols: 80, rows: 4 }],
      ['rows above 200', { cols: 80, rows: 201 }],
      ['a fractional size', { cols: 80.5, rows: 24 }],
      ['string numbers', { cols: '80', rows: '24' }],
      ['null', { cols: null, rows: null }],
      ['no rows', { cols: 80 }],
      ['no cols', { rows: 24 }],
      ['an empty object', {}],
      ['zero', { cols: 0, rows: 0 }],
      ['a negative size', { cols: -80, rows: -24 }],
    ])('is a 400 for %s, and resizes nothing', async (_label, body) => {
      const res = await post(session, 'resize', body)

      expect(res.status).toBe(400)
      expect(await errorOf(res)).toContain('integers')
      expect(server.runtime.resize).not.toHaveBeenCalled()
    })

    it('is a 400 for malformed JSON, and a 404 for a session that is not a team terminal', async () => {
      expect((await post(session, 'resize', '{')).status).toBe(400)
      expect((await post('some-other-shell', 'resize', { cols: 80, rows: 24 })).status).toBe(404)
    })
  })

  describe('the read routes the GUI, CLI and skill still use', () => {
    it('GET .../pane returns the rendered screen, or exists:false with an empty pane', async () => {
      server.runtime.screen.mockReturnValueOnce('> hello')
      const live = await (await fetch(`${server.baseUrl}/api/ensemble/sessions/${session}/pane?lines=10`)).json()
      expect(live).toEqual({ session, exists: true, pane: '> hello' })
      expect(server.runtime.screen).toHaveBeenLastCalledWith(session, 10)

      server.runtime.exists.mockReturnValue(false)
      const gone = await (await fetch(`${server.baseUrl}/api/ensemble/sessions/${session}/pane`)).json()
      expect(gone).toEqual({ session, exists: false, pane: '' })
    })

    it('GET /logs returns buffered console lines newer than ?since', async () => {
      console.log('[pane-test] marker line')
      const first = await (await fetch(`${server.baseUrl}/api/ensemble/logs`)).json() as { entries: Array<{ seq: number; text: string }>; latest: number }
      expect(first.entries.some(e => e.text.includes('[pane-test] marker line'))).toBe(true)

      const none = await (await fetch(`${server.baseUrl}/api/ensemble/logs?since=${first.latest}`)).json() as { entries: unknown[] }
      expect(none.entries).toEqual([])
    })
  })

  it('only POST reaches these routes', async () => {
    const res = await fetch(`${server.baseUrl}/api/ensemble/sessions/${session}/input`)
    expect(res.status).toBe(404)
  })
})
