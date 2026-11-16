/**
 * The AgentRuntime contract of PtyRuntime that a real shell cannot show:
 * the exact bytes `paste` writes, the bounded replay, and the listener lifecycle.
 * node-pty is replaced by a recording PTY; everything else is the real runtime.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface FakePty {
  pid: number
  writes: string[]
  killed: boolean
  emit: (chunk: string) => void
  end: () => void
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  kill: () => void
  onData: (cb: (chunk: string) => void) => void
  onExit: (cb: () => void) => void
}

const spawned: FakePty[] = []

vi.mock('node-pty', () => ({
  spawn: () => {
    let dataCb: (chunk: string) => void = () => {}
    let exitCb: () => void = () => {}
    const fake: FakePty = {
      pid: 4_000_000 + spawned.length,
      writes: [],
      killed: false,
      emit: chunk => dataCb(chunk),
      end: () => exitCb(),
      write: data => { fake.writes.push(data) },
      resize: () => {},
      kill: () => { fake.killed = true; exitCb() },
      onData: cb => { dataCb = cb },
      onExit: cb => { exitCb = cb },
    }
    spawned.push(fake)
    return fake
  },
}))

// No real taskkill against made-up pids.
vi.mock('../lib/win-process', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/win-process')>()),
  killProcessTree: vi.fn(async () => {}),
  killProcessTreeSync: vi.fn(),
}))

import { MAX_LISTENERS, MAX_SCROLLBACK, PtyRuntime } from '../lib/pty-runtime'

describe('PtyRuntime contract', () => {
  let runtime: PtyRuntime
  let counter = 0
  const name = () => `contract-${process.pid}-${++counter}`

  beforeEach(() => {
    spawned.length = 0
    runtime = new PtyRuntime()
  })

  afterEach(async () => {
    await Promise.all(runtime.list().map(session => runtime.kill(session.name)))
  })

  it('paste writes the text, then a lone CR as a separate write', async () => {
    const session = name()
    await runtime.create(session, process.cwd())

    runtime.paste(session, 'line one\nline two')

    expect(spawned[0].writes).toEqual(['line one\nline two', '\r'])
  })

  it('write sends bytes untouched, and sendKeys maps named keys as before', async () => {
    const session = name()
    await runtime.create(session, process.cwd())

    runtime.write(session, '\x1b[A raw \x03')
    runtime.sendKeys(session, 'Enter')
    runtime.sendKeys(session, 'Down', { enter: true })
    runtime.sendKeys(session, 'Enter', { literal: true })

    expect(spawned[0].writes).toEqual(['\x1b[A raw \x03', '\r', '\x1b[B\r', 'Enter'])
  })

  it('writers throw for a missing session, readers answer false or empty', () => {
    expect(() => runtime.write('nope', 'x')).toThrow('PTY session not found: nope')
    expect(() => runtime.paste('nope', 'x')).toThrow('PTY session not found')
    expect(() => runtime.resize('nope', 80, 24)).toThrow('PTY session not found')
    expect(() => runtime.onData('nope', () => {})).toThrow('PTY session not found')
    expect(runtime.exists('nope')).toBe(false)
    expect(runtime.screen('nope')).toBe('')
    expect(runtime.replay('nope')).toBe('')
  })

  it('replay returns the raw scrollback so far, and is bounded', async () => {
    const session = name()
    await runtime.create(session, process.cwd())

    spawned[0].emit('\x1b[31mred\x1b[0m')
    expect(runtime.replay(session)).toBe('\x1b[31mred\x1b[0m')

    const chunk = 'x'.repeat(50_000)
    for (let i = 0; i < 10; i++) spawned[0].emit(chunk)
    const replay = runtime.replay(session)
    expect(replay.length).toBe(MAX_SCROLLBACK)
    expect(replay.endsWith(chunk)).toBe(true)
  })

  it('a listener added after some output gets only what comes next; replay has the rest', async () => {
    const session = name()
    await runtime.create(session, process.cwd())
    spawned[0].emit('before')

    const seen: string[] = []
    runtime.onData(session, chunk => seen.push(chunk))
    spawned[0].emit('after')

    expect(runtime.replay(session)).toBe('beforeafter')
    expect(seen).toEqual(['after'])
  })

  it('onData unsubscribes, and a throwing listener is dropped without stopping the others', async () => {
    const session = name()
    await runtime.create(session, process.cwd())
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const first: string[] = []
    const second: string[] = []
    const off = runtime.onData(session, chunk => first.push(chunk))
    runtime.onData(session, () => { throw new Error('boom') })
    runtime.onData(session, chunk => second.push(chunk))

    spawned[0].emit('a')
    off()
    spawned[0].emit('b')
    spawned[0].emit('c')

    expect(first).toEqual(['a'])
    expect(second).toEqual(['a', 'b', 'c'])
  })

  it(`caps listeners at ${MAX_LISTENERS} per kind per session, and an unsubscribe frees a slot`, async () => {
    const session = name()
    await runtime.create(session, process.cwd())
    const offs = Array.from({ length: MAX_LISTENERS }, () => runtime.onData(session, () => {}))

    expect(() => runtime.onData(session, () => {})).toThrow('Too many data listeners')
    // The other kind has its own budget.
    expect(() => runtime.onExit(session, () => {})).not.toThrow()

    offs[0]()
    expect(() => runtime.onData(session, () => {})).not.toThrow()
  })

  it('tells the exit listeners once when the process ends, then forgets every listener', async () => {
    const session = name()
    await runtime.create(session, process.cwd())
    const exits = vi.fn()
    const data = vi.fn()
    runtime.onExit(session, exits)
    runtime.onData(session, data)

    spawned[0].end()
    spawned[0].end() // a second exit report must not fire anything again
    spawned[0].emit('late')

    expect(exits).toHaveBeenCalledTimes(1)
    expect(data).not.toHaveBeenCalled()
    expect(runtime.exists(session)).toBe(false)
  })

  it('kill ends the session for its listeners too, and a later unsubscribe is harmless', async () => {
    const session = name()
    await runtime.create(session, process.cwd())
    const exits = vi.fn()
    const off = runtime.onExit(session, exits)

    await runtime.kill(session)

    expect(exits).toHaveBeenCalledTimes(1)
    expect(spawned[0].killed).toBe(true)
    expect(() => off()).not.toThrow()
    expect(runtime.list()).toEqual([])
  })
})
