import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { EnsembleMessage, EnsembleTeam } from '../types/ensemble'
import { bootServer } from './helpers/boot-server'

/** POST /api/ensemble/teams against the real server: validation and the 202 contract. */
describe('POST /api/ensemble/teams', () => {
  let server: Awaited<ReturnType<typeof bootServer>>

  beforeAll(async () => {
    server = await bootServer()
  })

  afterAll(() => {
    server.restore()
    server.cleanup()
  })

  const post = (body: string) => fetch(`${server.baseUrl}/api/ensemble/teams`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
  const getTeam = async (id: string) =>
    (await (await fetch(`${server.baseUrl}/api/ensemble/teams/${id}`)).json() as { team: EnsembleTeam; messages: EnsembleMessage[] })

  const valid = { name: 'api-team', description: 'do the thing', agents: [{ program: 'codex' }, { program: 'claude' }] }

  describe.each([
    ['malformed JSON', '{ nope', 'malformed JSON'],
    ['JSON null', 'null', 'JSON object'],
    ['a JSON array', '[]', 'JSON object'],
    ['an empty object', '{}', 'name is required'],
    ['no description', JSON.stringify({ ...valid, description: '' }), 'description is required'],
    ['agents missing', JSON.stringify({ name: 'x', description: 'y' }), 'at least 2'],
    ['agents not an array', JSON.stringify({ ...valid, agents: 'codex,claude' }), 'at least 2'],
    ['a single agent', JSON.stringify({ ...valid, agents: [{ program: 'codex' }] }), 'at least 2'],
    ['an agent without a program', JSON.stringify({ ...valid, agents: [{ program: 'codex' }, { role: 'lead' }] }), 'agents[1].program'],
    ['a blank program', JSON.stringify({ ...valid, agents: [{ program: 'codex' }, { program: '  ' }] }), 'agents[1].program'],
    ['a null agent', JSON.stringify({ ...valid, agents: [{ program: 'codex' }, null] }), 'agents[1].program'],
    ['a numeric workingDirectory', JSON.stringify({ ...valid, workingDirectory: 42 }), 'workingDirectory'],
    ['an unknown program', JSON.stringify({ ...valid, agents: [{ program: 'codex' }, { program: 'gpt' }] }), 'unknown program "gpt"; available: codex, claude, plain'],
    ['a near-miss program name', JSON.stringify({ ...valid, agents: [{ program: 'claudex' }, { program: 'codex' }] }), 'unknown program "claudex"'],
  ])('%s', (_label, body, expected) => {
    it('is a 400 with a clear message, and creates nothing', async () => {
      const before = (await (await fetch(`${server.baseUrl}/api/ensemble/teams`)).json() as { teams: unknown[] }).teams.length

      const res = await post(body)

      expect(res.status).toBe(400)
      expect((await res.json() as { error: string }).error).toContain(expected)
      const after = (await (await fetch(`${server.baseUrl}/api/ensemble/teams`)).json() as { teams: unknown[] }).teams.length
      expect(after).toBe(before)
      // Nothing may have started: not a record, and not a process.
      expect(server.spawnLocalAgent).not.toHaveBeenCalled()
    })
  })

  it('answers 202 with the team while agents are still being spawned, then reports progress through status and feed', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    server.spawnLocalAgent.mockImplementation(async ({ name }) => {
      await gate
      return { id: `${name}-id` }
    })

    const res = await post(JSON.stringify({ ...valid, name: 'slow-team' }))

    // Returned although no agent has spawned yet.
    expect(res.status).toBe(202)
    const { team } = await res.json() as { team: EnsembleTeam }
    expect(team).toMatchObject({ name: 'slow-team', status: 'forming' })
    expect(team.agents.map(a => [a.name, a.status])).toEqual([['codex-1', 'spawning'], ['claude-2', 'spawning']])

    const early = await getTeam(team.id)
    expect(early.team.status).toBe('forming')

    release()

    await expect.poll(async () => (await getTeam(team.id)).team.status, { timeout: 15_000, interval: 100 }).toBe('active')
    await expect.poll(async () => (await getTeam(team.id)).messages.some(m => m.content.includes('collaboration started')), {
      timeout: 20_000, interval: 250,
    }).toBe(true)
    const done = await getTeam(team.id)
    expect(done.team.agents.map(a => a.status)).toEqual(['active', 'active'])
    expect(done.messages.filter(m => m.content.includes('has joined')).map(m => m.seq)).toEqual([1, 2])
  }, 30_000)
})
