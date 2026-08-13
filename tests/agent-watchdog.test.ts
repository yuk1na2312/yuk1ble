import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnsembleMessage, EnsembleTeam } from '../types/ensemble'
import {
  AgentWatchdog,
  getWatchdogNudgeMs,
  getWatchdogStallMs,
} from '../lib/agent-watchdog'

function makeTeam(overrides: Partial<EnsembleTeam> = {}): EnsembleTeam {
  return {
    id: overrides.id ?? 'team-1',
    name: overrides.name ?? 'alpha',
    description: overrides.description ?? 'test team',
    status: overrides.status ?? 'active',
    agents: overrides.agents ?? [
      {
        agentId: 'agent-1',
        name: 'codex-1',
        program: 'codex',
        role: 'lead',
        hostId: 'local',
        status: 'active',
      },
    ],
    createdBy: overrides.createdBy ?? 'test',
    createdAt: overrides.createdAt ?? '2026-03-19T10:00:00.000Z',
    completedAt: overrides.completedAt,
    feedMode: overrides.feedMode ?? 'live',
    result: overrides.result,
  }
}

function makeMessage(overrides: Partial<EnsembleMessage> = {}): EnsembleMessage {
  return {
    id: overrides.id ?? `msg-${Math.random().toString(36).slice(2, 8)}`,
    teamId: overrides.teamId ?? 'team-1',
    from: overrides.from ?? 'codex-1',
    to: overrides.to ?? 'team',
    content: overrides.content ?? 'progress',
    type: overrides.type ?? 'chat',
    timestamp: overrides.timestamp ?? '2026-03-19T10:00:00.000Z',
  }
}

