import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Background startup after the 202: failures are caught, logged and written to the feed. */
describe('team startup in the background', () => {
  const saved = { data: process.env.ENSEMBLE_DATA_DIR, runtime: process.env.ENSEMBLE_RUNTIME_DIR }
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-start-'))
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

  const request = { name: 'bg', description: 'task', agents: [{ program: 'codex' }, { program: 'claude' }], workingDirectory: os.tmpdir() }

  async function setup(options: {
    spawn?: (args: { name: string }) => Promise<{ id: string }>
    getRuntime?: () => unknown
  } = {}) {
    const killLocalAgent = vi.fn(async () => {})
    const runtime = {
      screen: vi.fn(() => '>'),
      sendKeys: vi.fn(() => {}),
      paste: vi.fn(() => {}),
      exists: vi.fn(() => true),
      onData: vi.fn(() => () => {}),
    }
    vi.doMock('../lib/agent-spawner', () => ({
      spawnLocalAgent: vi.fn(options.spawn ?? (async ({ name }: { name: string }) => ({ id: `${name}-id` }))),
      killLocalAgent,
      getAgentTokenUsage: vi.fn(async () => 'unknown'),
    }))
    vi.doMock('../lib/agent-runtime', () => ({ getRuntime: vi.fn(options.getRuntime ?? (() => runtime)) }))
    vi.doMock('../lib/agent-config', () => ({
      resolveAgentProgram: vi.fn(() => ({ readyMarker: '>', inputMethod: 'sendKeys' })),
      resolveReadyMarkers: vi.fn(() => ['>']),
    }))
    const store = await import('../lib/ensemble-registry')
    const service = await import('../services/ensemble-service')
    return { store, service, killLocalAgent }
  }

  it('an unexpected startup error is logged, written to the feed, cleans up, and the completion promise still resolves', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { store, service, killLocalAgent } = await setup({ getRuntime: () => { throw new Error('runtime exploded') } })

    const result = await service.createEnsembleTeam(request)
    expect(result.status).toBe(202)
    await expect(result.completion).resolves.toBeUndefined()

    const id = result.data!.team.id
    expect(store.getMessages(id).map(m => m.content)).toContain('❌ Team startup failed: runtime exploded')
    expect(store.getTeam(id)?.status).toBe('disbanded')
    // Both agents had spawned; leaving them would orphan the processes.
    expect(killLocalAgent).toHaveBeenCalledTimes(2)
    expect(error).toHaveBeenCalled()
  })

  it('reports each failed spawn and an aborted start when fewer than two agents come up', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { store, service } = await setup({ spawn: async ({ name }) => { throw new Error(`no binary for ${name}`) } })

    const result = await service.createEnsembleTeam(request)
    await result.completion

    const feed = store.getMessages(result.data!.team.id).map(m => m.content)
    expect(feed).toEqual([
      'Failed to spawn bg-codex-1: no binary for bg-codex-1',
      'Failed to spawn bg-claude-2: no binary for bg-claude-2',
      '❌ Team start aborted: only 0 of 2 agents spawned (at least 2 are needed)',
    ])
    expect(store.getTeam(result.data!.team.id)?.agents.map(a => a.status)).toEqual(['idle', 'idle'])
  })

  it('does not bring a team back to life when it was disbanded while agents were still spawning', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const spawnedNames: string[] = []
    const { store, service, killLocalAgent } = await setup({
      spawn: async ({ name }) => { spawnedNames.push(name); await gate; return { id: `${name}-id` } },
    })

    const result = await service.createEnsembleTeam(request)
    const id = result.data!.team.id
    await service.disbandTeam(id)
    expect(store.getTeam(id)?.status).toBe('disbanded')

    release()
    await result.completion

    expect(store.getTeam(id)?.status).toBe('disbanded')
    // The session that finished spawning after the disband is killed, and no further one is started.
    expect(killLocalAgent).toHaveBeenCalledTimes(1)
    expect(killLocalAgent).toHaveBeenCalledWith('bg-codex-1')
    expect(spawnedNames).toEqual(['bg-codex-1'])
  })
})
