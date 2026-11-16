/**
 * Readiness re-checks when the PTY emits output instead of waiting out a fixed
 * one-second sleep, and keeps its timer for the quiescence clock and the timeout.
 * Real waitForReady, real default timers (faked clock), a scripted screen.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveAgentProgram } from '../lib/agent-config'
import { DATA_DEBOUNCE_MS, waitForReady } from '../lib/readiness'
import { CLAUDE_READY_SCREEN, CLAUDE_TRUST_SCREEN } from './fixtures/screens'

function scriptedTerminal(initial: string) {
  let screen = initial
  const listeners = new Set<() => void>()
  const off = vi.fn()
  const runtime = {
    screen: vi.fn(() => screen),
    sendKeys: vi.fn(),
    exists: vi.fn(() => true),
    onData: vi.fn((_session: string, cb: () => void) => {
      listeners.add(cb)
      return () => { off(); listeners.delete(cb) }
    }),
  }
  return {
    runtime,
    off,
    listenerCount: () => listeners.size,
    /** The CLI paints `next` and the PTY reports output. */
    paint: (next: string) => { screen = next; for (const cb of [...listeners]) cb() },
    show: (next: string) => { screen = next }, // changes the screen with no output event
  }
}

const base = {
  sessionName: 's',
  readyMarkers: ['❯'],
  gates: [] as never[],
  isAborted: () => false,
  abortReason: 'test',
  maxWaitMs: 150_000,
  quiescentMs: 20_000,
}

describe('waitForReady on PTY output', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('notices the prompt one debounce after the output, not at the next one-second tick', async () => {
    const term = scriptedTerminal('starting...')
    let result: boolean | undefined
    void waitForReady({ ...base, runtime: term.runtime }).then(r => { result = r })

    await vi.advanceTimersByTimeAsync(100)
    term.paint(CLAUDE_READY_SCREEN) // output at t = 100 ms
    await vi.advanceTimersByTimeAsync(DATA_DEBOUNCE_MS - 10)
    expect(result).toBeUndefined() // debounced, not instant

    await vi.advanceTimersByTimeAsync(20) // t = 360 ms, well before the 1000 ms tick
    expect(result).toBe(true)
  })

  it('without output the screen is looked at once a second, as before', async () => {
    const term = scriptedTerminal('starting...')
    let result: boolean | undefined
    void waitForReady({ ...base, runtime: term.runtime }).then(r => { result = r })

    await vi.advanceTimersByTimeAsync(100)
    term.show(CLAUDE_READY_SCREEN) // no output event reaches the waiter
    await vi.advanceTimersByTimeAsync(800)
    expect(result).toBeUndefined()

    await vi.advanceTimersByTimeAsync(150) // t = 1050 ms: the one-second timer has passed
    expect(result).toBe(true)
  })

  it('a stream of output costs one pass per debounce window, not one per chunk', async () => {
    const term = scriptedTerminal('starting...')
    void waitForReady({ ...base, runtime: term.runtime })
    await vi.advanceTimersByTimeAsync(0)
    const before = term.runtime.screen.mock.calls.length

    for (let i = 0; i < 100; i++) {
      term.paint(`spinner ${i}`)
      await vi.advanceTimersByTimeAsync(5) // 100 chunks in 500 ms
    }

    expect(term.runtime.screen.mock.calls.length - before).toBeLessThanOrEqual(3)
  })

  it('still answers a gate before it believes a marker the gate screen also shows, now on output', async () => {
    const term = scriptedTerminal('starting...')
    const gates = resolveAgentProgram('claude')?.gates ?? [] // the folder-trust gate, from agents.json
    let result: boolean | undefined
    void waitForReady({ ...base, gates, runtime: term.runtime }).then(r => { result = r })

    await vi.advanceTimersByTimeAsync(50)
    term.paint(CLAUDE_TRUST_SCREEN) // contains the ❯ marker as the modal's cursor
    await vi.advanceTimersByTimeAsync(DATA_DEBOUNCE_MS + 10)

    expect(term.runtime.sendKeys).toHaveBeenCalledWith('s', 'Enter', undefined)
    expect(result).toBeUndefined() // the modal's ❯ was not taken for the prompt

    term.paint(CLAUDE_READY_SCREEN)
    await vi.advanceTimersByTimeAsync(DATA_DEBOUNCE_MS + 10)
    expect(result).toBe(true)
  })

  it('the timer alone still drives the quiescence clock and the timeout', async () => {
    const settled = scriptedTerminal('some unfamiliar prompt')
    let ready: boolean | undefined
    void waitForReady({ ...base, runtime: settled.runtime }).then(r => { ready = r })
    await vi.advanceTimersByTimeAsync(19_000)
    expect(ready).toBeUndefined()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(ready).toBe(true) // assumed ready after 20 s of an unchanged screen

    const never = scriptedTerminal('')
    let timedOut: boolean | undefined
    void waitForReady({ ...base, maxWaitMs: 5_000, runtime: never.runtime }).then(r => { timedOut = r })
    await vi.advanceTimersByTimeAsync(6_000)
    expect(timedOut).toBe(false)
  })

  it('stops listening to the terminal when the wait ends, whichever way it ends', async () => {
    const ready = scriptedTerminal(CLAUDE_READY_SCREEN)
    expect(await waitForReady({ ...base, runtime: ready.runtime })).toBe(true)
    expect(ready.listenerCount()).toBe(0)

    const exited = scriptedTerminal('x')
    exited.runtime.exists.mockReturnValue(false)
    expect(await waitForReady({ ...base, runtime: exited.runtime })).toBe(false)
    expect(exited.listenerCount()).toBe(0)

    const aborted = scriptedTerminal('x')
    expect(await waitForReady({ ...base, isAborted: () => true, runtime: aborted.runtime })).toBe(false)
    expect(aborted.listenerCount()).toBe(0)

    const slow = scriptedTerminal('')
    const timedOut = waitForReady({ ...base, maxWaitMs: 2_000, runtime: slow.runtime })
    await vi.advanceTimersByTimeAsync(3_000)
    expect(await timedOut).toBe(false)
    expect(slow.listenerCount()).toBe(0)
  })

  it('carries on with the timer alone when the terminal offers no output feed', async () => {
    const term = scriptedTerminal('starting...')
    term.runtime.onData.mockImplementation(() => { throw new Error('PTY session not found') })
    let result: boolean | undefined
    void waitForReady({ ...base, runtime: term.runtime }).then(r => { result = r })

    await vi.advanceTimersByTimeAsync(100)
    term.show(CLAUDE_READY_SCREEN)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(result).toBe(true)
  })
})
