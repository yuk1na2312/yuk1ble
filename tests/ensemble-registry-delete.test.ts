import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnsembleTeam } from '../types/ensemble'

function makeTeam(overrides: Partial<EnsembleTeam> = {}): EnsembleTeam {
  return {
    id: overrides.id ?? 'team-1',
    name: overrides.name ?? 'test-team',
    description: overrides.description ?? 'test',
    status: overrides.status ?? 'active',
    agents: overrides.agents ?? [
      {
        agentId: 'agent-id-1',
        name: 'codex-1',
        program: 'codex',
        role: 'lead',
        hostId: 'local',
        status: 'active',
      },
    ],
    createdBy: overrides.createdBy ?? 'test',
    createdAt: overrides.createdAt ?? '2026-03-18T10:00:00.000Z',
    completedAt: overrides.completedAt,
    feedMode: overrides.feedMode ?? 'live',
    result: overrides.result,
    archivedAt: overrides.archivedAt,
  }
}

// ─────────────────────────────────────────────────────
// deleteTeam() — teams.json record removal
// ─────────────────────────────────────────────────────
describe('deleteTeam()', () => {
  const originalDataDir = process.env.ENSEMBLE_DATA_DIR
  let tempRoot: string

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-registry-delete-'))
    process.env.ENSEMBLE_DATA_DIR = tempRoot
    vi.resetModules()
  })

  afterEach(() => {
    vi.resetModules()
    if (originalDataDir === undefined) {
      delete process.env.ENSEMBLE_DATA_DIR
    } else {
      process.env.ENSEMBLE_DATA_DIR = originalDataDir
    }
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })

  it('removes the record so getTeam returns undefined', async () => {
    const { saveTeams, getTeam, deleteTeam } = await import('../lib/ensemble-registry')
    const team = makeTeam({ id: 'team-to-delete' })
    saveTeams([team])

    expect(getTeam('team-to-delete')).toBeDefined()

    const result = deleteTeam('team-to-delete')

    expect(result).toBe(true)
    expect(getTeam('team-to-delete')).toBeUndefined()
  })

  it('returns false for an unknown id and leaves other records untouched', async () => {
    const { saveTeams, getTeam, deleteTeam } = await import('../lib/ensemble-registry')
    const team = makeTeam({ id: 'team-keep' })
    saveTeams([team])

    const result = deleteTeam('team-does-not-exist')

    expect(result).toBe(false)
    expect(getTeam('team-keep')).toBeDefined()
  })

  it('completes without deadlock and within a sane time', async () => {
    // Regression test: an implementation that composes withTeamsLock(() =>
    // saveTeams(...)) self-deadlocks against the non-reentrant mkdir mutex
    // and throws after the 5s LOCK_TIMEOUT_MS. A correct implementation
    // (single withTeamsLock call, private file helpers) returns near-instantly.
    const { saveTeams, deleteTeam } = await import('../lib/ensemble-registry')
    const team = makeTeam({ id: 'team-fast' })
    saveTeams([team])

    const startedAt = Date.now()
    const result = deleteTeam('team-fast')
    const elapsedMs = Date.now() - startedAt

    expect(result).toBe(true)
    expect(elapsedMs).toBeLessThan(1000)
  })

  it('leaves other teams intact when several exist', async () => {
    const { saveTeams, getTeam, deleteTeam } = await import('../lib/ensemble-registry')
    saveTeams([
      makeTeam({ id: 'team-a' }),
      makeTeam({ id: 'team-b' }),
      makeTeam({ id: 'team-c' }),
    ])

    const result = deleteTeam('team-b')

    expect(result).toBe(true)
    expect(getTeam('team-a')).toBeDefined()
    expect(getTeam('team-b')).toBeUndefined()
    expect(getTeam('team-c')).toBeDefined()
  })

  it('round-trips a team with archivedAt set through save/load', async () => {
    const { saveTeams, getTeam } = await import('../lib/ensemble-registry')
    const archivedAt = '2026-03-18T11:00:00.000Z'
    saveTeams([makeTeam({ id: 'team-archived', archivedAt })])

    const loaded = getTeam('team-archived')

    expect(loaded).toBeDefined()
    expect(loaded?.archivedAt).toBe(archivedAt)
  })
})