describe('AgentWatchdog', () => {
  const originalNudgeMs = process.env.ENSEMBLE_WATCHDOG_NUDGE_MS
  const originalStallMs = process.env.ENSEMBLE_WATCHDOG_STALL_MS
  const deliveryRoot = path.join(os.tmpdir(), `ensemble-watchdog-${process.pid}`)

  let nowMs: number
  let teams: EnsembleTeam[]
  let messages: EnsembleMessage[]
  let appended: EnsembleMessage[]
  let sendKeys: ReturnType<typeof vi.fn>
  let pasteFromFile: ReturnType<typeof vi.fn>
  let sessionExists: ReturnType<typeof vi.fn>
  let capturePane: ReturnType<typeof vi.fn>
  let postRemoteSessionCommand: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.restoreAllMocks()
    nowMs = new Date('2026-03-19T10:00:00.000Z').getTime()
    teams = [makeTeam()]
    messages = [makeMessage({ timestamp: '2026-03-19T10:00:00.000Z' })]
    appended = []
    sendKeys = vi.fn(async () => {})
    pasteFromFile = vi.fn(async () => {})
    sessionExists = vi.fn(async () => true)
    capturePane = vi.fn(async () => '> ')
    postRemoteSessionCommand = vi.fn(async () => {})
  })

  afterEach(() => {
    fs.rmSync(deliveryRoot, { recursive: true, force: true })
    if (originalNudgeMs === undefined) {
      delete process.env.ENSEMBLE_WATCHDOG_NUDGE_MS
    } else {
      process.env.ENSEMBLE_WATCHDOG_NUDGE_MS = originalNudgeMs
    }
    if (originalStallMs === undefined) {
      delete process.env.ENSEMBLE_WATCHDOG_STALL_MS
    } else {
      process.env.ENSEMBLE_WATCHDOG_STALL_MS = originalStallMs
    }
  })

  function createWatchdog() {
    return new AgentWatchdog({
      loadTeams: () => teams,
      getMessages: () => messages,
      appendMessage: (_teamId, message) => appended.push(message),
      // capturePane returns a composer-free screen so ensureSubmitted is a no-op
      // here; the paste-submit behaviour has its own tests.
      getRuntime: () => ({ sendKeys, pasteFromFile, sessionExists, capturePane }),
      resolveAgentProgram: () => ({ inputMethod: 'sendKeys' }),
      isSelf: () => true,
      getHostById: () => undefined,
      postRemoteSessionCommand,
      collabDeliveryFile: (teamId, sessionName) =>
        path.join(deliveryRoot, teamId, `${sessionName}.txt`),
      now: () => nowMs,
      pollIntervalMs: 60_000,
      nudgeAfterMs: 90_000,
      stallAfterMs: 180_000,
    })
  }

  it('nudges an active agent after prolonged silence and logs it to the team feed', async () => {
    const watchdog = createWatchdog()
    await watchdog.poll()

    nowMs += 91_000
    await watchdog.poll()

    expect(pasteFromFile).toHaveBeenCalledWith(
      'alpha-codex-1',
      path.join(deliveryRoot, 'team-1', 'alpha-codex-1.txt'),
    )
    expect(appended).toHaveLength(1)
    expect(appended[0].content).toContain('Watchdog nudged codex-1')
    watchdog.stop()
  })

  it('marks an agent stalled when silence continues after the nudge', async () => {
    const watchdog = createWatchdog()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await watchdog.poll()
    nowMs += 91_000
    await watchdog.poll()

    nowMs += 181_000
    await watchdog.poll()

    expect(appended).toHaveLength(2)
    expect(appended[1].content).toContain('marked codex-1 as stalled')
    expect(warnSpy).toHaveBeenCalledWith('[Watchdog] Agent codex-1 in team team-1 stalled after watchdog nudge')
    watchdog.stop()
  })

  it('resets stall tracking when a new agent message arrives after a nudge', async () => {
    const watchdog = createWatchdog()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await watchdog.poll()
    nowMs += 91_000
    await watchdog.poll()

    messages = [
      ...messages,
      makeMessage({ id: 'msg-new', timestamp: new Date(nowMs + 1_000).toISOString(), content: 'Still working' }),
    ]
    nowMs += 2_000
    await watchdog.poll()

    // Advance 80s — below nudge threshold, so no new nudge and no stall
    nowMs += 80_000
    await watchdog.poll()

    expect(appended).toHaveLength(1) // only the original nudge
    expect(warnSpy).not.toHaveBeenCalled()
    watchdog.stop()
  })

  it('drops watchdog state for non-active teams so disbanded teams are no longer monitored', async () => {
    const watchdog = createWatchdog()

    await watchdog.poll()
    nowMs += 91_000
    await watchdog.poll()

    teams = []
    nowMs += 181_000
    await watchdog.poll()

    teams = [makeTeam()]
    await watchdog.poll()

    expect(appended).toHaveLength(2)
    expect(appended[0].content).toContain('Watchdog nudged codex-1')
    expect(appended[1].content).toContain('Watchdog nudged codex-1')
    expect(appended.some(message => message.content.includes('marked codex-1 as stalled'))).toBe(false)
    watchdog.stop()
  })

  it('marks an agent stalled promptly (and only once) when its PTY session is gone, instead of retrying forever', async () => {
    // Regression test for the bug where a dead PTY session caused the watchdog
    // to spam a "failed to nudge" message every 30s tick forever, and never
    // transition the agent to stalled, because the catch path never set
    // `nudgedAt`.
    pasteFromFile.mockRejectedValue(new Error('PTY session not found'))
    sessionExists.mockResolvedValue(false)

    const watchdog = createWatchdog()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // First tick past the nudge threshold: nudge is attempted, pasteFromFile
    // throws, sessionExists confirms the session is gone -> stalled immediately.
    await watchdog.poll()
    nowMs += 91_000
    await watchdog.poll()

    expect(sessionExists).toHaveBeenCalledWith('alpha-codex-1')
    expect(appended).toHaveLength(1)
    expect(appended[0].content).toContain('stalled')
    expect(appended[0].content).toContain('session is gone')
    expect(warnSpy).toHaveBeenCalledTimes(1)

    // Several more ticks go by with the session still gone. Before the fix,
    // each tick re-attempted the nudge and appended another failure message
    // forever. After the fix, the agent is already terminal and is skipped.
    for (let i = 0; i < 5; i++) {
      nowMs += 30_000
      await watchdog.poll()
    }

    expect(pasteFromFile).toHaveBeenCalledTimes(1)
    expect(appended).toHaveLength(1)
    watchdog.stop()
  })

  it('backs off after a transient nudge failure instead of retrying every tick, and still eventually stalls', async () => {
    // Regression test for the missing `nudgedAt` write on the catch path: a
    // transient failure (session still exists) must not be retried on every
    // 30s tick either. It should log exactly one failure message, then let
    // the existing stall-after-nudge timer take over.
    pasteFromFile.mockRejectedValue(new Error('write EPIPE'))
    sessionExists.mockResolvedValue(true)

    const watchdog = createWatchdog()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await watchdog.poll()
    nowMs += 91_000
    await watchdog.poll()

    expect(pasteFromFile).toHaveBeenCalledTimes(1)
    expect(appended).toHaveLength(1)
    expect(appended[0].content).toContain('❌ Watchdog failed to nudge codex-1')

    // Ticks before the stall window elapses must not re-attempt the nudge or
    // append another message.
    nowMs += 30_000
    await watchdog.poll()
    nowMs += 30_000
    await watchdog.poll()

    expect(pasteFromFile).toHaveBeenCalledTimes(1)
    expect(appended).toHaveLength(1)

    // Once the stall window elapses since the (failed) nudge, the existing
    // stall path marks the agent stalled with a single additional message.
    nowMs += 181_000
    await watchdog.poll()

    expect(appended).toHaveLength(2)
    expect(appended[1].content).toContain('marked codex-1 as stalled')
    expect(warnSpy).toHaveBeenCalled()

    // Further ticks must not add more messages.
    nowMs += 60_000
    await watchdog.poll()
    expect(appended).toHaveLength(2)

    watchdog.stop()
  })

  it('reads watchdog thresholds from environment variables', () => {
    process.env.ENSEMBLE_WATCHDOG_NUDGE_MS = '1234'
    process.env.ENSEMBLE_WATCHDOG_STALL_MS = '5678'

    expect(getWatchdogNudgeMs()).toBe(1234)
    expect(getWatchdogStallMs()).toBe(5678)
  })
})
