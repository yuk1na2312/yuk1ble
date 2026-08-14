import fs from 'fs'
import os from 'os'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnsembleTeam } from '../types/ensemble'

/**
 * archiveTeam() / purgeTeam() — the two-tier run-removal feature
 * (docs/superpowers/specs/2026-08-14-run-removal-and-accounts-design.md §1).
 *
 * Runs against the real lib/ensemble-registry and lib/collab-paths modules
 * (nothing mocked) so that filesystem side effects — the thing the ordering
 * rules in the design exist to protect — are actually exercised. Both
 * ENSEMBLE_DATA_DIR and ENSEMBLE_RUNTIME_DIR point at fresh mkdtemp roots per
 * test, so nothing here can touch a real ~/.ensemble install.
 */

// Importing services/ensemble-service.ts constructs the module-level
// EnsembleService singleton, which registers SIGINT/SIGTERM/beforeExit/exit
// handlers. Guard against accumulating one set per dynamic import, same
// idiom as tests/ensemble.test.ts and tests/bridge-lifecycle.test.ts.
let sigintListeners = process.listeners('SIGINT')
let sigtermListeners = process.listeners('SIGTERM')
let beforeExitListeners = process.listeners('beforeExit')
let exitListeners = process.listeners('exit')

beforeEach(() => {
  sigintListeners = process.listeners('SIGINT')
  sigtermListeners = process.listeners('SIGTERM')
  beforeExitListeners = process.listeners('beforeExit')
  exitListeners = process.listeners('exit')
})

afterEach(() => {
  for (const listener of process.listeners('SIGINT')) {
    if (!sigintListeners.includes(listener)) process.removeListener('SIGINT', listener)
  }
  for (const listener of process.listeners('SIGTERM')) {
    if (!sigtermListeners.includes(listener)) process.removeListener('SIGTERM', listener)
  }
  for (const listener of process.listeners('beforeExit')) {
    if (!beforeExitListeners.includes(listener)) process.removeListener('beforeExit', listener)
  }
  for (const listener of process.listeners('exit')) {
    if (!exitListeners.includes(listener)) process.removeListener('exit', listener)
  }
})

