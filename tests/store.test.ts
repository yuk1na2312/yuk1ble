import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnsembleMessage, EnsembleTeam } from '../types/ensemble'

/**
 * The in-memory store against real files in a temp data dir. Each test gets a
 * fresh module (empty memory) so "restart" is just vi.resetModules() + import.
 */
describe('registry store', () => {
  const saved = { data: process.env.ENSEMBLE_DATA_DIR, runtime: process.env.ENSEMBLE_RUNTIME_DIR }
  let root: string
  let teamsFile: string
  let teamId: string

  const feedFile = () => path.join(root, 'ensemble', 'messages', teamId, 'feed.jsonl')
  const legacyFile = () => path.join(root, 'runtime', teamId, 'messages.jsonl')
  const load = () => import('../lib/ensemble-registry')

  function msg(id: string, extra: Partial<EnsembleMessage> = {}): EnsembleMessage {
    return {
      id, teamId, from: 'a', to: 'team', content: `content ${id}`, type: 'chat',
      timestamp: '2026-01-01T10:00:00.000Z', ...extra,
    }
  }

  function writeLines(file: string, lines: string[]): void {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, lines.join('\n') + '\n')
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-store-'))
    teamsFile = path.join(root, 'ensemble', 'teams.json')
    teamId = `team-${Math.random().toString(36).slice(2, 8)}`
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

  describe('teams', () => {
    it('writes teams.json on flush and a fresh process reads it back', async () => {
      const store = await load()
      const team = store.createTeam({ name: 'n', description: 'd', agents: [{ program: 'codex' }, { program: 'claude code' }] })
      store.updateTeam(team.id, { status: 'active' })
      expect(fs.existsSync(teamsFile)).toBe(false) // debounced, not yet written
      store.flushStore()

      const onDisk = JSON.parse(fs.readFileSync(teamsFile, 'utf-8')) as EnsembleTeam[]
      expect(onDisk).toHaveLength(1)
      expect(onDisk[0]).toMatchObject({ id: team.id, status: 'active' })
      expect(fs.readdirSync(path.dirname(teamsFile)).filter(f => f.endsWith('.tmp'))).toEqual([])

      vi.resetModules()
      const restarted = await load()
      expect(restarted.getTeam(team.id)).toMatchObject({ name: 'n', status: 'active' })
      expect(restarted.getTeam(team.id)?.agents.map(a => a.name)).toEqual(['codex-1', 'claude-2'])
    })

    it('flushes by itself after the debounce window', async () => {
      const store = await load()
      store.createTeam({ name: 'n', description: 'd', agents: [{ program: 'codex' }, { program: 'claude' }] })
      await vi.waitFor(() => expect(fs.existsSync(teamsFile)).toBe(true), { timeout: 2000 })
    })

    it('hands out copies, so a caller cannot change stored state by mutating one', async () => {
      const store = await load()
      const team = store.createTeam({ name: 'n', description: 'd', agents: [{ program: 'codex' }, { program: 'claude' }] })
      team.status = 'failed'
      team.agents[0].status = 'failed'
      expect(store.getTeam(team.id)).toMatchObject({ status: 'forming' })
      expect(store.getTeam(team.id)?.agents[0].status).toBe('spawning')
    })

    it('does not overwrite an unreadable teams.json with an empty list', async () => {
      fs.mkdirSync(path.dirname(teamsFile), { recursive: true })
      fs.writeFileSync(teamsFile, '{ not json')
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const store = await load()
      expect(store.loadTeams()).toEqual([])
      const kept = fs.readdirSync(path.dirname(teamsFile)).filter(f => f.startsWith('teams.json.corrupt-'))
      expect(kept).toHaveLength(1)
      expect(fs.readFileSync(path.join(path.dirname(teamsFile), kept[0]), 'utf-8')).toBe('{ not json')
    })
  })

  describe('messages', () => {
    it('numbers messages per team in append order and filters by seq', async () => {
      const store = await load()
      store.appendMessage(teamId, msg('m1'))
      store.appendMessage(teamId, msg('m2'))
      store.appendMessage(teamId, msg('m3'))
      store.appendMessage('other-team', msg('x1', { teamId: 'other-team' }))

      expect(store.getMessages(teamId).map(m => m.seq)).toEqual([1, 2, 3])
      expect(store.getMessages('other-team').map(m => m.seq)).toEqual([1])
      expect(store.getMessages(teamId, 1).map(m => m.id)).toEqual(['m2', 'm3'])
      expect(store.getMessages(teamId, '2').map(m => m.id)).toEqual(['m3'])
      expect(store.getMessages(teamId, 3)).toEqual([])
    })

    it('still honours an ISO timestamp for `since`', async () => {
      const store = await load()
      store.appendMessage(teamId, msg('old', { timestamp: '2026-01-01T10:00:00.000Z' }))
      store.appendMessage(teamId, msg('new', { timestamp: '2026-01-01T12:00:00.000Z' }))
      expect(store.getMessages(teamId, '2026-01-01T11:00:00.000Z').map(m => m.id)).toEqual(['new'])
    })

    it('appends to one log file and keeps seq across a restart', async () => {
      const store = await load()
      store.appendMessage(teamId, msg('m1'))
      store.appendMessage(teamId, msg('m2'))
      expect(fs.readFileSync(feedFile(), 'utf-8').trim().split('\n').map(l => JSON.parse(l).id)).toEqual(['m1', 'm2'])

      vi.resetModules()
      const restarted = await load()
      expect(restarted.getMessages(teamId).map(m => [m.id, m.seq])).toEqual([['m1', 1], ['m2', 2]])
      restarted.appendMessage(teamId, msg('m3'))
      expect(restarted.getMessages(teamId, 2).map(m => [m.id, m.seq])).toEqual([['m3', 3]])
    })

    it('ignores a repeated message id', async () => {
      const store = await load()
      store.appendMessage(teamId, msg('same'))
      store.appendMessage(teamId, msg('same', { content: 'retry' }))
      expect(store.getMessages(teamId)).toHaveLength(1)
      expect(fs.readFileSync(feedFile(), 'utf-8').trim().split('\n')).toHaveLength(1)
    })

    it('skips a corrupt log line and warns once instead of failing the whole feed', async () => {
      writeLines(feedFile(), [
        JSON.stringify(msg('good-1', { timestamp: '2026-01-01T10:00:00.000Z' })),
        '{"id":"torn","content":"never finished',
        'null',
        JSON.stringify(msg('good-2', { timestamp: '2026-01-01T10:00:01.000Z' })),
      ])
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const store = await load()

      expect(store.getMessages(teamId).map(m => m.id)).toEqual(['good-1', 'good-2'])
      store.getMessages(teamId)
      store.appendMessage(teamId, msg('good-3'))
      expect(store.getMessages(teamId).map(m => m.seq)).toEqual([1, 2, 3])
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toContain('2 corrupt')
    })

    it('merges the legacy runtime-dir messages.jsonl on load, de-duplicated by id', async () => {
      writeLines(feedFile(), [
        JSON.stringify(msg('shared', { content: 'from feed', timestamp: '2026-01-01T10:00:01.000Z' })),
      ])
      writeLines(legacyFile(), [
        JSON.stringify(msg('legacy-only', { timestamp: '2026-01-01T10:00:00.000Z' })),
        JSON.stringify(msg('shared', { content: 'from legacy', timestamp: '2026-01-01T10:00:01.000Z' })),
      ])
      const store = await load()

      const messages = store.getMessages(teamId)
      expect(messages.map(m => m.id)).toEqual(['legacy-only', 'shared'])
      expect(messages[1].content).toBe('from feed')
      expect(messages.map(m => m.seq)).toEqual([1, 2])
    })

    it('keeps only the newest 5000 messages in memory and leaves the rest on disk', async () => {
      const store = await load()
      const total = store.MAX_MESSAGES_PER_TEAM + 25
      for (let i = 1; i <= total; i++) store.appendMessage(teamId, msg(`m${i}`))

      const kept = store.getMessages(teamId)
      expect(kept).toHaveLength(store.MAX_MESSAGES_PER_TEAM)
      expect(kept[0].seq).toBe(26)
      expect(kept.at(-1)?.seq).toBe(total)
      expect(store.getMessages(teamId, total - 1).map(m => m.id)).toEqual([`m${total}`])
      expect(fs.readFileSync(feedFile(), 'utf-8').trim().split('\n')).toHaveLength(total)
    })
  })
})
