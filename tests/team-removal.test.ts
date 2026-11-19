import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnsembleTeam } from '../src/types'
import { bootServer } from './helpers/boot-server'

const agents = [{ program: 'codex' }, { program: 'claude' }]

/** Store + lifecycle against real files in a temp data dir; nothing mocked but the processes. */
describe('archiveTeam / purgeTeam / store.deleteTeam', () => {
  const saved = { data: process.env.ENSEMBLE_DATA_DIR, runtime: process.env.ENSEMBLE_RUNTIME_DIR }
  let root: string

  const teamsFile = () => path.join(root, 'ensemble', 'teams.json')
  const feedDir = (id: string) => path.join(root, 'ensemble', 'messages', id)
  const runtimeDir = (id: string) => path.join(root, 'runtime', id)

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-removal-'))
    process.env.ENSEMBLE_DATA_DIR = root
    process.env.ENSEMBLE_RUNTIME_DIR = path.join(root, 'runtime')
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
    vi.doMock('../src/core/agent-spawner', () => ({
      spawnLocalAgent: vi.fn(async () => ({ id: 'x' })),
      killLocalAgent: vi.fn(async () => {}),
      getAgentTokenUsage: vi.fn(async () => 'unknown'),
    }))
    vi.doMock('../src/runtime/agent-runtime', () => ({ getRuntime: vi.fn(), setRuntime: vi.fn() }))
    const store = await import('../src/core/store')
    const lifecycle = await import('../src/core/team-lifecycle')
    return { store, lifecycle }
  }

  /** A team with a message in its feed and a file in its runtime dir. */
  function makeTeam(store: Awaited<ReturnType<typeof setup>>['store'], updates: Partial<EnsembleTeam> = {}): EnsembleTeam {
    const team = store.createTeam({ name: 'old-run', description: 'd', agents })
    store.appendMessage(team.id, { id: 'm-1', teamId: team.id, from: 'codex-1', to: 'team', content: 'hi', type: 'chat', timestamp: new Date().toISOString() })
    fs.mkdirSync(runtimeDir(team.id), { recursive: true })
    fs.writeFileSync(path.join(runtimeDir(team.id), 'summary.txt'), 'summary')
    return store.updateTeam(team.id, updates)!
  }

  describe('archiveTeam', () => {
    it('sets archivedAt to an ISO timestamp, and false clears it', async () => {
      const { store, lifecycle } = await setup()
      const team = makeTeam(store, { status: 'disbanded' })

      const archived = await lifecycle.archiveTeam(team.id, true)
      expect(archived.status).toBe(200)
      expect(new Date(archived.data!.team.archivedAt!).toISOString()).toBe(archived.data!.team.archivedAt)
      expect(store.getTeam(team.id)?.archivedAt).toBe(archived.data!.team.archivedAt)

      const restored = await lifecycle.archiveTeam(team.id, false)
      expect(restored.status).toBe(200)
      expect(store.getTeam(team.id)?.archivedAt).toBeUndefined()
    })

    it('deletes nothing: feed and runtime dir survive an archive', async () => {
      const { store, lifecycle } = await setup()
      const team = makeTeam(store, { status: 'disbanded' })
      await lifecycle.archiveTeam(team.id, true)
      expect(fs.existsSync(feedDir(team.id))).toBe(true)
      expect(fs.existsSync(runtimeDir(team.id))).toBe(true)
    })

    it.each(['active', 'forming'] as const)('refuses a %s team with 409', async status => {
      const { store, lifecycle } = await setup()
      const team = makeTeam(store, { status })
      const result = await lifecycle.archiveTeam(team.id, true)
      expect(result).toMatchObject({ status: 409, error: expect.stringContaining('disband it first') })
      expect(store.getTeam(team.id)?.archivedAt).toBeUndefined()
    })

    it('answers 404 for an unknown id', async () => {
      const { lifecycle } = await setup()
      expect((await lifecycle.archiveTeam(randomUUID(), true)).status).toBe(404)
    })
  })

  describe('purgeTeam', () => {
    it('removes the record, the feed (memory and disk) and the runtime dir', async () => {
      const { store, lifecycle } = await setup()
      const team = makeTeam(store, { status: 'disbanded', archivedAt: new Date().toISOString() })
      const removed = vi.fn()
      const { bus } = await import('../src/core/bus')
      bus.on('team-removed', removed)

      const result = await lifecycle.purgeTeam(team.id)

      expect(result).toEqual({ data: { ok: true, warnings: [] }, status: 200 })
      expect(store.getTeam(team.id)).toBeUndefined()
      expect(store.loadTeams()).toEqual([])
      expect(fs.existsSync(feedDir(team.id))).toBe(false)
      expect(fs.existsSync(runtimeDir(team.id))).toBe(false)
      expect(removed).toHaveBeenCalledWith({ id: team.id })
      expect(JSON.parse(fs.readFileSync(teamsFile(), 'utf-8'))).toEqual([]) // written at once, not debounced
    })

    it('leaves other teams and their files alone', async () => {
      const { store, lifecycle } = await setup()
      const gone = makeTeam(store, { status: 'disbanded', archivedAt: new Date().toISOString() })
      const kept = makeTeam(store, { status: 'disbanded' })

      await lifecycle.purgeTeam(gone.id)

      expect(store.loadTeams().map(t => t.id)).toEqual([kept.id])
      expect(store.getMessages(kept.id)).toHaveLength(1)
      expect(fs.existsSync(feedDir(kept.id))).toBe(true)
      expect(fs.existsSync(runtimeDir(kept.id))).toBe(true)
    })

    it('stays removed after a restart', async () => {
      const { store, lifecycle } = await setup()
      const team = makeTeam(store, { status: 'disbanded', archivedAt: new Date().toISOString() })
      await lifecycle.purgeTeam(team.id)

      vi.resetModules()
      const restarted = await import('../src/core/store')
      expect(restarted.getTeam(team.id)).toBeUndefined()
      expect(restarted.getMessages(team.id)).toEqual([])
    })

    it('answers 404 for an unknown id and 400 for an id that is not a UUID', async () => {
      // A record whose id could climb out of the data dir if it reached rmSync, seeded on disk.
      fs.mkdirSync(path.dirname(teamsFile()), { recursive: true })
      fs.writeFileSync(teamsFile(), JSON.stringify([{
        id: '..', name: 'odd', description: 'd', status: 'disbanded', agents: [], createdBy: 'u',
        createdAt: new Date().toISOString(), feedMode: 'live', archivedAt: new Date().toISOString(),
      }]))
      const { store, lifecycle } = await setup()
      expect((await lifecycle.purgeTeam(randomUUID())).status).toBe(404)
      expect(await lifecycle.purgeTeam('..')).toMatchObject({ status: 400, error: 'Invalid team id' })
      expect(store.getTeam('..')).toBeDefined()
    })

    it.each(['active', 'forming'] as const)('refuses a %s team with 409, archived or not', async status => {
      const { store, lifecycle } = await setup()
      const team = makeTeam(store, { status, archivedAt: new Date().toISOString() })
      expect((await lifecycle.purgeTeam(team.id)).status).toBe(409)
      expect(store.getTeam(team.id)).toBeDefined()
      expect(fs.existsSync(feedDir(team.id))).toBe(true)
    })

    it('refuses a team that is not archived with 409', async () => {
      const { store, lifecycle } = await setup()
      const team = makeTeam(store, { status: 'disbanded' })
      expect(await lifecycle.purgeTeam(team.id)).toMatchObject({ status: 409, error: expect.stringContaining('not been archived') })
      expect(store.getTeam(team.id)).toBeDefined()
      expect(fs.existsSync(runtimeDir(team.id))).toBe(true)
    })

    it('warns about worktrees it cannot locate', async () => {
      const { store, lifecycle } = await setup()
      const team = makeTeam(store, { status: 'disbanded', archivedAt: new Date().toISOString() })
      store.updateTeam(team.id, { agents: team.agents.map(a => ({ ...a, worktreePath: 'C:\\wt\\x' })) })
      const result = await lifecycle.purgeTeam(team.id)
      expect(result.status).toBe(200)
      expect(result.data?.warnings).toEqual([expect.stringContaining('worktrees')])
    })

    it('reports a file it could not delete as a warning and still removes the record', async () => {
      const { store, lifecycle } = await setup()
      const team = makeTeam(store, { status: 'disbanded', archivedAt: new Date().toISOString() })
      const realRm = fs.rmSync
      vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
        if (String(target).startsWith(runtimeDir(team.id))) throw new Error('EBUSY')
        return realRm(target, options)
      })

      const result = await lifecycle.purgeTeam(team.id)

      expect(result.status).toBe(200)
      expect(result.data?.warnings).toEqual([expect.stringContaining('EBUSY')])
      expect(store.getTeam(team.id)).toBeUndefined()
    })
  })
})

