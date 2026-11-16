import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** sendTeamMessage against the real store, with only the PTY runtime replaced. */
describe('sendTeamMessage delivery', () => {
  const saved = { data: process.env.ENSEMBLE_DATA_DIR, runtime: process.env.ENSEMBLE_RUNTIME_DIR }
  let root: string
  const events: string[] = []
  let pasteFailsFor: string | undefined

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-send-'))
    process.env.ENSEMBLE_DATA_DIR = root
    process.env.ENSEMBLE_RUNTIME_DIR = path.join(root, 'runtime')
    events.length = 0
    pasteFailsFor = undefined
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    for (const [key, value] of [['ENSEMBLE_DATA_DIR', saved.data], ['ENSEMBLE_RUNTIME_DIR', saved.runtime]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(root, { recursive: true, force: true })
  })

  async function setup() {
    const runtime = {
      sessionExists: vi.fn(async () => true),
      pasteFromFile: vi.fn(async (session: string, file: string) => {
        if (session === pasteFailsFor) throw new Error('PTY session not found')
        events.push(`paste ${session} ${fs.readFileSync(file, 'utf8').split('\n')[0]}`)
      }),
      // ensureSubmitted looks at the pane once after its first wait.
      capturePane: vi.fn(async (session: string) => { events.push(`submit-check ${session}`); return '>' }),
      sendKeys: vi.fn(async () => {}),
    }
    vi.doMock('../lib/agent-runtime', () => ({ getRuntime: vi.fn(() => runtime) }))
    vi.doMock('../lib/agent-spawner', () => ({
      spawnLocalAgent: vi.fn(), killLocalAgent: vi.fn(), getAgentTokenUsage: vi.fn(async () => 'unknown'),
    }))

    const store = await import('../lib/ensemble-registry')
    const service = await import('../services/ensemble-service')
    const team = store.createTeam({
      name: 'trio', description: 'd',
      agents: [{ program: 'codex' }, { program: 'claude' }, { program: 'gemini' }],
    })
    store.updateTeam(team.id, { status: 'active', agents: team.agents.map(a => ({ ...a, status: 'active' as const })) })
    return { store, service, runtime, teamId: team.id }
  }

  it('serves the recipients of a broadcast in parallel, not one after another', async () => {
    const { service, teamId } = await setup()
    const startedAt = Date.now()

    const result = await service.sendTeamMessage(teamId, 'team', 'hello all', 'codex-1')
    await result.delivery
    const elapsed = Date.now() - startedAt

    expect(result.status).toBe(200)
    expect(events.filter(e => e.startsWith('paste')).sort()).toEqual([
      'paste trio-claude-2 [Team message from codex-1]: hello all',
      'paste trio-gemini-3 [Team message from codex-1]: hello all',
    ])
    // Each delivery waits 1.5s for the submit check; one after the other that is 3s.
    expect(elapsed).toBeGreaterThanOrEqual(1400)
    expect(elapsed).toBeLessThan(2800)
  }, 15_000)

  it('reports a failed recipient in the feed and still delivers to the others', async () => {
    const { service, store, teamId } = await setup()
    pasteFailsFor = 'trio-claude-2'

    const result = await service.sendTeamMessage(teamId, 'team', 'hello all', 'codex-1')
    await result.delivery

    expect(result.status).toBe(200)
    expect(events.some(e => e.startsWith('paste trio-gemini-3'))).toBe(true)
    const notes = store.getMessages(teamId).filter(m => m.from === 'ensemble').map(m => m.content)
    expect(notes).toEqual(['❌ Delivery to claude-2 failed: PTY session not found'])
  }, 15_000)

  it('never interleaves two messages for the same agent', async () => {
    const { service, teamId } = await setup()

    const sent = await Promise.all([
      service.sendTeamMessage(teamId, 'claude-2', 'first', 'codex-1'),
      service.sendTeamMessage(teamId, 'claude-2', 'second', 'gemini-3'),
    ])
    await Promise.all(sent.map(result => result.delivery))

    expect(events).toEqual([
      'paste trio-claude-2 [Team message from codex-1]: first',
      'submit-check trio-claude-2',
      'paste trio-claude-2 [Team message from gemini-3]: second',
      'submit-check trio-claude-2',
    ])
  }, 15_000)

  describe('the response does not wait for delivery', () => {
    let release!: () => void
    let blocked: Promise<void>
    beforeEach(() => { blocked = new Promise<void>(resolve => { release = resolve }) })

    it('resolves with the message already in the feed while the paste is still pending', async () => {
      const { service, store, runtime, teamId } = await setup()
      runtime.pasteFromFile.mockImplementation(async (session: string, file: string) => {
        await blocked
        events.push(`paste ${session} ${fs.readFileSync(file, 'utf8').split('\n')[0]}`)
      })
      const startedAt = Date.now()

      const result = await service.sendTeamMessage(teamId, 'claude-2', 'ping', 'codex-1')

      // Resolved long before the 1.5 s submit wait could have passed, with the paste not even finished.
      expect(Date.now() - startedAt).toBeLessThan(1000)
      expect(events).toEqual([])
      expect(store.getMessages(teamId).map(m => m.content)).toEqual(['ping'])
      expect(result.data?.message.seq).toBe(1)

      release()
      await result.delivery
      expect(events).toEqual(['paste trio-claude-2 [Team message from codex-1]: ping', 'submit-check trio-claude-2'])
    }, 15_000)

    it('keeps order per recipient and never rejects, even when the failure note cannot be written', async () => {
      const { service, store, runtime, teamId } = await setup()
      runtime.pasteFromFile.mockRejectedValue(new Error('PTY session not found'))
      const unhandled: unknown[] = []
      const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
      process.on('unhandledRejection', onUnhandled)
      vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const first = await service.sendTeamMessage(teamId, 'claude-2', 'one', 'codex-1')
        const realAppend = store.appendMessage
        vi.spyOn(store, 'appendMessage').mockImplementation((id, message) => {
          if (message.from === 'ensemble') throw new Error('disk full')
          realAppend(id, message)
        })
        const second = await service.sendTeamMessage(teamId, 'claude-2', 'two', 'codex-1')
        await expect(Promise.all([first.delivery, second.delivery])).resolves.toBeDefined()
        await new Promise(resolve => setTimeout(resolve, 50))
      } finally {
        process.off('unhandledRejection', onUnhandled)
      }
      expect(unhandled).toEqual([])
    }, 15_000)

    it('drops deliveries beyond a bounded queue per session, and says so in the feed', async () => {
      const { service, store, runtime, teamId } = await setup()
      runtime.pasteFromFile.mockImplementation(async () => { await blocked })

      const results = []
      for (let i = 0; i < 52; i++) results.push(await service.sendTeamMessage(teamId, 'claude-2', `m${i}`, 'codex-1'))

      const notes = store.getMessages(teamId).filter(m => m.from === 'ensemble').map(m => m.content)
      expect(notes).toHaveLength(2)
      expect(notes[0]).toContain('Delivery to claude-2 dropped')
      // Every message is still in the feed; only the terminal delivery was shed.
      expect(store.getMessages(teamId).filter(m => m.from === 'codex-1')).toHaveLength(52)

      // Drain the 50 that were accepted without sitting through 50 real 1.5 s submit waits.
      vi.useFakeTimers({ toFake: ['setTimeout'] })
      try {
        release()
        const drained = Promise.all(results.map(r => r.delivery))
        await vi.advanceTimersByTimeAsync(200_000)
        await drained
      } finally {
        vi.useRealTimers()
      }
    }, 30_000)
  })

  it('records a repeated message id once and returns its seq', async () => {
    const { service, store, teamId } = await setup()

    const first = await service.sendTeamMessage(teamId, 'nobody', 'once', 'codex-1', 'fixed-id')
    const again = await service.sendTeamMessage(teamId, 'nobody', 'once', 'codex-1', 'fixed-id')

    expect(store.getMessages(teamId).map(m => m.id)).toEqual(['fixed-id'])
    expect(first.data?.message.seq).toBe(1)
    expect(again.status).toBe(200)
  })

  it('rejects an empty message with 400 and records nothing', async () => {
    const { service, store, teamId } = await setup()

    expect(await service.sendTeamMessage(teamId, 'team', '  ', 'codex-1')).toMatchObject({ status: 400 })
    expect(await service.sendTeamMessage(teamId, 'team', undefined as unknown as string, 'codex-1')).toMatchObject({ status: 400 })
    expect(store.getMessages(teamId)).toEqual([])
  })
})
