import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * invokeAgentSkill against the real store and the real catalog, with only the PTY runtime replaced.
 * Programs: fakea (slash), fakeb (prose), fakec (no skills). Skills live in a temp project directory.
 */
const AGENTS = {
  fakea: { command: 'x', readyMarkers: ['>'], inputMethod: 'pasteFromFile', color: '#112233', icon: 'a', skills: { invocation: 'slash', roots: [{ dir: '{project}/.skills', source: 'project' }] } },
  fakeb: { command: 'x', readyMarkers: ['>'], inputMethod: 'sendKeys', color: '#112233', icon: 'b', skills: { invocation: 'prose', roots: [{ dir: '{project}/.skills', source: 'project' }] } },
  fakes: { command: 'x', readyMarkers: ['>'], inputMethod: 'sendKeys', color: '#112233', icon: 's', skills: { invocation: 'slash', roots: [{ dir: '{project}/.skills', source: 'project' }] } },
  fakec: { command: 'x', readyMarkers: ['>'], inputMethod: 'sendKeys', color: '#112233', icon: 'c' },
}

describe('invokeAgentSkill', () => {
  const saved = { data: process.env.ENSEMBLE_DATA_DIR, runtime: process.env.ENSEMBLE_RUNTIME_DIR, config: process.env.ENSEMBLE_AGENTS_CONFIG }
  let root: string
  let project: string
  const events: string[] = []
  let screenText: () => string
  let alive: boolean
  let pasteFails: boolean

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-skill-'))
    project = path.join(root, 'project')
    fs.mkdirSync(path.join(project, '.skills', 'greet'), { recursive: true })
    fs.writeFileSync(path.join(project, '.skills', 'greet', 'SKILL.md'), '---\nname: greet\ndescription: Say hello.\n---\nBody')
    fs.writeFileSync(path.join(root, 'agents.json'), JSON.stringify(AGENTS))
    process.env.ENSEMBLE_DATA_DIR = root
    process.env.ENSEMBLE_RUNTIME_DIR = path.join(root, 'runtime')
    process.env.ENSEMBLE_AGENTS_CONFIG = path.join(root, 'agents.json')
    events.length = 0
    alive = true
    pasteFails = false
    screenText = () => '> '
    vi.resetModules()
    vi.useFakeTimers({ toFake: ['setTimeout'] })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.resetModules()
    for (const [key, value] of [['ENSEMBLE_DATA_DIR', saved.data], ['ENSEMBLE_RUNTIME_DIR', saved.runtime], ['ENSEMBLE_AGENTS_CONFIG', saved.config]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(root, { recursive: true, force: true })
  })

  async function setup(options: { workingDirectory?: string | null } = {}) {
    const runtime = {
      exists: vi.fn(() => alive),
      paste: vi.fn((session: string, text: string) => {
        if (pasteFails) throw new Error('PTY session not found')
        events.push(`paste ${session} ${text}`)
      }),
      sendKeys: vi.fn((session: string, keys: string, opts?: { literal?: boolean; enter?: boolean }) => {
        events.push(`keys ${session} ${keys}${opts?.literal ? ' literal' : ''}${opts?.enter ? ' enter' : ''}`)
      }),
      screen: vi.fn(() => screenText()),
    }
    vi.doMock('../src/runtime/agent-runtime', () => ({ getRuntime: vi.fn(() => runtime) }))
    vi.doMock('../src/core/agent-spawner', () => ({
      spawnLocalAgent: vi.fn(), killLocalAgent: vi.fn(), getAgentTokenUsage: vi.fn(async () => 'unknown'),
    }))
    const store = await import('../src/core/store')
    const skills = await import('../src/core/skill-invoke')
    const messaging = await import('../src/core/messaging')
    const team = store.createTeam({
      name: 'duo', description: 'd',
      agents: [{ program: 'fakea' }, { program: 'fakeb' }, { program: 'fakec' }, { program: 'fakes' }],
      ...(options.workingDirectory === null ? {} : { workingDirectory: options.workingDirectory ?? project }),
    })
    store.updateTeam(team.id, { status: 'active', agents: team.agents.map(a => ({ ...a, status: 'active' as const })) })
    /** Runs fake time until the delivery settles. */
    const settle = async (result: { delivery?: Promise<void> }): Promise<void> => {
      const done = result.delivery
      await vi.advanceTimersByTimeAsync(120_000)
      await done
    }
    return { store, skills, messaging, runtime, teamId: team.id, settle }
  }
  const pastes = (): string[] => events.filter(e => e.startsWith('paste')).map(e => e.replace(/^paste duo-fake[a-c]-\d /, ''))

  it('persists the working directory a team was created with', async () => {
    const { store, teamId } = await setup()
    expect(store.getTeam(teamId)?.workingDirectory).toBe(project)
    store.flushStore()
    const file = JSON.parse(fs.readFileSync(path.join(root, 'ensemble', 'teams.json'), 'utf8')) as unknown
    expect(JSON.stringify(file)).toContain(JSON.stringify(project).slice(1, -1))
  })

  it('resolves the project directory: worktree, else the team directory, else the server cwd', async () => {
    const { store, skills, teamId } = await setup()
    const team = store.getTeam(teamId)!
    expect(skills.resolveAgentProjectDir(team, { ...team.agents[0], worktreePath: 'C:\\wt' })).toBe('C:\\wt')
    expect(skills.resolveAgentProjectDir(team, team.agents[0])).toBe(project)
    expect(skills.resolveAgentProjectDir({ ...team, workingDirectory: undefined }, team.agents[0])).toBe(process.cwd())
  })

  describe('refusals deliver nothing and write no feed message', () => {
    it.each([
      ['an unknown team', (id: string) => ['nope-' + id, 'fakea-1', 'greet', ''], 404, 'Team not found'],
      ['an unknown agent', (id: string) => [id, 'ghost-9', 'greet', ''], 404, 'Agent not found'],
      ['an agent whose program has no skills', (id: string) => [id, 'fakec-3', 'greet', ''], 400, 'fakec has no installed-skill support'],
      ['a token that is not installed', (id: string) => [id, 'fakea-1', 'not-installed', ''], 400, 'unknown skill "not-installed"'],
      ['a token that only looks like a path', (id: string) => [id, 'fakea-1', '../greet', ''], 400, 'unknown skill'],
      ['args with a newline', (id: string) => [id, 'fakea-1', 'greet', 'one\r/other-skill'], 400, 'single line'],
      ['args with an escape character', (id: string) => [id, 'fakea-1', 'greet', 'a\u001bb'], 400, 'single line'],
      ['args that are too long', (id: string) => [id, 'fakea-1', 'greet', 'x'.repeat(4001)], 400, 'longer than 4000'],
    ] as const)('%s', async (_label, args, status, error) => {
      const { store, skills, teamId } = await setup()
      const before = store.getMessages(teamId).length

      const [id, agent, token, text] = args(teamId)
      const result = await skills.invokeAgentSkill(id, agent, token, text)

      expect(result.status).toBe(status)
      expect(result.error).toContain(error)
      expect(events).toEqual([])
      expect(store.getMessages(teamId)).toHaveLength(before)
    })

    it('a dead session is a 409', async () => {
      const { skills, teamId } = await setup()
      alive = false
      const result = await skills.invokeAgentSkill(teamId, 'fakea-1', 'greet', 'hi')
      expect(result).toMatchObject({ status: 409, error: 'agent session is not running' })
      expect(events).toEqual([])
    })

    it('a token outside the project the agent runs in is refused: the directory comes from the team, not the caller', async () => {
      const { skills, teamId } = await setup({ workingDirectory: path.join(root, 'elsewhere') })
      const result = await skills.invokeAgentSkill(teamId, 'fakea-1', 'greet', '')
      expect(result.status).toBe(400)
    })
  })

  describe('slash', () => {
    it('writes the command alone on its line, then the nudge once it is accepted, and records one command message', async () => {
      const { store, skills, teamId, settle } = await setup()

      const result = await skills.invokeAgentSkill(teamId, 'fakea-1', 'greet', 'to the world')
      await settle(result)

      expect(result.status).toBe(200)
      expect(pastes()).toEqual(['/greet to the world', "→ When you're done, share what you did via team-say."])
      expect(pastes()[0]).not.toContain('[Team message')
      const feed = store.getMessages(teamId)
      expect(feed).toHaveLength(1)
      expect(feed[0]).toMatchObject({ from: 'user', to: 'fakea-1', type: 'command', content: '/greet to the world' })
      expect(result.data?.message).toMatchObject({ id: feed[0].id, seq: 1 })
    })

    it('is a bare "/token" with no trailing space when there are no args', async () => {
      const { store, skills, teamId, settle } = await setup()
      const result = await skills.invokeAgentSkill(teamId, 'fakea-1', 'greet', '')
      await settle(result)
      expect(pastes()[0]).toBe('/greet')
      expect(store.getMessages(teamId)[0].content).toBe('/greet')
    })

    it('types the command for an adapter whose inputMethod is sendKeys, so no character of args can be an Enter', async () => {
      const { skills, teamId, settle } = await setup()
      const result = await skills.invokeAgentSkill(teamId, 'fakes-4', 'greet', 'hi')
      await settle(result)
      expect(events[0]).toBe('keys duo-fakes-4 /greet hi literal enter')
      expect(events.filter(e => e.startsWith('paste'))).toEqual([])
    })

    it('presses a standalone Enter while the command still shows, then goes on once the composer is clear', async () => {
      const { runtime, skills, teamId, settle } = await setup()
      let shown = 3 // the first look is ensureSubmitted's own submit check; the next two are the confirmation's
      screenText = () => (shown-- > 0 ? '❯ /greet hi' : '> ')

      const result = await skills.invokeAgentSkill(teamId, 'fakea-1', 'greet', 'hi')
      await settle(result)

      expect(runtime.sendKeys.mock.calls.filter(c => c[1] === 'Enter')).toHaveLength(2)
      expect(pastes()).toHaveLength(2)
    })

    it('presses at most two extra Enters, then skips the nudge and leaves a warning after the command message', async () => {
      const { runtime, store, skills, teamId, settle } = await setup()
      screenText = () => '❯ /greet hi'

      const result = await skills.invokeAgentSkill(teamId, 'fakea-1', 'greet', 'hi')
      await settle(result)

      expect(runtime.sendKeys.mock.calls.filter(c => c[1] === 'Enter')).toHaveLength(2)
      expect(pastes()).toEqual(['/greet hi'])
      const feed = store.getMessages(teamId)
      expect(feed.map(m => [m.from, m.type])).toEqual([['user', 'command'], ['ensemble', 'chat']])
      expect(feed[1].content).toContain('/greet may not have been accepted by fakea-1')
    })

    it('holds the session for the whole sequence: a teammate message queues behind the nudge', async () => {
      const { skills, messaging, teamId } = await setup()
      const fired = await skills.invokeAgentSkill(teamId, 'fakea-1', 'greet', 'hi')
      const said = await messaging.sendTeamMessage(teamId, 'fakea-1', 'ping', 'fakeb-2')
      await vi.advanceTimersByTimeAsync(120_000)
      await Promise.all([fired.delivery, said.delivery])

      expect(pastes()).toEqual([
        '/greet hi',
        "→ When you're done, share what you did via team-say.",
        '[Team message from fakeb-2]: ping\n→ Respond with team-say. Then run team-read to check for more messages.',
      ])
    })

    it('reports a failed write in the feed, without rejecting, and still has the one command message', async () => {
      const { store, skills, teamId, settle } = await setup()
      pasteFails = true

      const result = await skills.invokeAgentSkill(teamId, 'fakea-1', 'greet', 'hi')
      await settle(result)

      const feed = store.getMessages(teamId)
      expect(feed.filter(m => m.type === 'command')).toHaveLength(1)
      expect(feed.find(m => m.from === 'ensemble')?.content).toBe('❌ Delivery of /greet to fakea-1 failed: PTY session not found')
    })
  })

  describe('prose', () => {
    it('goes through the ordinary team-message path and writes no raw slash line', async () => {
      const { store, skills, teamId, settle } = await setup()

      const result = await skills.invokeAgentSkill(teamId, 'fakeb-2', 'greet', 'to the world')
      await settle(result)

      expect(result.status).toBe(200)
      expect(events).toHaveLength(1)
      expect(events[0]).toContain('[Team message from user]: Use your "greet" skill: to the world')
      expect(events[0]).not.toMatch(/(^|\s)\/greet/)
      expect(store.getMessages(teamId).map(m => m.type)).toEqual(['chat'])
    })
  })
})