/** The two routes over real HTTP. */
describe('POST /api/ensemble/teams/:id/archive and /purge', () => {
  let server: Awaited<ReturnType<typeof bootServer>>
  const url = (suffix: string) => `${server.baseUrl}/api/ensemble/teams/${suffix}`
  const post = (suffix: string, body?: string) => fetch(url(suffix), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  })

  beforeAll(async () => { server = await bootServer() })
  afterAll(() => {
    server.restore()
    server.cleanup()
  })

  async function makeTeam(updates: Partial<EnsembleTeam>): Promise<EnsembleTeam> {
    const store = await server.store()
    const team = store.createTeam({ name: 'http-run', description: 'd', agents })
    store.appendMessage(team.id, { id: 'm-1', teamId: team.id, from: 'codex-1', to: 'team', content: 'hi', type: 'chat', timestamp: new Date().toISOString() })
    return store.updateTeam(team.id, updates)!
  }

  it('archive then restore round-trips archivedAt', async () => {
    const team = await makeTeam({ status: 'disbanded' })

    const archived = await post(`${team.id}/archive`, '{"archived":true}')
    expect(archived.status).toBe(200)
    expect(((await archived.json()) as { team: EnsembleTeam }).team.archivedAt).toBeTruthy()
    const listed = await (await fetch(`${server.baseUrl}/api/ensemble/teams`)).json() as { teams: EnsembleTeam[] }
    expect(listed.teams.find(t => t.id === team.id)?.archivedAt).toBeTruthy()

    const restored = await post(`${team.id}/archive`, '{"archived":false}')
    expect(restored.status).toBe(200)
    expect(((await restored.json()) as { team: EnsembleTeam }).team.archivedAt).toBeUndefined()
  })

  it.each([
    ['malformed JSON', '{ nope'],
    ['no body', ''],
    ['an object without archived', '{}'],
    ['a string archived', '{"archived":"true"}'],
    ['JSON null', 'null'],
  ])('archive with %s is a 400', async (_label, body) => {
    const team = await makeTeam({ status: 'disbanded' })
    const res = await post(`${team.id}/archive`, body)
    expect(res.status).toBe(400)
    const store = await server.store()
    expect(store.getTeam(team.id)?.archivedAt).toBeUndefined()
  })

  it('archive of an active or forming team is a 409, of an unknown one a 404', async () => {
    const active = await makeTeam({ status: 'active' })
    const forming = await makeTeam({ status: 'forming' })
    expect((await post(`${active.id}/archive`, '{"archived":true}')).status).toBe(409)
    expect((await post(`${forming.id}/archive`, '{"archived":true}')).status).toBe(409)
    expect((await post(`${randomUUID()}/archive`, '{"archived":true}')).status).toBe(404)
  })

  it('purge refuses unknown (404), not archived (409) and live (409) teams', async () => {
    const plain = await makeTeam({ status: 'disbanded' })
    const live = await makeTeam({ status: 'active', archivedAt: new Date().toISOString() })
    expect((await post(`${randomUUID()}/purge`)).status).toBe(404)
    expect((await post(`${plain.id}/purge`)).status).toBe(409)
    expect((await post(`${live.id}/purge`)).status).toBe(409)
  })

  it('purge erases an archived team: record, feed dir and runtime dir', async () => {
    const team = await makeTeam({ status: 'disbanded', archivedAt: new Date().toISOString() })
    const feedDir = path.join(server.tempRoot, 'ensemble', 'messages', team.id)
    const runtimeDir = path.join(server.tempRoot, 'runtime', team.id)
    fs.mkdirSync(runtimeDir, { recursive: true })
    fs.writeFileSync(path.join(runtimeDir, 'summary.txt'), 's')
    expect(fs.existsSync(feedDir)).toBe(true)

    const res = await post(`${team.id}/purge`)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, warnings: [] })
    expect((await fetch(url(team.id))).status).toBe(404)
    expect(fs.existsSync(feedDir)).toBe(false)
    expect(fs.existsSync(runtimeDir)).toBe(false)
  })
})