describe('archiveTeam() / purgeTeam()', () => {
  const originalDataDir = process.env.ENSEMBLE_DATA_DIR
  const originalRuntimeDir = process.env.ENSEMBLE_RUNTIME_DIR
  let dataDir: string
  let runtimeDir: string

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-removal-data-'))
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-removal-runtime-'))
    process.env.ENSEMBLE_DATA_DIR = dataDir
    process.env.ENSEMBLE_RUNTIME_DIR = runtimeDir
    vi.resetModules()
  })

  afterEach(() => {
    vi.resetModules()
    if (originalDataDir === undefined) delete process.env.ENSEMBLE_DATA_DIR
    else process.env.ENSEMBLE_DATA_DIR = originalDataDir
    if (originalRuntimeDir === undefined) delete process.env.ENSEMBLE_RUNTIME_DIR
    else process.env.ENSEMBLE_RUNTIME_DIR = originalRuntimeDir
    fs.rmSync(dataDir, { recursive: true, force: true })
    fs.rmSync(runtimeDir, { recursive: true, force: true })
  })

  async function loadModules() {
    const registry = await import('../lib/ensemble-registry')
    const collabPaths = await import('../lib/collab-paths')
    const service = await import('../services/ensemble-service')
    return { service, registry, collabPaths }
  }

  function makeTeam(
    registry: Awaited<ReturnType<typeof loadModules>>['registry'],
    overrides: Partial<EnsembleTeam> = {},
  ): EnsembleTeam {
    const created = registry.createTeam({
      name: `test-team-${Math.random().toString(36).slice(2, 8)}`,
      description: 'test',
      agents: [{ program: 'codex' }],
    })
    if (Object.keys(overrides).length === 0) return created
    return registry.updateTeam(created.id, overrides)!
  }

  // ── archive ──────────────────────────────────────────────────────────

  it('archive sets archivedAt to a fresh ISO timestamp', async () => {
    const { service, registry } = await loadModules()
    const team = makeTeam(registry, { status: 'disbanded' })

    const result = await service.archiveTeam(team.id, true)

    expect(result.status).toBe(200)
    expect(result.data?.team.archivedAt).toBeTruthy()
    expect(new Date(result.data!.team.archivedAt!).toString()).not.toBe('Invalid Date')
    expect(registry.getTeam(team.id)?.archivedAt).toBe(result.data!.team.archivedAt)
  })

  it('unarchive clears archivedAt', async () => {
    const { service, registry } = await loadModules()
    const team = makeTeam(registry, { status: 'disbanded', archivedAt: new Date().toISOString() })

    const result = await service.archiveTeam(team.id, false)

    expect(result.status).toBe(200)
    expect(result.data?.team.archivedAt).toBeUndefined()
    expect(registry.getTeam(team.id)?.archivedAt).toBeUndefined()
  })

  it('archive refuses an active team with 409', async () => {
    const { service, registry } = await loadModules()
    const team = makeTeam(registry, { status: 'active' })

    const result = await service.archiveTeam(team.id, true)

    expect(result.status).toBe(409)
    expect(registry.getTeam(team.id)?.archivedAt).toBeUndefined()
  })

  it('archive on an unknown id returns 404', async () => {
    const { service } = await loadModules()

    const result = await service.archiveTeam(uuidv4(), true)

    expect(result.status).toBe(404)
  })

  // ── purge ────────────────────────────────────────────────────────────

  it('purge refuses an active team with 409, even if archived', async () => {
    const { service, registry } = await loadModules()
    const team = makeTeam(registry, { status: 'active', archivedAt: new Date().toISOString() })

    const result = await service.purgeTeam(team.id)

    expect(result.status).toBe(409)
    expect(registry.getTeam(team.id)).toBeDefined()
  })

  it('purge refuses an unarchived team with 409', async () => {
    const { service, registry } = await loadModules()
    const team = makeTeam(registry, { status: 'disbanded' })

    const result = await service.purgeTeam(team.id)

    expect(result.status).toBe(409)
    expect(registry.getTeam(team.id)).toBeDefined()
  })

  it('purge on an unknown id returns 404', async () => {
    const { service } = await loadModules()

    const result = await service.purgeTeam(uuidv4())

    expect(result.status).toBe(404)
  })

  it('purge on an archived team removes both feed stores and the teams.json record', async () => {
    const { service, registry, collabPaths } = await loadModules()
    const team = makeTeam(registry, { status: 'disbanded', archivedAt: new Date().toISOString() })

    // Populate both message stores getMessages() merges at read time.
    registry.appendMessage(team.id, {
      id: 'feed-msg', teamId: team.id, from: 'agent', to: 'team',
      content: 'from feed store', type: 'chat', timestamp: new Date().toISOString(),
    })
    const runtimeMessagesFile = collabPaths.collabMessagesFile(team.id)
    fs.mkdirSync(path.dirname(runtimeMessagesFile), { recursive: true })
    fs.writeFileSync(runtimeMessagesFile, JSON.stringify({
      id: 'runtime-msg', teamId: team.id, from: 'agent', to: 'team',
      content: 'from runtime store', type: 'chat', timestamp: new Date().toISOString(),
    }) + '\n')

    const registryMessagesDir = path.join(dataDir, 'ensemble', 'messages', team.id)
    const runtimeTeamDir = collabPaths.collabRuntimeDir(team.id)
    expect(fs.existsSync(registryMessagesDir)).toBe(true)
    expect(fs.existsSync(runtimeTeamDir)).toBe(true)
    expect(registry.getMessages(team.id)).toHaveLength(2)

    const result = await service.purgeTeam(team.id)

    expect(result.status).toBe(200)
    expect(result.data?.ok).toBe(true)
    expect(result.data?.warnings).toEqual([])

    expect(fs.existsSync(registryMessagesDir)).toBe(false)
    expect(fs.existsSync(runtimeTeamDir)).toBe(false)
    expect(registry.getTeam(team.id)).toBeUndefined()
  })

  it('warns instead of guessing when an archived, purged team had worktrees', async () => {
    const { service, registry } = await loadModules()
    const team = makeTeam(registry, {
      status: 'disbanded',
      archivedAt: new Date().toISOString(),
      agents: [
        {
          agentId: 'agent-1', name: 'codex-1', program: 'codex', role: 'lead',
          hostId: 'local', status: 'done',
          worktreePath: '/repo/.worktrees/team-codex-1',
          worktreeBranch: 'collab/team/codex-1',
        },
      ],
    })

    const result = await service.purgeTeam(team.id)

    expect(result.status).toBe(200)
    expect(result.data?.warnings.length).toBeGreaterThan(0)
    expect(result.data?.warnings[0]).toMatch(/worktree/i)
  })

  it('rejects a non-UUID id before any filesystem call, even if a matching record exists', async () => {
    const { service, registry } = await loadModules()
    const maliciousId = '..'
    const malicious: EnsembleTeam = {
      id: maliciousId,
      name: 'evil',
      description: 'test',
      status: 'disbanded',
      agents: [],
      createdBy: 'test',
      createdAt: new Date().toISOString(),
      feedMode: 'live',
      archivedAt: new Date().toISOString(),
    }
    registry.saveTeams([...registry.loadTeams(), malicious])

    // A directory a path-traversal `rmSync(path.join(messagesDir, '..'))`
    // would actually destroy if the UUID gate were skipped or reordered
    // after the recursive deletes.
    const messagesDir = path.join(dataDir, 'ensemble', 'messages')
    fs.mkdirSync(messagesDir, { recursive: true })
    const sentinel = path.join(messagesDir, 'sentinel.txt')
    fs.writeFileSync(sentinel, 'still here')

    const result = await service.purgeTeam(maliciousId)

    expect(result.status).toBe(400)
    expect(fs.existsSync(sentinel)).toBe(true)
    expect(registry.getTeam(maliciousId)).toBeDefined()
  })
})
