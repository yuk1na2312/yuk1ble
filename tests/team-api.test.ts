import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { EnsembleMessage, EnsembleTeam } from '../src/types'
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
    ['a blank name', JSON.stringify({ ...valid, name: '   ' }), 'name is required'],
    ['a name over 64 characters', JSON.stringify({ ...valid, name: 'n'.repeat(65) }), 'longer than 64'],
    ['a name that sanitizes to nothing', JSON.stringify({ ...valid, name: '!! ?? 日本' }), 'at least one letter'],
    ['no description', JSON.stringify({ ...valid, description: '' }), 'description is required'],
    ['agents missing', JSON.stringify({ name: 'x', description: 'y' }), 'at least 2'],
    ['agents not an array', JSON.stringify({ ...valid, agents: 'codex,claude' }), 'at least 2'],
    ['a single agent', JSON.stringify({ ...valid, agents: [{ program: 'codex' }] }), 'at least 2'],
    ['an agent without a program', JSON.stringify({ ...valid, agents: [{ program: 'codex' }, { role: 'lead' }] }), 'agents[1].program'],
    ['a blank program', JSON.stringify({ ...valid, agents: [{ program: 'codex' }, { program: '  ' }] }), 'agents[1].program'],
    ['a null agent', JSON.stringify({ ...valid, agents: [{ program: 'codex' }, null] }), 'agents[1].program'],
    ['a numeric workingDirectory', JSON.stringify({ ...valid, workingDirectory: 42 }), 'workingDirectory'],
    ['a model outside the program catalog', JSON.stringify({ ...valid, agents: [{ program: 'codex', model: 'gpt-4' }, { program: 'claude' }] }), 'agents[0].model "gpt-4" is not available for codex; available: gpt-5.6-sol'],
    ['a model of another program', JSON.stringify({ ...valid, agents: [{ program: 'codex' }, { program: 'claude code', model: 'gpt-5.6-sol' }] }), 'agents[1].model "gpt-5.6-sol" is not available for claude; available: fable, opus, sonnet'],
    ['a model for a program without a catalog', JSON.stringify({ ...valid, agents: [{ program: 'codex' }, { program: 'plain', model: 'x' }] }), 'this program has no model catalog'],
    ['a non-string model', JSON.stringify({ ...valid, agents: [{ program: 'codex' }, { program: 'claude', model: 7 }] }), 'agents[1].model must be a non-empty string'],
    ['a blank model', JSON.stringify({ ...valid, agents: [{ program: 'codex' }, { program: 'claude', model: ' ' }] }), 'agents[1].model must be a non-empty string'],
    ['more than 8 agents', JSON.stringify({ ...valid, agents: Array.from({ length: 9 }, () => ({ program: 'codex' })) }), 'at most 8'],
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
    server.spawnLocalAgent.mockImplementation(async ({ sessionName }) => {
      await gate
      return { id: `${sessionName}-id` }
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

  it('starts a team of three with a lead and two workers, named <program>-<n>', async () => {
    const res = await post(JSON.stringify({
      ...valid, name: 'trio-team',
      agents: [{ program: 'codex' }, { program: 'claude' }, { program: 'plain' }],
    }))

    expect(res.status).toBe(202)
    const { team } = await res.json() as { team: EnsembleTeam }
    expect(team.agents.map(a => [a.name, a.role])).toEqual([['codex-1', 'lead'], ['claude-2', 'worker'], ['plain-3', 'worker']])
    await expect.poll(async () => (await getTeam(team.id)).messages.some(m => m.content.includes('3 agents received their task')), {
      timeout: 20_000, interval: 250,
    }).toBe(true)
  }, 30_000)

  it('accepts eight agents', async () => {
    const res = await post(JSON.stringify({ ...valid, name: 'octet', agents: Array.from({ length: 8 }, () => ({ program: 'plain' })) }))
    expect(res.status).toBe(202)
    const { team } = await res.json() as { team: EnsembleTeam }
    await expect.poll(async () => (await getTeam(team.id)).messages.some(m => m.content.includes('8 agents received their task')), {
      timeout: 30_000, interval: 250,
    }).toBe(true)
  }, 45_000)

  it('records a chosen model on the agent and hands it to the spawner; no model stays absent', async () => {
    server.spawnLocalAgent.mockClear()
    server.spawnLocalAgent.mockImplementation(async ({ sessionName }) => ({ id: `${sessionName}-id` }))

    const res = await post(JSON.stringify({
      ...valid, name: 'model-team',
      agents: [{ program: 'codex', model: 'gpt-5.6-sol' }, { program: 'claude code' }],
    }))

    expect(res.status).toBe(202)
    const { team } = await res.json() as { team: EnsembleTeam }
    expect(team.agents[0]).toMatchObject({ name: 'codex-1', model: 'gpt-5.6-sol' })
    expect('model' in team.agents[1]).toBe(false)
    await expect.poll(() => server.spawnLocalAgent.mock.calls.length, { timeout: 5000 }).toBe(2)
    const spawned = server.spawnLocalAgent.mock.calls.map(c => c[0] as unknown as { sessionName: string; model?: string })
    expect(spawned.map(s => [s.sessionName, s.model])).toEqual([['model-team-codex-1', 'gpt-5.6-sol'], ['model-team-claude-2', undefined]])
    expect((await getTeam(team.id)).team.agents[0].model).toBe('gpt-5.6-sol')
  }, 30_000)

  it('names terminals from one function: a team name with a space works, and its agents carry the session name', async () => {
    server.spawnLocalAgent.mockClear()
    const res = await post(JSON.stringify({ ...valid, name: 'my team' }))

    expect(res.status).toBe(202)
    const { team } = await res.json() as { team: EnsembleTeam }
    expect(team.agents.map(a => a.sessionName)).toEqual(['myteam-codex-1', 'myteam-claude-2'])
    await expect.poll(() => server.spawnLocalAgent.mock.calls.length, { timeout: 5000 }).toBe(2)
    expect(server.spawnLocalAgent.mock.calls.map(c => (c[0] as unknown as { sessionName: string }).sessionName))
      .toEqual(['myteam-codex-1', 'myteam-claude-2'])
    // Input is addressed by that name and reaches the (fake) runtime.
    const input = await fetch(`${server.baseUrl}/api/ensemble/sessions/myteam-codex-1/input`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: 'x' }),
    })
    expect(input.status).toBe(200)
  }, 30_000)

  it('refuses a team whose terminals would share a name with a running team', async () => {
    const same = await post(JSON.stringify({ ...valid, name: 'my  team' })) // sanitizes to the same "myteam"
    expect(same.status).toBe(400)
    expect((await same.json() as { error: string }).error).toContain('already uses the terminal name "myteam-codex-1"')
  })
})
