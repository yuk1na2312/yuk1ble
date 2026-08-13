/**
 * Regression tests for the "[Pasted Content]" defect.
 *
 * Live evidence (codex v0.147, Windows): after PtyRuntime.pasteFromFile the
 * composer held "[Pasted Content 1929 chars]" indefinitely — the prompt was
 * never submitted, the agent never spoke, and the watchdog reported it stalled.
 * A single standalone Enter submitted it and the agent replied.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { ensureSubmitted, PASTE_NOT_SUBMITTED } from '../lib/paste-submit'

const CODEX_PARKED = '› [Pasted Content 1929 chars]'
const CLAUDE_PARKED = '❯ [Pasted text #1 +42 lines]'
const CLEAN = '› Find and fix a bug in @filename'

function runtimeWith(panes: string[]) {
  let index = 0
  const capturePane = vi.fn(async () => panes[Math.min(index++, panes.length - 1)])
  const sendKeys = vi.fn(async () => {})
  return { capturePane, sendKeys }
}

/** Drives ensureSubmitted to completion without waiting out its real delays. */
async function runFast(fn: () => Promise<void>): Promise<void> {
  vi.useFakeTimers()
  try {
    const done = fn()
    // 1500 + 3000 + 6000 with margin.
    await vi.advanceTimersByTimeAsync(20_000)
    await done
  } finally {
    vi.useRealTimers()
  }
}

describe('PASTE_NOT_SUBMITTED', () => {
  it('matches both CLIs\' parked-paste indicators', () => {
    expect(PASTE_NOT_SUBMITTED.test(CODEX_PARKED)).toBe(true)
    expect(PASTE_NOT_SUBMITTED.test(CLAUDE_PARKED)).toBe(true)
  })

  it('does not match an ordinary prompt', () => {
    expect(PASTE_NOT_SUBMITTED.test(CLEAN)).toBe(false)
  })
})

describe('ensureSubmitted', () => {
  afterEach(() => vi.useRealTimers())

  it('sends Enter when the paste is parked, and stops once it submits', async () => {
    const runtime = runtimeWith([CODEX_PARKED, CLEAN])
    await runFast(() => ensureSubmitted(runtime, 'team-codex-1'))

    expect(runtime.sendKeys).toHaveBeenCalledTimes(1)
    expect(runtime.sendKeys).toHaveBeenCalledWith('team-codex-1', 'Enter')
  })

  it('sends nothing when the paste already submitted', async () => {
    const runtime = runtimeWith([CLEAN])
    await runFast(() => ensureSubmitted(runtime, 'team-codex-1'))

    expect(runtime.sendKeys).not.toHaveBeenCalled()
  })

  it('gives up after a bounded number of retries', async () => {
    const runtime = runtimeWith([CODEX_PARKED])
    await runFast(() => ensureSubmitted(runtime, 'team-codex-1'))

    // Bounded, not an infinite Enter storm into a wedged session.
    expect(runtime.sendKeys).toHaveBeenCalledTimes(3)
  })

  it('stops quietly when the session has gone away', async () => {
    const runtime = {
      capturePane: vi.fn(async () => { throw new Error('PTY session not found') }),
      sendKeys: vi.fn(async () => {}),
    }
    await runFast(() => ensureSubmitted(runtime, 'team-codex-1'))

    expect(runtime.sendKeys).not.toHaveBeenCalled()
  })
})
