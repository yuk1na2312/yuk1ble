import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnsembleMessage, EnsembleTeam } from '../types/ensemble'
import type { LogEntry } from '../lib/log-buffer'

describe('event bus', () => {
  const saved = { data: process.env.ENSEMBLE_DATA_DIR, runtime: process.env.ENSEMBLE_RUNTIME_DIR }
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-bus-'))
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

  const newMessage = (id: string): EnsembleMessage => ({
    id, teamId: 't1', from: 'a', to: 'team', content: id, type: 'chat', timestamp: '2026-01-01T00:00:00.000Z',
  })

  it('the store emits `team` after create and update, with the new state', async () => {
    const { bus } = await import('../lib/bus')
    const store = await import('../lib/ensemble-registry')
    const seen: EnsembleTeam[] = []
    bus.on('team', team => seen.push(team))

    const team = store.createTeam({ name: 'n', description: 'd', agents: [{ program: 'codex' }, { program: 'claude' }] })
    store.updateTeam(team.id, { status: 'active' })
    store.updateTeam('missing-team', { status: 'active' })

    expect(seen.map(t => t.status)).toEqual(['forming', 'active'])
    expect(seen[1].id).toBe(team.id)
    // The payload is a copy: a listener cannot edit stored state.
    seen[1].status = 'failed'
    expect(store.getTeam(team.id)?.status).toBe('active')
  })

  it('the store emits `message` after the message is readable, with its seq, and not for a repeated id', async () => {
    const { bus } = await import('../lib/bus')
    const store = await import('../lib/ensemble-registry')
    const seen: Array<{ seq?: number; readable: boolean }> = []
    bus.on('message', m => seen.push({ seq: m.seq, readable: store.getMessages(m.teamId, (m.seq ?? 0) - 1).some(x => x.id === m.id) }))

    store.appendMessage('t1', newMessage('m1'))
    store.appendMessage('t1', newMessage('m2'))
    store.appendMessage('t1', newMessage('m2'))

    expect(seen).toEqual([{ seq: 1, readable: true }, { seq: 2, readable: true }])
  })

  it('a throwing listener neither stops the others nor breaks the mutation', async () => {
    const { bus } = await import('../lib/bus')
    const store = await import('../lib/ensemble-registry')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const later = vi.fn()
    bus.on('message', () => { throw new Error('boom') })
    bus.on('message', later)

    expect(() => store.appendMessage('t1', newMessage('m1'))).not.toThrow()
    expect(later).toHaveBeenCalledTimes(1)
    expect(store.getMessages('t1')).toHaveLength(1)
  })

  it('unsubscribe stops delivery', async () => {
    const { bus } = await import('../lib/bus')
    const store = await import('../lib/ensemble-registry')
    const listener = vi.fn()
    const off = bus.on('message', listener)
    store.appendMessage('t1', newMessage('m1'))
    off()
    store.appendMessage('t1', newMessage('m2'))
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('the log buffer emits `log` for console output, and a logging listener cannot recurse', async () => {
    const { bus } = await import('../lib/bus')
    const logBuffer = await import('../lib/log-buffer')
    const original = { log: console.log, warn: console.warn, error: console.error }
    try {
      logBuffer.installLogCapture()
      const seen: LogEntry[] = []
      bus.on('log', entry => {
        seen.push(entry)
        if (seen.length === 1) console.log('listener chatter') // would re-enter forever without the guard
      })

      console.warn('server says hi')

      expect(seen.map(e => [e.level, e.text])).toEqual([['warn', 'server says hi']])
      expect(logBuffer.getLogEntries().entries.map(e => e.text)).toEqual(['server says hi', 'listener chatter'])
    } finally {
      Object.assign(console, original)
    }
  })
})
