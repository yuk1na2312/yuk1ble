import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { EnsembleMessage } from '../src/types'
import { bootServer } from './helpers/boot-server'

/** The real server and routes with the fake programs (fakea: slash, fakeb: prose); the PTY runtime is a stub. */
describe('the skill routes', () => {
  let server: Awaited<ReturnType<typeof bootServer>>
  let project: string
  let teamId: string
  const sessionA = 'routeteam-fakea-1'

  beforeAll(async () => {
    server = await bootServer({
      seed: () => { process.env.ENSEMBLE_AGENTS_CONFIG = path.join(process.cwd(), 'tests', 'fixtures', 'fake-agents.json') },
    })
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-skillroute-'))
    fs.mkdirSync(path.join(project, '.fake', 'skills', 'greet'), { recursive: true })
    fs.writeFileSync(path.join(project, '.fake', 'skills', 'greet', 'SKILL.md'), '---\nname: greet\ndescription: Say hello.\n---\nBody')
    const store = await server.store()
    const team = store.createTeam({
      name: 'routeteam', description: 'd', workingDirectory: project,
      agents: [{ program: 'fakea' }, { program: 'fakeb' }],
    })
    teamId = team.id
    store.updateTeam(team.id, { status: 'active', agents: team.agents.map(a => ({ ...a, status: 'active' as const })) })
  })
  afterAll(() => {
    server.restore()
    server.cleanup()
    fs.rmSync(project, { recursive: true, force: true })
  })

  const catalogUrl = (query: string) => `${server.baseUrl}/api/ensemble/skills?${query}`
  const fire = (body: unknown, id = teamId) => fetch(`${server.baseUrl}/api/ensemble/teams/${id}/skill`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const feed = async (): Promise<EnsembleMessage[]> =>
    (await (await fetch(`${server.baseUrl}/api/ensemble/teams/${teamId}/feed`)).json() as { messages: EnsembleMessage[] }).messages

  describe('GET /api/ensemble/skills', () => {
    it('lists the skills of the agent, read from the directory the team record names, with no path in the answer', async () => {
      const res = await fetch(catalogUrl(`team=${teamId}&agent=fakea-1`))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({
        program: 'fakea', invocation: 'slash',
        skills: [{ token: 'greet', name: 'greet', description: 'Say hello.', source: 'project', group: 'project' }],
      })
      expect(JSON.stringify(body)).not.toContain(project)
    })

    it('takes a team and an agent and nothing else: a directory in the query changes nothing', async () => {
      const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-skillroute-other-'))
      try {
        fs.mkdirSync(path.join(other, '.fake', 'skills', 'planted'), { recursive: true })
        fs.writeFileSync(path.join(other, '.fake', 'skills', 'planted', 'SKILL.md'), 'x')
        for (const extra of ['dir', 'path', 'project', 'cwd', 'workingDirectory']) {
          const res = await fetch(catalogUrl(`team=${teamId}&agent=fakea-1&${extra}=${encodeURIComponent(other)}`))
          expect(((await res.json()) as { skills: Array<{ token: string }> }).skills.map(s => s.token), extra).toEqual(['greet'])
        }
      } finally {
        fs.rmSync(other, { recursive: true, force: true })
      }
    })

    it.each([
      ['no parameters', '', 'Team not found'],
      ['an unknown team', 'team=nope&agent=fakea-1', 'Team not found'],
      ['an unknown agent', 'team=TEAM&agent=ghost-9', 'Agent not found'],
      ['no agent', 'team=TEAM', 'Agent not found'],
    ])('is a 404 for %s', async (_label, query, error) => {
      const res = await fetch(catalogUrl(query.replace('TEAM', teamId)))
      expect(res.status).toBe(404)
      expect(((await res.json()) as { error: string }).error).toBe(error)
    })

    it('sits behind the host guard', async () => {
      const res = await fetch(catalogUrl(`team=${teamId}&agent=fakea-1`), { headers: { Origin: 'https://evil.example' } })
      expect(res.status).toBe(403)
    })
  })

  describe('POST /api/ensemble/teams/:id/skill', () => {
    it.each([
      ['malformed JSON', '{ nope', 400, 'malformed JSON'],
      ['JSON null', 'null', 400, 'agent is required'],
      ['no agent', { token: 'greet' }, 400, 'agent is required'],
      ['no token', { agent: 'fakea-1' }, 400, 'token is required'],
      ['a non-string token', { agent: 'fakea-1', token: 7 }, 400, 'token is required'],
      ['non-string args', { agent: 'fakea-1', token: 'greet', args: ['x'] }, 400, 'args must be a string'],
      ['a token that is not installed', { agent: 'fakea-1', token: 'rm-rf' }, 400, 'unknown skill "rm-rf"'],
      ['args with a newline', { agent: 'fakea-1', token: 'greet', args: 'a\n/other' }, 400, 'single line'],
      ['an unknown agent', { agent: 'ghost-9', token: 'greet' }, 404, 'Agent not found'],
    ])('answers %s with %i, delivering and recording nothing', async (_label, body, status, error) => {
      const before = (await feed()).length
      server.runtime.paste.mockClear()

      const res = await fire(body)

      expect(res.status).toBe(status)
      expect(((await res.json()) as { error: string }).error).toContain(error)
      expect(server.runtime.paste).not.toHaveBeenCalled()
      expect(await feed()).toHaveLength(before)
    })

    it('is a 404 for an unknown team', async () => {
      expect((await fire({ agent: 'fakea-1', token: 'greet' }, 'nope')).status).toBe(404)
    })

    it('sits behind the host guard', async () => {
      const res = await fetch(`${server.baseUrl}/api/ensemble/teams/${teamId}/skill`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
        body: JSON.stringify({ agent: 'fakea-1', token: 'greet' }),
      })
      expect(res.status).toBe(403)
    })

    it('answers at once with the command message, then delivers the command and the nudge in the background', async () => {
      server.runtime.paste.mockClear()
      const res = await fire({ agent: 'fakea-1', token: 'greet', args: 'to the world' })

      expect(res.status).toBe(200)
      const { message } = await res.json() as { message: EnsembleMessage }
      expect(message).toMatchObject({ from: 'user', to: 'fakea-1', type: 'command', content: '/greet to the world' })
      expect((await feed()).filter(m => m.type === 'command')).toHaveLength(1)

      await vi.waitFor(() => expect(server.runtime.paste).toHaveBeenCalledTimes(2), { timeout: 15_000, interval: 100 })
      expect(server.runtime.paste.mock.calls[0]).toEqual([sessionA, '/greet to the world'])
      expect(String(server.runtime.paste.mock.calls[1][1])).toContain('team-say')
      expect((await feed()).filter(m => m.type === 'command')).toHaveLength(1)
    }, 30_000)

    it('sends a prose skill as an ordinary team message', async () => {
      server.runtime.paste.mockClear()
      const res = await fire({ agent: 'fakeb-2', token: 'greet' })

      expect(res.status).toBe(200)
      expect(((await res.json()) as { message: EnsembleMessage }).message.type).toBe('chat')
      await vi.waitFor(() => expect(server.runtime.paste).toHaveBeenCalledTimes(1), { timeout: 15_000, interval: 100 })
      expect(String(server.runtime.paste.mock.calls[0][1])).toContain('[Team message from user]: Use your "greet" skill')
    }, 30_000)
  })
})
