import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deliver, deliverSkillCommand, MAX_PENDING_DELIVERIES } from '../src/core/delivery'
import { COMMAND_MAX_EXTRA_ENTERS, waitForCommandAccepted } from '../src/core/paste-submit'

/** A scripted terminal. `screens` is what each successive screen() call shows (the last one repeats). */
function fakeRuntime(screens: string[], options: { gone?: Set<string> } = {}) {
  const events: string[] = []
  let looks = 0
  const runtime = {
    exists: vi.fn((session: string) => !options.gone?.has(session)),
    paste: vi.fn((session: string, text: string) => { events.push(`paste ${session} ${text}`) }),
    sendKeys: vi.fn((session: string, keys: string, opts?: { literal?: boolean; enter?: boolean }) => {
      events.push(`keys ${session} ${keys}${opts?.literal ? ' literal' : ''}${opts?.enter ? ' enter' : ''}`)
    }),
    screen: vi.fn(() => { events.push('look'); return screens[Math.min(looks++, screens.length - 1)] }),
  }
  return { runtime, events }
}

async function settle<T>(promise: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(600_000)
  return promise
}

describe('waitForCommandAccepted', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout'] }) })
  afterEach(() => { vi.useRealTimers() })

  it('is true at once, pressing nothing, when the last line of the screen is not the command', async () => {
    const { runtime } = fakeRuntime(['you ran /greet hi\n\nFAKE >'])
    expect(await settle(waitForCommandAccepted(runtime, 's', 'greet'))).toBe(true)
    expect(runtime.sendKeys).not.toHaveBeenCalled()
  })

  it(`presses at most ${COMMAND_MAX_EXTRA_ENTERS} Enters while the command stays in the composer, then gives up`, async () => {
    const { runtime } = fakeRuntime(['> /greet hi\n\n'])
    expect(await settle(waitForCommandAccepted(runtime, 's', 'greet'))).toBe(false)
    expect(runtime.sendKeys.mock.calls).toEqual([['s', 'Enter'], ['s', 'Enter']])
    expect(runtime.screen.mock.calls.length).toBeLessThanOrEqual(14) // bounded: ~10 s of 750 ms polls
  })

  it('is false, not a throw, when the session disappears', async () => {
    const { runtime } = fakeRuntime(['> /greet'])
    runtime.screen.mockImplementation(() => { throw new Error('PTY session not found') })
    expect(await settle(waitForCommandAccepted(runtime, 's', 'greet'))).toBe(false)
  })
})

describe('deliverSkillCommand', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout'] }) })
  afterEach(() => { vi.useRealTimers() })

  it('writes the command, confirms it, then the follow-up, as one job in the session queue', async () => {
    const { runtime, events } = fakeRuntime(['> '])
    const skill = { text: '/greet hi', token: 'greet', followUp: 'nudge' }

    const [outcome] = await settle(Promise.all([
      deliverSkillCommand('s1', skill, { runtime }),
      deliver('s1', 'teammate', { runtime }),
    ]))

    expect(outcome).toBe('delivered')
    expect(events.filter(e => e.startsWith('paste'))).toEqual(['paste s1 /greet hi', 'paste s1 nudge', 'paste s1 teammate'])
  })

  it('answers "unconfirmed" and never sends the follow-up when the command stays in the composer', async () => {
    const { runtime, events } = fakeRuntime(['> /greet hi'])
    const outcome = await settle(deliverSkillCommand('s1', { text: '/greet hi', token: 'greet', followUp: 'nudge' }, { runtime }))
    expect(outcome).toBe('unconfirmed')
    expect(events.filter(e => e.startsWith('paste'))).toEqual(['paste s1 /greet hi'])
  })

  it('answers "gone" without writing, and "dropped" beyond the queue bound', async () => {
    const { runtime, events } = fakeRuntime(['> '], { gone: new Set(['dead']) })
    const skill = { text: '/greet', token: 'greet', followUp: 'nudge' }
    expect(await deliverSkillCommand('dead', skill, { runtime })).toBe('gone')
    expect(events).toEqual([])

    const fill = Array.from({ length: MAX_PENDING_DELIVERIES }, (_, i) => deliver('s2', `m${i}`, { runtime }))
    const dropped = deliverSkillCommand('s2', skill, { runtime })
    expect(await settle(dropped)).toBe('dropped')
    await settle(Promise.all(fill))
  })
})
