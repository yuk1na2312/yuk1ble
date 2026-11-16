import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deliver, deliverStrict, MAX_PENDING_DELIVERIES, pendingDeliveries } from '../lib/delivery'

/** A scripted terminal: records every write in order, and shows a parked paste until an Enter arrives. */
function fakeRuntime(options: { parkedMarker?: string; gone?: Set<string> } = {}) {
  const events: string[] = []
  const unsubmitted = new Set<string>()
  const runtime = {
    exists: vi.fn((session: string) => !options.gone?.has(session)),
    paste: vi.fn((session: string, text: string) => {
      events.push(`paste ${session} ${text}`)
      unsubmitted.add(session)
    }),
    sendKeys: vi.fn((session: string, keys: string, opts?: { literal?: boolean; enter?: boolean }) => {
      events.push(`keys ${session} ${keys}${opts?.literal ? ' literal' : ''}${opts?.enter ? ' enter' : ''}`)
      if (keys === 'Enter' || opts?.enter) unsubmitted.delete(session)
    }),
    screen: vi.fn((session: string) => {
      events.push(`check ${session}`)
      return unsubmitted.has(session) ? (options.parkedMarker ?? '[Pasted Content 12 chars]') : '> '
    }),
  }
  return { runtime, events }
}

/** deliver() waits out ensureSubmitted's real delays; run it on a clock that skips them. */
async function settle<T extends unknown[]>(...promises: { [K in keyof T]: Promise<T[K]> }): Promise<T> {
  const all = Promise.all(promises) as Promise<T>
  await vi.advanceTimersByTimeAsync(600_000)
  return all
}

describe('deliver', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout'] }) })
  afterEach(() => { vi.useRealTimers() })

  it('pastes by default and presses the standalone Enter a parked paste needs', async () => {
    const { runtime, events } = fakeRuntime()

    const [outcome] = await settle(deliver('s1', 'hello', { runtime }))

    expect(outcome).toBe('delivered')
    expect(events).toEqual(['paste s1 hello', 'check s1', 'keys s1 Enter', 'check s1'])
  })

  it('types the text for an adapter whose inputMethod is sendKeys, then still checks the submit', async () => {
    const { runtime, events } = fakeRuntime()

    await settle(deliver('s1', 'hello', { runtime, inputMethod: 'sendKeys' }))

    expect(events).toEqual(['keys s1 hello literal enter', 'check s1'])
    expect(runtime.paste).not.toHaveBeenCalled()
  })

  it("recognises a parked paste by the adapter's own pasteMarker", async () => {
    const { runtime, events } = fakeRuntime({ parkedMarker: '[zz pasted 4 lines]' })

    await settle(deliver('s1', 'hello', { runtime, pasteMarker: '\\[zz pasted' }))
    expect(events.filter(e => e === 'keys s1 Enter')).toHaveLength(1)

    // The default marker does not know that screen, so nothing is pressed.
    events.length = 0
    await settle(deliver('s1', 'again', { runtime }))
    expect(events.filter(e => e.startsWith('keys'))).toEqual([])
  })

  it('never interleaves two deliveries to one session, and keeps their order', async () => {
    const { runtime, events } = fakeRuntime()

    await settle(
      deliver('s1', 'first', { runtime }),
      deliver('s1', 'second', { runtime }),
      deliver('s1', 'third', { runtime }),
    )

    const pastes = events.filter(e => e.startsWith('paste'))
    expect(pastes).toEqual(['paste s1 first', 'paste s1 second', 'paste s1 third'])
    // Each paste is followed by its own submit check before the next paste starts.
    const firstCheck = events.indexOf('check s1')
    expect(events.indexOf('paste s1 second')).toBeGreaterThan(firstCheck)
    expect(events.indexOf('paste s1 third')).toBeGreaterThan(events.indexOf('paste s1 second'))
  })

  it('serves different sessions in parallel', async () => {
    const { runtime, events } = fakeRuntime()

    await settle(deliver('a', 'for a', { runtime }), deliver('b', 'for b', { runtime }))

    // Both pastes land before either session's 1.5 s submit check.
    expect(events.slice(0, 2).sort()).toEqual(['paste a for a', 'paste b for b'])
  })

  it(`drops the delivery beyond ${MAX_PENDING_DELIVERIES} waiting for one session, writing nothing for it`, async () => {
    const { runtime, events } = fakeRuntime()

    const results = Array.from({ length: MAX_PENDING_DELIVERIES + 2 }, (_, i) => deliver('s1', `m${i}`, { runtime }))
    expect(pendingDeliveries('s1')).toBe(MAX_PENDING_DELIVERIES)
    const outcomes = await settle(...results)

    expect(outcomes.filter(o => o === 'delivered')).toHaveLength(MAX_PENDING_DELIVERIES)
    expect(outcomes.slice(MAX_PENDING_DELIVERIES)).toEqual(['dropped', 'dropped'])
    expect(events.some(e => e.includes(`m${MAX_PENDING_DELIVERIES}`))).toBe(false)
    expect(pendingDeliveries('s1')).toBe(0)
  })

  it('answers "gone" without writing when the session no longer exists', async () => {
    const { runtime, events } = fakeRuntime({ gone: new Set(['dead']) })

    expect(await deliver('dead', 'hello', { runtime })).toBe('gone')
    expect(events).toEqual([])
    await expect(deliverStrict('dead', 'hello', { runtime })).rejects.toThrow('PTY session not found: dead')
  })

  it('rejects when the write fails, and the next delivery still runs', async () => {
    const { runtime, events } = fakeRuntime()
    runtime.paste.mockImplementationOnce(() => { throw new Error('write EPIPE') })

    const [failed, ok] = await settle(
      deliver('s1', 'one', { runtime }).then(() => 'resolved', (err: Error) => err.message),
      deliver('s1', 'two', { runtime }),
    )

    expect(failed).toBe('write EPIPE')
    expect(ok).toBe('delivered')
    expect(events).toContain('paste s1 two')
    expect(pendingDeliveries('s1')).toBe(0)
  })

  it('deliverStrict throws for a dropped delivery', async () => {
    const { runtime } = fakeRuntime()
    const fill = Array.from({ length: MAX_PENDING_DELIVERIES }, (_, i) => deliver('s1', `m${i}`, { runtime }))

    const strict = deliverStrict('s1', 'one too many', { runtime }).then(() => 'resolved', (err: Error) => err.message)
    const [message] = await settle(strict, ...fill)

    expect(message).toContain('already waiting')
  })
})
